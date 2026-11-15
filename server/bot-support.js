// Customer support shared by Telegram and MAX bots.
// No workers, no periodic polling: SQL is used only for user commands.
// Requests survive Amvera restarts in the same persistent database as orders.
'use strict';

const db = require('./db');

const DRAFT_TTL = 15 * 60;
const TICKET_COOLDOWN = 60;
const HOURLY_LIMIT = 5;
const MAX_BODY_LENGTH = 1800;
const ALLOWED_PLATFORMS = new Set(['telegram','max']);

db.exec([
  'CREATE TABLE IF NOT EXISTS bot_support_drafts (',
  "  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),",
  '  chat_id TEXT NOT NULL,',
  '  sender_id TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  '  PRIMARY KEY (platform, chat_id)',
  ');',
  'CREATE TABLE IF NOT EXISTS bot_support_tickets (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  "  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),",
  '  chat_id TEXT NOT NULL,',
  '  sender_id TEXT NOT NULL,',
  '  sender_name TEXT NOT NULL DEFAULT \'\',',
  '  body TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  "  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered')),",
  '  delivery_count INTEGER NOT NULL DEFAULT 0,',
  '  answered_at INTEGER,',
  '  answer TEXT,',
  '  answered_by TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_bot_support_unanswered',
  '  ON bot_support_tickets(status,id DESC);',
  'CREATE INDEX IF NOT EXISTS idx_bot_support_sender',
  '  ON bot_support_tickets(platform,chat_id,created_at DESC);',
].join('\n'));

function now() { return Math.floor(Date.now() / 1000); }
function id(value) {
  const string = String(value == null ? '' : value);
  // Platform-specific chat and user ids are positive decimal strings.
  return /^[1-9]\d{0,19}$/.test(string) ? string : null;
}
function validIdentity(platform, chatId, senderId) {
  return ALLOWED_PLATFORMS.has(platform) && !!id(chatId) && !!id(senderId);
}
function cleanName(name) {
  return String(name || 'Клиент').replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(/\s+/g,' ').trim().slice(0,100) || 'Клиент';
}
function cleanBody(text) {
  const s = String(text || '').replace(/\r\n/g,'\n').trim();
  if (!s) return { error: 'Напишите сообщение для поддержки текстом.' };
  if (s.length > MAX_BODY_LENGTH) {
    return { error: 'Сообщение слишком длинное. Максимум ' + MAX_BODY_LENGTH + ' символов.' };
  }
  return { body: s };
}
function startDraft(platform, chatId, senderId) {
  if (!validIdentity(platform,chatId,senderId)) {
    return { ok:false,message:'Напишите боту из своего личного чата, чтобы обратиться в поддержку.' };
  }
  db.prepare(
    'INSERT INTO bot_support_drafts(platform,chat_id,sender_id,created_at) VALUES (?,?,?,?) '+
    'ON CONFLICT(platform,chat_id) DO UPDATE SET sender_id=excluded.sender_id,created_at=excluded.created_at'
  ).run(platform,id(chatId),id(senderId),now());
  return {
    ok:true,
    message:'🆘 Поддержка ХвостМаркета\n\nНапишите одним сообщением ваш вопрос или опишите проблему. '+
      'Я передам текст администраторам.\n\nДля отмены отправьте /cancel.',
  };
}
function cancelDraft(platform, chatId) {
  if (!ALLOWED_PLATFORMS.has(platform) || !id(chatId)) return false;
  return db.prepare('DELETE FROM bot_support_drafts WHERE platform=? AND chat_id=?')
    .run(platform,id(chatId)).changes > 0;
}
function submitTicket(platform, chatId, senderId, senderName, message) {
  if (!validIdentity(platform,chatId,senderId))
    return {ok:false,message:'Отправьте сообщение из своего личного чата с ботом.'};
  const checked=cleanBody(message);
  if (checked.error) return {ok:false,message:checked.error};
  const current=now();
  const last=db.prepare(
    'SELECT created_at FROM bot_support_tickets WHERE platform=? AND chat_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(platform,id(chatId));
  if (last && last.created_at > current - TICKET_COOLDOWN) {
    return {ok:false,message:'Подождите минуту перед следующим обращением. Если вы уже отправили вопрос, он сохранён.'};
  }
  const hourly=db.prepare(
    'SELECT COUNT(*) AS total FROM bot_support_tickets WHERE platform=? AND chat_id=? AND created_at>=?'
  ).get(platform,id(chatId),current-3600);
  if (hourly.total >= HOURLY_LIMIT) {
    return {ok:false,message:'Слишком много сообщений за час. Новое обращение можно отправить позднее.'};
  }
  const inserted=db.prepare(
    'INSERT INTO bot_support_tickets(platform,chat_id,sender_id,sender_name,body,created_at) '+
    'VALUES (?,?,?,?,?,?)'
  ).run(platform,id(chatId),id(senderId),cleanName(senderName),checked.body,current);
  cancelDraft(platform,chatId);
  const ticket=db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(inserted.lastInsertRowid);
  return {ok:true,ticket};
}
function consumeDraft(platform,chatId,senderId,senderName,text) {
  if (!validIdentity(platform,chatId,senderId)) return null;
  if (/^\//.test(String(text||'').trim())) return null;
  const draft=db.prepare(
    'SELECT sender_id,created_at FROM bot_support_drafts WHERE platform=? AND chat_id=?'
  ).get(platform,id(chatId));
  if (!draft) return null;
  if (draft.sender_id !== id(senderId) || draft.created_at <= now()-DRAFT_TTL) {
    cancelDraft(platform,chatId);
    return {ok:false,message:'Время ожидания истекло. Отправьте /support ещё раз.'};
  }
  return submitTicket(platform,chatId,senderId,senderName,text);
}
function activeAdmin(platform,chatId) {
  const column=platform==='telegram'?'telegram_chat_id':platform==='max'?'max_chat_id':null;
  if (!column || !id(chatId)) return false;
  return !!db.prepare(
    "SELECT 1 FROM admins WHERE active=1 AND role IN ('admin','super') AND "+
    "CAST("+column+" AS TEXT)=? LIMIT 1"
  ).get(id(chatId));
}
function adminRecipients() {
  const admins=db.prepare(
    "SELECT telegram_chat_id,max_chat_id FROM admins WHERE active=1 AND role IN ('admin','super')"
  ).all();
  const addresses=new Map();
  for (const admin of admins) {
    for(const platform of ['telegram','max']) {
      const chatId=id(admin[platform==='telegram'?'telegram_chat_id':'max_chat_id']);
      if (chatId) addresses.set(platform+':'+chatId,{platform,chatId});
    }
  }
  return [...addresses.values()];
}
function platformName(platform) { return platform==='telegram'?'Telegram':'MAX'; }
function notification(ticket) {
  return [
    '🆘 Новое обращение в поддержку ХвостМаркета · №'+ticket.id,
    'Канал: '+platformName(ticket.platform),
    'Отправитель: '+cleanName(ticket.sender_name),
    'ID чата: '+ticket.chat_id,
    '',
    ticket.body,
    '',
    'Ответить клиенту: /support_reply '+ticket.id+' ваш текст',
    'Неотвеченные: /support_inbox',
  ].join('\n');
}
async function sendToBot(platform,chatId,text) {
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
    return data?.ok!==false && !!data;
  }catch(err) {
    console.warn('[support] Не удалось доставить сообщение в '+platform+':',err.message);
    return false;
  }
}
async function notifyAdmins(ticket) {
  if (!ticket || !ticket.id) return {delivered:0,registered:0};
  const recipients=adminRecipients();
  const message=notification(ticket);
  const results=await Promise.all(recipients.map(item=>sendToBot(item.platform,item.chatId,message)));
  const delivered=results.filter(Boolean).length;
  if (delivered) {
    db.prepare('UPDATE bot_support_tickets SET delivery_count=delivery_count+? WHERE id=?')
      .run(delivered,ticket.id);
  }
  return {delivered,registered:recipients.length};
}
function confirmation(ticket,result) {
  return result.delivered>0
    ? '✅ Обращение №'+ticket.id+' отправлено администраторам. Ответ придёт сюда, в этот бот.'
    : '✅ Обращение №'+ticket.id+' сохранено, но уведомить администраторов пока не удалось. '+
      'Оно доступно им через /support_inbox. Если вопрос срочный, свяжитесь с менеджером.';
}
function inbox(platform, chatId) {
  if (!activeAdmin(platform,chatId)) {
    return {ok:false,message:'🔒 Список обращений доступен только подключённым администраторам.'};
  }
  const tickets=db.prepare(
    "SELECT id,platform,sender_name,body,created_at,delivery_count FROM bot_support_tickets "+
    "WHERE status='open' ORDER BY id DESC LIMIT 10"
  ).all();
  if(!tickets.length)return {ok:true,message:'✅ Неотвеченных обращений нет.'};
  return {ok:true,message:'🆘 Последние неотвеченные обращения:\n\n'+tickets.map(ticket=>
    '№'+ticket.id+' · '+platformName(ticket.platform)+' · '+cleanName(ticket.sender_name)+'\n'+
    ticket.body.replace(/\s+/g,' ').slice(0,90)+(ticket.body.length>90?'…':'')+
    '\nОтвет: /support_reply '+ticket.id+' текст'
  ).join('\n\n')};
}
async function replyToTicket(platform,chatId,senderId,ticketId,text) {
  if(!validIdentity(platform,chatId,senderId) ||
    !activeAdmin(platform,chatId))return {ok:false,message:'🔒 Отвечать клиентам могут только подключённые администраторы.'};
  const value=cleanBody(text);
  if(value.error)return {ok:false,message:value.error};
  const idValue=Number(ticketId);
  if(!Number.isSafeInteger(idValue) || idValue<=0)return {ok:false,message:'Укажите номер обращения: /support_reply 123 текст'};
  const ticket=db.prepare('SELECT * FROM bot_support_tickets WHERE id=?').get(idValue);
  if(!ticket)return {ok:false,message:'Обращение №'+idValue+' не найдено.'};
  if(ticket.status!=='open')return {ok:false,message:'По обращению №'+idValue+' уже ответили.'};
  const delivered=await sendToBot(ticket.platform,ticket.chat_id,
    '🐾 Ответ поддержки ХвостМаркета · обращение №'+ticket.id+'\n\n'+value.body+
    '\n\nЕсли потребуется помощь, отправьте /support.');
  if(!delivered)return {ok:false,message:'⚠️ Не удалось доставить ответ клиенту. Обращение осталось открытым.'};
  db.prepare(
    "UPDATE bot_support_tickets SET status='answered',answered_at=?,answer=?,answered_by=? "+
    "WHERE id=? AND status='open'"
  ).run(now(),value.body,platform+':'+id(chatId),ticket.id);
  return {ok:true,message:'✅ Ответ на обращение №'+ticket.id+' отправлен клиенту в '+platformName(ticket.platform)+'.'};
}
module.exports={
  DRAFT_TTL,MAX_BODY_LENGTH,startDraft,cancelDraft,submitTicket,consumeDraft,
  notifyAdmins,confirmation,inbox,replyToTicket,activeAdmin,adminRecipients,
};
