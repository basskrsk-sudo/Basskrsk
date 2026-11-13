'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createDailySalesRecords,bounds}=require('./partner-club-daily-records');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE points(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT,status TEXT,yookassa_payment_id TEXT,
      is_partner_self_order INTEGER DEFAULT 0, refund_status TEXT DEFAULT 'none',
      total INTEGER,refunded_amount INTEGER DEFAULT 0,created_at TEXT NOT NULL
    );`);
  db.prepare('INSERT INTO points(id,name) VALUES(?,?)').run('lapochki','Лапочки');
  db.prepare('INSERT INTO points(id,name) VALUES(?,?)').run('barsik','Сэр Барсик');
  const service=createDailySalesRecords(db);
  let number=0;
  const add=(datetime,point='lapochki',opts={})=>db.prepare(`
    INSERT INTO orders(point_id,status,yookassa_payment_id,
      is_partner_self_order,refund_status,total,refunded_amount,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
      point,opts.status||'paid',opts.demo?null:'payment-'+(++number),
      opts.self?1:0,opts.refunded?'refunded':'none',250,
      Number(opts.refundAmount||0),datetime).lastInsertRowid;
  return {db,service,add,close:()=>db.close()};
}
const now=new Date('2026-11-03T10:00:00.000Z');

test('Krasnoyarsk day boundaries split 17:00 UTC correctly',()=>{
  const b=bounds(now);
  assert.equal(b.today,'2026-11-03');
  assert.equal(b.yesterday,'2026-11-02');
  assert.equal(b.yesterdayStart,'2026-11-01 17:00:00');
  assert.equal(b.todayStart,'2026-11-02 17:00:00');
  assert.equal(b.tomorrowStart,'2026-11-03 17:00:00');
});
test('metrics track maximum daily sales and strongest point alongside maximum receipt',()=>{
  const f=fixture();
  try{
    f.add('2026-11-01 16:59:59','barsik');
    f.add('2026-11-01 17:00:00');
    f.add('2026-11-02 00:00:00');
    f.add('2026-11-02 16:59:59','barsik');
    f.add('2026-11-02 11:00:00','barsik',{demo:true});
    f.add('2026-11-02 11:01:00','barsik',{self:true});
    f.add('2026-11-02 11:02:00','barsik',{status:'pending'});
    f.add('2026-11-02 11:03:00','barsik',{refunded:true});
    f.add('2026-11-02 11:04:00','barsik',{refundAmount:250});
    f.add('2026-11-02 17:00:00');
    const data=f.service.metrics(now);
    assert.equal(data.timezone,'Asia/Krasnoyarsk');
    assert.deepEqual(data.max_daily_sales,{day:'2026-11-02',sales:3});
    assert.deepEqual(data.max_point_daily_sales,{
      day:'2026-11-02',sales:2,point_id:'lapochki',point_name:'Лапочки',
    });
    assert.equal(data.today_sales,1);
    assert.equal(data.yesterday_sales,3);
    assert.equal(data.max_check,250);
    assert.ok(!JSON.stringify(data).includes('payment-'));
  }finally{f.close();}
});
test('one moderated record draft per completed day, no duplicate or baseline alert',()=>{
  const f=fixture(),queued=[];
  const cfg={record_day:true,enabled:true,chat_id:'-100100',
    club_started_at:'2026-11-01 00:00:00'};
  try{
    f.add('2026-11-01 15:00:00');
    f.add('2026-11-01 17:30:00');
    f.add('2026-11-01 18:00:00','barsik');
    const enqueue=(...args)=>{queued.push(args);return true;};
    assert.equal(f.service.checkYesterday(now,cfg,enqueue),true);
    assert.equal(queued.length,1);
    assert.equal(queued[0][0],'record-day:2026-11-02:2');
    assert.equal(queued[0][1],'record_day');
    assert.match(queued[0][2],/02\.11\.2026/);
    assert.match(queued[0][2],/Предыдущий рекорд: 1/);
    assert.match(queued[0][2],/Продаж за день: 2/);
    assert.equal(f.service.validate(queued[0][0],now),true);
    assert.equal(f.service.checkYesterday(now,cfg,enqueue),false);
    assert.equal(queued.length,1);
    f.db.prepare("UPDATE orders SET refund_status='refunded' WHERE point_id='barsik' AND created_at='2026-11-01 18:00:00'").run();
    assert.equal(f.service.validate(queued[0][0],now),false);
    assert.equal(f.service.checkYesterday(now,cfg,enqueue),false);
  }finally{f.close();}
});
test('do not announce first-ever day, tied records or dates before club activation',()=>{
  let calls=0;
  const cfg={record_day:true,enabled:true,chat_id:'-100100',
    club_started_at:'2026-11-01 00:00:00'};
  const f=fixture();
  try{
    f.add('2026-11-01 18:00:00');
    assert.equal(f.service.checkYesterday(now,cfg,()=>{calls++;return true}),false);
    assert.equal(calls,0);
  }finally{f.close();}
  const g=fixture();
  try{
    g.add('2026-11-01 15:00:00');
    g.add('2026-11-01 18:00:00');
    assert.equal(g.service.checkYesterday(now,cfg,()=>{calls++;return true}),false);
    assert.equal(calls,0);
  }finally{g.close();}
  const k=fixture();
  try{
    k.add('2026-11-01 14:00:00');
    k.add('2026-11-01 18:00:00');
    k.add('2026-11-01 18:30:00');
    assert.equal(k.service.checkYesterday(now,{...cfg,club_started_at:'2026-11-02 08:00:00'},()=>{calls++;return true}),false);
    assert.equal(calls,0);
  }finally{k.close();}
});
test('disabled record check does not mark the day as checked',()=>{
  const f=fixture();let calls=0;
  try{
    assert.equal(f.service.checkYesterday(now,{
      enabled:false,record_day:true,chat_id:'-100100',
      club_started_at:'2026-11-01 00:00:00',
    },()=>{calls++;return true}),false);
    assert.equal(calls,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM partner_club_daily_record_checks').get().n,0);
  }finally{f.close();}
});
