// Client-side presentation only. The server validates every promo and
// calculates the final discount itself before creating a YooKassa payment.
(function(){
  'use strict';
  var cutoff=Date.parse('2026-11-30T17:00:00.000Z'); // 01.12 00:00 Krasnoyarsk
  function changed(now){return Number(now===undefined?Date.now():now)>=cutoff}
  var publicCode='HV15';
  function isUniversal(code){return /^(HV15|15)$/i.test(String(code||'').trim())}
  function isNewCode(code){return isUniversal(code)||/^(HVOST|HV)15(?=-)/i.test(String(code||'').trim())}
  function customerCode(value){return /^(HVOST|HV)(20|15)(?=-)/i.test(String(value||'').trim())?publicCode:String(value||'').trim().toUpperCase()}
  function percent(now,code){return changed(now)||isNewCode(code)?15:20}
  function displayCode(value,now){
    var code=String(value||'').trim().toUpperCase();
    return changed(now)?code.replace(/^(HVOST|HV)20(?=-)/,function(_,p){return p+'15'}):code;
  }
  function notice(code,now){
    if(isUniversal(code))return 'Единый промокод HV15: скидка 15% на первую покупку в любой точке ХвостМаркета. Можно ввести просто 15.';
    if(!changed(now)&&isNewCode(code))return 'По этому промокоду скидка на первую покупку — 15%.';
    if(!changed(now))return 'До 30 ноября по старым промокодам — 20%, по новым HV15/HVOST15 — 15%. С 1 декабря — 15% по всем промокодам.';
    if(/^(HVOST|HV)20(?=-)/i.test(String(code||'').trim()))
      return 'С 1 декабря 2026 скидка на первую покупку — 15%. Старый промокод принят, вместо 20% действует 15%.';
    return 'С 1 декабря 2026 года скидка на первую покупку — 15%. Ранее выданные промокоды тоже действуют.';
  }
  window.HvostFirstPurchasePromo={changed:changed,percent:percent,displayCode:displayCode,notice:notice,publicCode:publicCode,publicPercent:15,customerCode:customerCode};
})();
