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

const BOT_NAME = 'ХвостМаркет';
const BOT_DESCRIPTION = 'Помогаю входить в личный кабинет ХвостМаркета и присылаю уведомления о заказах, продажах и вознаграждениях.';
const BOT_SHORT_DESCRIPTION = 'Вход в кабинет и уведомления о заказах и вознаграждениях.';

async function callBotApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error((data && data.description) || `Telegram API: HTTP ${res.status}`);
  }
  return data.result;
}

// Отображаемое имя, описание и меню команд поддерживаем из кода, чтобы после
// очередного деплоя бот не оставался оформлен под старый бренд. Ошибка любой
// из этих косметических операций не должна останавливать вход и уведомления.
async function configureBotProfile() {
  if (!TG_TOKEN) return { ok: false, skipped: true };
  const operations = [
    ['setMyName', { name: BOT_NAME }],
    ['setMyDescription', { description: BOT_DESCRIPTION }],
    ['setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }],
    ['setMyCommands', { commands: [
      { command: 'start', description: 'Открыть помощника ХвостМаркета' },
      { command: 'help', description: 'Как пользоваться ботом' },
    ] }],
  ];
  const results = await Promise.allSettled(operations.map(([method, body]) => callBotApi(method, body)));
  const failed = results
    .map((result, index) => ({ result, method: operations[index][0] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, method } of failed) {
    console.warn(`Telegram: не удалось обновить ${method}:`, result.reason.message);
  }
  return { ok: failed.length === 0, failed: failed.map(({ method }) => method) };
}

// Короткий 4-значный код — запасной способ подтвердить вход, если сайт не
// подхватил это автоматически (например, вкладка была перезагружена и
// потеряла исходный длинный token, или опрос на фронтенде просто не дошёл
// до сервера). Код привязан к тому же токену и живёт до его истечения.
function generateLoginCode() {
  return String(crypto.randomInt(1000, 10000));
}

async function replyToChat(chatId, text) {
  try {
    await callBotApi('sendMessage', { chat_id: chatId, text });
  } catch (e) {
    console.warn('Не удалось ответить в Telegram-чат:', e.message);
  }
}

function buildWelcomeMessage() {
  return [
    '🐾 ХвостМаркет',
    '',
    'Я помогу войти в личный кабинет и буду присылать важные уведомления о заказах, продажах и вознаграждениях.',
    '',
    'Чтобы подключить кабинет, откройте на сайте вход через Telegram и перейдите по созданной ссылке.',
  ].join('\n');
}

function accountRoleText(role) {
  if (role === 'partner') return 'грумера';
  if (role === 'manager') return 'менеджера';
  if (role === 'owner') return 'владельца салона';
  if (role === 'admin') return 'администратора';
  return 'покупателя';
}

function rememberChatForAccount(record, chatId) {
  const tableByRole = {
    customer: 'customers',
    partner: 'partners',
    manager: 'managers',
    owner: 'salon_owners',
    admin: 'admins',
  };
  const table = tableByRole[record.role || 'customer'];
  if (!table) return;
  if (record.account_id) {
    db.prepare(`UPDATE ${table} SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), record.account_id);
    return;
  }
  const wantedPhone = String(record.phone || '').replace(/\D/g, '').slice(-10);
  if (!wantedPhone) return;
  let account = db.prepare(`SELECT id, phone FROM ${table}`).all()
    .find((row) => String(row.phone || '').replace(/\D/g, '').slice(-10) === wantedPhone);
  // Для покупателя бот подтверждает владение номером. Создаём минимальную
  // карточку сразу, чтобы связь с Telegram успела сохраниться даже если
  // вкладка сайта ещё не возобновила опрос после возврата из приложения.
  if (!account && table === 'customers') {
    const info = db.prepare('INSERT INTO customers (phone, orders_count, total_spent) VALUES (?, 0, 0)')
      .run(String(record.phone || '').replace(/\D/g, ''));
    account = { id: info.lastInsertRowid, phone: record.phone };
  }
  if (account) {
    db.prepare(`UPDATE ${table} SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), account.id);
  }
}

async function processUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const text = msg.text.trim();
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!match || !match[1]) {
    await replyToChat(msg.chat.id, buildWelcomeMessage());
    return;
  }

  const token = match[1];
  const record = db.prepare(
    "SELECT * FROM telegram_login_tokens WHERE token = ? AND verified = 0 AND expires_at > datetime('now')"
  ).get(token);

  if (!record) {
    await replyToChat(msg.chat.id, 'Ссылка для входа устарела или уже использована. Вернитесь на сайт «ХвостМаркета» и запросите новую.');
    return;
  }

  const code = generateLoginCode();
  db.prepare('UPDATE telegram_login_tokens SET verified = 1, chat_id = ?, code = ? WHERE id = ?')
    .run(String(msg.chat.id), code, record.id);
  rememberChatForAccount(record, msg.chat.id);
  await replyToChat(
    msg.chat.id,
    '✅ Telegram для кабинета ' + accountRoleText(record.role) + ' подключён!\n\n' +
    'Вернитесь на вкладку с сайтом «ХвостМаркета» — подключение завершится автоматически.\n\n' +
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
  await configureBotProfile();
  console.log('Опрос Telegram для входа в личный кабинет запущен');
  while (polling) {
    await pollOnce();
  }
}

function stopPolling() {
  polling = false;
}

module.exports = { startPolling, stopPolling, processUpdate, configureBotProfile, buildWelcomeMessage };
