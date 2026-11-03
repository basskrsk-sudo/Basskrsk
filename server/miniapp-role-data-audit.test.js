'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-miniapp-roles-audit-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerOwnerRoutes } = require('./routes-owners');
const { registerPartnerRoutes } = require('./routes-partners');
const { registerCustomerRoutes } = require('./routes-customers');

const registered = new Map();
const router = {};
for (const verb of ['get','post','put','delete']) {
  router[verb] = (url, handler) => registered.set(verb.toUpperCase() + ' ' + url, handler);
}
registerOwnerRoutes(router);
registerPartnerRoutes(router);
registerCustomerRoutes(router);

function call(verb, url, role, id) {
  const handler = registered.get(verb + ' ' + url);
  assert.ok(handler, 'registered API ' + url);
  const response = {
    status: 0,
    writeHead(code) { this.status = code; },
    end(body) { this.body = JSON.parse(body); },
  };
  handler({
    headers: { authorization: 'Bearer ' + signToken({ role, id }) },
  }, response, { body: {}, params: {}, query: {} });
  return response;
}

function manager(code, fullName) {
  return Number(db.prepare(
    'INSERT INTO managers (mgr_code,login,password_hash,full_name,phone) VALUES (?,?,?,?,?)'
  ).run(code,code,'hash',fullName,'79130000000').lastInsertRowid);
}
function point(id, name, managerId, active=1) {
  db.prepare('INSERT INTO points (id,name,addr,icon,manager_id,active) VALUES (?,?,?,?,?,?)')
    .run(id,name,'Красноярск, тест','🏪',managerId,active);
}
function owner(code, pointId) {
  return Number(db.prepare(
    'INSERT INTO salon_owners (login,password_hash,full_name,phone,point_id,commission_rate) '+
    'VALUES (?,?,?,?,?,?)'
  ).run(code,'hash','Владелец '+code,'79131234567',pointId,0.05).lastInsertRowid);
}
function partner(code, pointId) {
  return Number(db.prepare(
    'INSERT INTO partners (partner_code,login,password_hash,full_name,phone,point_name,point_id) '+
    'VALUES (?,?,?,?,?,?,?)'
  ).run(code,code,'hash','Грумер '+code,'79131234568','Устаревшее имя',pointId).lastInsertRowid);
}
function customer(phone) {
  return Number(db.prepare('INSERT INTO customers (phone,name) VALUES (?,?)')
    .run(phone,'Покупатель').lastInsertRowid);
}
const insertOrder = db.prepare(
  'INSERT INTO orders (order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,'+
  'subtotal,total,payment_method,status,refund_status,refunded_amount) '+
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
);
function order(code, phone, pointId, partnerId, total, status='paid', refund='none', refunded=null) {
  insertOrder.run(code,'Покупатель',phone,'Точка',pointId,partnerId,total,total,
    'sbp',status,refund,refunded);
}

test('owner and combined salon only use an active real salon, current manager and net nonreturned revenue', () => {
  const former = manager('owner-former','Старый менеджер');
  const current = manager('owner-current','Текущий менеджер');
  point('owner-live','БаркЛай (действующий)',current);
  point('owner-closed','Груминг Пушок',former,0);
  const liveOwner = owner('owner-live-account','owner-live');
  const closedOwner = owner('owner-closed-account','owner-closed');
  db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate) VALUES (?,?,?,?,?)')
    .run(former,'owner-live','Старое название','Груминг',0.12);
  db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate) VALUES (?,?,?,?,?)')
    .run(current,'owner-live','Устаревшее название','Груминг',0.07);

  order('OWN-LIVE-PAID','79135554444','owner-live',null,1000);
  order('OWN-LIVE-FULL-RETURN','79135554444','owner-live',null,500,'paid','refunded',500);
  order('OWN-LIVE-PARTIAL','79135554444','owner-live',null,700,'paid','refunded',200);
  order('OWN-LIVE-PENDING','79135554444','owner-live',null,300,'pending');

  const dashboard = call('GET','/api/owner/dashboard','owner',liveOwner);
  assert.equal(dashboard.status,200);
  assert.equal(dashboard.body.point.name,'БаркЛай (действующий)');
  assert.equal(dashboard.body.totals.revenue,1500);
  assert.equal(dashboard.body.totals.orders,2);
  assert.equal(dashboard.body.manager.full_name,'Текущий менеджер');
  assert.equal(dashboard.body.manager.tier_percent,7);
  assert.equal(JSON.stringify(dashboard.body).includes('Старый менеджер'),false);

  const closed = call('GET','/api/owner/dashboard','owner',closedOwner);
  assert.equal(closed.status,200);
  assert.equal(closed.body.noPoint,true);
  assert.equal(closed.body.point,undefined);
  assert.equal(closed.body.totals,undefined);
});

test('groomer uses existing active point for current profile, not stale name or closed salon', () => {
  point('groomer-closed','Салон закрыт',null,0);
  point('groomer-active','Новое название салона',null,1);
  const inactivePartner = partner('groomer-closed-role','groomer-closed');
  const livePartner = partner('groomer-active-role','groomer-active');
  const closedProfile = call('GET','/api/partners/me','partner',inactivePartner);
  assert.equal(closedProfile.status,200);
  assert.equal(closedProfile.body.partner.current_point,null);
  assert.equal(closedProfile.body.partner.point_unavailable,true);
  const closedStock = call('GET','/api/partners/me/stock','partner',inactivePartner);
  assert.equal(closedStock.status,200);
  assert.deepEqual(closedStock.body.stock,[]);
  assert.equal(closedStock.body.point_unavailable,true);

  const profile = call('GET','/api/partners/me','partner',livePartner);
  assert.equal(profile.body.partner.current_point.name,'Новое название салона');
  assert.equal(profile.body.partner.point_unavailable,false);
  const personalCode=db.prepare('SELECT first_purchase_promo_code FROM partners WHERE id=?')
    .get(livePartner).first_purchase_promo_code;
  const pointCode=db.prepare('SELECT first_purchase_promo_code FROM points WHERE id=?')
    .get('groomer-active').first_purchase_promo_code;
  assert.ok(personalCode && pointCode && personalCode !== pointCode);
  assert.equal(profile.body.partner.first_purchase_promo_code,personalCode);
  assert.equal(profile.body.partner.current_point.first_purchase_promo_code,pointCode);
  assert.equal(closedProfile.body.partner.current_point,null,
    'a closed salon never leaks its point promo code');
  assert.notEqual(call('GET','/api/partners/me','owner',livePartner).status,200,
    'an owner token cannot read a groomer\'s personal promo');


  order('GROOM-PAID','79131234568','groomer-active',livePartner,1000);
  order('GROOM-RETURN','79131234568','groomer-active',livePartner,600,'paid','refunded',600);
  order('GROOM-PARTIAL','79131234568','groomer-active',livePartner,400,'paid','refunded',100);
  const sales=call('GET','/api/partners/me/orders','partner',livePartner);
  assert.equal(sales.status,200);
  assert.deepEqual(sales.body.orders.map(x=>x.order_code).sort(),['GROOM-PAID','GROOM-PARTIAL']);
  assert.equal(sales.body.orders.reduce((sum,x)=>sum+x.sum,0),1300);
});

test('customer history reads this verified phone first, not latest 500 network orders', () => {
  const account=customer('+7 (913) 123-45-67');
  order('CUSTOMER-OLD','8 (913) 123-45-67','owner-live',null,130);
  for(let i=0;i<520;i++){
    order('FOREIGN-ORDER-'+i,'+7 999 000-00-01','owner-live',null,55);
  }
  const response=call('GET','/api/customer/me/orders','customer',account);
  assert.equal(response.status,200);
  assert.equal(response.body.orders.length,1);
  assert.equal(response.body.orders[0].order_code,'CUSTOMER-OLD');
  assert.equal(response.body.orders[0].total,130);
  assert.equal(response.body.orders.some(x=>x.order_code.startsWith('FOREIGN')),false);
});
