'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taiga-task-bot-'));

const db = require('./db');
const {
  handleTaskCreateCallback,
  handleTaskCreateMessage,
  parseDueDate,
  startTaskCreation,
} = require('./task-bot-create');

const addMember = db.prepare(`
  INSERT INTO task_assignees (code, full_name, telegram_chat_id)
  VALUES (?, ?, ?)
`);
addMember.run('creator', 'Алексей', '101');
addMember.run('assignee', 'Виталий', '202');

test('неподключённый Telegram не может создавать задачи', () => {
  const result = startTaskCreation('telegram', '999');
  assert.equal(result.ok, false);
  assert.match(result.message, /подключённым ответственным/);
});

test('пошагово создаёт задачу с выбранным ответственным и датой', () => {
  assert.equal(startTaskCreation('telegram', '101').ok, true);

  const titleResult = handleTaskCreateMessage('telegram', '101', 'Подготовить прайс-лист');
  assert.equal(titleResult.ok, true);
  assert.match(JSON.stringify(titleResult.replyMarkup), /newtsk:assignee:2/);

  const assigneeResult = handleTaskCreateCallback('telegram', '101', 'newtsk:assignee:2');
  assert.equal(assigneeResult.ok, true);
  assert.match(assigneeResult.message, /Виталий/);

  const invalidDate = handleTaskCreateMessage('telegram', '101', '31.02.2026');
  assert.equal(invalidDate.ok, false);

  const completed = handleTaskCreateMessage('telegram', '101', '15.10.2026');
  assert.equal(completed.ok, true);
  assert.equal(completed.created, true);
  assert.equal(completed.task.title, 'Подготовить прайс-лист');
  assert.equal(completed.task.assignee_id, 2);
  assert.equal(completed.task.due_date, '2026-10-15');
  assert.equal(completed.task.created_by, 'Алексей · Telegram');
  assert.equal(completed.assignee.telegram_chat_id, '202');

  const history = db.prepare('SELECT * FROM meeting_task_history WHERE task_id = ?').get(completed.task.id);
  assert.equal(history.action, 'created_from_telegram');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_bot_create_drafts').get().count, 0);
});

test('можно создать задачу без срока кнопками', () => {
  startTaskCreation('telegram', '101');
  handleTaskCreateMessage('telegram', '101', 'Проверить остатки');
  handleTaskCreateCallback('telegram', '101', 'newtsk:assignee:1');
  const completed = handleTaskCreateCallback('telegram', '101', 'newtsk:due:none');
  assert.equal(completed.created, true);
  assert.equal(completed.task.assignee_id, 1);
  assert.equal(completed.task.due_date, null);
});

test('проверяет календарные даты', () => {
  assert.equal(parseDueDate('29.02.2028'), '2028-02-29');
  assert.equal(parseDueDate('29.02.2027'), null);
  assert.equal(parseDueDate('2026-12-01'), '2026-12-01');
});

test('Telegram-команда проводит весь диалог и уведомляет ответственного', async () => {
  process.env.TG_TOKEN = 'test-token';
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const { processUpdate } = require('./telegram-login-poller');
    await processUpdate({ message: { chat: { id: 101 }, text: '/newtask' } });
    await processUpdate({ message: { chat: { id: 101 }, text: 'Сверить договор' } });
    await processUpdate({
      callback_query: {
        id: 'callback-assignee', data: 'newtsk:assignee:2',
        message: { chat: { id: 101 } }, from: { id: 101 },
      },
    });
    await processUpdate({
      callback_query: {
        id: 'callback-due', data: 'newtsk:due:none',
        message: { chat: { id: 101 } }, from: { id: 101 },
      },
    });
  } finally {
    global.fetch = originalFetch;
  }

  const task = db.prepare("SELECT * FROM meeting_tasks WHERE title = 'Сверить договор'").get();
  assert.ok(task);
  assert.equal(task.assignee_id, 2);
  assert.ok(requests.some((request) => request.url.endsWith('/sendMessage') &&
    String(request.body.chat_id) === '202' && /Вам назначена новая задача/.test(request.body.text)));
  assert.ok(requests.some((request) => request.url.endsWith('/sendMessage') &&
    request.body.reply_markup && JSON.stringify(request.body.reply_markup).includes('newtsk:start')));
});
