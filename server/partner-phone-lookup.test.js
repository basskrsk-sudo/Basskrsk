'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hm-partner-phone-key-'));
process.env.DATA_DIR=temporary;
const db=require('./db');
const { registerCustomerRoutes }=require('./routes-customers');
const { getDiscountSettings }=require('./settings');

const routes=new Map();
registerCustomerRoutes(new Proxy({},{
  get:(_,verb)=>(url,handler)=>routes.set(verb+' '+url,handler)
}));
let next=0;
function addPartner(phone,active=1) {
  const code='PART-PHONE-'+(++next);
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,active)'+
    ' VALUES(?,?,?,?,?,?,?)'
  ).run(code,code,'hash','Партнёр',phone,'Салон',active).lastInsertRowid);
}
function lookup(phone) {
  const res={
    status:null,result:null,
    writeHead(status){this.status=status;return this;},
    end(raw){this.result=JSON.parse(raw);},
  };
  routes.get('get /api/customers/check')(
    {headers:{}},res,{query:{phone}});
  assert.equal(res.status,200);
  return res.result;
}

test('partner loyalty query is indexed and no longer loads every partner phone',()=>{
  const sql='SELECT 1 FROM partners WHERE phone_last10=? AND active=1 LIMIT 1';
  const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all('9135550001');
  assert.match(plan.map(row=>row.detail).join('\n'),/idx_partners_phone_last10_active/);
  const code=fs.readFileSync(path.join(__dirname,'routes-customers.js'),'utf8');
  assert.match(code,/const activePartnerByPhoneKey = db\.prepare\(/);
  assert.doesNotMatch(code,/SELECT phone FROM partners WHERE active = 1/);
});

test('active groomer receives Gold for legacy formatting and Unicode separators',()=>{
  const id=addPartner('+7 😸 (913)\t555.00/01',1);
  assert.equal(db.prepare('SELECT phone_last10 FROM partners WHERE id=?').get(id).phone_last10,'9135550001');
  assert.equal(lookup('8 (913) 555-00-01').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
  assert.equal(lookup('+7 913 555 00 01').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
  assert.equal(lookup('8-913-555-00-02').loyalty_percent,0);
});

test('inactive groomer does not grant Gold until reactivated',()=>{
  const id=addPartner('8-905-123-45-67',0);
  assert.equal(lookup('79051234567').loyalty_percent,0);
  db.prepare('UPDATE partners SET active=1 WHERE id=?').run(id);
  assert.equal(lookup('89051234567').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(id);
  assert.equal(lookup('79051234567').loyalty_percent,0);
});

test('partner phone changes immediately invalidate old Gold entitlement',()=>{
  const id=addPartner('8 (916) 333-44-55');
  assert.equal(lookup('79163334455').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
  db.prepare('UPDATE partners SET phone=? WHERE id=?').run('+7(917)222-33-44',id);
  assert.equal(lookup('79163334455').loyalty_percent,0);
  assert.equal(lookup('89172223344').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
});

test('duplicate normalized phones preserve any-active-partner matching',()=>{
  const one=addPartner('8-928-111-22-33',0);
  const two=addPartner('+7 (928) 111 22 33',1);
  assert.notEqual(one,two);
  assert.equal(lookup('79281112233').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(two);
  assert.equal(lookup('89281112233').loyalty_percent,0);
});

test('old partner rows with a missing index key are recovered at the next restart',()=>{
  const id=addPartner('8 (904) 123-45-67');
  db.prepare('UPDATE partners SET phone_last10=NULL WHERE id=?').run(id);
  assert.equal(lookup('79041234567').loyalty_percent,0);
  const script=[
    "const db=require('./server/db');",
    "const row=db.prepare('SELECT phone_last10 FROM partners WHERE id=?').get("+id+");",
    "if(row.phone_last10!=='9041234567')process.exitCode=2;",
    "db.close();",
  ].join('\n');
  const child=spawnSync(process.execPath,['-e',script],{
    cwd:path.join(__dirname,'..'),
    env:{...process.env,DATA_DIR:temporary},
    encoding:'utf8',
    timeout:30000,
  });
  assert.equal(child.status,0,child.stderr||child.stdout);
  assert.equal(lookup('89041234567').loyalty_percent,getDiscountSettings().loyalty_gold_percent);
});

test.after(()=>{
  try { db.close(); } catch (_) {}
  fs.rmSync(temporary,{recursive:true,force:true});
});
