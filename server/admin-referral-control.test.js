'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-ref-control-'));
const db=require('./db');
const {signToken}=require('./auth');
const {registerAdminReferralRoutes}=require('./routes-admin-referrals');
const {checkAndPayManagerBonus,REFERRAL_REVENUE_THRESHOLD}=require('./bonus-logic');
const {referralSummary,storedReferral}=require('./referral-program');
const {getBonuses,createReferralBonusPayout}=require('./report-bonuses');

const routes=new Map(),router={};
for(const method of ['get','post','put'])router[method]=(url,fn)=>routes.set(method.toUpperCase()+' '+url,fn);
registerAdminReferralRoutes(router);
async function request(method,route,role,id,params={},body={}){
  const fn=routes.get(method+' '+route);
  assert.ok(fn,'route exists: '+method+' '+route);
  const token=role?signToken({role,id,login:'referral-test-admin'}):'';
  const response={status:0,body:null,headers:{},
    setHeader(key,value){this.headers[key]=value},
    writeHead(code){this.status=code;return this},
    end(raw){this.body=JSON.parse(raw)},
  };
  await fn({headers:{authorization:token?'Bearer '+token:''}},response,
    {params,body,query:{}});
  return response;
}
function admin(){
  return Number(db.prepare(
    "INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,?,1)"
  ).run('referral-admin','hash','admin').lastInsertRowid);
}
function manager(){
  return Number(db.prepare(
    "INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)"
  ).run('MGR-REF-CHECK','ref-check','hash','Менеджер','79131115555').lastInsertRowid);
}
function point(id,managerId){
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id,active,is_hub) VALUES(?,?,?,?,?,1,0)')
    .run(id,'Салон '+id,'Красноярск, ул. Тестовая, 10','🐾',managerId||null);
  if(managerId)db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type) VALUES(?,?,?,?)')
    .run(managerId,id,'Салон '+id,'Груминг');
}
function partner(code,pointId,phone){
  return Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,active) VALUES(?,?,?,?,?,?,?,1)'
  ).run(code,code,'hash','Грумер '+code,phone,pointId,'Салон '+pointId).lastInsertRowid);
}
function order(id,pointId,total,status='paid',refunded=0){
  db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status,refund_status,refunded_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,'Покупатель','79137770001','Салон',pointId,total,total,'sbp',status,
      refunded>0?'partially_refunded':'none',refunded);
}
const adminId=admin(), managerId=manager();
point('original-ref-point',managerId);
point('new-ref-point',managerId);
point('backfill-ref-point',managerId);
point('no-manager-ref-point',null);
const inviter=partner('GR-INV-101','original-ref-point','79131110001');
const another=partner('GR-INV-102','original-ref-point','79131110002');
const invited=partner('GR-INV-103','new-ref-point','79131110003');
const invitedBackfill=partner('GR-INV-104','backfill-ref-point','79131110004');
const adm={role:'admin',id:adminId};

test('admin referral control is private, read-only and shows all new points',async()=>{
  const unauthorized=await request('GET','/api/admin/referral-control','partner',inviter);
  assert.equal(unauthorized.status,401);
  const view=await request('GET','/api/admin/referral-control','admin',adminId);
  assert.equal(view.status,200);
  assert.equal(view.headers['Cache-Control'],'no-store');
  const row=view.body.points.find(x=>x.point_id==='new-ref-point');
  assert.equal(row.status,'unassigned');
  assert.equal(row.revenue,0);
  assert.equal(REFERRAL_REVENUE_THRESHOLD,1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM point_referral_assignment_log').get().c,0);
});

test('admin may attach inviter and invited groomer once before first sale',async()=>{
  const path='/api/admin/referral-control/points/:id';
  const data={inviter_partner_id:inviter,invited_partner_id:invited};
  assert.equal((await request('PUT',path,'partner',inviter,{id:'new-ref-point'},data)).status,401);
  assert.equal((await request('PUT',path,'admin',adminId,{id:'new-ref-point'},{...data,inviter_partner_id:invited})).status,409);
  assert.equal((await request('PUT',path,'admin',adminId,{id:'no-manager-ref-point'},data)).status,409);
  const linked=await request('PUT',path,'admin',adminId,{id:'new-ref-point'},data);
  assert.equal(linked.status,200,linked.body?.error);
  assert.equal(linked.body.point.status,'awaiting');
  assert.equal(storedReferral('new-ref-point').recipient_id,inviter);
  assert.equal(storedReferral('new-ref-point').invited_partner_id,invited);
  assert.equal(db.prepare('SELECT referred_by_partner_id FROM partners WHERE id=?').get(invited).referred_by_partner_id,inviter);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM point_referral_assignment_log').get().c,1);
  const repeat=await request('PUT',path,'admin',adminId,{id:'new-ref-point'},data);
  assert.equal(repeat.status,200,repeat.body?.error);
  assert.equal(repeat.body.changed,false);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM point_referral_assignment_log').get().c,1);
  assert.equal((await request('PUT',path,'admin',adminId,{id:'new-ref-point'},{...data,inviter_partner_id:another})).status,409);
});

test('999 RUB does not accrue, 1000 RUB nets exactly one bonus, manager remains independent',async()=>{
  order('REF-999','new-ref-point',999);
  await checkAndPayManagerBonus('new-ref-point');
  let row=(await request('GET','/api/admin/referral-control','admin',adminId)).body.points.find(x=>x.point_id==='new-ref-point');
  assert.equal(row.status,'awaiting');
  assert.equal(row.revenue,999);
  assert.equal(referralSummary('partner',inviter).awaiting,1000);
  order('REF-PLUS-1','new-ref-point',1);
  await checkAndPayManagerBonus('new-ref-point');
  await checkAndPayManagerBonus('new-ref-point');
  row=(await request('GET','/api/admin/referral-control','admin',adminId)).body.points.find(x=>x.point_id==='new-ref-point');
  assert.equal(row.status,'payable');
  assert.equal(row.revenue,1000);
  assert.equal(row.accrued,true);
  assert.equal(row.manager_assigned,true);
  assert.equal(row.amount,1000);
  assert.equal(referralSummary('partner',inviter).payable,1000);
  assert.equal(getBonuses(db,'partner',inviter).pending.length,1);
  assert.equal(db.prepare('SELECT bonus_paid FROM manager_points WHERE point_id=?').get('new-ref-point').bonus_paid,0);
  const summary=(await request('GET','/api/admin/referral-control','admin',adminId)).body;
  assert.equal(summary.bonus_by_partner[inviter],1000);
  assert.equal(summary.counts.payable_amount,1000);
});

test('refunds suspend payout until revenue recovers, and prevent a second payment',async()=>{
  db.prepare("UPDATE orders SET refunded_amount=2,refund_status='partially_refunded' WHERE order_code=?").run('REF-999');
  let view=(await request('GET','/api/admin/referral-control','admin',adminId)).body;
  assert.equal(view.points.find(x=>x.point_id==='new-ref-point').status,'on_hold');
  assert.equal(view.bonus_by_partner[inviter]||0,0);
  const mp=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get('new-ref-point');
  assert.throws(()=>createReferralBonusPayout(db,'partner',mp.id,inviter,1000,adm),/ниже 1 000/);
  order('REF-RECOVER','new-ref-point',2);
  await checkAndPayManagerBonus('new-ref-point');
  assert.equal((await request('GET','/api/admin/referral-control','admin',adminId)).body.points.find(x=>x.point_id==='new-ref-point').status,'payable');
  const payout=createReferralBonusPayout(db,'partner',mp.id,inviter,1000,adm);
  assert.equal(payout.payout.amount,1000);
  assert.equal((await request('GET','/api/admin/referral-control','admin',adminId)).body.points.find(x=>x.point_id==='new-ref-point').status,'paid');
  assert.throws(()=>createReferralBonusPayout(db,'partner',mp.id,inviter,1000,adm),/уже зафиксирована/);
});

test('historical sales require explicit consent; accrued backfill is idempotent',async()=>{
  order('REF-BACKFILL','backfill-ref-point',1000);
  const path='/api/admin/referral-control/points/:id';
  const body={inviter_partner_id:another,invited_partner_id:invitedBackfill};
  const no=await request('PUT',path,'admin',adminId,{id:'backfill-ref-point'},body);
  assert.equal(no.status,409);
  assert.equal(no.body.code,'CONFIRM_HISTORICAL_SALES');
  assert.equal(storedReferral('backfill-ref-point'),null);
  const yes=await request('PUT',path,'admin',adminId,{id:'backfill-ref-point'},{
    ...body,confirm_historical_sales:true});
  assert.equal(yes.status,200,yes.body?.error);
  assert.equal(yes.body.point.status,'payable');
  assert.equal(referralSummary('partner',another).payable,1000);
  const repeat=await request('POST','/api/admin/referral-control/points/:id/reconcile',
    'admin',adminId,{id:'backfill-ref-point'});
  assert.equal(repeat.status,200);
  assert.equal(getBonuses(db,'partner',another).pending.length,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM point_referral_assignment_log WHERE point_id=?').get('backfill-ref-point').c,1);
});


test('late attribution reduces unpaid manager bonus from 2000 to 1000 exactly once',async()=>{
  const pointId='late-invitation-unpaid';
  point(pointId,managerId);
  const newGroomer=partner('GR-INV-105',pointId,'79131110005');
  order('REF-LATE-2000',pointId,2000);
  await checkAndPayManagerBonus(pointId);
  const managerPoint=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(pointId);
  assert.equal(managerPoint.bonus_manager_amount,2000);
  const response=await request('PUT','/api/admin/referral-control/points/:id',
    'admin',adminId,{id:pointId},{
      inviter_partner_id:another,invited_partner_id:newGroomer,confirm_historical_sales:true
    });
  assert.equal(response.status,200,response.body?.error);
  assert.equal(db.prepare('SELECT bonus_manager_amount FROM manager_points WHERE id=?')
    .get(managerPoint.id).bonus_manager_amount,1000);
  const {getLaunchBonusSummary}=require('./manager-payouts');
  assert.equal(getLaunchBonusSummary(managerPoint.id).amount,1000,'payout uses the reduced amount');
  assert.equal(getBonuses(db,'manager',managerId).pending.find(b=>b.point_id===pointId).amount,1000);
  assert.equal(getBonuses(db,'partner',another).pending.find(b=>b.point_id===pointId).amount,1000);
  await checkAndPayManagerBonus(pointId);
  assert.equal(getLaunchBonusSummary(managerPoint.id).amount,1000,'recalculation is idempotent');
  const transfer=require('./manager-payouts').createManagerLaunchBonusPayout(managerPoint.id,adm);
  assert.equal(transfer.amount,1000,'actual manager launch payout uses the new split amount');
  assert.equal(db.prepare('SELECT amount FROM manager_launch_bonus_payouts WHERE manager_point_id=?')
    .get(managerPoint.id).amount,1000);
  assert.equal(getBonuses(db,'manager',managerId).pending.some(b=>b.point_id===pointId),false);

});

test('referral attachment is blocked after the 2000 RUB manager launch bonus was paid',async()=>{
  const pointId='late-invitation-paid';
  point(pointId,managerId);
  const newGroomer=partner('GR-INV-106',pointId,'79131110006');
  order('REF-PAID-2000',pointId,2000);
  await checkAndPayManagerBonus(pointId);
  const mgrPoint=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(pointId);
  assert.equal(mgrPoint.bonus_manager_amount,2000);
  const {createManagerLaunchBonusPayout}=require('./manager-payouts');
  const transfer=createManagerLaunchBonusPayout(mgrPoint.id,adm);
  assert.equal(transfer.amount,2000);
  const response=await request('PUT','/api/admin/referral-control/points/:id',
    'admin',adminId,{id:pointId},{
      inviter_partner_id:another,invited_partner_id:newGroomer,confirm_historical_sales:true
    });
  assert.equal(response.status,409);
  assert.match(response.body.error,/уже выплачена/);
  assert.equal(storedReferral(pointId),null,'failed assignment never persists');
  await checkAndPayManagerBonus(pointId);
  assert.equal(db.prepare('SELECT bonus_manager_amount FROM manager_points WHERE id=?')
    .get(mgrPoint.id).bonus_manager_amount,2000);
  assert.equal(db.prepare('SELECT amount FROM manager_launch_bonus_payouts WHERE manager_point_id=?')
    .get(mgrPoint.id).amount,2000);
});

test('owner recommendation can be assigned retrospectively, with role-aware audit and same net threshold',async()=>{
 const ownerId=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,owner_code,active) VALUES(?,?,?,?,?,?,1)')
  .run('owner-ref-control','hash','Владелец рекомендатель','79131110007','original-ref-point','OWN-REF-CTL').lastInsertRowid);
 const pointId='owner-invited-point';point(pointId,managerId);
 const groomerId=partner('GR-INV-OWNER',pointId,'79131110008');
 const route='/api/admin/referral-control/points/:id',body={inviter_role:'owner',inviter_id:ownerId,invited_partner_id:groomerId};
 order('OWNER-REF-PARTIAL',pointId,1500,'paid',501);
 db.prepare("UPDATE orders SET refund_status='refunded' WHERE order_code='OWNER-REF-PARTIAL'").run();
 assert.equal((await request('PUT',route,'admin',adminId,{id:pointId},body)).body.code,'CONFIRM_HISTORICAL_SALES');
 const linked=await request('PUT',route,'admin',adminId,{id:pointId},{...body,confirm_historical_sales:true});
 assert.equal(linked.status,200,linked.body?.error);
 assert.equal(linked.body.point.status,'awaiting');
 assert.equal(linked.body.point.revenue,999);
 assert.equal(linked.body.point.inviter_owner_id,ownerId);
 assert.equal(storedReferral(pointId).role,'owner');
 assert.equal(db.prepare('SELECT referred_by_owner_id FROM partners WHERE id=?').get(groomerId).referred_by_owner_id,ownerId);
 const audit=db.prepare('SELECT * FROM point_referral_assignment_log WHERE point_id=?').get(pointId);
 assert.equal(audit.inviter_role,'owner');assert.equal(audit.inviter_owner_id,ownerId);assert.equal(audit.inviter_partner_id,null);
 assert.equal((await request('PUT',route,'admin',adminId,{id:pointId},{inviter_partner_id:inviter})).status,409);
 order('OWNER-REF-LAST',pointId,1);
 await checkAndPayManagerBonus(pointId);
 const mp=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(pointId);
 assert.equal(mp.referred_owner_id,ownerId);assert.equal(mp.bonus_paid,0);
 assert.equal(referralSummary('owner',ownerId).payable,1000);
 assert.equal(getBonuses(db,'owner',ownerId).pending.length,1);
 db.prepare("UPDATE orders SET refunded_amount=502 WHERE order_code='OWNER-REF-PARTIAL'").run();
 assert.equal(referralSummary('owner',ownerId).held,1000);
 assert.equal(getBonuses(db,'owner',ownerId).pending.length,0);
 assert.throws(()=>createReferralBonusPayout(db,'owner',mp.id,ownerId,1000,adm),/ниже 1 000/);
 order('OWNER-REF-RECOVER',pointId,1);
 const paid=createReferralBonusPayout(db,'owner',mp.id,ownerId,1000,adm);
 assert.equal(paid.payout.amount,1000);
 await checkAndPayManagerBonus(pointId);
 assert.equal(referralSummary('owner',ownerId).paid,1000);
 assert.equal(getBonuses(db,'owner',ownerId).pending.length,0);
 assert.equal((await request('PUT',route,'admin',adminId,{id:pointId},body)).body.changed,false);
 const legacy='legacy-owner-invited-point';point(legacy,managerId);
 db.prepare("INSERT INTO point_referrals(point_id,point_name,role,recipient_id,amount,source) VALUES(?,?,'owner',?,1000,'legacy')").run(legacy,'Legacy salon',ownerId);
 order('LEGACY-OWNER-REF',legacy,1000);
 const {backfillOwnerReferrals}=require('./referral-policy');
 assert.equal(backfillOwnerReferrals(db),1);
 assert.equal(backfillOwnerReferrals(db),0);
 assert.equal(referralSummary('owner',ownerId).payable,1000);
});
test('admin UI exposes all three recommender types and correct payout role',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
 const js=fs.readFileSync(path.join(__dirname,'../public/admin-referral-control.js'),'utf8');
 assert.match(html,/id="referral-inviter-role"/);
 assert.match(html,/<option value="owner">Владелец салона/);
 assert.match(html,/<option value="referrer">Рекомендатель без стойки/);
 assert.match(html,/id="referral-historical-confirm"/);
 assert.match(js,/data-ref-report-role/);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../public/taiga-owner.html'),'utf8'),/2 000 ₽ прямой прибыли/);
});
