'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('QR promo validation passes the selected salon point_id to the server', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'p.html'), 'utf8');
  const start = html.indexOf('async function validateQrPromo(showEmptyError) {');
  const end = html.indexOf('\n}\n\nasync function checkQrSelfOrder()', start);
  assert.ok(start >= 0 && end > start, 'QR promo validation function must be present');
  const handler = html.slice(start, end + 2);
  let requestedUrl = '';
  const fields = {
    qrPromo: { value: 'hv20-007' },
    phone: { value: '9001234567' },
    qrPromoMsg: { textContent: '', style: {} },
  };
  const context = {
    CTX: { pointId: 'dog-style' },
    document: { getElementById: (id) => fields[id] || null },
    normPhone: (value) => '+7' + value.replace(/\D/g, '').slice(-10),
    encodeURIComponent,
    QR_PROMO_VALID: false,
    QR_PROMO_PERCENT: 0,
    QR_PROMO_CODE: '',
    updateQrPayButton() {},
    fetch: async (url) => {
      requestedUrl = url;
      return { json: async () => ({ valid: true, discount_percent: 20, promo_code: 'HV20-007' }) };
    },
  };
  vm.runInNewContext(handler + '\nthis.validatePromo = validateQrPromo;', context, { filename: 'public/p.html' });

  assert.equal(await context.validatePromo(true), true);
  const params = new URL(requestedUrl, 'https://example.invalid').searchParams;
  assert.equal(params.get('code'), 'HV20-007');
  assert.equal(params.get('phone'), '+79001234567');
  assert.equal(params.get('point_id'), 'dog-style');
  assert.equal(context.QR_PROMO_VALID, true);
  assert.equal(context.QR_PROMO_PERCENT, 20);
});
