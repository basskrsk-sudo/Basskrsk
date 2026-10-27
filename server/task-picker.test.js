'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-task-picker-test-'));
process.env.DATA_DIR=tmp;
const db=require('./db');
const {
  getTaskPage,taskPageMessage,handleTaskListNavigation,
  handleTaskCallback,taskListMarkup,
}=require('./task-bot-actions');

const person=Number(db.prepare(
  'INSERT INTO task_assignees(code,full_name,telegram_chat_id) VALUES (?,?,?)'
).run('picker-assignee','Тестовый ответственный','7001').lastInsertRowid);
const other=Number(db.prepare(
  'INSERT INTO task_assignees(code,full_name,telegram_chat_id) VALUES (?,?,?)'
).run('picker-stranger','Другой сотрудник','7002').lastInsertRowid);
const create=db.prepare(
  'INSERT INTO meeting_tasks(assignee_id,title,status,due_date,recurrence_rule) VALUES (?,?,?,?,?)'
);
const ids=[];
for(let i=0;i<13;i++){
  ids.push(Number(create.run(person,'Дело '+(i+1),'new','2026-11-'+String(i+1).padStart(2,'0'),null).lastInsertRowid));
}
const recur=Number(create.run(person,'Еженедельный отчёт','new','2026-10-26','weekly:monday').lastInsertRowid);
const stranger=Number(create.run(other,'Чужое секретное поручение','new','2026-11-20',null).lastInsertRowid);

test('pagination shows five choices and a way to browse beyond 20 tasks',()=>{
  const page=getTaskPage('telegram','7001',0);
  assert.equal(page.total,14);
  assert.equal(page.totalPages,3);
  assert.equal(page.tasks.length,5);
  assert.equal(getTaskPage('telegram','7001',1).tasks.length,5);
  assert.equal(getTaskPage('telegram','7001',2).tasks.length,4);
  const last=handleTaskListNavigation('telegram','7001','tsk:page:2');
  assert.equal(last.ok,true);
  assert.match(last.message,/страница 3\/3/);
  assert.ok(last.replyMarkup.inline_keyboard.some(row=>row.some(button=>button.text.includes('Назад'))));
  assert.ok(!last.replyMarkup.inline_keyboard.some(row=>row.some(button=>button.text.includes('Далее'))));
  assert.deepEqual(taskListMarkup(),{inline_keyboard:[[{text:'📋 Мои поручения',callback_data:'tsk:page:0'}]]});
});

test('selected task shows details, work/status and requires completion confirmation',()=>{
  const opened=handleTaskListNavigation('telegram','7001','tsk:open:'+ids[0]);
  assert.ok(opened.ok);
  assert.match(opened.message,/Дело 1/);
  const buttons=opened.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(buttons.includes('tsk:confirm:'+ids[0]+':2026-11-01'));
  assert.ok(buttons.includes('tsk:'+ids[0]+':work:2026-11-01'));
  assert.ok(buttons.includes('tsk:'+ids[0]+':status:2026-11-01'));
  assert.ok(!buttons.includes('tsk:'+ids[0]+':done:2026-11-01'));
  const question=handleTaskListNavigation('telegram','7001','tsk:confirm:'+ids[0]+':2026-11-01');
  assert.match(question.message,/Подтвердить выполнение/);
  assert.ok(question.replyMarkup.inline_keyboard.flat().some(x=>x.callback_data==='tsk:'+ids[0]+':done:2026-11-01'));
  assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(ids[0]).status,'new');
  const changed=handleTaskCallback('telegram','7001','tsk:'+ids[0]+':done:2026-11-01');
  assert.equal(changed.ok,true);
  assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(ids[0]).status,'done');
  const again=handleTaskCallback('telegram','7001','tsk:'+ids[0]+':done:2026-11-01');
  assert.equal(again.ok,false);
  assert.equal(handleTaskListNavigation('telegram','7001','tsk:open:'+ids[0]).ok,false);
});

test('cannot browse, confirm or finish another person’s task',()=>{
  assert.equal(getTaskPage('telegram','unknown'),null);
  assert.equal(taskPageMessage(getTaskPage('telegram','unknown')).ok,false);
  const denied=handleTaskListNavigation('telegram','7001','tsk:open:'+stranger);
  assert.equal(denied.ok,false);
  assert.equal(handleTaskListNavigation('telegram','7001','tsk:confirm:'+stranger+':2026-11-20').ok,false);
  assert.equal(handleTaskCallback('telegram','7001','tsk:'+stranger+':done:2026-11-20').ok,false);
  assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(stranger).status,'new');
  assert.ok(getTaskPage('telegram','7002').tasks.every(task=>task.id===stranger));
});

test('stale due dates are rejected, recurring tasks move forward',()=>{
  assert.equal(handleTaskListNavigation('telegram','7001','tsk:confirm:'+recur+':2026-11-02').ok,false);
  const confirmation=handleTaskListNavigation('telegram','7001','tsk:confirm:'+recur+':2026-10-26');
  assert.match(confirmation.message,/следующий срок/);
  const done=handleTaskCallback('telegram','7001','tsk:'+recur+':done:2026-10-26');
  assert.equal(done.ok,true);
  const row=db.prepare('SELECT status,due_date FROM meeting_tasks WHERE id=?').get(recur);
  assert.equal(row.status,'new');
  assert.equal(row.due_date,'2026-11-02');
  assert.equal(handleTaskCallback('telegram','7001','tsk:'+recur+':done:2026-10-26').ok,false);
});
test.after(()=>{
  try{db.close();}catch{}
  fs.rmSync(tmp,{recursive:true,force:true});
});
