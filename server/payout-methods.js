'use strict';

// Recipient payout preference only: no transfer is initiated by this field.
// Never collect a full card number, PIN or CVV on these registration screens.
const PAYOUT_METHODS = Object.freeze({
  sbp: 'СБП на номер телефона',
  card: 'Перевод на банковскую карту',
  bank_account: 'На расчётный счёт',
  cash: 'Наличными по согласованию',
});

function parsePayoutMethod(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Выберите способ получения вознаграждения');
    // Existing registrations have no payout method until the person selects one.
    return null;
  }
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(PAYOUT_METHODS, value)) {
    throw new Error('Недопустимый способ получения вознаграждения');
  }
  return value;
}

function payoutMethodLabel(method) {
  return PAYOUT_METHODS[method] || 'Не указан';
}

module.exports = { PAYOUT_METHODS, parsePayoutMethod, payoutMethodLabel };
