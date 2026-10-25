'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-no-groomer-'));
process.env.DATA_DIR = tmp;
const db = require('./db');
const report = require('./no-groomer-report');
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('a', 'БаркЛай', 'Молокова 40', '🐾');
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('b', 'Зверюга', 'Вторая улица', '🐾');
db.prepare("INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name) VALUES (?,?,?,?,?,?,?)")
  .run('G-TEST','groomer-test','hash','Грумер Мария','79991234567','a','БаркЛай');
const partnerId = db.prepare("SELECT id FROM partners WHERE partner_code='G-TEST'").get().id;

function insertOrder(code,options={}){
  const data={
    status:'paid', pointId:'a', partnerId:null, partnerName:null,
    rate:null, createdAt:'2026-10-24 12:00:00', total:250,
    refundStatus:'none', refundedAmount:0,
    fulfillment:'pickup',...options,
  };
  const res=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,' +
    'partner_id,partner_name,subtotal,total,payment_method,status,commission_rate,' +
    'refund_status,refunded_amount,fulfillment_type,created_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code,'Тестовый клиент','79990000000',data.pointId==='a'?'БаркЛай':'Зверюга',
    data.pointId,data.partnerId,data.partnerName,data.total,data.total,'sbp',data.status,
    data.rate,data.refundStatus,data.refundedAmount,data.fulfillment,data.createdAt);
  return Number(res.lastInsertRowid);
}
const self=insertOrder('SELF', {rate:0,total:250,createdAt:'2026-10-24 10:00:00'});
const unknown=insertOrder('UNKNOWN',{total:500,pointId:'b',createdAt:'2026-10-23 09:00:00'});
const legacy=insertOrder('LEGACY',{rate:0.2,total:300,createdAt:'2026-10-22 08:00:00'});
const partial=insertOrder('PARTIAL',{rate:0,total:400,refundedAmount:150,
  refundStatus:'partial',createdAt:'2026-10-24 11:00:00'});
const delivery=insertOrder('DELIVERY',{fulfillment:'home_delivery',pointId:'b',total:120});
insertOrder('FULLY-REFUNDED',{total:400,refundStatus:'refunded',refundedAmount:400});
insertOrder('PENDING',{status:'pending',total:500});
insertOrder('ASSIGNED',{partnerId,partnerName:'Грумер Мария',rate:0.2,total:600});
insertOrder('NAME-ONLY',{partnerName:'Грумер Мария',rate:0.2,total:700});
insertOrder('OLD',{rate:0,total:800,createdAt:'2026-09-15 08:00:00'});
const addItem=db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES (?,?,?,?,?)');
addItem.run(self,'Лёгкое говяжье','50 г',250,1);
addItem.run(unknown,'Кроличья лапка','5 шт.',250,2);
addItem.run(legacy,'Бычий корень','50 г',300,1);
addItem.run(partial,'Лёгкое говяжье','50 г',200,2);

test('all-time paid orders without a groomer are correctly grouped',()=>{
  const result=report.collectNoGroomerReport(undefined,new Date('2026-10-25T12:00:00Z'));
  assert.equal(result.count,6);
  assert.equal(result.self_count,3);
  assert.equal(result.unassigned_count,3);
  assert.equal(result.rate_without_partner,1);
  assert.equal(result.revenue,250+500+300+250+120+800);
  assert.deepEqual(result.orders.map(o=>o.code).sort(),
    ['SELF','UNKNOWN','LEGACY','PARTIAL','DELIVERY','OLD'].sort());
  assert.equal(result.orders.find(o=>o.code==='UNKNOWN').reason,'Не выбран');
  assert.equal(result.orders.find(o=>o.code==='SELF').reason,'Выбрал сам');
  assert.equal(result.orders.find(o=>o.code==='LEGACY').reason,'Не выбран');
  assert.equal(result.orders.find(o=>o.code==='PARTIAL').net,250);
  assert.ok(result.orders.find(o=>o.code==='DELIVERY').is_delivery);
  assert.equal(result.orders.find(o=>o.code==='UNKNOWN').products,'Кроличья лапка (5 шт.) ×2');
});
test('seven-day and thirty-day filters retain accurate counts',()=>{
  const now=new Date('2026-10-25T12:00:00Z');
  const seven=report.collectNoGroomerReport(7,now);
  const thirty=report.collectNoGroomerReport(30,now);
  assert.equal(seven.count,5);
  assert.equal(thirty.count,5);
  assert.equal(seven.self_count,2);
  assert.equal(seven.unassigned_count,3);
  assert.throws(()=>report.collectNoGroomerReport(9,now),/Укажите/);
});
test('CSV has products, totals and reasons, but no customer phone',()=>{
  const value=report.collectNoGroomerReport(undefined,new Date('2026-10-25T12:00:00Z'));
  const csv=report.buildNoGroomerCsv(value);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv,/Кроличья лапка/);
  assert.match(csv,/Не выбран/);
  assert.match(csv,/Выбрал сам/);
  assert.match(csv,/БаркЛай/);
  assert.match(csv,/250/);
  assert.doesNotMatch(csv,/79990000000/);
  const text=report.formatNoGroomerReport(value);
  assert.match(text,/оплаченные заказы без грумера/);
  assert.match(text,/Заказов с ненулевой ставкой/);
});
test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(tmp,{recursive:true,force:true});
});
