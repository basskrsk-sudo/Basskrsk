// Telegram editing of an assignee's own task due date.
'use strict';

const db = require('./db');
const { assignedTask, handleTaskListNavigation, taskListMarkup } = require('./task-bot-actions');
const { parseDueDate } = require('./task-bot-create');

const CHANNEL = 'telegram';
const DRAFT_TTL_MS = 30 * 60 * 1000;
const ZONE = 'Asia/Krasnoyarsk';

function todayInKrasnoyarsk(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
}

function addDays(localDate, days) {
  const d = new Date(localDate+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}

function dueKey(task) {
  return task.due_date || '-';
}

function dateText(value) {
  return value === '-' || !value ? 'не установлен' :
    String(value).split('-').reverse().join('.');
}

function isValidRequestedDate(date, today) {
  if (date === '-') return true;
  const parsed = parseDueDate(date);
  const maxDate = addDays(today, 366*10);
  return !!parsed && parsed === date && date >= today && date <= maxDate;
}

function timeButtons(task) {
  const id=task.id,old=dueKey(task);
  const payload=choice=>'tsk:due:pick:'+id+':'+old+':'+choice;
  const rows=[
    [
      {text:'Сегодня',callback_data:payload('today')},
      {text:'Завтра',callback_data:payload('tomorrow')},
    ],
    [
      {text:'Через 7 дней',callback_data:payload('week')},
      {text:'Через 14 дней',callback_data:payload('fortnight')},
    ],
    [{text:'🗓 Другая дата',callback_data:'tsk:due:custom:'+id+':'+old}],
  ];
  if (!task.recurrence_rule) {
    rows.push([{text:'Без срока',callback_data:payload('none')}]);
  }
  rows.push([{text:'↩ Назад к поручению',callback_data:'tsk:open:'+id}]);
  return {inline_keyboard:rows};
}

function dateConfirmation(task, newDue) {
  const old=dueKey(task);
  const label='📅 Изменение срока · поручение №'+task.id+'\n'+task.title+
    '\n\nБыло: '+dateText(old)+'\nСтанет: '+dateText(newDue)+
    (task.recurrence_rule?'\n🔁 Следующее повторение будет рассчитано от нового срока.':'')+
    '\n\nСохранить новый срок?';
  return {
    ok:true,
    message:label,
    replyMarkup:{inline_keyboard:[
      [{text:'✅ Сохранить срок',callback_data:'tsk:due:save:'+task.id+':'+old+':'+newDue}],
      [{text:'↩ Выбрать другую дату',callback_data:'tsk:due:menu:'+task.id+':'+old}],
      [{text:'✕ Отмена',callback_data:'tsk:open:'+task.id}],
    ]},
  };
}

function taskForChat(chatId,id){
  const task=assignedTask(CHANNEL,chatId,id);
  return task && !['done','cancelled'].includes(task.status) ? task : null;
}

function cancelTaskDueInput(channel,chatId){
  if(channel!==CHANNEL||!chatId)return false;
  return db.prepare('DELETE FROM task_bot_due_drafts WHERE channel=? AND chat_id=?')
    .run(channel,String(chatId)).changes>0;
}

function clearOtherDrafts(chatId){
  const id=String(chatId);
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel=? AND chat_id=?')
    .run(CHANNEL,id);
  db.prepare('DELETE FROM task_bot_create_drafts WHERE channel=? AND chat_id=?')
    .run(CHANNEL,id);
  db.prepare('DELETE FROM expense_bot_drafts WHERE channel=? AND chat_id=?')
    .run(CHANNEL,id);
}

function saveDueDate(chatId, task, date) {
  const old=dueKey(task);
  const desired=date==='-'?null:date;
  if (task.recurrence_rule && !desired) {
    return {ok:false,message:'У повторяющегося поручения должен быть срок.'};
  }
  if (old===date) return {ok:false,message:'Новый срок совпадает с текущим.',replyMarkup:timeButtons(task)};
  let opened=false;
  try{
    db.exec('BEGIN IMMEDIATE');
    opened=true;
    const result=db.prepare(
      "UPDATE meeting_tasks SET due_date=?,updated_at=datetime('now') "+
      "WHERE id=? AND assignee_id=? AND COALESCE(due_date,'-')=? "+
      "AND status NOT IN ('done','cancelled')"
    ).run(desired,task.id,task.assignee_id,old);
    if(result.changes!==1){
      db.exec('ROLLBACK'); opened=false;
      return {ok:false,message:'Поручение или его срок уже изменились. Обновите список задач.',
        replyMarkup:taskListMarkup()};
    }
    db.prepare(
      'INSERT INTO meeting_task_history(task_id,action,old_value,new_value,actor) '+
      'VALUES (?, ?, ?, ?, ?)'
    ).run(task.id,'bot_due_date_changed',task.due_date||null,desired,
      task.assignee_name+' · Telegram');
    db.exec('COMMIT'); opened=false;
  }catch(error){
    if(opened){try{db.exec('ROLLBACK');}catch(_){}}
    console.error('[task-due] Не удалось изменить срок:',error);
    return {ok:false,message:'Ошибка при сохранении срока. Изменение не применено.'};
  }
  cancelTaskDueInput(CHANNEL,chatId);
  clearOtherDrafts(chatId);
  const reopened=handleTaskListNavigation(CHANNEL,chatId,'tsk:open:'+task.id);
  return {
    ok:true,updated:true,
    message:'✅ Срок поручения №'+task.id+' изменён: '+
      dateText(old)+' → '+dateText(date)+'.\nИзменение записано в историю.\n\n'+
      (reopened?.message||''),
    replyMarkup:reopened?.replyMarkup||taskListMarkup(),
  };
}

function handleTaskDueCallback(channel, chatId, rawPayload, now = new Date()) {
  if(channel!==CHANNEL || !chatId)return null;
  const value=String(rawPayload||'');
  const command=value.match(/^tsk:due:(menu|custom|pick|save):(\d+):(\d{4}-\d{2}-\d{2}|-)(?::([a-z]+|\d{4}-\d{2}-\d{2}|-))?$/);
  if(!command)return null;
  const [,action,idText,old,valueText]=command;
  const task=taskForChat(chatId,Number(idText));
  if(!task) return {ok:false,message:'Это поручение не назначено вам или уже завершено.',
    replyMarkup:taskListMarkup()};
  if(dueKey(task)!==old)return {ok:false,message:
    'Срок уже изменился. Откройте обновлённую карточку поручения.',
    replyMarkup:taskListMarkup()};

  if(action==='menu'){
    // Opening the date editor ends any unrelated unfinished bot dialog.
    clearOtherDrafts(chatId);
    cancelTaskDueInput(CHANNEL,chatId);
    return {ok:true,message:
      '📅 Скорректировать срок поручения №'+task.id+'\n'+task.title+
      '\nТекущий срок: '+dateText(old)+
      '\n\nВыберите новый срок:',
      replyMarkup:timeButtons(task)};
  }
  if(action==='custom'){
    clearOtherDrafts(chatId);
    const expiresAt=new Date(now.getTime()+DRAFT_TTL_MS).toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO task_bot_due_drafts '+
      '(channel,chat_id,task_id,expected_due,expires_at) VALUES (?,?,?,?,?)'
    ).run(CHANNEL,String(chatId),task.id,old,expiresAt);
    return {ok:true,message:
      '🗓 Введите новый срок поручения №'+task.id+' одним сообщением.\n'+
      'Формат: ДД.ММ.ГГГГ (например, 15.11.2026).\n'+
      'Нельзя назначить прошедшую дату.\n'+
      'Для отмены отправьте /cancel.',
      replyMarkup:{inline_keyboard:[[
        {text:'✕ Отмена',callback_data:'tsk:due:menu:'+task.id+':'+old},
      ]]}};
  }
  const today=todayInKrasnoyarsk(now);
  if(action==='pick'){
    const choices={
      today:today,tomorrow:addDays(today,1),
      week:addDays(today,7),fortnight:addDays(today,14),none:'-',
    };
    if(!Object.prototype.hasOwnProperty.call(choices,valueText))return null;
    const due=choices[valueText];
    if(due==='-'&&task.recurrence_rule){
      return {ok:false,message:'Нельзя убрать срок у повторяющегося поручения.'};
    }
    // Selecting a quick date supersedes any unfinished typed-date prompt.
    cancelTaskDueInput(CHANNEL,chatId);
    return dateConfirmation(task,due);
  }
  if(action==='save'){
    if(!valueText||!isValidRequestedDate(valueText,today)){
      return {ok:false,message:'Дата недопустима или уже прошла. Выберите новый срок.',
        replyMarkup:timeButtons(task)};
    }
    return saveDueDate(chatId,task,valueText);
  }
  return null;
}

function handleTaskDueMessage(channel,chatId,text,now=new Date()){
  if(channel!==CHANNEL || !chatId)return null;
  const value=String(text||'').trim();
  if(!value||value.startsWith('/'))return null;
  const pending=db.prepare(
    "SELECT * FROM task_bot_due_drafts WHERE channel=? AND chat_id=? "+
    "AND datetime(expires_at)>datetime(?)"
  ).get(channel,String(chatId),now.toISOString());
  if(!pending)return null;
  const task=taskForChat(chatId,pending.task_id);
  if(!task||dueKey(task)!==pending.expected_due){
    cancelTaskDueInput(channel,chatId);
    return {ok:false,message:'Поручение или его срок уже изменились. Откройте список через /tasks.'};
  }
  const desired=parseDueDate(value);
  const today=todayInKrasnoyarsk(now);
  if(!desired||!isValidRequestedDate(desired,today)){
    return {ok:false,message:
      'Некорректная или прошедшая дата. Укажите ДД.ММ.ГГГГ, например 15.11.2026, не раньше сегодняшнего дня.\nДля отмены: /cancel.'};
  }
  cancelTaskDueInput(channel,chatId);
  return dateConfirmation(task,desired);
}

module.exports={
  todayInKrasnoyarsk,addDays,dateText,timeButtons,
  handleTaskDueCallback,handleTaskDueMessage,cancelTaskDueInput,
};
