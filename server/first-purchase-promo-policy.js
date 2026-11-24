'use strict';

// One scheduled change, without cron, timers, or /data writes. The shop is
// operated in Krasnoyarsk (UTC+7): 01.12.2026 00:00 local = 30.11 17:00 UTC.
// Existing HV20/HVOST20 codes stay in SQLite; new HV15/HVOST15 codes are
// read-only aliases for those same partner/salon records.
const EFFECTIVE_AT_UTC = Date.parse('2026-11-30T17:00:00.000Z');
const OLD_PERCENT = 20;
const NEW_PERCENT = 15;
const UNIVERSAL_PROMO_CODE = 'HV15';
const UNIVERSAL_LEGACY_PROMO_CODE = 'HV20';

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
function getUniversalFirstPurchasePromoCode(value){
  const code=normalizedCode(value);
  if(code===UNIVERSAL_PROMO_CODE || code==='15') return UNIVERSAL_PROMO_CODE;
  if(code===UNIVERSAL_LEGACY_PROMO_CODE || code==='20') return UNIVERSAL_LEGACY_PROMO_CODE;
  return '';
}
function isUniversalFirstPurchasePromoCode(value){
  return !!getUniversalFirstPurchasePromoCode(value);
}
function isNewCode(value){
  return getUniversalFirstPurchasePromoCode(value)===UNIVERSAL_PROMO_CODE || /^(HVOST|HV)15(?=-)/.test(normalizedCode(value));
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
  const universal=getUniversalFirstPurchasePromoCode(value);
  if(universal===UNIVERSAL_PROMO_CODE)return 'Единый промокод HV15: скидка 15% на первую покупку в любой точке ХвостМаркета. Можно ввести просто 15.';
  const policy=getFirstPurchasePromoPolicy(now,value);
  if(universal===UNIVERSAL_LEGACY_PROMO_CODE)return policy.changed
    ?'Промокод 20 действует. С 1 декабря 2026 скидка на первую покупку составляет 15% вместо 20%.'
    :'Промокод 20 даёт скидку 20% на первую покупку до конца 30 ноября 2026 по Красноярску.';
  if(!policy.changed && isNewCode(value))return 'По этому промокоду скидка на первую покупку — 15%.';
  if(!policy.changed)return 'До 30.11.2026 включительно по старым промокодам — 20%, по новым HV15/HVOST15 — 15%. С 01.12.2026 — 15% по всем промокодам.';
  const legacy=/^(HVOST|HV)20(?=-)/.test(normalizedCode(value));
  return legacy
    ?'Ваш старый промокод действует. С 01.12.2026 скидка на первую покупку составляет 15% вместо 20%.'
    :'С 01.12.2026 скидка на первую покупку составляет 15%. Старые промокоды тоже действуют со скидкой 15%.';
}
module.exports={
  EFFECTIVE_AT_UTC,OLD_PERCENT,NEW_PERCENT,UNIVERSAL_PROMO_CODE,UNIVERSAL_LEGACY_PROMO_CODE,isUniversalFirstPurchasePromoCode,getUniversalFirstPurchasePromoCode,
  getFirstPurchasePromoPolicy,
  displayFirstPurchasePromoCode,
  lookupStoredFirstPurchasePromoCode,
  firstPurchasePromoNotice,
};
