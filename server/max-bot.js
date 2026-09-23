// max-bot.js — безопасное подтверждение номера телефона через MAX.
//
// Сайт создаёт короткоживущую сессию и передаёт её в deep link. Сам переход
// в бота НЕ подтверждает номер: бот отдельно просит пользователя поделиться
// контактом кнопкой request_contact и сверяет номер с введённым на сайте.
'use strict';

const db = require('./db');

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || '';
const MAX_API_BASE = 'https://platform-api2.max.ru';

function isConfigured() {
  return Boolean(
    MAX_BOT_TOKEN &&
    process.env.MAX_BOT_USERNAME &&
    process.env.MAX_WEBHOOK_SECRET
  );
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function phoneFromVcard(vcfInfo) {
  const unfolded = String(vcfInfo || '').replace(/\r?\n[ \t]/g, '');
  const match = unfolded.match(/^TEL(?:;[^:]*)?:(.+)$/im);
  return match ? normalizePhone(match[1]) : '';
}

async function maxApi(pathname, options = {}) {
  if (!MAX_BOT_TOKEN) throw new Error('MAX_BOT_TOKEN не задан');
  const response = await fetch(MAX_API_BASE + pathname, {
    ...options,
    headers: {
      Authorization: MAX_BOT_TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `MAX API: HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

async function sendMaxMessage(chatId, text, attachments) {
  if (!chatId) return { ok: false, skipped: true };
  try {
    const body = { text };
    if (attachments) body.attachments = attachments;
    return await maxApi(`/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.warn('Не удалось отправить сообщение в MAX:', error.message);
    return { ok: false, error: error.message };
  }
}

function contactKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [[{
        type: 'request_contact',
        text: 'Поделиться номером',
      }]],
    },
  }];
}

async function handleLoginStart(chatId, token) {
  const record = db.prepare(`
    SELECT * FROM max_login_tokens
    WHERE token = ? AND verified = 0 AND datetime(expires_at) > datetime('now')
  `).get(String(token || ''));
  if (!record || !chatId) {
    if (chatId) {
      await sendMaxMessage(chatId, 'Ссылка для входа устарела. Вернитесь на сайт «ХвостМаркет» и запросите новую.');
    }
    return;
  }

  db.prepare('UPDATE max_login_tokens SET chat_id = ? WHERE id = ?')
    .run(String(chatId), record.id);
  await sendMaxMessage(
    chatId,
    'Для безопасного входа подтвердите номер телефона, привязанный к вашему аккаунту MAX.',
    contactKeyboard()
  );
}

function getContactAttachment(message) {
  const attachments = message && message.body && message.body.attachments;
  if (!Array.isArray(attachments)) return null;
  return attachments.find((item) => item && item.type === 'contact') || null;
}

async function handleContactMessage(message) {
  const chatId = message && message.recipient && message.recipient.chat_id;
  const senderId = message && message.sender && message.sender.user_id;
  const contact = getContactAttachment(message);
  if (!chatId || !senderId || !contact || !contact.payload) return false;

  const pending = db.prepare(`
    SELECT * FROM max_login_tokens
    WHERE chat_id = ? AND verified = 0 AND datetime(expires_at) > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(String(chatId));
  if (!pending) {
    await sendMaxMessage(chatId, 'Сначала запросите вход через MAX на сайте «ХвостМаркет».');
    return true;
  }

  // request_contact возвращает контакт текущего пользователя с max_info.
  // Не принимаем произвольную или пересланную карточку другого человека.
  const contactUserId = contact.payload.max_info && contact.payload.max_info.user_id;
  if (!contactUserId || String(contactUserId) !== String(senderId)) {
    await sendMaxMessage(chatId, 'Не удалось подтвердить владельца номера. Нажмите именно кнопку «Поделиться номером» в сообщении бота.');
    return true;
  }

  const confirmedPhone = phoneFromVcard(contact.payload.vcf_info);
  if (!confirmedPhone) {
    await sendMaxMessage(chatId, 'MAX не передал номер телефона. Повторите вход с сайта и разрешите отправку контакта.');
    return true;
  }
  if (confirmedPhone !== normalizePhone(pending.phone)) {
    await sendMaxMessage(chatId, 'Этот аккаунт MAX привязан к другому номеру. Введите на сайте номер, который используется в MAX.');
    return true;
  }

  db.prepare(`
    UPDATE max_login_tokens
    SET verified = 1, chat_id = ?
    WHERE id = ? AND verified = 0
  `).run(String(chatId), pending.id);
  await sendMaxMessage(chatId, '✅ Номер подтверждён. Вернитесь на сайт — личный кабинет откроется автоматически.');
  return true;
}

async function processUpdate(update) {
  if (!update || typeof update !== 'object') return;

  if (update.update_type === 'bot_started') {
    if (update.payload) await handleLoginStart(update.chat_id, update.payload);
    else if (update.chat_id) {
      await sendMaxMessage(update.chat_id, 'Откройте личный кабинет на сайте «ХвостМаркет» и выберите «Войти через MAX».');
    }
    return;
  }

  if (update.update_type !== 'message_created' || !update.message) return;
  if (await handleContactMessage(update.message)) return;

  const text = update.message.body && update.message.body.text;
  const chatId = update.message.recipient && update.message.recipient.chat_id;
  const match = String(text || '').match(/^\/start\s+([A-Za-z0-9_-]{1,128})$/);
  if (match) await handleLoginStart(chatId, match[1]);
}

module.exports = {
  isConfigured,
  normalizePhone,
  phoneFromVcard,
  processUpdate,
  sendMaxMessage,
};
