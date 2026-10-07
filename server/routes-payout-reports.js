'use strict';
const db = require('./db');
const { requireAuth } = require('./routes-auth');
const { sendJson } = require('./http-utils');
const { roleConfig, generatePeriodReport, saveReport, fromPayout, printableReport } = require('./payout-reports');

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
  router.get('/api/payout-reports/recipients', handler((req, res, ctx) => {
    const role = ctx.query.role;
    const c = roleConfig(role);
    const recipients = db.prepare(`SELECT id, full_name, ${c.code} AS code FROM ${c.table} ORDER BY full_name`).all();
    sendJson(res, 200, { recipients });
  }));
  router.get('/api/payout-reports', handler((req, res, ctx) => {
    const role = ctx.query.role;
    roleConfig(role);
    const reports = db.prepare(`SELECT id, recipient_id, payout_id, period_start, period_end, created_at,
      json_extract(snapshot_json, '$.recipient.name') AS recipient_name
      FROM payout_reports WHERE role = ? ORDER BY id DESC LIMIT 100`).all(role);
    sendJson(res, 200, { reports });
  }));
  router.post('/api/payout-reports/period', handler((req, res, ctx, admin) => {
    const b = ctx.body || {};
    let report = generatePeriodReport(db, b.role, positiveId(b.recipient_id), b.start, b.end, b.metadata);
    if (b.save === true) report = saveReport(db, report, admin.id);
    sendJson(res, b.save === true ? 201 : 200, { report, html: printableReport(report) });
  }));
  router.post('/api/payout-reports/from-payout', handler((req, res, ctx, admin) => {
    const b = ctx.body || {};
    const report = fromPayout(db, b.role, positiveId(b.payout_id), admin.id);
    sendJson(res, 200, { report, html: printableReport(report) });
  }));
  router.get('/api/payout-reports/:id', handler((req, res, ctx) => {
    const id = positiveId(ctx.params.id);
    const row = db.prepare('SELECT id, snapshot_json FROM payout_reports WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'Отчёт не найден' });
    const report = { ...JSON.parse(row.snapshot_json), id: row.id };
    sendJson(res, 200, { report, html: printableReport(report) });
  }));
}
module.exports = { registerPayoutReportRoutes };
