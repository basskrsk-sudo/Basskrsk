// Notify administrators when a REAL Telegram bot account binding is saved.
// Login checks and repeated /start commands with the same chat are not events.
// SQLite outbox survives redeploys and retries temporary Telegram failures.
'use strict';

const db=require('./db');
const ROLE_INFO=Object.freeze({
  customer:{table:'customers',label:'Покупатель',
    fields:"TRIM(COALESCE(a.name,'') || ' ' || COALESCE(a.lname,'')) AS account_name,a.phone,NULL AS salon_name,1 AS active",
    join:''},
  partner:{table:'partners',label:'Грумер',
    fields:'a.full_name AS account_name,a.phone,a.point_name AS salon_name,a.active',
    join:''},
  owner:{table:'salon_owners',label:'Владелец салона',
    fields:'a.full_name AS account_name,a.phone,p.name AS salon_name,a.active',
    join:' LEFT JOIN points p ON p.id=a.point_id'},
  manager:{table:'managers',label:'Менеджер',
    fields:'a.full_name AS account_name,a.phone,NULL AS salon_name,a.active',
    join:''},
  founder:{table:'business_founders',label:'Собственник бизнеса',
    fields:'a.full_name AS account_name,a.phone,NULL AS salon_name,a.active',
    join:''},
  admin:{table:'admins',label:'Администратор',
    fields:'COALESCE(a.full_name,a.login) AS account_name,NULL AS phone,NULL AS salon_name,a.active',
    join:''},
  task_assignee:{table:'task_assignees',label:'Исполнитель поручений',
    fields:'a.full_name AS account_name,a.phone,NULL AS salon_name,a.active',
    join:''},
});

function ensureBotConnectionAlertTables(database=db){
  database.exec(
    'CREATE TABLE IF NOT EXISTS bot_connection_events ('+
    'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
    'role TEXT NOT NULL,account_id INTEGER NOT NULL,chat_id TEXT NOT NULL,'+
    'event_type TEXT NOT NULL,account_name TEXT NOT NULL,'+
    'role_label TEXT NOT NULL,salon_name TEXT,phone_masked TEXT,'+
    "created_at TEXT NOT NULL DEFAULT (datetime('now')));"+
    'CREATE TABLE IF NOT EXISTS bot_connection_deliveries ('+
    'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
    'event_id INTEGER NOT NULL REFERENCES bot_connection_events(id) ON DELETE CASCADE,'+
    'target_chat_id TEXT NOT NULL,target_kind TEXT NOT NULL,'+
    "state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,"+
    'last_attempt_at TEXT,delivered_at TEXT,'+
    'UNIQUE(event_id,target_chat_id));'+
    'CREATE INDEX IF NOT EXISTS idx_bot_connection_pending '+
    'ON bot_connection_deliveries(state,last_attempt_at);'
  );
}
ensureBotConnectionAlertTables();

function snapshot(database,role,id){
  const meta=ROLE_INFO[role];
  const num=Number(id);
  if(!meta||!Number.isSafeInteger(num)||num<1)return null;
  return database.prepare('SELECT a.id,a.telegram_chat_id,'+meta.fields+
    ' FROM '+meta.table+' a'+meta.join+' WHERE a.id=?').get(num)||null;
}
function maskPhone(raw){
  const digits=String(raw||'').replace(/\D/g,'');
  if(digits.length<10)return '';
  return '+7 (***) ***-**-'+digits.slice(-2);
}
function escapeHtml(raw){
  return String(raw==null?'':raw).replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[c]);
}

// Store exactly one event per actual change in a role/account -> chat binding.
// All DB writes and outbox recipients are one transaction; no fake alerts for
// unverified /phone attempts, old /start links or routine login requests.
function bindTelegramAccount(role,accountId,chatId,options={}){
  const database=options.database||db;
  const meta=ROLE_INFO[role];
  const numericId=Number(accountId);
  const chat=String(chatId==null?'':chatId).trim();
  if(!meta||!Number.isSafeInteger(numericId)||numericId<1||
    !/^[1-9][0-9]{0,19}$/.test(chat)){
    return {changed:false,error:'Некорректные данные Telegram-подключения'};
  }
  database.exec('BEGIN IMMEDIATE');
  try{
    const user=snapshot(database,role,numericId);
    if(!user||Number(user.active)!==1){
      database.exec('ROLLBACK');
      return {changed:false,error:'Аккаунт отсутствует или отключён'};
    }
    if(String(user.telegram_chat_id||'').trim()===chat){
      database.exec('COMMIT');
      return {changed:false};
    }
    const newConnection=!String(user.telegram_chat_id||'').trim();
    database.prepare('UPDATE '+meta.table+' SET telegram_chat_id=? WHERE id=?')
      .run(chat,numericId);
    const event=database.prepare(
      'INSERT INTO bot_connection_events '+
      '(role,account_id,chat_id,event_type,account_name,role_label,salon_name,phone_masked) '+
      'VALUES (?,?,?,?,?,?,?,?)'
    ).run(role,numericId,chat,newConnection?'connected':'reconnected',
      String(user.account_name||'').trim()||'Не указано',
      meta.label,String(user.salon_name||'').trim()||null,maskPhone(user.phone)||null);
    const eventId=Number(event.lastInsertRowid);
    // Both private admin chats and the configured service/admin chat may
    // receive the alert. Duplicate chat IDs are deliberately collapsed.
    const recipients=new Map();
    const businessChat=String(options.businessChatId===undefined?
      (process.env.TG_CHAT_ID||''):options.businessChatId||'').trim();
    if(businessChat)recipients.set(businessChat,'business');
    const admins=database.prepare(
      "SELECT telegram_chat_id FROM admins WHERE active=1 AND "+
      "TRIM(COALESCE(telegram_chat_id,''))<>''"
    ).all();
    for(const admin of admins){
      const id=String(admin.telegram_chat_id||'').trim();
      if(id&&!recipients.has(id))recipients.set(id,'admin');
    }
    const insert=database.prepare(
      'INSERT INTO bot_connection_deliveries '+
      '(event_id,target_chat_id,target_kind) VALUES (?,?,?)'
    );
    for(const [id,kind] of recipients)insert.run(eventId,id,kind);
    database.exec('COMMIT');
    if(!options.deferDelivery&&process.env.TG_TOKEN){
      // Never delay or fail the user's successful Telegram login because an
      // administrator blocked the bot, Telegram was down, or a chat was moved.
      Promise.resolve().then(()=>flushBotConnectionAlerts({database}))
        .catch(e=>console.error('Telegram connection alert:',e.message));
    }
    return {changed:true,eventId,recipients:recipients.size};
  }catch(error){
    try{database.exec('ROLLBACK');}catch(_){}
    throw error;
  }
}

function formatConnectionAlert(event){
  const timestamp=new Date(String(event.created_at).replace(' ','T')+'Z');
  const date=Number.isFinite(timestamp.getTime())
    ?timestamp.toLocaleString('ru-RU',{timeZone:'Asia/Krasnoyarsk',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
    :'Не определено';
  return [
    event.event_type==='reconnected'?
      '🔄 <b>Telegram-бот переподключён</b>':'🔔 <b>Новое подключение Telegram-бота</b>',
    '',
    '👤 <b>'+escapeHtml(event.account_name)+'</b>',
    '🎭 Роль: <b>'+escapeHtml(event.role_label)+'</b>',
    ...(event.salon_name?['🏪 Салон: '+escapeHtml(event.salon_name)]:[]),
    ...(event.phone_masked?['📱 Телефон: '+escapeHtml(event.phone_masked)]:[]),
    '🗓 '+escapeHtml(date)+' (Красноярск)',
    '',
    '✅ Telegram связан с учётной записью ХвостМаркета.',
  ].join('\n');
}

let inProgress=null;
async function flushBotConnectionAlerts(options={}){
  if(inProgress)return inProgress;
  const database=options.database||db;
  const send=options.sendToChat||((...args)=>require('./telegram').sendToChat(...args));
  inProgress=(async()=>{
    const rows=database.prepare(
      'SELECT d.id,d.target_chat_id,d.target_kind,d.attempts,'+
      'e.account_name,e.role_label,e.salon_name,e.phone_masked,e.event_type,e.created_at '+
      'FROM bot_connection_deliveries d JOIN bot_connection_events e ON e.id=d.event_id '+
      "WHERE d.state='pending' AND d.attempts<30 AND "+
      "(d.last_attempt_at IS NULL OR d.last_attempt_at<=datetime('now','-2 minutes')) "+
      'ORDER BY d.id LIMIT 25'
    ).all();
    let sent=0,failed=0,cancelled=0;
    for(const row of rows){
      const target=String(row.target_chat_id);
      const allowed=row.target_kind==='business'
        ?target===String(options.businessChatId===undefined?
          process.env.TG_CHAT_ID||'':options.businessChatId||'').trim()
        :!!database.prepare(
          'SELECT 1 FROM admins WHERE active=1 AND telegram_chat_id=? LIMIT 1'
        ).get(target);
      if(!allowed){
        database.prepare(
          "UPDATE bot_connection_deliveries SET state='cancelled' WHERE id=?"
        ).run(row.id);
        cancelled++;
        continue;
      }
      database.prepare(
        "UPDATE bot_connection_deliveries SET attempts=attempts+1,last_attempt_at=datetime('now') WHERE id=?"
      ).run(row.id);
      try{
        const result=await send(target,formatConnectionAlert(row));
        if(result&&result.ok){
          database.prepare(
            "UPDATE bot_connection_deliveries SET state='sent',delivered_at=datetime('now') WHERE id=?"
          ).run(row.id);
          sent++;
        }else{
          failed++;
          console.warn('Telegram: не отправлено уведомление о подключении (#'+row.id+')');
        }
      }catch(error){
        failed++;
        console.warn('Telegram: сбой отправки уведомления о подключении (#'+
          row.id+'):',error.message);
      }
    }
    return {sent,failed,cancelled};
  })();
  try{return await inProgress;}finally{inProgress=null;}
}

let worker=null;
function startBotConnectionAlertWorker(){
  if(worker||!process.env.TG_TOKEN)return;
  flushBotConnectionAlerts().catch(e=>console.error('Telegram alerts:',e.message));
  worker=setInterval(()=>{
    flushBotConnectionAlerts().catch(e=>console.error('Telegram alerts:',e.message));
  },60*1000);
  if(typeof worker.unref==='function')worker.unref();
}

module.exports={
  bindTelegramAccount,flushBotConnectionAlerts,formatConnectionAlert,
  ensureBotConnectionAlertTables,startBotConnectionAlertWorker,
};
