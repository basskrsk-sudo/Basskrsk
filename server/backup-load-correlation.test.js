'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {correlateBackupWithHealth,timeUtc,WINDOW_MS}=require('./backup-load-correlation');
const backup={
  started_at:'2026-11-21T20:00:00.000Z',
  finished_at:'2026-11-21T20:04:00.000Z',
  running:false,
};
test('backup overlap detects a UTC SQLite event during the snapshot window',()=>{
  const r=correlateBackupWithHealth(backup,[
    {event_type:'event_loop',severity:'warning',created_at:'2026-11-21 20:02:00'},
    {event_type:'startup',severity:'info',created_at:'2026-11-21 20:03:00'},
    {event_type:'cpu',severity:'warning',created_at:'2026-11-22 05:02:00'},
  ],[]);
  assert.equal(r.status,'coincident');
  assert.equal(r.events_count,1);
  assert.equal(r.spike_samples,0);
  assert.equal(r.window_started_at,backup.started_at);
  assert.equal(r.window_finished_at,backup.finished_at);
});
test('five-minute memory-only health samples detect co-occurring spikes',()=>{
  const r=correlateBackupWithHealth(backup,[],[
    {at:'2026-11-21T19:59:30Z',event_loop_max_ms:2600,cpu_percent:35},
    {at:'2026-11-21T20:08:59Z',event_loop_max_ms:80,cpu_percent:50},
    {at:'2026-11-21T20:30:00Z',event_loop_max_ms:9000},
  ]);
  assert.equal(r.status,'coincident');
  assert.equal(r.spike_samples,1);
  assert.equal(r.coverage_samples,2);
  assert.equal(r.peak_event_loop_ms,2600);
});
test('absence of spikes is only a statement about available samples',()=>{
  const r=correlateBackupWithHealth(backup,[],[
    {at:'2026-11-21T20:03:00Z',event_loop_max_ms:25,cpu_percent:12,sqlite_ms:3,storage_write_ms:2},
  ]);
  assert.equal(r.status,'not_observed');
  assert.equal(r.coverage_samples,1);
  assert.equal(r.events_count,0);
});
test('no recent sample or backup time never asserts absence of trouble',()=>{
  const absent=correlateBackupWithHealth(backup,[],[
    {at:'2026-11-21T18:00:00Z',event_loop_max_ms:4000},
  ]);
  assert.equal(absent.status,'insufficient_data');
  assert.equal(absent.reason,null);
  const restarted=correlateBackupWithHealth({configured:true,last_success_at:'2026-11-21T20:05:00Z'},[],[]);
  assert.equal(restarted.status,'insufficient_data');
  assert.equal(restarted.reason,'backup_window_unavailable');
});
test('unfinished backup is compared only through the current observation time',()=>{
  const active=correlateBackupWithHealth({...backup,finished_at:null,running:true},[],[
    {at:'2026-11-21T20:06:00Z',storage_write_ms:2000,event_loop_max_ms:5},
  ],{now:'2026-11-21T20:07:00Z'});
  assert.equal(active.status,'coincident');
  assert.equal(active.window_finished_at,'2026-11-21T20:07:00.000Z');
  assert.equal(timeUtc('2026-11-21 20:00:00'),timeUtc('2026-11-21T20:00:00Z'));
  assert.equal(WINDOW_MS,300000);
});

test('stall alert distinguishes exact backup overlap, unrelated attempt and unavailable history',()=>{
  const {backupStallContext,describeBackupStall}=require('./backup-load-correlation');
  const during={at:'2026-11-21T20:02:01.000Z',sample_window_ms:16000};
  const after={at:'2026-11-21T22:03:40.358Z',sample_window_ms:16726};
  assert.equal(backupStallContext({...backup,configured:true},during).status,'overlap');
  assert.equal(backupStallContext({...backup,configured:true},after).status,'outside');
  assert.match(describeBackupStall(backup,during),/причина не доказана/);
  assert.match(describeBackupStall(backup,after),/вне окна паузы/);
  assert.equal(backupStallContext({configured:true},after).status,'unknown');
  assert.equal(backupStallContext({configured:false},after).status,'disabled');
});
