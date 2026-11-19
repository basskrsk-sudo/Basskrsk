'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHealthHistory}=require('./health-history');

test('health history samples at most every five minutes in normal operation',()=>{
  const trend=createHealthHistory({maxSamples:5,minSpacingMs:300000});
  assert.equal(trend.record({rss_mb:80,backup_phase:'idle'},1000000),true);
  assert.equal(trend.record({rss_mb:81},1000000+60000),false);
  assert.equal(trend.record({rss_mb:83},1000000+300000),true);
  assert.equal(trend.size,2);
  const snapshot=trend.snapshot();
  assert.equal(snapshot[0].rss_mb,80);
  assert.equal(snapshot[1].rss_mb,83);
  assert.match(snapshot[1].at,/Z$/);
});

test('anomaly snapshots bypass cadence but remain bounded; returned values are copies',()=>{
  const trend=createHealthHistory({maxSamples:3,minSpacingMs:300000});
  for(let i=0;i<10;i++)trend.record({cpu_percent:i,sqlite_ms:i*100},1000000+i*60000,true);
  assert.equal(trend.size,3);
  assert.deepEqual(trend.snapshot().map(row=>row.cpu_percent),[7,8,9]);
  const sample=trend.snapshot();
  sample[0].cpu_percent=999;
  assert.equal(trend.snapshot()[0].cpu_percent,7);
  assert.deepEqual(trend.snapshot(2).map(row=>row.cpu_percent),[8,9]);
});

test('invalid history configuration is rejected and timestamps cannot be fabricated',()=>{
  assert.throws(()=>createHealthHistory({maxSamples:0}),/Invalid health history bounds/);
  assert.throws(()=>createHealthHistory({minSpacingMs:-1}),/Invalid health history bounds/);
  const trend=createHealthHistory();
  assert.equal(trend.record({rss_mb:80},NaN),false);
  assert.equal(trend.size,0);
});
