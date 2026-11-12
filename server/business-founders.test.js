'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-business-founder-'));
const db=require('./db');
const {verifyToken,verifyPassword,hashPassword,signToken}=require('./auth');
const {
 FOUNDER_SLOTS,activeFounder,getFounder,configureFounder,
}=require('./business-founders');
const {registerBusinessFounderRoutes,collectFounderDashboard,periodBounds}=require('./routes-business-founders');
const {recordVerifiedTelegramContact,availableTelegramAccounts,issueTelegramAccountSession}=require('./miniapp-phone-identity');

function admin(role='super', active=1){
 const row=db.prepare('SELECT id FROM admins WHERE login=?').get('test-owner-super');
 if(row){db.prepare('UPDATE admins SET role=?,active=? WHERE id=?').run(role,active,row.id);return row.id;}
 return Number(db.prepare(
  'INSERT INTO admins(login,password_hash,full_name,role,active) VALUES (?,?,?,?,?)'
 ).run('test-owner-super',hashPassword('my-super-admin-secret'),'Super Admin',role,active).lastInsertRowid);
}
function routes(){
 const map=new Map();
 const router={get(p,fn){map.set('GET '+p,fn);},put(p,fn){map.set('PUT '+p,fn);}};
 registerBusinessFounderRoutes(router);
 return map;
}
function call(method,path,args={}){
 const map=routes(),fn=map.get(method+' '+path);
 if(!fn)throw new Error('Missing route '+path);
 const response={status:null,writeHead(code){this.status=code;},end(body){this.body=JSON.parse(body);}};
 fn({headers:args.token?{authorization:'Bearer '+args.token}:{}},response,{
  body:args.body||{},query:args.query||{},params:args.params||{},
 });
 return response;
}
const founderNames=FOUNDER_SLOTS.map(f=>f.name);
test('three founder slots are seeded disabled and distinct from grooming salon owners',()=>{
 assert.deepEqual(db.prepare('SELECT full_name FROM business_founders ORDER BY id').all().map(r=>r.full_name),founderNames);
 assert.equal(db.prepare('SELECT SUM(share_percent) AS total FROM business_founders').get().total,100);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business_founders WHERE active=1').get().n,0);
 assert.equal(activeFounder(1),null);
});
test('only active superadmin can provision; normal admin and founder cannot',()=>{
 const superId=admin('super',1);
 const normal=signToken({id:superId,role:'admin',adminRole:'admin'});
 assert.equal(call('GET','/api/business-founders',{token:normal}).status,403);
 const wrong=signToken({id:superId,role:'founder'});
 assert.equal(call('GET','/api/business-founders',{token:wrong}).status,401);
 const adminSession=signToken({id:superId,role:'admin',adminRole:'super'});
 assert.equal(call('GET','/api/business-founders',{token:adminSession}).status,200);
 const testFounders=call('GET','/api/business-founders',{token:adminSession}).body.founders;
 assert.equal(testFounders.length,3);
 assert.equal(JSON.stringify(testFounders).includes('password_hash'),false);
 assert.equal(JSON.stringify(testFounders).includes('telegram_chat_id'),false);
 admin('super',0);
 assert.equal(call('GET','/api/business-founders',{token:adminSession}).status,403);
 admin('super',1);
});
test('explicit founder activation needs phone and strong password; reserves share',()=>{
 const id=getFounder(1).id;
 assert.equal(configureFounder(id,{login:'aleksey-owner',phone:'79135554433',active:true}).status,400);
 const result=configureFounder(id,{login:'aleksey-owner',phone:'+7 913 555-44-33',
   password:'strong-owner-passphrase!',active:true});
 assert.equal(result.ok,true);
 assert.equal(result.founder.active,true);
 assert.equal(result.founder.share_percent,45);
 assert.equal(result.founder.phone_masked,'+7 (***) ***-**-33');
 assert.equal(result.founder.password_hash,undefined);
 assert.equal(result.founder.phone,undefined);
 assert.ok(verifyPassword('strong-owner-passphrase!',getFounder(id).password_hash));
 assert.equal(configureFounder(2,{login:'vit-owner',phone:'79135554433',password:'another-pass-123',
  active:true}).status,409);
});
test('founder Telegram account is matched only after verified own contact',()=>{
 const userId=811122330;
 assert.equal(availableTelegramAccounts(userId).accounts.some(a=>a.role==='founder'),false);
 const attempt=issueTelegramAccountSession(userId,'founder');
 assert.equal(attempt,null);
 const message={from:{id:userId},chat:{id:userId,type:'private'},
  contact:{user_id:userId,phone_number:'8(913)555-44-33'}};
 assert.equal(recordVerifiedTelegramContact(message).verified,true);
 const accounts=availableTelegramAccounts(userId).accounts.filter(a=>a.role==='founder');
 assert.equal(accounts.length,1);
 assert.equal(accounts[0].name,'Лакомых Алексей');
 const session=issueTelegramAccountSession(userId,'founder');
 assert.ok(session);
 const payload=verifyToken(session.token);
 assert.equal(payload.role,'founder');
 assert.equal(payload.id,1);
 assert.equal(payload.adminRole,undefined,'founder must not receive admin grants');
 assert.equal(getFounder(1).telegram_chat_id,String(userId));
});
test('founder cannot access admin data even if founder token is valid',()=>{
 const founderToken=signToken({role:'founder',id:1,login:'aleksey-owner'});
 assert.equal(call('GET','/api/business-founder/me',{token:founderToken}).status,200);
 assert.equal(call('GET','/api/business-founders',{token:founderToken}).status,401);
 assert.equal(call('GET','/api/business-founder/dashboard',{token:'invalid',query:{period:'30d'}}).status,401);
 assert.equal(call('GET','/api/business-founder/dashboard',{token:founderToken,query:{period:'wrong'}}).status,400);
});
test('founder revenue, capital and expenses derive from actual records, not fabricated values',()=>{
 db.prepare(
  'INSERT INTO points(id,name,addr,icon,active,is_hub) VALUES(?,?,?,?,?,?)'
 ).run('test-bark','БаркЛай','Молокова 40','🐾',1,0);
 db.prepare(
  'INSERT INTO points(id,name,addr,icon,active,is_hub) VALUES(?,?,?,?,?,?)'
 ).run('test-silent','Точка без продаж','Молокова 20','🐾',1,0);
 const orderTime='2026-10-31 11:00:00';
 db.prepare(
  'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,'+
  'subtotal,total,payment_method,status,commission_rate,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
 ).run('OWN-TEST-1','Тест','79135554433','БаркЛай','test-bark',1000,1000,'yookassa','paid',0.15,orderTime);
 db.prepare(
  'INSERT INTO expenses(expense_date,category,amount,investor_name) VALUES (?,?,?,?)'
 ).run('2026-10-31','Товар',200,'Лакомых Алексей');
 const user=getFounder(1);
 const dashboard=collectFounderDashboard(user,'30d',new Date('2026-11-01T12:00:00Z'));
 assert.equal(dashboard.sales.revenue,1000);
 assert.equal(dashboard.sales.orders,1);
 assert.equal(dashboard.sales.avg_check,1000);
 assert.equal(dashboard.finance.manual_expenses,200);
 assert.equal(dashboard.capital.my_planned_share,450000);
 assert.equal(dashboard.capital.personal_expenses_recorded,200);
 assert.equal(dashboard.capital.actual_paid_capital,null);
 assert.equal(dashboard.network.active_points,2);
 assert.equal(dashboard.network.top_points[0].name,'БаркЛай');
 assert.equal(dashboard.network.silent_points[0].name,'Точка без продаж');
 assert.ok(dashboard.strategy.goal_2031>=1000);
 assert.equal(JSON.stringify(dashboard).includes('79135554433'),false,'no customer phone in founder dashboard');
 assert.equal(JSON.stringify(dashboard).includes('password_hash'),false);
});

test('founder counts ALL silent active salons, even past the previous 50-point ranking cutoff', () => {
 const founder=getFounder(1);
 for(let i=0;i<60;i++){
   db.prepare('INSERT INTO points(id,name,addr,icon,active,is_hub) VALUES(?,?,?,?,?,?)')
     .run('founder-silent-'+i,'Новая точка '+i,'Красноярск','🐾',1,0);
 }
 db.prepare('INSERT INTO points(id,name,addr,icon,active,is_hub) VALUES(?,?,?,?,?,?)')
   .run('founder-inactive','Удалённая тестовая точка','Красноярск','🐾',0,0);
 const dashboard=collectFounderDashboard(founder,'30d',new Date('2026-11-01T12:00:00Z'));
 const currentPoints=Number(db.prepare('SELECT COUNT(*) AS c FROM points WHERE active=1 AND COALESCE(is_hub,0)=0').get().c);
 assert.equal(dashboard.network.active_points,currentPoints);
 assert.equal(dashboard.network.silent_points_count,currentPoints-dashboard.network.sold_points_period);
 assert.ok(dashboard.network.silent_points_count>=60);
 assert.equal(dashboard.network.silent_points.length,7,'only list preview is capped');
 assert.equal(dashboard.network.silent_points.some(p=>p.name==='Удалённая тестовая точка'),false);
});

test('deactivating owner denies previously signed sessions and prevents Telegram login',()=>{
 const ownerSession=signToken({role:'founder',id:1});
 const adminSession=signToken({role:'admin',id:admin('super',1),adminRole:'super'});
 const result=call('PUT','/api/business-founders/:id',{
  token:adminSession,params:{id:'1'},
  body:{login:'aleksey-owner',active:false},
 });
 assert.equal(result.status,200);
 assert.equal(call('GET','/api/business-founder/me',{token:ownerSession}).status,401);
 assert.equal(issueTelegramAccountSession(811122330,'founder'),null);
});
test('changing registered phone forces Telegram re-link',()=>{
 configureFounder(1,{login:'aleksey-owner',phone:'79135554433',active:true});
 db.prepare('UPDATE business_founders SET telegram_chat_id=? WHERE id=1').run('999888777');
 const r=configureFounder(1,{login:'aleksey-owner',phone:'79134443322',active:true});
 assert.equal(r.telegram_reconnect_required,true);
 assert.equal(getFounder(1).telegram_chat_id,null);
});
test('Krasnoyarsk month period starts at first local day with UTC offset',()=>{
 const t=periodBounds('month',new Date('2026-11-01T00:00:00Z'));
 assert.equal(t.date_from,'2026-11-01');
 assert.equal(t.from,'2026-10-31 17:00:00');
});


test('six-month founder sales keep the same net figures with one grouped SQL query', () => {
  const d = collectFounderDashboard(getFounder(1),'30d',new Date('2026-11-01T12:00:00Z'));
  assert.equal(d.sales.last_six_months.length,6);
  const october=d.sales.last_six_months.find(row => row.month==='2026-10');
  assert.deepEqual(october,{month:'2026-10',revenue:1000,orders:1,avg_check:1000});
  const november=d.sales.last_six_months.find(row => row.month==='2026-11');
  assert.deepEqual(november,{month:'2026-11',revenue:0,orders:0,avg_check:0});
});
