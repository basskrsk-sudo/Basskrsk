'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
// Older Amvera overrides must not silently restore the 15-minute policy.
process.env.RESERVATION_TTL_MINUTES='15';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-one-minute-stock-'));
process.env.DATA_DIR=directory;
const db=require('./db');
const {
  RESERVATION_TTL_MINUTES,newReservationExpiry,withImmediateTransaction,
  reserveForOrder,releaseOrderReservation,consumeOrderReservation,
} = require('./reservations');

db.prepare('INSERT INTO products(id,slug,name,category,icon,desc,comp,active) VALUES (1,?,?,?,?,?,?,1)')
  .run('reservation-1m-lung','Лёгкое','treats','🐾','Лакомство','[]');
db.prepare('INSERT INTO product_variants(id,product_id,weight,price) VALUES(1,1,?,?)')
  .run('50 г',250);
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)')
  .run('reservation-1m-point','Салон Тест','Красноярск','🐾');
db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES(1,?,2)')
  .run('reservation-1m-point');

let seq=0;
function createReservedOrder() {
  return withImmediateTransaction(()=>{
    const info=db.prepare(
      "INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,"+
      "status,reservation_status,reservation_expires_at,inventory_source_type,inventory_source_id) "+
      "VALUES(?,?,?,?,?,?,?,?,'pending','active',?,'point',?)"
    ).run('ORDER-ONE-MIN-'+(++seq),'Клиент','79139990001',
      'Салон Тест','reservation-1m-point',250,250,'sbp',
      newReservationExpiry(),'reservation-1m-point');
    const id=Number(info.lastInsertRowid);
    db.prepare('INSERT INTO order_items(order_id,variant_id,name,weight,price,qty,is_custom) VALUES(?,?,?,?,?,?,0)')
      .run(id,1,'Лёгкое','50 г',250,1);
    reserveForOrder(id,{type:'point',id:'reservation-1m-point'},[
      {variantId:1,name:'Лёгкое',weight:'50 г',price:250,qty:1}
    ],null,0);
    return id;
  });
}
function qty(){
  return db.prepare('SELECT qty FROM stock WHERE variant_id=1 AND point_id=?')
    .get('reservation-1m-point').qty;
}
test('exactly one-minute reserve regardless of legacy production override',()=>{
  assert.equal(RESERVATION_TTL_MINUTES,1);
  const now=Date.now();
  const end=Date.parse(newReservationExpiry().replace(' ','T')+'Z');
  assert.ok(end-now>58000&&end-now<=60000,
    'expires in one minute (SQLite has one-second precision)');
});
test('confirmed canceled payment releases stock exactly once',()=>{
  const id=createReservedOrder();
  assert.equal(qty(),1);
  const result=releaseOrderReservation(id,'failed','YooKassa canceled payment');
  assert.equal(result.released,true);
  assert.equal(qty(),2);
  const order=db.prepare('SELECT status,reservation_status FROM orders WHERE id=?').get(id);
  assert.deepEqual({...order},{status:'failed',reservation_status:'released'});
  assert.equal(releaseOrderReservation(id).released,false);
  assert.equal(qty(),2,'no double stock restoration');
});
test('paid order consumes stock rather than releasing it',()=>{
  const id=createReservedOrder();
  assert.equal(qty(),1);
  assert.equal(consumeOrderReservation(id).consumed,true);
  assert.equal(qty(),1);
  const row=db.prepare('SELECT status,reservation_status FROM orders WHERE id=?').get(id);
  assert.deepEqual({...row},{status:'paid',reservation_status:'consumed'});
  assert.equal(releaseOrderReservation(id).released,false,'paid stock stays sold');
  assert.equal(qty(),1);
});
test.after(()=>{
  try{db.close()}catch(_){}
  fs.rmSync(directory,{force:true,recursive:true});
});
