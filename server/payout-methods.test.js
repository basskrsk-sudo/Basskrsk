'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PAYOUT_METHODS, parsePayoutMethod, payoutMethodLabel } = require('./payout-methods');

test('exactly four payout channels are supported', () => {
  assert.deepEqual(Object.keys(PAYOUT_METHODS), ['sbp', 'card', 'bank_account', 'cash']);
  for (const method of Object.keys(PAYOUT_METHODS)) {
    assert.equal(parsePayoutMethod(method, { required: true }), method);
    assert.ok(payoutMethodLabel(method).length > 4);
  }
});
test('older accounts may be unconfigured; saving a preference requires a choice', () => {
  assert.equal(parsePayoutMethod(undefined), null);
  assert.equal(parsePayoutMethod(null), null);
  assert.equal(payoutMethodLabel(null), 'Не указан');
  for (const value of ['', null, undefined]) {
    assert.throws(() => parsePayoutMethod(value, { required: true }), /Выберите способ/);
  }
});
test('arbitrary payout method payloads are rejected', () => {
  for (const value of ['crypto', 'sbp ', 42, {}, ['cash']]) {
    assert.throws(() => parsePayoutMethod(value), /Недопустимый/);
  }
});
