'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IDLE_RECHECK_MS, OVERDUE_RETRY_MS, FIRST_RUN_MS, EXPIRY_CUSHION_MS,
  nextReservationCleanupDelay, createReservationCleanupScheduler,
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
    assert.equal(jobCalls,2);
    assert.equal(tasks.size,0);
    expiry='2026-11-19 14:04:59';
    suspend=false;resume();
    await new Promise(r=>setImmediate(r));
    assert.equal(delay(),OVERDUE_RETRY_MS);
    // Order cleared: no frequent worker scans after the one retry.
    expiry=null;
    await runTimer();
    assert.equal(delay(),IDLE_RECHECK_MS);
    assert.equal(jobCalls,3);
  } finally {scheduler.stop();}
  assert.equal(tasks.size,0);
});
