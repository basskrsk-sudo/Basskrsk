// Private share-link access to a stand-alone tasks dashboard.
// Link tokens are derived from a random /data secret and rotation counters.
// The secret and full links are never written to the git repository or server logs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTaskReminder } = require('./task-reminders');
const { nextRecurringDue } = require('./task-utils');

const PROFILES = Object.freeze([
  { key: 'admin', label: 'Администратор — все поручения', code: null },
  { key: 'alexey', label: 'Алексей', code: 'alexey' },
  { key: 'vitaly', label: 'Виталий', code: 'vitaly' },
  { key: 'angelina', label: 'Ангелина', code: 'angelina' },
  { key: 'nikolay', label: 'Николай', code: 'nikolay' },
]);
const STATUSES = new Set(['new', 'in_progress', 'blocked', 'done', 'cancelled']);
const USER_STATUSES = new Set(['new', 'in_progress', 'blocked', 'done']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const RECURRENCES = new Set(['', 'weekly:monday', 'monthly:10,25']);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_PATH = path.join(DATA_DIR, 'task-page-secret.key');

db.exec(
  'CREATE TABLE IF NOT EXISTS task_page_access (' +
  'profile_key TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1, ' +
  "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
  ')'
);
for (const item of PROFILES) {
  db.prepare('INSERT OR IGNORE INTO task_page_access(profile_key,generation) VALUES (?,1)').run(item.key);
}

function persistentSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const fd = fs.openSync(KEY_PATH, 'wx', 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32)); }
    finally { fs.closeSync(fd); }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const secret = fs.readFileSync(KEY_PATH);
  if (secret.length !== 32) throw new Error('Invalid task page secret length');
  return secret;
}
const SECRET = persistentSecret();

function accessToken(profileKey, generation) {
  return crypto.createHmac('sha256', SECRET)
    .update('hvostmarket-task-page:v1:' + profileKey + ':' + generation)
    .digest('hex');
}
function validTokenShape(input) {
  return typeof input === 'string' && /^[a-f0-9]{64}$/.test(input);
}
function findAccess(input) {
  if (!validTokenShape(input)) return null;
  const supplied = Buffer.from(input, 'hex');
  const generations = db.prepare('SELECT profile_key,generation FROM task_page_access').all();
  let matching = null;
  for (const profile of PROFILES) {
    const row = generations.find(item => item.profile_key === profile.key);
    if (!row) continue;
    const expected = Buffer.from(accessToken(profile.key, row.generation), 'hex');
    if (crypto.timingSafeEqual(supplied, expected)) matching = profile;
  }
  if (!matching) return null;
  if (matching.key === 'admin') {
    return { key: matching.key, label: matching.label, is_admin: true, assignee_id: null };
  }
  const member = db.prepare('SELECT id,full_name FROM task_assignees WHERE code=? AND active=1').get(matching.code);
  if (!member) return null;
  return { key: matching.key, label: member.full_name, is_admin: false, assignee_id: member.id };
}

function taskIdentity(req, res) {
  const bearer = /^TaskLink ([a-f0-9]{64})$/.exec(String(req.headers.authorization || ''));
  const actor = bearer ? findAccess(bearer[1]) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!actor) sendJson(res, 401, { error: 'Персональная ссылка недействительна или отозвана. Запросите новую.' });
  return actor;
}
function requireTaskAdmin(req, res) {
  const actor = taskIdentity(req, res);
  if (!actor) return null;
  if (!actor.is_admin) {
    sendJson(res, 403, { error: 'Действие доступно только администратору поручений.' });
    return null;
  }
  return actor;
}
function isOwned(actor, task) {
  return actor.is_admin || (task.assignee_id != null && Number(task.assignee_id) === Number(actor.assignee_id));
}
function safeTask(row, actor) {
  const task = {
    id: row.id, title: row.title, description: row.description,
    meeting_date: row.meeting_date, assignee_id: row.assignee_id,
    assignee_name: row.assignee_name, due_date: row.due_date,
    priority: row.priority, status: row.status, reminder_enabled: !!row.reminder_enabled,
    recurrence_rule: row.recurrence_rule, created_at: row.created_at,
    updated_at: row.updated_at, can_edit: isOwned(actor, row),
  };
  if (actor.is_admin) {
    task.telegram_connected = !!row.telegram_chat_id;
    task.max_connected = !!row.max_chat_id;
  }
  return task;
}
const SELECT_TASK = 'SELECT t.*, a.full_name AS assignee_name, ' +
  'a.telegram_chat_id, a.max_chat_id FROM meeting_tasks t ' +
  'LEFT JOIN task_assignees a ON a.id=t.assignee_id';

function getTask(id) {
  const key = Number(id);
  if (!Number.isSafeInteger(key) || key <= 0) return null;
  return db.prepare(SELECT_TASK + ' WHERE t.id=?').get(key);
}
function validatedDate(input, field) {
  if (input === undefined) return undefined;
  if (input == null || input === '') return null;
  const text = String(input);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Некорректная дата: ' + field);
  const date = new Date(text + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error('Некорректная дата: ' + field);
  }
  return text;
}
function validateMemberId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Некорректный исполнитель.');
  if (!db.prepare('SELECT id FROM task_assignees WHERE id=? AND active=1').get(n)) {
    throw new Error('Исполнитель не найден или отключён.');
  }
  return n;
}
function validateNewFields(body) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  if (!title || title.length > 250) throw new Error('Название должно содержать от 1 до 250 символов.');
  if (description.length > 4000) throw new Error('Описание слишком длинное.');
  const meeting_date = validatedDate(body.meeting_date, 'планёрка') ?? null;
  const due_date = validatedDate(body.due_date, 'срок') ?? null;
  const priority = body.priority || 'normal';
  const status = body.status || 'new';
  const recurrence_rule = body.recurrence_rule || null;
  if (!PRIORITIES.has(priority) || !STATUSES.has(status) ||
      !RECURRENCES.has(recurrence_rule || '')) throw new Error('Недопустимый статус, приоритет или повторение.');
  return {
    title, description: description || null, meeting_date, due_date, priority,
    status, recurrence_rule, assignee_id: validateMemberId(body.assignee_id),
    reminder_enabled: body.reminder_enabled === false ? 0 : 1,
  };
}
function addHistory(id, action, oldValue, newValue, actor) {
  db.prepare('INSERT INTO meeting_task_history(task_id,action,old_value,new_value,actor) VALUES (?,?,?,?,?)')
    .run(id, action, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), actor);
}
function updateTask(req, res, ctx) {
  const actor = taskIdentity(req, res);
  if (!actor) return;
  const task = getTask(ctx.params.id);
  if (!task) return sendJson(res, 404, { error: 'Поручение не найдено.' });
  if (!isOwned(actor, task)) return sendJson(res, 403, { error: 'Можно изменять только собственные поручения.' });
  const body = ctx.body || {};
  const note = String(body.comment || '').trim();
  if (note.length > 2000) return sendJson(res, 400, { error: 'Комментарий слишком длинный.' });
  if (!actor.is_admin) {
    if (Object.keys(body).some(key => !['status', 'comment'].includes(key))) {
      return sendJson(res, 403, { error: 'Исполнитель может изменять только статус и комментарий.' });
    }
    const status = body.status === undefined ? task.status : String(body.status);
    if (!USER_STATUSES.has(status)) return sendJson(res, 400, { error: 'Недопустимый статус.' });
    if (status === task.status && !note) return sendJson(res, 200, { ok: true, unchanged: true });
    let nextStatus = status, due = task.due_date, completed = status === 'done' ? new Date().toISOString() : null;
    if (status === 'done' && task.recurrence_rule) {
      due = nextRecurringDue(task.due_date, task.recurrence_rule);
      nextStatus = 'new';
      completed = null;
    }
    db.prepare("UPDATE meeting_tasks SET status=?,due_date=?,completed_at=?,updated_at=datetime('now') WHERE id=?")
      .run(nextStatus, due, completed, task.id);
    if (status !== task.status) addHistory(task.id, 'link_status', task.status, status, actor.label + ' · персональная ссылка');
    if (note) addHistory(task.id, 'link_comment', null, note, actor.label + ' · персональная ссылка');
    return sendJson(res, 200, { ok: true, status: nextStatus, next_due_date: due });
  }
  try {
    const edit = {
      title: body.title === undefined ? task.title : String(body.title || '').trim(),
      description: body.description === undefined ? task.description : String(body.description || '').trim() || null,
      meeting_date: body.meeting_date === undefined ? task.meeting_date : validatedDate(body.meeting_date, 'планёрка'),
      due_date: body.due_date === undefined ? task.due_date : validatedDate(body.due_date, 'срок'),
      priority: body.priority === undefined ? task.priority : body.priority,
      status: body.status === undefined ? task.status : body.status,
      recurrence_rule: body.recurrence_rule === undefined ? task.recurrence_rule : (body.recurrence_rule || null),
      assignee_id: body.assignee_id === undefined ? task.assignee_id : validateMemberId(body.assignee_id),
      reminder_enabled: body.reminder_enabled === undefined ? task.reminder_enabled : (body.reminder_enabled ? 1 : 0),
    };
    if (!edit.title || edit.title.length > 250 || String(edit.description || '').length > 4000) {
      throw new Error('Некорректное название или описание.');
    }
    if (!STATUSES.has(edit.status) || !PRIORITIES.has(edit.priority) ||
        !RECURRENCES.has(edit.recurrence_rule || '')) throw new Error('Недопустимый статус или приоритет.');
    let completed = edit.status === 'done' ? new Date().toISOString() : null;
    if (edit.status === 'done' && edit.recurrence_rule) {
      edit.due_date = nextRecurringDue(edit.due_date, edit.recurrence_rule);
      edit.status = 'new';
      completed = null;
    }
    db.prepare("UPDATE meeting_tasks SET meeting_date=?,title=?,description=?,assignee_id=?,due_date=?,priority=?,status=?,reminder_enabled=?,recurrence_rule=?,completed_at=?,updated_at=datetime('now') WHERE id=?")
      .run(edit.meeting_date, edit.title, edit.description, edit.assignee_id, edit.due_date,
        edit.priority, edit.status, edit.reminder_enabled, edit.recurrence_rule, completed, task.id);
    addHistory(task.id, 'link_admin_update', JSON.stringify(safeTask(task, actor)),
      JSON.stringify(edit), actor.label + ' · персональная ссылка');
    if (note) addHistory(task.id, 'link_comment', null, note, actor.label + ' · персональная ссылка');
    sendJson(res, 200, { ok: true, status: edit.status, next_due_date: edit.due_date });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}
function registerTaskPageRoutes(router) {
  // Admin-only issuing/rotating of five bookmarkable private URLs.
  router.get('/api/admin/task-links', (req, res, ctx) => {
    if (!requireAuth(['admin'])(req, res, ctx)) return;
    const rows = db.prepare('SELECT profile_key,generation,updated_at FROM task_page_access').all();
    const links = PROFILES.map(profile => {
      const row = rows.find(record => record.profile_key === profile.key);
      return {
        profile: profile.key, label: profile.label,
        hash: '#key=' + accessToken(profile.key, row.generation),
        generation: row.generation, updated_at: row.updated_at,
      };
    });
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { links });
  });
  router.post('/api/admin/task-links/:profile/rotate', (req, res, ctx) => {
    if (!requireAuth(['admin'])(req, res, ctx)) return;
    const profile = PROFILES.find(item => item.key === ctx.params.profile);
    if (!profile) return sendJson(res, 404, { error: 'Ссылка не найдена.' });
    db.prepare("UPDATE task_page_access SET generation=generation+1,updated_at=datetime('now') WHERE profile_key=?").run(profile.key);
    const row = db.prepare('SELECT generation FROM task_page_access WHERE profile_key=?').get(profile.key);
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { ok: true, profile: profile.key, hash: '#key=' + accessToken(profile.key, row.generation) });
  });
  router.get('/api/task-page/session', (req, res) => {
    const actor = taskIdentity(req, res);
    if (!actor) return;
    sendJson(res, 200, { actor });
  });
  router.get('/api/task-page/tasks', (req, res) => {
    const actor = taskIdentity(req, res);
    if (!actor) return;
    const rows = db.prepare(SELECT_TASK +
      " ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'new' THEN 1 WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, " +
      "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, " +
      'CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,t.due_date,t.id').all();
    sendJson(res, 200, { tasks: rows.map(row => safeTask(row, actor)) });
  });
  router.get('/api/task-page/assignees', (req, res) => {
    const actor = taskIdentity(req, res);
    if (!actor) return;
    const rows = db.prepare(
      'SELECT id,code,full_name,responsibility,active,phone,telegram_chat_id,max_chat_id ' +
      'FROM task_assignees ORDER BY active DESC,full_name'
    ).all();
    const members = rows.map(row => ({
      id: row.id, code: row.code, full_name: row.full_name, active: !!row.active,
      ...(actor.is_admin ? {
        responsibility: row.responsibility, phone: row.phone,
        telegram_connected: !!row.telegram_chat_id, max_connected: !!row.max_chat_id,
      } : {}),
    }));
    sendJson(res, 200, { members });
  });
  router.get('/api/task-page/meeting-notes', (req, res) => {
    if (!taskIdentity(req, res)) return;
    const notes = db.prepare('SELECT meeting_date,title,note FROM task_meeting_notes ORDER BY meeting_date DESC,source_key').all();
    sendJson(res, 200, { notes });
  });
  router.get('/api/task-page/tasks/:id/history', (req, res, ctx) => {
    const actor = taskIdentity(req, res);
    if (!actor) return;
    const task = getTask(ctx.params.id);
    if (!task) return sendJson(res, 404, { error: 'Поручение не найдено.' });
    if (!isOwned(actor, task)) return sendJson(res, 403, { error: 'История другого исполнителя недоступна.' });
    const history = db.prepare(
      'SELECT action,old_value,new_value,actor,created_at FROM meeting_task_history WHERE task_id=? ORDER BY id DESC LIMIT 100'
    ).all(task.id);
    sendJson(res, 200, { history });
  });
  router.post('/api/task-page/tasks', (req, res, ctx) => {
    const actor = requireTaskAdmin(req, res);
    if (!actor) return;
    try {
      const record = validateNewFields(ctx.body || {});
      const result = db.prepare(
        'INSERT INTO meeting_tasks(meeting_date,title,description,assignee_id,due_date,priority,status,reminder_enabled,recurrence_rule,created_by,completed_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='done' THEN datetime('now') ELSE NULL END)"
      ).run(record.meeting_date, record.title, record.description, record.assignee_id, record.due_date,
        record.priority, record.status, record.reminder_enabled, record.recurrence_rule,
        'Персональная ссылка администратора', record.status);
      addHistory(Number(result.lastInsertRowid), 'link_created', null, record.title, actor.label);
      sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
  router.put('/api/task-page/tasks/:id', updateTask);
  router.post('/api/task-page/tasks/:id/remind', async (req, res, ctx) => {
    if (!requireTaskAdmin(req, res)) return;
    const task = getTask(ctx.params.id);
    if (!task) return sendJson(res, 404, { error: 'Поручение не найдено.' });
    const result = await sendTaskReminder(task.id, { manual: true });
    sendJson(res, result.ok ? 200 : 409, result);
  });
  router.put('/api/task-page/assignees/:id', (req, res, ctx) => {
    if (!requireTaskAdmin(req, res)) return;
    const id = Number(ctx.params.id);
    const current = db.prepare('SELECT * FROM task_assignees WHERE id=?').get(id);
    if (!current) return sendJson(res, 404, { error: 'Исполнитель не найден.' });
    const body = ctx.body || {};
    const phone = String(body.phone === undefined ? current.phone || '' : body.phone).replace(/\D/g,'').slice(-10);
    const responsibility = String(body.responsibility === undefined ? current.responsibility || '' : body.responsibility).trim().slice(0, 250);
    db.prepare("UPDATE task_assignees SET phone=?,responsibility=?,updated_at=datetime('now') WHERE id=?")
      .run(phone || null, responsibility || null, id);
    sendJson(res, 200, { ok: true });
  });
  router.post('/api/task-page/assignees/:id/connect/:channel/start', (req, res, ctx) => {
    if (!requireTaskAdmin(req, res)) return;
    const member = db.prepare('SELECT id,phone FROM task_assignees WHERE id=? AND active=1').get(Number(ctx.params.id));
    if (!member) return sendJson(res, 404, { error: 'Исполнитель не найден.' });
    const phone = String(member.phone || '').replace(/\D/g,'').slice(-10);
    if (phone.length !== 10) return sendJson(res, 400, { error: 'Сначала укажите телефон исполнителя.' });
    const channel = ctx.params.channel;
    const token = crypto.randomBytes(20).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    if (channel === 'telegram') {
      if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Telegram не настроен.' });
      db.prepare("INSERT INTO telegram_login_tokens(token,phone,role,account_id,expires_at) VALUES (?,?,'task_assignee',?,?)")
        .run(token,phone,member.id,expires);
      const username = String(process.env.TG_BOT_USERNAME || 'taiga_dog_bot').replace(/^@/,'');
      return sendJson(res, 200, { token, deep_link: 'https://t.me/'+username+'?start='+token });
    }
    if (channel === 'max') {
      const { isConfigured } = require('./max-bot');
      if (!isConfigured()) return sendJson(res, 503, { error: 'MAX не настроен.' });
      db.prepare("INSERT INTO max_login_tokens(token,phone,role,account_id,expires_at) VALUES (?,?,'task_assignee',?,?)")
        .run(token,phone,member.id,expires);
      const username = String(process.env.MAX_BOT_USERNAME).replace(/^@/,'');
      return sendJson(res, 200, { token, deep_link: 'https://max.ru/'+username+'?start='+token });
    }
    sendJson(res, 400, { error: 'Неизвестный канал.' });
  });
  router.get('/api/task-page/assignees/:id/connect/:channel/check', (req, res, ctx) => {
    if (!requireTaskAdmin(req, res)) return;
    const channel = ctx.params.channel;
    const table = channel === 'telegram' ? 'telegram_login_tokens' :
      channel === 'max' ? 'max_login_tokens' : null;
    if (!table) return sendJson(res, 400, { error: 'Неизвестный канал.' });
    const record = db.prepare(
      'SELECT verified,chat_id FROM '+table+" WHERE token=? AND role='task_assignee' AND account_id=?"
    ).get(String(ctx.query.token || ''), Number(ctx.params.id));
    if (!record) return sendJson(res, 404, { error: 'Подключение не найдено.' });
    if (!record.verified || !record.chat_id) return sendJson(res, 200, { verified: false });
    const field = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
    db.prepare("UPDATE task_assignees SET "+field+"=?,updated_at=datetime('now') WHERE id=?")
      .run(String(record.chat_id),Number(ctx.params.id));
    sendJson(res, 200, { verified: true });
  });
}

module.exports = {
  registerTaskPageRoutes, accessToken, findAccess, taskIdentity, PROFILES, safeTask,
};
