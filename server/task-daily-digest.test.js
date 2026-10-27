'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-task-digest-test-'));
process.env.DATA_DIR=tmp;
const db=require('./db');
const {
  groupTask,buildTaskDigest,runDailyTaskDigest,sendManualTaskPdf,
  localDate,assigneeByTelegram,
}=require('./task-daily-digest');
const {taskDigestPdfPages}=require('./task-daily-digest-pdf');

const addPerson=db.prepare(
  'INSERT INTO task_assignees(code,full_name,telegram_chat_id,max_chat_id) VALUES (?,?,?,?)'
);
const aId=Number(addPerson.run('digest-a','Ответственный А','101','max-101').lastInsertRowid);
const bId=Number(addPerson.run('digest-b','Ответственный Б','202',null).lastInsertRowid);
const addTask=db.prepare(
  'INSERT INTO meeting_tasks(assignee_id,title,status,due_date,priority,reminder_enabled) VALUES (?,?,?,?,?,?)'
);
const t=(id,title,status,due,priority='normal',remind=1)=>
  Number(addTask.run(id,title,status,due,priority,remind).lastInsertRowid);
const overdue=t(aId,'Просрочить важное задание','new','2026-10-25','critical');
const current=t(aId,'Сделать сегодня','new','2026-10-27','normal');
const working=t(aId,'Работа над новым сайтом','in_progress','2026-12-25','high');
const blocked=t(aId,'Ожидаем поставщика','blocked',null,'normal');
const later=t(aId,'Планы на декабрь','new','2026-12-20','normal');
const disabled=t(aId,'Без уведомлений, но в общем списке','new','2026-11-01','low',0);
t(aId,'Завершено','done','2026-10-20');
t(bId,'Отдельная задача другого сотрудника','new','2026-10-27');
const now=new Date('2026-10-27T03:05:00Z'); // 10:05 Krasnoyarsk

test('three categories are date/status driven and include inactive reminders',()=>{
  assert.equal(localDate(now),'2026-10-27');
  const rows=db.prepare('SELECT * FROM meeting_tasks WHERE assignee_id=?').all(aId);
  const report=buildTaskDigest({id:aId,full_name:'Ответственный А'},rows,now);
  assert.deepEqual(report.totals,{overdue:1,work:3,later:2,total:6});
  assert.equal(report.sections.overdue[0].id,overdue);
  assert.ok(report.sections.work.some(x=>x.id===current));
  assert.ok(report.sections.work.some(x=>x.id===working));
  assert.ok(report.sections.work.some(x=>x.id===blocked));
  assert.ok(report.sections.later.some(x=>x.id===later));
  assert.ok(report.sections.later.some(x=>x.id===disabled));
  assert.equal(groupTask({status:'in_progress',due_date:'2026-12-25'},'2026-10-27'),'work');
});

test('PDF print layout keeps complete tasks in readable sections and paginates',()=>{
  const person={id:aId,full_name:'Ответственный А'};
  const report=buildTaskDigest(person,db.prepare('SELECT * FROM meeting_tasks WHERE assignee_id=?').all(aId),now);
  const pages=taskDigestPdfPages(report,'/usr/share/fonts/dejavu/DejaVuSans.ttf');
  const content=pages.join('\n');
  assert.ok(pages.length>=1);
  for(const marker of ['ПРОСРОЧЕНО','В РАБОТЕ / АКТУАЛЬНО','ПОЗЖЕ',
    'Ответственный А','Просрочить важное задание','Планы на декабрь']){
    assert.ok(content.includes(marker),marker);
  }
  assert.ok(pages.every(page=>page.endsWith('pop graphic-context')));
  const many=Array.from({length:130},(_,i)=>({id:i+1000,title:'Новая ответственная задача номер '+i,
    status:'new',due_date:'2026-12-25',priority:'normal'}));
  const long=buildTaskDigest(person,many,now);
  const sheets=taskDigestPdfPages(long,'/usr/share/fonts/dejavu/DejaVuSans.ttf');
  assert.ok(sheets.length>2);
  assert.ok(sheets.join('\n').includes('задача номер 129'));
});

test('at 10AM one PDF per assignee, one MAX summary, no duplicate after rerun',async()=>{
  const deliveries=[],max=[];
  const deps={
    renderPdf:async report=>{deliveries.push({step:'render',person:report.assignee.id,report});return Buffer.from('%PDF-FAKE');},
    sendTelegram:async(id,report,pdf)=>{deliveries.push({step:'send',id,bytes:pdf.length,report});return {ok:true,message_id:887};},
    sendMax:async(chatId,message)=>{max.push({chatId,message});return {ok:true};},
  };
  const early=await runDailyTaskDigest(new Date('2026-10-27T02:05:00Z'),deps);
  assert.deepEqual(early,[]);
  const first=await runDailyTaskDigest(now,deps);
  assert.equal(first.filter(x=>x.ok).length,3); // 2 Telegram, 1 MAX
  assert.equal(deliveries.filter(x=>x.step==='send').length,2);
  assert.equal(max.length,1);
  assert.match(max[0].message,/Просрочено: 1/);
  assert.deepEqual(
    deliveries.filter(x=>x.step==='send').map(x=>x.report.assignee.id).sort(),
    [aId,bId].sort()
  );
  const second=await runDailyTaskDigest(new Date('2026-10-27T03:15:00Z'),deps);
  assert.equal(second.filter(x=>x.already_sent_or_attempted).length,3);
  assert.equal(deliveries.filter(x=>x.step==='send').length,2);
  const log=db.prepare("SELECT COUNT(*) AS n FROM task_daily_digest_log WHERE local_date='2026-10-27'").get();
  assert.equal(log.n,3);
  const next=await runDailyTaskDigest(new Date('2026-10-28T03:15:00Z'),deps);
  assert.equal(next.filter(x=>x.ok).length,3);
  assert.equal(deliveries.filter(x=>x.step==='send').length,4);
});

test('manual PDF can be requested without changing daily delivery status',async()=>{
  const sent=[];
  const deps={
    renderPdf:async()=>Buffer.from('%PDF-FAKE'),
    sendTelegram:async(chatId,report)=>{sent.push(chatId);return {ok:true};},
  };
  assert.equal(assigneeByTelegram('101').id,aId);
  const first=await sendManualTaskPdf('101',now,deps);
  const second=await sendManualTaskPdf('101',now,deps);
  assert.ok(first.ok&&second.ok);
  assert.deepEqual(sent,['101','101']);
  assert.equal((await sendManualTaskPdf('unknown',now,deps)).ok,false);
});

test.after(()=>{
  try{db.close();}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
});
