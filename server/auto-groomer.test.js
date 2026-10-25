'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-auto-groomer-'));
process.env.DATA_DIR = dir;
const db = require('./db');
const { findDefaultGroomer, validateOwnerGroomer, normalizedPhone, resolveCheckoutGroomer } = require('./auto-groomer');

function point(id) {
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
    .run(id,id,'Тестовая улица, 1','🐾');
  return id;
}
let seq = 0;
function groomer(pointId, fullName, phone, active = 1) {
  seq += 1;
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,active) '+
    'VALUES(?,?,?,?,?,?,?,?)'
  ).run('AUTO-G-'+seq,'auto-g-'+seq,'hash',fullName,phone,pointId,pointId,active).lastInsertRowid);
}
let ownerSeq=0;
function owner(pointId, phone, groomerPartnerId=null, active=1) {
  ownerSeq += 1;
  return Number(db.prepare(
    'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,groomer_partner_id,active) '+
    'VALUES(?,?,?,?,?,?,?)'
  ).run('auto-owner-'+ownerSeq,'hash','Владелец салона',phone,pointId,groomerPartnerId,active).lastInsertRowid);
}

test('no groomers: leave the attribution unassigned', () => {
  const id=point('auto-empty');
  assert.deepEqual(findDefaultGroomer(id),{partner:null,source:null});
});
test('sole active groomer becomes the automatic default', () => {
  const id=point('auto-single');
  const selected=groomer(id,'Единственный грумер','79001110001');
  groomer(id,'Неактивный грумер','79001110099',0);
  const result=findDefaultGroomer(id);
  assert.equal(result.partner.id,selected);
  assert.equal(result.source,'auto_single');
});
test('multiple groomers without a verified salon owner require explicit choice', () => {
  const id=point('auto-many');
  groomer(id,'Грумер 1','79001110002');
  groomer(id,'Грумер 2','79001110003');
  assert.equal(findDefaultGroomer(id).partner,null);
});
test('multiple groomers: exact matching owner phone selects owner groomer only', () => {
  const id=point('auto-phone');
  const selected=groomer(id,'Владелец-грумер','+7 999 111-22-33');
  groomer(id,'Другой грумер','79001110004');
  owner(id,'8 (999) 111-22-33');
  const result=findDefaultGroomer(id);
  assert.equal(result.partner.id,selected);
  assert.equal(result.source,'auto_owner_phone');
  assert.equal(normalizedPhone('8 (999) 111-22-33'),'9991112233');
});
test('explicit owner-groomer association takes precedence over telephone matching', () => {
  const id=point('auto-linked');
  const selected=groomer(id,'Назначенный владелец-грумер','79001110005');
  groomer(id,'Другой с телефоном владельца','79001110006');
  owner(id,'79001110006',selected);
  const result=findDefaultGroomer(id);
  assert.equal(result.partner.id,selected);
  assert.equal(result.source,'auto_owner_link');
});
test('stale association never silently falls back to a different groomer', () => {
  const id=point('auto-stale');
  const toDisable=groomer(id,'Бывший владелец-грумер','79001110007');
  groomer(id,'Тот же телефон, другой грумер','79001110008');
  owner(id,'79001110008',toDisable);
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(toDisable);
  assert.equal(findDefaultGroomer(id).partner,null);
});
test('duplicate owner phone match is ambiguous and not auto-attributed', () => {
  const id=point('auto-duplicate');
  groomer(id,'Первый','79001110009');
  groomer(id,'Второй','89001110009');
  owner(id,'+7 (900) 111-00-09');
  assert.equal(findDefaultGroomer(id).partner,null);
});
test('inactive salon owner does not select any groomer', () => {
  const id=point('auto-inactive-owner');
  groomer(id,'Владелец','79001110010');
  groomer(id,'Другой','79001110011');
  owner(id,'79001110010',null,0);
  assert.equal(findDefaultGroomer(id).partner,null);
});
test('owner-groomer link cannot point to inactive groomer or another salon', () => {
  const pointA=point('auto-link-a');
  const pointB=point('auto-link-b');
  const activeA=groomer(pointA,'Владелец А','79001110012');
  const activeB=groomer(pointB,'Владелец Б','79001110013');
  const inactiveA=groomer(pointA,'Неактивный','79001110014',0);
  assert.deepEqual(validateOwnerGroomer(pointA,activeA),{valid:true,id:activeA});
  assert.deepEqual(validateOwnerGroomer(pointA,''),{valid:true,id:null});
  assert.equal(validateOwnerGroomer(pointA,activeB).valid,false);
  assert.equal(validateOwnerGroomer(pointA,inactiveA).valid,false);
  assert.equal(validateOwnerGroomer(null,activeA).valid,false);
});
test('checkout picks sole groomer when no choice; explicit self preserves zero commission', () => {
  const id=point('auto-checkout-single');
  const sole=groomer(id,'Грумер','79001110101');
  const missing=resolveCheckoutGroomer({
    pointId:id, partnerId:null, advisorSelection:null, selfOrderingPartner:null, fulfillmentType:'pickup',
  });
  assert.equal(missing.id,sole);
  assert.equal(missing.source,'auto_single');
  const self=resolveCheckoutGroomer({
    pointId:id, partnerId:null, advisorSelection:'self', selfOrderingPartner:null, fulfillmentType:'pickup',
  });
  assert.equal(self.id,null);
  assert.equal(self.source,'self');
  const delivery=resolveCheckoutGroomer({
    pointId:id, partnerId:null, advisorSelection:null, selfOrderingPartner:null, fulfillmentType:'home_delivery',
  });
  assert.equal(delivery.id,null);
});

test('checkout owner is default with multiple groomers, but manual selection overrides it', () => {
  const id=point('auto-checkout-owner');
  const ownerGroomer=groomer(id,'Владелец-грумер','79001110102');
  const another=groomer(id,'Коллега','79001110103');
  owner(id,'79001110102',ownerGroomer);
  const base={pointId:id,advisorSelection:null,selfOrderingPartner:null,fulfillmentType:'pickup'};
  assert.equal(resolveCheckoutGroomer({...base,partnerId:null}).id,ownerGroomer);
  const manual=resolveCheckoutGroomer({...base,partnerId:another});
  assert.equal(manual.id,another);
  assert.equal(manual.source,'selected');
  const selfOrder=resolveCheckoutGroomer({...base,partnerId:another,
    selfOrderingPartner:{id:ownerGroomer,full_name:'Владелец-грумер'}});
  assert.equal(selfOrder.id,ownerGroomer);
  assert.equal(selfOrder.source,'self_order');
});

test('checkout does not randomly attribute when owner is unknown or a manual ID is invalid', () => {
  const id=point('auto-checkout-unknown');
  groomer(id,'Первый','79001110104');
  const other=groomer(id,'Второй','79001110105');
  const base={pointId:id,advisorSelection:null,selfOrderingPartner:null,fulfillmentType:'pickup'};
  assert.throws(()=>resolveCheckoutGroomer({...base,partnerId:null}),error=>{
    assert.equal(error.code,'ADVISOR_SELECTION_REQUIRED');return true;
  });
  assert.throws(()=>resolveCheckoutGroomer({...base,partnerId:999999}),error=>{
    assert.equal(error.code,'PARTNER_POINT_MISMATCH');return true;
  });
  const unrelatedPoint=point('auto-checkout-other');
  assert.throws(()=>resolveCheckoutGroomer({...base,pointId:unrelatedPoint,partnerId:other}),
    error=>error.code==='PARTNER_POINT_MISMATCH');
});

test('both public checkout pages preselect only the backend-approved default', () => {
  const qr=fs.readFileSync(path.join(__dirname,'..','public','p.html'),'utf8');
  const catalog=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'routes-payment.js'),'utf8');
  assert.match(qr,/CTX\.defaultPartnerId = partnersData\.default_partner_id/);
  assert.match(qr,/advisor\.value = String\(CTX\.defaultPartnerId\)/);
  assert.match(catalog,/data\.default_partner_id/);
  assert.match(catalog,/groomerSel\.value = String\(automaticPartner\.id\)/);
  assert.match(server,/resolveCheckoutGroomer\(/);
  assert.match(server,/partnerId: authoritativePartnerId/);
});
test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(dir,{recursive:true,force:true});
});
