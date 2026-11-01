// Standalone customer-facing Telegram bot for the ХвостМаркет Mini App.
// Does not share token, updates or messages with the operations/partner bots.
'use strict';

const BOT_TOKEN = String(process.env.TG_SHOP_BOT_TOKEN || '').trim();
const SHOP_URL = 'https://хвостмаркет.рф/miniapp.html';
let started = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function botMethod(method, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error('Telegram ' + method + ': ' + (result.description || response.status));
    }
    return result.result;
  } finally { clearTimeout(timer); }
}

async function configureBot() {
  await botMethod('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: '🛍 Магазин',
      web_app: { url: SHOP_URL },
    },
  });
  await botMethod('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть ХвостМаркет' },
      { command: 'shop', description: 'Перейти в магазин' },
      { command: 'help', description: 'Как покупать' },
    ],
  });
}

async function handleMessage(message) {
  if (!message || !message.chat || message.chat.type !== 'private') return;
  const raw = String(message.text || '');
  const command = raw.split(/\s+/)[0].split('@')[0].toLowerCase();
  if (!['/start', '/shop', '/help'].includes(command)) return;
  const help = command === '/help';
  const text = help
    ? '🐾 Как покупать в ХвостМаркете:\n\n1. Откройте магазин кнопкой ниже.\n2. Выберите грумерский салон.\n3. Добавьте лакомства и другие товары в корзину.\n4. Оплатите через ЮKassa и заберите покупку с полки салона.'
    : '🐾 Добро пожаловать в ХвостМаркет!\n\nЛакомства, игрушки и забота о питомцах — прямо в Telegram.\n\nВыберите свой салон, проверьте наличие и порадуйте хвостика! 💚';
  await botMethod('sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_markup: {
      inline_keyboard: [[{
        text: '🛍 Открыть ХвостМаркет',
        web_app: { url: SHOP_URL },
      }]],
    },
  });
}

async function runPolling() {
  let offset = 0;
  while (true) {
    try {
      const updates = await botMethod('getUpdates', {
        offset,
        timeout: 20,
        limit: 50,
        allowed_updates: ['message'],
      }, 30000);
      for (const update of updates || []) {
        // An update is acknowledged on the next getUpdates call.
        offset = Math.max(offset, update.update_id + 1);
        try { await handleMessage(update.message); }
        catch (error) { console.warn('[shop-bot] Message error:', error.message); }
      }
    } catch (error) {
      console.warn('[shop-bot] Polling paused:', error.message);
      await sleep(5000);
    }
  }
}

function startCustomerMiniAppBot() {
  if (!BOT_TOKEN) {
    console.log('[shop-bot] Telegram Mini App preview is available; configure TG_SHOP_BOT_TOKEN to activate the customer bot.');
    return;
  }
  if (started) return;
  started = true;
  configureBot().then(() => {
    console.log('[shop-bot] Customer bot menu configured; polling started.');
    return runPolling();
  }).catch((error) => {
    console.error('[shop-bot] Setup error:', error.message);
    // A transient setChatMenuButton failure should not stop /start handling.
    runPolling().catch((e) => console.error('[shop-bot] Polling failed:', e.message));
  });
}

module.exports = { startCustomerMiniAppBot };
