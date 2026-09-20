// telegram-login-poller.js — фоновый опрос Telegram (long polling) для входа
// в личный кабинет клиента через бота. Бот не может написать клиенту первым,
// поэтому клиент сам открывает диалог по ссылке-приглашению с токеном
// (t.me/BOT?start=ТОКЕН) — это и есть подтверждение входа.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');

const TG_TOKEN = process.env.TG_TOKEN || '';
let lastUpdateId = 0;
let polling = false;

// Короткий 4-значный код — запасной способ подтвердить вход, если сайт не
// подхватил это автоматически (например, вкладка была перезагружена и
// потеряла исходный длинный token, или опрос на фронтенде просто не дошёл
// до сервера). Код привязан к тому же токену и живёт до его истечения.
function generateLoginCode() {
  return String(crypto.randomInt(1000, 10000));
}

async function replyToChat(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.warn('Не удалось ответить в Telegram-чат:', e.message);
  }
}

async function processUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const match = msg.text.match(/^\/start\s+(\S+)/);
  if (!match) return; // не команда входа — игнорируем (обычный /start без токена, другие сообщения)

  const token = match[1];
  const record = db.prepare(
    "SELECT * FROM telegram_login_tokens WHERE token = ? AND verified = 0 AND expires_at > datetime('now')"
  ).get(token);

  if (!record) {
    await replyToChat(msg.chat.id, 'Ссылка для входа устарела или уже использована. Вернитесь на сайт «Тайга» и запросите новую.');
    return;
  }

  const code = generateLoginCode();
  db.prepare('UPDATE telegram_login_tokens SET verified = 1, chat_id = ?, code = ? WHERE id = ?')
    .run(String(msg.chat.id), code, record.id);
  await replyToChat(
    msg.chat.id,
    '✅ Вход подтверждён! Обычно сайт «Тайга» подхватывает это автоматически — просто вернитесь на вкладку с сайтом.\n\n' +
    'Если через несколько секунд ничего не произошло, введите на сайте код вручную: ' + code
  );
}

async function pollOnce() {
  if (!TG_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
      { signal: AbortSignal.timeout(30000) }
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;
    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      await processUpdate(update);
    }
  } catch (e) {
    // Тихо игнорируем отдельные сбои опроса (сеть моргнула и т.п.) — просто
    // попробуем снова на следующей итерации, ничего не роняем.
    // e.cause содержит настоящую причину сетевого сбоя (код вроде ENOTFOUND/
    // ECONNREFUSED/ETIMEDOUT) — без неё "fetch failed" ничего не говорит о
    // реальной причине.
    console.warn('Опрос Telegram: сбой (пробуем снова):', e.message, e.cause ? '| причина: ' + JSON.stringify({ code: e.cause.code, errno: e.cause.errno, syscall: e.cause.syscall, address: e.cause.address }) : '(без деталей)');
  }
}

async function startPolling() {
  if (!TG_TOKEN) {
    console.warn('Вход через Telegram выключен — не задан TG_TOKEN');
    return;
  }
  if (polling) return;
  polling = true;
  console.log('Опрос Telegram для входа в личный кабинет запущен');
  while (polling) {
    await pollOnce();
  }
}

function stopPolling() {
  polling = false;
}

module.exports = { startPolling, stopPolling };
