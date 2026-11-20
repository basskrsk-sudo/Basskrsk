'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Database state is intentionally isolated from all production/customer data.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-first-purchase-unpaid-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const promo = require('./first-purchase-promo');
const { releaseOrderReservation, releaseOrderReservationInTransaction, withImmediateTransaction } = require('./reservations');
const point = 'unpaid-claim-test-point';
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run(point, 'Салон', 'Тестовая улица', '🐾');
const code = db.prepare('SELECT first_purchase_promo_code AS code FROM points WHERE id=?').get(point).code;
assert.ok(code);
const now = Date.parse('2026-11-20T12:00:00Z');
let sequence = 0;
function createOrder(phone, { status='pending', reservation='active' } = {}) {
  const result = db.prepare(
    "INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id," +
    "subtotal,total,payment_method,status,reservation_status,reservation_expires_at," +
    "inventory_source_type,inventory_source_id) " +
    "VALUES(?,'Клиент',?,'Тестовый салон',?,250,200,'yookassa',?,?," +
    "datetime('now','+1 minute'),'point',?)"
  ).run('UNPAID-PROMO-TEST-'+(++sequence),phone,point,status,reservation,point);
  return Number(result.lastInsertRowid);
}
function check(phone) {
  return promo.validateFirstPurchasePromo(code,phone,point,now);
}
function claim(phone, orderId) {
  const validation = check(phone);
  assert.equal(validation.valid,true,validation.error);
  promo.claimFirstPurchasePromo(validation,orderId);
}
function claimCount(orderId) {
  return db.prepare('SELECT COUNT(*) AS count FROM first_purchase_point_promo_claims WHERE order_id=?')
    .get(orderId).count;
}
test('unpaid pending attempt temporarily holds the discount and blocks another claim',()=>{
  const phone='+7 (908) 000-00-01';
  const id=createOrder(phone);
  claim(phone,id);
  assert.equal(claimCount(id),1);
  assert.equal(check('89080000001').valid,false);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(id).status,'pending');
});
test('canceled payment releases stock and the first-purchase discount atomically',()=>{
  const phone='89080000002';
  const id=createOrder(phone);
  claim(phone,id);
  assert.equal(check(phone).valid,false);
  const result=releaseOrderReservation(id,'failed','ЮKassa подтвердила отмену');
  assert.equal(result.released,true);
  assert.equal(claimCount(id),0);
  assert.equal(check('+79080000002').valid,true);
  assert.equal(releaseOrderReservation(id,'failed').released,false);
});
test('admin release with unchanged pending status also returns discount',()=>{
  const phone='+79080000003';
  const id=createOrder(phone);
  claim(phone,id);
  const result=withImmediateTransaction(() =>
    releaseOrderReservationInTransaction(id,null,'Админ высвободил остаток')
  );
  assert.equal(result.released,true);
  assert.equal(db.prepare('SELECT status,reservation_status FROM orders WHERE id=?')
    .get(id).status,'pending');
  assert.equal(claimCount(id),0);
  assert.equal(check(phone).valid,true);
});
test('stale promo claims left by previous deployments are self-healed',()=>{
  const phone='+79080000004';
  const id=createOrder(phone);
  claim(phone,id);
  db.prepare("UPDATE orders SET status='failed', reservation_status='released' WHERE id=?").run(id);
  assert.equal(claimCount(id),1);
  assert.equal(check(phone).valid,true);
  assert.equal(claimCount(id),0);
});
test('successful payment blocks all future first-purchase discounts',()=>{
  const phone='79080000005';
  const id=createOrder(phone);
  claim(phone,id);
  db.prepare("UPDATE orders SET status='paid', reservation_status='consumed' WHERE id=?").run(id);
  assert.equal(check('+7 (908) 000-00-05').valid,false);
  assert.equal(releaseOrderReservation(id,'failed').released,false);
  assert.equal(claimCount(id),1,'paid claim stays consumed');
});
test('a non-discounted unpaid order never consumes first purchase',()=>{
  const phone='89080000006';
  createOrder(phone);
  assert.equal(check(phone).valid,true);
});
test.after(()=>{
  try { db.close(); } catch (_) {}
  fs.rmSync(directory,{force:true,recursive:true});
});
