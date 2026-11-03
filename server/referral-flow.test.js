'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-referral-'));
const db=require('./db');
const {signToken}=require('./auth');
const {registerPartnerLeadRoutes}=require('./routes-partner-leads');
const {registerPartnerRoutes}=require('./routes-partners');
const {registerProductRoutes}=require('./routes-products');
const {referralSummary,storedReferral,AMOUNT}=require('./referral-program');
const {checkAndPayManagerBonus}=require('./bonus-logic');
const {getBonuses,createReferralBonusPayout}=require('./report-bonuses');
const routes=new Map(),router={};
for(const method of ['get','post','put','delete'])
  router[method]=(url,handler)=>routes.set(method.toUpperCase()+' '+url,handler);
registerPartnerLeadRoutes(router);
registerProductRoutes(router);
registerPartnerRoutes(router);
async function request(method,url,role,id,body={},query={},ip='referral-test'){
  const handler=routes.get(method+' '+url);
  assert.ok(handler,'route exists '+url);
  const res={status:0,body:null,
    writeHead(code){this.status=code;return this;},
    end(data){this.body=JSON.parse(data);},
  };
  const token=role?'Bearer '+signToken({role,id}):'';
  await handler({headers:{authorization:token,'x-forwarded-for':ip},socket:{remoteAddress:ip}},
    res,{body,query,params:{}});
  return res;
}
function groomer(code,pointId,phone){
  return Number(db.prepare(
    'INSERT INTO partners (partner_code,login,password_hash,full_name,phone,point_id,point_name,active) '+
    'VALUES (?,?,?,?,?,?,?,1)'
  ).run(code,code,'hash','Пригласивший '+code,phone,pointId,'Начальная точка').lastInsertRowid);
}
function owner(code,pointId,phone) {
  return Number(db.prepare(
    'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,owner_code,active) '+
    'VALUES (?,?,?,?,?,?,1)'
  ).run('owner-ref-test-'+code,'hash','Владелец '+code,phone,pointId,code).lastInsertRowid);
}
function oldPoint(id){
  db.prepare('INSERT INTO points(id,name,addr,icon,city_id) VALUES (?,?,?,?,?)')
    .run(id,id,'ул. Салонная, 1','🐾','krsk');
}
oldPoint('original-groomer-point');
oldPoint('original-owner-point');
const groomerId=groomer('GR-916','original-groomer-point','79131111111');
const ownerId=owner('OWN-917','original-owner-point','79132222222');
const managerId=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,city_id) VALUES (?,?,?,?,?,?)'
).run('MGR-REF-TEST','manager-ref-test','hash','Менеджер','79133333333','krsk').lastInsertRowid);
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES (?,?,?,?,?)')
  .run(901,'admin-ref-test','hash','admin',1);
function pointBody(name,leadId){
  return {name,addr:'ул. Новая, 20',icon:'🐾',city_id:'krsk',lat:56.012,lng:92.882,
    referral_lead_id:leadId};
}
function paidOrder(code,pointId,partnerId){
  db.prepare(
    "INSERT INTO orders (order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,"+
    "subtotal,total,payment_method,status,commission_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(code,'Покупатель','79135555555','Салон',pointId,partnerId,5000,5000,'sbp','paid',0.15);
}

test('new groomer invitation stores verified referrer and protects against self-referral',async()=>{
  assert.equal(AMOUNT,1000);
  const invalid=await request('POST','/api/partner-leads/public',null,null,{
    salon_name:'Питомец на Мира',contact_name:'Новый Грумер',phone:'79134444444',
    city_id:'krsk',referral_code:'GR-DOES-NOT-EXIST',
  });
  assert.equal(invalid.status,400);
  const self=await request('POST','/api/partner-leads/public',null,null,{
    salon_name:'Свой салон',contact_name:'Пригласивший',phone:'79131111111',
    city_id:'krsk',referral_code:'GR-916',
  });
  assert.equal(self.status,409);
  const first=await request('POST','/api/partner-leads/public',null,null,{
    salon_name:'Питомец на Мира',contact_name:'Новый Грумер',phone:'79134444444',
    city_id:'krsk',referral_code:'GR-916',category:'groomer',
  });
  assert.equal(first.status,201,JSON.stringify(first.body));
  const lead=db.prepare('SELECT * FROM partner_leads WHERE salon_name=?')
    .get('Питомец на Мира');
  assert.equal(lead.referred_by_role,'partner');
  assert.equal(lead.referred_by_id,groomerId);
  assert.equal(lead.referral_code,'GR-916');
  assert.equal(lead.linked_point_id,null);
  const duplicate=await request('POST','/api/partner-leads/public',null,null,{
    salon_name:'Питомец на Мира',phone:'79134444444',referral_code:'GR-916',
  });
  assert.equal(duplicate.status,409);
});

test('creating a new point from the invited lead records exactly one pending 1000 RUB bonus',async()=>{
  const lead=db.prepare('SELECT id FROM partner_leads WHERE referral_code=?').get('GR-916');
  const options=await request('GET','/api/partner-leads/referral-options','manager',managerId);
  assert.equal(options.status,200);
  assert.ok(options.body.leads.some(x=>x.id===lead.id));
  assert.ok(options.body.leads.every(x=>!('phone' in x)),'referral dropdown contains no private phone');
  const wrong=await request('POST','/api/points','manager',managerId,
    pointBody('Несовпадающий салон',lead.id));
  assert.equal(wrong.status,409);
  const created=await request('POST','/api/points','manager',managerId,
    pointBody('Питомец на Мира',lead.id));
  assert.equal(created.status,201,JSON.stringify(created.body));
  const ledger=storedReferral(created.body.id);
  assert.equal(ledger.role,'partner');
  assert.equal(ledger.recipient_id,groomerId);
  assert.equal(ledger.amount,1000);
  assert.equal(ledger.lead_id,lead.id);
  const linked=db.prepare('SELECT linked_point_id,status FROM partner_leads WHERE id=?').get(lead.id);
  assert.equal(linked.linked_point_id,created.body.id);
  assert.equal(linked.status,'signed');
  const ref=referralSummary('partner',groomerId);
  assert.equal(ref.count,1);
  assert.equal(ref.awaiting,1000);
  assert.equal(ref.payable,0);
  assert.equal(ref.paid,0);
  assert.equal(ref.rows[0].point_name,'Питомец на Мира');
  const reused=await request('POST','/api/points','manager',managerId,{
    ...pointBody('Питомец на Мира',lead.id),addr:'ул. Новая, 25'
  });
  assert.equal(reused.status,409);
  assert.equal(referralSummary('partner',groomerId).count,1);
});

test('first groomer automatically inherits locked inviter, but does not mint extra 1000 RUB',async()=>{
  const point=db.prepare('SELECT point_id FROM point_referrals WHERE role=? AND recipient_id=?')
    .get('partner',groomerId).point_id;
  const signup=await request('POST','/api/partners/register',null,null,{
    full_name:'Новый Грумер',phone:'79134444444',point_id:point,
    login:'new-invited-groomer',password:'sixcharacters',
  });
  assert.equal(signup.status,201,JSON.stringify(signup.body));
  const partner=db.prepare('SELECT * FROM partners WHERE id=?').get(signup.body.id);
  assert.equal(partner.referred_by_partner_id,groomerId);
  assert.equal(partner.referred_by_owner_id,null);
  assert.equal(referralSummary('partner',groomerId).count,1);
  paidOrder('REF-PAID-ONE',point,partner.id);
  await checkAndPayManagerBonus(point);
  const mp=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(point);
  assert.equal(mp.bonus_paid,1);
  assert.equal(mp.bonus_manager_amount,1000);
  assert.equal(mp.referred_groomer_id,groomerId);
  assert.equal(mp.referred_groomer_amount,1000);
  const summary=referralSummary('partner',groomerId);
  assert.equal(summary.awaiting,0);
  assert.equal(summary.payable,1000);
  assert.equal(summary.paid,0);
  await checkAndPayManagerBonus(point);
  assert.equal(getBonuses(db,'partner',groomerId).pending.length,1);
  const payout=createReferralBonusPayout(db,'partner',mp.id,groomerId,1000,
    {id:901,login:'admin-ref-test'});
  assert.equal(payout.payout.amount,1000);
  assert.equal(referralSummary('partner',groomerId).paid,1000);
  assert.equal(referralSummary('partner',groomerId).payable,0);
  assert.throws(()=>createReferralBonusPayout(db,'partner',mp.id,groomerId,1000,
    {id:901,login:'admin-ref-test'}),/уже зафиксирована/);
});

test('owner code also credits exactly one new point, never somebody else or again',async()=>{
  const lead=await request('POST','/api/partner-leads/public',null,null,{
    salon_name:'Новый Барс',contact_name:'Салон новый',phone:'79136666666',
    city_id:'krsk',referral_code:'OWN-917',
  },{},'owner-referral-test');
  assert.equal(lead.status,201);
  const leadId=db.prepare('SELECT id FROM partner_leads WHERE referral_code=?').get('OWN-917').id;
  const add=await request('POST','/api/points','admin',901,{
    ...pointBody('Новый Барс',leadId),manager_id:managerId,
  });
  assert.equal(add.status,201,JSON.stringify(add.body));
  const point=add.body.id;
  const summary=referralSummary('owner',ownerId);
  assert.equal(summary.count,1);
  assert.equal(summary.awaiting,1000);
  const wrongCode=await request('POST','/api/partners/register',null,null,{
    full_name:'Новый Барс',phone:'79136666666',point_id:point,
    login:'new-owner-salon-groomer',password:'sixcharacters',referral_code:'GR-916',
  });
  assert.equal(wrongCode.status,409);
  const correct=await request('POST','/api/partners/register',null,null,{
    full_name:'Новый Барс',phone:'79136666666',point_id:point,
    login:'new-owner-salon-groomer',password:'sixcharacters',
  });
  assert.equal(correct.status,201,JSON.stringify(correct.body));
  assert.equal(db.prepare('SELECT referred_by_owner_id FROM partners WHERE id=?')
    .get(correct.body.id).referred_by_owner_id,ownerId);
  paidOrder('REF-OWNER-PAID',point,correct.body.id);
  await checkAndPayManagerBonus(point);
  assert.equal(referralSummary('owner',ownerId).payable,1000);
  assert.equal(referralSummary('partner',groomerId).count,1);
  const mp=db.prepare('SELECT * FROM manager_points WHERE point_id=?').get(point);
  assert.equal(mp.referred_owner_id,ownerId);
  assert.equal(mp.referred_owner_amount,1000);
});
