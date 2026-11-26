'use strict';

// Recipient payout preference only: no transfer is initiated by this field.
// Never collect a full card number, PIN or CVV on these registration screens.
const PAYOUT_METHODS = Object.freeze({
  sbp: 'СБП на номер телефона',
  card: 'Перевод на банковскую карту',
  bank_account: 'Безналичный расчёт по договору (на счёт)',
  cash: 'Наличными по согласованию',
  mobile_balance: 'Пополнение баланса мобильного телефона',
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

function payoutMethodCode(method) {
  return typeof method==='string'&&Object.hasOwn(PAYOUT_METHODS,method)?method:null;
}
function payoutMethodLabel(method) {
  return PAYOUT_METHODS[payoutMethodCode(method)] || 'Не указан';
}
// Store only explicitly confirmed actual channels, never infer legacy ones.
function parseActualPayoutMethod(value) {
  try{return parsePayoutMethod(value);}catch(e){throw Object.assign(e,{statusCode:400,publicMessage:true});}
}

module.exports = { PAYOUT_METHODS, parsePayoutMethod, payoutMethodLabel, payoutMethodCode, parseActualPayoutMethod };
