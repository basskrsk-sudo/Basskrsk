'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-backup-schedule-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const {
  createBackupScheduler, nextBackupDelay, BACKUP_INTERVAL_MS,
  BACKUP_START_DELAY_MS, BACKUP_RETRY_MS,
} = require('./backup');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
function iso(ms) { return new Date(ms).toISOString(); }

test('a fresh database sends first backup two minutes after start', () => {
  assert.equal(nextBackupDelay({}, NOW), 2 * MINUTE);
  assert.equal(nextBackupDelay({last_success_at:null,last_attempt_at:null},NOW),2*MINUTE);
});

test('recently successful backup suppresses repeated snapshots after redeploy', () => {
  const state = {last_success_at:iso(NOW-10*MINUTE),last_attempt_at:iso(NOW-10*MINUTE)};
  assert.equal(nextBackupDelay(state,NOW),BACKUP_INTERVAL_MS-10*MINUTE);
  assert.equal(nextBackupDelay({last_success_at:iso(NOW-25*60*MINUTE),
    last_attempt_at:iso(NOW-25*60*MINUTE)},NOW),BACKUP_START_DELAY_MS);
});

test('failed SMTP or snapshot attempts keep a one-hour cooldown across restarts', () => {
  const state = {last_attempt_at:iso(NOW-5*MINUTE)};
  assert.equal(nextBackupDelay(state,NOW),BACKUP_RETRY_MS-5*MINUTE);
  assert.equal(nextBackupDelay({last_success_at:iso(NOW-2*60*MINUTE),
    last_attempt_at:iso(NOW-5*MINUTE)},NOW),BACKUP_INTERVAL_MS-2*60*MINUTE);
});

function fakeScheduler(initialState = {}, backupResult = true) {
  let current = NOW, state = { ...initialState };
  const scheduled = [];
  const history = [];
  const scheduler = createBackupScheduler({
    enabled:true,
    now:()=>current,
    readState:()=>state,
    send:async()=>{
      history.push(current);
      state.last_attempt_at=iso(current);
      if(backupResult)state.last_success_at=iso(current);
      return {ok:backupResult};
    },
    setTimer:(fn,delay)=>{
      const timer = {fn,delay,active:true,unref(){}};
      scheduled.push(timer);
      return timer;
    },
    clearTimer:(timer)=>{timer.active=false;},
  });
  return {
    scheduler,scheduled,history,
    advance:ms=>{current+=ms;},
    recent:()=>scheduled.filter(x=>x.active).at(-1),
    updateState:next=>{state={...state,...next};},
    async runNext() {
      const timer=this.recent();
      assert.ok(timer,'expected a scheduled backup check');
      timer.active=false;
      current+=timer.delay;
      await timer.fn();
    },
  };
}

test('idle process schedules one backup, then next day, without intervals',async()=>{
  const h=fakeScheduler();
  h.scheduler.start();
  h.scheduler.start();
  assert.equal(h.scheduled.length,1);
  assert.equal(h.recent().delay,BACKUP_START_DELAY_MS);
  await h.runNext();
  assert.equal(h.history.length,1);
  assert.equal(h.recent().delay,BACKUP_INTERVAL_MS);
  h.scheduler.stop();
  assert.equal(h.recent(),undefined);
});

test('successful manual backup before a pending tick suppresses duplicate auto send',async()=>{
  const h=fakeScheduler();
  h.scheduler.start();
  h.updateState({last_success_at:iso(NOW+MINUTE),last_attempt_at:iso(NOW+MINUTE)});
  await h.runNext();
  assert.equal(h.history.length,0);
  assert.ok(h.recent().delay>=BACKUP_INTERVAL_MS-MINUTE);
  h.scheduler.stop();
});

test('a failed automatic attempt waits one hour rather than storming SMTP',async()=>{
  const h=fakeScheduler({},false);
  h.scheduler.start();
  await h.runNext();
  assert.equal(h.history.length,1);
  assert.equal(h.recent().delay,BACKUP_RETRY_MS);
  h.scheduler.stop();
});

test('real backup schedule metadata survives restarts without customer data',()=>{
  db.exec('INSERT INTO backup_email_schedule(id,last_attempt_at,last_success_at) '+
    "VALUES(1,'2026-11-14T10:00:00.000Z','2026-11-14T10:01:00.000Z')");
  const row=db.prepare('SELECT * FROM backup_email_schedule WHERE id=1').get();
  assert.equal(row.last_success_at,'2026-11-14T10:01:00.000Z');
  assert.equal(nextBackupDelay(row,NOW),BACKUP_INTERVAL_MS-119*MINUTE);
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(directory,{recursive:true,force:true});
});
