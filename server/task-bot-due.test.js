'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-task-due-test-'));
process.env.DATA_DIR = tmp;
const db = require('./db');
const {
  handleTaskDueCallback, handleTaskDueMessage, cancelTaskDueInput,
  todayInKrasnoyarsk, addDays,
} = require('./task-bot-due');
const { taskButtons, handleTaskCallback, handleTaskListNavigation } = require('./task-bot-actions');

const insertPerson = db.prepare(
  'INSERT INTO task_assignees(code,full_name,telegram_chat_id) VALUES (?,?,?)'
);
const owner = Number(insertPerson.run('due-owner','Тестовый ответственный','101').lastInsertRowid);
const stranger = Number(insertPerson.run('due-other','Другой ответственный','202').lastInsertRowid);
const insertTask = db.prepare(
  'INSERT INTO meeting_tasks(assignee_id,title,status,due_date,recurrence_rule) VALUES (?,?,?,?,?)'
);
const taskId = Number(insertTask.run(owner,'Согласовать PR-мероприятие','new','2026-10-30',null).lastInsertRowid);
const recurringId = Number(insertTask.run(owner,'Еженедельная сверка','in_progress','2026-11-02','weekly:monday').lastInsertRowid);
const noDueId = Number(insertTask.run(owner,'Обновить этикетки','new',null,null).lastInsertRowid);
const otherId = Number(insertTask.run(stranger,'Чужая задача','new','2026-11-01',null).lastInsertRowid);
const completedId = Number(insertTask.run(owner,'Завершённая задача','done','2026-10-25',null).lastInsertRowid);
const now = new Date('2026-10-27T03:30:00Z'); // 10:30 Krasnoyarsk
const task = id => db.prepare('SELECT * FROM meeting_tasks WHERE id=?').get(id);
const history = id => db.prepare('SELECT * FROM meeting_task_history WHERE task_id=? ORDER BY id').all(id);
const act = (payload,chat='101',date=now) => handleTaskDueCallback('telegram',chat,payload,date);

test('quick dates are based on Krasnoyarsk calendar and displayed on task cards',()=>{
  assert.equal(todayInKrasnoyarsk(new Date('2026-10-26T18:01:00Z')),'2026-10-27');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  const telegram = taskButtons({id:taskId,due_date:'2026-10-30'},'telegram');
  assert.match(JSON.stringify(telegram),/Скорректировать срок/);
  assert.match(JSON.stringify(telegram),/tsk:due:menu:/);
  const opened = handleTaskListNavigation('telegram','101','tsk:open:'+taskId);
  assert.match(JSON.stringify(opened.replyMarkup),/Скорректировать срок/);
  assert.equal(JSON.stringify(taskButtons({id:taskId,due_date:'2026-10-30'},'max')).includes('Скорректировать срок'),false);
  const menu = act('tsk:due:menu:'+taskId+':2026-10-30');
  assert.ok(menu.ok);
  const buttons=menu.replyMarkup.inline_keyboard.flat().map(x=>x.callback_data);
  assert.ok(buttons.includes('tsk:due:pick:'+taskId+':2026-10-30:today'));
  assert.ok(buttons.includes('tsk:due:pick:'+taskId+':2026-10-30:tomorrow'));
  assert.ok(buttons.includes('tsk:due:pick:'+taskId+':2026-10-30:week'));
  assert.ok(buttons.includes('tsk:due:pick:'+taskId+':2026-10-30:fortnight'));
  assert.ok(buttons.includes('tsk:due:pick:'+taskId+':2026-10-30:none'));
});

test('assignees cannot edit another assignee task or a finished one',()=>{
  assert.equal(act('tsk:due:menu:'+otherId+':2026-11-01').ok,false);
  assert.equal(act('tsk:due:save:'+otherId+':2026-11-01:2026-11-10').ok,false);
  assert.equal(act('tsk:due:menu:'+completedId+':2026-10-25').ok,false);
  assert.equal(task(otherId).due_date,'2026-11-01');
  assert.equal(history(otherId).length,0);
});

test('choosing quick option prompts for confirmation and records old and new dates',()=>{
  const ready = act('tsk:due:pick:'+taskId+':2026-10-30:tomorrow');
  assert.equal(ready.ok,true);
  assert.match(ready.message,/28\.10\.2026/);
  assert.match(ready.message,/30\.10\.2026/);
  assert.equal(task(taskId).due_date,'2026-10-30');
  const updated = act('tsk:due:save:'+taskId+':2026-10-30:2026-10-28');
  assert.equal(updated.ok,true);
  assert.equal(updated.updated,true);
  assert.equal(task(taskId).due_date,'2026-10-28');
  assert.equal(task(taskId).status,'new');
  assert.equal(history(taskId).length,1);
  assert.equal(history(taskId)[0].action,'bot_due_date_changed');
  assert.equal(history(taskId)[0].old_value,'2026-10-30');
  assert.equal(history(taskId)[0].new_value,'2026-10-28');
  assert.match(history(taskId)[0].actor,/Тестовый ответственный/);
  assert.match(JSON.stringify(updated.replyMarkup),/tsk:due:menu:/);
  assert.equal(act('tsk:due:save:'+taskId+':2026-10-30:2026-11-05').ok,false);
  assert.equal(handleTaskCallback('telegram','101','tsk:'+taskId+':done:2026-10-30').ok,false);
});

test('custom date requires valid input and confirmation; draft removed after input',()=>{
  const custom=act('tsk:due:custom:'+taskId+':2026-10-28');
  assert.equal(custom.ok,true);
  assert.match(custom.message,/ДД\.ММ\.ГГГГ/);
  assert.equal(handleTaskDueMessage('telegram','101','31.02.2026',now).ok,false);
  assert.equal(handleTaskDueMessage('telegram','101','20.10.2026',now).ok,false);
  assert.equal(task(taskId).due_date,'2026-10-28');
  const entered=handleTaskDueMessage('telegram','101','15.11.2026',now);
  assert.equal(entered.ok,true);
  assert.match(entered.message,/15\.11\.2026/);
  assert.equal(handleTaskDueMessage('telegram','101','15.11.2026',now),null);
  assert.equal(task(taskId).due_date,'2026-10-28');
  assert.equal(act('tsk:due:save:'+taskId+':2026-10-28:2026-11-15').ok,true);
  assert.equal(task(taskId).due_date,'2026-11-15');
});

test('stale callbacks cannot silently overwrite a deadline modified in admin',()=>{
  const old=task(taskId).due_date;
  db.prepare('UPDATE meeting_tasks SET due_date=? WHERE id=?').run('2026-11-19',taskId);
  const attempt=act('tsk:due:save:'+taskId+':'+old+':2026-12-01');
  assert.equal(attempt.ok,false);
  assert.equal(task(taskId).due_date,'2026-11-19');
});

test('non-recurring task can be left without a due date, but recurring task cannot',()=>{
  const noDue=act('tsk:due:pick:'+taskId+':2026-11-19:none');
  assert.ok(noDue.ok);
  const saved=act('tsk:due:save:'+taskId+':2026-11-19:-');
  assert.ok(saved.ok);
  assert.equal(task(taskId).due_date,null);
  assert.equal(history(taskId).at(-1).new_value,null);
  const recurring=act('tsk:due:menu:'+recurringId+':2026-11-02');
  assert.equal(JSON.stringify(recurring.replyMarkup).includes('Без срока'),false);
  assert.equal(act('tsk:due:save:'+recurringId+':2026-11-02:-').ok,false);
  assert.equal(task(recurringId).due_date,'2026-11-02');
});

test('custom date draft expires and can be cancelled, without stealing other messages',()=>{
  const custom=act('tsk:due:custom:'+noDueId+':-');
  assert.ok(custom.ok);
  assert.equal(handleTaskDueMessage('telegram','101','2026-10-31',new Date('2026-10-27T04:00:00Z')),null);
  assert.equal(cancelTaskDueInput('telegram','101'),true);
  assert.equal(cancelTaskDueInput('telegram','101'),false);
  assert.equal(handleTaskDueMessage('telegram','101','2026-10-31',now),null);
});

test('a failed audit insert rolls back the due date change',()=>{
  db.exec("CREATE TRIGGER due_history_fail BEFORE INSERT ON meeting_task_history "+
    "BEGIN SELECT RAISE(ABORT,'audit test failure'); END");
  try{
    const before=task(noDueId).due_date;
    const result=act('tsk:due:save:'+noDueId+':-:2026-11-02');
    assert.equal(result.ok,false);
    assert.equal(task(noDueId).due_date,before);
    assert.equal(history(noDueId).length,0);
  }finally{
    db.exec('DROP TRIGGER due_history_fail');
  }
});

test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(tmp,{recursive:true,force:true});
});
