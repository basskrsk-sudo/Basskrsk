// One daily per-assignee PDF in Telegram (and a single MAX digest).
// Snapshot and ownership are taken directly from SQLite for each send.
'use strict';
const db = require('./db');
const { renderTaskDailyDigestPdf } = require('./task-daily-digest-pdf');
const { taskListMarkup } = require('./task-bot-actions');
const { sendMaxMessage } = require('./max-bot');

const TZ = 'Asia/Krasnoyarsk';
const TG_TOKEN = process.env.TG_TOKEN || '';

function localParts(now=new Date()){
  const pieces=new Intl.DateTimeFormat('en-CA',{
    timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',hourCycle:'h23',
  }).formatToParts(now);
  return Object.fromEntries(pieces.map(piece=>[piece.type,piece.value]));
}
function localDate(now=new Date()){
  const p=localParts(now);
  return p.year+'-'+p.month+'-'+p.day;
}
function groupTask(task,today){
  if(task.due_date&&task.due_date<today)return 'overdue';
  if(task.status==='in_progress'||task.status==='blocked'||!task.due_date||task.due_date===today)return 'work';
  return 'later';
}
function buildTaskDigest(assignee,tasks,now=new Date()){
  const today=localDate(now);
  const sections={overdue:[],work:[],later:[]};
  for(const task of tasks){
    if(['done','cancelled'].includes(task.status))continue;
    sections[groupTask(task,today)].push(task);
  }
  const priority={critical:0,high:1,normal:2,low:3};
  const sort=(a,b)=>(a.due_date||'9999-12-31').localeCompare(b.due_date||'9999-12-31')||
    (priority[a.priority]??2)-(priority[b.priority]??2) || a.id-b.id;
  for(const key of Object.keys(sections))sections[key].sort(sort);
  return{
    assignee:{id:assignee.id,full_name:assignee.full_name},
    local_date:today,generated_at:now.toISOString(),sections,
    totals:{
      overdue:sections.overdue.length,work:sections.work.length,later:sections.later.length,
      total:sections.overdue.length+sections.work.length+sections.later.length,
    },
  };
}
function tasksForAssignee(assigneeId){
  return db.prepare([
    "SELECT id,title,description,status,due_date,priority,recurrence_rule,reminder_enabled",
    "FROM meeting_tasks WHERE assignee_id=? AND status NOT IN ('done','cancelled')",
    "ORDER BY due_date,id",
  ].join(' ')).all(assigneeId);
}
function assigneeByTelegram(chatId){
  if(!chatId)return null;
  return db.prepare(
    'SELECT id,full_name,telegram_chat_id,max_chat_id FROM task_assignees '+
    'WHERE active=1 AND telegram_chat_id=? LIMIT 1'
  ).get(String(chatId));
}
function queuedAssignees(){
  return db.prepare([
    'SELECT a.id,a.full_name,a.telegram_chat_id,a.max_chat_id',
    'FROM task_assignees a',
    'WHERE a.active=1',
    "AND (COALESCE(TRIM(a.telegram_chat_id),'')!='' OR COALESCE(TRIM(a.max_chat_id),'')!='')",
    'AND EXISTS (SELECT 1 FROM meeting_tasks t',
    "WHERE t.assignee_id=a.id AND t.status NOT IN ('done','cancelled')",
    'AND t.reminder_enabled=1)',
    'ORDER BY a.id',
  ].join(' ')).all();
}

async function sendTelegramTaskPdf(chatId,report,bytes){
  if(!TG_TOKEN)throw Error('Telegram token is not configured');
  const blob=new Blob([bytes],{type:'application/pdf'});
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption','📋 Поручения ХвостМаркета · '+report.local_date+
    '\n🔴 Просрочено: '+report.totals.overdue+
    ' · 🟢 В работе: '+report.totals.work+
    ' · 📅 Позже: '+report.totals.later+
    '\nДля управления откройте список кнопкой ниже.');
  form.append('reply_markup',JSON.stringify(taskListMarkup()));
  form.append('document',blob,
    'HvostMarket_tasks_'+report.local_date+'_'+report.assignee.id+'.pdf');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/sendDocument',{
      method:'POST',body:form,signal:controller.signal,
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.ok){
      const error=new Error(result.description||'Telegram HTTP '+response.status);
      error.status=response.status;
      throw error;
    }
    return {ok:true,message_id:result.result?.message_id||null};
  }finally{clearTimeout(timeout);}
}
function maxSummary(report){
  const items=[
    '📋 ХвостМаркет · поручения на '+report.local_date,
    'Ответственный: '+report.assignee.full_name,
    '🔴 Просрочено: '+report.totals.overdue,
    '🟢 В работе: '+report.totals.work,
    '📅 Позже: '+report.totals.later,
  ];
  if(report.sections.overdue.length){
    items.push('','Сначала проверьте просроченные:');
    for(const task of report.sections.overdue.slice(0,4)){
      items.push('№'+task.id+' · '+String(task.title).slice(0,85));
    }
  }
  items.push('','/tasks — список и управление поручениями');
  return items.join('\n');
}

async function deliverAssigneeDigest(assignee,channel,now=new Date(),manual=false,deps={}){
  const chatId=channel==='telegram'?assignee.telegram_chat_id:assignee.max_chat_id;
  if(!chatId)return {ok:false,skipped:true,channel};
  const day=localDate(now);
  if(!manual){
    const reserved=db.prepare(
      "INSERT OR IGNORE INTO task_daily_digest_log(assignee_id,local_date,channel,status) "+
      "VALUES (?,?,?,'pending')"
    ).run(assignee.id,day,channel);
    if(!reserved.changes)return {ok:false,skipped:true,channel,already_sent_or_attempted:true};
  }
  let delivery;
  try{
    const report=buildTaskDigest(assignee,tasksForAssignee(assignee.id),now);
    if(channel==='telegram'){
      const render=deps.renderPdf||renderTaskDailyDigestPdf;
      const send=deps.sendTelegram||sendTelegramTaskPdf;
      const pdf=await render(report);
      delivery=await send(chatId,report,pdf);
    }else{
      const send=deps.sendMax||sendMaxMessage;
      delivery=await send(chatId,maxSummary(report));
    }
    const ok=!!delivery && delivery.ok!==false && !delivery.error;
    if(!ok)throw Error(String(delivery?.error||'Messaging API did not confirm delivery'));
    if(!manual)db.prepare(
      "UPDATE task_daily_digest_log SET status='sent',error=NULL,message_id=?,"+
      "sent_at=datetime('now') WHERE assignee_id=? AND local_date=? AND channel=?"
    ).run(delivery.message_id?String(delivery.message_id):null,assignee.id,day,channel);
    return {ok:true,channel,assignee_id:assignee.id,date:day};
  }catch(error){
    if(!manual){
      db.prepare(
        "UPDATE task_daily_digest_log SET status='failed',error=? "+
        "WHERE assignee_id=? AND local_date=? AND channel=?"
      ).run(String(error.message||error).slice(0,490),assignee.id,day,channel);
    }
    console.error('[task-digest] Ошибка отправки',channel,assignee.id,error);
    return {ok:false,channel,assignee_id:assignee.id,date:day,error:error.message};
  }
}
async function runDailyTaskDigest(now=new Date(),deps={}){
  const p=localParts(now);
  if(Number(p.hour)!==10)return [];
  const sent=[];
  for(const assignee of queuedAssignees()){
    if(assignee.telegram_chat_id)sent.push(await deliverAssigneeDigest(assignee,'telegram',now,false,deps));
    if(assignee.max_chat_id)sent.push(await deliverAssigneeDigest(assignee,'max',now,false,deps));
  }
  return sent;
}
async function sendManualTaskPdf(chatId,now=new Date(),deps={}){
  const assignee=assigneeByTelegram(chatId);
  if(!assignee)return {ok:false,message:'Telegram не подключён к ответственному за поручения.'};
  const result=await deliverAssigneeDigest(assignee,'telegram',now,true,deps);
  return result.ok?{ok:true,message:'PDF отправлен'}:
    {ok:false,message:'Не удалось отправить PDF поручений. Проверьте журнал сервера.'};
}
module.exports={
  TZ,localDate,groupTask,buildTaskDigest,queuedAssignees,
  sendTelegramTaskPdf,sendManualTaskPdf,runDailyTaskDigest,
  deliverAssigneeDigest,assigneeByTelegram,maxSummary,
};
