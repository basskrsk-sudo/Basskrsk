'use strict';

// One scheduled change, without cron, timers, or /data writes. The shop is
// operated in Krasnoyarsk (UTC+7): 01.12.2026 00:00 local = 30.11 17:00 UTC.
// Existing HV20/HVOST20 codes stay in SQLite; new HV15/HVOST15 codes are
// read-only aliases for those same partner/salon records.
const EFFECTIVE_AT_UTC = Date.parse('2026-11-30T17:00:00.000Z');
const OLD_PERCENT = 20;
const NEW_PERCENT = 15;

function getFirstPurchasePromoPolicy(now = Date.now(), value = '') {
  const changed=Number(now)>=EFFECTIVE_AT_UTC;
  return {
    discountPercent:changed || isNewCode(value) ? NEW_PERCENT : OLD_PERCENT,
    changed,
    effectiveOn:'2026-12-01',
    timezone:'Asia/Krasnoyarsk',
  };
}
function normalizedCode(value){
  return String(value||'').trim().toUpperCase();
}
function isNewCode(value){
  return /^(HVOST|HV)15(?=-)/.test(normalizedCode(value));
}
function displayFirstPurchasePromoCode(value,now=Date.now()){
  const code=normalizedCode(value);
  return getFirstPurchasePromoPolicy(now).changed
    ?code.replace(/^(HVOST|HV)20(?=-)/,(_,prefix)=>prefix+'15')
    :code;
}
function lookupStoredFirstPurchasePromoCode(value,now=Date.now()){
  const code=normalizedCode(value);
  return code.replace(/^(HVOST|HV)15(?=-)/,(_,prefix)=>prefix+'20');
}
function firstPurchasePromoNotice(value,now=Date.now()){
  const policy=getFirstPurchasePromoPolicy(now,value);
  if(!policy.changed && isNewCode(value))return 'По этому промокоду скидка на первую покупку — 15%.';
  if(!policy.changed)return 'До 30.11.2026 включительно по старым промокодам — 20%, по новым HV15/HVOST15 — 15%. С 01.12.2026 — 15% по всем промокодам.';
  const legacy=/^(HVOST|HV)20(?=-)/.test(normalizedCode(value));
  return legacy
    ?'Ваш старый промокод действует. С 01.12.2026 скидка на первую покупку составляет 15% вместо 20%.'
    :'С 01.12.2026 скидка на первую покупку составляет 15%. Старые промокоды тоже действуют со скидкой 15%.';
}
module.exports={
  EFFECTIVE_AT_UTC,OLD_PERCENT,NEW_PERCENT,
  getFirstPurchasePromoPolicy,
  displayFirstPurchasePromoCode,
  lookupStoredFirstPurchasePromoCode,
  firstPurchasePromoNotice,
};
