'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(),'hm-admin-miniapp-register-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerMiniAppAdminRegistrationRoutes } = require('./routes-miniapp-admin-registration');
const { registerManagerRoutes } = require('./routes-managers');
const { registerPartnerRoutes } = require('./routes-partners');
const { registerOwnerRoutes } = require('./routes-owners');
const { registerProductRoutes } = require('./routes-products');

const handlers = new Map(), router={};
for (const method of ['get','post','put','delete']) {
  router[method] = (route, fn) => handlers.set(method.toUpperCase()+' '+route,fn);
}
registerMiniAppAdminRegistrationRoutes(router);
registerManagerRoutes(router);
registerPartnerRoutes(router);
registerOwnerRoutes(router);
registerProductRoutes(router);

async function invoke(method,route,role,id,body={},query={}) {
  const handler=handlers.get(method+' '+route);
  assert.ok(handler,'API exists: '+method+' '+route);
  const res={status:0,body:null,writeHead(code){this.status=code;},
    end(raw){this.body=JSON.parse(raw);}};
  const token=role ? signToken({role,id,login:'test-actor',adminRole:'admin'}) : '';
  await handler({headers:{authorization:token?'Bearer '+token:''}},res,
    {params:{},query,body});
  return res;
}
function admin(login,active=1) {
  return Number(db.prepare(
    'INSERT INTO admins(login,password_hash,full_name,active,role) VALUES(?,?,?,?,?)'
  ).run(login,'hash',login,active,'admin').lastInsertRowid);
}
function manager(code) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active) '+
    'VALUES(?,?,?,?,?,?,1)'
  ).run(code,code,'hash','Менеджер '+code,'79130000001','krsk').lastInsertRowid);
}
function salon(id,assignedManager,active=1,hub=0) {
  db.prepare(
    'INSERT INTO points(id,name,addr,icon,city_id,manager_id,active,is_hub) VALUES(?,?,?,?,?,?,?,?)'
  ).run(id,'Салон '+id,'Красноярск, ул. Тестовая, 12','🐾','krsk',assignedManager,active,hub);
}
const adminId=admin('operator-admin');
const disabledId=admin('disabled-admin',0);
const existingManagerId=manager('MGR-2026-001');
salon('open-salon',existingManagerId);
salon('no-manager',null);
salon('archived',existingManagerId,0);
salon('warehouse-hub',existingManagerId,1,1);
db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,active) VALUES(?,?,?,?,?,1)'
).run('owner-old','hash','Владелец','79130000002','open-salon');
db.prepare(
  'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name) VALUES(?,?,?,?,?,?,?)'
).run('GR-001','groomer-old','hash','Грумер А','79130000003','open-salon','Салон open-salon');
const productId=Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)'
).run('dry-treat','Тестовый товар','treats','🐾','Тест','[]').lastInsertRowid);
const variantId=Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES(?,?,?)'
).run(productId,'5 шт.',90).lastInsertRowid);

test('registration options never leak accounts or expose inactive or hub points',async()=>{
  const route='/api/miniapp/admin/registration-options';
  assert.equal((await invoke('GET',route,null,0)).status,401);
  assert.equal((await invoke('GET',route,'manager',existingManagerId)).status,401);
  assert.equal((await invoke('GET',route,'owner',1)).status,401);
  assert.equal((await invoke('GET',route,'admin',disabledId)).status,401);
  const result=await invoke('GET',route,'admin',adminId);
  assert.equal(result.status,200);
  assert.deepEqual(result.body.points.map(p=>p.id).sort(),['no-manager','open-salon']);
  assert.deepEqual(result.body.owner_points.map(p=>p.id),['no-manager']);
  assert.equal(result.body.managers.length,1);
  assert.equal(result.body.groomers.length,1);
  assert.equal(result.body.cities.some(c=>c.id==='krsk'),true);
  const serialized=JSON.stringify(result.body);
  for(const forbidden of ['password_hash','79130000001','79130000003','warehouse-hub','archived']){
    assert.equal(serialized.includes(forbidden),false,forbidden);
  }
});

test('only active admin can create managers; input uses verified city',async()=>{
  const body={full_name:'Менеджер Новый',phone:'+7 913 111-11-11',
    email:'new@example.ru',login:'manager-new',password:'secure123',city_id:'krsk'};
  assert.equal((await invoke('POST','/api/managers',null,0,body)).status,401);
  assert.equal((await invoke('POST','/api/managers','partner',1,body)).status,401);
  assert.equal((await invoke('POST','/api/managers','admin',disabledId,body)).status,401);
  assert.equal((await invoke('POST','/api/managers','admin',adminId,
    {...body,city_id:'invalid',login:'manager-invalid'})).status,400);
  const created=await invoke('POST','/api/managers','admin',adminId,body);
  assert.equal(created.status,201,created.body?.error);
  assert.match(created.body.mgr_code,/^MGR-20\d\d-\d{3}$/);
  assert.equal(db.prepare('SELECT city_id,active FROM managers WHERE id=?')
    .get(created.body.id).city_id,'krsk');
  assert.equal((await invoke('POST','/api/managers','admin',adminId,body)).status,409);
  const options=(await invoke('GET','/api/miniapp/admin/registration-options','admin',adminId)).body;
  assert.equal(options.managers.some(m=>m.id===Number(created.body.id)),true);
});

test('admin creates point, assigns a selected manager, enables stock and staff signup',async()=>{
  const body={name:'Новое место',addr:'ул. Молокова, 40',city_id:'krsk',
    manager_id:existingManagerId,icon:'📍',lat:56.009,lng:92.85};
  assert.equal((await invoke('POST','/api/points','admin',disabledId,body)).status,401);
  assert.equal((await invoke('POST','/api/points','partner',1,body)).status,401);
  const created=await invoke('POST','/api/points','admin',adminId,body);
  assert.equal(created.status,201,created.body?.error);
  const point=db.prepare('SELECT * FROM points WHERE id=?').get(created.body.id);
  assert.equal(point.manager_id,existingManagerId);
  assert.equal(point.city_id,'krsk');
  assert.equal(point.active,1);
  assert.equal(point.is_hub,0);
  assert.equal(db.prepare('SELECT qty FROM stock WHERE variant_id=? AND point_id=?')
    .get(variantId,created.body.id).qty,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_points WHERE point_id=? AND manager_id=?')
    .get(created.body.id,existingManagerId).n,1);
  const options=(await invoke('GET','/api/miniapp/admin/registration-options','admin',adminId)).body;
  assert.equal(options.points.some(p=>p.id===created.body.id),true);
  assert.equal(options.owner_points.some(p=>p.id===created.body.id),true);
  assert.equal((await invoke('POST','/api/points','admin',adminId,body)).status,409);
  const unassigned=await invoke('POST','/api/points','admin',adminId,{
    ...body,name:'Точка без менеджера',manager_id:null,
  });
  assert.equal(unassigned.status,201);
  assert.equal(db.prepare('SELECT manager_id FROM points WHERE id=?').get(unassigned.body.id).manager_id,null);
});

test('admin groomer signup is protected and retains point-assigned manager',async()=>{
  const route='/api/miniapp/admin/register-groomer';
  const body={full_name:'Грумер Новая',phone:'79134445566',
    login:'groomer-new',password:'secure123',point_id:'open-salon',
    personal_data_consent:true};
  assert.equal((await invoke('POST',route,null,0,body)).status,401);
  assert.equal((await invoke('POST',route,'manager',existingManagerId,body)).status,401);
  assert.equal((await invoke('POST',route,'admin',disabledId,body)).status,401);
  assert.equal((await invoke('POST',route,'admin',adminId,{...body,point_id:'archived'})).status,400);
  assert.equal((await invoke('POST',route,'admin',adminId,{...body,point_id:'warehouse-hub'})).status,403);
  assert.equal((await invoke('POST',route,'admin',adminId,{...body,manager_code:'MGR-2026-999'})).status,400);
  assert.equal((await invoke('POST',route,'admin',adminId,{...body,personal_data_consent:false})).status,400);
  const created=await invoke('POST',route,'admin',adminId,body);
  assert.equal(created.status,201,created.body?.error);
  assert.match(created.body.partner_code,/^GR-/);
  const row=db.prepare('SELECT point_id,manager_code,phone FROM partners WHERE id=?').get(created.body.id);
  assert.equal(row.point_id,'open-salon');
  assert.equal(row.manager_code,'MGR-2026-001');
  assert.equal((await invoke('POST',route,'admin',adminId,{
    ...body,login:'groomer-duplicate',password:'secure123',
  })).status,409);
});

test('admin creates owner linked only to matching groomer; rejected duplicates do not mutate',async()=>{
  const route='/api/salon-owners';
  const groomer=db.prepare("SELECT id FROM partners WHERE login='groomer-new'").get();
  const body={full_name:'Грумер Новая',phone:'79134445566',login:'owner-new',
    password:'secure123',point_id:'open-salon',groomer_partner_id:groomer.id};
  assert.equal((await invoke('POST',route,'admin',disabledId,body)).status,401);
  assert.equal((await invoke('POST',route,'manager',999,body)).status,401);
  assert.equal((await invoke('POST',route,'admin',adminId,body)).status,409,
    'an existing owner cannot be silently replaced');
  // A new salon has no owner, and links are allowed only for matching phones.
  const freePoint=db.prepare("SELECT id FROM points WHERE name='Новое место'").get().id;
  assert.equal((await invoke('POST',route,'admin',adminId,{
    ...body,point_id:freePoint,groomer_partner_id:groomer.id,login:'wrong-point-owner',
  })).status,400);
  const noLink={...body,point_id:freePoint,groomer_partner_id:null};
  const created=await invoke('POST',route,'admin',adminId,noLink);
  assert.equal(created.status,201,created.body?.error);
  assert.match(created.body.owner_code,/^OWN-/);
  assert.equal(db.prepare('SELECT point_id FROM salon_owners WHERE id=?')
    .get(created.body.id).point_id,freePoint);
  assert.equal((await invoke('POST',route,'admin',adminId,{...noLink,login:'owner-next'})).status,409);
});
