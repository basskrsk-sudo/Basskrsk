'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(),'hm-miniapp-new-point-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerProductRoutes } = require('./routes-products');
const { registerManagerRoutes } = require('./routes-managers');
const routes = new Map();
const router = {};
for (const verb of ['get','post','put','delete']) router[verb] = (url, fn) => {
  routes.set(verb.toUpperCase()+' '+url, fn);
};
registerProductRoutes(router);
registerManagerRoutes(router);

async function invoke(method, route, payload, body={}) {
  const handler=routes.get(method+' '+route);
  assert.ok(handler,'route exists: '+route);
  const response = {status:0,body:null,
    writeHead(code){this.status=code;},
    end(text){this.body=JSON.parse(text);}};
  const auth=payload ? 'Bearer '+signToken(payload) : '';
  await handler({headers:{authorization:auth}},response,{params:{},query:{},body});
  return response;
}
function manager(code,active=1) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,?)'
  ).run(code,code,'hash',code,'79130000000',active).lastInsertRowid);
}
const managerId=manager('MGR-POINT-01');
const otherManagerId=manager('MGR-POINT-02');
const disabledManagerId=manager('MGR-POINT-03',0);
const actor={role:'manager',id:managerId};
const base={
  name:'Кот и Пёс', addr:'ул. Молокова, 40', city_id:'krsk',
  icon:'🐾',lat:56.009, lng:92.85, manager_id:otherManagerId,
};
const newProduct = Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)'
).run('test-treat','Тестовое лакомство','treats','🐾','Описание','[]').lastInsertRowid);
const variant = Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES(?,?,?)'
).run(newProduct,'5 шт.',90).lastInsertRowid);

test('point creation is not available to guests, owners, or a disabled manager',async()=>{
  assert.equal((await invoke('POST','/api/points',null,base)).status,401);
  assert.equal((await invoke('POST','/api/points',{role:'owner',id:managerId},base)).status,401);
  assert.equal((await invoke('POST','/api/points',{role:'manager',id:disabledManagerId},base)).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM points').get().n,0);
});
test('manager must provide a valid city, salon name and precise address',async()=>{
  const route='/api/points';
  assert.equal((await invoke('POST',route,actor,{...base,city_id:''})).status,400);
  assert.equal((await invoke('POST',route,actor,{...base,city_id:'unknown'})).status,400);
  assert.equal((await invoke('POST',route,actor,{...base,name:' '})).status,400);
  assert.equal((await invoke('POST',route,actor,{...base,addr:'д'})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM points').get().n,0);
});
test('a new point is assigned to authenticated manager, available to staff and appears with zero stock',async()=>{
  const created=await invoke('POST','/api/points',actor,base);
  assert.equal(created.status,201,created.body?.error);
  assert.equal(created.body.ok,true);
  assert.equal(created.body.lat,56.009);
  assert.equal(created.body.lng,92.85);
  const point=db.prepare('SELECT id,name,addr,city_id,manager_id,is_hub,active FROM points WHERE id=?')
    .get(created.body.id);
  assert.equal(point.manager_id,managerId,'spoofed manager_id is ignored');
  assert.equal(point.city_id,'krsk');
  assert.equal(point.name,'Кот и Пёс');
  assert.equal(point.addr,'ул. Молокова, 40');
  assert.equal(point.active,1);
  assert.equal(point.is_hub,0);
  const ledger=db.prepare('SELECT COUNT(*) AS n FROM manager_points WHERE point_id=? AND manager_id=?')
    .get(point.id,managerId);
  assert.equal(ledger.n,1);
  const stock=db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?')
    .get(point.id,variant);
  assert.equal(stock.qty,0,'all product variants get initial zero stock');
  const mine=(await invoke('GET','/api/managers/me/registration-options',actor)).body;
  assert.ok(mine.groomer_points.some(p=>p.id===point.id));
  assert.ok(mine.owner_points.some(p=>p.id===point.id));
  const notMine=(await invoke('GET','/api/managers/me/registration-options',
    {role:'manager',id:otherManagerId})).body;
  assert.equal(notMine.groomer_points.some(p=>p.id===point.id),false);
});
test('duplicate submit is rejected, including different casing, punctuation and archived salons',async()=>{
  const same=await invoke('POST','/api/points',actor,{
    ...base,name:'  КОТ   И   ПЁС ',addr:'ул Молокова 40  ',manager_id:otherManagerId,
  });
  assert.equal(same.status,409,same.body?.error);
  assert.match(same.body.error,/уже зарегистрирован/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM points').get().n,1);
  db.prepare('UPDATE points SET active=0').run();
  const closed=await invoke('POST','/api/points',actor,base);
  assert.equal(closed.status,409,'archived salons require admin reactivation');
  const differentName=await invoke('POST','/api/points',actor,{
    ...base,name:'Другая клиника',manager_id:otherManagerId,
  });
  assert.equal(differentName.status,201,differentName.body?.error);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM points').get().n,2,
    'different businesses may share the same building');
});
