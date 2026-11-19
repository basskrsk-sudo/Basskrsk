'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-bot-support-conversation-'));
process.env.TG_TOKEN='mock-hvost-telegram';
process.env.MAX_BOT_TOKEN='mock-hvost-max';
process.env.MAX_BOT_USERNAME='mock-hvost-max-bot';
process.env.MAX_WEBHOOK_SECRET='mock-hvost-max-secret';
const db=require('./db');
const support=require('./bot-support');
const telegram=require('./telegram-login-poller');
const maxBot=require('./max-bot');

db.prepare(
  "INSERT INTO admins(login,password_hash,full_name,role,active,telegram_chat_id,max_chat_id) VALUES(?,?,?,?,?,?,?)"
).run('support-test-admin','hash','Администратор','admin',1,'9188101','88001');
const sent=[];
const originalFetch=global.fetch;
global.fetch=async (url,options={})=>{
  const body=options.body?JSON.parse(options.body):{};
  sent.push({url:String(url),body});
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
function count(){return db.prepare('SELECT COUNT(*) AS count FROM bot_support_tickets').get().count;}
function ticket(num){return db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(num);}
function messages(num){return db.prepare('SELECT role,body,platform,chat_id FROM bot_support_messages WHERE ticket_id=? ORDER BY id').all(num);}
function lastTicket(){return db.prepare('SELECT * FROM bot_support_tickets ORDER BY id DESC LIMIT 1').get();}
function after(n){return sent.slice(n);}
function tgSends(events){return events.filter(x=>x.url.includes('api.telegram.org/')&&x.url.endsWith('/sendMessage'));}
function maxSends(events){return events.filter(x=>x.url.includes('platform-api2.max.ru/messages?chat_id='));}
let tgTicketId,maxTicketId;

test('both bots expose /support and reject spoofed access to admin tickets',()=>{
  assert.ok(telegram.TELEGRAM_BOT_COMMANDS.some(x=>x.command==='support'));
  assert.ok(maxBot.MAX_BOT_COMMANDS.some(x=>x.name==='support'));
  assert.ok(maxBot.buildMaxHelp('88002').attachments[0].payload.buttons
    .some(row=>row[0].payload==='support:start'));
  assert.equal(support.activeAdmin('telegram','9188202'),false);
  assert.equal(support.activeAdmin('telegram','9188101'),true);
  assert.equal(support.activeAdmin('max','88001'),true);
});

test('Telegram wizard requires point name, contact phone, then issue and notifies admins on both platforms',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188202','/support'));
  assert.match(tgSends(after(before)).at(-1).body.text,/название точки/);
  await telegram.processUpdate(tg('9188202','БаркЛай'));
  assert.match(tgSends(after(before)).at(-1).body.text,/телефон/);
  await telegram.processUpdate(tg('9188202','abc'));
  assert.match(tgSends(after(before)).at(-1).body.text,/Укажите телефон/);
  assert.equal(count(),0);
  await telegram.processUpdate(tg('9188202','+7 (913) 123-45-67'));
  assert.match(tgSends(after(before)).at(-1).body.text,/Опишите ваш вопрос/);
  await telegram.processUpdate(tg('9188202','Не могу войти в кабинет грумера'));
  assert.equal(count(),1);
  const row=lastTicket();tgTicketId=row.id;
  assert.equal(row.platform,'telegram');
  assert.equal(row.sender_name,'Анна');
  assert.equal(row.point_name,'БаркЛай');
  assert.equal(row.contact_phone,'+79131234567');
  assert.match(row.body,/Не могу войти/);
  assert.equal(row.delivery_count,2);
  assert.equal(row.status,'open');
  assert.deepEqual(messages(row.id).map(x=>x.role),['client']);
  const notifications=tgSends(after(before)).filter(x=>String(x.body.chat_id)==='9188101');
  assert.equal(notifications.length,1);
  assert.match(notifications[0].body.text,/Точка: БаркЛай/);
  assert.match(notifications[0].body.text,/Телефон: \+79131234567/);
  assert.match(notifications[0].body.text,/\/support_close/);
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88001')&&
    x.body.text.includes('БаркЛай')));
});

test('MAX supports /support inline issue but still collects point and callback phone',async()=>{
  const before=sent.length;
  await maxBot.processUpdate(max('88003','/support Хочу узнать, как получить заказ'));
  assert.match(maxSends(after(before)).at(-1).body.text,/название точки/);
  await maxBot.processUpdate(max('88003','Лапочки'));
  assert.match(maxSends(after(before)).at(-1).body.text,/телефон/);
  await maxBot.processUpdate(max('88003','8 913 222 11 00'));
  assert.equal(count(),2,'inline issue completes the ticket after phone without an extra step');
  const row=lastTicket();maxTicketId=row.id;
  assert.equal(row.platform,'max');
  assert.equal(row.sender_name,'Андрей');
  assert.equal(row.point_name,'Лапочки');
  assert.equal(row.contact_phone,'+79132221100');
  assert.match(row.body,/получить заказ/);
  assert.equal(row.status,'open');
  assert.equal(row.delivery_count,2);
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188101'&&
    x.body.text.includes('Канал: MAX')));
});

test('support replies in either bot remain open, later plain texts and explicit additions use the same ticket',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188101','/support_inbox',{first_name:'Администратор'}));
  const inbox=tgSends(after(before)).find(x=>String(x.body.chat_id)==='9188101'&&
    x.body.text.includes('открытые обращения'));
  assert.ok(inbox);
  assert.match(inbox.body.text,/Точка: Лапочки/);
  assert.match(inbox.body.text,/Телефон:/);
  await maxBot.processUpdate(max('88001','/support_reply '+tgTicketId+' Проверьте вход повторно',
    {name:'Администратор'}));
  assert.equal(ticket(tgTicketId).status,'open','first support answer does not close the ticket');
  assert.equal(ticket(tgTicketId).answer,'Проверьте вход повторно');
  assert.deepEqual(messages(tgTicketId).map(x=>x.role),['client','admin']);
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188202'&&
    x.body.text.includes('Проверьте вход повторно')));
  await telegram.processUpdate(tg('9188202','Я попробовал, проблема осталась'));
  assert.equal(count(),2,'plain client follow-up does not create another ticket');
  assert.deepEqual(messages(tgTicketId).map(x=>x.role),['client','admin','client']);
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88001')&&
    x.body.text.includes('Я попробовал')));
  await telegram.processUpdate(tg('9188101','/support_reply '+tgTicketId+' Уточните версию приложения'));
  assert.deepEqual(messages(tgTicketId).map(x=>x.role),['client','admin','client','admin']);
  assert.equal(ticket(tgTicketId).status,'open');
  await maxBot.processUpdate(max('88003','/support_add '+maxTicketId+' Приложение обновилось, но заказ не виден'));
  assert.deepEqual(messages(maxTicketId).map(x=>x.role),['client','client']);
  assert.equal(ticket(maxTicketId).status,'open');
  const historyAdmin=support.history('telegram','9188101','9188101',tgTicketId);
  assert.match(historyAdmin.message,/Точка: БаркЛай/);
  assert.match(historyAdmin.message,/Проверьте вход повторно/);
  assert.match(historyAdmin.message,/Я попробовал/);
  assert.match(historyAdmin.message,/Уточните версию/);
  assert.match(historyAdmin.message,new RegExp('support_reply '+tgTicketId));
  const historyClient=support.history('max','88003','88003',maxTicketId);
  assert.match(historyClient.message,/Лапочки/);
  assert.match(historyClient.message,/Приложение обновилось/);
  assert.match(historyClient.message,new RegExp('support_add '+maxTicketId));
});

test('ticket owner and authorized admin may close it explicitly, reply to closed ticket blocked',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188101','/support_close '+maxTicketId));
  assert.equal(ticket(maxTicketId).status,'answered');
  assert.ok(ticket(maxTicketId).closed_at);
  assert.match(ticket(maxTicketId).closed_by,/admin/);
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88003')&&
    x.body.text.includes('закрыто поддержкой')));
  await maxBot.processUpdate(max('88001','/support_reply '+maxTicketId+' Ответ после закрытия'));
  assert.equal(messages(maxTicketId).length,2);
  assert.ok(maxSends(after(before)).some(x=>x.url.endsWith('chat_id=88001')&&
    x.body.text.includes('закрыто')));
  await telegram.processUpdate(tg('9188202','/support_close '+tgTicketId));
  assert.equal(ticket(tgTicketId).status,'answered');
  assert.match(ticket(tgTicketId).closed_by,/client/);
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188101'&&
    x.body.text.includes('закрыто клиентом')));
  await telegram.processUpdate(tg('9188202','/support_add '+tgTicketId+' ещё сообщение'));
  assert.equal(messages(tgTicketId).length,4);
  assert.equal(support.history('telegram','9188202','9188202',tgTicketId).ok,true,
    'owner can still read their closed history');
});

test('another user cannot read or modify ticket and cannot impersonate an administrator',async()=>{
  const before=sent.length;
  await telegram.processUpdate(tg('9188205','/support_inbox'));
  await telegram.processUpdate(tg('9188205','/support_reply '+tgTicketId+' Заблокируйте его'));
  await telegram.processUpdate(tg('9188205','/support_history '+tgTicketId));
  await telegram.processUpdate(tg('9188205','/support_close '+tgTicketId));
  await telegram.processUpdate(tg('9188205','/support_add '+tgTicketId+' Чужое обращение'));
  await maxBot.processUpdate(max('88005','/support_inbox'));
  await maxBot.processUpdate(max('88005','/support_reply '+maxTicketId+' Заглушка'));
  await maxBot.processUpdate(max('88005','/support_history '+maxTicketId));
  assert.equal(messages(tgTicketId).length,4);
  assert.equal(messages(maxTicketId).length,2);
  assert.ok(tgSends(after(before)).some(x=>x.body.text.includes('только подключённым администраторам')));
  assert.ok(maxSends(after(before)).some(x=>x.body.text.includes('подключённым администраторам')));
  await telegram.processUpdate(tg('9188206','/support',{sender:'9188205'}));
  await maxBot.processUpdate(max('88006','/support',{sender:null}));
  assert.equal(count(),2);
});

test('cancel, timeout, length and one-hour new ticket/message limits protect bots',async()=>{
  const before=sent.length;
  await maxBot.processUpdate(max('88010','/support'));
  await maxBot.processUpdate(max('88010','/cancel'));
  await maxBot.processUpdate(max('88010','Игнорировать'));
  assert.equal(count(),2);
  const started=support.startDraft('max','88127','88127');
  assert.equal(started.ok,true);
  db.prepare('UPDATE bot_support_drafts SET created_at=? WHERE platform=? AND chat_id=?')
    .run(Math.floor(Date.now()/1000)-support.DRAFT_TTL-1,'max','88127');
  assert.match(support.consumeDraft('max','88127','88127','Клиент','Салон').message,/истекло/);
  assert.equal(support.submitTicket('max','88123','88123','Клиент','x'.repeat(support.MAX_BODY_LENGTH+1),
    'Пушок','79132224455').ok,false);
  for(let i=0;i<6;i++){
    const result=support.submitTicket('telegram','9188299','9188299','Спам-тест',
      'Тест '+i,'Тестовый салон','79138889900');
    assert.equal(result.ok,i<5,'five tickets/hour, after closing each');
    if(result.ok){
      db.prepare("UPDATE bot_support_tickets SET status='answered',created_at=? WHERE id=?")
        .run(Math.floor(Date.now()/1000)-120,result.ticket.id);
    }
  }
  assert.ok(support.adminRecipients().length===2);
  assert.ok(tgSends(after(before)).some(x=>String(x.body.chat_id)==='9188205')===false);
});

test('failed admin notification does not lose an open ticket or its reply history',async()=>{
  const oldTg=process.env.TG_TOKEN,oldMax=process.env.MAX_BOT_TOKEN;
  process.env.TG_TOKEN='';process.env.MAX_BOT_TOKEN='';
  try{
    const result=support.submitTicket('max','88124','88124','Клиент','Сайт не открывается',
      'Мистер Лапсик','79132224466');
    assert.equal(result.ok,true);
    const state=await support.notifyAdmins(result.ticket);
    assert.equal(state.delivered,0);
    assert.equal(state.registered,2);
    assert.equal(ticket(result.ticket.id).status,'open');
    assert.equal(ticket(result.ticket.id).delivery_count,0);
    assert.match(support.inbox('max','88001').message,new RegExp('№'+result.ticket.id));
    assert.match(support.confirmation(result.ticket,state),/сохранено/);
    const append=support.appendToOpenTicket('max','88124','88124','Вторая деталь');
    assert.equal(append.ok,true);
    assert.equal(append.followup,true);
    assert.equal(messages(result.ticket.id).length,2);
  }finally{
    process.env.TG_TOKEN=oldTg;process.env.MAX_BOT_TOKEN=oldMax;
  }
});

test('ticket history can display more than 10 messages using page number',()=>{
  const open=support.getOpenTicket('max','88124','88124');
  assert.ok(open);
  for(let i=0;i<13;i++){
    assert.equal(support.appendToOpenTicket('max','88124','88124','Уточнение '+i).ok,true);
  }
  const page1=support.history('max','88124','88124',open.id);
  const page2=support.history('max','88124','88124',open.id,2);
  assert.match(page1.message,/страница 1/);
  assert.match(page1.message,new RegExp('/support_history '+open.id+' 2'));
  assert.match(page2.message,/страница 2/);
  assert.match(page2.message,/Сайт не открывается/);
  assert.equal(support.history('max','88005','88005',open.id).ok,false);
});

test('restart backfills historic single-message answered tickets without duplicating history',()=>{
  const info=db.prepare(
    "INSERT INTO bot_support_tickets(platform,chat_id,sender_id,sender_name,body,created_at,status,answer,answered_at,answered_by) VALUES (?,?,?,?,?,?,'answered',?,?,?)"
  ).run('telegram','991202','991202','Старый клиент','Ранее заданный вопрос',
    Math.floor(Date.now()/1000)-1000,'Ранее отправленный ответ',Math.floor(Date.now()/1000)-900,'telegram:9188101');
  const ticketId=Number(info.lastInsertRowid);
  const modulePath=require.resolve('./bot-support');
  delete require.cache[modulePath];
  const restarted=require('./bot-support');
  assert.equal(messages(ticketId).length,2);
  assert.equal(restarted.history('telegram','991202','991202',ticketId).ok,true);
  delete require.cache[modulePath];require('./bot-support');
  assert.equal(messages(ticketId).length,2,'migration must be idempotent');
});

test.after(()=>{
  global.fetch=originalFetch;
  try{db.close()}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});