'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-payout-preference-'));
const db = require('./db');
const { signToken } = require('./auth');
const { registerPartnerRoutes } = require('./routes-partners');
const { registerOwnerRoutes } = require('./routes-owners');
const { normalizeProfile, ProfileCorrectionError } = require('./profile-corrections');

const routes = new Map(), router = {};
for (const verb of ['get','post','put','delete']) {
  router[verb] = (url,handler) => routes.set(verb.toUpperCase()+' '+url,handler);
}
registerPartnerRoutes(router);
registerOwnerRoutes(router);
async function invoke(verb,url,actor,body={}) {
  const handler=routes.get(verb+' '+url);
  assert.ok(handler,'missing '+verb+' '+url);
  const response={
    status:0,body:null,
    writeHead(code){this.status=code},
    end(raw){this.body=JSON.parse(raw)},
  };
  const token=actor?signToken(actor):'';
  await handler({headers:{authorization:token?'Bearer '+token:''}},response,
    {params:{},query:{},body});
  return response;
}

test('registration saves payout methods, role-scoped profiles edit them safely',async()=>{
  const managerId=Number(db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name,phone,active) VALUES(?,?,?,?,?,1)')
    .run('MGR-PAYOUT','mgr-payout','hash','Менеджер','79130000000').lastInsertRowid);
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id,active,is_hub) VALUES(?,?,?,?,?,1,0)')
    .run('payout-test-salon','Салон тест','Красноярск, ул. Тестовая, 1','🐾',managerId);
  const manager={role:'manager',id:managerId,login:'mgr-payout'};
  const newPartner=await invoke('POST','/api/managers/me/register-groomer',manager,{
    full_name:'Новый Грумер',phone:'+7 913 100 11 22',point_id:'payout-test-salon',
    login:'payout-groomer',password:'long-secret',personal_data_consent:true,
    payout_method:'sbp',
  });
  assert.equal(newPartner.status,201,newPartner.body?.error);
  const partner=db.prepare('SELECT * FROM partners WHERE login=?').get('payout-groomer');
  assert.equal(partner.payout_method,'sbp');
  const newOwner=await invoke('POST','/api/salon-owners',manager,{
    full_name:'Владелец салона',phone:'+7 913 200 11 22',point_id:'payout-test-salon',
    login:'payout-owner',password:'long-secret',payout_method:'bank_account',
  });
  assert.equal(newOwner.status,201,newOwner.body?.error);
  const owner=db.prepare('SELECT * FROM salon_owners WHERE login=?').get('payout-owner');
  assert.equal(owner.payout_method,'bank_account');
  const partnerActor={role:'partner',id:partner.id,login:partner.login};
  const ownerActor={role:'owner',id:owner.id,login:owner.login};
  assert.equal((await invoke('PUT','/api/partners/me/payout-method',ownerActor,{payout_method:'cash'})).status,401);
  assert.equal((await invoke('PUT','/api/owner/me/payout-method',partnerActor,{payout_method:'cash'})).status,401);
  assert.equal((await invoke('PUT','/api/partners/me/payout-method',partnerActor,{payout_method:'crypto'})).status,400);
  assert.equal((await invoke('PUT','/api/owner/me/payout-method',ownerActor,{payout_method:''})).status,400);
  assert.equal((await invoke('PUT','/api/partners/me/payout-method',partnerActor,{payout_method:'card'})).status,200);
  assert.equal((await invoke('PUT','/api/owner/me/payout-method',ownerActor,{payout_method:'cash'})).status,200);
  assert.equal((await invoke('GET','/api/partners/me',partnerActor)).body.partner.payout_method,'card');
  assert.equal((await invoke('GET','/api/owner/me',ownerActor)).body.owner.payout_method,'cash');
  assert.equal(db.prepare('SELECT payout_method FROM partners WHERE id=?').get(partner.id).payout_method,'card');
  assert.equal(db.prepare('SELECT payout_method FROM salon_owners WHERE id=?').get(owner.id).payout_method,'cash');
  assert.throws(()=>normalizeProfile(partner,{payout_method:'unknown'}),ProfileCorrectionError);
  assert.equal(normalizeProfile(partner,{payout_method:'sbp'}).values.payout_method,'sbp');
  assert.equal((await invoke('PUT','/api/partners/me/payout-method',partnerActor,{payout_method:'mobile_balance'})).status,200);
  assert.equal((await invoke('PUT','/api/owner/me/payout-method',ownerActor,{payout_method:'mobile_balance'})).status,200);
  assert.equal((await invoke('GET','/api/partners/me',partnerActor)).body.partner.payout_method,'mobile_balance');
  assert.equal((await invoke('GET','/api/owner/me',ownerActor)).body.owner.payout_method,'mobile_balance');
  assert.equal(normalizeProfile(partner,{payout_method:'mobile_balance'}).values.payout_method,'mobile_balance');
  assert.equal(db.prepare('SELECT commission_rate FROM partners WHERE id=?').get(partner.id).commission_rate,partner.commission_rate);
});

test('legacy owner can select a payout method later',async()=>{
  const ownerId=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,phone) VALUES(?,?,?,?)')
    .run('legacy-owner','hash','Старый владелец','79130000078').lastInsertRowid);
  assert.equal(db.prepare('SELECT payout_method FROM salon_owners WHERE id=?').get(ownerId).payout_method,null);
  const result=await invoke('PUT','/api/owner/me/payout-method',{role:'owner',id:ownerId,login:'legacy-owner'},{payout_method:'sbp'});
  assert.equal(result.status,200);
  assert.equal(db.prepare('SELECT payout_method FROM salon_owners WHERE id=?').get(ownerId).payout_method,'sbp');
});
