// Support dialogue shared by Telegram and MAX. No background workers.
// One OPEN ticket per private chat. Replies never close it automatically.
'use strict';

const db = require('./db');
const DRAFT_TTL = 15 * 60;
const TICKET_COOLDOWN = 60;
const HOURLY_LIMIT = 5;
const MESSAGE_HOURLY_LIMIT = 60;
const MAX_BODY_LENGTH = 1800;
const ALLOWED_PLATFORMS = new Set(['telegram','max']);

// The old 'answered' status is the legacy equivalent of CLOSED. Retaining it
// avoids rebuilding the deployed SQLite table and preserves historical tickets.
db.exec([
  'CREATE TABLE IF NOT EXISTS bot_support_drafts (',
  "  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),",
  '  chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  '  PRIMARY KEY (platform,chat_id)',
  ');',
  'CREATE TABLE IF NOT EXISTS bot_support_tickets (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  "  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),",
  "  chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '',",
  '  body TEXT NOT NULL, created_at INTEGER NOT NULL,',
  "  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered')),",
  '  delivery_count INTEGER NOT NULL DEFAULT 0,',
  '  answered_at INTEGER, answer TEXT, answered_by TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_bot_support_unanswered ON bot_support_tickets(status,id DESC);',
  'CREATE INDEX IF NOT EXISTS idx_bot_support_sender ON bot_support_tickets(platform,chat_id,created_at DESC);',
  'CREATE TABLE IF NOT EXISTS bot_support_messages (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  ticket_id INTEGER NOT NULL REFERENCES bot_support_tickets(id) ON DELETE CASCADE,',
  "  role TEXT NOT NULL CHECK(role IN ('client','admin')),",
  '  platform TEXT NOT NULL, chat_id TEXT NOT NULL,',
  '  body TEXT NOT NULL, created_at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_bot_support_messages_ticket ON bot_support_messages(ticket_id,id);',
].join('\n'));

function ensureColumn(table,column,type) {
  if(!db.prepare('PRAGMA table_info('+table+')').all().some(x=>x.name===column))
    db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+type);
}
ensureColumn('bot_support_drafts','stage',"TEXT NOT NULL DEFAULT 'point'");
ensureColumn('bot_support_drafts','point_name','TEXT');
ensureColumn('bot_support_drafts','contact_phone','TEXT');
ensureColumn('bot_support_drafts','initial_body','TEXT');
ensureColumn('bot_support_tickets','point_name','TEXT');
ensureColumn('bot_support_tickets','contact_phone','TEXT');
ensureColumn('bot_support_tickets','closed_at','INTEGER');
ensureColumn('bot_support_tickets','closed_by','TEXT');

// Historic single-message tickets remain available in the conversation view.
db.exec("INSERT INTO bot_support_messages(ticket_id,role,platform,chat_id,body,created_at) " +
  "SELECT t.id,'client',t.platform,t.chat_id,t.body,t.created_at FROM bot_support_tickets t " +
  "WHERE NOT EXISTS (SELECT 1 FROM bot_support_messages m WHERE m.ticket_id=t.id AND m.role='client')");
db.exec("INSERT INTO bot_support_messages(ticket_id,role,platform,chat_id,body,created_at) " +
  "SELECT t.id,'admin',COALESCE(substr(t.answered_by,1,instr(t.answered_by,':')-1),t.platform)," +
  "COALESCE(substr(t.answered_by,instr(t.answered_by,':')+1),t.chat_id),t.answer," +
  "COALESCE(t.answered_at,t.created_at) FROM bot_support_tickets t " +
  "WHERE t.answer IS NOT NULL AND NOT EXISTS " +
  "(SELECT 1 FROM bot_support_messages m WHERE m.ticket_id=t.id AND m.role='admin')");

function now(){return Math.floor(Date.now()/1000);}
function id(value){
  const s=String(value==null?'':value);
  return /^[1-9]\d{0,19}$/.test(s)?s:null;
}
function validIdentity(platform,chatId,senderId){
  return ALLOWED_PLATFORMS.has(platform)&&!!id(chatId)&&!!id(senderId);
}
function cleanName(value){
  return String(value||'Клиент').replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(/\s+/g,' ').trim().slice(0,100)||'Клиент';
}
function cleanBody(text){
  const s=String(text||'').replace(/\r\n/g,'\n').trim();
  if(!s)return {error:'Напишите сообщение для поддержки текстом.'};
  if(s.length>MAX_BODY_LENGTH)return {
    error:'Сообщение слишком длинное. Максимум '+MAX_BODY_LENGTH+' символов.'};
  return {body:s};
}
function cleanPoint(text){
  const s=String(text||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().replace(/\s+/g,' ');
  if(!s||s.length>120)return {error:'Укажите название точки (не более 120 символов). Если точки нет, напишите «Нет точки». '};
  return {value:s};
}
function cleanPhone(text){
  let s=String(text||'').trim().replace(/[ ().-]/g,'');
  if(/^\d{10}$/.test(s)&&s[0]==='9')s='7'+s;
  if(/^8\d{10}$/.test(s))s='7'+s.slice(1);
  if(s.startsWith('+'))s=s.slice(1);
  if(!/^[1-9]\d{9,14}$/.test(s))return {
    error:'Укажите телефон для обратной связи, например +7 999 123-45-67.'};
  return {value:'+'+s};
}
function getOpenTicket(platform,chatId,senderId){
  if(!validIdentity(platform,chatId,senderId))return null;
  return db.prepare(
    "SELECT * FROM bot_support_tickets WHERE platform=? AND chat_id=? AND sender_id=? AND status='open' ORDER BY id DESC LIMIT 1"
  ).get(platform,id(chatId),id(senderId))||null;
}
function isPlain(text){
  return typeof text==='string' && text.trim() && !text.trim().startsWith('/');
}
function startDraft(platform,chatId,senderId,initialText){
  if(!validIdentity(platform,chatId,senderId))return {
    ok:false,message:'Обратитесь в поддержку из своего личного чата с ботом.'};
  const open=getOpenTicket(platform,chatId,senderId);
  if(open){
    if(initialText!=null&&String(initialText).trim())return appendToOpenTicket(platform,chatId,senderId,initialText);
    return {ok:true,existing:true,message:'💬 Обращение №'+open.id+
      ' уже открыто. Напишите следующее сообщение прямо в чат — оно добавится в эту переписку.'+
      '\nИстория: /support_history '+open.id+
      '\nЗакрыть: /support_close '+open.id};
  }
  let initial=null;
  if(initialText!=null && String(initialText).trim()){
    const checked=cleanBody(initialText);
    if(checked.error)return {ok:false,message:checked.error};
    initial=checked.body;
  }
  const current=now();
  db.prepare(
    "INSERT INTO bot_support_drafts(platform,chat_id,sender_id,created_at,stage,point_name,contact_phone,initial_body) "+
    "VALUES (?,?,?,?,'point',NULL,NULL,?) ON CONFLICT(platform,chat_id) DO UPDATE SET "+
    "sender_id=excluded.sender_id,created_at=excluded.created_at,stage='point',point_name=NULL,"+
    "contact_phone=NULL,initial_body=excluded.initial_body"
  ).run(platform,id(chatId),id(senderId),current,initial);
  return {ok:true,message:'🆘 Поддержка ХвостМаркета\n\nШаг 1/3. Укажите название точки (салона, клиники или магазина).'+
    '\nЕсли обращение не связано с точкой, напишите «Нет точки».\n\nДля отмены — /cancel.'};
}
function cancelDraft(platform,chatId){
  if(!ALLOWED_PLATFORMS.has(platform)||!id(chatId))return false;
  return db.prepare('DELETE FROM bot_support_drafts WHERE platform=? AND chat_id=?')
    .run(platform,id(chatId)).changes>0;
}
function insertMessage(ticket,role,platform,chatId,body){
  db.prepare(
    'INSERT INTO bot_support_messages(ticket_id,role,platform,chat_id,body,created_at) VALUES (?,?,?,?,?,?)'
  ).run(ticket.id,role,platform,id(chatId),body,now());
}
function submitTicket(platform,chatId,senderId,senderName,text,pointName,contactPhone){
  if(!validIdentity(platform,chatId,senderId))return {
    ok:false,message:'Отправьте сообщение из своего личного чата с ботом.'};
  const checked=cleanBody(text),point=cleanPoint(pointName),phone=cleanPhone(contactPhone);
  for(const item of [checked,point,phone])if(item.error)return {ok:false,message:item.error};
  const existing=getOpenTicket(platform,chatId,senderId);
  if(existing)return appendToOpenTicket(platform,chatId,senderId,checked.body);
  const current=now();
  const last=db.prepare(
    'SELECT created_at FROM bot_support_tickets WHERE platform=? AND chat_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(platform,id(chatId));
  if(last&&last.created_at>current-TICKET_COOLDOWN)return {
    ok:false,message:'Подождите минуту перед созданием следующего обращения.'};
  const hourly=db.prepare(
    'SELECT COUNT(*) AS total FROM bot_support_tickets WHERE platform=? AND chat_id=? AND created_at>=?'
  ).get(platform,id(chatId),current-3600);
  if(hourly.total>=HOURLY_LIMIT)return {
    ok:false,message:'Лимит новых обращений за час исчерпан. Продолжить открытое обращение можно без создания нового.'};
  db.exec('BEGIN IMMEDIATE');
  let ticket;
  try{
    const inserted=db.prepare(
      'INSERT INTO bot_support_tickets(platform,chat_id,sender_id,sender_name,body,created_at,point_name,contact_phone) '+
      'VALUES (?,?,?,?,?,?,?,?)'
    ).run(platform,id(chatId),id(senderId),cleanName(senderName),checked.body,current,point.value,phone.value);
    ticket=db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(inserted.lastInsertRowid);
    insertMessage(ticket,'client',platform,chatId,checked.body);
    db.prepare('DELETE FROM bot_support_drafts WHERE platform=? AND chat_id=?')
      .run(platform,id(chatId));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true,ticket,body:checked.body,followup:false};
}
function consumeDraft(platform,chatId,senderId,senderName,text){
  if(!validIdentity(platform,chatId,senderId)||!isPlain(text))return null;
  const draft=db.prepare(
    'SELECT * FROM bot_support_drafts WHERE platform=? AND chat_id=?'
  ).get(platform,id(chatId));
  if(!draft)return null;
  if(draft.sender_id!==id(senderId)||draft.created_at<=now()-DRAFT_TTL){
    cancelDraft(platform,chatId);
    return {ok:false,message:'Время заполнения обращения истекло. Отправьте /support ещё раз.'};
  }
  if(draft.stage==='point'){
    const point=cleanPoint(text);
    if(point.error)return {ok:false,message:point.error};
    db.prepare(
      "UPDATE bot_support_drafts SET point_name=?,stage='phone',created_at=? WHERE platform=? AND chat_id=?"
    ).run(point.value,now(),platform,id(chatId));
    return {ok:true,message:'Шаг 2/3. Укажите номер телефона для обратной связи (например, +7 999 123-45-67).'};
  }
  if(draft.stage==='phone'){
    const phone=cleanPhone(text);
    if(phone.error)return {ok:false,message:phone.error};
    db.prepare(
      "UPDATE bot_support_drafts SET contact_phone=?,stage='body',created_at=? WHERE platform=? AND chat_id=?"
    ).run(phone.value,now(),platform,id(chatId));
    if(draft.initial_body)return submitTicket(platform,chatId,senderId,senderName,
      draft.initial_body,draft.point_name,phone.value);
    return {ok:true,message:'Шаг 3/3. Опишите ваш вопрос или проблему.\n'+
      'После отправки обращение останется открытым до отдельного закрытия.'};
  }
  return submitTicket(platform,chatId,senderId,senderName,text,draft.point_name,draft.contact_phone);
}
function appendToOpenTicket(platform,chatId,senderId,text,ticketId){
  if(!validIdentity(platform,chatId,senderId))return null;
  if(!isPlain(text))return null;
  const checked=cleanBody(text);
  if(checked.error)return {ok:false,message:checked.error};
  const ticket=getOpenTicket(platform,chatId,senderId);
  if(!ticket)return null;
  if(ticketId!==undefined&&Number(ticketId)!==ticket.id)return {
    ok:false,message:'Вы можете дополнять только своё открытое обращение №'+ticket.id};
  const recent=db.prepare(
    "SELECT COUNT(*) AS c FROM bot_support_messages WHERE ticket_id=? AND role='client' AND created_at>=?"
  ).get(ticket.id,now()-3600);
  if(recent.c>=MESSAGE_HOURLY_LIMIT)return {
    ok:false,message:'Лимит дополнений за час достигнут. Продолжите переписку позднее.'};
  insertMessage(ticket,'client',platform,chatId,checked.body);
  return {ok:true,ticket,body:checked.body,followup:true};
}
function clientAdd(platform,chatId,senderId,ticketId,text){
  const ticket=getOpenTicket(platform,chatId,senderId);
  if(!ticket)return {ok:false,message:'У вас нет открытого обращения. Начните с /support.'};
  return appendToOpenTicket(platform,chatId,senderId,text,ticketId)||
    {ok:false,message:'Формат: /support_add '+ticket.id+' ваше сообщение'};
}
function activeAdmin(platform,chatId){
  const column=platform==='telegram'?'telegram_chat_id':platform==='max'?'max_chat_id':null;
  if(!column||!id(chatId))return false;
  return !!db.prepare(
    "SELECT 1 FROM admins WHERE active=1 AND role IN ('admin','super') AND CAST("+column+" AS TEXT)=? LIMIT 1"
  ).get(id(chatId));
}
function adminRecipients(){
  const admins=db.prepare(
    "SELECT telegram_chat_id,max_chat_id FROM admins WHERE active=1 AND role IN ('admin','super')"
  ).all();
  const addresses=new Map();
  for(const admin of admins)for(const platform of ['telegram','max']){
    const chatId=id(admin[platform==='telegram'?'telegram_chat_id':'max_chat_id']);
    if(chatId)addresses.set(platform+':'+chatId,{platform,chatId});
  }
  return [...addresses.values()];
}
function platformName(platform){return platform==='telegram'?'Telegram':'MAX';}
function notification(ticket,kind='new',text=null){
  return [
    kind==='closed'?'✅ Обращение №'+ticket.id+' закрыто клиентом':
      kind==='followup'?'💬 Новое сообщение по обращению №'+ticket.id:
        '🆘 Новое обращение в поддержку ХвостМаркета · №'+ticket.id,
    'Канал: '+platformName(ticket.platform),
    'Отправитель: '+cleanName(ticket.sender_name),
    'Точка: '+(ticket.point_name||'Не указана'),
    'Телефон: '+(ticket.contact_phone||'Не указан'),
    'ID чата: '+ticket.chat_id,'',
    text||ticket.body,'',
    'Ответ: /support_reply '+ticket.id+' текст',
    'История: /support_history '+ticket.id,
    'Закрыть: /support_close '+ticket.id,
    'Открытые: /support_inbox',
  ].join('\n');
}
async function sendToBot(platform,chatId,text){
  let url,headers;
  if(platform==='telegram'){
    if(!process.env.TG_TOKEN)return false;
    url='https://api.telegram.org/bot'+process.env.TG_TOKEN+'/sendMessage';
    headers={'Content-Type':'application/json'};
  }else if(platform==='max'){
    if(!process.env.MAX_BOT_TOKEN)return false;
    url='https://platform-api2.max.ru/messages?chat_id='+encodeURIComponent(chatId);
    headers={'Content-Type':'application/json',Authorization:process.env.MAX_BOT_TOKEN};
  }else return false;
  try{
    const response=await fetch(url,{
      method:'POST',headers,
      body:JSON.stringify(platform==='telegram'?{chat_id:chatId,text}:{text}),
      signal:AbortSignal.timeout(8500),
    });
    if(!response.ok)return false;
    const data=await response.json().catch(()=>null);
    if(platform==='telegram')return !!data?.ok;
    return data?.ok!==false&&!!data;
  }catch(error){
    console.warn('[support] Сообщение не доставлено в '+platform+':',error.message);
    return false;
  }
}
async function notifyAdmins(ticket,kind='new',body){
  if(!ticket||!ticket.id)return {delivered:0,registered:0};
  const recipients=adminRecipients();
  const message=notification(ticket,kind,body);
  const deliveredResults=await Promise.all(recipients.map(item=>sendToBot(item.platform,item.chatId,message)));
  const delivered=deliveredResults.filter(Boolean).length;
  if(delivered)db.prepare('UPDATE bot_support_tickets SET delivery_count=delivery_count+? WHERE id=?')
    .run(delivered,ticket.id);
  return {delivered,registered:recipients.length};
}
function confirmation(ticket,result,followup=false){
  if(followup)return result.delivered>0
    ? '✅ Сообщение добавлено в обращение №'+ticket.id+'. Переписка продолжается до закрытия.'
    : '✅ Сообщение сохранено в обращении №'+ticket.id+
      '. Уведомление пока не доставлено; история доступна администрации.';
  return result.delivered>0
    ? '✅ Обращение №'+ticket.id+' создано. Ответ придёт сюда.\n'+
      'Можете отправлять новые сообщения в этот чат до закрытия обращения.\n'+
      'История: /support_history '+ticket.id+'\nЗакрыть: /support_close '+ticket.id
    : '✅ Обращение №'+ticket.id+' сохранено, но уведомление администраторам не доставлено. '+
      'Оно доступно через /support_inbox. Можете продолжать переписку здесь.';
}
function inbox(platform,chatId){
  if(!activeAdmin(platform,chatId))return {
    ok:false,message:'🔒 Список обращений доступен только подключённым администраторам.'};
  const tickets=db.prepare(
    "SELECT t.*, (SELECT body FROM bot_support_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) AS latest "+
    "FROM bot_support_tickets t WHERE t.status='open' ORDER BY t.id DESC LIMIT 10"
  ).all();
  if(!tickets.length)return {ok:true,message:'✅ Открытых обращений нет.'};
  return {ok:true,message:'🆘 Последние открытые обращения:\n\n'+tickets.map(t=>
    '№'+t.id+' · '+platformName(t.platform)+' · '+cleanName(t.sender_name)+'\n'+
    'Точка: '+(t.point_name||'не указана')+' · Телефон: '+(t.contact_phone||'не указан')+'\n'+
    (t.latest||t.body).replace(/\s+/g,' ').slice(0,90)+
    '\nОтвет: /support_reply '+t.id+' текст\nИстория: /support_history '+t.id+
    '\nЗакрыть: /support_close '+t.id
  ).join('\n\n')};
}
function resolveReadableTicket(platform,chatId,senderId,ticketId){
  const num=Number(ticketId);
  if(!Number.isSafeInteger(num)||num<=0)return null;
  const ticket=db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(num);
  if(!ticket||!validIdentity(platform,chatId,senderId))return null;
  const admin=activeAdmin(platform,chatId);
  const owner=ticket.platform===platform&&ticket.chat_id===id(chatId)&&ticket.sender_id===id(senderId);
  return admin||owner?ticket:null;
}
function history(platform,chatId,senderId,ticketId,pageValue=1){
  const ticket=resolveReadableTicket(platform,chatId,senderId,ticketId);
  if(!ticket)return {ok:false,message:'🔒 Обращение не найдено или недоступно.'};
  const page=Number(pageValue);
  if(!Number.isSafeInteger(page)||page<1||page>100)return {
    ok:false,message:'Страница истории должна быть от 1 до 100.'};
  const total=db.prepare(
    'SELECT COUNT(*) AS count FROM bot_support_messages WHERE ticket_id=?'
  ).get(ticket.id).count;
  const messages=db.prepare(
    'SELECT role,body,created_at FROM bot_support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 10 OFFSET ?'
  ).all(ticket.id,(page-1)*10).reverse();
  const isAdmin=activeAdmin(platform,chatId);
  const hint=isAdmin?'/support_reply '+ticket.id+' текст':'/support_add '+ticket.id+' текст';
  return {ok:true,message:[
    '📋 Обращение №'+ticket.id+' · '+(ticket.status==='open'?'Открыто':'Закрыто'),
    'Точка: '+(ticket.point_name||'не указана'),
    'Телефон: '+(ticket.contact_phone||'не указан'),
    'Сообщения: '+messages.length+' (страница '+page+', всего '+total+')',
    ...messages.map(m=>(m.role==='admin'?'🟢 Поддержка: ':'🐾 Клиент: ')+
      m.body.slice(0,280)+(m.body.length>280?'…':'')),
    page*10<total?'Более ранние: /support_history '+ticket.id+' '+(page+1):'',
    ticket.status==='open'?'Ответить: '+hint+'\nЗакрыть: /support_close '+ticket.id:'',
  ].filter(Boolean).join('\n\n')};
}
async function replyToTicket(platform,chatId,senderId,ticketId,text){
  if(!validIdentity(platform,chatId,senderId)||!activeAdmin(platform,chatId))
    return {ok:false,message:'🔒 Отвечать клиентам могут только подключённые администраторы.'};
  const value=cleanBody(text);
  if(value.error)return {ok:false,message:value.error};
  const num=Number(ticketId);
  if(!Number.isSafeInteger(num)||num<=0)return {ok:false,message:'Формат: /support_reply 123 текст'};
  const ticket=db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(num);
  if(!ticket)return {ok:false,message:'Обращение №'+num+' не найдено.'};
  if(ticket.status!=='open')return {ok:false,message:'Обращение №'+num+' закрыто. Повторный ответ невозможен.'};
  const delivered=await sendToBot(ticket.platform,ticket.chat_id,
    '🐾 Ответ поддержки ХвостМаркета · обращение №'+ticket.id+'\n\n'+value.body+
    '\n\nОбращение остаётся открытым. Ответьте прямо сюда или отправьте /support_close '+ticket.id+'.');
  if(!delivered)return {ok:false,message:'⚠️ Не удалось доставить ответ. Обращение остаётся открытым.'};
  db.exec('BEGIN IMMEDIATE');
  try{
    insertMessage(ticket,'admin',platform,chatId,value.body);
    db.prepare(
      "UPDATE bot_support_tickets SET answered_at=?,answer=?,answered_by=? WHERE id=? AND status='open'"
    ).run(now(),value.body,platform+':'+id(chatId),ticket.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true,message:'✅ Ответ отправлен в '+platformName(ticket.platform)+
    '. Обращение №'+ticket.id+' остаётся открытым.\n'+
    'Следующий ответ: /support_reply '+ticket.id+' текст\nЗакрыть: /support_close '+ticket.id};
}
async function closeTicket(platform,chatId,senderId,ticketId){
  if(!validIdentity(platform,chatId,senderId))return {ok:false,message:'🔒 Личный чат обязателен.'};
  const isAdmin=activeAdmin(platform,chatId);
  let ticket;
  if(ticketId===undefined||ticketId===null||ticketId===''){
    ticket=getOpenTicket(platform,chatId,senderId);
  }else{
    ticket=resolveReadableTicket(platform,chatId,senderId,ticketId);
  }
  if(!ticket)return {ok:false,message:'🔒 Открытое обращение не найдено или недоступно.'};
  if(ticket.status!=='open')return {ok:false,message:'Обращение №'+ticket.id+' уже закрыто.'};
  const owner=ticket.platform===platform&&ticket.chat_id===id(chatId)&&ticket.sender_id===id(senderId);
  if(!owner&&!isAdmin)return {ok:false,message:'🔒 Это не ваше обращение.'};
  const who=owner?'client':'admin';
  const changed=db.prepare(
    "UPDATE bot_support_tickets SET status='answered',closed_at=?,closed_by=? WHERE id=? AND status='open'"
  ).run(now(),who+':'+platform+':'+id(chatId),ticket.id);
  if(!changed.changes)return {ok:false,message:'Обращение №'+ticket.id+' уже закрыто.'};
  if(owner){
    await notifyAdmins(ticket,'closed','Клиент закрыл обращение №'+ticket.id);
  }else{
    await sendToBot(ticket.platform,ticket.chat_id,
      '✅ Обращение №'+ticket.id+' закрыто поддержкой.\n'+
      'Если возникнет новый вопрос, отправьте /support.');
  }
  return {ok:true,message:'✅ Обращение №'+ticket.id+' закрыто. При необходимости создайте новое: /support.'};
}
module.exports={
  DRAFT_TTL,MAX_BODY_LENGTH,startDraft,cancelDraft,submitTicket,consumeDraft,
  appendToOpenTicket,clientAdd,notifyAdmins,confirmation,inbox,history,
  replyToTicket,closeTicket,activeAdmin,adminRecipients,getOpenTicket,
};