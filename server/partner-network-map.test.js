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

async function coordinateCall(identity, leadIds, candidateIds) {
  const handler = handlers.get('POST /api/partner-leads/network-map/coordinates');
  assert.ok(handler, 'read-only coordinate route exists');
  const req = {headers: {authorization: identity ? 'Bearer ' + signToken(identity) : ''}};
  const res = {status: 0, body: null,
    writeHead(code) { this.status = code; return this; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler(req, res, {body: {lead_ids: leadIds, candidate_ids: candidateIds || []}});
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


test('external registry loads 114 entries but never inserts them into working CRM', async () => {
  const source = require('./partner-map-candidates');
  assert.equal(source.length, 114);
  assert.ok(source.every(row => row.type === 'candidate' &&
    row.status === 'candidate' && row.address.includes('Красноярск')));
  const before = db.prepare('SELECT COUNT(*) AS n FROM partner_leads').get().n;
  const admin = await mapCall({role:'admin',id:995});
  assert.equal(admin.status, 200);
  assert.equal(admin.body.candidate_source_total, 114);
  assert.equal(admin.body.candidates.length, 114);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_leads').get().n, before);
});

test('manager candidate overlay is limited to the assigned city', async () => {
  const krasnoyarsk = await mapCall({role:'manager',id:a});
  const petersburg = await mapCall({role:'manager',id:b});
  assert.equal(krasnoyarsk.body.candidates.length,114);
  assert.equal(petersburg.body.candidates.length,0);
  assert.equal(petersburg.body.candidate_source_total,0);
});

test('candidate coordinates work through secure server route by IDs only', async () => {
  const countBefore = db.prepare('SELECT total_changes() AS n').get().n;
  const r = await coordinateCall({role:'manager',id:a},[],[1,2]);
  assert.equal(r.status,200);
  assert.equal(r.body.results.length,2);
  assert.equal(r.body.results[0].type,'candidate');
  assert.equal(r.body.results[1].type,'candidate');
  assert.ok(geocodeCalls.some(q=>q.includes('Красноярск')));
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n,countBefore);
  assert.equal((await coordinateCall({role:'manager',id:b},[],[1])).status,403);
  assert.equal((await coordinateCall({role:'manager',id:a},[],[7777])).status,403);
  assert.equal((await coordinateCall({role:'manager',id:a},[],Array(11).fill(1))).status,400);
});

test('candidate status never overrides live CRM or duplicates working minimarket',async () => {
  const result = await mapCall({role:'admin',id:995});
  assert.ok(result.body.points.every(row=>row.status==='active'));
  assert.ok(result.body.leads.every(row=>row.status!=='candidate'));
  assert.ok(result.body.candidates.every(row=>row.status==='candidate'));
  const known=result.body.candidates.filter(row=>row.recommendation==='Не добавлять повторно');
  assert.equal(known.length,4);
});


test('live CRM map includes actual Yandex organization IDs and linked point profile URLs', async () => {
  db.prepare("UPDATE partner_leads SET yandex_org_id=?, yandex_url=? WHERE salon_name='Звонить А'")
    .run('16856539729', 'https://yandex.ru/maps/org/tsatsagrum/16856539729',);
  db.prepare("UPDATE partner_leads SET yandex_org_id=?, yandex_url=? WHERE salon_name='Привязан к действующей'")
    .run('19999999999', 'https://yandex.ru/maps/org/salon/19999999999');
  const map = await mapCall({role:'admin', id:995});
  assert.equal(map.status,200);
  const lead = map.body.leads.find(x => x.name === 'Звонить А');
  assert.equal(lead.yandex_org_id, '16856539729');
  assert.match(lead.yandex_url, /tsatsagrum\/16856539729/);
  const point = map.body.points.find(x => x.id === 'map-active-a');
  assert.equal(point.yandex_org_id, '19999999999');
  assert.equal(point.yandex_url, 'https://yandex.ru/maps/org/salon/19999999999');
});


test('only the verified TsatsaGroom branch carries its direct Yandex profile ID', async () => {
  const result = await mapCall({role:'admin',id:995});
  assert.equal(result.status, 200);
  const first = result.body.candidates.find(row => row.id === 12);
  const second = result.body.candidates.find(row => row.id === 13);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.yandex_org_id, '16856539729');
  assert.equal(second.yandex_org_id, null);
});


async function reviewCandidate(identity, id, body) {
  const handler = handlers.get('POST /api/partner-leads/network-map/candidates/:id/review');
  assert.ok(handler, 'authenticated candidate review route exists');
  const req = {headers: {authorization: identity ? 'Bearer ' + signToken(identity) : ''}};
  const res = {status: 0, body: null,
    writeHead(code) { this.status = code; return this; },
    end(payload) { this.body = JSON.parse(payload); }
  };
  await handler(req, res, {params: {id: String(id)}, body: body || {}});
  return res;
}

test('candidate review is denied to buyers, unauthorized accounts, and managers from another city', async () => {
  const body = {action: 'hide', reason: 'not_grooming'};
  for (const user of [null, {role: 'partner', id: a},
    {role: 'manager', id: inactive}, {role: 'admin', id: 996}]) {
    assert.equal((await reviewCandidate(user, 27, body)).status, 401);
  }
  assert.equal((await reviewCandidate({role: 'manager', id: b}, 27, body)).status, 403);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 0, body)).status, 404);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 999999, body)).status, 404);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, '../27', body)).status, 404);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 27, {action:'delete'})).status, 400);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 27,
    {action:'hide',reason:'invalid'})).status, 400);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 27,
    {action:'hide',reason:'not_grooming',note:'a'.repeat(301)})).status, 400);
  assert.equal((await reviewCandidate({role: 'manager', id: a}, 27,
    {action:'hide',reason:'not_grooming',note:{bad:true}})).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_map_candidate_review_log').get().n, 0);
});

test('reviewed non-groomer disappears from map for every staff member but is retained for recovery', async () => {
  const id = 27;
  const original = require('./partner-map-candidates').find(row => row.id === id);
  assert.ok(original);
  const crmBefore = db.prepare('SELECT COUNT(*) n FROM partner_leads').get().n;
  const pointBefore = db.prepare('SELECT COUNT(*) n FROM points').get().n;
  const result = await reviewCandidate({role:'manager',id:a},id,{
    action:'hide',reason:'not_grooming',note:'Проверил: салона груминга нет'
  });
  assert.equal(result.status,200);
  assert.equal(result.body.ok,true);
  assert.equal(result.body.id,id);
  assert.equal(result.body.hidden,true);
  assert.equal(result.body.review_reason,'not_grooming');
  assert.equal(result.body.review_note,'Проверил: салона груминга нет');
  assert.ok(result.body.reviewed_at);

  const managerView = await mapCall({role:'manager',id:a});
  const adminView = await mapCall({role:'admin',id:995});
  assert.equal(managerView.body.candidates.find(row=>row.id===id).hidden,true);
  assert.equal(adminView.body.candidates.find(row=>row.id===id).hidden,true);
  assert.equal(adminView.body.candidate_hidden_total,1);
  assert.equal(adminView.body.candidate_source_total,114);
  const beforeGeocode = geocodeCalls.length;
  const coords = await coordinateCall({role:'admin',id:995},[],[id]);
  assert.equal(coords.status,200);
  assert.equal(coords.body.results[0].status,'hidden');
  assert.equal(geocodeCalls.length,beforeGeocode,
    'hidden candidates must not generate additional Yandex API calls');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads').get().n,crmBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM points').get().n,pointBefore);
  assert.equal(require('./partner-map-candidates').length,114);
  assert.equal(require('./partner-map-candidates').find(row=>row.id===id).hidden,undefined);
  const review=db.prepare('SELECT * FROM partner_map_candidate_reviews WHERE candidate_id=?').get(id);
  assert.equal(review.hidden,1);
  assert.equal(review.reviewed_by_role,'manager');
  assert.equal(review.reviewed_by_id,a);
  const log=db.prepare('SELECT * FROM partner_map_candidate_review_log WHERE candidate_id=?').all(id);
  assert.equal(log.length,1);
  assert.equal(log[0].action,'hide');
});

test('administrator can restore reviewed candidate and history stays in audit log', async () => {
  const id=27;
  const result=await reviewCandidate({role:'admin',id:995},id,{action:'restore'});
  assert.equal(result.status,200);
  assert.equal(result.body.hidden,false);
  assert.equal(result.body.review_reason,null);
  const admin=await mapCall({role:'admin',id:995});
  const mgr=await mapCall({role:'manager',id:a});
  assert.equal(admin.body.candidates.find(row=>row.id===id).hidden,false);
  assert.equal(mgr.body.candidates.find(row=>row.id===id).hidden,false);
  assert.equal(admin.body.candidate_hidden_total,0);
  const log=db.prepare('SELECT action,actor_role FROM partner_map_candidate_review_log WHERE candidate_id=? ORDER BY id').all(id);
  assert.deepEqual(log.map(row=>row.action),['hide','restore']);
  assert.deepEqual(log.map(row=>row.actor_role),['manager','admin']);
  assert.equal(db.prepare('SELECT hidden FROM partner_map_candidate_reviews WHERE candidate_id=?').get(id).hidden,0);
});


async function candidateContact(identity, id, body) {
  const handler = handlers.get('POST /api/partner-leads/network-map/candidates/:id/contact');
  assert.ok(handler, 'authenticated map contact status route exists');
  const req={headers:{authorization:identity ? 'Bearer '+signToken(identity) : ''}};
  const res={status:0,body:null,writeHead(code){this.status=code;return this;},
    end(payload){this.body=JSON.parse(payload);}};
  await handler(req,res,{params:{id:String(id)},body:body || {}});
  return res;
}
test('all six CRM stages and extra pre-CRM/messaging stages are available to external candidates', async () => {
  const id=47;
  const crmBefore=db.prepare('SELECT COUNT(*) n FROM partner_leads').get().n;
  const pointsBefore=db.prepare('SELECT COUNT(*) n FROM points').get().n;
  const statuses=['candidate','to_call','no_answer','in_progress',
    'message_sent','waiting_reply','meeting_scheduled','meeting_held','signed','declined'];
  for(const status of statuses) {
    const request={
      status,
      channel:['message_sent','waiting_reply'].includes(status)?'vk':'',
      note:'Тестовая запись',
      next_contact_date:'2026-11-13'
    };
    const response=await candidateContact({role:'manager',id:a},id,request);
    assert.equal(response.status,200,'saving status '+status);
    assert.equal(response.body.ok,true);
    assert.equal(response.body.contact_status,status);
    assert.equal(response.body.hidden,false);
    assert.equal(response.body.next_contact_date,'2026-11-13');
  }
  for(const channel of ['vk','tg','max']) {
    const response=await candidateContact({role:'manager',id:a},id,{
      status:'waiting_reply',channel,note:'Написали в соцсетях',next_contact_date:'2026-11-14'
    });
    assert.equal(response.status,200);
    assert.equal(response.body.contact_status,'waiting_reply');
    assert.equal(response.body.contact_channel,channel);
    assert.equal(response.body.contact_note,'Написали в соцсетях');
    assert.equal(response.body.next_contact_date,'2026-11-14');
  }
  const map=await mapCall({role:'admin',id:995});
  const candidate=map.body.candidates.find(x=>x.id===id);
  assert.equal(candidate.status,'waiting_reply');
  assert.equal(candidate.contact_channel,'max');
  assert.equal(candidate.contact_note,'Написали в соцсетях');
  assert.equal(candidate.next_contact_date,'2026-11-14');
  assert.equal(candidate.hidden,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_leads').get().n,crmBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM points').get().n,pointsBefore);
  assert.equal(require('./partner-map-candidates').length,114);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_map_candidate_contact_log WHERE candidate_id=?')
    .get(id).n,statuses.length+3);
});
test('candidate social status requires a valid channel and correct date; access stays scoped', async () => {
  const id=48;
  const user={role:'manager',id:a};
  const value={status:'waiting_reply',channel:'vk',note:'Ожидаю ответа'};
  for(const role of [null,{role:'customer',id:a},{role:'partner',id:a},
    {role:'manager',id:inactive},{role:'admin',id:996}]) {
    assert.equal((await candidateContact(role,id,value)).status,401);
  }
  assert.equal((await candidateContact({role:'manager',id:b},id,value)).status,403);
  assert.equal((await candidateContact(user,999999,value)).status,404);
  assert.equal((await candidateContact(user,'../48',value)).status,404);
  assert.equal((await candidateContact(user,id,{status:'unknown',channel:'vk'})).status,400);
  assert.equal((await candidateContact(user,id,{status:'message_sent',channel:''})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'phone'})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'telegram'})).status,400);
  assert.equal((await candidateContact(user,id,{status:'meeting_held',channel:'fake'})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'vk',
    note:'a'.repeat(501)})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'vk',
    next_contact_date:'2026-02-31'})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'vk',
    next_contact_date:{bad:true}})).status,400);
  assert.equal((await candidateContact(user,id,{status:'waiting_reply',channel:'vk',
    note:{bad:true}})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_map_candidate_contact_log WHERE candidate_id=?')
    .get(id).n,0);
});
test('candidate status updates work for administrator and do not unhide a reviewed non-salon', async () => {
  const id=49;
  const first=await candidateContact({role:'admin',id:995},id,{
    status:'message_sent',channel:'tg',note:'Отправили предложение'
  });
  assert.equal(first.status,200);
  assert.equal(first.body.contact_status,'message_sent');
  const hidden=await reviewCandidate({role:'manager',id:a},id,{
    action:'hide',reason:'not_grooming',note:'Подтверждено'
  });
  assert.equal(hidden.status,200);
  assert.equal(hidden.body.hidden,true);
  assert.equal((await candidateContact({role:'admin',id:995},id,{
    status:'waiting_reply',channel:'max'
  })).status,409);
  const hiddenMap=await mapCall({role:'admin',id:995});
  assert.equal(hiddenMap.body.candidates.find(x=>x.id===id).hidden,true);
  assert.equal(hiddenMap.body.candidates.find(x=>x.id===id).status,'message_sent');
  const restored=await reviewCandidate({role:'admin',id:995},id,{action:'restore'});
  assert.equal(restored.status,200);
  const current=await mapCall({role:'manager',id:a});
  assert.equal(current.body.candidates.find(x=>x.id===id).status,'message_sent');
  assert.equal(current.body.candidates.find(x=>x.id===id).hidden,false);
  const log=db.prepare('SELECT contact_status,contact_channel,actor_role FROM partner_map_candidate_contact_log WHERE candidate_id=?').all(id);
  assert.equal(log.length,1);
  assert.equal(log[0].actor_role,'admin');
});
