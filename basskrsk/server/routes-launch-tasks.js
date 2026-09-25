// routes-launch-tasks.js — чек-лист по запуску проекта, с сохранением
// отметок о выполнении в базе (не просто текст, а рабочий список).
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

function registerLaunchTaskRoutes(router) {
  // GET /api/launch-tasks — список всех задач
  router.get('/api/launch-tasks', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare('SELECT * FROM launch_tasks ORDER BY category, sort_order').all();
    sendJson(res, 200, { tasks: rows });
  });

  // PUT /api/launch-tasks/:id — отметить выполненной/невыполненной
  router.put('/api/launch-tasks/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM launch_tasks WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Задача не найдена' });
    const { done } = ctx.body || {};
    db.prepare('UPDATE launch_tasks SET done = ? WHERE id = ?').run(done ? 1 : 0, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/launch-tasks — добавить свою задачу
  router.post('/api/launch-tasks', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { category, title, note } = ctx.body || {};
    if (!category || !title) return sendJson(res, 400, { error: 'Укажите category и title' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM launch_tasks WHERE category = ?').get(category);
    const info = db.prepare('INSERT INTO launch_tasks (category, title, note, done, sort_order) VALUES (?, ?, ?, 0, ?)')
      .run(category, title, note || null, (maxOrder.m ?? -1) + 1);
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // DELETE /api/launch-tasks/:id
  router.delete('/api/launch-tasks/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM launch_tasks WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerLaunchTaskRoutes };
