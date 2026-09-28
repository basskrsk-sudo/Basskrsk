// task-bot-actions.js — безопасное изменение назначенных поручений из ботов.
'use strict';

const db = require('./db');
const { nextRecurringDue } = require('./task-utils');

function expectedDue(task) {
  return task.due_date || '-';
}

function taskButtons(task, channel) {
  const due = expectedDue(task);
  const payload = (action) => `tsk:${task.id}:${action}:${due}`;
  if (channel === 'telegram') {
    return {
      inline_keyboard: [
        [
          { text: '▶️ В работу', callback_data: payload('work') },
          { text: '💬 Статус', callback_data: payload('status') },
        ],
        [{ text: '✅ Выполнено', callback_data: payload('done') }],
      ],
    };
  }
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          { type: 'callback', text: '▶️ В работу', payload: payload('work') },
          { type: 'callback', text: '💬 Статус', payload: payload('status') },
        ],
        [{ type: 'callback', text: '✅ Выполнено', payload: payload('done') }],
      ],
    },
  }];
}

function parsePayload(value) {
  const match = String(value || '').match(/^tsk:(\d+):(work|status|done):(\d{4}-\d{2}-\d{2}|-)$/);
  return match ? { taskId: Number(match[1]), action: match[2], expectedDue: match[3] } : null;
}

function assignedTask(channel, chatId, taskId) {
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  if (!['telegram', 'max'].includes(channel)) return null;
  return db.prepare(`
    SELECT t.*, a.full_name AS assignee_name
    FROM meeting_tasks t
    JOIN task_assignees a ON a.id = t.assignee_id AND a.active = 1
    WHERE t.id = ? AND a.${column} = ?
  `).get(taskId, String(chatId));
}

function getTaskInbox(channel, chatId) {
  if (!['telegram', 'max'].includes(channel) || !chatId) return null;
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  const assignee = db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 AND ${column} = ?
  `).get(String(chatId));
  if (!assignee) return null;
  const tasks = db.prepare(`
    SELECT t.*, ? AS assignee_name
    FROM meeting_tasks t
    WHERE t.assignee_id = ? AND t.status NOT IN ('done', 'cancelled')
    ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
             t.due_date,
             CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.id
    LIMIT 20
  `).all(assignee.full_name, assignee.id);
  return { assignee, tasks };
}

function taskBotCard(task) {
  const statusNames = { new: 'Новое', in_progress: 'В работе', blocked: 'Заблокировано' };
  const lines = [
    `📌 Поручение №${task.id}`,
    task.title,
    `Статус: ${statusNames[task.status] || task.status}`,
    `Срок: ${task.due_date || 'не установлен'}`,
  ];
  if (task.description) lines.push('Что сделать: ' + task.description);
  return lines.join('\n');
}

function addHistory(taskId, action, oldValue, newValue, actor) {
  db.prepare(`
    INSERT INTO meeting_task_history (task_id, action, old_value, new_value, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, action, oldValue || null, newValue || null, actor || 'бот');
}

function handleTaskCallback(channel, chatId, rawPayload) {
  const parsed = parsePayload(rawPayload);
  if (!parsed) return null;
  const task = assignedTask(channel, chatId, parsed.taskId);
  if (!task) return { ok: false, message: 'Это поручение не назначено вам или подключение устарело.' };
  if (expectedDue(task) !== parsed.expectedDue) {
    return { ok: false, message: 'Поручение уже изменилось. Откройте последнее напоминание.' };
  }
  if (['done', 'cancelled'].includes(task.status)) {
    return { ok: false, message: task.status === 'done' ? 'Поручение уже выполнено.' : 'Поручение отменено.' };
  }

  if (parsed.action === 'status') {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO task_bot_pending_inputs
        (channel, chat_id, task_id, expected_due, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(channel, String(chatId), task.id, parsed.expectedDue, expiresAt);
    return { ok: true, askStatus: true, message: 'Напишите одним сообщением текущий статус, результат или причину задержки по поручению «' + task.title + '».' };
  }

  if (parsed.action === 'work') {
    if (task.status !== 'in_progress') {
      db.prepare("UPDATE meeting_tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?").run(task.id);
      addHistory(task.id, 'bot_status', task.status, 'in_progress', task.assignee_name + ' · ' + channel);
    }
    return { ok: true, message: 'Поручение отмечено «В работе».' };
  }

  if (task.recurrence_rule) {
    const nextDue = nextRecurringDue(task.due_date, task.recurrence_rule);
    db.prepare("UPDATE meeting_tasks SET status='new', due_date=?, completed_at=NULL, updated_at=datetime('now') WHERE id=?")
      .run(nextDue, task.id);
    addHistory(task.id, 'bot_completed_recurring', task.due_date, nextDue, task.assignee_name + ' · ' + channel);
    return { ok: true, message: '✅ Выполнение зафиксировано. Следующий срок: ' + nextDue + '.' };
  }

  db.prepare("UPDATE meeting_tasks SET status='done', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(task.id);
  addHistory(task.id, 'bot_completed', task.status, 'done', task.assignee_name + ' · ' + channel);
  return { ok: true, message: '✅ Поручение закрыто как выполненное.' };
}

function handleTaskStatusMessage(channel, chatId, text) {
  const statusText = String(text || '').trim();
  if (!statusText || statusText.startsWith('/')) return null;
  const pending = db.prepare(`
    SELECT * FROM task_bot_pending_inputs
    WHERE channel = ? AND chat_id = ? AND datetime(expires_at) > datetime('now')
  `).get(channel, String(chatId));
  if (!pending) return null;
  const task = assignedTask(channel, chatId, pending.task_id);
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  if (!task) return { ok: false, message: 'Не удалось записать статус: поручение больше не назначено вам.' };
  if (expectedDue(task) !== pending.expected_due) return { ok: false, message: 'Поручение уже изменилось; статус не записан.' };
  if (['done', 'cancelled'].includes(task.status)) return { ok: false, message: 'Поручение уже закрыто; статус не записан.' };
  const safeText = statusText.slice(0, 2000);
  if (task.status === 'new') {
    db.prepare("UPDATE meeting_tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?").run(task.id);
  } else {
    db.prepare("UPDATE meeting_tasks SET updated_at=datetime('now') WHERE id=?").run(task.id);
  }
  addHistory(task.id, 'status_report', null, safeText, task.assignee_name + ' · ' + channel);
  return { ok: true, message: '✅ Статус записан в поручение и виден в админке.' };
}

module.exports = {
  getTaskInbox,
  handleTaskCallback,
  handleTaskStatusMessage,
  parsePayload,
  taskBotCard,
  taskButtons,
};
