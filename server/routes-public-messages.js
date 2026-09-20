// routes-public-messages.js — безопасная передача обращений с публичного сайта
// в служебный Telegram-чат. Токен бота остаётся только на сервере.
'use strict';

const { sendJson } = require('./http-utils');
const { sendTelegram } = require('./telegram');

const attempts = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isRateLimited(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > MAX_PER_WINDOW;
}

function registerPublicMessageRoutes(router) {
  router.post('/api/public/message', async (req, res, ctx) => {
    if (isRateLimited(req)) {
      return sendJson(res, 429, { error: 'Слишком много сообщений. Попробуйте через минуту.' });
    }
    const text = String((ctx.body || {}).text || '').trim();
    if (!text || text.length > 3500) {
      return sendJson(res, 400, { error: 'Сообщение пустое или слишком длинное' });
    }
    const safeText = escapeHtml(text)
      .replace(/&lt;b&gt;/g, '<b>')
      .replace(/&lt;\/b&gt;/g, '</b>');
    const result = await sendTelegram('📨 <b>Сообщение с сайта ХвостМаркета</b>\n\n' + safeText);
    if (!result.ok) return sendJson(res, 503, { error: 'Не удалось отправить сообщение' });
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPublicMessageRoutes };
