// Client-side presentation only. The server validates every promo and
// calculates the final discount itself before creating a YooKassa payment.
(function(){
  'use strict';
  var cutoff=Date.parse('2026-11-30T17:00:00.000Z'); // 01.12 00:00 Krasnoyarsk
  function changed(now){return Number(now===undefined?Date.now():now)>=cutoff}
  function percent(now){return changed(now)?15:20}
  function displayCode(value,now){
    var code=String(value||'').trim().toUpperCase();
    return changed(now)?code.replace(/^(HVOST|HV)20(?=-)/,function(_,p){return p+'15'}):code;
  }
  function notice(code,now){
    if(!changed(now))return 'С 1 декабря 2026 года скидка на первую покупку составит 15%. До 30 ноября — 20%.';
    if(/^(HVOST|HV)20(?=-)/i.test(String(code||'').trim()))
      return 'С 1 декабря 2026 скидка на первую покупку — 15%. Старый промокод принят, вместо 20% действует 15%.';
    return 'С 1 декабря 2026 года скидка на первую покупку — 15%. Ранее выданные промокоды тоже действуют.';
  }
  window.HvostFirstPurchasePromo={changed:changed,percent:percent,displayCode:displayCode,notice:notice};
})();
