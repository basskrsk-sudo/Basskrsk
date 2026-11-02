// Private two-way Mini App conversations: groomers and owners can contact
// the currently assigned salon manager, who can reply from the same app.
// Neither sender nor manager can choose another account or point in the API.
'use strict';
const defaultDb=require('./db');
const {requireAuth}=require('./routes-auth');
const {sendJson}=require('./http-utils');
const telegram=require('./telegram');
const {WORK_URL}=require('./miniapp-bot-links');
const {preference}=require('./notification-preferences');

const TABLES=Object.freeze({partner:'partners',owner:'salon_owners',manager:'managers'});
const MAX_LENGTH=1200;

function ensureManagerMessageTables(database=defaultDb){
  database.exec(
    'CREATE TABLE IF NOT EXISTS miniapp_manager_threads ('+
    'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
    'point_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE,'+
    'manager_id INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,'+
    "sender_role TEXT NOT NULL CHECK(sender_role IN ('partner','owner')),"+
    'sender_id INTEGER NOT NULL,sender_name TEXT NOT NULL,manager_last_read_id INTEGER NOT NULL DEFAULT 0,'+
    "created_at TEXT NOT NULL DEFAULT (datetime('now')),"+
    "updated_at TEXT NOT NULL DEFAULT (datetime('now')),"+
    'UNIQUE(point_id,manager_id,sender_role,sender_id));'+
    'CREATE TABLE IF NOT EXISTS miniapp_manager_messages ('+
    'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
    'thread_id INTEGER NOT NULL REFERENCES miniapp_manager_threads(id) ON DELETE CASCADE,'+
    "author_role TEXT NOT NULL CHECK(author_role IN ('partner','owner','manager')),"+
    'author_id INTEGER NOT NULL,author_name TEXT NOT NULL,body TEXT NOT NULL,'+
    "created_at TEXT NOT NULL DEFAULT (datetime('now')));"+
    'CREATE INDEX IF NOT EXISTS idx_miniapp_manager_threads_manager '+
    'ON miniapp_manager_threads(manager_id,updated_at DESC);'+
    'CREATE INDEX IF NOT EXISTS idx_miniapp_manager_messages_thread '+
    'ON miniapp_manager_messages(thread_id,id DESC);'
  );
}
ensureManagerMessageTables();

function getAccount(database,role,id){
  if(!Object.hasOwn(TABLES,role))return null;
  const numeric=Number(id);
  if(!Number.isSafeInteger(numeric)||numeric<1)return null;
  return database.prepare('SELECT id,full_name,telegram_chat_id,active'+
    (role==='manager'?'':',point_id')+
    ' FROM '+TABLES[role]+' WHERE id=? AND active=1').get(numeric)||null;
}

function managerForPoint(database,pointId){
  const point=database.prepare('SELECT id,name,manager_id,active FROM points WHERE id=?').get(pointId);
  if(!point||!point.active)return {status:409,error:'Ваша точка неактивна или не найдена'};
  if(point.manager_id!=null){
    const manager=getAccount(database,'manager',point.manager_id);
    return manager?{point,manager}:{status:409,error:'Ответственный менеджер этой точки недоступен'};
  }
  // Legacy points sometimes have no manager_id. A unique, active
  // manager_points association is the only permitted fallback.
  const managers=database.prepare(
    'SELECT DISTINCT m.id,m.full_name,m.telegram_chat_id,m.active FROM manager_points mp '+
    'JOIN managers m ON m.id=mp.manager_id AND m.active=1 '+
    'WHERE mp.point_id=? AND mp.active=1'
  ).all(pointId);
  if(managers.length!==1)return {status:409,error:managers.length?
    'У точки несколько менеджеров. Обратитесь к администратору для уточнения.':
    'Для вашей точки менеджер ещё не назначен'};
  return {point,manager:managers[0]};
}

function senderContext(database,role,id){
  const sender=getAccount(database,role,id);
  if(!sender)return {status:403,error:'Учётная запись неактивна или не найдена'};
  if(!sender.point_id)return {status:409,error:'Для вашего салона пока не назначена точка'};
  const link=managerForPoint(database,sender.point_id);
  return link.error?link:{sender,...link};
}

function getThread(database,pointId,managerId,role,senderId){
  return database.prepare('SELECT * FROM miniapp_manager_threads WHERE '+
    'point_id=? AND manager_id=? AND sender_role=? AND sender_id=?'
  ).get(pointId,managerId,role,senderId)||null;
}
function getManagerThread(database,managerId,threadId){
  const id=Number(threadId);
  if(!Number.isSafeInteger(id)||id<1)return null;
  const row=database.prepare(
    'SELECT t.*,p.name AS point_name FROM miniapp_manager_threads t '+
    'JOIN points p ON p.id=t.point_id WHERE t.id=? AND t.manager_id=?'
  ).get(id,managerId);
  if(!row)return null;
  const current=managerForPoint(database,row.point_id);
  return current.manager&&Number(current.manager.id)===Number(managerId)?row:null;
}
function threadSender(database,thread){
  const sender=getAccount(database,thread.sender_role,thread.sender_id);
  return sender&&sender.point_id===thread.point_id?sender:null;
}
function messages(database,threadId){
  return database.prepare(
    'SELECT id,author_role,author_name,body,created_at FROM miniapp_manager_messages '+
    'WHERE thread_id=? ORDER BY id DESC LIMIT 80'
  ).all(threadId).reverse().map(m=>({
    id:m.id,author_role:m.author_role,author_name:m.author_name,
    text:m.body,created_at:m.created_at,
  }));
}

function getManagerMessages(database,role,id,threadId){
  if(role==='partner'||role==='owner'){
    const contact=senderContext(database,role,id);
    if(contact.error)return contact;
    if(threadId!==undefined && threadId!==null)return {status:400,error:'Нельзя просматривать чужую переписку'};
    const thread=getThread(database,contact.point.id,contact.manager.id,role,Number(id));
    return {kind:'sender',manager:{name:contact.manager.full_name},
      point:{name:contact.point.name},thread_id:thread?.id||null,
      messages:thread?messages(database,thread.id):[]};
  }
  if(role!=='manager')return {status:403,error:'Нет доступа к сообщениям'};
  const manager=getAccount(database,'manager',id);
  if(!manager)return {status:403,error:'Кабинет менеджера неактивен'};
  if(threadId!==undefined&&threadId!==null){
    const thread=getManagerThread(database,manager.id,threadId);
    if(!thread||!threadSender(database,thread))return {status:404,error:'Переписка недоступна'};
    database.prepare(
      'UPDATE miniapp_manager_threads SET manager_last_read_id=('+
      'SELECT COALESCE(MAX(id),0) FROM miniapp_manager_messages WHERE thread_id=?) WHERE id=?'
    ).run(thread.id,thread.id);
    return {kind:'manager_thread',thread_id:thread.id,
      point:{name:thread.point_name},sender:{name:thread.sender_name,role:thread.sender_role},
      messages:messages(database,thread.id)};
  }
  const rows=database.prepare(
    'SELECT t.*,p.name AS point_name,'+
    '(SELECT m.body FROM miniapp_manager_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_text,'+
    '(SELECT m.created_at FROM miniapp_manager_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_at,'+
    "(SELECT COUNT(*) FROM miniapp_manager_messages m WHERE m.thread_id=t.id AND m.author_role!='manager' "+
    'AND m.id>t.manager_last_read_id) AS unread '+
    'FROM miniapp_manager_threads t JOIN points p ON p.id=t.point_id '+
    'WHERE t.manager_id=? ORDER BY t.updated_at DESC,t.id DESC LIMIT 100'
  ).all(manager.id);
  const threads=rows.filter(t=>{
    const cur=managerForPoint(database,t.point_id);
    return cur.manager&&cur.manager.id===manager.id&&!!threadSender(database,t);
  }).map(t=>({
    id:t.id,point_name:t.point_name,sender_role:t.sender_role,sender_name:t.sender_name,
    last_text:t.last_text||'',last_at:t.last_at,unread:t.unread,
  }));
  return {kind:'manager',threads,unread:threads.reduce((n,t)=>n+t.unread,0)};
}

function validatedBody(body,role){
  if(!body||typeof body!=='object'||Array.isArray(body))return {status:400,error:'Неверный формат сообщения'};
  const allowed=role==='manager'?['text','thread_id']:['text'];
  if(Object.keys(body).some(k=>!allowed.includes(k)))return {status:400,error:'Недопустимые параметры сообщения'};
  if(typeof body.text!=='string')return {status:400,error:'Введите текст сообщения'};
  const text=body.text.replace(/\r\n/g,'\n').trim();
  if(!text||text.length>MAX_LENGTH||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)){
    return {status:400,error:'Текст должен содержать от 1 до 1200 символов'};
  }
  if(role==='manager'&&(!Number.isSafeInteger(Number(body.thread_id))||
    Number(body.thread_id)<1||body.thread_id==null)){
    return {status:400,error:'Выберите переписку для ответа'};
  }
  return {text};
}
function html(text){
  return String(text).replace(/[&<>"']/g,
    c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

async function postManagerMessage(database,role,id,body,send=telegram.sendToChat,
  notifications=preference){
  if(!Object.hasOwn(TABLES,role))return {status:403,error:'Нет доступа к сообщениям'};
  const parsed=validatedBody(body,role);
  if(parsed.error)return parsed;
  let ctx;
  database.exec('BEGIN IMMEDIATE');
  try{
    if(role==='manager'){
      const actor=getAccount(database,'manager',id);
      if(!actor){database.exec('ROLLBACK');return {status:403,error:'Кабинет менеджера недоступен'};}
      const thread=getManagerThread(database,actor.id,body.thread_id);
      if(!thread){database.exec('ROLLBACK');return {status:404,error:'Переписка недоступна'};}
      const recipient=threadSender(database,thread);
      if(!recipient){database.exec('ROLLBACK');return {status:409,error:'Отправитель больше не привязан к точке'};}
      ctx={actor,thread,recipient,recipientRole:thread.sender_role,pointName:thread.point_name};
    }else{
      const contact=senderContext(database,role,id);
      if(contact.error){database.exec('ROLLBACK');return contact;}
      const {sender,point,manager}=contact;
      database.prepare('INSERT OR IGNORE INTO miniapp_manager_threads '+
        '(point_id,manager_id,sender_role,sender_id,sender_name) VALUES (?,?,?,?,?)'
      ).run(point.id,manager.id,role,sender.id,sender.full_name);
      const thread=getThread(database,point.id,manager.id,role,sender.id);
      ctx={actor:sender,thread,recipient:manager,recipientRole:'manager',pointName:point.name};
    }
    const recent=database.prepare('SELECT 1 FROM miniapp_manager_messages '+
      'WHERE thread_id=? AND author_role=? AND author_id=? '+
      "AND created_at>=datetime('now','-12 seconds') LIMIT 1"
    ).get(ctx.thread.id,role,ctx.actor.id);
    if(recent){database.exec('ROLLBACK');return {status:429,error:'Повторите отправку через 12 секунд'};}
    const result=database.prepare('INSERT INTO miniapp_manager_messages '+
      '(thread_id,author_role,author_id,author_name,body) VALUES (?,?,?,?,?)'
    ).run(ctx.thread.id,role,ctx.actor.id,ctx.actor.full_name,parsed.text);
    database.prepare("UPDATE miniapp_manager_threads SET updated_at=datetime('now') WHERE id=?").run(ctx.thread.id);
    ctx.messageId=Number(result.lastInsertRowid);
    database.exec('COMMIT');
  }catch(e){
    try{database.exec('ROLLBACK');}catch(_){}
    throw e;
  }
  let notified=false;
  if(ctx.recipient.telegram_chat_id&&notifications(ctx.recipientRole,ctx.recipient.id,'messages')){
    const caption=role==='manager'?'💬 <b>Ответ менеджера ХвостМаркет</b>':
      '💬 <b>Новое сообщение менеджеру ХвостМаркет</b>';
    const text=[caption,'🏪 Точка: '+html(ctx.pointName),
      '👤 '+(role==='manager'?'Менеджер: ':'Партнёр: ')+html(ctx.actor.full_name),
      '',html(parsed.text),'','Ответьте в мини-приложении: «Кабинеты» → «Сообщения».'].join('\n');
    try{
      const result=await send(ctx.recipient.telegram_chat_id,text,
        {reply_markup:{inline_keyboard:[[
          {text:'💬 Открыть переписку',web_app:{url:WORK_URL}},
        ]]}});
      notified=!!result?.ok;
    }catch(e){console.error('Не удалось отправить уведомление о переписке:',e.message);}
  }
  return {ok:true,saved:true,message_id:ctx.messageId,
    thread_id:ctx.thread.id,notified};
}

function registerMiniAppManagerMessageRoutes(router,options={}){
  const database=options.database||defaultDb;
  const send=options.sendToChat||((...args)=>telegram.sendToChat(...args));
  const notifications=options.preference||preference;
  router.get('/api/miniapp/manager-messages',(req,res,ctx)=>{
    const actor=requireAuth(['partner','owner','manager'])(req,res,ctx);
    if(!actor)return;
    const result=getManagerMessages(database,actor.role,actor.id,ctx.query?.thread_id);
    sendJson(res,result.status||200,result.error?{error:result.error}:result);
  });
  router.post('/api/miniapp/manager-messages',async(req,res,ctx)=>{
    const actor=requireAuth(['partner','owner','manager'])(req,res,ctx);
    if(!actor)return;
    const result=await postManagerMessage(database,actor.role,actor.id,ctx.body,
      send,notifications);
    sendJson(res,result.status||201,result.error?{error:result.error}:result);
  });
}

module.exports={ensureManagerMessageTables,managerForPoint,senderContext,
  getManagerMessages,postManagerMessage,registerMiniAppManagerMessageRoutes,MAX_LENGTH};
