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
  assert.throws(()=>trackSync('private:123',()=>null),/Invalid operation name/);
});
