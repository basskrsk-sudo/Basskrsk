'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { matchesQrPaymentRetry } = require('./qr-payment-retry');

const order = {
  point_id: 'salon-1', customer_phone: '+7 (913) 000-00-01',
  total: 250, fulfillment_type: 'pickup',
};
const items = [{ variant_id: 2, qty: 1 }];
const request = {
  pointId: 'salon-1', customerPhone: '89130000001', amount: 250,
  cartItems: [{ variantId: 2, qty: 1 }],
  confirmationMode: 'redirect', returnPath: '/p/salon-1/lung',
};

test('safe retry of same checkout reuses the original order', () => {
  assert.equal(matchesQrPaymentRetry(order, items, request), true);
  for (const patch of [
    { pointId: 'other-salon' }, { customerPhone: '89130000002' },
    { amount: 260 }, { cartItems: [{ variantId: 3, qty: 1 }] },
    { cartItems: [{ variantId: 2, qty: 2 }] },
    { confirmationMode: 'embedded' }, { returnPath: 'https://other.test/p/salon-1/lung' },
  ]) {
    assert.equal(matchesQrPaymentRetry(order, items, { ...request, ...patch }), false,
      'must reject ' + JSON.stringify(patch));
  }
});
test('YooKassa idempotence key never depends on Date.now', () => {
  const source = fs.readFileSync(path.join(__dirname, 'yookassa.js'), 'utf8');
  assert.match(source, /createHash\('sha256'\)\.update\(String\(orderCode\)\)\.digest\('hex'\)/);
});
