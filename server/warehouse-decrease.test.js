'use strict';

// Real SQLite integration checks for administrative warehouse inventory fixes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-warehouse-decrease-'));
process.env.DATA_DIR = temp;
const db = require('./db');
const { signToken } = require('./auth');
const { registerWarehouseRoutes } = require('./routes-warehouse');
const { registerAuditRoutes } = require('./routes-audit');

const cityId = 'decrease-test-city';
db.prepare('INSERT INTO cities(id,name) VALUES (?,?)').run(cityId,'Тестовый город');
const productId = db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES (?,?,?,?,?,?)'
).run('warehouse-test-product','Тестовая печень','treats','🐾','Тестовое описание','[]').lastInsertRowid;
const variantId = Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES (?,?,?)'
).run(productId,'50 г',250).lastInsertRowid);
db.prepare('INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES (?,?,?)')
  .run(cityId,variantId,25);
const pointId='warehouse-test-point';
db.prepare('INSERT INTO points(id,name,addr,icon,city_id) VALUES (?,?,?,?,?)')
  .run(pointId,'Тестовая точка','Тестовый адрес','🐾',cityId);
db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES (?,?,?)')
  .run(variantId,pointId,3);
const routeMap = new Map();
const router = {};
for (const verb of ['get','post','put','delete']) {
  router[verb] = (endpoint,handler) => routeMap.set(verb.toUpperCase()+' '+endpoint,handler);
}
registerWarehouseRoutes(router);
registerAuditRoutes(router);

function call(verb, endpoint, role, body = {}, query = {}) {
  const handler = routeMap.get(verb+' '+endpoint);
  assert.equal(typeof handler,'function','missing '+verb+' '+endpoint);
  const token = signToken({
    role, id: 9, login: role+'-warehouse-tester',
    ...(role==='super' ? {adminRole:'super'} : {}),
  });
  const req = { headers: { authorization:'Bearer '+token } };
  const res = {
    status:null, payload:null,
    writeHead(status) { this.status = status; return this; },
    end(raw) { this.payload = JSON.parse(raw); },
  };
  // All tested routes are synchronous; no external network.
  handler(req,res,{body,query,params:{}});
  return res;
}
const decrease = (role,extra = {}) => call(
  'POST','/api/warehouse/stock/decrease',role, {
    city_id:cityId,variant_id:variantId,
    expected_qty:25,new_qty:20,
    reason:'Ошибка при оприходовании, внесено 25 вместо 20',
    ...extra,
  }
);
const stock = () => db.prepare(
  'SELECT qty FROM warehouse_stock WHERE city_id=? AND variant_id=?'
).get(cityId,variantId)?.qty;
const audits = () => db.prepare(
  "SELECT * FROM warehouse_stock_adjustments WHERE action='decrease' ORDER BY id"
).all();

test('only administrator accounts can lower stock', () => {
  assert.equal(decrease('manager').status,401);
  assert.equal(decrease('warehouse').status,401);
  assert.equal(stock(),25);
  assert.equal(audits().length,0);
});

test('validation rejects negative stock, invalid expected value, no reason and raising values', () => {
  for (const input of [
    {new_qty:-1},{new_qty:1.5},{new_qty:25},{new_qty:30},
    {expected_qty:0},{expected_qty:25.5},{new_qty:'19'},
    {reason:'ошибка'},{reason:null},{reason:'x'.repeat(501)},
    {city_id:null},{variant_id:0},
  ]) {
    const result = decrease('admin',input);
    assert.equal(result.status,400,JSON.stringify(input)+' -> '+JSON.stringify(result.payload));
  }
  assert.equal(stock(),25);
  assert.equal(audits().length,0);
});

test('stale starting quantity is refused without modifying the stock', () => {
  const result = decrease('admin',{expected_qty:24,new_qty:20});
  assert.equal(result.status,409);
  assert.equal(result.payload.current_qty,25);
  assert.equal(stock(),25);
});

test('pending placement reports prevent reduction below their requested stock', () => {
  const managerId = db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id) VALUES (?,?,?,?,?,?)'
  ).run('MGR-TEST-WAREHOUSE','warehouse-test-manager','hash','Тестовый менеджер','79990000001',cityId).lastInsertRowid;
  const movementId = db.prepare(
    'INSERT INTO stock_movements(manager_id,point_id,city_id) VALUES (?,?,?)'
  ).run(managerId,pointId,cityId).lastInsertRowid;
  db.prepare(
    'INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES (?,?,?)'
  ).run(movementId,variantId,22);
  const blocked = decrease('admin');
  assert.equal(blocked.status,409);
  assert.equal(blocked.payload.pending_qty,22);
  assert.equal(stock(),25);
  assert.equal(audits().length,0);
  db.prepare("UPDATE stock_movements SET status='rejected' WHERE id=?").run(movementId);
});

test('successful correction keeps the product, shop stock and receipt history intact', () => {
  const beforeReceipts = db.prepare('SELECT COUNT(*) AS cnt FROM warehouse_receipts').get().cnt;
  const beforePoint = db.prepare('SELECT qty FROM stock WHERE variant_id=? AND point_id=?')
    .get(variantId,pointId).qty;
  const response = decrease('admin');
  assert.equal(response.status,200);
  assert.equal(response.payload.decreased_by,5);
  assert.equal(stock(),20);
  assert.equal(audits().length,1);
  assert.equal(audits()[0].action,'decrease');
  assert.equal(audits()[0].old_qty,25);
  assert.equal(audits()[0].new_qty,20);
  assert.equal(audits()[0].city_id,cityId);
  assert.equal(audits()[0].product_name,'Тестовая печень');
  assert.equal(audits()[0].weight,'50 г');
  assert.equal(audits()[0].admin_login,'admin-warehouse-tester');
  assert.match(audits()[0].reason,/Ошибка при оприходовании/);
  assert.equal(db.prepare('SELECT COUNT(*) AS cnt FROM warehouse_receipts').get().cnt,beforeReceipts);
  assert.equal(db.prepare('SELECT qty FROM stock WHERE variant_id=? AND point_id=?')
    .get(variantId,pointId).qty,beforePoint);
});

test('legacy PUT cannot silently decrease the warehouse quantity', () => {
  for (const role of ['admin','warehouse']) {
    const result = call('PUT','/api/warehouse/stock',role,
      { city_id:cityId,variant_id:variantId,qty:10 });
    assert.equal(result.status,409);
    assert.equal(result.payload.current_qty,20);
    assert.equal(stock(),20);
  }
  assert.equal(audits().length,1);
});

test('a second correction can reduce the row to zero without deleting it', () => {
  const result=decrease('admin',{
    expected_qty:20,new_qty:0,reason:'Повторная инвентаризация: исправлена ошибочная запись',
  });
  assert.equal(result.status,200);
  assert.equal(stock(),0);
  assert.equal(audits().length,2);
  const saved = db.prepare(
    'SELECT COUNT(*) AS n FROM warehouse_stock WHERE city_id=? AND variant_id=?'
  ).get(cityId,variantId);
  assert.equal(saved.n,1);
});

test('super-admin audit can filter inventory decreases and display before/after quantities', () => {
  const denied=call('GET','/api/admin/audit-log','admin',{},{
    type:'warehouse_decrease',limit:'50',
  });
  assert.equal(denied.status,403);
  const response = call('GET','/api/admin/audit-log','super',{},{
    type:'warehouse_decrease',limit:'50',
  });
  assert.equal(response.status,200);
  const changes=response.payload.events;
  assert.equal(changes.length,2);
  for (const change of changes) {
    assert.equal(change.type,'warehouse_decrease');
    assert.equal(change.product_name,'Тестовая печень');
    assert.equal(change.city_id,cityId);
  }
});

test('audit insertion failure rolls back the quantity change', () => {
  db.prepare('UPDATE warehouse_stock SET qty=10 WHERE city_id=? AND variant_id=?')
    .run(cityId,variantId);
  db.exec(`
    CREATE TRIGGER test_fail_warehouse_audit
    BEFORE INSERT ON warehouse_stock_adjustments
    BEGIN SELECT RAISE(ABORT, 'simulated audit error'); END;
  `);
  try {
    const result=decrease('admin',{
      expected_qty:10,new_qty:8,reason:'Исправление должно откатиться при ошибке журнала',
    });
    assert.equal(result.status,500);
    assert.equal(stock(),10);
    assert.equal(audits().length,2);
  } finally {
    db.exec('DROP TRIGGER test_fail_warehouse_audit');
  }
});

test.after(()=>{
  try { db.close(); } catch (_) {}
  fs.rmSync(temp,{recursive:true,force:true});
});
