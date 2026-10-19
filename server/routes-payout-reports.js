'use strict';
const db = require('./db');
const { requireAuth } = require('./routes-auth');
const { sendJson } = require('./http-utils');
const { roleConfig, generatePeriodReport, saveReport, fromPayout, printableReport, enrichReportOrders } = require('./payout-reports');
const { getBonuses, createReferralBonusPayout } = require('./report-bonuses');
const { calculateLifetimeEarnings } = require('./payout-report-lifetime');
const withLifetime = report => ({...report, lifetime_earned: calculateLifetimeEarnings(db,report.role,report.recipient?.id)});

function registerPayoutReportRoutes(router) {
  const positiveId = (value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Некорректный идентификатор'), { statusCode: 400 });
    return id;
  };
  const handler = (fn) => (req, res, ctx) => {
    const admin = requireAuth(['admin'])(req, res, ctx);
    if (!admin) return;
    res.setHeader('Cache-Control', 'no-store');
    try { fn(req, res, ctx, admin); }
    catch (err) {
      if (!err.statusCode) console.error('[payout-report]', err);
      sendJson(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'Не удалось сформировать отчёт' });
    }
  };
  router.get('/api/payout-reports/:id/telegram', handler((req,res,ctx) => {
    const id = positiveId(ctx.params.id);
    if (!db.prepare('SELECT id FROM payout_reports WHERE id = ?').get(id)) return sendJson(res,404,{error:'Отчёт не найден'});
    sendJson(res,200,require('./payout-report-telegram').deliveryStatus(db,id));
  }));
  router.post('/api/payout-reports/:id/telegram', async (req,res,ctx) => {
    const admin = requireAuth(['admin'])(req,res,ctx);
    if (!admin) return;
    res.setHeader('Cache-Control','no-store');
    try {
      const id = positiveId(ctx.params.id);
      const row = db.prepare('SELECT id,snapshot_json FROM payout_reports WHERE id=?').get(id);
      if (!row) return sendJson(res,404,{error:'Отчёт не найден'});
      const result = await require('./payout-report-telegram').sendWorkReport(db,{...withLifetime(enrichReportOrders(db,JSON.parse(row.snapshot_json))),id:row.id},admin,ctx.body);
      sendJson(res,200,result);
    } catch(e) {
      if (!e.statusCode) console.error('[payout-telegram]',e);
      sendJson(res,e.statusCode || 500,{error:e.statusCode ? e.message : 'Не удалось отправить отчёт. Проверьте рабочий чат перед повтором.',code:e.code});
    }
  });
  router.get('/api/payout-reports/:id/pdf', async (req, res, ctx) => {
    if (!requireAuth(['admin'])(req, res, ctx)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const id = positiveId(ctx.params.id);
      const row = db.prepare('SELECT id, snapshot_json FROM payout_reports WHERE id = ?').get(id);
      if (!row) return sendJson(res, 404, { error:'Отчёт не найден' });
      const report = { ...enrichReportOrders(db,JSON.parse(row.snapshot_json)), id:row.id };
      const buffer = await require('./payout-report-pdf').renderPayoutPdf(report);
      res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length':buffer.length,
        'Content-Disposition':'attachment; filename="HvostMarket_report_' + id + '.pdf"' });
      res.end(buffer);
    } catch (e) {
      if (!e.statusCode) console.error('[payout-pdf]', e);
      if (!res.headersSent) sendJson(res, e.statusCode || 500, { error:e.statusCode ? e.message : 'Не удалось сформировать PDF. Попробуйте ещё раз или используйте печать отчёта.' });
    }
  });
  router.get('/api/payout-reports/recipients', handler((req, res, ctx) => {
    const role = ctx.query.role;
    const c = roleConfig(role);
    const recipients = db.prepare(`SELECT id, full_name, ${c.code} AS code FROM ${c.table} ORDER BY full_name`).all();
    sendJson(res, 200, { recipients });
  }));
  router.get('/api/payout-reports/bonuses',handler((req,res,ctx)=>{
    roleConfig(ctx.query.role);
    const bonuses=getBonuses(db,ctx.query.role,positiveId(ctx.query.recipient_id));
    sendJson(res,200,bonuses);
  }));
  router.post('/api/payout-reports/bonus-payouts',handler((req,res,ctx,admin)=>{
    const b=ctx.body||{};
    if(b.confirm_transferred !== true) throw Object.assign(new Error('Подтвердите фактический перевод'),{statusCode:400});
    const result=createReferralBonusPayout(db,b.role,positiveId(b.manager_point_id),positiveId(b.recipient_id),positiveId(b.expected_amount),admin);
    const report=withLifetime(result.report);
    sendJson(res,201,{...result,report,html:printableReport(report)});
  }));
  router.get('/api/payout-reports', handler((req, res, ctx) => {
    const role = ctx.query.role;
    roleConfig(role);
    const recipientId = ctx.query.recipient_id ? positiveId(ctx.query.recipient_id) : null;
    const reports = db.prepare(`SELECT id, recipient_id,
      COALESCE(payout_id,json_extract(snapshot_json,'$.bonus_payout_id')) AS payout_id,
      period_start, period_end, created_at,
      json_extract(snapshot_json, '$.recipient.name') AS recipient_name,
      json_extract(snapshot_json, '$.bonus_payout_id') AS bonus_payout_id,
      json_extract(snapshot_json, '$.payout_type') AS payout_type
      FROM payout_reports WHERE role = ? ${recipientId ? 'AND recipient_id = ?' : ''} ORDER BY id DESC LIMIT 100`).all(...(recipientId ? [role, recipientId] : [role]));
    sendJson(res, 200, { reports });
  }));
  router.post('/api/payout-reports/period', handler((req, res, ctx, admin) => {
    const b = ctx.body || {};
    let report = generatePeriodReport(db, b.role, positiveId(b.recipient_id), b.start, b.end, b.metadata);
    if (b.save === true) report = saveReport(db, report, admin.id);
    report=withLifetime(report);
    sendJson(res, b.save === true ? 201 : 200, { report, html: printableReport(report) });
  }));
  router.post('/api/payout-reports/from-payout', handler((req, res, ctx, admin) => {
    const b = ctx.body || {};
    const report = withLifetime(enrichReportOrders(db,fromPayout(db, b.role, positiveId(b.payout_id), admin.id,b.payout_type || 'commission')));
    sendJson(res, 200, { report, html: printableReport(report) });
  }));
  router.get('/api/payout-reports/:id', handler((req, res, ctx) => {
    const id = positiveId(ctx.params.id);
    const row = db.prepare('SELECT id, snapshot_json FROM payout_reports WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'Отчёт не найден' });
    const report = { ...enrichReportOrders(db,JSON.parse(row.snapshot_json)), id: row.id };
    sendJson(res, 200, { report, html: printableReport(report) });
  }));
}
module.exports = { registerPayoutReportRoutes };
