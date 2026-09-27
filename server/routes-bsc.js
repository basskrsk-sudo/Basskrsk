// routes-bsc.js — API стратегического дашборда и планов улучшения.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, requireSuperAdmin } = require('./routes-auth');
const { collectWeeklyReport } = require('./weekly-report');
const { KPI_DEFINITIONS, PERSPECTIVES, calculateBsc, seedSettings } = require('./bsc');

const ALLOWED_STATUSES = new Set(['planned', 'in_progress', 'done', 'cancelled']);
const PERSPECTIVE_KEYS = new Set(PERSPECTIVES.map((item) => item.key));
const KPI_KEYS = new Set(KPI_DEFINITIONS.map((item) => item.key));

function listInitiatives() {
  return db.prepare(`
    SELECT * FROM bsc_initiatives
    ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
             due_date, id DESC LIMIT 200
  `).all().map((row) => ({
    ...row,
    overdue: !['done', 'cancelled'].includes(row.status) && row.due_date < new Date().toISOString().slice(0, 10),
  }));
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function registerBscRoutes(router) {
  router.get('/api/bsc/dashboard', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const report = collectWeeklyReport();
    const bsc = calculateBsc(report);
    sendJson(res, 200, {
      ...bsc,
      initiatives: listInitiatives(),
      settings_history: db.prepare('SELECT * FROM bsc_settings_log ORDER BY id DESC LIMIT 10').all(),
    });
  });

  router.put('/api/bsc/settings', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    seedSettings();
    const targets = ctx.body && ctx.body.targets || {};
    const weights = ctx.body && ctx.body.perspective_weights || {};
    const targetChanges = {};
    const weightChanges = {};
    const currentTargets = new Map(db.prepare('SELECT kpi_key, target_value FROM bsc_kpi_settings').all().map((row) => [row.kpi_key, Number(row.target_value)]));
    const currentWeights = new Map(db.prepare('SELECT perspective_key, weight FROM bsc_perspective_settings').all().map((row) => [row.perspective_key, Number(row.weight)]));
    for (const [key, rawValue] of Object.entries(targets)) {
      if (!KPI_KEYS.has(key)) return sendJson(res, 400, { error: 'Неизвестный показатель: ' + key });
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > 10000000) return sendJson(res, 400, { error: 'Некорректная цель для ' + key });
      if (Math.abs(value - Number(currentTargets.get(key))) > 0.0001) targetChanges[key] = value;
    }
    for (const [key, rawValue] of Object.entries(weights)) {
      if (!PERSPECTIVE_KEYS.has(key)) return sendJson(res, 400, { error: 'Неизвестное направление: ' + key });
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > 100) return sendJson(res, 400, { error: 'Некорректный вес направления ' + key });
      if (Math.abs(value - Number(currentWeights.get(key))) > 0.0001) weightChanges[key] = value;
    }
    const mergedWeights = new Map(currentWeights);
    Object.entries(weightChanges).forEach(([key, value]) => mergedWeights.set(key, value));
    const totalWeight = Array.from(mergedWeights.values()).reduce((sum, value) => sum + value, 0);
    if (Math.abs(totalWeight - 100) > 0.01) return sendJson(res, 400, { error: 'Сумма весов четырёх направлений должна быть равна 100%' });
    if (!Object.keys(targetChanges).length && !Object.keys(weightChanges).length) return sendJson(res, 200, { ok: true, unchanged: true });
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateTarget = db.prepare("UPDATE bsc_kpi_settings SET target_value = ?, updated_by = ?, updated_at = datetime('now') WHERE kpi_key = ?");
      Object.entries(targetChanges).forEach(([key, value]) => updateTarget.run(value, payload.login || null, key));
      const updateWeight = db.prepare("UPDATE bsc_perspective_settings SET weight = ?, updated_by = ?, updated_at = datetime('now') WHERE perspective_key = ?");
      Object.entries(weightChanges).forEach(([key, value]) => updateWeight.run(value, payload.login || null, key));
      db.prepare('INSERT INTO bsc_settings_log (admin_id, admin_login, changes_json) VALUES (?, ?, ?)')
        .run(payload.id || null, payload.login || null, JSON.stringify({ targets: targetChanges, perspective_weights: weightChanges }));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/bsc/initiatives', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const body = ctx.body || {};
    const perspective = cleanText(body.perspective_key, 30);
    const kpi = cleanText(body.kpi_key, 60) || null;
    const title = cleanText(body.title, 160);
    const action = cleanText(body.action, 2000);
    const responsible = cleanText(body.responsible, 160);
    const dueDate = cleanText(body.due_date, 10);
    if (!PERSPECTIVE_KEYS.has(perspective) || (kpi && !KPI_KEYS.has(kpi))) return sendJson(res, 400, { error: 'Выберите корректное направление и показатель' });
    if (!title || !action || !responsible || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendJson(res, 400, { error: 'Заполните название, действие, ответственного и срок' });
    const info = db.prepare(`
      INSERT INTO bsc_initiatives
        (perspective_key, kpi_key, title, problem, action, responsible, due_date, expected_result, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(perspective, kpi, title, cleanText(body.problem, 2000) || null, action, responsible, dueDate, cleanText(body.expected_result, 2000) || null, payload.login || null);
    sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
  });

  router.put('/api/bsc/initiatives/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM bsc_initiatives WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'План улучшения не найден' });
    const body = ctx.body || {};
    const status = body.status === undefined ? existing.status : cleanText(body.status, 30);
    if (!ALLOWED_STATUSES.has(status)) return sendJson(res, 400, { error: 'Неизвестный статус плана' });
    const responsible = body.responsible === undefined ? existing.responsible : cleanText(body.responsible, 160);
    const dueDate = body.due_date === undefined ? existing.due_date : cleanText(body.due_date, 10);
    const resultComment = body.result_comment === undefined ? existing.result_comment : cleanText(body.result_comment, 2000) || null;
    if (!responsible || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendJson(res, 400, { error: 'Укажите ответственного и корректный срок' });
    db.prepare("UPDATE bsc_initiatives SET status = ?, responsible = ?, due_date = ?, result_comment = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, responsible, dueDate, resultComment, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/bsc/initiatives/:id', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    const info = db.prepare('DELETE FROM bsc_initiatives WHERE id = ?').run(ctx.params.id);
    if (!info.changes) return sendJson(res, 404, { error: 'План улучшения не найден' });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerBscRoutes };
