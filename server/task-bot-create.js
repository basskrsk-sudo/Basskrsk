// task-bot-create.js — пошаговое создание поручения из Telegram.
'use strict';

const db = require('./db');
const { localDate } = require('./task-reminders');

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function creatorForChat(channel, chatId) {
  if (channel !== 'telegram' || !chatId) return null;
  return db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 AND telegram_chat_id = ?
    ORDER BY id LIMIT 1
  `).get(String(chatId));
}

function newTaskButton() {
  return { inline_keyboard: [[{ text: '➕ Новая задача', callback_data: 'newtsk:start' }]] };
}

function assigneeButtons() {
  const members = db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 ORDER BY full_name, id
  `).all();
  const rows = [];
  for (let index = 0; index < members.length; index += 2) {
    rows.push(members.slice(index, index + 2).map((member) => ({
      text: member.full_name,
      callback_data: 'newtsk:assignee:' + member.id,
    })));
  }
  rows.push([{ text: '✕ Отмена', callback_data: 'newtsk:cancel' }]);
  return { inline_keyboard: rows };
}

function dueDateButtons() {
  return {
    inline_keyboard: [
      [
        { text: 'Сегодня', callback_data: 'newtsk:due:today' },
        { text: 'Завтра', callback_data: 'newtsk:due:tomorrow' },
      ],
      [
        { text: 'Через 7 дней', callback_data: 'newtsk:due:week' },
        { text: 'Без срока', callback_data: 'newtsk:due:none' },
      ],
      [{ text: '✕ Отмена', callback_data: 'newtsk:cancel' }],
    ],
  };
}

function draftForChat(channel, chatId) {
  const draft = db.prepare(`
    SELECT * FROM task_bot_create_drafts
    WHERE channel = ? AND chat_id = ? AND datetime(expires_at) > datetime('now')
  `).get(channel, String(chatId));
  if (draft) return draft;
  db.prepare('DELETE FROM task_bot_create_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId));
  return null;
}

function startTaskCreation(channel, chatId) {
  const creator = creatorForChat(channel, chatId);
  if (!creator) {
    return {
      ok: false,
      message: 'Создание задач доступно только подключённым ответственным. Подключите Telegram в разделе «Поручения» админки.',
    };
  }
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId));
  db.prepare(`
    INSERT OR REPLACE INTO task_bot_create_drafts
      (channel, chat_id, creator_assignee_id, step, title, assignee_id, expires_at, updated_at)
    VALUES (?, ?, ?, 'title', NULL, NULL, ?, datetime('now'))
  `).run(channel, String(chatId), creator.id, expiresAt);
  return {
    ok: true,
    message: '➕ Новая задача\n\nНапишите одним сообщением короткое название задачи. Для отмены используйте /cancel.',
  };
}

function cancelTaskCreation(channel, chatId) {
  const changes = db.prepare('DELETE FROM task_bot_create_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId)).changes;
  return changes > 0;
}

function addDays(dateString, days) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDueDate(value) {
  const text = String(value || '').trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else {
    match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!match) return null;
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function dueDateFromChoice(choice) {
  const today = localDate();
  if (choice === 'today') return today;
  if (choice === 'tomorrow') return addDays(today, 1);
  if (choice === 'week') return addDays(today, 7);
  if (choice === 'none') return null;
  return undefined;
}

function finishTaskCreation(channel, chatId, dueDate) {
  const draft = draftForChat(channel, chatId);
  if (!draft || draft.step !== 'due_date' || !draft.title || !draft.assignee_id) {
    return { ok: false, message: 'Черновик задачи устарел. Начните заново командой /newtask.' };
  }
  const creator = db.prepare('SELECT id, full_name FROM task_assignees WHERE id = ? AND active = 1')
    .get(draft.creator_assignee_id);
  const assignee = db.prepare(`
    SELECT id, full_name, telegram_chat_id FROM task_assignees
    WHERE id = ? AND active = 1
  `).get(draft.assignee_id);
  if (!creator || !assignee) {
    cancelTaskCreation(channel, chatId);
    return { ok: false, message: 'Создатель или ответственный больше не активен. Начните создание задачи заново.' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const actor = creator.full_name + ' · Telegram';
    const info = db.prepare(`
      INSERT INTO meeting_tasks
        (title, assignee_id, due_date, priority, status, reminder_enabled, created_by)
      VALUES (?, ?, ?, 'normal', 'new', 1, ?)
    `).run(draft.title, assignee.id, dueDate, actor);
    const taskId = Number(info.lastInsertRowid);
    db.prepare(`
      INSERT INTO meeting_task_history (task_id, action, new_value, actor)
      VALUES (?, 'created_from_telegram', ?, ?)
    `).run(taskId, JSON.stringify({ title: draft.title, assignee_id: assignee.id, due_date: dueDate }), actor);
    db.prepare('DELETE FROM task_bot_create_drafts WHERE channel = ? AND chat_id = ?')
      .run(channel, String(chatId));
    db.exec('COMMIT');
    const task = db.prepare('SELECT * FROM meeting_tasks WHERE id = ?').get(taskId);
    return {
      ok: true,
      created: true,
      task,
      assignee,
      message: [
        '✅ Задача создана',
        '',
        '№' + task.id + ' · ' + task.title,
        'Ответственный: ' + assignee.full_name,
        'Срок: ' + (task.due_date || 'не установлен'),
      ].join('\n'),
      replyMarkup: newTaskButton(),
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function handleTaskCreateCallback(channel, chatId, rawPayload) {
  const payload = String(rawPayload || '');
  if (!payload.startsWith('newtsk:')) return null;
  if (payload === 'newtsk:start') return startTaskCreation(channel, chatId);
  if (payload === 'newtsk:cancel') {
    cancelTaskCreation(channel, chatId);
    return { ok: true, message: 'Создание задачи отменено.', replyMarkup: newTaskButton() };
  }

  const assigneeMatch = payload.match(/^newtsk:assignee:(\d+)$/);
  if (assigneeMatch) {
    const draft = draftForChat(channel, chatId);
    if (!draft || draft.step !== 'assignee') {
      return { ok: false, message: 'Черновик задачи устарел. Начните заново командой /newtask.' };
    }
    const assignee = db.prepare('SELECT id, full_name FROM task_assignees WHERE id = ? AND active = 1')
      .get(Number(assigneeMatch[1]));
    if (!assignee) return { ok: false, message: 'Ответственный не найден или отключён.' };
    db.prepare(`
      UPDATE task_bot_create_drafts
      SET assignee_id = ?, step = 'due_date', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(assignee.id, channel, String(chatId));
    return {
      ok: true,
      message: 'Ответственный: ' + assignee.full_name + '.\n\nВыберите срок или отправьте дату сообщением в формате ДД.ММ.ГГГГ.',
      replyMarkup: dueDateButtons(),
    };
  }

  const dueMatch = payload.match(/^newtsk:due:(today|tomorrow|week|none)$/);
  if (dueMatch) return finishTaskCreation(channel, chatId, dueDateFromChoice(dueMatch[1]));
  return { ok: false, message: 'Неизвестное действие. Начните заново командой /newtask.' };
}

function handleTaskCreateMessage(channel, chatId, text) {
  const draft = draftForChat(channel, chatId);
  if (!draft) return null;
  const value = String(text || '').trim();
  if (!value || value.startsWith('/')) return null;
  if (draft.step === 'title') {
    const title = value.slice(0, 300);
    db.prepare(`
      UPDATE task_bot_create_drafts
      SET title = ?, step = 'assignee', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(title, channel, String(chatId));
    return {
      ok: true,
      message: 'Задача: «' + title + '».\n\nВыберите ответственного:',
      replyMarkup: assigneeButtons(),
    };
  }
  if (draft.step === 'assignee') {
    return { ok: false, message: 'Выберите ответственного кнопкой под предыдущим сообщением.', replyMarkup: assigneeButtons() };
  }
  if (draft.step === 'due_date') {
    const dueDate = parseDueDate(value);
    if (!dueDate) {
      return { ok: false, message: 'Не понял дату. Отправьте её в формате ДД.ММ.ГГГГ, например 15.10.2026, или выберите кнопку.', replyMarkup: dueDateButtons() };
    }
    return finishTaskCreation(channel, chatId, dueDate);
  }
  return null;
}

module.exports = {
  cancelTaskCreation,
  handleTaskCreateCallback,
  handleTaskCreateMessage,
  newTaskButton,
  parseDueDate,
  startTaskCreation,
};
