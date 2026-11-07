'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-manager-leads-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerPartnerLeadRoutes } = require('./routes-partner-leads');

const routes = new Map();
const router = {};
for (const method of ['get', 'post', 'put', 'delete']) {
  router[method] = (url, handler) => routes.set(method.toUpperCase() + ' ' + url, handler);
}
registerPartnerLeadRoutes(router);

async function call(method, url, identity, body, params, query) {
  const handler = routes.get(method + ' ' + url);
  assert.ok(handler, 'Route exists: ' + method + ' ' + url);
  const headers = { authorization: identity ? 'Bearer ' + signToken(identity) : '' };
  const res = {
    status: 0, body: null,
    writeHead(code) { this.status = code; return this; },
    end(json) { this.body = JSON.parse(json); },
  };
  await handler({ headers }, res, {
    body: body || {}, query: query || {}, params: params || {},
  });
  return res;
}
function makeManager(code, city, active) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active) VALUES(?,?,?,?,?,?,?)'
  ).run(code,code,'hash','Менеджер '+code,'79130000001',city,active == null ? 1 : active).lastInsertRowid);
}
function makeLead(name, city, assigned) {
  return Number(db.prepare(
    'INSERT INTO partner_leads(salon_name,category,city_id,status,assigned_manager_id) VALUES(?,?,?,?,?)'
  ).run(name,'groomer',city,'to_call',assigned).lastInsertRowid);
}
const a = makeManager('ML-A','krsk',1);
const b = makeManager('ML-B','krsk',1);
const c = makeManager('ML-C','spb',1);
const off = makeManager('ML-OFF','krsk',0);
db.prepare("INSERT INTO admins(id,login,password_hash,active) VALUES(?,?,?,1)")
  .run(999,'test-leads-admin','hash');
const admin = {role:'admin',id:999};
const actor = {role:'manager',id:a};
const stranger = {role:'manager',id:b};
const remote = {role:'manager',id:c};
const inactive = {role:'manager',id:off};
const ownedA = makeLead('Салон А','krsk',a);
const ownedB = makeLead('Салон Б','krsk',b);
const free = makeLead('Свободный Красноярск','krsk',null);
const freeSpb = makeLead('Свободный Петербург','spb',null);
const noCity = makeLead('Без города',null,null);

test('shared list: admin sees all, managers only own and unassigned leads of their city', async () => {
  const path = '/api/partner-leads';
  assert.equal((await call('GET',path,null)).status,401);
  assert.equal((await call('GET',path,{role:'partner',id:a})).status,401);
  assert.equal((await call('GET',path,inactive)).status,401);
  const all = await call('GET',path,admin);
  assert.equal(all.status,200);
  assert.equal(all.body.leads.length,5);
  const first = await call('GET',path,actor);
  assert.equal(first.status,200);
  assert.deepEqual(first.body.leads.map(x=>x.id).sort(),[ownedA,free].sort());
  const other = await call('GET',path,stranger);
  assert.deepEqual(other.body.leads.map(x=>x.id).sort(),[ownedB,free].sort());
  const far = await call('GET',path,remote);
  assert.deepEqual(far.body.leads.map(x=>x.id),[freeSpb]);
  const filtered = await call('GET',path,actor,null,null,{status:'to_call',city_id:'spb'});
  assert.equal(filtered.body.leads.length,0,'city filter cannot bypass authorization');
  assert.equal((await call('GET','/api/partner-leads/:id',actor,null,{id:ownedB})).status,403);
  assert.equal((await call('GET','/api/partner-leads/:id',actor,null,{id:freeSpb})).status,403);
  assert.equal((await call('GET','/api/partner-leads/:id',actor,null,{id:free})).status,200);
});

test('manager can claim a free city lead only once; records are synchronized in admin', async () => {
  const route='/api/partner-leads/:id/claim';
  assert.equal((await call('POST',route,stranger,null,{id:freeSpb})).status,403);
  assert.equal((await call('POST',route,actor,null,{id:noCity})).status,403);
  const claimed = await call('POST',route,actor,null,{id:free});
  assert.equal(claimed.status,200,claimed.body?.error);
  assert.equal(db.prepare('SELECT assigned_manager_id FROM partner_leads WHERE id=?').get(free).assigned_manager_id,a);
  assert.equal((await call('POST',route,stranger,null,{id:free})).status,403);
  assert.equal((await call('POST',route,actor,null,{id:free})).body.already_assigned,true);
  const latest = await call('GET','/api/partner-leads/:id',admin,null,{id:free});
  assert.equal(latest.body.lead.assigned_manager_id,a);
  assert.match(latest.body.notes[0].note,/Взял заведение/);
});

test('manager cannot edit free, foreign or inactive leads and cannot forge city/assignment', async () => {
  const route='/api/partner-leads/:id';
  assert.equal((await call('PUT',route,actor,{status:'signed'},{id:ownedB})).status,403);
  assert.equal((await call('PUT',route,actor,{status:'signed'},{id:freeSpb})).status,403);
  assert.equal((await call('POST','/api/partner-leads/:id/notes',stranger,{note:'чужой'},{id:ownedA})).status,403);
  assert.equal((await call('PUT',route,inactive,{status:'signed'},{id:ownedA})).status,401);
  const change=await call('PUT',route,actor,{
    status:'meeting_scheduled',next_contact_date:'2026-11-13',city_id:'spb',
    assigned_manager_id:b,
  },{id:ownedA});
  assert.equal(change.status,200,change.body?.error);
  const stored=db.prepare('SELECT status,city_id,assigned_manager_id,next_contact_date FROM partner_leads WHERE id=?').get(ownedA);
  assert.equal(stored.status,'meeting_scheduled');
  assert.equal(stored.city_id,'krsk');
  assert.equal(stored.assigned_manager_id,a);
  assert.equal(stored.next_contact_date,'2026-11-13');
});

test('manager-created leads are assigned to self and notes show real author in admin history', async () => {
  const created=await call('POST','/api/partner-leads',actor,{
    salon_name:'Новый Зоосалон',category:'groomer',city_id:'spb',
    assigned_manager_id:b,phone:'79135550000',note:'Первый контакт',
  });
  assert.equal(created.status,201,created.body?.error);
  const lead=db.prepare('SELECT city_id,assigned_manager_id FROM partner_leads WHERE id=?').get(created.body.id);
  assert.equal(lead.city_id,'krsk');
  assert.equal(lead.assigned_manager_id,a);
  const note=await call('POST','/api/partner-leads/:id/notes',actor,{note:'Перезвонить в пятницу'},{id:created.body.id});
  assert.equal(note.status,201);
  const fromAdmin=await call('GET','/api/partner-leads/:id',admin,null,{id:created.body.id});
  assert.equal(fromAdmin.body.lead.phone,'79135550000');
  assert.equal(fromAdmin.body.notes.length,2);
  assert.equal(fromAdmin.body.notes[0].author,'Менеджер ML-A');
  assert.equal((await call('GET','/api/partner-leads/:id',stranger,null,{id:created.body.id})).status,403);
  assert.equal((await call('DELETE','/api/partner-leads/:id',actor,null,{id:created.body.id})).status,401);
});

test('desktop and Telegram manager UIs use the shared call-list module and CSS', () => {
  const publicDir=path.join(__dirname,'..','public');
  const desktop=fs.readFileSync(path.join(publicDir,'taiga-manager.html'),'utf8');
  const mini=fs.readFileSync(path.join(publicDir,'miniapp.html'),'utf8');
  const work=fs.readFileSync(path.join(publicDir,'miniapp-work.js'),'utf8');
  const widget=fs.readFileSync(path.join(publicDir,'manager-leads.js'),'utf8');
  assert.match(desktop,/data-group="leads"/);
  assert.match(desktop,/id="manager-leads-panel"/);
  assert.match(desktop,/manager-leads\.js/);
  assert.match(mini,/manager-leads\.css/);
  assert.match(mini,/manager-leads\.js/);
  assert.match(work,/manager-leads-open/);
  assert.match(work,/workManagerLeads/);
  assert.match(widget,/\/api\/partner-leads/);
  assert.doesNotThrow(()=>new Function(widget));
});
