// routes-weekly-reports.js — создание и скачивание управленческих отчётов.
'use strict';

const fs = require('node:fs');
const { sendJson } = require('./http-utils');
const { requireAuth, requireActiveAdmin } = require('./routes-auth');
const { readComparison } = require('./week-over-week');
const {
  createWeeklyReport,
  customPeriod,
  listWeeklyReports,
  previousCompletedWeek,
  resolveReportFile,
} = require('./weekly-report');

function safeRecord(record) {
  let summary = record.summary || {};
  if (!record.summary && record.summary_json) {
    try { summary = JSON.parse(record.summary_json); } catch (_) { summary = {}; }
  }
  const { summary_json, excel_file, pdf_file, ...rest } = record;
  return { ...rest, summary, has_excel: !!excel_file, has_pdf: !!pdf_file };
}

function registerWeeklyReportRoutes(router) {
  // Live, read-only business comparison, unlike the PDF/Excel generator.
  // A limited time window and city filtering keep the API lightweight.
  router.get('/api/weekly-reports/comparison', (req, res, ctx) => {
    if (!requireActiveAdmin(req, res, ctx)) return;
    const query=ctx.query||{};
    const rawOffset=String(query.offset ?? '0');
    if (!/^(0|[1-9][0-9]?)$/.test(rawOffset) || Number(rawOffset)>52)
      return sendJson(res,400,{error:'Можно сравнивать не более 52 завершённых недель назад'});
    const city=String(query.city||'').trim();
    if (city && !/^[a-zA-Z0-9_-]{1,64}$/.test(city))
      return sendJson(res,400,{error:'Некорректный код города'});
    try {
      const comparison=readComparison({offset:Number(rawOffset),city});
      res.setHeader('Cache-Control','private, no-store');
      sendJson(res,200,comparison);
    } catch(error) {
      if (error instanceof RangeError) return sendJson(res,400,{error:error.message});
      throw error;
    }
  });

  router.get('/api/weekly-reports', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.max(1, Math.min(100, Number(ctx.query.limit) || 30));
    sendJson(res, 200, {
      period: previousCompletedWeek(),
      reports: listWeeklyReports(limit).map(safeRecord),
    });
  });

  router.post('/api/weekly-reports', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      const body = ctx.body || {};
      // Период необязателен: без start/end — предыдущая завершённая неделя,
      // как раньше. customPeriod сам проверяет формат и границы дат.
      let period = null;
      if (body.start || body.end) {
        period = customPeriod(String(body.start || ''), String(body.end || ''));
      }
      const result = await createWeeklyReport(payload, {
        period,
        skipTelegram: body.skip_telegram === true,
      });
      sendJson(res, 201, {
        ok: true,
        report: safeRecord(result.record),
        telegram: result.telegram,
      });
    } catch (error) {
      console.error('[weekly-report] Не удалось сформировать отчёт:', error);
      sendJson(res, 500, { error: 'Не удалось сформировать отчёт: ' + error.message });
    }
  });

  router.get('/api/weekly-reports/:id/download', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const format = ctx.query.format === 'excel' ? 'excel' : 'pdf';
    const record = listWeeklyReports(100).find((item) => Number(item.id) === Number(ctx.params.id));
    if (!record) return sendJson(res, 404, { error: 'Отчёт не найден' });
    const resolved = resolveReportFile(record, format);
    if (!resolved) return sendJson(res, 404, { error: 'Файл отчёта не найден. Сформируйте отчёт повторно.' });
    const stat = fs.statSync(resolved.filePath);
    res.writeHead(200, {
      'Content-Type': format === 'excel' ? 'application/vnd.ms-excel' : 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + resolved.fileName.replace(/"/g, '') + '"',
      'Content-Length': stat.size,
      'Cache-Control': 'private, no-store',
    });
    fs.createReadStream(resolved.filePath).pipe(res);
  });
}

module.exports = { registerWeeklyReportRoutes };
