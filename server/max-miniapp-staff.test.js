'use strict';
// Real DB and server route tests: signed MAX launch + signed own-contact
// must precede every staff role session. No SMS and no broad role token.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-max-roles-'));
process.env.TOKEN_SECRET='hm-max-staff-test-token';
const db=require('./db');
const {Router}=require('./http-utils');
const {verifyToken,signToken}=require('./auth');
const {registerMaxMiniAppRoutes,verifyMaxBridgeContact}=require('./max-miniapp');
const BOT_TOKEN='hm-max-test-bot';
const router=new Router();
const sentReports=[];
let renderCount=0,denyBeforeSend=false;
const rewardReports=require('./max-reward-reports').createMaxRewardReports(db,{
 renderBrief:async(report,options)=>{renderCount++;assert.equal(report.people.length,1);assert.equal(options.recipient.name,'Получатель отчёта');return Buffer.from('%PDF-test');},
 renderPeriod:async report=>{renderCount++;assert.equal(report.recipient.name,'Получатель отчёта');return Buffer.from('%PDF-period');},
 sendFile:async args=>{if(denyBeforeSend)db.prepare("UPDATE admins SET active=0 WHERE phone='79135550999'").run();args.authorize();sentReports.push(args);return {messageId:'test-mid'};},
});
registerMaxMiniAppRoutes(router,{token:()=>BOT_TOKEN,rewardReports});
const NOW=Math.floor(Date.now()/1000);

function signedLaunch(userId=812345,chatId='8877700',date=NOW) {
  const fields={
    auth_date:String(date),query_id:'max-miniapp-signature-fixture',
    user:JSON.stringify({id:userId,first_name:'Тест MAX'}),
    chat:JSON.stringify({id:chatId,type:'DIALOG'}),
  };
  const payload=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>k+'='+v).join('\n');
  const key=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  return new URLSearchParams({...fields,hash:crypto.createHmac('sha256',key).update(payload).digest('hex')}).toString();
}
function signedContact(userId=812345,phone='+79135550101',date=NOW){
  const authDate=String(date);
  const signedPhone=phone.startsWith('+')?phone.slice(1):phone;
  const value=['authDate='+authDate,'phone='+signedPhone,'userId='+userId].join('\n');
  const hash=crypto.createHmac('sha256',BOT_TOKEN).update(value).digest('hex');
  return {authDate,phone,hash};
}
async function api(path,body={},token){
  const match=router.match('POST',path);
  assert.ok(match,path);
  const res={status:0,json:null,headers:{},
    writeHead(code){this.status=code;},
    setHeader(k,v){this.headers[k]=v;},
    end(data){this.json=data?JSON.parse(data):null;},
  };
  await match.handler({headers:token?{authorization:'Bearer '+token}:{}},res,{body,query:{},params:match.params});
  return res;
}
let next=0;
function partner(phone,extra={}) {
  const code='MAXP-'+(++next);
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_name,active,max_chat_id,point_id) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(code,code,'fake-passhash','Тестовый грумер',phone,'Точка',extra.active??1,extra.chat??null,extra.point??null).lastInsertRowid);
}
function owner(phone,extra={}){
  const login='MAXO-'+(++next);
  return Number(db.prepare(
    'INSERT INTO salon_owners(login,password_hash,full_name,phone,active,max_chat_id,point_id,groomer_partner_id) VALUES (?,?,?,?,?,?,?,?)'
  ).run(login,'fake-passhash','Владелец теста',phone,extra.active??1,extra.chat??null,extra.point??null,extra.partner??null).lastInsertRowid);
}
function manager(phone,chat=null){
  const code='MAXM-'+(++next);
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active,max_chat_id) VALUES (?,?,?,?,?,1,?)'
  ).run(code,code,'fake-passhash','Менеджер MAX',phone,chat).lastInsertRowid);
}
function admin(phone,chat=null){
  const login='MAXA-'+(++next);
  return Number(db.prepare(
    'INSERT INTO admins(login,password_hash,full_name,phone,role,active,max_chat_id) VALUES (?,?,?,?,?,1,?)'
  ).run(login,'fake-passhash','Администратор MAX',phone,'super',chat).lastInsertRowid);
}
function point(id){
  db.prepare('INSERT INTO points(id,name,addr,icon) VALUES (?,?,?,?)')
    .run(id,'Точка MAX '+id,'ул. Тест, 1','🐾');
}

test('a signed MAX launch reveals NO roles before independently signed own contact',async()=>{
  const id=partner('8(913)555-01-01',{chat:'8877700'});
  const init_data=signedLaunch();
  let r=await api('/api/max/miniapp/accounts',{init_data});
  assert.equal(r.status,200);
  assert.equal(r.json.verified,false);
  assert.deepEqual(r.json.accounts,[]);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'partner'})).status,403);
  assert.equal((await api('/api/max/miniapp/verify-phone',{
    init_data,contact:{phone:'+79135550101',authDate:String(NOW),hash:'a'.repeat(64)},
  })).status,403);
  const contact=signedContact();
  assert.equal(verifyMaxBridgeContact(contact,{id:'812345'},BOT_TOKEN,NOW),'79135550101');
  r=await api('/api/max/miniapp/verify-phone',{init_data,contact});
  assert.equal(r.status,200,JSON.stringify(r.json));
  assert.equal(r.json.verified,true);
  assert.deepEqual(r.json.accounts.map(x=>x.role),['partner']);
  assert.ok(!JSON.stringify(r.json).includes('79135550101'));
  r=await api('/api/max/miniapp/session',{init_data,role:'partner'});
  assert.equal(r.status,200,JSON.stringify(r.json));
  const claims=verifyToken(r.json.token);
  assert.equal(claims.role,'partner');
  assert.equal(claims.id,id);
  assert.equal(r.json.account.adminRole,null);
  assert.equal(r.headers['Cache-Control'],'no-store');
});

test('all four existing roles use their own signed sessions; combined owner/groomer is presentation only',async()=>{
  const phone='79135550202',user=812346,chat='8877701',salon='max-role-salon';
  point(salon);
  const groomer=partner(phone,{chat,point:salon});
  const ownership=owner(phone,{chat,point:salon,partner:groomer});
  const mgr=manager(phone,chat);
  const adm=admin(phone,chat);
  const init_data=signedLaunch(user,chat);
  assert.equal((await api('/api/max/miniapp/verify-phone',{
    init_data,contact:signedContact(user,phone),
  })).status,200);
  const accounts=(await api('/api/max/miniapp/accounts',{init_data})).json;
  assert.deepEqual(accounts.accounts.map(x=>x.role),['partner','owner','manager','admin']);
  assert.equal(accounts.combined_salon,true);
  assert.equal(accounts.accounts.some(x=>x.role==='founder'),false);
  const ids={partner:groomer,owner:ownership,manager:mgr,admin:adm};
  for(const role of Object.keys(ids)){
    const response=await api('/api/max/miniapp/session',{init_data,role});
    assert.equal(response.status,200,JSON.stringify({role,json:response.json}));
    const claims=verifyToken(response.json.token);
    assert.equal(claims.id,ids[role]);
    assert.equal(claims.role,role);
    if(role==='admin'){
      assert.equal(claims.adminRole,'super');
      assert.ok(Object.hasOwn(claims,'miniappAuthVersion'));
    }else assert.equal(claims.adminRole,undefined);
  }
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'founder'})).status,400);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'salon'})).status,400);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'customer'})).status,400);
});

test('signature, phone, launch user and chat cannot be forged or replayed after expiry',async()=>{
  const init_data=signedLaunch();
  const validContact=signedContact();
  assert.equal(verifyMaxBridgeContact({...validContact,phone:'+79135550102'}, {id:'812345'},BOT_TOKEN,NOW),null);
  assert.equal(verifyMaxBridgeContact(validContact,{id:'812348'},BOT_TOKEN,NOW),null);
  assert.equal(verifyMaxBridgeContact(signedContact(812345,'+79135550101',NOW-800),{id:'812345'},BOT_TOKEN,NOW),null);
  assert.equal((await api('/api/max/miniapp/session',{init_data:init_data+'x',role:'partner'})).status,401);
  assert.equal((await api('/api/max/miniapp/session',{init_data:signedLaunch(812345,'8877700',NOW-3700),role:'partner'})).status,401);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'admin'})).status,403);
  assert.equal((await api('/api/max/miniapp/verify-phone',{init_data,contact:{...validContact,hash:'0'.repeat(64)}})).status,403);
});

test('duplicate, inactive, different linked MAX chat or changed phone never grant privileged sessions',async()=>{
  const user=812347,chat='9988111',phone='79135550303';
  const init_data=signedLaunch(user,chat);
  const first=partner(phone,{chat});
  partner(phone,{chat});
  assert.equal((await api('/api/max/miniapp/verify-phone',{init_data,contact:signedContact(user,phone)})).status,200);
  const discovery=(await api('/api/max/miniapp/accounts',{init_data})).json;
  assert.ok(discovery.ambiguous_roles.includes('partner'));
  assert.equal(discovery.accounts.some(x=>x.role==='partner'),false);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'partner'})).status,403);
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(first);
  // The second record is still active and recognized.
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'partner'})).status,200);
  db.prepare("UPDATE partners SET max_chat_id='another-chat' WHERE phone=? AND active=1").run(phone);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'partner'})).status,403);
  db.prepare("UPDATE partners SET phone='79135550304' WHERE phone=? AND active=1").run(phone);
  assert.equal((await api('/api/max/miniapp/session',{init_data,role:'partner'})).status,403);
});

test('MAX user switch cannot reuse earlier phone verification',async()=>{
  const foreign=signedLaunch(987999,'900099');
  const profiles=(await api('/api/max/miniapp/accounts',{init_data:foreign})).json;
  assert.equal(profiles.verified,false);
  assert.deepEqual(profiles.accounts,[]);
  assert.equal((await api('/api/max/miniapp/session',{init_data:foreign,role:'partner'})).status,403);
  assert.equal((await api('/api/max/miniapp/verify-phone',{
    init_data:foreign,contact:signedContact(),
  })).status,403);
});

test.after(()=>{
  try{db.close()}catch(_){}
  fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
});

test('MAX reward reports require active admin, same signed private chat and send only to requester',async()=>{
 const phone='79135550999',userId=829999,chat='8877999',salon='max-reward-test';
 point(salon);
 const pid=partner('79135550888',{chat:'8877888',point:salon});
 db.prepare("UPDATE partners SET full_name='Получатель отчёта',commission_rate=.15 WHERE id=?").run(pid);
 db.prepare(`INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate)
 VALUES('MAX-REPORT-ORDER','Клиент','79130000000','Точка',?,?,500,500,'sbp','paid',.15)`).run(salon,pid);
 const adm=admin(phone,chat),init_data=signedLaunch(userId,chat);
 const optionsPath='/api/max/miniapp/reward-reports/options',sendPath='/api/max/miniapp/reward-reports/send';
 const token=signToken({role:'admin',id:adm,adminRole:'super',miniappAuthVersion:0});
 assert.equal((await api(optionsPath,{init_data,kind:'unpaid'},token)).status,403);
 await api('/api/max/miniapp/verify-phone',{init_data,contact:signedContact(userId,phone)});
 assert.equal((await api(optionsPath,{init_data,kind:'unpaid'})).status,401);
 assert.equal((await api(optionsPath,{init_data,kind:'unpaid'},signToken({role:'partner',id:pid}))).status,401);
 assert.equal((await api(optionsPath,{init_data:signedLaunch(userId,'8877555'),kind:'unpaid'},token)).status,403);
 assert.equal((await api(optionsPath,{init_data:signedLaunch(987777,chat),kind:'unpaid'},token)).status,403);
 const other=admin('79135550998','8877998');
 assert.equal((await api(optionsPath,{init_data,kind:'unpaid'},signToken({role:'admin',id:other,adminRole:'super'}))).status,403);
 const list=await api(optionsPath,{init_data,kind:'unpaid'},token);
 assert.equal(list.status,200,JSON.stringify(list.json));
 const selected=list.json.recipients.find(p=>p.name==='Получатель отчёта');
 assert.ok(selected);assert.equal(selected.amount,75);
 assert.equal((await api(sendPath,{init_data,kind:'unpaid',key:selected.key,expected_total:76},token)).status,409);
 const before=db.prepare('SELECT COUNT(*) AS n FROM partner_payouts').get().n;
 const snapshots=db.prepare('SELECT COUNT(*) AS n FROM payout_reports').get().n;
 const sent=await api(sendPath,{init_data,kind:'unpaid',key:selected.key,expected_total:75,
   chat_id:'8877888',user_id:'12345678',target_user_id:'12345678'},token);
 assert.equal(sent.status,200,JSON.stringify(sent.json));
 assert.equal(sentReports.length,1);
 assert.equal(sentReports[0].userId,String(userId));
 assert.match(sentReports[0].caption,/К выплате: 75 ₽/);
 const periods=await api(optionsPath,{init_data,kind:'period'},token);
 assert.ok(periods.json.recipients.some(x=>x.role==='partner'&&x.id===pid));
 const date=db.prepare("SELECT substr(created_at,1,10) AS d FROM orders WHERE order_code='MAX-REPORT-ORDER'").get().d;
 const period=await api(sendPath,{init_data,kind:'period',role:'partner',recipient_id:pid,start:date,end:date},token);
 assert.equal(period.status,200,JSON.stringify(period.json));assert.equal(sentReports.length,2);
 assert.equal(sentReports[1].userId,String(userId));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_payouts').get().n,before);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payout_reports').get().n,snapshots);
 denyBeforeSend=true;
 const denied=await api(sendPath,{init_data,kind:'unpaid',key:selected.key,expected_total:75},token);
 assert.equal(denied.status,403);assert.equal(sentReports.length,2);
 assert.equal(renderCount,3);
 denyBeforeSend=false;
 assert.equal((await api(optionsPath,{init_data,kind:'unpaid'},token)).status,401);
});
