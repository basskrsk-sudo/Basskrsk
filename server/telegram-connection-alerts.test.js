'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-bot-connection-alerts-'));
const {
  ensureBotConnectionAlertTables,bindTelegramAccount,
  flushBotConnectionAlerts,formatConnectionAlert,
}=require('./telegram-connection-alerts');

function fixture(){
  const database=new DatabaseSync(':memory:');
  database.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE admins (id INTEGER PRIMARY KEY,login TEXT,full_name TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE customers (id INTEGER PRIMARY KEY,name TEXT,lname TEXT,phone TEXT,telegram_chat_id TEXT);',
    'CREATE TABLE partners (id INTEGER PRIMARY KEY,full_name TEXT,point_name TEXT,phone TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE salon_owners (id INTEGER PRIMARY KEY,full_name TEXT,phone TEXT,point_id TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE managers (id INTEGER PRIMARY KEY,full_name TEXT,phone TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE business_founders (id INTEGER PRIMARY KEY,full_name TEXT,phone TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE task_assignees (id INTEGER PRIMARY KEY,full_name TEXT,phone TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE points (id TEXT PRIMARY KEY,name TEXT);',
    "INSERT INTO points VALUES ('zveryuga','Zveryuga');",
    "INSERT INTO admins(id,login,full_name,telegram_chat_id,active) VALUES (1,'admin','Админ Один','77001',1),(2,'second','Админ Два','77002',1),(3,'closed','Админ Отключён','77003',0);",
    "INSERT INTO partners VALUES (10,'<Ирина & Мария>','Zveryuga','79135550014',NULL,1);",
    "INSERT INTO customers VALUES (11,'Покупатель','Пример','79135550015',NULL);",
    "INSERT INTO salon_owners VALUES (12,'Владелец салона','79135550016','zveryuga',NULL,1);",
    "INSERT INTO managers VALUES (13,'Ангелина Функ','79135550017',NULL,1);",
    "INSERT INTO business_founders VALUES (14,'Лакомых Алексей','79135550018',NULL,1);",
    "INSERT INTO task_assignees VALUES (15,'Николай','79135550019',NULL,1);",
  ].join(' '));
  ensureBotConnectionAlertTables(database);
  return database;
}
function settings(database,extra={}){
  return {database,deferDelivery:true,businessChatId:'77002',...extra};
}
function count(database,table){
  return database.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
}

test('one alert per newly connected or reconnected role account, never per repeat login',async()=>{
  const database=fixture();
  const initial=bindTelegramAccount('partner',10,'10010',settings(database));
  assert.equal(initial.changed,true);
  assert.equal(initial.recipients,2);
  assert.equal(count(database,'bot_connection_events'),1);
  assert.equal(count(database,'bot_connection_deliveries'),2);
  assert.equal(database.prepare('SELECT telegram_chat_id FROM partners WHERE id=10').get().telegram_chat_id,'10010');
  const event=database.prepare('SELECT * FROM bot_connection_events').get();
  assert.equal(event.role,'partner');
  assert.equal(event.role_label,'Грумер');
  assert.equal(event.account_name,'<Ирина & Мария>');
  assert.equal(event.phone_masked,'+7 (***) ***-**-14');
  assert.equal(event.salon_name,'Zveryuga');
  const message=formatConnectionAlert(event);
  assert.match(message,/Новое подключение Telegram-бота/);
  assert.match(message,/&lt;Ирина &amp; Мария&gt;/);
  assert.doesNotMatch(message,/<Ирина & Мария>/);
  assert.doesNotMatch(message,/79135550014/);
  assert.equal(bindTelegramAccount('partner',10,'10010',settings(database)).changed,false);
  assert.equal(count(database,'bot_connection_events'),1);
  const next=bindTelegramAccount('partner',10,'20010',settings(database));
  assert.equal(next.changed,true);
  assert.match(formatConnectionAlert(database.prepare('SELECT * FROM bot_connection_events WHERE id=?').get(next.eventId)),/переподключён/);
  assert.equal(count(database,'bot_connection_events'),2);
  database.close();
});

test('alert goes to configured admin chat and individual active admins; duplicates are removed',async()=>{
  const database=fixture();
  bindTelegramAccount('customer',11,'10011',settings(database));
  const deliveries=[];
  const send=async(chat,message)=>{deliveries.push({chat,message});return {ok:true};};
  const summary=await flushBotConnectionAlerts({database,sendToChat:send,businessChatId:'77002'});
  assert.deepEqual(summary,{sent:2,failed:0,cancelled:0});
  assert.deepEqual(deliveries.map(d=>d.chat).sort(),['77001','77002']);
  assert.ok(deliveries.every(d=>/Покупатель/.test(d.message)));
  assert.equal(count(database,'bot_connection_deliveries'),2);
  assert.equal(database.prepare("SELECT COUNT(*) n FROM bot_connection_deliveries WHERE state='sent'").get().n,2);
  assert.deepEqual(await flushBotConnectionAlerts({database,sendToChat:send,businessChatId:'77002'}),{sent:0,failed:0,cancelled:0});
  database.close();
});

test('failed delivery is retained and sent again later; removed admins never receive it',async()=>{
  const database=fixture();
  bindTelegramAccount('manager',13,'10013',settings(database));
  const failed=[];
  const first=await flushBotConnectionAlerts({database,businessChatId:'77002',
    sendToChat:async(chat)=>{failed.push(chat);return {ok:false};}});
  assert.deepEqual(first,{sent:0,failed:2,cancelled:0});
  assert.equal(count(database,'bot_connection_deliveries'),2);
  assert.equal((await flushBotConnectionAlerts({database,businessChatId:'77002',
    sendToChat:async()=>{throw Error('Unexpected early retry');}})).sent,0);
  database.prepare("UPDATE bot_connection_deliveries SET last_attempt_at=datetime('now','-3 minutes')").run();
  database.prepare('UPDATE admins SET active=0 WHERE id=1').run();
  const delivered=[];
  const second=await flushBotConnectionAlerts({database,businessChatId:'77002',
    sendToChat:async(chat)=>{delivered.push(chat);return {ok:true};}});
  assert.deepEqual(second,{sent:1,failed:0,cancelled:1});
  assert.deepEqual(delivered,['77002']);
  assert.equal(count(database,'bot_connection_events'),1);
  database.close();
});

test('all role names are accurate; owner includes salon and no chat is leaked into formatted notification',()=>{
  const database=fixture();
  const expected=[
    ['customer',11,'Покупатель'],
    ['owner',12,'Владелец салона'],
    ['manager',13,'Менеджер'],
    ['founder',14,'Собственник бизнеса'],
    ['task_assignee',15,'Исполнитель поручений'],
    ['admin',2,'Администратор'],
  ];
  for(const [role,id,label] of expected){
    const result=bindTelegramAccount(role,id,String(60000+id),settings(database,{businessChatId:''}));
    assert.equal(result.changed,true,role);
    const event=database.prepare('SELECT * FROM bot_connection_events WHERE id=?').get(result.eventId);
    assert.equal(event.role_label,label);
    assert.ok(formatConnectionAlert(event).includes(label));
    assert.doesNotMatch(formatConnectionAlert(event),new RegExp('600'+id));
  }
  const owner=database.prepare("SELECT * FROM bot_connection_events WHERE role='owner'").get();
  assert.match(formatConnectionAlert(owner),/Zveryuga/);
  database.close();
});

test('invalid chat, inactive account or unknown role does not bind or generate an event',()=>{
  const database=fixture();
  for(const [role,id,chat] of [
    ['partner',10,'-11'],['partner',10,'<html>'],['wrong',10,'1234'],
    ['partner',999,'1234'],['partner',10,'0'],['owner',12,''],
  ]){
    assert.equal(bindTelegramAccount(role,id,chat,settings(database)).changed,false);
  }
  database.prepare('UPDATE partners SET active=0 WHERE id=10').run();
  assert.equal(bindTelegramAccount('partner',10,'80010',settings(database)).changed,false);
  assert.equal(database.prepare('SELECT telegram_chat_id FROM partners WHERE id=10').get().telegram_chat_id,null);
  assert.equal(count(database,'bot_connection_events'),0);
  database.close();
});

test('source paths use the binder rather than unlogged direct chat updates',()=>{
  const poller=fs.readFileSync(path.join(__dirname,'telegram-login-poller.js'),'utf8');
  const phone=fs.readFileSync(path.join(__dirname,'miniapp-phone-identity.js'),'utf8');
  const routes=fs.readFileSync(path.join(__dirname,'routes-auth.js'),'utf8');
  const tasks=fs.readFileSync(path.join(__dirname,'routes-tasks.js'),'utf8');
  assert.match(poller,/bindTelegramAccount\(/);
  assert.match(poller,/startBotConnectionAlertWorker/);
  assert.match(phone,/bindTelegramAccount\(role,account\.id,userId\)/);
  assert.match(routes,/bindTelegramAccount\('manager',mgr\.id,record\.chat_id\)/);
  assert.match(routes,/bindTelegramAccount\('partner',partner\.id,record\.chat_id\)/);
  assert.match(routes,/bindTelegramAccount\('customer',customer\.id,record\.chat_id\)/);
  assert.match(routes,/bindTelegramAccount\(payload\.role,payload\.id,record\.chat_id\)/);
  assert.match(tasks,/bindTelegramAccount\('task_assignee'/);
});

test.after(()=>{
  try{require('./db').close();}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});
