'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const policy=require('./first-purchase-promo-policy');
const cutoff=Date.parse('2026-11-30T17:00:00.000Z');
const script=fs.readFileSync(path.join(__dirname,'../public/first-purchase-promo-display.js'),'utf8');

function browserAt(time){
  class Clock extends Date {static now(){return time}}
  const window={};
  vm.runInNewContext(script,{window,Date:Clock},{filename:'first-purchase-promo-display.js'});
  return window.HvostFirstPurchasePromo;
}

test('Krasnoyarsk 1 December midnight changes server and client discount together',()=>{
  assert.equal(policy.EFFECTIVE_AT_UTC,cutoff);
  for(const now of [cutoff-1000,cutoff-1,cutoff,cutoff+1000]){
    const server=policy.getFirstPurchasePromoPolicy(now);
    const client=browserAt(now);
    assert.equal(server.discountPercent,now<cutoff?20:15);
    assert.equal(client.percent(),server.discountPercent);
    assert.equal(client.changed(),server.changed);
    assert.equal(server.timezone,'Asia/Krasnoyarsk');
  }
});
test('newly displayed HV15 codes map to stored HV20, while printed originals remain valid',()=>{
  const after=browserAt(cutoff);
  const before=browserAt(cutoff-1);
  for(const old of ['HV20-G-001','HV20-007','HVOST20-S-101','HVOST20-LEGACY']){
    const display=policy.displayFirstPurchasePromoCode(old,cutoff);
    assert.equal(display,after.displayCode(old));
    assert.notEqual(display,old);
    assert.equal(policy.lookupStoredFirstPurchasePromoCode(display,cutoff),old);
    assert.equal(policy.lookupStoredFirstPurchasePromoCode(old,cutoff),old);
    assert.equal(before.displayCode(old),old);
    assert.equal(policy.lookupStoredFirstPurchasePromoCode(display,cutoff-1),old);
    assert.equal(policy.getFirstPurchasePromoPolicy(cutoff-1,display).discountPercent,15);
    assert.equal(policy.getFirstPurchasePromoPolicy(cutoff-1,old).discountPercent,20);
    assert.equal(before.percent(cutoff-1,display),15);
    assert.equal(before.percent(cutoff-1,old),20);
    assert.match(before.notice(display),/15%/);
    assert.match(policy.firstPurchasePromoNotice(display,cutoff-1),/15%/);
    assert.match(after.notice(old),/15%/);
    assert.match(after.notice(old),/старый промокод/i);
  }
  assert.equal(after.displayCode('GR-001'),'GR-001','referral codes are not sale promo codes');
  assert.equal(after.displayCode('OWN-001'),'OWN-001');
});
test('checkout pricing uses the authoritative validated rate, not an old hard-coded 20%',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-payment.js'),'utf8');
  assert.match(source,/promoDiscount = Math\.round\(pricedCart\.subtotal \* promoValidation\.discountPercent \/ 100\)/);
  assert.match(source,/discount_percent: result\.discountPercent/);
  assert.match(source,/notice: result\.notice/);
  for(const amount of [250,360,1310]){
    const before=Math.round(amount*policy.getFirstPurchasePromoPolicy(cutoff-1).discountPercent/100);
    const after=Math.round(amount*policy.getFirstPurchasePromoPolicy(cutoff).discountPercent/100);
    assert.equal(before,Math.round(amount*.2));
    assert.equal(after,Math.round(amount*.15));
    assert.ok(after<before);
  }
});
test('all public purchase screens show notice and avoid a stale 20% payment amount',()=>{
  const dir=path.join(__dirname,'../public');
  const main=fs.readFileSync(path.join(dir,'index.html'),'utf8');
  const qr=fs.readFileSync(path.join(dir,'p.html'),'utf8');
  const mini=fs.readFileSync(path.join(dir,'miniapp.html'),'utf8');
  for(const source of [main,qr,mini])
    assert.match(source,/first-purchase-promo-display\.js/);
  assert.match(main,/first-purchase-promo-policy-notice/);
  assert.match(main,/percentBeforeValidation !== firstPurchasePromoPercent/);
  assert.match(qr,/previousPromoPercent !== QR_PROMO_PERCENT/);
  assert.match(mini,/state\.promoInfo\.discount_percent!==window\.HvostFirstPurchasePromo\.percent\(undefined,state\.promo\)/);
  assert.doesNotMatch(mini,/Промокод −20%/);
  assert.doesNotMatch(qr,/Промокод грумера −20%/);
  // Existing backend 20% strings in promo-code prefixes remain deliberately.
});
