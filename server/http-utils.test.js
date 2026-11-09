'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readBody, parseJsonBody, Router } = require('./http-utils');

function request(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.headers = headers;
  return req;
}

test('JSON request body joins UTF-8 chunks correctly', async () => {
  const encoded = Buffer.from(JSON.stringify({ text: 'Привет 🐾' }));
  const parsed = await parseJsonBody(request([encoded.subarray(0, 12), encoded.subarray(12, 16), encoded.subarray(16)]));
  assert.deepEqual(parsed, { text: 'Привет 🐾' });
});
test('large declared body is rejected with HTTP 413', async () => {
  await assert.rejects(readBody(request([], { 'content-length': String(23 * 1024 * 1024) })),
    err => err.statusCode === 413);
});
test('router preserves registration order and method matching', () => {
  const router = new Router();
  const first = () => 1;
  const second = () => 2;
  router.get('/api/items/:id', first);
  router.post('/api/items/:id', second);
  router.get('/api/items/special', second);
  assert.equal(router.match('GET', '/api/items/123').handler, first);
  assert.equal(router.match('POST', '/api/items/123').handler, second);
  assert.equal(router.match('GET', '/api/items/special').handler, first);
  assert.equal(router.match('DELETE', '/api/items/123'), null);
});
