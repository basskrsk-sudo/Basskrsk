'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(file, start, end) {
  const text = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

function catalogContext(status) {
  const elements = new Map();
  const pages = [];
  const context = {
    URL, console,
    window: { location: { href: 'https://example.test/?payment_return=TG-test' } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '' });
      return elements.get(id);
    } },
    closeModal() {}, showPage(id) { pages.push(id); },
    fetchWithTimeout: async () => ({ ok: true, json: async () => status }),
    readPendingSuccess: () => ({ fulfillmentType: 'pickup', items: [], phone: '+79990000000', pickup: 'Точка', total: 100 }),
    configureSuccessFulfillment() {}, renderSuccessProducts() {},
    getKnownPhone: () => '', escapeHtml: String,
    trackGoalOnce() {}, showCheckoutMessagingOffers() {}, clearPendingSuccess() {},
    checkoutPaymentMethod: 'yookassa', setTimeout(resolve) { resolve(); },
  };
  vm.createContext(context);
  vm.runInContext(source('index.html', 'async function handleRedirectPaymentReturn()', '\nfunction simulatePaymentSuccess('), context);
  return { context, elements, pages };
}

test('возврат из банка открывает подтверждение только после paid от сервера', async () => {
  const { context, elements, pages } = catalogContext({ paid: true, order_code: 'TG-test' });
  await context.handleRedirectPaymentReturn();
  assert.deepEqual(pages, ['payment-result', 'success']);
  assert.match(elements.get('success-details').innerHTML, /оплата подтверждена/);
  assert.equal(new URL(context.window.location.href).searchParams.get('payment_return'), 'TG-test');
});

test('задержка подтверждения оставляет экран проверки и кнопку повтора', async () => {
  const { context, elements, pages } = catalogContext({ paid: false, status: 'pending' });
  await context.handleRedirectPaymentReturn();
  assert.deepEqual(pages, ['payment-result']);
  assert.equal(elements.get('payment-result-retry').style.display, 'inline-flex');
  assert.equal(elements.get('payment-result-title').textContent, 'Платёж ещё обрабатывается');
});

test('отменённый платёж не показывает экран успешной оплаты', async () => {
  const { context, elements, pages } = catalogContext({ paid: false, status: 'failed' });
  await context.handleRedirectPaymentReturn();
  assert.deepEqual(pages, ['payment-result']);
  assert.equal(elements.get('payment-result-title').textContent, 'Оплата не завершена');
});

test('QR возврат проверяет оплату даже после продажи последней единицы', async () => {
  const returned = [];
  const context = {
    URLSearchParams, location: { search: '?payment_return=TG-last' },
    CTX: {}, parseParams: () => ({ point: 'p1', product: 'toy' }),
    fetch: async (url) => ({ ok: true, json: async () =>
      url === '/api/products' ? { products: [{ id: 1, slug: 'toy', active: true, variants: [{ id: 2, active: true, stock: { p1: 0 } }] }] }
        : url === '/api/points' ? { points: [{ id: 'p1', name: 'Точка' }] } : { partners: [] }
    }),
    document: { getElementById: () => ({ style: {} }) },
    rememberQrPoint() {}, trackGoalOnce() {},
    handlePaymentReturn: async (code) => returned.push(code),
    failState() { throw Error('Нельзя блокировать результат остатками'); },
    renderCard() { throw Error('Ожидалось подтверждение оплаты'); },
  };
  vm.createContext(context);
  vm.runInContext(source('p.html', 'async function boot()', '\nfunction findAlts('), context);
  await context.boot();
  assert.deepEqual(returned, ['TG-last']);
});
