'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'order-recovery-test-'));
process.env.TOKEN_SECRET = 'isolated-recovery-test-token-secret';
const db = require('./db');
const { initializeRecovery, recoverOrder, verifyRecoveryPayment } = require('./order-recovery');
initializeRecovery(db);
const paymentId = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const admin = { id:1, login:'recovery-admin' };
function fixture(overrides = {}, paymentOverrides = {}) {
  db.exec(`DELETE FROM bone_transactions; DELETE FROM order_recovery_log; DELETE FROM order_items; DELETE FROM orders;
    DELETE FROM stock; DELETE FROM product_variants; DELETE FROM products; DELETE FROM customers;
    DELETE FROM partners; DELETE FROM points;
    INSERT INTO products(id, slug, name, category, icon, desc, comp) VALUES(1,'lung','Лёгкое','treats','x','x','[]');
    INSERT INTO product_variants(id,product_id,weight,price) VALUES(1,1,'50 г',999);
    INSERT INTO points(id,name,addr,icon) VALUES('barklay','БаркЛай','Молокова 40','x');
    INSERT INTO stock VALUES(1,'barklay',5);`);
  const body = { payment_id:paymentId, order_code:'TG-RESTORE-TEST', created_at:'2026-10-08T14:08:13+03:00',
    customer_phone:'+79990000001', customer_name:'Клиент', point_id:'barklay', partner_id:null,
    commission_percent:0, is_self_order:false, total:250, discount:0, bones_used:0, bones_earned:0,
    adjust_bones:false, inventory_mode:'deduct', reason:'Восстановление после сбоя', items:[{variant_id:1, price:250, qty:1}], ...overrides };
  const payment = { id:paymentId, status:'succeeded', paid:true, test:false,
    amount:{value:'250.00', currency:'RUB'}, metadata:{order_code:body.order_code}, ...paymentOverrides };
  return { body, gateway:{ isConfigured:() => true, getPayment:async () => payment } };
}
test('restores historical price/date, customer and stock with an audit record', async () => {
  const {body,gateway} = fixture();
  const result = await recoverOrder(db,gateway,body,admin);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(result.id);
  assert.equal(order.created_at,'2026-10-08 11:08:13');
  assert.equal(order.status,'paid'); assert.equal(order.total,250);
  assert.equal(db.prepare('SELECT price FROM order_items').get().price,250);
  assert.equal(db.prepare('SELECT qty FROM stock').get().qty,4);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.phone,'79990000001'); assert.equal(c.orders_count,1); assert.equal(c.last_order_at,order.created_at);
  assert.equal(db.prepare('SELECT admin_login FROM order_recovery_log').get().admin_login,admin.login);
});
test('retries and concurrent restores cannot duplicate the order, stock or customer counters', async () => {
  const {body,gateway} = fixture();
  const results = await Promise.allSettled([recoverOrder(db,gateway,body,admin),recoverOrder(db,gateway,body,admin)]);
  assert.equal(results.filter(r=>r.status === 'fulfilled').length,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
  assert.equal(db.prepare('SELECT qty FROM stock').get().qty,4);
  await assert.rejects(recoverOrder(db,gateway,body,admin), /уже/);
});
test('already accounted inventory is preserved and a later customer date is not overwritten', async () => {
  const {body,gateway} = fixture({inventory_mode:'already_accounted'});
  db.prepare("INSERT INTO customers(phone,orders_count,total_spent,first_order_at,last_order_at) VALUES(?,1,300,'2026-10-09 09:00:00','2026-10-09 09:00:00')").run('79990000001');
  await recoverOrder(db,gateway,body,admin);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.last_order_at,'2026-10-09 09:00:00'); assert.equal(c.first_order_at,'2026-10-08 11:08:13');
  assert.equal(c.total_spent,550); assert.equal(db.prepare('SELECT qty FROM stock').get().qty,5);
});
test('payment failure, test mode, refund, amount and metadata mismatches leave no writes', async () => {
  for (const override of [{status:'pending'},{paid:false},{test:true},{refunded_amount:{value:'1.00'}},{amount:{value:'251.00',currency:'RUB'}},{metadata:{order_code:'OTHER'}}]) {
    const {body,gateway} = fixture({},override);
    await assert.rejects(recoverOrder(db,gateway,body,admin));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
    assert.equal(db.prepare('SELECT qty FROM stock').get().qty,5);
  }
});
test('insufficient stock rolls back the order, all items, customer and audit', async () => {
  const {body,gateway} = fixture(); db.exec('UPDATE stock SET qty=0');
  await assert.rejects(recoverOrder(db,gateway,body,admin), /Недостаточно остатка/);
  for (const table of ['orders','order_items','customers','order_recovery_log']) assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
});
test('invalid calendar date, totals and duplicated variants are rejected', async () => {
  for (const override of [{created_at:'2026-02-30T14:00:00+03:00'},{discount:1},{items:[{variant_id:1,price:125,qty:1},{variant_id:1,price:125,qty:1}]},{inventory_mode:''}]) {
    const {body,gateway} = fixture(override); await assert.rejects(recoverOrder(db,gateway,body,admin));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  }
});
test('explicit historical bones change the balance and ledger once; insufficient balance rolls back', async () => {
  let f = fixture({bones_earned:10,adjust_bones:true});
  await recoverOrder(db,f.gateway,f.body,admin);
  assert.equal(db.prepare('SELECT bones_balance FROM customers').get().bones_balance,10);
  assert.equal(db.prepare('SELECT amount FROM bone_transactions').get().amount,10);
  f = fixture({bones_used:20,adjust_bones:true,items:[{variant_id:1,price:270,qty:1}]});
  await assert.rejects(recoverOrder(db,f.gateway,f.body,admin), /Недостаточно косточек/);
  assert.equal(db.prepare('SELECT qty FROM stock').get().qty,5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n,0);
});
test('payment lookup rejects unconfigured gateways and malformed ids', async () => {
  const {gateway}=fixture(); await assert.rejects(verifyRecoveryPayment(db,gateway,'../payments'), /ID платежа/);
  await assert.rejects(verifyRecoveryPayment(db,{...gateway,isConfigured:()=>false},paymentId), /не настроена/);
});
test('Telegram time in Krasnoyarsk is converted to UTC without a four-hour shift', async () => {
  const {body,gateway} = fixture({created_at:'2026-10-08T14:08:13+07:00'});
  await recoverOrder(db,gateway,body,admin);
  assert.equal(db.prepare('SELECT created_at FROM orders').get().created_at,'2026-10-08 07:08:13');
});
test('recovery log prevents reimport even if the order was later deleted', async () => {
  const {body,gateway}=fixture(); await recoverOrder(db,gateway,body,admin);
  db.exec('DELETE FROM order_items; DELETE FROM orders');
  await assert.rejects(recoverOrder(db,gateway,body,admin), /уже/);
});
test('historical partner commission is preserved rather than taking the current tariff', async () => {
  const {body,gateway} = fixture({partner_id:1,commission_percent:15});
  db.exec("INSERT INTO partners(id,partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES(1,'GR-1','groomer','unused','Грумер','79999999999','barklay','БаркЛай',0.25)");
  await recoverOrder(db,gateway,body,admin);
  const order = db.prepare('SELECT * FROM orders').get();
  assert.equal(order.partner_id,1); assert.equal(order.commission_rate,0.15);
  assert.equal(order.partner_name,'Грумер');
});
test('ordinary admins and unauthenticated callers cannot check, restore or read the recovery log', async () => {
  fixture();
  const { Router } = require('./http-utils');
  const { signToken } = require('./auth');
  const router = new Router();
  require('./routes-orders').registerOrderRoutes(router);
  for (const token of [null,signToken({role:'admin',adminRole:'admin',id:2})]) {
    for (const [method,url] of [['POST','/api/orders/recovery/check'],['POST','/api/orders/recovery'],['GET','/api/orders/recovery-log']]) {
      const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      await router.match(method,url).handler({headers:token ? {authorization:'Bearer '+token} : {}},response,{body:{},query:{},params:{}});
      assert.equal(response.status,token ? 403 : 401);
    }
  }
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await router.match('GET','/api/orders/recovery-log').handler({headers:{authorization:'Bearer '+signToken({role:'admin',adminRole:'super',id:1})}},response,{query:{}});
  assert.equal(response.status,200); assert.deepEqual(JSON.parse(response.body).entries,[]);
});
