'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-bot-support-'));
process.env.TG_TOKEN='mock-hvost-telegram';
process.env.MAX_BOT_TOKEN='mock-hvost-max';
process.env.MAX_BOT_USERNAME='mock-hvost-max-bot';
process.env.MAX_WEBHOOK_SECRET='mock-hvost-max-secret';
const db=require('./db');
const support=require('./bot-support');
const telegram=require('./telegram-login-poller');
const maxBot=require('./max-bot');

const adminId=db.prepare(
  "INSERT INTO admins(login,password_hash,full_name,role,active,telegram_chat_id,max_chat_id) VALUES(?,?,?,?,?,?,?)"
).run('support-test-admin','hash','Администратор','admin',1,'9188101','88001').lastInsertRowid;
const sent=[];
const originalFetch=global.fetch;
global.fetch=async (url,options={})=>{
  const body=options.body?JSON.parse(options.body):{};
  const record={url:String(url),body};
  sent.push(record);
  return {ok:true,status:200,json:async()=>({ok:true,result:true})};
};

function tg(chat,text,{sender=chat,type='private',first_name='Анна'}={}){
  return {message:{chat:{type,id:Number(chat)},from:{id:Number(sender),first_name},text}};
}
function max(chat,text,{sender=chat,chat_type='dialog',name='Андрей'}={}){
  return {update_type:'message_created',message:{
    body:{text},recipient:{chat_id:String(chat),chat_type},
    ...(sender?{sender:{user_id:String(sender),name}}:{}),
  }};
}
function ticketCount(){return db.prepare('SELECT COUNT(*) AS count FROM bot_support_tickets').get().count;}
function ticket(id){return db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(id);}
function after(index){return sent.slice(index);}
function tgSends(records){return records.filter(x=>x.url.includes('api.telegram.org/')&&x.url.endsWith('/sendMessage'));}
function maxSends(records){return records.filter(x=>x.url.includes('platform-api2.max.ru/messages?chat_id='));}

test('both command menus offer public /support, no registration needed',()=>{
  assert.ok(telegram.TELEGRAM_BOT_COMMANDS.some(x=>x.command==='support'));
  assert.ok(maxBot.MAX_BOT_COMMANDS.some(x=>x.name==='support'));
  const help=maxBot.buildMaxHelp('88002');
  assert.match(help.text,/\/support/);
  assert.ok(help.attachments[0].payload.buttons.some(row=>row[0].payload==='support:start'));
  assert.equal(support.activeAdmin('telegram','9188202'),false);
  assert.equal(support.activeAdmin('telegram','9188101'),true);
  assert.equal(support.activeAdmin('max','88001'),true);
});

test('Telegram /support prompt then client text persists numbered ticket and notifies both admin bots',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188202','/support'));
  assert.match(tgSends(after(before))[0].body.text,/Напишите одним сообщением/);
  await telegram.processUpdate(tg('9188202','Не могу войти в кабинет грумера'));
  assert.equal(ticketCount(),1);
  const row=db.prepare('SELECT * FROM bot_support_tickets ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.platform,'telegram');
  assert.equal(row.sender_name,'Анна');
  assert.match(row.body,/Не могу войти/);
  assert.equal(row.delivery_count,2);
  assert.equal(row.status,'open');
  const events=after(before);
  assert.ok(tgSends(events).some(x=>x.body.chat_id==='9188101'||x.body.chat_id===9188101));
  assert.ok(maxSends(events).some(x=>x.url.endsWith('chat_id=88001')));
  const notification=tgSends(events).find(x=>String(x.body.chat_id)==='9188101');
  assert.match(notification.body.text,/Канал: Telegram/);
  assert.match(notification.body.text,new RegExp('№'+row.id));
  assert.match(notification.body.text,/\/support_reply/);
  assert.ok(tgSends(events).some(x=>String(x.body.chat_id)==='9188202'&&x.body.text.includes('Обращение №'+row.id)));
});

test('MAX /support in a private chat collects the message and admins receive MAX/TG notifications',async()=>{
  const before=sent.length;
  await maxBot.processUpdate(max('88003','/support'));
  assert.match(maxSends(after(before))[0].body.text,/Напишите одним сообщением/);
  await maxBot.processUpdate(max('88003','Хочу узнать, как получить заказ'));
  assert.equal(ticketCount(),2);
  const row=db.prepare('SELECT * FROM bot_support_tickets ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.platform,'max');
  assert.equal(row.sender_name,'Андрей');
  assert.equal(row.delivery_count,2);
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188101'&&x.body.text.includes('Канал: MAX')));
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88001')&&x.body.text.includes('№'+row.id)));
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88003')&&x.body.text.includes('Обращение №'+row.id)));
});

test('admins can list support tickets and respond to original client across platforms',async()=>{
  const ids=db.prepare('SELECT id,platform FROM bot_support_tickets ORDER BY id').all();
  assert.equal(ids.length,2);
  const before=sent.length;
  await telegram.processUpdate(tg('9188101','/support_inbox',{first_name:'Администратор'}));
  const list=tgSends(after(before)).find(x=>String(x.body.chat_id)==='9188101');
  assert.ok(list);
  assert.match(list.body.text,/неотвеченные обращения/i);
  assert.match(list.body.text,new RegExp('№'+ids[1].id));
  await maxBot.processUpdate(max('88001','/support_reply '+ids[0].id+' Вход восстановлен',
    {name:'Администратор'}));
  assert.equal(ticket(ids[0].id).status,'answered');
  assert.equal(ticket(ids[0].id).answer,'Вход восстановлен');
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188202'&&
    x.body.text.includes('Вход восстановлен')));
  await telegram.processUpdate(tg('9188101','/support_reply '+ids[1].id+' Заказ ждёт вас в салоне'));
  assert.equal(ticket(ids[1].id).status,'answered');
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88003')&&
    x.body.text.includes('Заказ ждёт вас в салоне')));
  await maxBot.processUpdate(max('88001','/support_reply '+ids[0].id+' Дубль'));
  assert.equal(ticket(ids[0].id).answer,'Вход восстановлен');
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88001')&&
    x.body.text.includes('уже ответили')));
});

test('unlinked users cannot read tickets, send support replies or spoof bot admins',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188205','/support_inbox'));
  await telegram.processUpdate(tg('9188205','/support_reply 1 Заблокируйте его'));
  await maxBot.processUpdate(max('88005','/support_inbox'));
  await maxBot.processUpdate(max('88005','/support_reply 1 Заглушка'));
  const records=after(before);
  assert.ok(tgSends(records).some(x=>x.body.text.includes('только подключённым администраторам')));
  assert.ok(maxSends(records).some(x=>x.body.text.includes('подключённым администраторам')));
  const first=ticket(1);
  assert.equal(first.answer,'Вход восстановлен');
  const n=ticketCount();
  await telegram.processUpdate(tg('9188206','/support',{sender:'9188205'}));
  await maxBot.processUpdate(max('88006','/support',{sender:null}));
  assert.equal(ticketCount(),n);
});

test('inline support text, cancellation, cooldown, excess length and hourly throttle are handled',async()=>{
  const n=ticketCount(),before=sent.length;
  await telegram.processUpdate(tg('9188210','/support Сломан QR-код'));
  assert.equal(ticketCount(),n+1);
  await telegram.processUpdate(tg('9188210','/support Ещё одно письмо'));
  assert.equal(ticketCount(),n+1);
  assert.ok(tgSends(after(before)).some(x=>x.body.text.includes('Подождите минуту')));
  await maxBot.processUpdate(max('88010','/support'));
  await maxBot.processUpdate(max('88010','/cancel'));
  await maxBot.processUpdate(max('88010','Забытое сообщение'));
  assert.equal(ticketCount(),n+1);
  const tooLong=support.submitTicket('max','88123','88123','Клиент','x'.repeat(support.MAX_BODY_LENGTH+1));
  assert.equal(tooLong.ok,false);
  assert.equal(ticketCount(),n+1);
  const first=ticket(n+1);
  db.prepare('UPDATE bot_support_tickets SET created_at=? WHERE id=?')
    .run(Math.floor(Date.now()/1000)-3600,first.id);
  for(let i=0;i<6;i++){
    const result=support.submitTicket('telegram','9188299','9188299','Спам-тест','Тест '+i);
    assert.equal(result.ok,i<5,'after 5 requests in an hour further tickets are blocked');
    if(result.ok) {
      // Simulate time elapsed beyond the 1-minute cooldown, but still within the hour.
      db.prepare('UPDATE bot_support_tickets SET created_at=? WHERE id=?')
        .run(Math.floor(Date.now()/1000)-120,result.ticket.id);
    }
  }
  assert.ok(support.adminRecipients().length===2);
});

test('ticket survives failed delivery: it remains visible in admin inbox',async()=>{
  const old=process.env.TG_TOKEN;
  const previous=process.env.MAX_BOT_TOKEN;
  process.env.TG_TOKEN='';
  process.env.MAX_BOT_TOKEN='';
  try{
    const result=support.submitTicket('max','88124','88124','Клиент','Сайт не открывается');
    assert.equal(result.ok,true);
    const state=await support.notifyAdmins(result.ticket);
    assert.equal(state.delivered,0);
    assert.equal(state.registered,2);
    assert.equal(ticket(result.ticket.id).status,'open');
    assert.equal(ticket(result.ticket.id).delivery_count,0);
    assert.match(support.inbox('max','88001').message,new RegExp('№'+result.ticket.id));
    assert.match(support.confirmation(result.ticket,state),/сохранено/);
  }finally{
    process.env.TG_TOKEN=old;process.env.MAX_BOT_TOKEN=previous;
  }
});

test.after(()=>{
  global.fetch=originalFetch;
  try{db.close()}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});