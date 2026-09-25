// routes-max-webhook.js — приём production-событий MAX через Webhook.
'use strict';

const crypto = require('node:crypto');
const { sendJson } = require('./http-utils');
const { processUpdate } = require('./max-bot');

function secretsMatch(received, expected) {
  const left = Buffer.from(String(received || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function registerMaxWebhookRoutes(router) {
  router.post('/api/max/webhook', (req, res, ctx) => {
    const expectedSecret = process.env.MAX_WEBHOOK_SECRET || '';
    if (!expectedSecret) {
      return sendJson(res, 503, { error: 'MAX webhook не настроен' });
    }
    if (!secretsMatch(req.headers['x-max-bot-api-secret'], expectedSecret)) {
      return sendJson(res, 401, { error: 'MAX webhook secret mismatch' });
    }

    // MAX ждёт HTTP 200 не дольше 30 секунд. Подтверждаем получение сразу,
    // а сетевой ответ бота отправляем асинхронно.
    sendJson(res, 200, { ok: true });
    processUpdate(ctx.body).catch((error) => {
      console.error('Ошибка обработки MAX webhook:', error.message);
    });
  });
}

module.exports = { registerMaxWebhookRoutes, secretsMatch };
