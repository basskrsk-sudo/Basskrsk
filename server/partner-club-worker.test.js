'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-club-worker-'));
process.env.DATA_DIR=directory;
const db=require('./db');
const club=require('./routes-partner-club');
const telegram=require('./telegram');

test('disabled Club skips automatic drafts; local daily record wakes at midnight only',()=>{
  const noon=Date.parse('2026-11-19T06:00:00Z'); // 13:00 Krasnoyarsk
  assert.equal(club.nextClubDailyCheckDelay(noon),11*60*60*1000+5000);
  assert.equal(club.nextClubDailyCheckDelay(Date.parse('2026-11-19T16:59:59Z')),6000);
  const before=db.prepare('SELECT COUNT(*) AS n FROM partner_club_events').get().n;
  const prior=db.prepare('SELECT config_json FROM partner_club_settings WHERE id=1').get();
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json')
    .run(JSON.stringify({enabled:false,chat_id:null,sales:true,first_sale:true,record_check:true,new_points:true}));
  try{
    assert.equal(club.recordPaidOrder({
      id:70001,status:'paid',point_id:null,pickup_point:'Салон',
      refund_status:'none',total:250,
    },[{name:'Лёгкое говяжье',qty:1}]),false);
    assert.equal(club.welcomeNewPoint({id:'disabled-point',name:'Отключена'}),false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_club_events').get().n,before);
  }finally{
    if(prior)db.prepare('UPDATE partner_club_settings SET config_json=? WHERE id=1').run(prior.config_json);
    else db.prepare('DELETE FROM partner_club_settings WHERE id=1').run();
  }
});
test('sales wake the parked Club worker, retries remain punctual and disabled types never block',async()=>{
  const admin=Number(db.prepare(
    'INSERT INTO admins(login,password_hash,role,telegram_chat_id,active) VALUES (?,?,?,?,1)'
  ).run('club-worker-test','hash','super','990099').lastInsertRowid);
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?)').run(JSON.stringify({
    enabled:true,chat_id:'-100200',reviewer_admin_id:admin,
    club_started_at:'2026-01-01 00:00:00',sales:true,first_sale:false,
    record_day:false,record_check:false,daily:false,weekly:false
  }));
  const messages=[];
  let failNext=false;
  const oldSend=telegram.sendToChat,oldSet=global.setTimeout,oldClear=global.clearTimeout;
  const timers=new Map();
  let nextTimerId=0;
  global.setTimeout=(fn,delay)=>{
    const handle={id:++nextTimerId,delay,fn,unref(){}};
    timers.set(handle.id,handle);
    return handle;
  };
  global.clearTimeout=handle=>{if(handle)timers.delete(handle.id);};
  telegram.sendToChat=async(chat,text)=>{
    messages.push({chat:String(chat),text});
    if(failNext){failNext=false;return {ok:false,error:'Telegram temporarily down'};}
    return {ok:true,data:{ok:true}};
  };
  async function tick(){
    const timer=[...timers.values()].sort((a,b)=>a.delay-b.delay)[0];
    assert.ok(timer,'a timer should be scheduled');
    timers.delete(timer.id);
    timer.fn();
    await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
    return timer.delay;
  }
  const sale=id=>club.recordPaidOrder({
    id,status:'paid',refund_status:'none',point_id:null,pickup_point:'Дог Стиль',
    is_partner_self_order:0,total:250,yookassa_payment_id:null
  },[{name:'Лёгкое говяжье',qty:1}]);
  try{
    club.startPartnerClubWorker();
    club.startPartnerClubWorker();
    assert.equal(timers.size,1,'only one worker timer');
    assert.equal(await tick(),0,'restart checks pending drafts immediately');
    assert.equal(timers.size,0,'no daily record or drafts: worker parks without a timer');

    // Inactive, older drafts must not starve an eligible new sale.
    for(let i=0;i<7;i++){
      db.prepare("INSERT INTO partner_club_events(event_key,event_type,message) VALUES (?, 'daily', 'old')").run('old-daily-'+i);
    }
    assert.equal(sale(91001),true);
    assert.equal(timers.size,1);
    assert.equal([...timers.values()][0].delay,250);
    assert.equal(await tick(),250);
    assert.equal(messages.length,1);
    assert.equal(messages[0].chat,'990099');
    assert.match(messages[0].text,/Дог Стиль/);
    assert.ok(db.prepare("SELECT 1 FROM partner_club_reviews r JOIN partner_club_events e ON e.id=r.event_id WHERE e.event_key='paid:91001'").get());
    assert.equal(timers.size,0,'after processing the sale, the worker parks again');

    assert.equal(sale(91002),true);
    failNext=true;
    await tick();
    assert.equal([...timers.values()][0].delay,30000,'failed Telegram send gets a bounded retry');
    assert.equal(db.prepare("SELECT 1 FROM partner_club_reviews r JOIN partner_club_events e ON e.id=r.event_id WHERE e.event_key='paid:91002'").get(),undefined);
    await tick();
    assert.ok(db.prepare("SELECT 1 FROM partner_club_reviews r JOIN partner_club_events e ON e.id=r.event_id WHERE e.event_key='paid:91002'").get());
    assert.equal(timers.size,0,'after successful retry, worker parks');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_club_reviews").get().n,2);
  } finally {
    club.stopPartnerClubWorker();
    global.setTimeout=oldSet;
    global.clearTimeout=oldClear;
    telegram.sendToChat=oldSend;
    db.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
