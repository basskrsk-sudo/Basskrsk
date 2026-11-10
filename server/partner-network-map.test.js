'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-network-map-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerPartnerLeadRoutes } = require('./routes-partner-leads');
const handlers = new Map();
const router = {};
for (const method of ['get', 'post', 'put', 'delete']) {
  router[method] = (url, fn) => handlers.set(method.toUpperCase() + ' ' + url, fn);
}
const geocodeCalls = [];
registerPartnerLeadRoutes(router, {
  geocodeAddress: async function(query) {
    geocodeCalls.push(query);
    if (query.includes('Ленина, 99')) {
      return {lat: 56.0, lng: 92.8, precision: 'street',
        formattedAddress: 'Россия, Красноярск, улица Ленина'};
    }
    if (query.includes('Ленина, 88')) throw new Error('Service temporarily unavailable');
    return {lat: 56.0123, lng: 92.8456, precision: 'exact',
      formattedAddress: 'Россия, Красноярск, улица Ленина, 2'};
  }
});

function manager(code, city, active = 1) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id,active) VALUES(?,?,?,?,?,?,?)'
  ).run(code, code, 'hash', code, '79130000012', city, active).lastInsertRowid);
}
db.prepare('INSERT OR IGNORE INTO cities(id,name,active) VALUES(?,?,1)').run('krsk', 'Красноярск');
db.prepare('INSERT OR IGNORE INTO cities(id,name,active) VALUES(?,?,1)').run('spb', 'Санкт-Петербург');
const a = manager('MAP-A','krsk');
const b = manager('MAP-B','spb');
const inactive = manager('MAP-OFF','krsk',0);
db.prepare('INSERT INTO admins(id,login,password_hash,active) VALUES(?,?,?,1)')
  .run(995, 'network-map-admin', 'hash');
db.prepare('INSERT INTO admins(id,login,password_hash,active) VALUES(?,?,?,0)')
  .run(996, 'network-map-disabled', 'hash');
const pointInsert = db.prepare(
  'INSERT INTO points(id,name,addr,icon,city_id,manager_id,active,is_hub,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?)');
pointInsert.run('map-active-a','Минимаркет A','Красноярск, пр. Мира, 1','🐾','krsk',a,1,0,56.0,92.8);
pointInsert.run('map-active-b','Минимаркет B','Санкт-Петербург, Невский проспект, 2','🐾','spb',b,1,0,59.9,30.3);
pointInsert.run('map-hub','Технический склад','Красноярск','📦','krsk',a,1,1,56.1,92.9);
pointInsert.run('map-inactive','Закрытая точка','Красноярск','🐾','krsk',a,0,0,56.1,92.9);
const leadInsert = db.prepare(
  'INSERT INTO partner_leads(salon_name,address,phone,city_id,status,assigned_manager_id,linked_point_id) VALUES(?,?,?,?,?,?,?)');
leadInsert.run('Звонить А','Красноярск, улица Ленина, 2','79000000001','krsk','to_call',a,null);
leadInsert.run('Отказ B','Санкт-Петербург, Лиговский, 3','79000000002','spb','declined',b,null);
leadInsert.run('Свободный Красноярск','Красноярск, Мира, 8','79000000003','krsk','no_answer',null,null);
leadInsert.run('Свободный Петербург','Санкт-Петербург, Мира, 8','79000000004','spb','meeting_held',null,null);
leadInsert.run('Привязан к действующей','Красноярск, пр. Мира, 1','79000000005','krsk','signed',a,'map-active-a');

async function mapCall(identity) {
  const handler = handlers.get('GET /api/partner-leads/network-map');
  assert.ok(handler, 'map route exists');
  const req = {headers: {authorization: identity ? 'Bearer ' + signToken(identity) : ''}};
  const res = {status: 0, body: null,
    writeHead(code) { this.status = code; return this; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler(req, res, {query: {}});
  return res;
}
test('network map only accepts active manager or admin', async () => {
  assert.equal((await mapCall(null)).status,401);
  assert.equal((await mapCall({role:'partner',id:a})).status,401);
  assert.equal((await mapCall({role:'manager',id:inactive})).status,401);
  assert.equal((await mapCall({role:'admin',id:996})).status,401);
});
test('manager only sees own live points and available city CRM leads', async () => {
  const result = await mapCall({role:'manager',id:a});
  assert.equal(result.status,200);
  assert.deepEqual(result.body.points.map(x=>x.id),['map-active-a']);
  assert.deepEqual(result.body.leads.map(x=>x.name).sort(),
    ['Звонить А','Свободный Красноярск'].sort());
  assert.equal(result.body.leads.find(x=>x.name==='Звонить А').lat,null);
  assert.equal(result.body.default_city_id,'krsk');
  assert.ok(!JSON.stringify(result.body).includes('Отказ B'));
  assert.ok(!JSON.stringify(result.body).includes('map-inactive'));
  assert.ok(!JSON.stringify(result.body).includes('map-hub'));
});
test('admin sees all operational points, all CRM statuses, no duplicate pinned active lead', async () => {
  const result = await mapCall({role:'admin',id:995});
  assert.equal(result.status,200);
  assert.equal(result.body.points.length,2);
  assert.equal(result.body.leads.length,4);
  assert.ok(result.body.leads.some(x=>x.status==='declined'));
  assert.ok(result.body.leads.some(x=>x.status==='no_answer'));
  assert.ok(result.body.leads.some(x=>x.status==='meeting_held'));
  assert.ok(!result.body.leads.some(x=>x.name==='Привязан к действующей'));
  assert.equal(result.body.points[0].lat != null,true);
  assert.ok(!JSON.stringify(result.body).includes('password_hash'));
});
test('network map is read-only', async () => {
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  await mapCall({role:'manager',id:b});
  const after = db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(after,before);
});

async function coordinateCall(identity, leadIds) {
  const handler = handlers.get('POST /api/partner-leads/network-map/coordinates');
  assert.ok(handler, 'read-only coordinate route exists');
  const req = {headers: {authorization: identity ? 'Bearer ' + signToken(identity) : ''}};
  const res = {status: 0, body: null,
    writeHead(code) { this.status = code; return this; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler(req, res, {body: {lead_ids: leadIds}});
  return res;
}
test('coordinates are resolved for accessible CRM IDs without writing to database', async () => {
  const id = db.prepare("SELECT id FROM partner_leads WHERE salon_name='Звонить А'").get().id;
  const originalChangeCount = db.prepare('SELECT total_changes() n').get().n;
  const before = geocodeCalls.length;
  const response = await coordinateCall({role:'manager',id:a}, [id]);
  assert.equal(response.status, 200);
  assert.equal(response.body.results[0].status, 'mapped');
  assert.equal(response.body.results[0].lat,56.0123);
  assert.ok(geocodeCalls[before].includes('Красноярск'));
  assert.equal(db.prepare('SELECT total_changes() n').get().n, originalChangeCount);
  await coordinateCall({role:'manager',id:a},[id]);
  assert.equal(geocodeCalls.length,before+1, 'cached successful geocoding');
});
test('coordinates cannot reveal a foreign manager lead or validate arbitrary IDs', async () => {
  const foreign = db.prepare("SELECT id FROM partner_leads WHERE salon_name='Отказ B'").get().id;
  const own = db.prepare("SELECT id FROM partner_leads WHERE salon_name='Звонить А'").get().id;
  const before = geocodeCalls.length;
  assert.equal((await coordinateCall(null,[own])).status,401);
  assert.equal((await coordinateCall({role:'partner',id:a},[own])).status,401);
  assert.equal((await coordinateCall({role:'manager',id:inactive},[own])).status,401);
  assert.equal((await coordinateCall({role:'admin',id:996},[own])).status,401);
  assert.equal((await coordinateCall({role:'manager',id:a},[own,foreign])).status,403);
  assert.equal((await coordinateCall({role:'manager',id:a},[0])).status,400);
  assert.equal((await coordinateCall({role:'manager',id:a},[own,own])).status,400);
  assert.equal((await coordinateCall({role:'manager',id:a},[999999])).status,403);
  assert.equal(geocodeCalls.length,before);
});
test('address without house number stays unplaced with a clear reason', async () => {
  const id=Number(leadInsert.run('Нет номера дома','улица Мира','79000000006','krsk','to_call',a,null).lastInsertRowid);
  const response=await coordinateCall({role:'manager',id:a},[id]);
  assert.equal(response.status,200);
  assert.equal(response.body.results[0].status,'needs_address');
  assert.equal(response.body.results[0].lat,undefined);
});
test('imprecise geocoder response is never turned into a map pin', async () => {
  const id=Number(leadInsert.run('Неточный адрес','Красноярск, улица Ленина, 99','79000000007','krsk','declined',a,null).lastInsertRowid);
  const response=await coordinateCall({role:'manager',id:a},[id]);
  assert.equal(response.status,200);
  assert.equal(response.body.results[0].status,'needs_verification');
  assert.equal(response.body.results[0].lat,undefined);
});
test('transient geocoder failures show an unavailable state without fake coordinates', async () => {
  const id=Number(leadInsert.run('Не работает геокодер','Красноярск, улица Ленина, 88','79000000008','krsk','to_call',a,null).lastInsertRowid);
  const response=await coordinateCall({role:'manager',id:a},[id]);
  assert.equal(response.status,200);
  assert.equal(response.body.results[0].status,'unavailable');
  assert.equal(response.body.results[0].lat,undefined);
});
