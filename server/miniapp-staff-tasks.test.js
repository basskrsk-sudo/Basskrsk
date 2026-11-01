'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hm-miniapp-staff-tasks-'));
process.env.DATA_DIR=temp;
process.env.TOKEN_SECRET='unit-test-miniapp-tasks';
const db=require('./db');
require('./business-founders');
const {seedMeetingTasks}=require('./task-seed');
const {signToken}=require('./auth');
const {
 PEOPLE,ensureTaskAccountBindings,taskMemberFromAccount,taskDashboard,
 changeOwnTask,registerMiniAppTaskRoutes,
}=require('./routes-miniapp-tasks');
seedMeetingTasks();
const founderRows=db.prepare('SELECT id,full_name FROM business_founders').all();
assert.equal(founderRows.length,3);
for(const row of founderRows)db.prepare('UPDATE business_founders SET active=1 WHERE id=?').run(row.id);
const managerId=Number(db.prepare(
 'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)'
).run('M-ANGELINA','angelina-funk','hash','Ангелина Функ','79130003344').lastInsertRowid);
const otherManager=Number(db.prepare(
 'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)'
).run('M-OTHER','another-person','hash','Другой менеджер','79130003345').lastInsertRowid);
const managerAlias=Number(db.prepare(
 'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)'
).run('M-FAKE','fake-manager','hash','Не Ангелина','79130003346').lastInsertRowid);
ensureTaskAccountBindings();

const assignees=Object.fromEntries(db.prepare(
 "SELECT code,id FROM task_assignees WHERE code IN ('alexey','vitaly','nikolay','angelina')"
).all().map(r=>[r.code,r.id]));
assert.equal(Object.keys(assignees).length,4);
const insert=db.prepare(
 'INSERT INTO meeting_tasks(title,assignee_id,due_date,status,priority,recurrence_rule) VALUES(?,?,?,?,?,?)'
);
const taskFor=Object.fromEntries(Object.entries(assignees).map(([code,id])=>
 [code,Number(insert.run('Test '+code,id,'2026-11-14','new','high',null).lastInsertRowid)]
));
const managerRecurring=Number(insert.run(
 'Регулярная проверка стоек',assignees.angelina,'2026-11-20','in_progress',
 'critical','weekly:monday').lastInsertRowid);

function jwt(role,id){return signToken({role,id,login:role+'-person'});}
const routes={};
registerMiniAppTaskRoutes({
 get(route,callback){routes['GET '+route]=callback;},
 post(route,callback){routes['POST '+route]=callback;},
});
function call(method,endpoint,role,id,body={},params={}){
 const handler=routes[method+' '+endpoint];
 assert.ok(handler,method+' '+endpoint+' should exist');
 const response={status:null,writeHead(status){this.status=status;},
   end(raw){this.body=JSON.parse(raw);}};
 handler({headers:role?{authorization:'Bearer '+jwt(role,id)}:{}},
   response,{body,query:{},params});
 return response;
}
function founderId(name){return founderRows.find(row=>row.full_name===name).id;}
const vitaly=founderId('Соколов Виталий');
const aleksey=founderId('Лакомых Алексей');
const nikolay=founderId('Кучкин Николай');

test('bindings are persistent and unique for three founders and Angelina',()=>{
 assert.equal(PEOPLE.length,4);
 const links=db.prepare('SELECT * FROM miniapp_task_account_links ORDER BY assignee_id').all();
 assert.equal(links.length,4);
 assert.equal(taskMemberFromAccount({role:'manager',id:managerId}).code,'angelina');
 assert.equal(taskMemberFromAccount({role:'founder',id:vitaly}).code,'vitaly');
 assert.equal(taskMemberFromAccount({role:'founder',id:aleksey}).code,'alexey');
 assert.equal(taskMemberFromAccount({role:'founder',id:nikolay}).code,'nikolay');
 assert.equal(taskMemberFromAccount({role:'manager',id:otherManager}),null);
 ensureTaskAccountBindings();
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM miniapp_task_account_links').get().n,4);
});

test('one manager cannot gain Angelina tasks by editing their name',()=>{
 db.prepare('UPDATE managers SET full_name=? WHERE id=?').run('Ангелина Функ',managerAlias);
 ensureTaskAccountBindings();
 assert.equal(taskMemberFromAccount({role:'manager',id:managerAlias}),null);
 assert.equal(taskMemberFromAccount({role:'manager',id:managerId}).code,'angelina');
});

test('founders see all four team members, but manager sees only assigned tasks',()=>{
 const founder=call('GET','/api/miniapp/tasks','founder',vitaly);
 assert.equal(founder.status,200);
 assert.equal(founder.body.actor.code,'vitaly');
 assert.ok(founder.body.my_tasks.some(x=>x.id===taskFor.vitaly));
 assert.equal(founder.body.my_tasks.some(x=>x.id===taskFor.alexey),false);
 assert.deepEqual(founder.body.team.members.map(x=>x.code),
   ['alexey','vitaly','nikolay','angelina']);
 assert.ok(founder.body.team.tasks.some(x=>x.id===taskFor.angelina));
 assert.equal(founder.body.can_edit_team,false);
 const manager=call('GET','/api/miniapp/tasks','manager',managerId);
 assert.equal(manager.status,200);
 assert.equal(manager.body.actor.code,'angelina');
 assert.equal(manager.body.team,null);
 assert.ok(manager.body.my_tasks.some(x=>x.id===taskFor.angelina));
 assert.ok(manager.body.my_tasks.some(x=>x.id===managerRecurring));
 assert.equal(manager.body.my_tasks.some(x=>x.id===taskFor.nikolay),false);
 assert.equal(manager.body.my_tasks.some(x=>x.id===taskFor.aleksey),false);
});

test('visitor, other manager and expired or inactive staff are denied',()=>{
 assert.equal(call('GET','/api/miniapp/tasks',null,null).status,401);
 assert.equal(call('GET','/api/miniapp/tasks','customer',123).status,401);
 assert.equal(call('GET','/api/miniapp/tasks','manager',otherManager).status,403);
 db.prepare('UPDATE business_founders SET active=0 WHERE id=?').run(aleksey);
 assert.equal(call('GET','/api/miniapp/tasks','founder',aleksey).status,403);
 db.prepare('UPDATE business_founders SET active=1 WHERE id=?').run(aleksey);
});

test('owner of task can move to work, add report, and set due date',()=>{
 const result=call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   status:'in_progress',expected_status:'new',expected_due:'2026-11-14',
 },{id:taskFor.angelina});
 assert.equal(result.status,200);
 assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(taskFor.angelina).status,'in_progress');
 const note=call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   comment:'Позвонила владельцу салона. Ожидаем фото стойки.',
   expected_status:'in_progress',expected_due:'2026-11-14',
 },{id:taskFor.angelina});
 assert.equal(note.status,200);
 assert.match(db.prepare('SELECT new_value FROM meeting_task_history WHERE task_id=? ORDER BY id DESC LIMIT 1')
   .get(taskFor.angelina).new_value,/Ожидаем фото/);
 const due=call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   due_date:'2026-12-08',expected_status:'in_progress',expected_due:'2026-11-14',
 },{id:taskFor.angelina});
 assert.equal(due.status,200);
 assert.equal(db.prepare('SELECT due_date FROM meeting_tasks WHERE id=?').get(taskFor.angelina).due_date,'2026-12-08');
});

test('founders cannot change tasks of teammates; manager cannot see or modify founder tasks',()=>{
 assert.equal(call('POST','/api/miniapp/tasks/:id','founder',aleksey,{
   status:'done',
 },{id:taskFor.vitaly}).status,404);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   comment:'Смотрю чужие поручения',
 },{id:taskFor.nikolay}).status,404);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',otherManager,{
   status:'done',
 },{id:taskFor.angelina}).status,403);
 assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(taskFor.vitaly).status,'new');
});

test('a saved browser card cannot overwrite a changed task',()=>{
 const changed=call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   status:'done',expected_status:'new',expected_due:'2026-11-14',
 },{id:taskFor.angelina});
 assert.equal(changed.status,409);
 assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(taskFor.angelina).status,'in_progress');
});

test('recurrence advances instead of closing the recurring task',()=>{
 const done=call('POST','/api/miniapp/tasks/:id','manager',managerId,{
   status:'done',expected_status:'in_progress',expected_due:'2026-11-20',
 },{id:managerRecurring});
 assert.equal(done.status,200);
 assert.equal(done.body.recurring_advanced,true);
 const row=db.prepare('SELECT status,due_date FROM meeting_tasks WHERE id=?').get(managerRecurring);
 assert.equal(row.status,'new');
 assert.notEqual(row.due_date,'2026-11-20');
 assert.match(db.prepare('SELECT action FROM meeting_task_history WHERE task_id=? ORDER BY id DESC LIMIT 1')
   .get(managerRecurring).action,/miniapp_completed_recurring/);
});

test('closed tasks cannot be reopened; malformed and dangerous fields are refused',()=>{
 const task=taskFor.vitaly;
 assert.equal(call('POST','/api/miniapp/tasks/:id','founder',vitaly,
   {status:'done'},{id:task}).status,200);
 assert.equal(call('POST','/api/miniapp/tasks/:id','founder',vitaly,
   {status:'in_progress'},{id:task}).status,409);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',managerId,
   {assignee_id:assignees.alexey},{id:taskFor.angelina}).status,400);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',managerId,
   {status:'cancelled'},{id:taskFor.angelina}).status,400);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',managerId,
   {due_date:'2026-02-30'},{id:taskFor.angelina}).status,400);
 assert.equal(call('POST','/api/miniapp/tasks/:id','manager',managerId,
   {comment:'x'.repeat(1600)},{id:taskFor.angelina}).status,400);
});

test('task assignee phone mismatch blocks access even for a bound role',()=>{
 db.prepare('UPDATE task_assignees SET phone=? WHERE id=?')
   .run('79131119999',assignees.angelina);
 assert.equal(call('GET','/api/miniapp/tasks','manager',managerId).status,403);
 db.prepare('UPDATE task_assignees SET phone=NULL WHERE id=?').run(assignees.angelina);
});

test.after(()=>{
 try{db.close();}catch(_){}
 fs.rmSync(temp,{recursive:true,force:true});
});
