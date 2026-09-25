// routes-weekly-reports.js — создание и скачивание управленческих отчётов.
'use strict';

const fs = require('node:fs');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const {
  createWeeklyReport,
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
      const result = await createWeeklyReport(payload);
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
