// Read-only admin registry: which personal Telegram chats are bound to which roles.
'use strict';
const db=require('./db');
require('./business-founders'); // ensure founder accounts are registered on a fresh database
const {sendJson}=require('./http-utils');
const {requireAuth}=require('./routes-auth');

// A verified Mini App phone without a saved account binding is not a connection.
const SOURCES=[
 {role:'founder',label:'Собственник',sql:"SELECT id,full_name AS name,login,phone,telegram_chat_id,active,NULL AS point_name,NULL AS admin_role FROM business_founders WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
 {role:'admin',label:'Администратор',sql:"SELECT id,full_name AS name,login,NULL AS phone,telegram_chat_id,active,NULL AS point_name,role AS admin_role FROM admins WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
 {role:'manager',label:'Менеджер',sql:"SELECT id,full_name AS name,login,phone,telegram_chat_id,active,NULL AS point_name,NULL AS admin_role FROM managers WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
 {role:'owner',label:'Владелец салона',sql:"SELECT o.id,o.full_name AS name,o.login,o.phone,o.telegram_chat_id,o.active,p.name AS point_name,NULL AS admin_role FROM salon_owners o LEFT JOIN points p ON p.id=o.point_id WHERE TRIM(COALESCE(o.telegram_chat_id,'')) <> ''"},
 {role:'partner',label:'Грумер',sql:"SELECT id,full_name AS name,login,phone,telegram_chat_id,active,point_name,NULL AS admin_role FROM partners WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
 {role:'task_assignee',label:'Исполнитель поручений',sql:"SELECT id,full_name AS name,NULL AS login,phone,telegram_chat_id,active,NULL AS point_name,NULL AS admin_role FROM task_assignees WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
 {role:'customer',label:'Покупатель',sql:"SELECT id,TRIM(COALESCE(name,'') || ' ' || COALESCE(lname,'')) AS name,NULL AS login,phone,telegram_chat_id,1 AS active,NULL AS point_name,NULL AS admin_role FROM customers WHERE TRIM(COALESCE(telegram_chat_id,'')) <> ''"},
];

function collectTelegramConnections(database=db){
 const grouped=new Map(),byRole=[];
 for(const source of SOURCES){
  const records=database.prepare(source.sql).all();
  byRole.push({role:source.role,label:source.label,accounts:records.length});
  for(const row of records){
   // Use the real Telegram chat as the grouping key. Same phone alone is not enough.
   const chat=String(row.telegram_chat_id||'').trim();
   if(!chat)continue;
   if(!grouped.has(chat))grouped.set(chat,{name:'',roles:[],phones:[],accounts:[]});
   const person=grouped.get(chat);
   const name=String(row.name||row.login||row.phone||'').trim() ||
    (source.role==='customer'?'Покупатель':'Без имени');
   const label=source.role==='admin'&&row.admin_role==='super'?'Супер-администратор':source.label;
   const phone=String(row.phone||'').trim();
   if(!person.name||person.name==='Покупатель'||person.name==='Без имени')person.name=name;
   if(!person.roles.includes(source.role))person.roles.push(source.role);
   if(phone&&!person.phones.includes(phone))person.phones.push(phone);
   person.accounts.push({role:source.role,role_label:label,account_id:row.id,
    name,login:String(row.login||''),phone,point_name:String(row.point_name||''),
    active:Number(row.active)===1});
  }
 }
 const people=[...grouped.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));
 return {people,summary:{people:people.length,
  accounts:people.reduce((n,p)=>n+p.accounts.length,0),by_role:byRole}};
}

function registerTelegramConnectionRoutes(router){
 router.get('/api/admin/telegram-connections',(req,res,ctx)=>{
  const session=requireAuth(['admin'])(req,res,ctx);
  if(!session)return;
  const admin=db.prepare('SELECT active FROM admins WHERE id=?').get(session.id);
  if(!admin||admin.active!==1)return sendJson(res,403,{error:'Учётная запись администратора отключена'});
  sendJson(res,200,collectTelegramConnections());
 });
}
module.exports={collectTelegramConnections,registerTelegramConnectionRoutes};
