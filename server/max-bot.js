// max-bot.js — вход в личный кабинет через мессенджер MAX. По устройству
// похоже на Telegram (бот не может написать первым, нужен deep link), но
// протокол другой: авторизация заголовком, marker вместо offset, timestamp
// в миллисекундах. Проверено по документации и открытым разборам API,
// но НЕ протестировано против настоящего сервера MAX (нет доступа к сети
// в этом окружении) — при реальном подключении токена возможны нюансы,
// которые нужно будет доотладить по факту.
'use strict';

const db = require('./db');

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || '';
const MAX_API_BASE = 'https://platform-api.max.ru';

let lastMarker = 0;
let polling = false;

function isConfigured() {
  return Boolean(MAX_BOT_TOKEN);
}

async function sendMaxMessage(chatId, text) {
  try {
    await fetch(`${MAX_API_BASE}/messages`, {
      method: 'POST',
      headers: { 'Authorization': MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.warn('Не удалось ответить в чат MAX:', e.message);
  }
}

async function handleLoginToken(chatId, token) {
  const record = db.prepare(
    "SELECT * FROM max_login_tokens WHERE token = ? AND verified = 0 AND expires_at > datetime('now')"
  ).get(token);
  if (!record) {
    await sendMaxMessage(chatId, 'Ссылка для входа устарела или уже использована. Вернитесь на сайт «Тайга» и запросите новую.');
    return;
  }
  db.prepare('UPDATE max_login_tokens SET verified = 1, chat_id = ? WHERE id = ?').run(String(chatId), record.id);
  await sendMaxMessage(chatId, '✅ Вход подтверждён! Вернитесь на сайт «Тайга» — кабинет уже открывается.');
}

async function processUpdate(update) {
  const type = update.update_type;

  if (type === 'bot_started') {
    // На практике диплинк не всегда надёжно прокидывает payload в это
    // событие — на всякий случай пробуем несколько вероятных полей...
    const chatId = update.chat_id || (update.chat && update.chat.chat_id);
    const payload = update.payload || update.start_payload || (update.chat && update.chat.start_payload);
    if (payload) {
      await handleLoginToken(chatId, payload);
    } else if (chatId) {
      // ...а если не прокинуло — просим отправить команду вручную (проверенный
      // на практике запасной путь, надёжнее, чем полагаться только на payload).
      await sendMaxMessage(chatId, 'Здравствуйте! Если вы переходили по ссылке для входа с сайта «Тайга», отправьте команду /start ещё раз с тем же кодом, который был в ссылке.');
    }
    return;
  }

  if (type === 'message_created') {
    const msg = update.message;
    const text = msg && msg.body && msg.body.text;
    const chatId = msg && msg.recipient && msg.recipient.chat_id;
    if (!text || !chatId) return;
    const match = text.match(/^\/start\s+(\S+)/);
    if (match) await handleLoginToken(chatId, match[1]);
  }
}

async function pollOnce() {
  if (!MAX_BOT_TOKEN) return;
  try {
    const res = await fetch(`${MAX_API_BASE}/updates?marker=${lastMarker}&timeout=25`, {
      headers: { 'Authorization': MAX_BOT_TOKEN },
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!Array.isArray(data.updates)) return;
    for (const update of data.updates) {
      await processUpdate(update);
    }
    if (typeof data.marker === 'number') lastMarker = data.marker;
  } catch (e) {
    console.warn('Опрос MAX: сбой (пробуем снова):', e.message);
  }
}

async function startPolling() {
  if (!MAX_BOT_TOKEN) {
    console.warn('Вход через MAX выключен — не задан MAX_BOT_TOKEN');
    return;
  }
  if (polling) return;
  polling = true;
  console.log('Опрос MAX для входа в личный кабинет запущен');
  while (polling) {
    await pollOnce();
  }
}

function stopPolling() {
  polling = false;
}

module.exports = { startPolling, stopPolling, isConfigured };
