// Validates signed Telegram Mini App initData without trusting client-supplied profile fields.
'use strict';

const crypto = require('node:crypto');
const { sendJson } = require('./http-utils');
const { availableTelegramAccounts, issueTelegramAccountSession } = require('./miniapp-phone-identity');

function verifyTelegramInitData(raw, token, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') throw new Error('Bot token is not configured');
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 8192) throw new Error('Invalid initData');
  const params = new URLSearchParams(raw);
  const pairs = [...params.entries()];
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error('Duplicate initData keys');

  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Missing Telegram signature');
  if (!Number.isSafeInteger(authDate) || authDate <= 0 ||
      authDate > nowSeconds + 60 || nowSeconds - authDate > 24 * 60 * 60) {
    throw new Error('Telegram session has expired');
  }

  const checkString = pairs
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest();
  const actual = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Telegram signature does not match');
  }

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (_) { throw new Error('Invalid Telegram user'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 ||
      typeof user.first_name !== 'string' || !user.first_name.trim()) {
    throw new Error('Telegram user is missing');
  }
  return {
    id: user.id,
    first_name: user.first_name.slice(0, 100),
    last_name: String(user.last_name || '').slice(0, 100),
    username: String(user.username || '').slice(0, 100),
  };
}

function verifiedMiniAppUser(ctx, res) {
  if (!process.env.TG_TOKEN) {
    sendJson(res, 503, { error: 'Telegram-бот ещё не настроен' });
    return null;
  }
  try {
    return verifyTelegramInitData(ctx.body && ctx.body.initData, process.env.TG_TOKEN);
  } catch (_) {
    sendJson(res, 401, { error: 'Откройте Mini App заново через действующего Telegram-бота' });
    return null;
  }
}

function registerMiniAppRoutes(router) {
  router.post('/api/miniapp/auth', (req, res, ctx) => {
    const token = process.env.TG_TOKEN;
    if (!token) return sendJson(res, 503, { error: 'Telegram-бот ещё не настроен' });
    try {
      const user = verifyTelegramInitData(ctx.body && ctx.body.initData, token);
      // This does not authorize a customer account or grant access to bones/orders.
      // Customer-account linking must require separately verified phone ownership.
      return sendJson(res, 200, { ok: true, user });
    } catch (_) {
      return sendJson(res, 401, { error: 'Не удалось проверить авторизацию Telegram. Откройте приложение заново.' });
    }
  });
  // The number cannot be submitted from the browser. It must be sent
  // by Telegram directly to our bot with matching contact.user_id/from.id.
  router.post('/api/miniapp/accounts', (req, res, ctx) => {
    const user = verifiedMiniAppUser(ctx, res);
    if (!user) return;
    const { verified, phoneMasked, accounts, ambiguousRoles } = availableTelegramAccounts(user.id);
    sendJson(res, 200, {
      verified,
      phone_masked: phoneMasked,
      accounts: accounts.map(a => ({
        role: a.role,
        name: a.name,
      })),
      ambiguous_roles: ambiguousRoles,
    });
  });

  router.post('/api/miniapp/session', (req, res, ctx) => {
    const user = verifiedMiniAppUser(ctx, res);
    if (!user) return;
    const role = String(ctx.body && ctx.body.role || '');
    if (!['customer', 'partner', 'manager', 'owner', 'admin'].includes(role)) {
      return sendJson(res, 400, { error: 'Некорректная роль' });
    }
    const result = issueTelegramAccountSession(user.id, role);
    if (!result) {
      return sendJson(res, 403, {
        error: 'Не найден подтверждённый кабинет для этого номера Telegram. Проверьте номер на сайте или войдите с паролем.',
      });
    }
    sendJson(res, 200, {
      token: result.token,
      role: result.role,
      account: result.account,
    });
  });
}

module.exports = { verifyTelegramInitData, registerMiniAppRoutes };
