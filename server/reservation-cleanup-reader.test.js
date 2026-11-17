'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-expired-reader-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const { listExpiredActiveReservationsBatch } = require('./reservations');
const { createReservationCleanupReader, readExpiredReservationsBatch } = require('./reservation-cleanup-reader');
const insert=db.prepare(
  'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,subtotal,total,' +
  'payment_method,status,reservation_status,reservation_expires_at,yookassa_payment_id) ' +
  'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
);
for (let i=1;i<=19;i++) {
  insert.run('READER-TEST-'+i,'User','79000000000','Test',250,250,
    'yookassa','pending','active','2000-01-01 00:00:00','test-payment-'+i);
}
insert.run('READER-FUTURE','User','79000000000','Test',250,250,
  'yookassa','pending','active','2999-01-01 00:00:00','future');
insert.run('READER-PAID','User','79000000000','Test',250,250,
  'yookassa','paid','consumed','2000-01-01 00:00:00','paid');

test('worker reads expired reservations without blocking the HTTP event loop',async()=>{
  let timerFired=false;
  const reading=readExpiredReservationsBatch(db.DB_PATH,0,8);
  await new Promise(resolve=>setImmediate(()=>{timerFired=true;resolve();}));
  const first=await reading;
  assert.equal(timerFired,true);
  assert.equal(first.length,8);
  assert.deepEqual(first.map(row=>({...row})),
    listExpiredActiveReservationsBatch(0,8).map(row=>({...row})));
  const second=await readExpiredReservationsBatch(db.DB_PATH,first.at(-1).id,8);
  const third=await readExpiredReservationsBatch(db.DB_PATH,second.at(-1).id,8);
  assert.deepEqual([first.length,second.length,third.length],[8,8,3]);
  assert.deepEqual(
    [...first,...second,...third].map(row=>row.order_code),
    Array.from({length:19},(_,i)=>'READER-TEST-'+(i+1))
  );
  assert.deepEqual(Object.keys(first[0]).sort(),['id','order_code','yookassa_payment_id']);
  assert.equal((await readExpiredReservationsBatch(db.DB_PATH,0,999)).length,19,
    'SQL page size is limited to 20');
});

test('unreadable database rejects cleanly without creating a file',async()=>{
  const missing=path.join(directory,'missing.db');
  await assert.rejects(readExpiredReservationsBatch(missing,0,8),/reader/i);
  assert.equal(fs.existsSync(missing),false);
});

test('reader timeout waits for termination',async()=>{
  let terminated=0;
  class StuckWorker extends EventEmitter {
    terminate(){terminated++;return Promise.resolve(0);}
  }
  const read=createReservationCleanupReader({WorkerClass:StuckWorker,timeoutMs:10});
  await assert.rejects(read(db.DB_PATH,0,8),/timed out/);
  assert.equal(terminated,1);
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(directory,{recursive:true,force:true});
});
