'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-checkout-partner-index-'));
process.env.DATA_DIR=directory;
const db=require('./db');
const { findSelfOrderingPartner, resolveOrderCommission }=require('./routes-payment');

let sequence=0;
function point(name) {
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)')
    .run(name,name,'Красноярск','🐾');
  return name;
}
function partner(pointId,phone,rate=0.15,active=1) {
  sequence++;
  const code='CHECKOUT-PART-'+sequence;
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,active,commission_rate)'+
    ' VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(code,code,'hash','Грумер '+sequence,phone,pointId,pointId,active,rate).lastInsertRowid);
}

test('self-order lookup uses the groomer phone index and only loads one matching person',()=>{
  const a=point('checkout-phone-a');
  const b=point('checkout-phone-b');
  const chosen=partner(a,'+7 😸 (913)\t555.00/01',0.20);
  partner(a,'8(923)555-00-02',0.15);
  partner(b,'8 (913) 555 00 01',0.30);

  const picked=findSelfOrderingPartner(a,'8 (913) 555-00-01');
  assert.equal(picked.id,chosen);
  assert.equal(picked.point_id,a);
  assert.equal(picked.commission_rate,0.20);
  assert.equal(findSelfOrderingPartner(b,'79135550001').point_id,b);
  assert.equal(findSelfOrderingPartner(a,'79235550002').phone,'8(923)555-00-02');
  assert.equal(findSelfOrderingPartner(a,'7'),null);
  assert.equal(findSelfOrderingPartner(null,'79135550001'),null);
  assert.equal(findSelfOrderingPartner(a,'79000000000'),null);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM partners '+
    'WHERE point_id=? AND active=1 AND phone_last10=? ORDER BY id LIMIT 1'
  ).all(a,'9135550001').map(x=>String(x.detail)).join('\n');
  assert.match(plan,/idx_partners_(?:phone_last10_active|point_active)/);
  assert.doesNotMatch(plan,/SCAN partners\b/);
});

test('inactive matching groomer cannot claim a self-order; phone updates are immediately reflected',()=>{
  const a=point('checkout-phone-inactive');
  const id=partner(a,'8(965)111-22-33',0.14,0);
  assert.equal(findSelfOrderingPartner(a,'79651112233'),null);
  db.prepare('UPDATE partners SET active=1 WHERE id=?').run(id);
  assert.equal(findSelfOrderingPartner(a,'79651112233').id,id);
  db.prepare('UPDATE partners SET phone=? WHERE id=?').run('8 916 000 11 22',id);
  assert.equal(findSelfOrderingPartner(a,'79651112233'),null);
  assert.equal(findSelfOrderingPartner(a,'79160001122').id,id);
});

test('multiple active identical groomer phones preserve first groomer attribution',()=>{
  const a=point('checkout-duplicate');
  const first=partner(a,'8 999 321 00 11',0.21);
  partner(a,'+7 (999) 321-00-11',0.19);
  const result=findSelfOrderingPartner(a,'79993210011');
  assert.equal(result.id,first);
});

test('commission remains unassigned with multiple groomers unless selected explicitly',()=>{
  const a=point('checkout-commission');
  const b=point('checkout-commission-none');
  assert.deepEqual(resolveOrderCommission(b,null,'79001110001',null),
    {rate:null,isSelfOrder:false});
  const first=partner(a,'8(900)111-00-01',0.12);
  assert.deepEqual(resolveOrderCommission(a,null,'79001110001',null),
    {rate:0.12,isSelfOrder:true});
  assert.deepEqual(resolveOrderCommission(a,null,'79001110009',null),
    {rate:0.12,isSelfOrder:false});
  assert.deepEqual(resolveOrderCommission(a,null,'79001110001','self'),
    {rate:0,isSelfOrder:false});
  partner(a,'8(900)111-00-09',0.18);
  partner(a,'8(900)111-00-10',0.25);
  assert.deepEqual(resolveOrderCommission(a,null,'79001110001',null),
    {rate:null,isSelfOrder:false});
  assert.deepEqual(resolveOrderCommission(a,first,'79001110001',null),
    {rate:0.12,isSelfOrder:true});
  assert.deepEqual(resolveOrderCommission(a,first,'79001110009',null),
    {rate:0.12,isSelfOrder:false});

  const plan=db.prepare(
    'EXPLAIN QUERY PLAN SELECT id FROM partners WHERE point_id=? AND active=1 LIMIT 2'
  ).all(a).map(x=>String(x.detail)).join('\n');
  assert.match(plan,/idx_partners_point_active/);
});

test('checkout and tier checks use bounded partner reads, with no full-salon loading',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes-payment.js'),'utf8');
  const self=source.split('function findSelfOrderingPartner(')[1]
    .split('async function checkPartnerTierForOrder')[0];
  assert.match(self,/selfOrderingPartnerQuery\.get\(pointId, phone\)/);
  assert.doesNotMatch(self,/\.all\(pointId\)\.find/);
  const commission=source.split('function resolveOrderCommission(')[1]
    .split('const selfOrderingPartnerQuery')[0];
  assert.match(commission,/WHERE point_id = \? AND active = 1 LIMIT 2/);
  const tier=source.split('async function checkPartnerTierForOrder(')[1]
    .split('function tryDecrementStock')[0];
  assert.match(tier,/WHERE point_id = \? AND active = 1 LIMIT 2/);
});

test('first purchase promo self-order keeps the discount but freezes zero groomer commission',()=>{
  const a=point('checkout-promo-self');
  const phone='+79135550123';
  const id=partner(a,phone,0.20);
  const other=partner(a,'+79135550124',0.15);
  const { validateFirstPurchasePromo }=require('./first-purchase-promo');
  const { resolveCheckoutGroomer }=require('./auto-groomer');
  const { getUnpaidSummary, getUnpaidOrders }=require('./partner-payouts');
  const { buildCustomerMessage, buildPartnerMessage }=require('./order-notifications');
  const { buildOrderMessage }=require('./telegram');
  const before=Date.parse('2026-11-24T06:00:00Z');
  const after=Date.parse('2026-12-01T06:00:00Z');
  const picked=resolveCheckoutGroomer({pointId:a,partnerId:other,advisorSelection:'self',
    selfOrderingPartner:findSelfOrderingPartner(a,phone),fulfillmentType:'pickup'});
  assert.equal(picked.id,id,'self-order identity takes precedence over other groomers');
  for(const [code,now,expected] of [['HV20',before,20],['HV15',before,15],['HV20',after,15],
      ['HV15',after,15],['HV20-G-'+String(id).padStart(3,'0'),before,20]]){
    const promo=validateFirstPurchasePromo(code,phone,a,now);
    assert.equal(promo.valid,true);
    assert.equal(promo.discountPercent,expected);
    assert.deepEqual(resolveOrderCommission(a,picked.id,phone,'self',promo.valid),{rate:0,isSelfOrder:true});
    assert.deepEqual(resolveOrderCommission(a,id,'+79135550999',null,promo.valid),{rate:0.20,isSelfOrder:false});
  }
  assert.deepEqual(resolveOrderCommission(a,id,phone,null,false),{rate:0.20,isSelfOrder:true});
  const insert=db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,discount,total,promo_code,payment_method,commission_rate,is_partner_self_order,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const rate=resolveOrderCommission(a,id,phone,null,true).rate;
  const orderId=Number(insert.run('SELF-PROMO-ZERO','Грумер',phone,a,a,id,1000,150,850,'HV15','sbp',rate,1,'paid').lastInsertRowid);
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  assert.equal(order.total,850);
  assert.equal(order.commission_rate,0);
  assert.equal(getUnpaidOrders(id).find(o=>o.id===orderId).commission_amount,0);
  assert.equal(getUnpaidSummary(id).amount,0);
  assert.match(buildCustomerMessage(order,[]),/комиссия грумеру не начисляется/);
  assert.match(buildPartnerMessage(order,[],{}),/Вознаграждение по этому заказу не начисляется/);
  assert.match(buildOrderMessage(order,[]),/комиссия грумеру 0%/);
  insert.run('SELF-REGULAR','Грумер',phone,a,a,id,1000,0,1000,null,'sbp',0.20,1,'paid');
  insert.run('CLIENT-PROMO','Клиент','+79135550999',a,a,id,1000,150,850,'HV15','sbp',0.20,0,'paid');
  assert.equal(getUnpaidSummary(id).amount,370);
});

test('payment route forwards validated first purchase promo, and manager totals respect the frozen rate',()=>{
  const payment=fs.readFileSync(path.join(__dirname,'routes-payment.js'),'utf8');
  const managers=fs.readFileSync(path.join(__dirname,'routes-managers.js'),'utf8');
  const orders=fs.readFileSync(path.join(__dirname,'routes-orders.js'),'utf8');
  assert.match(payment,/resolveOrderCommission\(\s*pointId, authoritativePartnerId, customerPhone, advisorSelection, !!promoValidation\?\.valid/);
  assert.match(payment,/commissionRate: orderCommissionRate, isSelfOrder/);
  assert.match(managers,/SUM\(ROUND\(total \* COALESCE\(commission_rate, \?, 0\)\)\)/);
  assert.match(orders,/SELF_ORDER_PROMO_NO_COMMISSION/);
});

test.after(()=>{
  try { db.close(); }catch(_){}
  fs.rmSync(directory,{recursive:true,force:true});
});
