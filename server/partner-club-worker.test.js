'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-club-worker-'));
process.env.DATA_DIR=directory;
const db=require('./db');
const club=require('./routes-partner-club');
const telegram=require('./telegram');

test('new sales wake moderation; idle polling and retry are adaptive, disabled drafts do not block sales',async()=>{
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
    assert.equal([...timers.values()][0].delay,300000,'empty queue checks every five minutes');

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
    assert.equal([...timers.values()][0].delay,300000);

    assert.equal(sale(91002),true);
    failNext=true;
    await tick();
    assert.equal([...timers.values()][0].delay,30000,'failed Telegram send gets a bounded retry');
    assert.equal(db.prepare("SELECT 1 FROM partner_club_reviews r JOIN partner_club_events e ON e.id=r.event_id WHERE e.event_key='paid:91002'").get(),undefined);
    await tick();
    assert.ok(db.prepare("SELECT 1 FROM partner_club_reviews r JOIN partner_club_events e ON e.id=r.event_id WHERE e.event_key='paid:91002'").get());
    assert.equal([...timers.values()][0].delay,300000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_club_reviews").get().n,2);
  } finally {
    global.setTimeout=oldSet;
    global.clearTimeout=oldClear;
    telegram.sendToChat=oldSend;
    db.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
