'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const claims = { legacy: new Map(), salon: new Map() };
  const db = {
    prepare(query) {
      return {
        all() { return []; },
        get(phoneOrCode) {
          if (query.includes('FROM points WHERE UPPER')) return phoneOrCode === 'HVOST20-S-TEST'
            ? { id:'salon-a', name:'Салон А', first_purchase_promo_code:'HVOST20-S-TEST' } : undefined;
          if (query.includes('FROM partners') && query.includes('UPPER')) return phoneOrCode === 'HVOST20-001'
            ? { id:1, full_name:'Грумер', first_purchase_promo_code:'HVOST20-001' } : undefined;
          if (query.includes('FROM orders WHERE id=?')) return { status: 'pending', reservation_status: 'active' };
          if (query.includes('FROM first_purchase_promo_claims')) return claims.legacy.get(phoneOrCode);
          if (query.includes('FROM first_purchase_point_promo_claims')) return claims.salon.get(phoneOrCode);
        },
        run(phone, id, code, orderId) {
          if (query.includes('INSERT INTO first_purchase_point_promo_claims')) claims.salon.set(phone,{order_id:orderId});
          if (query.includes('INSERT INTO first_purchase_promo_claims')) claims.legacy.set(phone,{order_id:orderId});
          if (query.includes('DELETE FROM first_purchase_point_promo_claims')) {
            for (const [key,value] of claims.salon) if (value.order_id === phone) claims.salon.delete(key);
          }
          if (query.includes('DELETE FROM first_purchase_promo_claims')) {
            for (const [key,value] of claims.legacy) if (value.order_id === phone) claims.legacy.delete(key);
          }
        },
      };
    },
  };
  const moduleObj = {exports:{}};
  const source = fs.readFileSync(require.resolve('./first-purchase-promo'),'utf8');
  vm.runInNewContext(source,{require(name) {if(name==='./db') return db;if(name==='./first-purchase-promo-policy') return require('./first-purchase-promo-policy');if(name==='./report-phone-key') return require('./report-phone-key');throw Error(name);},module:moduleObj,exports:moduleObj.exports});
  return moduleObj.exports;
}

test('salon code is accepted only for own pickup point; legacy code still works', () => {
  const api = setup();
  assert.equal(api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000001','salon-a').valid,true);
  assert.equal(api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000001','salon-b').valid,false);
  assert.equal(api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000001').valid,false);
  assert.equal(api.validateFirstPurchasePromo('HVOST20-001','+79130000002','salon-a').valid,true);
});

test('a phone cannot claim both a salon code and an old groomer code', () => {
  const api = setup();
  const salon=api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000001','salon-a');
  api.claimFirstPurchasePromo(salon,10);
  assert.equal(api.validateFirstPurchasePromo('HVOST20-001','+79130000001','salon-a').valid,false);
  api.releaseFirstPurchasePromoClaim(10);
  assert.equal(api.validateFirstPurchasePromo('HVOST20-001','+79130000001','salon-a').valid,true);
});

test('salon HVOST20 and HVOST15 aliases resolve to the same location from 1 December',()=>{
 const api=setup(),cutoff=Date.parse('2026-11-30T17:00:00.000Z');
 const before=api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000021','salon-a',cutoff-1);
 assert.equal(before.discountPercent,20);
 const early=api.validateFirstPurchasePromo('HVOST15-S-TEST','+79130000022','salon-a',cutoff-1);
 assert.equal(early.valid,true);
 assert.equal(early.discountPercent,15);
 assert.equal(early.pointId,'salon-a');
 assert.equal(api.validateFirstPurchasePromo('HVOST15-S-TEST','+79130000026','salon-b',cutoff-1).valid,false);
 const old=api.validateFirstPurchasePromo('HVOST20-S-TEST','+79130000023','salon-a',cutoff);
 const current=api.validateFirstPurchasePromo('HVOST15-S-TEST','+79130000024','salon-a',cutoff);
 assert.equal(old.valid,true);
 assert.equal(current.valid,true);
 assert.equal(old.discountPercent,15);
 assert.equal(current.discountPercent,15);
 assert.equal(current.pointId,'salon-a');
 assert.equal(api.validateFirstPurchasePromo('HVOST15-S-TEST','+79130000025','salon-b',cutoff).valid,false);
});
