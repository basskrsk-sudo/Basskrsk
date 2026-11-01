// Role-scoped task cards in Telegram Mini App for the three business founders
// and Angelina Funk. This reads and edits the existing meeting_tasks ledger.
'use strict';

const db = require('./db');
const { requireAuth } = require('./routes-auth');
const { sendJson } = require('./http-utils');
const { nextRecurringDue } = require('./task-utils');
require('./business-founders');

const PEOPLE = Object.freeze([
  { code:'alexey', name:'Лакомых Алексей', role:'founder' },
  { code:'vitaly', name:'Соколов Виталий', role:'founder' },
  { code:'nikolay', name:'Кучкин Николай', role:'founder' },
  { code:'angelina', name:'Ангелина Функ', role:'manager' },
]);
const ALLOWED_STATUSES = new Set(['new','in_progress','blocked','done']);

db.exec("CREATE TABLE IF NOT EXISTS miniapp_task_account_links (" +
  "account_role TEXT NOT NULL CHECK(account_role IN ('founder','manager'))," +
  "account_id INTEGER NOT NULL," +
  "assignee_id INTEGER NOT NULL REFERENCES task_assignees(id) ON DELETE CASCADE," +
  "linked_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "PRIMARY KEY(account_role,account_id)," +
  "UNIQUE(assignee_id))");

// Initialize trusted, persistent role-to-task mappings at startup. Later
// profile edits cannot change who owns an assignee's tasks.
function ensureTaskAccountBindings(database=db) {
  const founderCodes=PEOPLE.filter(p=>p.role==='founder');
  for (const person of founderCodes) {
    const assignee=database.prepare('SELECT id FROM task_assignees WHERE code=? AND active=1').get(person.code);
    const account=database.prepare('SELECT id FROM business_founders WHERE full_name=?').get(person.name);
    if (assignee&&account) database.prepare(
      "INSERT OR IGNORE INTO miniapp_task_account_links(account_role,account_id,assignee_id) " +
      "VALUES('founder',?,?)").run(account.id,assignee.id);
  }
  const angelina=database.prepare(
    "SELECT id,phone,telegram_chat_id FROM task_assignees WHERE code='angelina' AND active=1"
  ).get();
  if (!angelina) return;
  const existing=database.prepare(
    "SELECT 1 FROM miniapp_task_account_links WHERE assignee_id=?"
  ).get(angelina.id);
  if (existing) return;
  const managerRows=database.prepare(
    'SELECT id,full_name,phone,telegram_chat_id,active FROM managers WHERE active=1'
  ).all();
  const normalizedPhone=require('./miniapp-phone-identity').normalizeRussianPhone;
  const candidates=managerRows.filter(row=>{
    const name=cleanName(row.full_name);
    if (!['ангелина функ','функ ангелина','ангелина'].includes(name)) return false;
    // First-name-only records require independently matching contact data.
    const samePhone=angelina.phone &&
      normalizedPhone(angelina.phone)===normalizedPhone(row.phone);
    const sameTelegram=angelina.telegram_chat_id && row.telegram_chat_id &&
      String(angelina.telegram_chat_id)===String(row.telegram_chat_id);
    if (angelina.phone && !samePhone) return false;
    if (angelina.telegram_chat_id && row.telegram_chat_id && !sameTelegram) return false;
    return name!=='ангелина'||samePhone||sameTelegram;
  });
  if (candidates.length===1){
    database.prepare(
      "INSERT OR IGNORE INTO miniapp_task_account_links(account_role,account_id,assignee_id) " +
      "VALUES('manager',?,?)").run(candidates[0].id,angelina.id);
  }
}

function cleanName(name) {
  return String(name || '').toLocaleLowerCase('ru-RU').trim()
    .replace(/ё/g,'е').replace(/\s+/g,' ');
}
function taskMemberFromAccount(session, database=db) {
  if (!session || !['founder','manager'].includes(session.role) ||
      !Number.isSafeInteger(Number(session.id))) return null;
  const table=session.role==='founder'?'business_founders':'managers';
  const account=database.prepare(
    'SELECT id,phone,telegram_chat_id,active FROM '+table+' WHERE id=?'
  ).get(session.id);
  if (!account || Number(account.active)!==1) return null;
  // Persistent, uniquely bound account ID, never a mutable name in a request.
  const link=database.prepare(
    'SELECT a.id,a.code,a.full_name,a.phone,a.telegram_chat_id FROM miniapp_task_account_links l ' +
    'JOIN task_assignees a ON a.id=l.assignee_id AND a.active=1 ' +
    'WHERE l.account_role=? AND l.account_id=?'
  ).get(session.role,session.id);
  if (!link) return null;
  const person=PEOPLE.find(p=>p.code===link.code&&p.role===session.role);
  if (!person) return null;
  const normalize=require('./miniapp-phone-identity').normalizeRussianPhone;
  if (link.phone &&
      (!normalize(account.phone)||normalize(link.phone)!==normalize(account.phone))) return null;
  if (link.telegram_chat_id && account.telegram_chat_id &&
      String(link.telegram_chat_id)!==String(account.telegram_chat_id)) return null;
  return {id:link.id,code:link.code,name:person.name,
    loginRole:session.role,accountId:Number(account.id)};
}

const TASK_SELECT=[
  'SELECT t.id,t.title,t.description,t.due_date,t.priority,t.status,',
  't.assignee_id,t.recurrence_rule,t.created_at,t.updated_at,',
  'a.code AS assignee_code, a.full_name AS assignee_name,',
  '(SELECT h.new_value FROM meeting_task_history h',
  " WHERE h.task_id=t.id AND h.action IN ('status_report','link_comment','miniapp_note')",
  ' ORDER BY h.id DESC LIMIT 1) AS latest_report',
  'FROM meeting_tasks t LEFT JOIN task_assignees a ON a.id=t.assignee_id',
].join(' ');
const sortSql=[
  "CASE WHEN t.status IN ('done','cancelled') THEN 1 ELSE 0 END,",
  'CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,t.due_date,',
  "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,",
  't.id DESC',
].join(' ');
function todayKrasnoyarsk(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Krasnoyarsk',year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(now);
  const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return o.year+'-'+o.month+'-'+o.day;
}
function safeTask(row,today=todayKrasnoyarsk()){
  return {
    id:row.id,title:row.title,description:row.description||'',
    due_date:row.due_date||null,priority:row.priority,status:row.status,
    recurrence_rule:row.recurrence_rule||null,assignee_code:row.assignee_code||null,
    assignee_name:(PEOPLE.find(p=>p.code===row.assignee_code)||{}).name ||
      row.assignee_name || 'Без исполнителя',
    overdue:!!(row.due_date && row.due_date<today && !['done','cancelled'].includes(row.status)),
    latest_report:row.latest_report||null,
  };
}
function listTasksForMember(assigneeId,limit=500) {
  return db.prepare(TASK_SELECT+' WHERE t.assignee_id=? ORDER BY '+sortSql+' LIMIT ?')
    .all(assigneeId,limit);
}
function summaries(rows,today){
  const active=rows.filter(r=>!['done','cancelled'].includes(r.status));
  return {
    active:active.length, overdue:active.filter(r=>r.due_date&&r.due_date<today).length,
    today:active.filter(r=>r.due_date===today).length,
    in_progress:active.filter(r=>r.status==='in_progress').length,
    blocked:active.filter(r=>r.status==='blocked').length,
    done:rows.filter(r=>r.status==='done').length,
  };
}
function taskDashboard(actor){
  const today=todayKrasnoyarsk();
  const mine=listTasksForMember(actor.id);
  const result={
    actor:{name:actor.name,code:actor.code,role:actor.loginRole},
    today, summary:summaries(mine,today), my_tasks:mine.map(t=>safeTask(t,today)),
    team:null, can_edit_team:false,
  };
  if (actor.loginRole==='founder') {
    const members=db.prepare(
      'SELECT id,code,active FROM task_assignees WHERE code IN (?,?,?,?)'
    ).all(...PEOPLE.map(p=>p.code)).filter(p=>p.active===1);
    const ids=members.map(x=>x.id);
    const team=ids.length ? db.prepare(
      TASK_SELECT+' WHERE t.assignee_id IN ('+ids.map(()=>'?').join(',')+') '+
      'ORDER BY '+sortSql+' LIMIT 800'
    ).all(...ids):[];
    result.team={
      summary:summaries(team,today),
      members:PEOPLE.map(person=>{
        const member=members.find(m=>m.code===person.code);
        const items=team.filter(t=>member&&Number(t.assignee_id)===Number(member.id));
        return {code:person.code,name:person.name,summary:summaries(items,today)};
      }),
      tasks:team.map(t=>safeTask(t,today)),
    };
  }
  return result;
}
function validDue(value,today){
  if (value===null) return true;
  if (typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(value+'T00:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value) return false;
  const maxDate=new Date(today+'T00:00:00Z');
  maxDate.setUTCFullYear(maxDate.getUTCFullYear()+10);
  return value>=today && value<=maxDate.toISOString().slice(0,10);
}
function changeOwnTask(actor,taskId,body) {
  const id=Number(taskId);
  if(!Number.isSafeInteger(id)||id<1)return {status:400,error:'Неверный номер поручения'};
  if(!body || typeof body!=='object' || Array.isArray(body))return {status:400,error:'Неверные параметры'};
  const allowed=new Set(['status','comment','due_date','expected_status','expected_due']);
  if(Object.keys(body).some(k=>!allowed.has(k)))return {status:400,error:'Можно изменить только свой статус, комментарий или срок'};
  const hasStatus=Object.prototype.hasOwnProperty.call(body,'status');
  const hasDue=Object.prototype.hasOwnProperty.call(body,'due_date');
  const hasComment=Object.prototype.hasOwnProperty.call(body,'comment');
  if(!hasStatus&&!hasDue&&!hasComment)return {status:400,error:'Нет изменений'};
  if(hasStatus&&!ALLOWED_STATUSES.has(body.status))return {status:400,error:'Неверный статус'};
  if(hasComment && typeof body.comment!=='string')return {status:400,error:'Комментарий должен быть текстом'};
  const note=hasComment?body.comment.trim():'';
  if(note.length>1500)return {status:400,error:'Комментарий слишком длинный (максимум 1500 символов)'};
  if(hasComment&&!note&&!hasStatus&&!hasDue)return {status:400,error:'Введите комментарий'};
  const today=todayKrasnoyarsk();
  if(hasDue&&!validDue(body.due_date,today))return {status:400,error:'Укажите дату от сегодня до 10 лет вперёд'};
  let response=null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const task=db.prepare(
      'SELECT t.* FROM meeting_tasks t JOIN task_assignees a '+
      'ON a.id=t.assignee_id AND a.active=1 WHERE t.id=? AND t.assignee_id=?'
    ).get(id,actor.id);
    if(!task){db.exec('ROLLBACK');return {status:404,error:'Поручение не найдено среди ваших задач'};}
    if(['done','cancelled'].includes(task.status)){
      db.exec('ROLLBACK');return {status:409,error:'Закрытое поручение может повторно открыть только администратор'};
    }
    if(body.expected_status!=null && task.status!==body.expected_status ||
       Object.prototype.hasOwnProperty.call(body,'expected_due') &&
       (task.due_date||null)!==(body.expected_due||null)){
      db.exec('ROLLBACK');return {status:409,error:'Поручение уже изменилось. Обновите список'};
    }
    let status=hasStatus?body.status:task.status;
    let due=hasDue?body.due_date:task.due_date;
    if(task.recurrence_rule&&!due){
      db.exec('ROLLBACK');return {status:400,error:'Повторяющееся поручение должно иметь срок'};
    }
    let completed=status==='done'?new Date().toISOString():null;
    const recurrent=status==='done'&&!!task.recurrence_rule;
    if(recurrent){due=nextRecurringDue(due,task.recurrence_rule);status='new';completed=null;}
    const changed=status!==task.status || due!==task.due_date;
    if(changed){
      const updated=db.prepare(
        "UPDATE meeting_tasks SET status=?,due_date=?,completed_at=?,updated_at=datetime('now') "+
        "WHERE id=? AND assignee_id=? AND status=? AND COALESCE(due_date,'')=?"
      ).run(status,due,completed,id,actor.id,task.status,task.due_date||'');
      if(updated.changes!==1)throw Error('Concurrent task update rejected');
    } else if(note){
      db.prepare("UPDATE meeting_tasks SET updated_at=datetime('now') WHERE id=?").run(id);
    }
    const history=db.prepare(
      'INSERT INTO meeting_task_history(task_id,action,old_value,new_value,actor) VALUES(?,?,?,?,?)'
    );
    const who=actor.name+' · Mini App';
    if(recurrent){
      history.run(id,'miniapp_completed_recurring',task.due_date,due,who);
    } else {
      if(status!==task.status)history.run(id,'miniapp_status',task.status,status,who);
      if(due!==task.due_date)history.run(id,'miniapp_due',task.due_date,due,who);
    }
    if(note)history.run(id,'miniapp_note',null,note,who);
    db.exec('COMMIT');
    response={
      status:200,body:{ok:true,status,next_due_date:due,recurring_advanced:recurrent,
        message:recurrent?'Выполнение зафиксировано, создан следующий срок':
          status==='done'?'Поручение выполнено':'Изменения сохранены'},
    };
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return response;
}
function registerMiniAppTaskRoutes(router){
  router.get('/api/miniapp/tasks',(req,res,ctx)=>{
    const auth=requireAuth(['founder','manager'])(req,res,ctx);
    if(!auth)return;
    const actor=taskMemberFromAccount(auth);
    if(!actor)return sendJson(res,403,{error:'Нет доступа к поручениям этого кабинета. Проверьте назначение исполнителя'});
    sendJson(res,200,taskDashboard(actor));
  });
  router.post('/api/miniapp/tasks/:id',(req,res,ctx)=>{
    const auth=requireAuth(['founder','manager'])(req,res,ctx);
    if(!auth)return;
    const actor=taskMemberFromAccount(auth);
    if(!actor)return sendJson(res,403,{error:'Нет доступа к поручениям этого кабинета'});
    const result=changeOwnTask(actor,ctx.params.id,ctx.body);
    sendJson(res,result.status,result.body||{error:result.error});
  });
}
module.exports={
  PEOPLE,ensureTaskAccountBindings,taskMemberFromAccount,taskDashboard,changeOwnTask,
  summaries,validDue,todayKrasnoyarsk,registerMiniAppTaskRoutes,
};
