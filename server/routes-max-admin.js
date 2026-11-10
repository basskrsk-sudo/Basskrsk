// MAX bot operational administration. Only authenticated, active admins see
// connection data. Destructive actions are restricted to an active super-admin.
// Bot credentials remain in Amvera environment variables and are never exposed.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');
const maxBot = require('./max-bot');

const PER_PAGE = 60;
const SOURCES = Object.freeze([
  { role:'customer', label:'Покупатель', table:'customers',
    name:"TRIM(COALESCE(a.name,'') || ' ' || COALESCE(a.lname,''))", login:"''",
    point:"''", active:'1', phone:'a.phone' },
  { role:'partner', label:'Грумер', table:'partners',
    name:'a.full_name', login:'a.login', point:'a.point_name', active:'a.active', phone:'a.phone' },
  { role:'owner', label:'Владелец салона', table:'salon_owners',
    name:'a.full_name', login:'a.login', point:"COALESCE(p.name,'')",
    join:' LEFT JOIN points p ON p.id=a.point_id',active:'a.active',phone:'a.phone' },
  { role:'manager', label:'Менеджер', table:'managers',
    name:'a.full_name', login:'a.login', point:"''", active:'a.active',phone:'a.phone' },
  { role:'assignee', label:'Исполнитель поручений', table:'task_assignees',
    name:'a.full_name',login:"''",point:"''",active:'a.active',phone:'a.phone' },
]);

db.exec(
  'CREATE TABLE IF NOT EXISTS max_bot_admin_log ('+
  'id INTEGER PRIMARY KEY AUTOINCREMENT,'+
  'admin_id INTEGER NOT NULL,action TEXT NOT NULL,'+
  'target_role TEXT,target_id INTEGER,success INTEGER NOT NULL,'+
  "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
);
db.exec('CREATE INDEX IF NOT EXISTS idx_max_bot_admin_log_created ON max_bot_admin_log(created_at DESC)');

function normalizePhone(phone) {
  const digits=String(phone||'').replace(/\D/g,'');
  return digits.length>=10?digits.slice(-10):'';
}
function maskPhone(phone) {
  const digits=normalizePhone(phone);
  return digits?'+7 ••• •••-••-'+digits.slice(-2):'—';
}
function maskChat(chat) {
  const value=String(chat||'');
  return value.length>4?'••••'+value.slice(-4):'••••';
}
function unionSql() {
  return SOURCES.map(source =>
    'SELECT \''+source.role+'\' AS role, a.id AS account_id, '+
    source.name+' AS name, '+source.login+' AS login, '+
    source.phone+' AS phone, '+source.point+' AS point_name, '+
    source.active+' AS active, a.max_chat_id AS chat_id '+
    'FROM '+source.table+' a'+(source.join||'')+
    " WHERE TRIM(COALESCE(a.max_chat_id,''))<>''"
  ).join(' UNION ALL ');
}
const CONNECTION_SQL=unionSql();
const ROLES=Object.fromEntries(SOURCES.map(x=>[x.role,x]));

function listConnections({page=1,role='',search=''}={},database=db) {
  const target=String(role||'').trim();
  if (target && !ROLES[target]) {
    const error=new Error('Неизвестная роль');error.statusCode=400;throw error;
  }
  const n=Number(page);
  if (!Number.isSafeInteger(n)||n<1||n>100000) {
    const error=new Error('Некорректный номер страницы');error.statusCode=400;throw error;
  }
  const q=String(search||'').trim().slice(0,90);
  const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
  const where=" WHERE (? = '' OR role = ?) AND (? = '' OR name LIKE ? ESCAPE '\\' OR login LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR point_name LIKE ? ESCAPE '\\')";
  const params=[target,target,q,pattern,pattern,pattern,pattern];
  const total=database.prepare('SELECT COUNT(*) AS n FROM ('+CONNECTION_SQL+')'+where).get(...params).n;
  const rows=database.prepare(
    'SELECT role,account_id,name,login,phone,point_name,active,chat_id '+
    'FROM ('+CONNECTION_SQL+')'+where+
    ' ORDER BY name COLLATE NOCASE,role,account_id LIMIT ? OFFSET ?'
  ).all(...params,PER_PAGE,(n-1)*PER_PAGE);
  return {
    page:n,per_page:PER_PAGE,total,
    pages:Math.max(1,Math.ceil(total/PER_PAGE)),
    rows:rows.map(row=>({
      role:row.role,role_label:ROLES[row.role].label,
      account_id:row.account_id,name:String(row.name||row.login||'Без имени'),
      login:String(row.login||''),phone_masked:maskPhone(row.phone),
      point_name:String(row.point_name||''),chat_masked:maskChat(row.chat_id),
      active:!!row.active
    })),
  };
}
function connectionStats(database=db) {
  const data=database.prepare('SELECT role,COUNT(*) AS n FROM ('+CONNECTION_SQL+') GROUP BY role').all();
  const byRole=SOURCES.map(x=>({
    role:x.role,label:x.label,accounts:Number(data.find(r=>r.role===x.role)?.n||0)
  }));
  const people=database.prepare('SELECT COUNT(DISTINCT chat_id) AS n FROM ('+CONNECTION_SQL+')').get().n;
  return {
    people,accounts:byRole.reduce((a,b)=>a+b.accounts,0),by_role:byRole
  };
}
function record(adminId,action,success,role=null,id=null,database=db) {
  database.prepare(
    'INSERT INTO max_bot_admin_log(admin_id,action,target_role,target_id,success) VALUES(?,?,?,?,?)'
  ).run(adminId,action,role,id,success?1:0);
}
function readStatus(database=db, bot=maxBot) {
  const token=!!process.env.MAX_BOT_TOKEN;
  const username=String(process.env.MAX_BOT_USERNAME||'').trim().replace(/^@/,'');
  const validUsername=/^[A-Za-z0-9_]{1,80}$/.test(username);
  const webhook=!!process.env.MAX_WEBHOOK_SECRET;
  const lastSync=database.prepare(
    "SELECT created_at,success FROM max_bot_admin_log WHERE action='sync_commands' "+
    'ORDER BY id DESC LIMIT 1'
  ).get()||null;
  return {
    configured:bot.isConfigured(),
    token_configured:token,
    username_configured:validUsername,
    webhook_secret_configured:webhook,
    webhook_path:'/api/max/webhook',
    bot_url:validUsername?'https://max.ru/'+username:null,
    commands:bot.MAX_BOT_COMMANDS.map(x=>({...x})),
    connections:connectionStats(database),
    last_manual_commands_sync:lastSync,
    // No external health probe is performed when opening this screen.
    detail:'Состояние настроек в Amvera, не проверка доставки MAX в реальном времени.',
  };
}
function getAdmin(req,res,ctx,database=db,superOnly=false) {
  const claims=requireActiveAdmin(req,res,ctx);
  if(!claims)return null;
  const account=database.prepare('SELECT id,role,phone FROM admins WHERE id=? AND active=1')
    .get(claims.id);
  if(!account){sendJson(res,403,{error:'Администратор отключён'});return null;}
  if(superOnly&&account.role!=='super'){
    sendJson(res,403,{error:'Доступно только супер-администратору'});return null;
  }
  return account;
}
function personalMaxChat(admin,database=db) {
  const phone=normalizePhone(admin.phone);
  if(!phone)return null;
  // Confirmed connections already saved by existing login/linking flows.
  // Only send to a linked account with the administrator's own phone.
  for(const table of ['task_assignees','managers','salon_owners','partners','customers']){
    const condition=table==='customers'?'1=1':'active=1';
    const rows=database.prepare(
      'SELECT phone,max_chat_id FROM '+table+' WHERE '+condition+
      " AND TRIM(COALESCE(max_chat_id,''))<>''"
    ).all();
    const own=rows.find(a=>normalizePhone(a.phone)===phone);
    if(own)return own.max_chat_id;
  }
  return null;
}
function disconnect(role,accountId,database=db) {
  const meta=ROLES[role],id=Number(accountId);
  if(!meta||!Number.isSafeInteger(id)||id<1){
    const error=new Error('Некорректная роль или учётная запись');
    error.statusCode=400;throw error;
  }
  const existing=database.prepare('SELECT id,phone,max_chat_id FROM '+meta.table+' WHERE id=?').get(id);
  if(!existing||!existing.max_chat_id){
    const error=new Error('Подключение не найдено');
    error.statusCode=404;throw error;
  }
  const result=database.prepare('UPDATE '+meta.table+" SET max_chat_id=NULL WHERE id=? AND TRIM(COALESCE(max_chat_id,''))<>''").run(id);
  // Disable pending/verified MAX logins for this exact account where possible.
  const tokenRole=role==='assignee'?'task_assignee':role;
  if(role==='customer'){
    database.prepare("DELETE FROM max_login_tokens WHERE role='customer' AND (phone=? OR chat_id=?)")
      .run(existing.phone,existing.max_chat_id);
  }else{
    database.prepare('DELETE FROM max_login_tokens WHERE role=? AND account_id=?')
      .run(tokenRole,id);
  }
  return {changed:result.changes===1};
}

function registerMaxAdminRoutes(router,{database=db,bot=maxBot}={}) {
  router.get('/api/admin/max/overview',(req,res,ctx)=>{
    if(!getAdmin(req,res,ctx,database))return;
    sendJson(res,200,readStatus(database,bot));
  });
  router.get('/api/admin/max/connections',(req,res,ctx)=>{
    if(!getAdmin(req,res,ctx,database))return;
    try {
      sendJson(res,200,listConnections(ctx.query||{},database));
    }catch(e){sendJson(res,e.statusCode||500,{error:e.statusCode?e.message:'Ошибка реестра MAX'});}
  });
  router.get('/api/admin/max/history',(req,res,ctx)=>{
    if(!getAdmin(req,res,ctx,database))return;
    const rows=database.prepare(
      "SELECT l.action,l.target_role,l.target_id,l.success,l.created_at,"+
      "COALESCE(a.full_name,a.login,'Администратор') AS actor "+
      "FROM max_bot_admin_log l LEFT JOIN admins a ON a.id=l.admin_id "+
      "ORDER BY l.id DESC LIMIT 25"
    ).all();
    sendJson(res,200,{rows});
  });
  router.post('/api/admin/max/commands/sync',async(req,res,ctx)=>{
    const admin=getAdmin(req,res,ctx,database,true);if(!admin)return;
    // This route does not let a caller set arbitrary commands/strings.
    // Avoid repeated network retries when an operator double-clicks the button.
    const last=database.prepare(
      "SELECT created_at FROM max_bot_admin_log WHERE admin_id=? "+
      "AND action='sync_commands' AND created_at>datetime('now','-20 seconds') "+
      "ORDER BY id DESC LIMIT 1"
    ).get(admin.id);
    if(last)return sendJson(res,429,{error:'Повтор синхронизации — не чаще одного раза за 20 секунд'});
    record(admin.id,'sync_commands',false,null,null,database);
    const result=await bot.configureMaxCommands();
    database.prepare("UPDATE max_bot_admin_log SET success=? WHERE id=("+
      "SELECT id FROM max_bot_admin_log WHERE admin_id=? "+
      "AND action='sync_commands' ORDER BY id DESC LIMIT 1)").run(result.ok?1:0,admin.id);
    sendJson(res,result.ok?200:503,
      result.ok?{ok:true,message:'Штатное меню MAX успешно обновлено'}:
        {error:'Не удалось обновить меню MAX. Проверьте настройки подключения и журнал сервера.'});
  });
  router.post('/api/admin/max/test',async(req,res,ctx)=>{
    const admin=getAdmin(req,res,ctx,database);if(!admin)return;
    const chat=personalMaxChat(admin,database);
    if(!chat)return sendJson(res,409,{
      error:'Личный MAX администратора не подключён. Привяжите его через раздел «Поручения», указав тот же номер, что и у администратора.'
    });
    const last=database.prepare(
      "SELECT created_at FROM max_bot_admin_log WHERE admin_id=? AND action='test_message' "+
      "AND created_at>datetime('now','-1 minute') ORDER BY id DESC LIMIT 1"
    ).get(admin.id);
    if(last)return sendJson(res,429,{error:'Тестовое сообщение разрешено не чаще одного раза в минуту'});
    // Reserve cooldown before network call to avoid concurrent duplicate messages.
    record(admin.id,'test_message',false,null,null,database);
    const result=await bot.sendMaxMessage(chat,'🧪 ХвостМаркет · тестовое сообщение из раздела MAX админки. Команды: /help, /tasks, /stock.');
    if(result?.ok===false||result?.error){
      return sendJson(res,502,{error:'MAX не подтвердил отправку тестового сообщения. Проверьте настройки и чат с ботом.'});
    }
    database.prepare("UPDATE max_bot_admin_log SET success=1 WHERE id=("+
      "SELECT id FROM max_bot_admin_log WHERE admin_id=? AND action='test_message' ORDER BY id DESC LIMIT 1)").run(admin.id);
    sendJson(res,200,{ok:true,message:'Тестовое сообщение отправлено в личный MAX администратора'});
  });
  router.post('/api/admin/max/connections/disconnect',(req,res,ctx)=>{
    const admin=getAdmin(req,res,ctx,database,true);if(!admin)return;
    const role=String(ctx.body?.role||''),id=ctx.body?.account_id;
    try{
      const result=disconnect(role,id,database);
      record(admin.id,'disconnect',result.changed,role,Number(id),database);
      sendJson(res,200,{ok:true,disconnected:result.changed,
        message:'MAX отключён от выбранной учётной записи. Другие роли и каналы не затронуты.'});
    }catch(e){
      sendJson(res,e.statusCode||500,
        {error:e.statusCode?e.message:'Не удалось отключить привязку MAX'});
    }
  });
}
module.exports={
  SOURCES,collectMaxConnections:listConnections,connectionStats,readStatus,
  disconnect,personalMaxChat,registerMaxAdminRoutes,
};
