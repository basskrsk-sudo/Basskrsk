'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Router } = require('./http-utils');
const { verifyMaxInitData, registerMaxMiniAppRoutes, MAX_AGE_SECONDS } = require('./max-miniapp');

const BOT_TOKEN = 'secret-for-max-miniapp-test';
const NOW = 1773140000;

function signedData(fields = {}, token = BOT_TOKEN) {
  const params = {
    auth_date: String(NOW),
    query_id: 'max-test-session',
    user: JSON.stringify({ id: 1288, first_name: 'Светлана', last_name: 'Тест' }),
    ...fields,
  };
  const string = Object.entries(params).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(string).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}
async function invoke(body, opts = {}) {
  const router = new Router();
  registerMaxMiniAppRoutes(router, { token: () => opts.token === undefined ? BOT_TOKEN : opts.token });
  const match = router.match('POST', '/api/max/miniapp/verify');
  assert.ok(match);
  const res = {
    code: 0, result: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code) { this.code = code; },
    end(data) { this.result = JSON.parse(data); },
  };
  await match.handler({}, res, { body });
  return res;
}

test('official MAX WebAppData HMAC grants a read-only pilot identity', async () => {
  const signed = signedData();
  assert.deepEqual(verifyMaxInitData(signed, BOT_TOKEN, NOW), {
    id: '1288', first_name: 'Светлана', last_name: 'Тест',
  });
  const result = await invoke({ init_data: signedData({ auth_date: String(Math.floor(Date.now() / 1000)) }) });
  assert.equal(result.code, 200);
  assert.equal(result.result.verified, true);
  assert.equal(result.result.mode, 'pilot');
  assert.equal(result.result.checkout_enabled, false);
  assert.deepEqual(Object.keys(result.result).sort(), ['checkout_enabled', 'mode', 'user', 'verified']);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('forged hash, wrong token, changed user and duplicate parameters are rejected', () => {
  const original = signedData();
  assert.equal(verifyMaxInitData(original, 'incorrect-token', NOW), null);
  assert.equal(verifyMaxInitData(original.replace('1288', '1289'), BOT_TOKEN, NOW), null);
  assert.equal(verifyMaxInitData(original + '&hash=garbage', BOT_TOKEN, NOW), null);
  assert.equal(verifyMaxInitData(original + '&auth_date=1234567890', BOT_TOKEN, NOW), null);
  assert.equal(verifyMaxInitData(original.replace(/hash=[0-9a-f]{64}/, 'hash=not-a-hash'), BOT_TOKEN, NOW), null);
  assert.equal(verifyMaxInitData('user=untrusted', BOT_TOKEN, NOW), null);
  assert.equal(verifyMaxInitData('x'.repeat(13000), BOT_TOKEN, NOW), null);
});

test('stale or future MAX launch data are rejected', () => {
  const signed = signedData();
  assert.ok(verifyMaxInitData(signed, BOT_TOKEN, NOW + MAX_AGE_SECONDS));
  assert.equal(verifyMaxInitData(signed, BOT_TOKEN, NOW + MAX_AGE_SECONDS + 1), null);
  assert.equal(verifyMaxInitData(signed, BOT_TOKEN, NOW - 61), null);
  assert.ok(verifyMaxInitData(signed, BOT_TOKEN, NOW - 60));
});

test('bad identity and missing data never unlock anything', async () => {
  const signed = signedData({ user: JSON.stringify({ id: -7, first_name: 'Неверный' }) });
  assert.equal(verifyMaxInitData(signed, BOT_TOKEN, NOW), null);
  const bad = await invoke({ init_data: signedData({ auth_date: String(Math.floor(Date.now() / 1000)) }).replace('1288', '1289') });
  assert.equal(bad.code, 401);
  const blank = await invoke({});
  assert.equal(blank.code, 400);
  const noToken = await invoke({ init_data: signedData() }, { token: '' });
  assert.equal(noToken.code, 503);
});

test('isolated pilot route does not register payment or privileged endpoints', () => {
  const router = new Router();
  registerMaxMiniAppRoutes(router, { token: () => BOT_TOKEN });
  assert.equal(router.match('GET', '/api/max/miniapp/verify'), null);
  assert.equal(router.match('POST', '/api/max/miniapp/checkout'), null);
  assert.equal(router.match('GET', '/api/admin/system-health'), null);
});
