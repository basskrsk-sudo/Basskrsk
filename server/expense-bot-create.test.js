'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taiga-expense-bot-'));
process.env.TG_TOKEN = 'test-token';

const db = require('./db');
const {
  handleExpenseCallback,
  handleExpenseMessage,
  parseAmount,
  parseDate,
  startExpenseCreation,
} = require('./expense-bot-create');

db.prepare(`
  INSERT INTO task_assignees (code, full_name, telegram_chat_id)
  VALUES ('investor', 'Лакомых Алексей', '501')
`).run();

test('неподключённый пользователь не может вносить траты', () => {
  const result = startExpenseCreation('telegram', '999');
  assert.equal(result.ok, false);
});

test('пошагово создаёт трату с обязательными реквизитами', () => {
  assert.equal(startExpenseCreation('telegram', '501').ok, true);
  assert.equal(handleExpenseMessage('telegram', '501', '05.10.2026').ok, true);
  assert.equal(handleExpenseCallback('telegram', '501', 'expense:investor:vitaly').ok, true);
  assert.equal(handleExpenseMessage('telegram', '501', '15 500 ₽').ok, true);
  const purpose = handleExpenseMessage('telegram', '501', 'Изготовление металлической стойки');
  assert.equal(purpose.ok, true);
  assert.match(purpose.message, /Соколов Виталий/);
  const completed = handleExpenseCallback('telegram', '501', 'expense:confirm');
  assert.equal(completed.created, true);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(completed.expenseId);
  assert.equal(expense.expense_date, '2026-10-05');
  assert.equal(expense.investor_name, 'Соколов Виталий');
  assert.equal(expense.amount, 15500);
  assert.equal(expense.category, 'Изготовление металлической стойки');
  assert.equal(expense.source, 'telegram');
  assert.equal(expense.created_by, 'Лакомых Алексей · Telegram');
  assert.equal(expense.city_id, 'krsk');
});

test('проверяет дату и сумму', () => {
  assert.equal(parseDate('29.02.2028'), '2028-02-29');
  assert.equal(parseDate('31.02.2028'), null);
  assert.equal(parseAmount('12 345 ₽'), 12345);
  assert.equal(parseAmount('-10'), null);
});

test('Telegram-команда /expense сохраняет подтверждённую трату', async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const { processUpdate } = require('./telegram-login-poller');
    await processUpdate({ message: { chat: { id: 501 }, text: '/expense' } });
    await processUpdate({
      callback_query: {
        id: 'date', data: 'expense:date:today',
        message: { chat: { id: 501 } }, from: { id: 501 },
      },
    });
    await processUpdate({
      callback_query: {
        id: 'investor', data: 'expense:investor:nikolay',
        message: { chat: { id: 501 } }, from: { id: 501 },
      },
    });
    await processUpdate({ message: { chat: { id: 501 }, text: '7000' } });
    await processUpdate({ message: { chat: { id: 501 }, text: 'Юридическая консультация' } });
    await processUpdate({
      callback_query: {
        id: 'confirm', data: 'expense:confirm',
        message: { chat: { id: 501 } }, from: { id: 501 },
      },
    });
  } finally {
    global.fetch = originalFetch;
  }

  const expense = db.prepare("SELECT * FROM expenses WHERE category = 'Юридическая консультация'").get();
  assert.ok(expense);
  assert.equal(expense.investor_name, 'Кучкин Николай');
  assert.equal(expense.amount, 7000);
  assert.ok(requests.some((request) => request.url.endsWith('/sendMessage') && /Трата записана/.test(request.body.text)));
});
