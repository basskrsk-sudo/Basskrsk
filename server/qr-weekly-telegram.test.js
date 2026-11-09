'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-qr-scheduler-'));
process.env.TG_TOKEN='test-token-not-real';
process.env.TG_CHAT_ID='123';
const db=require('./db');
const {previousCompletedWeek,sendWeeklyQrReport}=require('./qr-weekly-telegram');

test('already delivered weekly QR report skips SQLite aggregation on every subsequent minute',async()=>{
  const now=new Date('2026-11-09T02:06:00.000Z'); // Monday 09:06 Krasnoyarsk
  const week=previousCompletedWeek(now);
  assert.deepEqual([week.weekStart,week.weekEnd],['2026-11-02','2026-11-08']);
  assert.equal(new Date(week.dueUtcMs).toISOString(),'2026-11-09T02:00:00.000Z');
  db.prepare('UPDATE qr_weekly_telegram_schedule SET activated_at=? WHERE id=1')
    .run('2026-10-01T00:00:00.000Z');
  db.prepare('INSERT INTO qr_weekly_telegram_delivery '+
    '(week_start,week_end,summary_sent_at,file_sent_at) VALUES(?,?,?,?)')
    .run(week.weekStart,week.weekEnd,'2026-11-09 02:00:00','2026-11-09 02:00:01');

  // Deliberately make the expensive report query impossible. The scheduler
  // must still return "already delivered" without touching the funnel table.
  // This is an isolated, temporary test database — not production data.
  db.exec('DROP TABLE qr_funnel_events');
  for(const offsetSeconds of [0,60,120,300]){
    const result=await sendWeeklyQrReport({now:new Date(now.getTime()+offsetSeconds*1000)});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.skipped,true);
    assert.equal(result.week,week.weekStart);
    assert.match(result.message,/Отчёт уже доставлен/);
  }
  const delivery=db.prepare(
    'SELECT summary_sent_at,file_sent_at,last_error FROM qr_weekly_telegram_delivery WHERE week_start=?'
  ).get(week.weekStart);
  assert.equal(delivery.last_error,null);
  assert.equal(delivery.summary_sent_at,'2026-11-09 02:00:00');
  assert.equal(delivery.file_sent_at,'2026-11-09 02:00:01');
});

test('QR report is not sent early before the Monday schedule',async()=>{
  const before=new Date('2026-11-09T01:59:59.000Z');
  const result=await sendWeeklyQrReport({now:before});
  assert.equal(result.ok,false);
  assert.equal(result.skipped,true);
  assert.equal(result.reason,'Время отчёта ещё не наступило');
});
