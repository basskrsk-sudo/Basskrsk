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

test.after(()=>{
  try { db.close(); }catch(_){}
  fs.rmSync(directory,{recursive:true,force:true});
});
