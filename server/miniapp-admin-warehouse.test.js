'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-miniapp-admin-warehouse-'));
process.env.TOKEN_SECRET='miniapp-stock-isolated-token-secret';
const db=require('./db');
const {signToken}=require('./auth');
const {registerMiniAppAdminWarehouseRoutes}=require('./routes-miniapp-admin-warehouse');

const aCity='miniapp-warehouse-city',otherCity='miniapp-warehouse-other';
for(const id of [aCity,otherCity])db.prepare('INSERT INTO cities (id,name) VALUES (?,?)').run(id,id);
const product=Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES (?,?,?,?,?,?)'
).run('miniapp-warehouse-product','Лёгкое тестовое','treats','🐾','Проверка склада','[]').lastInsertRowid);
const variant=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES (?,?,?)'
).run(product,'50 г',250).lastInsertRowid);
const archived=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,active) VALUES (?,?,?,0)'
).run(product,'100 г',350).lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon,city_id) VALUES (?,?,?,?,?)')
  .run('miniapp-stock-point','БаркЛай тест','Адрес тест','🐾',aCity);
db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES (?,?,?)')
  .run(variant,'miniapp-stock-point',3);
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES (?,?,?,?,?)')
  .run(1009,'warehouse-active-admin','unused','admin',1);
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES (?,?,?,?,?)')
  .run(1010,'warehouse-disabled-admin','unused','admin',0);
const routes=new Map(),router={};
for(const method of ['get','post'])router[method]=(url,handler)=>routes.set(method.toUpperCase()+' '+url,handler);
registerMiniAppAdminWarehouseRoutes(router);
function call(method,url,role='admin',body={},query={},id=1009){
  const handler=routes.get(method+' '+url);
  assert.ok(handler,'Route missing: '+method+' '+url);
  const token=signToken({role,id,login:'warehouse-active-admin',adminRole:'admin'});
  const req={headers:{authorization:'Bearer '+token}};
  const res={status:0,data:null,writeHead(code){this.status=code;return this;},end(raw){this.data=JSON.parse(raw);}};
  handler(req,res,{body,query,params:{}});
  return res;
}
function reset(){
  db.exec('DELETE FROM stock_movement_items; DELETE FROM stock_movements;' +
    'DELETE FROM order_items; DELETE FROM orders;' +
    'DELETE FROM warehouse_receipts; DELETE FROM warehouse_stock_adjustments;');
  db.prepare('DELETE FROM warehouse_stock WHERE city_id IN (?,?)').run(aCity,otherCity);
  db.prepare('INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES (?,?,?)').run(aCity,variant,25);
  db.prepare('INSERT INTO warehouse_stock(city_id,variant_id,qty) VALUES (?,?,?)').run(otherCity,variant,7);
}
function adjust(body={},role='admin',id=1009){
  return call('POST','/api/miniapp/admin/warehouse/adjust',role,{
    city_id:aCity,variant_id:variant,action:'add',expected_qty:25,qty:5,
    reason:'Поставка по накладной 123',...body,
  },{},id);
}
function qty(city=aCity){return db.prepare(
  'SELECT qty FROM warehouse_stock WHERE city_id=? AND variant_id=?'
).get(city,variant)?.qty;}

test('warehouse listing shows real active variants, city stock and archived existing rows',()=>{
  reset();
  const res=call('GET','/api/miniapp/admin/warehouse','admin',{}, {city:aCity});
  assert.equal(res.status,200);
  assert.equal(res.data.city_id,aCity);
  assert.ok(res.data.cities.some(x=>x.id===otherCity));
  assert.equal(res.data.items.find(x=>x.variant_id===variant).qty,25);
  assert.equal(res.data.items.find(x=>x.variant_id===archived),undefined);
  const second=call('GET','/api/miniapp/admin/warehouse','admin',{}, {city:otherCity});
  assert.equal(second.data.items.find(x=>x.variant_id===variant).qty,7);
});

test('only an active administrator may read or change central warehouse',()=>{
  reset();
  for(const role of ['customer','partner','manager','owner','founder','warehouse']){
    assert.notEqual(call('GET','/api/miniapp/admin/warehouse',role,{}, {city:aCity}).status,200);
    assert.notEqual(adjust({},role).status,200);
  }
  assert.equal(call('GET','/api/miniapp/admin/warehouse','admin',{}, {city:aCity},1010).status,401);
  assert.equal(adjust({},'admin',1010).status,401);
  assert.equal(qty(),25);
});

test('adding stock is atomic, audited, and never changes salon or other-city stock',()=>{
  reset();
  const res=adjust();
  assert.equal(res.status,200);
  assert.equal(res.data.old_qty,25);
  assert.equal(res.data.new_qty,30);
  assert.equal(qty(),30);
  assert.equal(qty(otherCity),7);
  assert.equal(db.prepare('SELECT qty FROM stock WHERE variant_id=? AND point_id=?')
    .get(variant,'miniapp-stock-point').qty,3);
  const receipt=db.prepare('SELECT * FROM warehouse_receipts ORDER BY id DESC LIMIT 1').get();
  assert.equal(receipt.qty,5);
  assert.equal(receipt.city_id,aCity);
  assert.equal(receipt.supplier_note,'Поставка по накладной 123');
  const log=db.prepare('SELECT * FROM warehouse_stock_adjustments ORDER BY id DESC LIMIT 1').get();
  assert.equal(log.action,'increase');
  assert.equal(log.admin_id,1009);
  assert.equal(log.old_qty,25);
  assert.equal(log.new_qty,30);
  assert.equal(log.reason,'Поставка по накладной 123');
});

test('rejects negative, stale, fractional, archived and cross-city invalid edits',()=>{
  reset();
  for(const bad of [
    {expected_qty:24},{qty:-1},{qty:0},{qty:1.5},{qty:'5'},
    {variant_id:'1'},{reason:'нет'},{reason:'x'.repeat(501)},
    {city_id:'imaginary-city'},{action:'unknown'},{expected_qty:-2},
  ]){
    const res=adjust(bad);
    assert.ok([400,409].includes(res.status),JSON.stringify(bad)+': '+res.status);
  }
  assert.equal(adjust({variant_id:archived,expected_qty:0}).status,409);
  assert.equal(qty(),25);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouse_receipts').get().n,0);
});

test('part-stock removal respects reserved manager transfers and never goes below zero',()=>{
  reset();
  assert.equal(adjust({action:'decrease',qty:26}).status,409);
  const m=Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id) VALUES (?,?,?,?,?,?)'
  ).run('MINIAPP-WH-TEST','warehouse-moving-manager','x','Менеджер','79990000001',aCity).lastInsertRowid);
  const movement=Number(db.prepare(
    'INSERT INTO stock_movements(manager_id,point_id,city_id) VALUES (?,?,?)'
  ).run(m,'miniapp-stock-point',aCity).lastInsertRowid);
  db.prepare('INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES (?,?,?)')
    .run(movement,variant,22);
  const blocked=adjust({action:'decrease',qty:5});
  assert.equal(blocked.status,409);
  assert.equal(blocked.data.reserved_qty,22);
  db.prepare("UPDATE stock_movements SET status='rejected' WHERE id=?").run(movement);
  assert.equal(adjust({action:'decrease',qty:5}).status,200);
  assert.equal(qty(),20);
  assert.equal(db.prepare("SELECT action FROM warehouse_stock_adjustments ORDER BY id DESC LIMIT 1").get().action,'decrease');
});

test('deleting a warehouse row requires confirmation and preserves catalog and salon stock',()=>{
  reset();
  assert.equal(adjust({action:'delete',qty:null}).status,400);
  const done=adjust({action:'delete',qty:null,confirmed:true,reason:'Товар убран со склада по инвентаризации'});
  assert.equal(done.status,200);
  assert.equal(qty(),undefined);
  assert.equal(qty(otherCity),7);
  assert.ok(db.prepare('SELECT id FROM product_variants WHERE id=?').get(variant));
  assert.equal(db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?')
    .get('miniapp-stock-point',variant).qty,3);
  const log=db.prepare("SELECT * FROM warehouse_stock_adjustments WHERE action='delete' ORDER BY id DESC LIMIT 1").get();
  assert.equal(log.old_qty,25);
  assert.equal(log.new_qty,null);
});

test('failed audit writes roll back inventory and receipt changes',()=>{
  reset();
  db.exec("CREATE TRIGGER miniapp_wh_fail BEFORE INSERT ON warehouse_stock_adjustments " +
    "BEGIN SELECT RAISE(ABORT,'test fail'); END");
  try{
    const result=adjust();
    assert.equal(result.status,500);
    assert.equal(qty(),25);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouse_receipts').get().n,0);
  }finally{db.exec('DROP TRIGGER miniapp_wh_fail');}
});
