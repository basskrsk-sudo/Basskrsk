// routes-tasks.js — поручения планёрок, ответственные и каналы напоминаний.
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { localDate, sendTaskReminder } = require('./task-reminders');
const { nextRecurringDue } = require('./task-utils');

const STATUSES = new Set(['new', 'in_progress', 'blocked', 'done', 'cancelled']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const RECURRENCES = new Set(['', 'weekly:monday', 'monthly:10,25']);

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function listTasks() {
  return db.prepare(`
    SELECT t.*, a.full_name AS assignee_name, a.telegram_chat_id, a.max_chat_id,
      (SELECT MAX(sent_at) FROM task_reminder_log r WHERE r.task_id = t.id AND r.status = 'sent') AS last_reminder_at,
      (SELECT COUNT(*) FROM task_reminder_log r WHERE r.task_id = t.id AND r.status = 'failed') AS reminder_errors
    FROM meeting_tasks t
    LEFT JOIN task_assignees a ON a.id = t.assignee_id
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'new' THEN 1 WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.id
  `).all();
}

function taskSnapshot(task) {
  return JSON.stringify({
    title: task.title, description: task.description, assignee_id: task.assignee_id,
    due_date: task.due_date, priority: task.priority, status: task.status,
    reminder_enabled: task.reminder_enabled, recurrence_rule: task.recurrence_rule,
  });
}

function registerTaskRoutes(router) {
  router.get('/api/tasks', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const tasks = listTasks();
    const active = tasks.filter((task) => !['done', 'cancelled'].includes(task.status));
    const today = localDate();
    sendJson(res, 200, {
      tasks,
      summary: {
        total: tasks.length,
        active: active.length,
        overdue: active.filter((task) => task.due_date && task.due_date < today).length,
        unassigned: active.filter((task) => !task.assignee_id).length,
        blocked: active.filter((task) => task.status === 'blocked').length,
      },
    });
  });

  router.get('/api/task-assignees', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const members = db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM meeting_tasks t WHERE t.assignee_id = a.id AND t.status NOT IN ('done','cancelled')) AS active_tasks
      FROM task_assignees a ORDER BY a.active DESC, a.full_name
    `).all();
    sendJson(res, 200, { members });
  });

  router.post('/api/tasks', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const body = ctx.body || {};
    const title = String(body.title || '').trim();
    const status = STATUSES.has(body.status) ? body.status : 'new';
    const priority = PRIORITIES.has(body.priority) ? body.priority : 'normal';
    const recurrence = RECURRENCES.has(body.recurrence_rule || '') ? (body.recurrence_rule || null) : null;
    if (!title) return sendJson(res, 400, { error: 'Укажите название поручения' });
    const info = db.prepare(`
      INSERT INTO meeting_tasks
        (meeting_date, title, description, assignee_id, due_date, priority, status,
         reminder_enabled, recurrence_rule, created_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END)
    `).run(
      body.meeting_date || null, title, String(body.description || '').trim() || null,
      body.assignee_id ? Number(body.assignee_id) : null, body.due_date || null,
      priority, status, body.reminder_enabled === false ? 0 : 1, recurrence,
      payload.login || 'admin', status
    );
    db.prepare("INSERT INTO meeting_task_history (task_id, action, new_value, actor) VALUES (?, 'created', ?, ?)")
      .run(info.lastInsertRowid, JSON.stringify({ title }), payload.login || 'admin');
    sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
  });

  router.put('/api/tasks/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM meeting_tasks WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Поручение не найдено' });
    const body = ctx.body || {};
    const title = body.title === undefined ? existing.title : String(body.title || '').trim();
    if (!title) return sendJson(res, 400, { error: 'Название поручения не может быть пустым' });
    const status = body.status === undefined ? existing.status : body.status;
    const priority = body.priority === undefined ? existing.priority : body.priority;
    const recurrenceRaw = body.recurrence_rule === undefined ? (existing.recurrence_rule || '') : (body.recurrence_rule || '');
    if (!STATUSES.has(status)) return sendJson(res, 400, { error: 'Неизвестный статус' });
    if (!PRIORITIES.has(priority)) return sendJson(res, 400, { error: 'Неизвестный приоритет' });
    if (!RECURRENCES.has(recurrenceRaw)) return sendJson(res, 400, { error: 'Неизвестное правило повторения' });
    let dueDate = body.due_date === undefined ? existing.due_date : (body.due_date || null);
    let finalStatus = status;
    let completedAt = status === 'done' ? new Date().toISOString() : null;
    const recurrence = recurrenceRaw || null;
    if (status === 'done' && recurrence) {
      dueDate = nextRecurringDue(dueDate, recurrence);
      finalStatus = 'new';
      completedAt = null;
    }
    const updated = {
      ...existing,
      meeting_date: body.meeting_date === undefined ? existing.meeting_date : (body.meeting_date || null),
      title,
      description: body.description === undefined ? existing.description : (String(body.description || '').trim() || null),
      assignee_id: body.assignee_id === undefined ? existing.assignee_id : (body.assignee_id ? Number(body.assignee_id) : null),
      due_date: dueDate,
      priority,
      status: finalStatus,
      reminder_enabled: body.reminder_enabled === undefined ? existing.reminder_enabled : (body.reminder_enabled ? 1 : 0),
      recurrence_rule: recurrence,
    };
    db.prepare(`
      UPDATE meeting_tasks SET meeting_date=?, title=?, description=?, assignee_id=?, due_date=?,
        priority=?, status=?, reminder_enabled=?, recurrence_rule=?, completed_at=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      updated.meeting_date, updated.title, updated.description, updated.assignee_id, updated.due_date,
      updated.priority, updated.status, updated.reminder_enabled, updated.recurrence_rule, completedAt, existing.id
    );
    db.prepare("INSERT INTO meeting_task_history (task_id, action, old_value, new_value, actor) VALUES (?, 'updated', ?, ?, ?)")
      .run(existing.id, taskSnapshot(existing), taskSnapshot(updated), payload.login || 'admin');
    sendJson(res, 200, { ok: true, recurring_advanced: status === 'done' && !!recurrence, next_due_date: dueDate });
  });

  router.get('/api/tasks/:id/history', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare('SELECT * FROM meeting_task_history WHERE task_id = ? ORDER BY id DESC LIMIT 100').all(ctx.params.id);
    sendJson(res, 200, { history: rows });
  });

  router.post('/api/tasks/:id/remind', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const result = await sendTaskReminder(Number(ctx.params.id), { manual: true });
    sendJson(res, result.ok ? 200 : 409, result);
  });

  router.put('/api/task-assignees/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM task_assignees WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Ответственный не найден' });
    const body = ctx.body || {};
    db.prepare(`
      UPDATE task_assignees SET full_name=?, responsibility=?, phone=?, active=?, updated_at=datetime('now') WHERE id=?
    `).run(
      String(body.full_name === undefined ? existing.full_name : body.full_name).trim() || existing.full_name,
      String(body.responsibility === undefined ? (existing.responsibility || '') : body.responsibility).trim() || null,
      normalizePhone(body.phone === undefined ? existing.phone : body.phone) || null,
      body.active === undefined ? existing.active : (body.active ? 1 : 0),
      existing.id
    );
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/task-assignees/:id/connect/:channel/start', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const member = db.prepare('SELECT * FROM task_assignees WHERE id = ? AND active = 1').get(ctx.params.id);
    if (!member) return sendJson(res, 404, { error: 'Ответственный не найден' });
    const phone = normalizePhone(member.phone);
    if (phone.length !== 10) return sendJson(res, 400, { error: 'Сначала сохраните телефон ответственного' });
    const channel = ctx.params.channel;
    const token = crypto.randomBytes(20).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    if (channel === 'telegram') {
      if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Telegram-бот не настроен' });
      db.prepare("INSERT INTO telegram_login_tokens (token, phone, role, account_id, expires_at) VALUES (?, ?, 'task_assignee', ?, ?)")
        .run(token, phone, member.id, expiresAt);
      const username = String(process.env.TG_BOT_USERNAME || 'taiga_dog_bot').replace(/^@/, '');
      return sendJson(res, 200, { token, deep_link: 'https://t.me/' + username + '?start=' + token });
    }
    if (channel === 'max') {
      const { isConfigured } = require('./max-bot');
      if (!isConfigured()) return sendJson(res, 503, { error: 'MAX-бот не настроен' });
      db.prepare("INSERT INTO max_login_tokens (token, phone, role, account_id, expires_at) VALUES (?, ?, 'task_assignee', ?, ?)")
        .run(token, phone, member.id, expiresAt);
      const username = String(process.env.MAX_BOT_USERNAME).replace(/^@/, '');
      return sendJson(res, 200, { token, deep_link: 'https://max.ru/' + username + '?start=' + token });
    }
    sendJson(res, 400, { error: 'Неизвестный канал' });
  });

  router.get('/api/task-assignees/:id/connect/:channel/check', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const channel = ctx.params.channel;
    const table = channel === 'telegram' ? 'telegram_login_tokens' : channel === 'max' ? 'max_login_tokens' : null;
    if (!table) return sendJson(res, 400, { error: 'Неизвестный канал' });
    const record = db.prepare(`SELECT * FROM ${table} WHERE token = ? AND role = 'task_assignee' AND account_id = ?`).get(String(ctx.query.token || ''), ctx.params.id);
    if (!record) return sendJson(res, 404, { error: 'Подключение не найдено' });
    if (!record.verified || !record.chat_id) return sendJson(res, 200, { verified: false });
    const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
    db.prepare(`UPDATE task_assignees SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(String(record.chat_id), ctx.params.id);
    sendJson(res, 200, { verified: true });
  });
}

module.exports = { registerTaskRoutes, nextRecurringDue };
