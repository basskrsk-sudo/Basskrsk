'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function source(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }

test('payment return finishes status check before loading browsing data', async () => {
  let finishPayment;
  const calls = [];
  const context = {
    URLSearchParams, window: { location: { search: '?payment_return=TG-test' } },
    handleRedirectPaymentReturn: () => new Promise(resolve => { finishPayment = resolve; calls.push('payment'); }),
    startBrowsingData: () => calls.push('catalog'),
  };
  vm.createContext(context);
  vm.runInContext(source('async function initializeStorefront()', '\nsetupDeferredNews();'), context);
  const started = context.initializeStorefront();
  assert.deepEqual(calls, ['payment']);
  finishPayment(); await started;
  assert.deepEqual(calls, ['payment', 'catalog']);
});

test('opening home does not load the account or news', async () => {
  const calls = [];
  const context = {
    URLSearchParams, window: { location: { search: '' } },
    startBrowsingData: async () => calls.push('catalog'),
    renderAccountPage: () => calls.push('account'), loadPublicNews: () => calls.push('news'),
  };
  vm.createContext(context);
  vm.runInContext(source('async function initializeStorefront()', '\nsetupDeferredNews();'), context);
  await context.initializeStorefront();
  assert.deepEqual(calls, ['catalog']);
});

test('simultaneous point requests share one fetch and errors permit retry', async () => {
  let requests = 0;
  let fail = true;
  const context = { window: {}, Date, fetch: async () => {
    requests++; return { ok: !fail, json: async () => fail ? { error: 'offline' } : { points: [{ id: 'p1' }] } };
  } };
  vm.createContext(context);
  vm.runInContext(source('async function loadPointDirectory()', '// Выбранный город'), context);
  const first = await Promise.allSettled([context.loadPointDirectory(), context.loadPointDirectory()]);
  assert.equal(requests, 1);
  assert.equal(first[0].status, 'rejected');
  fail = false;
  const next = await Promise.all([context.loadPointDirectory(), context.loadPointDirectory()]);
  assert.equal(requests, 2);
  assert.equal(next[0][0].id, 'p1');
  await context.loadPointDirectory();
  assert.equal(requests, 2);
});
