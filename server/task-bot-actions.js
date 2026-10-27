// task-bot-actions.js — безопасное изменение назначенных поручений из ботов.
'use strict';

const db = require('./db');
const { nextRecurringDue } = require('./task-utils');

function expectedDue(task) {
  return task.due_date || '-';
}

function taskButtons(task, channel) {
  const due = expectedDue(task);
  const payload = (action) => `tsk:${task.id}:${action}:${due}`;
  if (channel === 'telegram') {
    return {
      inline_keyboard: [
        [
          { text: '▶️ В работу', callback_data: payload('work') },
          { text: '💬 Статус', callback_data: payload('status') },
        ],
        [{ text: '📅 Скорректировать срок', callback_data: 'tsk:due:menu:' + task.id + ':' + due }],
        [{ text: '✅ Выполнено', callback_data: payload('done') }],
      ],
    };
  }
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          { type: 'callback', text: '▶️ В работу', payload: payload('work') },
          { type: 'callback', text: '💬 Статус', payload: payload('status') },
        ],
        [{ type: 'callback', text: '✅ Выполнено', payload: payload('done') }],
      ],
    },
  }];
}

function parsePayload(value) {
  const match = String(value || '').match(/^tsk:(\d+):(work|status|done):(\d{4}-\d{2}-\d{2}|-)$/);
  return match ? { taskId: Number(match[1]), action: match[2], expectedDue: match[3] } : null;
}

function assignedTask(channel, chatId, taskId) {
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  if (!['telegram', 'max'].includes(channel)) return null;
  return db.prepare(`
    SELECT t.*, a.full_name AS assignee_name
    FROM meeting_tasks t
    JOIN task_assignees a ON a.id = t.assignee_id AND a.active = 1
    WHERE t.id = ? AND a.${column} = ?
  `).get(taskId, String(chatId));
}

function getTaskInbox(channel, chatId) {
  if (!['telegram', 'max'].includes(channel) || !chatId) return null;
  const column = channel === 'telegram' ? 'telegram_chat_id' : 'max_chat_id';
  const assignee = db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 AND ${column} = ?
  `).get(String(chatId));
  if (!assignee) return null;
  const tasks = db.prepare(`
    SELECT t.*, ? AS assignee_name
    FROM meeting_tasks t
    WHERE t.assignee_id = ? AND t.status NOT IN ('done', 'cancelled')
    ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
             t.due_date,
             CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             t.id
    LIMIT 20
  `).all(assignee.full_name, assignee.id);
  return { assignee, tasks };
}

// One compact, paginated Telegram list replaces 20 separate /tasks messages.
const TASK_PAGE_SIZE = 5;
function taskListMarkup() {
  return {inline_keyboard:[[{text:'📋 Мои поручения',callback_data:'tsk:page:0'}]]};
}
function getTaskPage(channel, chatId, requestedPage = 0) {
  if (!['telegram','max'].includes(channel)) return null;
  const column=channel==='telegram'?'telegram_chat_id':'max_chat_id';
  const person=db.prepare(
    'SELECT id, full_name FROM task_assignees WHERE active=1 AND '+column+'=? LIMIT 1'
  ).get(String(chatId || ''));
  if(!person)return null;
  const count=Number(db.prepare(
    "SELECT COUNT(*) AS total FROM meeting_tasks WHERE assignee_id=? AND status NOT IN ('done','cancelled')"
  ).get(person.id)?.total||0);
  const totalPages=Math.max(1,Math.ceil(count/TASK_PAGE_SIZE));
  const requested=Number(requestedPage);
  const page=Number.isSafeInteger(requested)?Math.max(0,Math.min(requested,totalPages-1)):0;
  const tasks=db.prepare([
    'SELECT t.*, ? AS assignee_name FROM meeting_tasks t',
    "WHERE t.assignee_id=? AND t.status NOT IN ('done','cancelled')",
    'ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,',
    't.due_date, CASE t.priority WHEN \'critical\' THEN 0',
    "WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.id",
    'LIMIT ? OFFSET ?',
  ].join(' ')).all(person.full_name,person.id,TASK_PAGE_SIZE,page*TASK_PAGE_SIZE);
  return {assignee:person,tasks,total:count,totalPages,page};
}
function taskPageMessage(data){
  if(!data)return {ok:false,message:'Этот Telegram не подключён к ответственному за поручения.'};
  if(!data.total)return {ok:true,message:'✅ У вас нет активных поручений.',replyMarkup:null};
  const lines=[
    '📋 Мои поручения · '+data.assignee.full_name,
    'Активных: '+data.total+' · страница '+(data.page+1)+'/'+data.totalPages,
    '',
  ];
  const keys=[];
  for(const task of data.tasks){
    const date=task.due_date||'без срока';
    const label='#'+task.id+' · '+String(task.title||'').replace(/[\r\n]/g,' ').slice(0,38);
    lines.push('• '+label+' · '+date);
    keys.push([{text:'📌 '+label.slice(0,44),callback_data:'tsk:open:'+task.id}]);
  }
  const navigation=[];
  if(data.page>0)navigation.push({text:'◀ Назад',callback_data:'tsk:page:'+(data.page-1)});
  if(data.page+1<data.totalPages)navigation.push({text:'Далее ▶',callback_data:'tsk:page:'+(data.page+1)});
  if(navigation.length)keys.push(navigation);
  return {ok:true,message:lines.join('\n'),replyMarkup:{inline_keyboard:keys}};
}
function handleTaskListNavigation(channel,chatId,value){
  const raw=String(value||'');
  const page=raw.match(/^tsk:page:(\d{1,4})$/);
  if(page)return taskPageMessage(getTaskPage(channel,chatId,Number(page[1])));
  const open=raw.match(/^tsk:open:(\d+)$/);
  const confirm=raw.match(/^tsk:confirm:(\d+):(\d{4}-\d{2}-\d{2}|-)$/);
  if(!open&&!confirm)return null;
  const taskId=Number((open||confirm)[1]);
  const task=assignedTask(channel,chatId,taskId);
  if(!task)return {ok:false,message:'Поручение больше не назначено вам. Обновите список.',replyMarkup:taskListMarkup()};
  if(['done','cancelled'].includes(task.status))
    return {ok:false,message:'Это поручение уже закрыто.',replyMarkup:taskListMarkup()};
  const due=expectedDue(task);
  if(confirm){
    if(confirm[2]!==due)return {ok:false,message:'Срок поручения изменился. Откройте его из нового списка.',replyMarkup:taskListMarkup()};
    return {
      ok:true,
      message:'Подтвердить выполнение поручения №'+task.id+'?\n'+task.title+
        '\nСрок: '+(task.due_date||'не установлен')+
        (task.recurrence_rule?'\n🔁 Повторяющееся поручение: после выполнения будет назначен следующий срок.':''),
      replyMarkup:{inline_keyboard:[
        [{text:'✅ Да, выполнено',callback_data:'tsk:'+task.id+':done:'+due}],
        [{text:'✕ Отмена',callback_data:'tsk:open:'+task.id}],
      ]},
    };
  }
  return {
    ok:true,message:taskBotCard(task),
    replyMarkup:{inline_keyboard:[
      [{text:'▶️ В работу',callback_data:'tsk:'+task.id+':work:'+due},
       {text:'💬 Статус',callback_data:'tsk:'+task.id+':status:'+due}],
      [{text:'📅 Скорректировать срок',callback_data:'tsk:due:menu:'+task.id+':'+due}],
      [{text:'✅ Выполнено',callback_data:'tsk:confirm:'+task.id+':'+due}],
      [{text:'◀ Все задачи',callback_data:'tsk:page:0'}],
    ]},
  };
}

function taskBotCard(task) {
  const statusNames = { new: 'Новое', in_progress: 'В работе', blocked: 'Заблокировано' };
  const lines = [
    `📌 Поручение №${task.id}`,
    task.title,
    `Статус: ${statusNames[task.status] || task.status}`,
    `Срок: ${task.due_date || 'не установлен'}`,
  ];
  if (task.description) lines.push('Что сделать: ' + task.description);
  return lines.join('\n');
}

function addHistory(taskId, action, oldValue, newValue, actor) {
  db.prepare(`
    INSERT INTO meeting_task_history (task_id, action, old_value, new_value, actor)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, action, oldValue || null, newValue || null, actor || 'бот');
}

function handleTaskCallback(channel, chatId, rawPayload) {
  const parsed = parsePayload(rawPayload);
  if (!parsed) return null;
  const task = assignedTask(channel, chatId, parsed.taskId);
  if (!task) return { ok: false, message: 'Это поручение не назначено вам или подключение устарело.' };
  if (expectedDue(task) !== parsed.expectedDue) {
    return { ok: false, message: 'Поручение уже изменилось. Откройте последнее напоминание.' };
  }
  if (['done', 'cancelled'].includes(task.status)) {
    return { ok: false, message: task.status === 'done' ? 'Поручение уже выполнено.' : 'Поручение отменено.' };
  }

  if (parsed.action === 'status') {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO task_bot_pending_inputs
        (channel, chat_id, task_id, expected_due, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(channel, String(chatId), task.id, parsed.expectedDue, expiresAt);
    return { ok: true, askStatus: true, message: 'Напишите одним сообщением текущий статус, результат или причину задержки по поручению «' + task.title + '».' };
  }

  if (parsed.action === 'work') {
    if (task.status !== 'in_progress') {
      db.prepare("UPDATE meeting_tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?").run(task.id);
      addHistory(task.id, 'bot_status', task.status, 'in_progress', task.assignee_name + ' · ' + channel);
    }
    return { ok: true, message: 'Поручение отмечено «В работе».' };
  }

  if (task.recurrence_rule) {
    const nextDue = nextRecurringDue(task.due_date, task.recurrence_rule);
    db.prepare("UPDATE meeting_tasks SET status='new', due_date=?, completed_at=NULL, updated_at=datetime('now') WHERE id=?")
      .run(nextDue, task.id);
    addHistory(task.id, 'bot_completed_recurring', task.due_date, nextDue, task.assignee_name + ' · ' + channel);
    return { ok: true, message: '✅ Выполнение зафиксировано. Следующий срок: ' + nextDue + '.' };
  }

  db.prepare("UPDATE meeting_tasks SET status='done', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(task.id);
  addHistory(task.id, 'bot_completed', task.status, 'done', task.assignee_name + ' · ' + channel);
  return { ok: true, message: '✅ Поручение закрыто как выполненное.' };
}

function handleTaskStatusMessage(channel, chatId, text) {
  const statusText = String(text || '').trim();
  if (!statusText || statusText.startsWith('/')) return null;
  const pending = db.prepare(`
    SELECT * FROM task_bot_pending_inputs
    WHERE channel = ? AND chat_id = ? AND datetime(expires_at) > datetime('now')
  `).get(channel, String(chatId));
  if (!pending) return null;
  const task = assignedTask(channel, chatId, pending.task_id);
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  if (!task) return { ok: false, message: 'Не удалось записать статус: поручение больше не назначено вам.' };
  if (expectedDue(task) !== pending.expected_due) return { ok: false, message: 'Поручение уже изменилось; статус не записан.' };
  if (['done', 'cancelled'].includes(task.status)) return { ok: false, message: 'Поручение уже закрыто; статус не записан.' };
  const safeText = statusText.slice(0, 2000);
  if (task.status === 'new') {
    db.prepare("UPDATE meeting_tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?").run(task.id);
  } else {
    db.prepare("UPDATE meeting_tasks SET updated_at=datetime('now') WHERE id=?").run(task.id);
  }
  addHistory(task.id, 'status_report', null, safeText, task.assignee_name + ' · ' + channel);
  return { ok: true, message: '✅ Статус записан в поручение и виден в админке.' };
}

module.exports = {
  assignedTask,
  getTaskInbox,
  getTaskPage, taskPageMessage, taskListMarkup, handleTaskListNavigation,
  handleTaskCallback,
  handleTaskStatusMessage,
  parsePayload,
  taskBotCard,
  taskButtons,
};
