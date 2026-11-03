'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-miniapp-registration-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerManagerRoutes } = require('./routes-managers');
const { registerPartnerRoutes } = require('./routes-partners');
const { registerOwnerRoutes } = require('./routes-owners');

const routes = new Map();
const router = {};
for (const verb of ['get','post','put','delete']) {
  router[verb] = (url, handler) => routes.set(verb.toUpperCase() + ' ' + url, handler);
}
registerManagerRoutes(router);
registerPartnerRoutes(router);
registerOwnerRoutes(router);

async function invoke(verb, url, payload, body = {}) {
  const handler = routes.get(verb + ' ' + url);
  assert.ok(handler, 'route exists: ' + verb + ' ' + url);
  const response = {
    status: 0, body: null,
    writeHead(code) { this.status = code; },
    end(value) { this.body = JSON.parse(value); },
  };
  const token = payload ? signToken(payload) : '';
  await handler({ headers: { authorization: token ? 'Bearer ' + token : '' } },
    response, { params: {}, query: {}, body });
  return response;
}
function manager(code, active = 1) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,?)'
  ).run(code,code,'hash',code,'79130000000',active).lastInsertRowid);
}
function salon(id, managerId, active=1, hub=0) {
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id,active,is_hub) VALUES(?,?,?,?,?,?,?)')
    .run(id,'Салон '+id,'Красноярск, ул. Тестовая 7','🐾',managerId,active,hub);
}
function groomer(code, pointId, phone) {
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name) ' +
    'VALUES(?,?,?,?,?,?,?)'
  ).run(code,code,'hash','Грумер '+code,phone,pointId,'Салон '+pointId).lastInsertRowid);
}
function createOwnerDirect(code, pointId, phone) {
  return Number(db.prepare(
    'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id) VALUES(?,?,?,?,?)'
  ).run(code,'hash','Владелец '+code,phone,pointId).lastInsertRowid);
}
const managerId = manager('MGR-2026-100');
const otherManagerId = manager('MGR-2026-101');
const inactiveManagerId = manager('MGR-2026-102',0);
const actor = { role: 'manager', id: managerId };
const stranger = { role: 'manager', id: otherManagerId };
salon('own-live',managerId);
salon('own-taken',managerId);
salon('own-inactive',managerId,0);
salon('own-hub',managerId,1,1);
salon('foreign-live',otherManagerId);
salon('blocked-manager',inactiveManagerId);
createOwnerDirect('taken','own-taken','79130000012');
const existingGroomerId=groomer('GR-EXIST','own-live','79131112233');
groomer('GR-FOREIGN','foreign-live','79139998877');
db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES(?,?,?,?)')
  .run(managerId,null,'Груминг Пушок','Груминг');

test('manager registration options are server-scoped, active and never contain ghost or foreign salons', async () => {
  const route='/api/managers/me/registration-options';
  assert.equal((await invoke('GET',route,null)).status,401);
  assert.equal((await invoke('GET',route,{role:'partner',id:managerId})).status,401);
  assert.equal((await invoke('GET',route,{role:'manager',id:inactiveManagerId})).status,401);
  const {status,body}=await invoke('GET',route,actor);
  assert.equal(status,200);
  assert.deepEqual(body.groomer_points.map(p=>p.id).sort(),['own-live','own-taken']);
  assert.deepEqual(body.owner_points.map(p=>p.id),['own-live']);
  assert.equal(body.groomers.length,1);
  assert.equal(body.groomers[0].id,existingGroomerId);
  assert.equal(JSON.stringify(body).includes('Груминг Пушок'),false);
  assert.equal(JSON.stringify(body).includes('foreign-live'),false);
  assert.equal(JSON.stringify(body).includes('own-inactive'),false);
  assert.equal(JSON.stringify(body).includes('own-hub'),false);
});

test('manager-only groomer signup rejects unverified manager, wrong salon and missing consent', async () => {
  const route='/api/managers/me/register-groomer';
  const input={full_name:'Новая Грумерова',phone:'+7 913 555 11 22',
    login:'new-groomer',password:'strong-password',point_id:'own-live',
    personal_data_consent:true};
  assert.equal((await invoke('POST',route,null,input)).status,401);
  assert.equal((await invoke('POST',route,{role:'owner',id:managerId},input)).status,401);
  assert.equal((await invoke('POST',route,{role:'manager',id:inactiveManagerId},
    {...input,point_id:'blocked-manager'})).status,401);
  assert.equal((await invoke('POST',route,actor,{...input,point_id:'foreign-live'})).status,403);
  assert.equal((await invoke('POST',route,actor,{...input,point_id:'own-inactive'})).status,400);
  assert.equal((await invoke('POST',route,actor,{...input,point_id:'own-hub'})).status,403);
  assert.equal((await invoke('POST',route,actor,{...input,manager_code:'MGR-2026-101'})).status,400);
  assert.equal((await invoke('POST',route,actor,{...input,personal_data_consent:false})).status,400);
  assert.equal((await invoke('POST',route,actor,{...input,phone:'79131112233'})).status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partners WHERE point_id='own-live'").get().n,1);
});

test('manager can add multiple groomers to the same real salon and existing public signup stays available', async () => {
  const url='/api/managers/me/register-groomer';
  const base={full_name:'Тестовый Грумер',point_id:'own-live',password:'pass12345',
    personal_data_consent:true};
  const a=await invoke('POST',url,actor,{...base,phone:'+7 913 555 11 22',login:'groomer-one'});
  assert.equal(a.status,201,a.body?.error);
  assert.match(a.body.partner_code,/^GR-/);
  const b=await invoke('POST',url,actor,{...base,phone:'+7 913 555 11 23',login:'groomer-two'});
  assert.equal(b.status,201,b.body?.error);
  const partners=db.prepare('SELECT phone,manager_code FROM partners WHERE point_id=?').all('own-live');
  assert.equal(partners.length,3);
  assert.ok(partners.slice(1).every(p=>p.manager_code==='MGR-2026-100'));
  const options=(await invoke('GET','/api/managers/me/registration-options',actor)).body;
  assert.equal(options.groomers.filter(p=>p.point_id==='own-live').length,3);
  assert.equal(options.owner_points.some(p=>p.id==='own-live'),true);

  // Existing ordinary website signup is still public, with its own validation.
  const publicResult=await invoke('POST','/api/partners/register',null,{
    full_name:'Грумер сайта',point_id:'own-taken',phone:'79135556677',
    login:'web-groomer',password:'secure123',
  });
  assert.equal(publicResult.status,201,publicResult.body?.error);
});

test('manager-only owner signup is restricted, supports linked groomer by SAME phone, and blocks duplicates', async () => {
  const url='/api/salon-owners';
  const base={full_name:'Владелец И Грумер',point_id:'own-live',
    phone:'79131112233',login:'salon-owner',password:'secure123',
    groomer_partner_id:existingGroomerId};
  assert.equal((await invoke('POST',url,null,base)).status,401);
  assert.equal((await invoke('POST',url,stranger,base)).status,403);
  assert.equal((await invoke('POST',url,actor,{...base,point_id:'foreign-live'})).status,403);
  assert.equal((await invoke('POST',url,actor,{...base,point_id:'own-inactive'})).status,400);
  assert.equal((await invoke('POST',url,actor,{...base,point_id:'own-taken'})).status,409);
  assert.equal((await invoke('POST',url,actor,{...base,phone:'79132224455'})).status,400);
  const registered=await invoke('POST',url,actor,base);
  assert.equal(registered.status,201,registered.body?.error);
  assert.match(registered.body.owner_code,/^OWN-/);
  const row=db.prepare('SELECT point_id,groomer_partner_id,phone FROM salon_owners WHERE login=?')
    .get('salon-owner');
  assert.equal(row.point_id,'own-live');
  assert.equal(row.groomer_partner_id,existingGroomerId);
  assert.equal((await invoke('POST',url,actor,{...base,login:'owner-another'})).status,409);
  const options=(await invoke('GET','/api/managers/me/registration-options',actor)).body;
  assert.equal(options.owner_points.length,0,'no salon with an owner is offered');
  assert.equal(options.groomer_points.length,2,'multiple groomers still allowed');
});
