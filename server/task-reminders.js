// task-reminders.js — автоматические напоминания ответственным за поручения.
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');
const { sendMaxMessage } = require('./max-bot');
const { taskButtons } = require('./task-bot-actions');

const TIME_ZONE = 'Asia/Krasnoyarsk';
let schedulerStarted = false;

function localParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDate(value = new Date()) {
  const p = localParts(value);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateDiffDays(from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function reminderKey(task, now = new Date(), manual = false) {
  const today = localDate(now);
  if (manual) return 'manual:' + now.toISOString();
  const parts = localParts(now);
  if (Number(parts.hour) !== 10) return null;
  if (task.due_date) {
    const left = dateDiffDays(today, task.due_date);
    if ([3, 1, 0].includes(left)) return 'due:' + task.due_date + ':' + left;
    if (left < 0) return 'overdue:' + today;
    return null;
  }
  return parts.weekday === 'Mon' ? 'weekly:' + today : null;
}

function statusLine(task, today) {
  if (!task.due_date) return 'Срок: не установлен';
  const left = dateDiffDays(today, task.due_date);
  if (left < 0) return '⚠️ Просрочено на ' + Math.abs(left) + ' дн. · срок ' + task.due_date;
  if (left === 0) return '⏰ Срок сегодня: ' + task.due_date;
  return 'Срок: ' + task.due_date + ' · осталось ' + left + ' дн.';
}

function buildTaskReminder(task, now = new Date()) {
  const lines = [
    '📌 Поручение ХвостМаркета',
    '',
    'Ответственный: ' + task.assignee_name,
    'Задача: ' + task.title,
  ];
  if (task.description) lines.push('Что сделать: ' + task.description);
  lines.push(statusLine(task, localDate(now)));
  if (task.meeting_date) lines.push('Планёрка: ' + task.meeting_date);
  if (task.priority === 'critical') lines.push('Приоритет: критический');
  else if (task.priority === 'high') lines.push('Приоритет: высокий');
  lines.push('', 'Измените статус кнопкой под сообщением или в админке: ' + String(process.env.PUBLIC_URL || process.env.SITE_URL || 'https://xn----7sbal3ajopsm.xn--p1ai').replace(/\/$/, '') + '/taiga-admin.html');
  return lines.join('\n');
}

function telegramText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function deliver(task, key, channel, message) {
  const reservation = db.prepare(`
    INSERT OR IGNORE INTO task_reminder_log
      (task_id, assignee_id, reminder_key, channel, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(task.id, task.assignee_id, key, channel);
  if (!reservation.changes) return { channel, skipped: true, ok: false };
  let result;
  try {
    result = channel === 'telegram'
      ? await sendToChat(task.telegram_chat_id, telegramText(message), { reply_markup: taskButtons(task, 'telegram') })
      : await sendMaxMessage(task.max_chat_id, message, taskButtons(task, 'max'));
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const ok = channel === 'telegram'
    ? !!(result && result.ok)
    : !!(result && result.ok !== false && !result.error);
  const error = ok ? null : String((result && result.error) || 'Канал не ответил').slice(0, 500);
  db.prepare(`
    UPDATE task_reminder_log
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE task_id = ? AND reminder_key = ? AND channel = ?
  `).run(ok ? 'sent' : 'failed', error, ok ? 1 : 0, task.id, key, channel);
  return { channel, ok, error };
}

function getTask(taskId) {
  return db.prepare(`
    SELECT t.*, a.full_name AS assignee_name, a.telegram_chat_id, a.max_chat_id
    FROM meeting_tasks t
    LEFT JOIN task_assignees a ON a.id = t.assignee_id AND a.active = 1
    WHERE t.id = ?
  `).get(taskId);
}

async function sendTaskReminder(taskId, options = {}) {
  const now = options.now || new Date();
  const task = getTask(taskId);
  if (!task) return { ok: false, error: 'Поручение не найдено', deliveries: [] };
  if (!task.assignee_id || !task.assignee_name) return { ok: false, error: 'Ответственный не назначен', deliveries: [] };
  if (!options.manual && (!task.reminder_enabled || ['done', 'cancelled'].includes(task.status))) {
    return { ok: false, skipped: true, deliveries: [] };
  }
  const key = reminderKey(task, now, !!options.manual);
  if (!key) return { ok: false, skipped: true, deliveries: [] };
  const message = buildTaskReminder(task, now);
  const deliveries = [];
  if (task.telegram_chat_id) deliveries.push(await deliver(task, key, 'telegram', message));
  if (task.max_chat_id) deliveries.push(await deliver(task, key, 'max', message));
  if (!deliveries.length) return { ok: false, error: 'У ответственного не подключены Telegram и MAX', deliveries: [] };
  return { ok: deliveries.some((item) => item.ok), message, deliveries };
}

async function runTaskReminderCheck(now = new Date()) {
  const tasks = db.prepare(`
    SELECT id FROM meeting_tasks
    WHERE reminder_enabled = 1 AND status NOT IN ('done', 'cancelled') AND assignee_id IS NOT NULL
  `).all();
  const results = [];
  for (const task of tasks) {
    const result = await sendTaskReminder(task.id, { now });
    if (!result.skipped) results.push({ task_id: task.id, ...result });
  }
  return results;
}

function scheduleTaskReminders() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const first = setTimeout(() => runTaskReminderCheck().catch((error) => console.warn('Поручения: ошибка напоминаний:', error.message)), 30000);
  const interval = setInterval(() => runTaskReminderCheck().catch((error) => console.warn('Поручения: ошибка напоминаний:', error.message)), 10 * 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  if (typeof interval.unref === 'function') interval.unref();
}

module.exports = {
  TIME_ZONE,
  buildTaskReminder,
  localDate,
  reminderKey,
  runTaskReminderCheck,
  scheduleTaskReminders,
  sendTaskReminder,
};
