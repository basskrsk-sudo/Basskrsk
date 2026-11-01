'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyTelegramInitData } = require('./routes-miniapp');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWxyz';
const now = 1750000000;

function makeInitData(fields = {}) {
  const params = new URLSearchParams(Object.assign({
    auth_date: String(now),
    query_id: 'AAExample-123',
    user: JSON.stringify({ id: 123456789, first_name: 'Тестовый', last_name: 'Покупатель' }),
  }, fields));
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(dataCheckString).digest('hex'));
  return params.toString();
}

test('accepts correctly signed Telegram customer, never exposes auth token', () => {
  assert.deepEqual(verifyTelegramInitData(makeInitData(), token, now), {
    id: 123456789, first_name: 'Тестовый', last_name: 'Покупатель', username: '',
  });
});

test('rejects tampering with signed profile', () => {
  const tampered = makeInitData().replace(encodeURIComponent('Тестовый'), encodeURIComponent('Чужой'));
  assert.throws(() => verifyTelegramInitData(tampered, token, now), /signature/);
});

test('rejects signatures for another Telegram bot', () => {
  assert.throws(() => verifyTelegramInitData(makeInitData(), 'wrong-bot-token', now), /signature/);
});

test('rejects an expired or future initData', () => {
  assert.throws(() => verifyTelegramInitData(makeInitData(), token, now + 60 * 60 * 25), /expired/);
  assert.throws(() => verifyTelegramInitData(makeInitData({ auth_date: String(now + 61) }), token, now), /expired/);
});

test('rejects duplicate Telegram fields', () => {
  assert.throws(() => verifyTelegramInitData(makeInitData() + '&user=%7B%7D', token, now), /Duplicate/);
});

test('rejects missing Telegram customer', () => {
  assert.throws(() => verifyTelegramInitData(makeInitData({ user: '{}' }), token, now), /user/);
});

test('rejects missing bot token and missing hash', () => {
  assert.throws(() => verifyTelegramInitData(makeInitData(), '', now), /Bot token/);
  assert.throws(() => verifyTelegramInitData('auth_date=1750000000&user=%7B%7D', token, now), /signature/);
});
