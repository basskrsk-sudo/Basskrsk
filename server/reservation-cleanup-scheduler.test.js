'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IDLE_RECHECK_MS, OVERDUE_RETRY_MS, FIRST_RUN_MS, EXPIRY_CUSHION_MS,
  nextReservationCleanupDelay, nextReservationCleanupDelayFromExpiry,
  hasOverdueReservation, isReservationExpiryOverdue, createReservationCleanupScheduler,
} = require('./reservation-cleanup-scheduler');

const NOW = Date.parse('2026-11-19T14:04:00.000Z');
function stub(expiry) {
  const sqls=[];
  return { sqls, prepare(sql) {
    sqls.push(sql);
    return {get:()=>({expiry})};
  } };
}
test('deadline query is narrow and follows only pending active reservation expiry',()=>{
  const empty=stub(null);
  assert.equal(nextReservationCleanupDelay(NOW,empty),IDLE_RECHECK_MS);
  assert.match(empty.sqls[0],/MIN\(reservation_expires_at\)/);
  assert.match(empty.sqls[0],/status='pending'/);
  assert.match(empty.sqls[0],/reservation_status='active'/);
  assert.doesNotMatch(empty.sqls[0],/SELECT \*/);
  assert.equal(nextReservationCleanupDelay(NOW,stub('2026-11-19 14:05:00')),60_000+EXPIRY_CUSHION_MS);
  assert.equal(nextReservationCleanupDelay(NOW,stub('2026-11-19 14:03:59')),OVERDUE_RETRY_MS);
  assert.equal(hasOverdueReservation(NOW,empty),false);
  assert.equal(hasOverdueReservation(NOW,stub('2026-11-19 14:05:00')),false);
  assert.equal(hasOverdueReservation(NOW,stub('2026-11-19 14:03:59')),true);
  assert.equal(hasOverdueReservation(NOW,stub('legacy-invalid')),true,
    'unparseable deadlines must still be reconciled safely');
});
test('one scheduler, wake-up on new order, idle when empty, retry overdue without stacking scans',async()=>{
  let expiry=null,now=NOW,jobCalls=0;
  let resume;
  let suspend=false;
  const tasks=new Map();
  let nextId=0;
  const setTimer=(fn,delay)=>{const id=++nextId;const t={id,fn,delay,unref(){}};tasks.set(id,t);return t;};
  const clearTimer=(t)=>tasks.delete(t.id);
  const database={prepare(sql){return {get(){return {expiry}}}}};
  const scheduler=createReservationCleanupScheduler({
    database,
    now:()=>now,
    setTimer,
    clearTimer,
    run:async()=>{
      jobCalls++;
      if(suspend)await new Promise(resolve=>{resume=resolve;});
    },
  });
  async function runTimer(){
    const first=[...tasks.values()][0];
    assert.ok(first,'scheduled timeout');
    tasks.delete(first.id);
    first.fn();
    await new Promise(r=>setImmediate(r));
    await new Promise(r=>setImmediate(r));
  }
  const delay=()=>[...tasks.values()][0]?.delay;
  try{
    scheduler.start();scheduler.start();
    assert.equal(tasks.size,1);
    assert.equal(delay(),FIRST_RUN_MS);
    await runTimer();
    assert.equal(jobCalls,0,'an empty store must not spawn an idle SQLite worker');
    assert.equal(delay(),IDLE_RECHECK_MS);
    expiry='2026-11-19 14:05:00';
    scheduler.wake();
    assert.equal(delay(),60_000+EXPIRY_CUSHION_MS);
    assert.equal(tasks.size,1);
    // A slow remote payment reconciliation cannot overlap itself.
    now=NOW+65_000;
    suspend=true;
    await runTimer();
    scheduler.wake();
    assert.equal(jobCalls,1,'the worker starts only when the deadline is actually overdue');
    assert.equal(tasks.size,0);
    expiry='2026-11-19 14:04:59';
    suspend=false;resume();
    await new Promise(r=>setImmediate(r));
    assert.equal(delay(),OVERDUE_RETRY_MS);
    // Order cleared: no frequent worker scans after the one retry.
    expiry=null;
    await runTimer();
    assert.equal(delay(),IDLE_RECHECK_MS);
    assert.equal(jobCalls,1,'returning to an empty store must not spawn more workers');
  } finally {scheduler.stop();}
  assert.equal(tasks.size,0);
});

test('production-style scheduler does not read SQLite synchronously during checkout wake',async()=>{
  let expiry=null,now=NOW,reads=0,runs=0,release=null;
  const tasks=new Map();
  let seq=0;
  const setTimer=(fn,delay)=>{
    const task={id:++seq,fn,delay,unref(){}};
    tasks.set(task.id,task);return task;
  };
  const scheduler=createReservationCleanupScheduler({
    database:{prepare(){throw Error('main thread SQL called');}},
    readExpiry:async()=>{reads++;return expiry;},
    run:async()=>{
      runs++;
      if(release!==null)await new Promise(resolve=>{release=resolve;});
    },
    now:()=>now,setTimer,clearTimer:task=>tasks.delete(task.id),
  });
  const delay=()=>[...tasks.values()][0]?.delay;
  const fire=async()=>{
    const task=[...tasks.values()][0];assert.ok(task);
    tasks.delete(task.id);task.fn();
    await new Promise(r=>setImmediate(r));
    await new Promise(r=>setImmediate(r));
  };
  try{
    scheduler.start();
    assert.equal(delay(),FIRST_RUN_MS);
    await fire();
    assert.equal(reads,1);
    assert.equal(runs,0);
    assert.equal(delay(),IDLE_RECHECK_MS);
    expiry='2026-11-19 14:05:00';
    scheduler.wake();
    assert.equal(reads,1,'wake cannot synchronously query SQLite');
    assert.equal(delay(),0);
    await fire();
    assert.equal(reads,2);
    assert.equal(delay(),60000+EXPIRY_CUSHION_MS);
    now=NOW+65000;
    release=()=>{};
    await fire();
    assert.equal(runs,1);
    scheduler.wake();
    assert.equal(tasks.size,0,'no duplicate workers during in-flight reconciliation');
    const resume=release;
    expiry=null;
    resume();
    await new Promise(r=>setImmediate(r));
    assert.equal(delay(),0,'new order wake preempts idle retry');
    await fire();
    assert.equal(delay(),IDLE_RECHECK_MS);
    assert.equal(runs,1);
  }finally{scheduler.stop();}
});
test('deadline helper retains safe expiry and backoff behavior',()=>{
  assert.equal(nextReservationCleanupDelayFromExpiry(null,NOW),IDLE_RECHECK_MS);
  assert.equal(nextReservationCleanupDelayFromExpiry('2026-11-19 14:04:01',NOW),1000+EXPIRY_CUSHION_MS);
  assert.equal(nextReservationCleanupDelayFromExpiry('legacy-invalid',NOW),OVERDUE_RETRY_MS);
  assert.equal(isReservationExpiryOverdue('legacy-invalid',NOW),true);
  assert.equal(isReservationExpiryOverdue(null,NOW),false);
  assert.equal(isReservationExpiryOverdue('2026-11-19 14:05:00',NOW),false);
});
