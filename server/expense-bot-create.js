// expense-bot-create.js — пошаговое внесение бизнес-трат из Telegram.
'use strict';

const db = require('./db');
const { localDate } = require('./task-reminders');

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function actorForChat(channel, chatId) {
  if (channel !== 'telegram' || !chatId) return null;
  const admin = db.prepare(`
    SELECT id, full_name, login FROM admins
    WHERE active = 1 AND telegram_chat_id = ?
    ORDER BY CASE role WHEN 'super' THEN 0 ELSE 1 END, id LIMIT 1
  `).get(String(chatId));
  if (admin) {
    return { role: 'admin', id: admin.id, name: admin.full_name || admin.login || 'Администратор' };
  }
  const assignee = db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 AND telegram_chat_id = ?
    ORDER BY id LIMIT 1
  `).get(String(chatId));
  return assignee ? { role: 'task_assignee', id: assignee.id, name: assignee.full_name } : null;
}

function expenseButton() {
  return { inline_keyboard: [[{ text: '💳 Добавить трату', callback_data: 'expense:start' }]] };
}

function dateButtons() {
  return {
    inline_keyboard: [
      [
        { text: 'Сегодня', callback_data: 'expense:date:today' },
        { text: 'Вчера', callback_data: 'expense:date:yesterday' },
      ],
      [{ text: '✕ Отмена', callback_data: 'expense:cancel' }],
    ],
  };
}

function confirmButtons() {
  return {
    inline_keyboard: [
      [{ text: '✅ Записать трату', callback_data: 'expense:confirm' }],
      [{ text: '✕ Отмена', callback_data: 'expense:cancel' }],
    ],
  };
}

function parseDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year;
  let month;
  let day;
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

function addDays(dateString, days) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseAmount(value) {
  const normalized = String(value || '')
    .replace(/[₽рrub]/gi, '')
    .replace(/\s+/g, '')
    .replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount);
}

function draftForChat(channel, chatId) {
  const draft = db.prepare(`
    SELECT * FROM expense_bot_drafts
    WHERE channel = ? AND chat_id = ? AND datetime(expires_at) > datetime('now')
  `).get(channel, String(chatId));
  if (draft) return draft;
  db.prepare('DELETE FROM expense_bot_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId));
  return null;
}

function cancelExpenseCreation(channel, chatId) {
  return db.prepare('DELETE FROM expense_bot_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId)).changes > 0;
}

function defaultCityId() {
  const krasnoyarsk = db.prepare("SELECT id FROM cities WHERE id = 'krsk' AND active = 1").get();
  if (krasnoyarsk) return krasnoyarsk.id;
  const first = db.prepare('SELECT id FROM cities WHERE active = 1 ORDER BY id LIMIT 1').get();
  return first ? first.id : 'krsk';
}

function startExpenseCreation(channel, chatId) {
  const actor = actorForChat(channel, chatId);
  if (!actor) {
    return {
      ok: false,
      message: 'Добавлять траты могут только подключённые администраторы и ответственные. Сначала подключите Telegram в админке.',
    };
  }
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  db.prepare('DELETE FROM task_bot_create_drafts WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  db.prepare(`
    INSERT OR REPLACE INTO expense_bot_drafts
      (channel, chat_id, creator_role, creator_id, creator_name, step, city_id, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'date', ?, ?, datetime('now'))
  `).run(channel, String(chatId), actor.role, actor.id, actor.name, defaultCityId(), expiresAt);
  return {
    ok: true,
    message: '💳 Новая трата\n\nВыберите дату или отправьте её сообщением в формате ДД.ММ.ГГГГ.',
    replyMarkup: dateButtons(),
  };
}

function setDraftDate(channel, chatId, expenseDate) {
  const draft = draftForChat(channel, chatId);
  if (!draft || draft.step !== 'date') {
    return { ok: false, message: 'Черновик траты устарел. Начните заново командой /expense.' };
  }
  db.prepare(`
    UPDATE expense_bot_drafts
    SET expense_date = ?, step = 'investor', updated_at = datetime('now')
    WHERE channel = ? AND chat_id = ?
  `).run(expenseDate, channel, String(chatId));
  return { ok: true, message: 'Дата: ' + expenseDate + '.\n\nВведите ФИО инвестора, который оплатил эту трату.' };
}

function confirmationMessage(draft) {
  return [
    'Проверьте трату перед сохранением:',
    '',
    'Дата: ' + draft.expense_date,
    'Инвестор: ' + draft.investor_name,
    'Сумма: ' + Number(draft.amount).toLocaleString('ru-RU') + ' ₽',
    'Назначение: ' + draft.purpose,
  ].join('\n');
}

function finishExpenseCreation(channel, chatId) {
  const draft = draftForChat(channel, chatId);
  if (!draft || draft.step !== 'confirm' || !draft.expense_date || !draft.investor_name || !draft.amount || !draft.purpose) {
    return { ok: false, message: 'Черновик траты неполный или устарел. Начните заново командой /expense.' };
  }
  const city = db.prepare('SELECT id, name FROM cities WHERE id = ?').get(draft.city_id);
  const info = db.prepare(`
    INSERT INTO expenses
      (expense_date, category, amount, investor_name, note, created_by, source, city_id)
    VALUES (?, ?, ?, ?, NULL, ?, 'telegram', ?)
  `).run(
    draft.expense_date,
    draft.purpose,
    draft.amount,
    draft.investor_name,
    draft.creator_name + ' · Telegram',
    draft.city_id
  );
  cancelExpenseCreation(channel, chatId);
  return {
    ok: true,
    created: true,
    expenseId: Number(info.lastInsertRowid),
    message: [
      '✅ Трата записана',
      '',
      draft.expense_date + ' · ' + Number(draft.amount).toLocaleString('ru-RU') + ' ₽',
      draft.investor_name,
      draft.purpose,
      city ? 'Город: ' + city.name : '',
    ].filter(Boolean).join('\n'),
    replyMarkup: expenseButton(),
  };
}

function handleExpenseCallback(channel, chatId, rawPayload) {
  const payload = String(rawPayload || '');
  if (!payload.startsWith('expense:')) return null;
  if (payload === 'expense:start') return startExpenseCreation(channel, chatId);
  if (payload === 'expense:cancel') {
    cancelExpenseCreation(channel, chatId);
    return { ok: true, message: 'Внесение траты отменено.', replyMarkup: expenseButton() };
  }
  if (payload === 'expense:date:today') return setDraftDate(channel, chatId, localDate());
  if (payload === 'expense:date:yesterday') return setDraftDate(channel, chatId, addDays(localDate(), -1));
  if (payload === 'expense:confirm') return finishExpenseCreation(channel, chatId);
  return { ok: false, message: 'Неизвестное действие. Начните заново командой /expense.' };
}

function handleExpenseMessage(channel, chatId, text) {
  const draft = draftForChat(channel, chatId);
  if (!draft) return null;
  const value = String(text || '').trim();
  if (!value || value.startsWith('/')) return null;

  if (draft.step === 'date') {
    const expenseDate = parseDate(value);
    if (!expenseDate) {
      return { ok: false, message: 'Не понял дату. Отправьте её в формате ДД.ММ.ГГГГ, например 05.10.2026.', replyMarkup: dateButtons() };
    }
    return setDraftDate(channel, chatId, expenseDate);
  }
  if (draft.step === 'investor') {
    const investorName = value.slice(0, 200);
    db.prepare(`
      UPDATE expense_bot_drafts
      SET investor_name = ?, step = 'amount', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(investorName, channel, String(chatId));
    return { ok: true, message: 'Инвестор: ' + investorName + '.\n\nВведите сумму в рублях, например 12500.' };
  }
  if (draft.step === 'amount') {
    const amount = parseAmount(value);
    if (!amount) return { ok: false, message: 'Не понял сумму. Введите число больше нуля, например 12500.' };
    db.prepare(`
      UPDATE expense_bot_drafts
      SET amount = ?, step = 'purpose', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(amount, channel, String(chatId));
    return { ok: true, message: 'Сумма: ' + amount.toLocaleString('ru-RU') + ' ₽.\n\nУкажите назначение траты: что именно было оплачено?' };
  }
  if (draft.step === 'purpose') {
    const purpose = value.slice(0, 500);
    db.prepare(`
      UPDATE expense_bot_drafts
      SET purpose = ?, step = 'confirm', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(purpose, channel, String(chatId));
    const updated = draftForChat(channel, chatId);
    return { ok: true, message: confirmationMessage(updated), replyMarkup: confirmButtons() };
  }
  if (draft.step === 'confirm') {
    return { ok: false, message: 'Подтвердите сохранение кнопкой под предыдущим сообщением.', replyMarkup: confirmButtons() };
  }
  return null;
}

module.exports = {
  cancelExpenseCreation,
  expenseButton,
  handleExpenseCallback,
  handleExpenseMessage,
  parseAmount,
  parseDate,
  startExpenseCreation,
};
