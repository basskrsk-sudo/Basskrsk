'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '../public/p.html'), 'utf8');
const start = page.indexOf('var QR_PAYMENT_STORAGE_KEY =');
const end = page.indexOf('\nfunction state(html)', start);
assert.ok(start >= 0 && end > start, 'QR checkout recovery helpers exist');
const recoverySource = page.slice(start, end);

function harness(fetchImpl) {
  const storage = new Map();
  const redirects = [];
  const screens = [];
  const successes = [];
  const requests = [];
  const ctx = {
    console, Date, JSON, URL, AbortController, clearTimeout, setTimeout,
    location: { pathname: '/p/salon-1/lung', assign: url => redirects.push(url) },
    CTX: { pointId: 'salon-1', productSlug: 'lung', product: { id: 1, name: 'Лёгкое' } },
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    state: value => screens.push(value),
    showPhoneStep() { screens.push('phone-step'); },
    esc: String, fmtPrice: value => value + ' ₽',
    trackGoal() {}, trackGoalOnce() {}, recordQrEvent() {},
    showSuccess: (...args) => successes.push(args),
    QR_PUBLIC_NUMBER: '', 
    fetch: (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return fetchImpl(url, options);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(recoverySource, ctx);
  return { ctx, storage, redirects, screens, successes, requests };
}
function attempt() {
  return {
    orderId: 'TG-original-opaque', pointId: 'salon-1', productSlug: 'lung',
    variantId: 2, weight: '50 г', amount: 250, phone: '+79130000001',
    createdAt: Date.now(),
    body: { orderId: 'TG-original-opaque', pointId: 'salon-1',
      cartItems: [{ variantId: 2, qty: 1 }], confirmationMode: 'redirect',
      amount: 250, customerPhone: '+79130000001', returnPath: '/p/salon-1/lung' },
  };
}
test('QR checkout retries the same order and redirects to YooKassa once', async () => {
  const h = harness(async () => ({
    ok: true, status: 200,
    json: async () => ({ confirmation_url: 'https://yoomoney.ru/pay/one', display_number: 'ХМ-0042' }),
  }));
  h.ctx.savePendingQrPayment(attempt());
  await h.ctx.resumePendingQrPayment();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.orderId, 'TG-original-opaque');
  assert.equal(h.redirects[0], 'https://yoomoney.ru/pay/one');
  assert.ok(h.ctx.readPendingQrPayment(), 'retry keeps attempt until confirmed success');
});
test('a network switch keeps checkout context and offers safe recovery', async () => {
  const h = harness(async () => { throw new TypeError('Network switch'); });
  h.ctx.savePendingQrPayment(attempt());
  await h.ctx.resumePendingQrPayment();
  assert.ok(h.ctx.readPendingQrPayment());
  assert.match(h.screens.at(-1), /Соединение прервалось/);
  assert.match(h.screens.at(-1), /Проверить и продолжить оплату/);
});
test('a paid retry clears the pending attempt without creating a new payment', async () => {
  const h = harness(async () => ({
    ok: true, status: 200, json: async () => ({ paid: true, display_number: 'ХМ-0042' }),
  }));
  h.ctx.savePendingQrPayment(attempt());
  await h.ctx.resumePendingQrPayment();
  assert.equal(h.ctx.readPendingQrPayment(), null);
  assert.equal(h.successes.length, 1);
  assert.equal(h.redirects.length, 0);
});
test('concurrent taps do not create parallel checkout requests', async () => {
  let complete;
  const h = harness(() => new Promise(resolve => { complete = resolve; }));
  const saved = attempt();
  h.ctx.savePendingQrPayment(saved);
  const first = h.ctx.runQrPayment(saved);
  const second = h.ctx.runQrPayment(saved);
  assert.equal(h.requests.length, 1);
  complete({ ok: true, status: 202, json: async () => ({ status: 'initializing' }) });
  await Promise.all([first, second]);
  assert.equal(h.redirects.length, 0);
});
test('QR checkout uses direct redirect without an embedded widget and bounds network wait', () => {
  const checkout = page.slice(page.indexOf('async function startPayment()'), page.indexOf('/* ── Экран 4: успех ── */'));
  assert.match(checkout, /confirmationMode: 'redirect'/);
  assert.doesNotMatch(page, /YooMoneyCheckoutWidget|prepareWidget\(/);
  assert.match(recoverySource, /controller\.abort\(\); \}, 8000/);
});
