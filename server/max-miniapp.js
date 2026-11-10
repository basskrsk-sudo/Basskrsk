'use strict';

// MAX Mini App pilot: verified identity + READ-ONLY storefront.
// No customer account is created, no phone is inferred and no staff token
// is issued. Future role integration must independently verify own contact.
const crypto = require('node:crypto');
const { sendJson } = require('./http-utils');

const MAX_AGE_SECONDS = 60 * 60;
const FUTURE_SKEW_SECONDS = 60;
const MAX_DATA_LENGTH = 12 * 1024;
const MAX_PARAMS = 32;
const USER_ID_RE = /^[1-9]\d{0,19}$/;

function normalizeMaxId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && USER_ID_RE.test(value)) return value;
  return null;
}

function verifyMaxInitData(initData, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!botToken || typeof botToken !== 'string' ||
      typeof initData !== 'string' || !initData || initData.length > MAX_DATA_LENGTH) return null;

  try {
    const entries = [...new URLSearchParams(initData).entries()];
    if (entries.length < 3 || entries.length > MAX_PARAMS) return null;

    const values = new Map();
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_]*$/i.test(key) || values.has(key)) return null;
      values.set(key, value);
    }
    const hash = values.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

    const authText = values.get('auth_date');
    if (!/^\d{10,11}$/.test(authText || '')) return null;
    const authDate = Number(authText);
    if (!Number.isSafeInteger(authDate) ||
        authDate > nowSeconds + FUTURE_SKEW_SECONDS ||
        nowSeconds - authDate > MAX_AGE_SECONDS) return null;

    const payload = [...values.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => key + '=' + value)
      .join('\n');
    // MAX official algorithm: HMAC(key='WebAppData', message=BOT_TOKEN)
    // then HMAC(key=secret, message=sorted launch parameters).
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const actual = crypto.createHmac('sha256', secret).update(payload).digest();
    const expected = Buffer.from(hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    const user = JSON.parse(values.get('user') || 'null');
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    const id = normalizeMaxId(user.id);
    if (!id) return null;
    const safeName = input => typeof input === 'string' ?
      input.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
    return {
      id,
      first_name: safeName(user.first_name),
      last_name: safeName(user.last_name),
    };
  } catch (_) {
    return null;
  }
}

function registerMaxMiniAppRoutes(router, { token = () => process.env.MAX_BOT_TOKEN } = {}) {
  router.post('/api/max/miniapp/verify', (req, res, ctx) => {
    res.setHeader?.('Cache-Control', 'no-store');
    const botToken = token();
    if (!botToken) return sendJson(res, 503, { error: 'MAX временно не настроен' });
    const input = ctx.body && ctx.body.init_data;
    if (typeof input !== 'string' || !input || input.length > MAX_DATA_LENGTH) {
      return sendJson(res, 400, { error: 'Отсутствуют данные запуска MAX' });
    }
    const user = verifyMaxInitData(input, botToken);
    if (!user) return sendJson(res, 401, { error: 'Подтверждение MAX не прошло. Откройте приложение из бота повторно.' });
    // Deliberately no auth token / staff role: the pilot does not grant
    // access to employee dashboards or modify production user records.
    sendJson(res, 200, {
      verified: true, user, mode: 'pilot', checkout_enabled: false,
    });
  });
}

module.exports = {
  verifyMaxInitData, registerMaxMiniAppRoutes, MAX_AGE_SECONDS,
};
