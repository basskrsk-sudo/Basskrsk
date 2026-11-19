'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createEventLoopStallProfiler} = require('./event-loop-stall-profiler');

function fixture() {
  let elapsed = 0, micros = 0, callback = null, cleared = false, interval;
  const monitor = createEventLoopStallProfiler({
    monotonicNow: () => elapsed,
    wallNow: () => Date.parse('2026-11-16T16:02:00Z') + elapsed,
    cpuUsage: () => ({user:micros, system:0}),
    residentBytes: () => 70 * 1048576,
    setIntervalFn(fn, ms) { callback = fn; interval = ms; return {unref(){}}; },
    clearIntervalFn() { cleared = true; },
    maxEvents: 3,
  });
  return {
    monitor,
    step(milliseconds, cpuMilliseconds) {
      elapsed += milliseconds;
      micros += cpuMilliseconds * 1000;
      return callback();
    },
    get interval() { return interval; },
    get cleared() { return cleared; },
  };
}

test('a five-second wall-clock pause with negligible CPU is recorded precisely', () => {
  const f=fixture();
  f.monitor.start();
  assert.equal(f.interval,1000);
  assert.equal(f.step(1000,1),null);
  const stall=f.step(6014,7);
  assert.equal(stall.late_by_ms,5014);
  assert.equal(stall.sample_window_ms,6014);
  assert.equal(stall.process_cpu_ms,7);
  assert.equal(stall.process_cpu_pct,0.1);
  assert.equal(stall.rss_mb,70);
  assert.equal(f.monitor.snapshot()[0].at,'2026-11-16T16:02:07.014Z');
  assert.deepEqual(f.monitor.snapshot()[0],stall);
  f.monitor.stop();
  assert.equal(f.cleared,true);
});

test('CPU-heavy stalls and external/suspended stalls have distinct CPU ratios',()=>{
  const f=fixture();f.monitor.start();
  const cpuBusy=f.step(6000,5900);
  assert.equal(cpuBusy.late_by_ms,5000);
  assert.ok(cpuBusy.process_cpu_pct>90);
  const notCpuBusy=f.step(6000,10);
  assert.ok(notCpuBusy.process_cpu_pct<1);
  assert.equal(f.monitor.snapshot().length,2);
});

test('normal timers are ignored and snapshots are bounded and private',()=>{
  const f=fixture();f.monitor.start();f.monitor.start();
  for(let i=0;i<10;i++) assert.equal(f.step(1000,1),null);
  for(let i=0;i<5;i++) f.step(2400,5);
  const samples=f.monitor.snapshot();
  assert.equal(samples.length,3);
  assert.ok(samples.every(s=>s.late_by_ms===1400));
  assert.equal(Object.keys(samples[0]).sort().join(','),
    'at,late_by_ms,process_cpu_ms,process_cpu_pct,rss_mb,sample_window_ms');
  assert.ok(!JSON.stringify(samples).includes('order_code'));
  f.monitor.stop();
});
