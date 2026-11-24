// Client-side presentation only. The server validates every promo and
// calculates the final discount itself before creating a YooKassa payment.
(function(){
  'use strict';
  var cutoff=Date.parse('2026-11-30T17:00:00.000Z'); // 01.12 00:00 Krasnoyarsk
  function changed(now){return Number(now===undefined?Date.now():now)>=cutoff}
  var publicCode='HV15';
  function isUniversal15(code){return /^HV15$/i.test(String(code||'').trim())}
  function isUniversal20(code){return /^HV20$/i.test(String(code||'').trim())}
  function isNewCode(code){return isUniversal15(code)||/^(HVOST|HV)15(?=-)/i.test(String(code||'').trim())}
  function checkoutNotice(now){
    return 'Если у вас есть промокод на первую покупку, введите его полностью и нажмите «Применить».';
  }
  function codeFromLink(value){
    var code=String(value||'').trim().toUpperCase();
    return /^(HV15|HV20|15|20)$/.test(code)?'':code;
  }
  function customerCode(value){return /^(HVOST|HV)(20|15)(?=-)/i.test(String(value||'').trim())?publicCode:String(value||'').trim().toUpperCase()}
  function percent(now,code){return changed(now)||isNewCode(code)?15:20}
  function displayCode(value,now){
    var code=String(value||'').trim().toUpperCase();
    return changed(now)?code.replace(/^(HVOST|HV)20(?=-)/,function(_,p){return p+'15'}):code;
  }
  function notice(code,now){
    if(isUniversal15(code))return 'Единый промокод HV15: скидка 15% на первую покупку в любой точке ХвостМаркета.';
    if(isUniversal20(code))return changed(now)
      ?'Промокод HV20 действует. С 1 декабря 2026 скидка на первую покупку составляет 15% вместо 20%.'
      :'Промокод HV20 даёт скидку 20% на первую покупку до конца 30 ноября 2026 по Красноярску.';
    if(!changed(now)&&isNewCode(code))return 'По этому промокоду скидка на первую покупку — 15%.';
    if(!changed(now))return 'До 30 ноября по старым промокодам — 20%, по новым HV15/HVOST15 — 15%. С 1 декабря — 15% по всем промокодам.';
    if(/^(HVOST|HV)20(?=-)/i.test(String(code||'').trim()))
      return 'С 1 декабря 2026 скидка на первую покупку — 15%. Старый промокод принят, вместо 20% действует 15%.';
    return 'С 1 декабря 2026 года скидка на первую покупку — 15%. Ранее выданные промокоды тоже действуют.';
  }
  window.HvostFirstPurchasePromo={changed:changed,percent:percent,displayCode:displayCode,notice:notice,checkoutNotice:checkoutNotice,codeFromLink:codeFromLink,publicCode:publicCode,publicPercent:15,customerCode:customerCode};
})();
