'use strict';

// Short human-readable number for NEW orders only. Persisted separately from
// technical order_code, which is used by YooKassa, refunds, existing URLs and
// the customer's non-enumerable account-claim flow.
function numberForId(id) {
  const text = String(id);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new RangeError('Invalid order row ID');
  return 'ХМ-' + text.padStart(5, '0');
}

function assignDisplayNumber(db, id) {
  const number = numberForId(id);
  const updated = db.prepare(
    'UPDATE orders SET display_number=? WHERE id=? AND display_number IS NULL'
  ).run(number,id);
  if (updated.changes !== 1) throw new Error('Display number was not assigned to the new order');
  return number;
}

function visibleOrderNumber(order) {
  return String(order?.display_number || order?.order_code || '');
}

module.exports = {numberForId,assignDisplayNumber,visibleOrderNumber};
