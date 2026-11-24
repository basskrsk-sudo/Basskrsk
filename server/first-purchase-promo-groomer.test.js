'use strict';

// Integration test with the real SQLite schema and registration trigger.
// A separate DATA_DIR keeps production data and other tests untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-promo-groomer-'));
process.env.DATA_DIR = dir;
const db = require('./db');
const {
  validateFirstPurchasePromo, claimFirstPurchasePromo,
  releaseFirstPurchasePromoClaim,
} = require('./first-purchase-promo');

test('registration auto-generates separate codes and keeps old promo codes valid', () => {
  const pointId = 'test-groomer-promo-point';
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
    .run(pointId, 'Тестовый салон', 'Тестовая улица, 1', '🐾');

  function addGroomer(suffix, oldPromo = null) {
    const info = db.prepare(
      'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,' +
      'point_id,point_name,active,first_purchase_promo_code) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      'PROMO-TEST-' + suffix, 'promo-test-' + suffix, 'password-hash',
      'Тестовый грумер ' + suffix, '7900123000' + suffix,
      pointId, 'Тестовый салон', 1, oldPromo
    );
    return db.prepare('SELECT id,first_purchase_promo_code FROM partners WHERE id = ?')
      .get(info.lastInsertRowid);
  }

  const first = addGroomer('1');
  const second = addGroomer('2');
  const old = addGroomer('3', 'HVOST20-TEST-LEGACY');

  assert.equal(first.first_purchase_promo_code, 'HV20-G-' + String(first.id).padStart(3, '0'));
  assert.equal(second.first_purchase_promo_code, 'HV20-G-' + String(second.id).padStart(3, '0'));
  assert.notEqual(first.first_purchase_promo_code, second.first_purchase_promo_code);
  assert.equal(old.first_purchase_promo_code, 'HVOST20-TEST-LEGACY');

  const phone = '+7 (900) 999-00-01';
  const validation = validateFirstPurchasePromo(first.first_purchase_promo_code, phone, pointId,
    Date.parse('2026-11-20T00:00:00Z'));
  assert.equal(validation.valid, true);
  assert.equal(validation.discountPercent, 20);
  assert.equal(validation.partnerId, first.id);
  assert.equal(validateFirstPurchasePromo(old.first_purchase_promo_code, '+79009990002', pointId).valid, true);

  const order = db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,' +
    'point_id,subtotal,total,payment_method,status) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('PROMO-TEST-ORDER', 'Клиент', phone, 'Тестовый салон',
    pointId, 250, 200, 'sbp', 'pending');
  claimFirstPurchasePromo(validation, order.lastInsertRowid);
  assert.equal(validateFirstPurchasePromo(second.first_purchase_promo_code, phone, pointId).valid, false);
  releaseFirstPurchasePromoClaim(order.lastInsertRowid);
  assert.equal(validateFirstPurchasePromo(second.first_purchase_promo_code, phone, pointId).valid, true);

  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.lastInsertRowid);
  assert.equal(validateFirstPurchasePromo(second.first_purchase_promo_code, phone, pointId).valid, false);
  assert.equal(validateFirstPurchasePromo(first.first_purchase_promo_code, phone, pointId).valid, false);
  assert.equal(validateFirstPurchasePromo(old.first_purchase_promo_code, '+79009990003', pointId).valid, true);
});

test('existing groomer HV20 and legacy code work after cutoff at 15%, new HV15 is identical',()=>{
  const groomer=db.prepare("SELECT id,first_purchase_promo_code FROM partners WHERE first_purchase_promo_code LIKE 'HV20-G-%' ORDER BY id LIMIT 1").get();
  assert.ok(groomer);
  const pointId='test-groomer-promo-point';
  const cutoff=Date.parse('2026-11-30T17:00:00.000Z');
  const oldCode=groomer.first_purchase_promo_code;
  const newCode=oldCode.replace('HV20-','HV15-');
  const before=validateFirstPurchasePromo(oldCode,'+79007771001',pointId,cutoff-1);
  assert.equal(before.valid,true);
  assert.equal(before.discountPercent,20);
  const early=validateFirstPurchasePromo(newCode,'+79007771002',pointId,cutoff-1);
  assert.equal(early.valid,true);
  assert.equal(early.discountPercent,15);
  assert.equal(early.partnerId,before.partnerId);
  assert.equal(early.promoCode,newCode);
  const old=validateFirstPurchasePromo(oldCode,'+79007771003',pointId,cutoff);
  const revised=validateFirstPurchasePromo(newCode,'+79007771004',pointId,cutoff);
  assert.equal(old.discountPercent,15);
  assert.equal(revised.discountPercent,15);
  assert.equal(old.partnerId,revised.partnerId);
  assert.equal(old.promoCode,oldCode);
  assert.equal(revised.promoCode,newCode);
  assert.match(old.notice,/старый промокод действует/i);
  const legacy=validateFirstPurchasePromo('HVOST20-TEST-LEGACY','+79007771005',pointId,cutoff);
  const legacyNew=validateFirstPurchasePromo('HVOST15-TEST-LEGACY','+79007771006',pointId,cutoff);
  assert.equal(legacy.valid,true);
  assert.equal(legacyNew.valid,true);
  assert.equal(legacy.discountPercent,15);
  assert.equal(legacyNew.discountPercent,15);
  assert.equal(legacyNew.partnerId,legacy.partnerId);
});
