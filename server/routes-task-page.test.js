'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-task-links-'));
process.env.DATA_DIR = tmp;
const db = require('./db');
const { Router } = require('./http-utils');
const {
  registerTaskPageRoutes, accessToken, findAccess, PROFILES,
} = require('./routes-task-page');
const router = new Router();
registerTaskPageRoutes(router);

for (const [code, name] of [
  ['alexey','Лакомых Алексей'], ['vitaly','Соколов Виталий'],
  ['angelina','Ангелина'], ['nikolay','Кучкин Николай'],
]) {
  db.prepare('INSERT INTO task_assignees(code,full_name) VALUES (?,?)').run(code,name);
}
const alexey = db.prepare("SELECT id FROM task_assignees WHERE code='alexey'").get().id;
const vitaly = db.prepare("SELECT id FROM task_assignees WHERE code='vitaly'").get().id;
const ours = Number(db.prepare("INSERT INTO meeting_tasks(title,assignee_id,priority,status) VALUES (?,?,?,?)")
  .run('Наше поручение',alexey,'high','new').lastInsertRowid);
const other = Number(db.prepare("INSERT INTO meeting_tasks(title,assignee_id,priority,status) VALUES (?,?,?,?)")
  .run('Чужое поручение',vitaly,'normal','new').lastInsertRowid);

async function request(method, resource, token, body) {
  const [pathname, querystring = ''] = resource.split('?');
  const match = router.match(method, pathname);
  assert.ok(match, method + ' ' + resource);
  const headers = {};
  if (token) headers.authorization = 'TaskLink ' + token;
  let statusCode = 200, response = '';
  const res = {
    setHeader() {},
    writeHead(code) { statusCode = code; },
    end(chunk) { response += chunk || ''; },
  };
  await match.handler({ method, headers }, res, {
    params: match.params, query: Object.fromEntries(new URLSearchParams(querystring)),
    body: body || {},
  });
  return { statusCode, data: JSON.parse(response) };
}

const tokens = Object.fromEntries(PROFILES.map(p => [p.key,accessToken(p.key,1)]));

test('five stable private profiles with independent unpredictable tokens', () => {
  assert.deepEqual(PROFILES.map(p=>p.key),['admin','alexey','vitaly','angelina','nikolay']);
  assert.equal(new Set(Object.values(tokens)).size,5);
  for (const token of Object.values(tokens)) assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(findAccess(tokens.alexey).assignee_id,alexey);
  assert.equal(findAccess(tokens.vitaly).assignee_id,vitaly);
  assert.equal(findAccess('f'.repeat(64)),null);
  assert.equal(accessToken('alexey',1),tokens.alexey);
});
test('viewer needs a valid key; personal profile defaults are server-enforced', async () => {
  assert.equal((await request('GET','/api/task-page/session')).statusCode,401);
  assert.equal((await request('GET','/api/task-page/tasks','0'.repeat(64))).statusCode,401);
  const session = await request('GET','/api/task-page/session',tokens.alexey);
  assert.equal(session.statusCode,200);
  assert.equal(session.data.actor.is_admin,false);
  assert.equal(session.data.actor.assignee_id,alexey);
});
test('all profiles can view all tasks; only their own are editable', async () => {
  const response = await request('GET','/api/task-page/tasks',tokens.alexey);
  assert.equal(response.statusCode,200);
  assert.equal(response.data.tasks.length,2);
  const byId = new Map(response.data.tasks.map(row=>[row.id,row]));
  assert.equal(byId.get(ours).can_edit,true);
  assert.equal(byId.get(other).can_edit,false);
  assert.equal(byId.get(other).assignee_name,'Соколов Виталий');
  assert.equal('telegram_chat_id' in byId.get(ours),false);
});
test('member cannot change other tasks or create new tasks', async () => {
  const forbidden = await request('PUT','/api/task-page/tasks/'+other,tokens.alexey,{status:'done'});
  assert.equal(forbidden.statusCode,403);
  const create = await request('POST','/api/task-page/tasks',tokens.alexey,{title:'Forbidden'});
  assert.equal(create.statusCode,403);
  const fullEdit = await request('PUT','/api/task-page/tasks/'+ours,tokens.alexey,{title:'Steal'});
  assert.equal(fullEdit.statusCode,403);
});
test('member can update only own status and comment; closed task cannot be reopened', async () => {
  const updated = await request('PUT','/api/task-page/tasks/'+ours,tokens.alexey,{status:'done',comment:'Результат достигнут'});
  assert.equal(updated.statusCode,200);
  assert.equal(db.prepare('SELECT status FROM meeting_tasks WHERE id=?').get(ours).status,'done');
  const history = await request('GET','/api/task-page/tasks/'+ours+'/history',tokens.alexey);
  assert.equal(history.statusCode,200);
  assert.ok(history.data.history.some(h=>h.new_value==='Результат достигнут'));
  assert.equal((await request('GET','/api/task-page/tasks/'+other+'/history',tokens.alexey)).statusCode,403);
  assert.equal((await request('PUT','/api/task-page/tasks/'+ours,tokens.alexey,{status:'new'})).statusCode,409);
});
test('admin task link manages every task and creates tasks', async () => {
  assert.equal((await request('GET','/api/task-page/session',tokens.admin)).data.actor.is_admin,true);
  const updated = await request('PUT','/api/task-page/tasks/'+other,tokens.admin,{status:'in_progress',priority:'high'});
  assert.equal(updated.statusCode,200);
  const created = await request('POST','/api/task-page/tasks',tokens.admin,{
    title:'Новая задача',assignee_id:alexey,meeting_date:'2026-10-25',
  });
  assert.equal(created.statusCode,201);
  assert.equal(db.prepare('SELECT assignee_id FROM meeting_tasks WHERE id=?').get(created.data.id).assignee_id,alexey);
  assert.equal((await request('GET','/api/task-page/assignees',tokens.alexey)).data.members[0].phone,undefined);
});
test('rotated profile keys revoke old links, including after module reload', async () => {
  db.prepare('UPDATE task_page_access SET generation=2 WHERE profile_key=?').run('alexey');
  assert.equal((await request('GET','/api/task-page/tasks',tokens.alexey)).statusCode,401);
  const token = accessToken('alexey',2);
  assert.equal((await request('GET','/api/task-page/tasks',token)).statusCode,200);
  delete require.cache[require.resolve('./routes-task-page')];
  const reloaded = require('./routes-task-page');
  assert.equal(reloaded.accessToken('alexey',2),token);
});
test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(tmp,{recursive:true,force:true});
});
