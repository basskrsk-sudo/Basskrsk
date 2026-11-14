'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-customer-lookup-'));
process.env.DATA_DIR = temporary;
const db = require('./db');
const { findCustomer } = require('./order-notifications');
const insert = db.prepare('INSERT INTO customers(phone,telegram_chat_id) VALUES(?,?)');
function customer(phone, chat) {
  return Number(insert.run(phone,chat).lastInsertRowid);
}

test('purchase receipt lookup uses SQLite index, not a scan of all customer records', () => {
  const statement = 'SELECT id,phone,telegram_chat_id FROM customers WHERE phone_last10=? LIMIT 2';
  const plan=db.prepare('EXPLAIN QUERY PLAN '+statement).all('9135550001');
  assert.match(plan.map(row=>String(row.detail)).join(' '),/idx_customers_phone_last10/);
  const src=fs.readFileSync(path.join(__dirname,'order-notifications.js'),'utf8');
  assert.match(src,/const customerByPhoneKey = db\.prepare\(/);
  assert.doesNotMatch(src,/SELECT id,phone,telegram_chat_id FROM customers'\)\.all\(\)/);
});

test('legacy phone formats and Unicode characters resolve to the same last 10 ASCII digits', () => {
  const id=customer('+7 😸 (913)\t555.00/01','5550101');
  assert.equal(findCustomer('8 (913) 555-00-01').id,id);
  assert.equal(findCustomer('+7 913 555 00 01').telegram_chat_id,'5550101');
  assert.equal(findCustomer('9135550001').id,id);
  assert.equal(findCustomer('913555001'),null);
  assert.equal(findCustomer(null),null);
  assert.equal(db.prepare('SELECT phone_last10 FROM customers WHERE id=?').get(id).phone_last10,'9135550001');
});

test('ambiguous last-10-digit matches never send a private receipt to either chat', () => {
  const second=customer('8-913-555-00-01','5550102');
  assert.equal(findCustomer('79135550001'),null);
  assert.equal(findCustomer('8 (913) 555 00 01'),null);
  db.prepare('UPDATE customers SET phone=? WHERE id=?').run('8-(923) 555-00-02',second);
  assert.equal(findCustomer('79135550001').telegram_chat_id,'5550101');
  assert.equal(findCustomer('89235550002').id,second);
});

test('phone changes and deletes immediately update the indexed lookup', () => {
  const id=customer('+7 (999) 999-99-99','5550103');
  db.prepare('UPDATE customers SET phone=? WHERE id=?').run('+7(916)111-22-33',id);
  assert.equal(findCustomer('79999999999'),null);
  assert.equal(findCustomer('89161112233').id,id);
  db.prepare('DELETE FROM customers WHERE id=?').run(id);
  assert.equal(findCustomer('79161112233'),null);
});

test('missing legacy key is backfilled safely when the process starts again', () => {
  const id=customer('8 (904) 123-45-67','5550104');
  db.prepare('UPDATE customers SET phone_last10=NULL WHERE id=?').run(id);
  assert.equal(findCustomer('79041234567'),null);
  const script=[
    "const db=require('./server/db');",
    "const row=db.prepare('SELECT phone_last10 FROM customers WHERE id=?').get("+id+");",
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
  assert.equal(findCustomer('79041234567').id,id);
});

test('large customer list still produces at most two candidate rows', () => {
  db.exec('BEGIN IMMEDIATE');
  try {
    for(let i=0;i<750;i++){
      insert.run('7999'+String(i).padStart(7,'0'),null);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const rows=db.prepare(
    'SELECT id FROM customers WHERE phone_last10=? LIMIT 2'
  ).all('9135550001');
  assert.equal(rows.length,1);
  assert.equal(findCustomer('8-913-555-00-01').telegram_chat_id,'5550101');
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(temporary,{recursive:true,force:true});
});
