'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-referrer-'));
process.env.DATA_DIR=directory;
const db=require('./db');
const {signToken,verifyToken,hashPassword}=require('./auth');
const {registerAuthRoutes}=require('./routes-auth');
const {recordVerifiedTelegramContact,issueTelegramAccountSession}=require('./miniapp-phone-identity');
const {registerPartnerRoutes}=require('./routes-partners');
const {registerAdminReferralRoutes}=require('./routes-admin-referrals');
const {referralFromCode,storedReferral,referralSummary}=require('./referral-program');
const {checkAndPayManagerBonus}=require('./bonus-logic');
const {getBonuses,createReferralBonusPayout}=require('./report-bonuses');
const {getTierProgress,checkAndUpgradePartnerTier}=require('./partner-tiers');

const handlers=new Map(),router={};
for(const method of ['get','post','put','delete','patch']){
  router[method]=(name,fn)=>handlers.set(method.toUpperCase()+' '+name,fn);
}
registerPartnerRoutes(router);
registerAdminReferralRoutes(router);
registerAuthRoutes(router);
async function request(method,route,actor=null,body={},params={},query={}){
  const fn=handlers.get(method+' '+route);
  assert.ok(fn,'endpoint exists '+method+' '+route);
  const res={status:0,body:null,headers:{},
    setHeader(name,value){this.headers[name]=value},
    writeHead(status){this.status=status;return this},
    end(raw){this.body=JSON.parse(raw)},
  };
  const token=actor?signToken(actor):'';
  await fn({headers:{authorization:token?'Bearer '+token:''}},res,{body,params,query});
  return res;
}
const adminId=Number(db.prepare(
  'INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,?,1)'
).run('referrer-admin','hash','admin').lastInsertRowid);
const mgrId=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)'
).run('MGR-REFERRER-TEST','referrer-mgr','hash','Тест Менеджер','79131112222').lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon,manager_id,active,is_hub) VALUES(?,?,?,?,?,1,0)')
  .run('referrer-target','Приглашённый салон','Красноярск, ул. Тестовая, 1','🐾',mgrId);
db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES(?,?,?,?)')
  .run(mgrId,'referrer-target','Приглашённый салон','Груминг');
const admin={id:adminId,role:'admin',login:'referrer-admin'};
const owner={id:55,role:'owner',login:'test-owner'};
const base={full_name:'Иван Рекомендатель',phone:'+7 (913) 222-22-22',
  personal_data_consent:true,payout_method:'sbp'};
let refId=null,code=null;

test('only active admin creates a referral partner without any point or sales entitlement',async()=>{
  const url='/api/admin/referral-partners';
  assert.equal((await request('POST',url,null,base)).status,401);
  assert.equal((await request('POST',url,owner,base)).status,401);
  assert.equal((await request('POST',url,admin,{...base,personal_data_consent:false})).status,400);
  assert.equal((await request('POST',url,admin,{...base,point_id:'referrer-target'})).status,400);
  const res=await request('POST',url,admin,base);
  assert.equal(res.status,201,JSON.stringify(res.body));
  refId=Number(res.body.id);
  code=res.body.partner_code;
  assert.match(code,/^GR-\d+$/);
  assert.match(res.body.referral_url,/partner-invite\.html\?ref=GR-/);
  const p=db.prepare('SELECT * FROM partners WHERE id=?').get(refId);
  assert.equal(p.partner_type,'referrer');
  assert.equal(p.point_id,null);
  assert.equal(p.commission_rate,0);
  assert.equal(p.display_stand,0);
  assert.equal(p.display_poster,0);
  assert.equal(p.display_basket,0);
  assert.equal(p.first_purchase_promo_code,null);
  assert.equal(p.payout_method,'sbp');
  assert.equal(p.phone,'79132222222','canonical mobile phone supports Telegram and MAX');
  assert.equal(p.phone_last10,'9132222222');
  assert.match(p.login,/^referrer-[a-f0-9]{32}$/,'technical unique login is not issued');
  assert.notEqual(p.password_hash,null);
  assert.notEqual(p.password_hash,'','a random unusable hash satisfies legacy SQLite NOT NULL');
  assert.equal(res.body.login,undefined,'admin create response never exposes internal login');
  assert.equal(res.body.password,undefined,'admin create response never issues passwords');
  const who=referralFromCode(code);
  assert.equal(who.role,'partner');
  assert.equal(who.recipient_id,refId);
  assert.equal(who.point_id,null);
  assert.equal((await request('POST',url,admin,base)).status,409,'duplicate phone');
  assert.equal((await request('POST',url,admin,{...base,login:'other-login',password:'ignored'})).status,409,'no duplicate phone with user credentials');
  assert.equal((await request('POST',url,admin,{...base,phone:'+7 (800) 000-00-00'})).status,400,'mobile number required');
  const me=await request('GET','/api/partners/me',{id:refId,role:'partner'});
  assert.equal(me.body.partner.referrals.count,0);
  assert.equal(me.body.partner.login,null,'partner never sees technical login');
});

test('referral-only partner cannot acquire a point, equipment or sales tariff',async()=>{
  const partner={id:refId,role:'partner'};
  assert.equal((await request('PUT','/api/partners/me',partner,{display_stand:true})).status,409);
  assert.equal((await request('PUT','/api/partners/:id',admin,{point_id:'referrer-target'},{id:refId})).status,409);
  assert.equal((await request('PUT','/api/partners/:id',admin,{commission_rate:0.15},{id:refId})).status,409);
  const tier=getTierProgress(refId);
  assert.equal(tier.partner_type,'referrer');
  assert.equal(tier.currentRate,0);
  assert.equal(await checkAndUpgradePartnerTier(refId),null);
  assert.equal(db.prepare('SELECT commission_rate FROM partners WHERE id=?').get(refId).commission_rate,0);
  const payout=await request('PUT','/api/partners/me/payout-method',partner,{payout_method:'bank_account'});
  assert.equal(payout.status,200);
});

test('referrer cannot obtain a password session, including admin password reset',async()=>{
  const p=db.prepare('SELECT login,password_hash FROM partners WHERE id=?').get(refId);
  // Even a formerly issued/known password cannot open a referrer after update.
  db.prepare('UPDATE partners SET password_hash=? WHERE id=?')
    .run(hashPassword('securepassword'),refId);
  try {
    const credentials=await request('POST','/api/auth/login',null,
      {role:'partner',login:p.login,password:'securepassword'});
    assert.equal(credentials.status,401);
    assert.match(credentials.body.error,/Telegram/);
  } finally {
    db.prepare('UPDATE partners SET password_hash=? WHERE id=?').run(p.password_hash,refId);
  }
  const reset=await request('POST','/api/partners/:id/reset-password',admin,{},{id:refId});
  assert.equal(reset.status,409);
});

test('Telegram miniapp verifies the referrer owns the registered phone',()=>{
  const telegramId=928371122;
  const now=Math.floor(Date.now()/1000);
  const bad=recordVerifiedTelegramContact({
    chat:{type:'private',id:telegramId},
    from:{id:telegramId},
    contact:{user_id:telegramId+1,phone_number:base.phone}
  },now);
  assert.equal(bad.verified,false);
  assert.equal(issueTelegramAccountSession(telegramId,'partner',now),null);
  const verified=recordVerifiedTelegramContact({
    chat:{type:'private',id:telegramId},
    from:{id:telegramId},
    contact:{user_id:telegramId,phone_number:base.phone}
  },now);
  assert.equal(verified.verified,true);
  const session=issueTelegramAccountSession(telegramId,'partner',now);
  assert.ok(session?.token);
  assert.equal(verifyToken(session.token).role,'partner');
  assert.equal(Number(verifyToken(session.token).id),refId);
  assert.equal(session.account.login,null,'Telegram Mini App does not show the internal login');
  assert.equal(verifyToken(session.token).login,undefined,'referrer JWT needs role and ID only');
  const saved=db.prepare('SELECT telegram_chat_id FROM partners WHERE id=?').get(refId);
  assert.equal(saved.telegram_chat_id,String(telegramId));
  const otherId=telegramId+2;
  recordVerifiedTelegramContact({
    chat:{type:'private',id:otherId},from:{id:otherId},
    contact:{user_id:otherId,phone_number:base.phone}
  },now);
  assert.equal(issueTelegramAccountSession(otherId,'partner',now),null,
    'another Telegram account must not hijack a linked partner');
});

test('legacy website Telegram deep link cannot sign in a passwordless referrer',async()=>{
  const old=process.env.TG_TOKEN;
  process.env.TG_TOKEN='123456:test';
  try{
    const start=await request('POST','/api/partners/telegram/start',null,{phone:base.phone});
    assert.equal(start.status,409);
    assert.match(start.body.error,/мини-приложении/);
    const token='legacy-referrer-token-'+refId;
    db.prepare("INSERT INTO telegram_login_tokens(token,phone,role,code,chat_id,verified,expires_at) VALUES (?,?,'partner','5678','190087001',1,datetime('now','+10 minutes'))")
      .run(token,'79132222222');
    const checked=await request('GET','/api/partners/telegram/check',null,{}, {},{token});
    assert.equal(checked.status,409);
    const code=await request('POST','/api/partners/telegram/verify-code',null,
      {phone:base.phone,code:'5678'});
    assert.equal(code.status,409);
    assert.equal(db.prepare('SELECT telegram_chat_id FROM partners WHERE id=?').get(refId).telegram_chat_id,
      '928371122','old link must not rebind a verified referrer');
  }finally{
    if(old===undefined)delete process.env.TG_TOKEN;else process.env.TG_TOKEN=old;
  }
});

test('MAX confirmed contact grants a one-time passwordless referral session',async()=>{
  const token='f'.repeat(64);
  db.prepare("INSERT INTO max_login_tokens(token,phone,role,account_id,chat_id,verified,expires_at) VALUES (?,?,'partner_login',?, ?,1,datetime('now','+10 minutes'))")
    .run(token,'79132222222',refId,'max-referrer-123');
  const result=await request('POST','/api/partners/max/check',null,{token});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.verified,true);
  assert.equal(Number(verifyToken(result.body.token).id),refId);
  assert.equal(verifyToken(result.body.token).role,'partner');
  assert.equal(result.body.user.partner_type,'referrer');
  assert.equal(result.body.user.login,null,'MAX does not reveal the internal login');
  assert.equal(verifyToken(result.body.token).login,undefined);
  assert.equal(db.prepare('SELECT max_chat_id FROM partners WHERE id=?').get(refId).max_chat_id,'max-referrer-123');
  const used=await request('POST','/api/partners/max/check',null,{token});
  assert.equal(used.status,404,'MAX token cannot be redeemed twice');
});

test('referrer uses existing point attribution, threshold, ledger and one-time payment',async()=>{
  const url='/api/admin/referral-control/points/:id';
  const linked=await request('PUT',url,admin,{inviter_partner_id:refId},{id:'referrer-target'});
  assert.equal(linked.status,200,linked.body?.error);
  assert.equal(storedReferral('referrer-target').recipient_id,refId);
  assert.equal(storedReferral('referrer-target').role,'partner');
  assert.equal((await request('PUT',url,admin,{inviter_partner_id:refId},{id:'referrer-target'})).body.changed,false);
  const pointId='referrer-target';
  function paid(code,total){db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(code,'Клиент','79132220000','Салон',pointId,total,total,'sbp','paid');}
  paid('REFERRER-999',999);
  await checkAndPayManagerBonus(pointId);
  assert.equal(referralSummary('partner',refId).awaiting,1000);
  paid('REFERRER-1',1);
  await checkAndPayManagerBonus(pointId);
  await checkAndPayManagerBonus(pointId);
  const rec=referralSummary('partner',refId);
  assert.equal(rec.payable,1000);
  assert.equal(getBonuses(db,'partner',refId).pending.length,1);
  const mp=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(pointId);
  assert.equal(mp.referred_groomer_id,refId);
  const payout=createReferralBonusPayout(db,'partner',mp.id,refId,1000,admin);
  assert.equal(payout.payout.amount,1000);
  assert.equal(referralSummary('partner',refId).paid,1000);
  assert.throws(()=>createReferralBonusPayout(db,'partner',mp.id,refId,1000,admin),/уже зафиксирована/);
  assert.equal((await request('DELETE','/api/partners/:id',admin,{}, {id:refId})).status,409,
    'attribution history cannot be deleted or wiped');
});

test('both registration interfaces and private dashboards expose referral-only mode',()=>{
  const adminPage=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
  const miniapp=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
  const partnerPage=fs.readFileSync(path.join(__dirname,'../public/taiga-groomer.html'),'utf8');
  const referralControl=fs.readFileSync(path.join(__dirname,'../public/admin-referral-control.js'),'utf8');
  const loyalty=fs.readFileSync(path.join(__dirname,'routes-customers.js'),'utf8');
  assert.match(adminPage,/referral-new-partner-form/);
  assert.doesNotMatch(adminPage,/id="referral-new-login"/);
  assert.doesNotMatch(adminPage,/id="referral-new-password"/);
  assert.match(adminPage,/Логин и пароль не нужны/);
  assert.match(referralControl,/api\/admin\/referral-partners/);
  assert.match(miniapp,/admin-reg-referrer/);
  assert.match(miniapp,/kind==='referrer'\?'':String\(get\('workAdminPersonLogin'\)/);
  assert.match(referralControl,/Рекомендатель создан без логина и пароля/);
  assert.match(miniapp,/partner_type==='referrer'/);
  assert.match(partnerPage,/renderReferralOnlyPage/);
  assert.match(loyalty,/partner_type=\\'groomer\\'/);
});
test.after(()=>{try{db.close()}catch(_){}fs.rmSync(directory,{recursive:true,force:true})});
