'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-manager-chat-'));
process.env.TOKEN_SECRET='manager-chat-test-secret';
const {signToken}=require('./auth');
const {
  ensureManagerMessageTables,getManagerMessages,registerMiniAppManagerMessageRoutes,
  postManagerMessage,
}=require('./miniapp-manager-messages');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE managers (id INTEGER PRIMARY KEY,full_name TEXT,telegram_chat_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE points (id TEXT PRIMARY KEY,name TEXT,manager_id INTEGER REFERENCES managers(id),active INTEGER DEFAULT 1);',
    'CREATE TABLE manager_points (id INTEGER PRIMARY KEY,point_id TEXT,manager_id INTEGER,active INTEGER DEFAULT 1);',
    'CREATE TABLE partners (id INTEGER PRIMARY KEY,full_name TEXT,telegram_chat_id TEXT,point_id TEXT,active INTEGER DEFAULT 1);',
    'CREATE TABLE salon_owners (id INTEGER PRIMARY KEY,full_name TEXT,telegram_chat_id TEXT,point_id TEXT,active INTEGER DEFAULT 1);',
    "INSERT INTO managers(id,full_name,telegram_chat_id) VALUES (1,'Ангелина Функ','tg-manager-1'),(2,'Другой менеджер','tg-manager-2');",
    "INSERT INTO points(id,name,manager_id) VALUES ('salon-a','Zveryuga',1),('salon-b','БаркЛай',2),('salon-c','Без менеджера',NULL);",
    "INSERT INTO partners(id,full_name,telegram_chat_id,point_id) VALUES (10,'Барсукова Юлия','tg-partner-10','salon-a'),(11,'Грумер второго салона','tg-partner-11','salon-b'),(12,'Без точки',NULL,NULL),(13,'Без менеджера',NULL,'salon-c');",
    "INSERT INTO salon_owners(id,full_name,telegram_chat_id,point_id) VALUES (20,'Барсукова Юлия','tg-owner-20','salon-a'),(21,'Владелец другого салона','tg-owner-21','salon-b');",
  ].join(' '));
  ensureManagerMessageTables(db);
  const deliveries=[];
  const router={get(){},post(){}};
  const handlers={};
  router.get=(route,handler)=>{handlers['GET '+route]=handler;};
  router.post=(route,handler)=>{handlers['POST '+route]=handler;};
  registerMiniAppManagerMessageRoutes(router,{
    database:db,
    sendToChat:async(chatId,text,options)=>{
      deliveries.push({chatId:String(chatId),text,options});
      return {ok:true};
    },
    preference:()=>true,
  });
  async function call(method,role,id,body,query={}){
    const handler=handlers[method+' /api/miniapp/manager-messages'];
    const res={status:null,writeHead(status){this.status=status;},
      end(raw){this.json=JSON.parse(raw);}};
    const req={headers:{authorization:role?'Bearer '+signToken({role,id}):''}};
    await handler(req,res,{body,query});
    return res;
  }
  return {db,call,deliveries};
}

test('groomer and owner contact only their assigned manager; manager sees both chats and can answer',async()=>{
  const {db,call,deliveries}=fixture();
  const before=await call('GET','partner',10);
  assert.equal(before.status,200);
  assert.equal(before.json.manager.name,'Ангелина Функ');
  assert.equal(before.json.point.name,'Zveryuga');
  assert.deepEqual(before.json.messages,[]);
  assert.equal(before.json.thread_id,null);

  const groomer=await call('POST','partner',10,{text:'Нужны новые лакомства'});
  assert.equal(groomer.status,201);
  assert.equal(groomer.json.saved,true);
  assert.equal(groomer.json.notified,true);
  assert.equal(deliveries[0].chatId,'tg-manager-1');
  assert.match(deliveries[0].text,/Барсукова Юлия/);
  assert.match(deliveries[0].text,/Zveryuga/);
  assert.match(JSON.stringify(deliveries[0].options),/Открыть переписку/);

  const owner=await call('POST','owner',20,{text:'Когда привезёте новую стойку?'});
  assert.equal(owner.status,201);
  assert.notEqual(owner.json.thread_id,groomer.json.thread_id);
  assert.equal(deliveries[1].chatId,'tg-manager-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM miniapp_manager_threads').get().n,2);

  const managerInbox=await call('GET','manager',1);
  assert.equal(managerInbox.status,200);
  assert.equal(managerInbox.json.threads.length,2);
  assert.equal(managerInbox.json.unread,2);
  assert.equal(managerInbox.json.threads[0].sender_name,'Барсукова Юлия');

  const thread=await call('GET','manager',1,null,{thread_id:groomer.json.thread_id});
  assert.equal(thread.status,200);
  assert.equal(thread.json.messages.length,1);
  assert.equal(thread.json.sender.role,'partner');
  assert.equal(thread.json.messages[0].text,'Нужны новые лакомства');
  const afterRead=await call('GET','manager',1);
  assert.equal(afterRead.json.unread,1,'reading a thread clears only its own unread messages');

  const reply=await call('POST','manager',1,{thread_id:groomer.json.thread_id,text:'Привезу завтра'});
  assert.equal(reply.status,201);
  assert.equal(deliveries[2].chatId,'tg-partner-10');
  const history=await call('GET','partner',10);
  assert.equal(history.json.messages.length,2);
  assert.equal(history.json.messages[1].text,'Привезу завтра');
  const ownerHistory=await call('GET','owner',20);
  assert.equal(ownerHistory.json.messages.length,1);
  db.close();
});

test('another manager and another salon cannot read or reply to a private thread',async()=>{
  const {db,call,deliveries}=fixture();
  const sent=await call('POST','partner',10,{text:'Обратная связь'});
  assert.equal(sent.status,201);
  assert.equal((await call('GET','manager',2,null,{thread_id:sent.json.thread_id})).status,404);
  assert.equal((await call('POST','manager',2,{thread_id:sent.json.thread_id,text:'Мой ответ'})).status,404);
  const secondSalon=await call('GET','partner',11);
  assert.equal(secondSalon.json.manager.name,'Другой менеджер');
  assert.equal(secondSalon.json.messages.length,0);
  assert.equal((await call('GET','partner',11,null,{thread_id:sent.json.thread_id})).status,400);
  assert.equal((await call('POST','partner',11,{text:'Попытка',manager_id:1})).status,400);
  assert.equal((await call('POST','owner',21,{text:'Попытка',point_id:'salon-a'})).status,400);
  assert.equal((await call('GET','customer',10)).status,401);
  assert.equal((await call('POST',null,0,{text:'Hi'})).status,401);
  assert.equal(deliveries.length,1);
  db.close();
});

test('manager reassignment immediately removes old access and switches new chat to new manager',async()=>{
  const {db,call,deliveries}=fixture();
  const first=await call('POST','partner',10,{text:'Старый менеджер'});
  assert.equal(first.status,201);
  db.prepare("UPDATE points SET manager_id=2 WHERE id='salon-a'").run();
  const newContext=await call('GET','partner',10);
  assert.equal(newContext.json.manager.name,'Другой менеджер');
  assert.equal(newContext.json.thread_id,null);
  assert.equal((await call('GET','manager',1,null,{thread_id:first.json.thread_id})).status,404);
  assert.equal((await call('POST','manager',1,{thread_id:first.json.thread_id,text:'Нельзя'})).status,404);
  assert.equal((await call('GET','manager',1)).json.threads.length,0);
  const second=await call('POST','partner',10,{text:'Новый менеджер'});
  assert.equal(second.status,201);
  assert.notEqual(second.json.thread_id,first.json.thread_id);
  assert.deepEqual(deliveries.map(d=>d.chatId),['tg-manager-1','tg-manager-2']);
  assert.equal((await call('GET','manager',2)).json.threads.length,1);
  db.close();
});

test('missing manager, inactive accounts, invalid content, and sender impersonation are rejected',async()=>{
  const {db,call}=fixture();
  assert.equal((await call('GET','partner',13)).status,409);
  assert.equal((await call('POST','partner',13,{text:'Нужна связь'})).status,409);
  assert.equal((await call('GET','partner',12)).status,409);
  for(const text of ['', ' ', 'x'.repeat(1201), '\u0000']) {
    const r=await call('POST','partner',10,{text});
    assert.equal(r.status,400);
  }
  assert.equal((await call('POST','manager',1,{text:'без переписки'})).status,400);
  assert.equal((await call('POST','partner',10,{text:'Привет',sender_role:'manager'})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM miniapp_manager_messages').get().n,0);
  db.prepare('UPDATE partners SET active=0 WHERE id=10').run();
  assert.equal((await call('GET','partner',10)).status,403);
  db.prepare('UPDATE partners SET active=1 WHERE id=10').run();
  db.prepare('UPDATE managers SET active=0 WHERE id=1').run();
  assert.equal((await call('POST','partner',10,{text:'Менеджер неактивен'})).status,409);
  db.close();
});

test('spam cooldown blocks rapid repeated sends and safe escaping prevents HTML injection',async()=>{
  const {db,call,deliveries}=fixture();
  const text='<script>alert("xss")</script> & привет';
  const first=await call('POST','partner',10,{text});
  assert.equal(first.status,201);
  assert.match(deliveries[0].text,/&lt;script&gt;/);
  assert.doesNotMatch(deliveries[0].text,/<script>/);
  assert.equal((await call('POST','partner',10,{text:'Повтор'})).status,429);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM miniapp_manager_messages').get().n,1);
  assert.equal((await call('GET','partner',10)).json.messages[0].text,text);
  db.prepare("UPDATE miniapp_manager_messages SET created_at=datetime('now','-20 seconds')").run();
  assert.equal((await call('POST','partner',10,{text:'Позже'})).status,201);
  db.close();
});

test('recipient without Telegram or opted-out of messages still has persistent in-app conversation',async()=>{
  const {db}=fixture();
  db.prepare('UPDATE managers SET telegram_chat_id=NULL WHERE id=1').run();
  const deliveries=[];
  const send=async(chat,text)=>{deliveries.push([chat,text]);return {ok:true};};
  let sent=await postManagerMessage(db,'partner',10,{text:'Вопрос без бота'},send,()=>true);
  assert.equal(sent.saved,true);
  assert.equal(sent.notified,false);
  assert.equal(deliveries.length,0);
  db.prepare("UPDATE miniapp_manager_messages SET created_at=datetime('now','-20 seconds')").run();
  db.prepare("UPDATE managers SET telegram_chat_id='tg-manager-1' WHERE id=1").run();
  sent=await postManagerMessage(db,'partner',10,{text:'Выключены уведомления'},send,()=>false);
  assert.equal(sent.notified,false);
  assert.equal(getManagerMessages(db,'manager',1).threads.length,1);
  db.close();
});

test.after(()=>{
  const db=require('./db');
  try{db.close();}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});
