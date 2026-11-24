// Client-side presentation only. The server validates every promo and
// calculates the final discount itself before creating a YooKassa payment.
(function(){
  'use strict';
  var cutoff=Date.parse('2026-11-30T17:00:00.000Z'); // 01.12 00:00 Krasnoyarsk
  function changed(now){return Number(now===undefined?Date.now():now)>=cutoff}
  function isNewCode(code){return /^(HVOST|HV)15(?=-)/i.test(String(code||'').trim())}
  function percent(now,code){return changed(now)||isNewCode(code)?15:20}
  function displayCode(value,now){
    var code=String(value||'').trim().toUpperCase();
    return changed(now)?code.replace(/^(HVOST|HV)20(?=-)/,function(_,p){return p+'15'}):code;
  }
  function notice(code,now){
    if(!changed(now)&&isNewCode(code))return 'По этому промокоду скидка на первую покупку — 15%.';
    if(!changed(now))return 'До 30 ноября по старым промокодам — 20%, по новым HV15/HVOST15 — 15%. С 1 декабря — 15% по всем промокодам.';
    if(/^(HVOST|HV)20(?=-)/i.test(String(code||'').trim()))
      return 'С 1 декабря 2026 скидка на первую покупку — 15%. Старый промокод принят, вместо 20% действует 15%.';
    return 'С 1 декабря 2026 года скидка на первую покупку — 15%. Ранее выданные промокоды тоже действуют.';
  }
  window.HvostFirstPurchasePromo={changed:changed,percent:percent,displayCode:displayCode,notice:notice};
})();
