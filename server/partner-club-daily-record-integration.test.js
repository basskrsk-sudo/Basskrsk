'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-club-daily-record-'));
process.env.DATA_DIR=dir;
const db=require('./db');
const club=require('./routes-partner-club');
const telegram=require('./telegram');
const {bounds}=require('./partner-club-daily-records');

const current=new Date();
const day=bounds(current);
const toSql=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
const yesterdayStart=Date.parse(day.yesterdayStart.replace(' ','T')+'Z');
const earlier=toSql(yesterdayStart-86400000+3600000);
const yesterdayFirst=toSql(yesterdayStart+3600000);
const yesterdaySecond=toSql(yesterdayStart+7200000);
let sequence=0;
function paid(createdAt,point='lapochki'){
  const id=++sequence;
  return Number(db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,'+
    'point_id,subtotal,total,payment_method,status,yookassa_payment_id,created_at) '+
    'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run('DAILY-RECORD-'+id,'Клиент','79990000000','Лапочки',
    point,250,250,'sbp','paid','pay-daily-'+id,createdAt).lastInsertRowid);
}

db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)')
  .run('lapochki','Лапочки','Красноярск, Тестовая 1','🐾');
const adminId=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role) VALUES (?,?,?,?,?)'
).run('daily-record-admin','hash','Модератор','332200','super').lastInsertRowid);
db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)').run(JSON.stringify({
  enabled:true,chat_id:'-100200',reviewer_admin_id:adminId,
  club_started_at:toSql(yesterdayStart-2*86400000),
  record_day:true,record_check:true,sales:true,
}));
paid(earlier);
paid(yesterdayFirst);
paid(yesterdaySecond);

test('daily record enters same moderated workflow as receipt record',async()=>{
  const created=club.checkDailySalesRecord(current);
  assert.equal(created,true);
  const ev=db.prepare(
    "SELECT * FROM partner_club_events WHERE event_type='record_day'"
  ).get();
  assert.ok(ev);
  assert.equal(ev.event_key,'record-day:'+day.yesterday+':2');
  assert.match(ev.message,/Продаж за день: 2/);
  assert.match(ev.message,/Лапочки/);
  assert.equal(club.checkDailySalesRecord(current),false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM partner_club_events WHERE event_type='record_day'").get().n,1);
  const metric=club.analytics('week').records;
  assert.equal(metric.max_daily_sales.day,day.yesterday);
  assert.equal(metric.max_daily_sales.sales,2);
  assert.equal(metric.max_point_daily_sales.point_name,'Лапочки');
  assert.match(club.preview('record_day',{point:'Лапочки',count:4}),/рекорд/i);
  const posts=[];
  const old=telegram.sendToChat;
  telegram.sendToChat=async(chat,html)=>{posts.push({chat:String(chat),html});return {ok:true,data:{ok:true}}};
  try {
    db.prepare("INSERT INTO partner_club_reviews(event_id,state,reviewer_chat_id) VALUES(?,'pending',?)")
      .run(ev.id,'332200');
    assert.doesNotMatch(club.preview('record_day',{count:4}),/\+\-/);
    assert.equal((await club.handleClubCallback('999','club:send:'+ev.id)).ok,false);
    assert.equal(posts.length,0);
    const approved=await club.handleClubCallback('332200','club:send:'+ev.id);
    assert.equal(approved.ok,true);
    assert.equal(posts.length,1);
    assert.equal(posts[0].chat,'-100200');
    assert.match(posts[0].html,/рекорд ХвостМаркета/i);
    assert.equal((await club.handleClubCallback('332200','club:send:'+ev.id)).ok,false);
    assert.equal(posts.length,1);
  } finally {telegram.sendToChat=old;}
});

test.after(()=>{
  try{db.close()}catch(_){}
  fs.rmSync(dir,{recursive:true,force:true});
});
