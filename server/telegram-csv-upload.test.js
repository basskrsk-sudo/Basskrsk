'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendTelegramCsvDocument } = require('./telegram-csv-upload');

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const params = {
  token: 'test-token',
  chatId: 123,
  csvText: '\uFEFF"Точка";"Продажи"\r\n"БаркЛай";"0"\r\n',
  filename: 'business-points-2026.csv',
  caption: 'Все точки ХвостМаркета',
};

test('sends CSV as a real Telegram document, with correct name and UTF-8 data', async () => {
  let seen = null;
  const result = await sendTelegramCsvDocument({
    ...params,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return response(200, { ok: true });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.match(seen.url, /\/sendDocument$/);
  assert.equal(seen.options.body.get('chat_id'), '123');
  const document = seen.options.body.get('document');
  assert.equal(document.name, params.filename);
  assert.equal(await document.text(), params.csvText);
});

test('retries a rejected upload after Telegram 429 Retry-After', async () => {
  let tries = 0;
  const waits = [];
  const result = await sendTelegramCsvDocument({
    ...params,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      tries++;
      return tries === 1
        ? response(429, { ok: false, error_code: 429,
            description: 'Too Many Requests: retry after 3',
            parameters: { retry_after: 3 } })
        : response(200, { ok: true });
    },
  });
  assert.equal(tries, 2);
  assert.deepEqual(waits, [3300]);
  assert.equal(result.attempts, 2);
});

test('never retries non-429 responses', async () => {
  let tries = 0;
  await assert.rejects(() => sendTelegramCsvDocument({
    ...params,
    fetchImpl: async () => {
      tries++;
      return response(400, {
        ok: false, error_code: 400, description: 'Bad Request: invalid file',
      });
    },
  }), (err) => err.telegramCode === 400 && /invalid file/.test(err.message));
  assert.equal(tries, 1);
});

test('does not retry an unknown network outcome, to avoid duplicate files', async () => {
  let tries = 0;
  await assert.rejects(() => sendTelegramCsvDocument({
    ...params,
    fetchImpl: async () => {
      tries++;
      throw new Error('fetch failed');
    },
  }), /fetch failed/);
  assert.equal(tries, 1);
});

test('does not sleep on an excessive Telegram retry timeout', async () => {
  let tries = 0;
  await assert.rejects(() => sendTelegramCsvDocument({
    ...params,
    fetchImpl: async () => {
      tries++;
      return response(429, { ok: false, error_code: 429,
        parameters: { retry_after: 999 }, description: 'Too Many Requests' });
    },
    sleep: async () => { throw new Error('must not sleep'); },
  }), err => err.telegramCode === 429 && err.retryAfter === 999);
  assert.equal(tries, 1);
});
