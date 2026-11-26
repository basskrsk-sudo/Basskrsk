'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseCpuStat,cpuThrottleDelta,sampleCpuThrottling,
  trackSync,trackAsync,snapshotOperations} = require('./runtime-diagnostics');

test('cgroup v2 and v1 CPU statistics produce unit-safe throttle deltas',()=>{
  const before = parseCpuStat('nr_periods 100\nnr_throttled 3\nthrottled_usec 300000\n');
  const after = parseCpuStat('nr_periods 120\nnr_throttled 8\nthrottled_usec 940000\n');
  assert.deepEqual(cpuThrottleDelta(before,after),{
    periods:20,throttled_periods:5,throttled_periods_pct:25,throttled_ms:640
  });
  assert.equal(cpuThrottleDelta(after,before),null,'restarts reset counters');
  const v1=parseCpuStat('nr_periods 42\nnr_throttled 3\nthrottled_time 9000000');
  assert.equal(v1.throttled_us,9000);
  assert.equal(parseCpuStat('nr_periods not-a-number\nnr_throttled 5'),null);
});

test('missing cgroup is reported as unavailable, never interpreted as zero throttling',async()=>{
  const stat=await sampleCpuThrottling(async()=>{throw Error('EACCES')});
  assert.equal(stat.available,false);
  assert.equal(stat.throttled_periods_pct,undefined);
});

test('job observations preserve return and throw behavior and never store payloads',async()=>{
  const customer='customer-token-PRIVATE';
  const result=trackSync('unpaid_order_query',()=>({customer}));
  assert.deepEqual(result,{customer});
  assert.equal(await trackAsync('backup_job',async()=>42),42);
  assert.throws(()=>trackSync('unpaid_order_query',()=>{throw Error('boom')}),/boom/);
  await assert.rejects(()=>trackAsync('backup_job',async()=>{throw Error('offline')}),/offline/);
  const rows=snapshotOperations();
  assert.ok(rows.some(r=>r.name==='unpaid_order_query'&&r.calls===2));
  assert.ok(rows.some(r=>r.name==='backup_job'&&r.calls===2));
  assert.ok(!JSON.stringify(rows).includes(customer));
  assert.ok(rows.every(row=>row.max_ms>=0&&row.avg_ms>=0));
  assert.ok(rows.every(row=>row.p95_ms>=0&&row.sample_window>=1&&row.sample_window<=32));
  assert.throws(()=>trackSync('private:123',()=>null),/Invalid operation name/);
});

test('p95 uses recent bounded samples without dropping lifetime maximum',()=>{
  const { recordOperation } = require('./runtime-diagnostics');
  recordOperation('bounded_latency_window',8000);
  for(let i=0;i<40;i++)recordOperation('bounded_latency_window',10);
  const row=snapshotOperations().find(r=>r.name==='bounded_latency_window');
  assert.equal(row.sample_window,32);
  assert.equal(row.p95_ms,10);
  assert.equal(row.max_ms,8000);
});

test('slow synchronous operations are time-stamped, bounded and contain no payloads',()=>{
  const {noteSlowSync,snapshotSlowSyncOperations}=require('./runtime-diagnostics');
  noteSlowSync('report_query',320,'2026-11-16T16:02:00Z'); // ignored
  for(let i=0;i<11;i++) noteSlowSync('report_query',1500+i,Date.parse('2026-11-16T16:02:00Z')+i);
  const recent=snapshotSlowSyncOperations();
  assert.equal(recent.length,8);
  assert.equal(recent[0].duration_ms,1510);
  assert.equal(recent[0].at,'2026-11-16T16:02:00.010Z');
  assert.deepEqual(Object.keys(recent[0]).sort(),['at','duration_ms','name']);
  assert.throws(()=>noteSlowSync('secret:order-123',1900),/Invalid operation name/);
});

test('SQLite instrumentation keeps native behavior, transactions, statements and iterators',()=>{
  const {DatabaseSync}=require('node:sqlite');
  const {createSqliteDiagnostics}=require('./sqlite-runtime-diagnostics');
  let clock=0;
  const d=createSqliteDiagnostics({now:()=>clock++,thresholdMs:500});
  const db=new DatabaseSync(':memory:'),preparePrototype=DatabaseSync.prototype.prepare;
  assert.equal(d.instrument(db),db);
  assert.equal(d.instrument(db),db);
  assert.equal(DatabaseSync.prototype.prepare,preparePrototype);
  try{
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)');
    db.exec('BEGIN');
    const insert=db.prepare('INSERT INTO t(v) VALUES($value)');
    assert.equal(Number(insert.run({$value:'private data'}).changes),1);
    db.exec('COMMIT');
    const stmt=db.prepare('SELECT id,v FROM t ORDER BY id');
    assert.equal(stmt.get().v,'private data');
    assert.equal(stmt.all().length,1);
    assert.equal(stmt.sourceSQL,'SELECT id,v FROM t ORDER BY id');
    assert.equal([...stmt.iterate()][0].id,1);
    assert.throws(()=>db.prepare('SELECT FROM'));
    assert.equal(d.snapshot().length,0);
  }finally{db.close();}
});
test('slow SQLite operations retain only bounded timing and safe source, including failed calls',()=>{
  const {createSqliteDiagnostics,selectSqliteOperation}=require('./sqlite-runtime-diagnostics');
  let clock=0,wall=Date.parse('2026-11-25T22:03:40.000Z');
  const d=createSqliteDiagnostics({now:()=>clock,wallNow:()=>wall,getSource:()=> 'routes-orders.js:42',maxEvents:3});
  assert.equal(d.observe('sqlite_get',()=>{clock+=499;return 7}),7);
  assert.equal(d.snapshot().length,0);
  for(let i=0;i<4;i++){
    wall+=10000;
    assert.throws(()=>d.observe('sqlite_run',()=>{clock+=800+i;throw Error('private SQL and token')}),/private SQL/);
  }
  const rows=d.snapshot();
  assert.equal(rows.length,3);
  assert.equal(rows[0].duration_ms,803);
  assert.equal(rows[0].source,'routes-orders.js:42');
  assert.doesNotMatch(JSON.stringify(rows),/private SQL|token/);
  assert.deepEqual(Object.keys(rows[0]).sort(),['at','duration_ms','name','source','started_at']);
  const match=selectSqliteOperation(rows,{at:rows[1].at,sample_window_ms:1000});
  assert.equal(match.duration_ms,802);
  assert.equal(selectSqliteOperation(rows,{at:'2025-01-01T00:00:00Z',sample_window_ms:1000}),null);
  rows[0].source='changed';
  assert.equal(d.snapshot()[0].source,'routes-orders.js:42');
});
test('real slow statement records source and preserves the native error',()=>{
  const {DatabaseSync}=require('node:sqlite');
  const {createSqliteDiagnostics}=require('./sqlite-runtime-diagnostics');
  const db=new DatabaseSync(':memory:');
  const d=createSqliteDiagnostics({thresholdMs:0});
  try{
    d.instrument(db);
    db.prepare('SELECT 1 AS n').get();
    assert.throws(()=>db.prepare('SELECT FROM'));
    const rows=d.snapshot();
    assert.equal(rows[0].name,'sqlite_prepare');
    assert.ok(rows.some(r=>r.name==='sqlite_get'));
    assert.ok(rows.some(r=>/^runtime-diagnostics\.test\.js:\d+$/.test(r.source||'')));
    assert.doesNotMatch(JSON.stringify(rows),/SELECT FROM|SELECT 1/);
  }finally{db.close();}
});
