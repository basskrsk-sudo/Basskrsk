'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(),'hm-miniapp-new-point-'));
delete process.env.TG_TOKEN;
delete process.env.TG_CHAT_ID;
const db = require('./db');
const club = require('./routes-partner-club');
const telegram = require('./telegram');
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

async function invoke(method, route, payload, body={}, params={}) {
  const handler=routes.get(method+' '+route);
  assert.ok(handler,'route exists: '+route);
  const response = {status:0,body:null,
    writeHead(code){this.status=code;},
    end(text){this.body=JSON.parse(text);}};
  const auth=payload ? 'Bearer '+signToken(payload) : '';
  await handler({headers:{authorization:auth}},response,{params,query:{},body});
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
const moderator=Number(db.prepare("INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role,active) VALUES(?,?,?,?,?,1)").run('new-point-reviewer','hash','Moderator','332201','super').lastInsertRowid);
const group='-100201';
const cfg={enabled:true,chat_id:group,reviewer_admin_id:moderator,club_started_at:'2020-01-01 00:00:00',new_points:true,record_day:false,sales:false,record_check:false,first_sale:false,daily:false,weekly:false,milestones:false,tips:false,new_products:false,top_products_week:false,top_products_all:false};
function configureClub(overrides={}){db.prepare("INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json").run(JSON.stringify({...cfg,...overrides}));}
configureClub();
function welcomeCount(){return db.prepare("SELECT COUNT(*) n FROM partner_club_events WHERE event_type='new_points'").get().n;}
function welcomeFor(id){return db.prepare("SELECT * FROM partner_club_events WHERE event_key=?").get('welcome:point:'+id);}
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
  const draft=welcomeFor(point.id);
  assert.ok(draft,'registration alone creates the draft');
  assert.equal(draft.status,'draft');
  assert.equal(draft.event_type,'new_points');
  assert.match(draft.message,/Кот и Пёс/);
  assert.match(draft.message,/Красноярск/);
  assert.doesNotMatch(draft.message,/Молокова|79130000000/);
  assert.equal(club.welcomeNewPoint({id:point.id}),false);
  assert.equal(welcomeCount(),1);
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
  assert.equal(welcomeCount(),1);
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

test('admin and legacy retail registration create drafts; manager-only lead and disabled feature do not',async()=>{
 const admin={role:'admin',id:moderator,login:'new-point-reviewer'};
 const created=await invoke('POST','/api/points',admin,{...base,name:'Админский салон',addr:'Тестовая 15'});
 assert.equal(created.status,201,created.body?.error);
 assert.ok(welcomeFor(created.body.id));
 const before=welcomeCount();
 const lead=await invoke('POST','/api/managers/:id/points',actor,{point_name:'Лид без адреса',point_type:'Груминг'},{id:managerId});
 assert.equal(lead.status,201);assert.equal(lead.body.point_id,null);
 assert.equal(welcomeCount(),before);
 const legacy=await invoke('POST','/api/managers/:id/points',actor,{point_name:'Ветклиника Тест',point_type:'Ветеринарная клиника',address:'Тестовая 20'},{id:managerId});
 assert.equal(legacy.status,201);
 assert.match(welcomeFor(legacy.body.point_id).message,/Ветеринарная клиника/);
 assert.equal(welcomeCount(),before+1);
 assert.equal(club.welcomeNewPoint({id:legacy.body.point_id}),false);
 configureClub({new_points:false});
 try{
  const disabled=await invoke('POST','/api/points',actor,{...base,name:'Выключенная рассылка',addr:'Тестовая 21'});
  assert.equal(disabled.status,201);assert.equal(welcomeFor(disabled.body.id),undefined);
  assert.equal(welcomeCount(),before+1);
 }finally{configureClub();}
});
test('welcome drafts go only to private moderator, support edit/reject and publish exactly once after approval',async()=>{
 const oldSend=telegram.sendToChat,oldSet=global.setTimeout,oldClear=global.clearTimeout;
 const sent=[],timers=new Map();let seq=0;
 telegram.sendToChat=async(chat,html,options)=>{sent.push({chat:String(chat),html,options});return {ok:true,data:{ok:true}};};
 global.setTimeout=(fn,delay)=>{const h={id:++seq,delay,fn,unref(){}};timers.set(h.id,h);return h;};
 global.clearTimeout=h=>{if(h)timers.delete(h.id);};
 try{
  const drafts=db.prepare("SELECT e.*,p.active FROM partner_club_events e JOIN points p ON e.event_key='welcome:point:'||p.id WHERE e.event_type='new_points' ORDER BY e.id").all();
  assert.ok(drafts.length>=4);
  const active=drafts.filter(d=>d.active===1);
  const archived=drafts.find(d=>d.active===0);
  assert.ok(archived);
  club.startPartnerClubWorker();
  const timer=[...timers.values()][0];assert.ok(timer);timers.delete(timer.id);timer.fn();
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,drafts.length);
  assert.ok(sent.every(s=>s.chat==='332201' && s.html.includes('Черновик')));
  for(const s of sent){
   const buttons=s.options.reply_markup.inline_keyboard.flat();
   assert.ok(buttons.some(b=>b.callback_data.startsWith('club:send:')));
   assert.ok(buttons.some(b=>b.callback_data.startsWith('club:edit:')));
   assert.ok(buttons.some(b=>b.callback_data.startsWith('club:reject:')));
  }
  assert.equal((await club.handleClubCallback('unauthorized','club:send:'+active[0].id)).ok,false);
  assert.equal((await club.handleClubCallback('332201','club:send:'+archived.id)).ok,false);
  assert.equal((await club.handleClubCallback('332201','club:edit:'+active[0].id)).ok,true);
  assert.equal((await club.handleClubCallback('332201','club:send:'+active[0].id)).ok,false);
  assert.equal((await club.handleClubEdit('332201','/clubtext '+active[0].id+' Добро пожаловать в ХвостМаркет!')).ok,true);
  assert.equal(sent.filter(s=>s.chat===group).length,0);
  assert.equal((await club.handleClubCallback('332201','club:reject:'+active[1].id)).ok,true);
  assert.equal((await club.handleClubCallback('332201','club:send:'+active[1].id)).ok,false);
  configureClub({new_points:false});
  assert.equal((await club.handleClubCallback('332201','club:send:'+active[0].id)).ok,false);
  configureClub();
  assert.equal((await club.handleClubCallback('332201','club:send:'+active[0].id)).ok,true);
  assert.equal((await club.handleClubCallback('332201','club:send:'+active[0].id)).ok,false);
  assert.deepEqual(sent.filter(s=>s.chat===group).map(s=>s.html),['Добро пожаловать в ХвостМаркет!']);
  assert.equal(club.welcomeNewPoint({id:active[0].event_key.slice('welcome:point:'.length)}),false);
 }finally{
  club.stopPartnerClubWorker();telegram.sendToChat=oldSend;global.setTimeout=oldSet;global.clearTimeout=oldClear;
 }
});
test('first groomer registration no longer triggers a point welcome',()=>{
 const src=fs.readFileSync(path.join(__dirname,'routes-partners.js'),'utf8');
 assert.doesNotMatch(src,/welcomeNewPoint/);
});
