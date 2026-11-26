'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-cancel-payout-'));
const db=require('./db');
const {signToken}=require('./auth');
const {cancelPayout,assertReportActive}=require('./payout-cancellations');
const {registerPayoutReportRoutes}=require('./routes-payout-reports');
const {registerAuditRoutes}=require('./routes-audit');
const reports=require('./payout-reports');
const partner=require('./partner-payouts');
const owner=require('./owner-payouts');
const manager=require('./manager-payouts');
const bonuses=require('./report-bonuses');
const briefs=require('./payout-brief-confirmation');
const {collectPayoutBrief}=require('./payout-brief');
const adminId=Number(db.prepare('INSERT INTO admins(login,password_hash,full_name,telegram_chat_id,role,active) VALUES(?,?,?,?,?,1)').run('cancel-super','hash','Super','777991','super').lastInsertRowid);
const regularId=Number(db.prepare('INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,?,1)').run('cancel-regular','hash','admin').lastInsertRowid);
const disabledId=Number(db.prepare('INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,?,0)').run('cancel-disabled','hash','super').lastInsertRowid);
const admin={id:adminId,login:'cancel-super'};
const managerId=Number(db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)').run('M-CANCEL','cancel-mgr','hash','Тест Менеджер','79990001112').lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)').run('cancel-point','Салон','Адрес','🐾',managerId);
const partnerId=Number(db.prepare('INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES(?,?,?,?,?,?,?,?)').run('P-CANCEL','cancel-partner','hash','Тест Владелец','79990001111','cancel-point','Салон',0.15).lastInsertRowid);
const ownerId=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES(?,?,?,?,?,?)').run('cancel-owner','hash','Тест Владелец','+7 999 000 11 11','cancel-point',0.05).lastInsertRowid);
const bonusId=Number(db.prepare('INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,bonus_paid,bonus_manager_amount,bonus_accrued_at,referred_groomer_id,referred_groomer_amount,referred_owner_id,referred_owner_amount,referral_bonus_accrued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(managerId,'cancel-point','Салон','Груминг',0.07,1,2000,'2026-10-08',partnerId,1000,ownerId,1000,'2026-10-08').lastInsertRowid);
const orderId=Number(db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('CANCEL-ORDER','Клиент','79001112233','Салон','cancel-point',partnerId,3000,3000,'sbp','paid',0.15).lastInsertRowid);
const token=(id,adminRole)=>signToken({role:'admin',id,adminRole});
const handlers={get:new Map(),post:new Map()};
const router={get:(p,f)=>handlers.get.set(p,f),post:(p,f)=>handlers.post.set(p,f)};
registerPayoutReportRoutes(router);registerAuditRoutes(router);
async function invoke(method,url,{auth=token(adminId,'super'),body={},query={},params={}}={}){
  const res={status:0,data:null,setHeader(){},writeHead(code){this.status=code;},end(text){this.data=text?JSON.parse(text):null;}};
  await handlers[method].get(url)({headers:{authorization:auth?'Bearer '+auth:''}},res,{body,query,params});
  return res;
}
const bodyFor=(role,payout,type='commission')=>({role,payout_type:type,payout_id:payout.id,expected_amount:payout.amount,reason:'Ошибка фиксации',confirm_not_transferred:true});
test('reopen only the selected commission, validate live permissions, archive evidence and issue a new payout',async()=>{
  const ledger=[
    ['partner',partnerId,()=>partner.createPartnerPayout(partnerId,admin),()=>partner.getUnpaidSummary(partnerId).amount],
    ['owner',ownerId,()=>owner.createOwnerPayout(ownerId,admin),()=>owner.getOwnerUnpaidSummary(ownerId).amount],
    ['manager',managerId,()=>manager.createManagerCommissionPayout(managerId,admin),()=>manager.getManagerUnpaidSummary(managerId).amount]
  ].map(([role,id,create,pending])=>({role,id,create,pending,payout:create()}));
  for(const {role,create,pending,payout} of ledger){
    const body=bodyFor(role,payout),c=reports.roleConfig(role);
    assert.equal(pending(),0);
    const route='/api/payout-reports/cancel-payment';
    for(const auth of [token(regularId,'admin'),token(regularId,'super'),token(disabledId,'super')]){
      assert.equal((await invoke('post',route,{auth,body})).status,403);
    }
    assert.equal((await invoke('post',route,{body:{...body,reason:''}})).status,400);
    assert.equal((await invoke('post',route,{body:{...body,confirm_not_transferred:false}})).status,400);
    assert.equal((await invoke('post',route,{body:{...body,expected_amount:payout.amount+1}})).status,409);
    assert.equal(pending(),0);
    const original=reports.fromPayout(db,role,payout.id,admin.id);
    const snapshot=db.prepare('SELECT snapshot_json FROM payout_reports WHERE id=?').get(original.id).snapshot_json;
    const result=await invoke('post',route,{body});
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(pending(),payout.amount);
    const archived=db.prepare('SELECT * FROM payout_cancellations WHERE id=?').get(result.data.cancellation_id);
    assert.equal(archived.amount,payout.amount);assert.equal(archived.reason,body.reason);
    assert.equal(JSON.parse(archived.snapshot_json).items[0].order_id,orderId);
    assert.equal(db.prepare('SELECT snapshot_json FROM payout_reports WHERE id=?').get(original.id).snapshot_json,snapshot);
    assert.throws(()=>assertReportActive(db,original.id),/аннулирован/);
    assert.throws(()=>reports.fromPayout(db,role,payout.id,admin.id),/отменена/);
    assert.equal((await invoke('get','/api/payout-reports/:id',{params:{id:original.id}})).status,409);
    assert.equal((await invoke('get','/api/payout-reports/:id/pdf',{params:{id:original.id}})).status,409);
    assert.equal((await invoke('post',route,{body})).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+c.items+' WHERE order_id=?').get(orderId).n,0);
    for(const other of ledger.filter(x=>x.role!==role))assert.equal(other.pending(),0);
    const fresh=create();
    assert.notEqual(fresh.id,payout.id);
    assert.equal(fresh.amount,payout.amount);
    assert.equal(pending(),0);
  }
  const audit=await invoke('get','/api/admin/audit-log',{query:{type:'payout_cancel'}});
  assert.equal(audit.status,200);assert.equal(audit.data.events.length,3);
});
test('launch and referral bonus cancellation leaves original accrual intact and permits a fresh payout',()=>{
  for(const [role,type,id,make] of [
    ['manager','launch_bonus',managerId,()=>manager.createManagerLaunchBonusPayout(bonusId,admin)],
    ['partner','referral_bonus',partnerId,()=>bonuses.createReferralBonusPayout(db,'partner',bonusId,partnerId,1000,admin).payout],
    ['owner','referral_bonus',ownerId,()=>bonuses.createReferralBonusPayout(db,'owner',bonusId,ownerId,1000,admin).payout]
  ]){
    const payout=make();
    assert.equal(bonuses.getBonuses(db,role,id).pending.length,0);
    const report=reports.fromPayout(db,role,payout.id,adminId,type);
    cancelPayout(db,bodyFor(role,payout,type),adminId);
    assert.equal(bonuses.getBonuses(db,role,id).pending[0].amount,payout.amount);
    assert.throws(()=>assertReportActive(db,report.id),/аннулирован/);
    assert.notEqual(make().id,payout.id);
    assert.equal(bonuses.getBonuses(db,role,id).pending.length,0);
  }
});
test('cancellation invalidates older actionable PDF confirmations; reopened debt has a fresh confirmation',()=>{
  const original=db.prepare('SELECT * FROM owner_payouts WHERE owner_id=? ORDER BY id DESC LIMIT 1').get(ownerId);
  // Add an unpaid sale so a pending PDF is bound to the same account.
  db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('CANCEL-NEW','Клиент','79001112233','Салон','cancel-point',partnerId,250,250,'sbp','paid',0.15);
  const getPerson=()=>collectPayoutBrief(new Date()).people.find(p=>p.statements.some(s=>s.role==='owner'&&s.account_id===ownerId));
  const old=briefs.registerPayoutBrief('777991',getPerson(),new Date().toISOString());
  assert.ok(old.id);
  cancelPayout(db,bodyFor('owner',original),adminId);
  const invalid=briefs.handlePayoutConfirmation('777991','payout:paid:'+old.id);
  assert.equal(invalid.ok,false);assert.match(invalid.message,/аннулирована/);
  const fresh=briefs.registerPayoutBrief('777991',getPerson(),new Date().toISOString());
  assert.ok(fresh.id);assert.equal(briefs.handlePayoutConfirmation('777991','payout:paid:'+fresh.id).ok,true);
});
test('admin UI exposes cancellation only through guarded history and audit view',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','public','taiga-admin.html'),'utf8');
  for(const role of ['partner','owner','manager'])assert.ok(html.includes("payoutCancelButton('"+role+"'"));
  assert.match(html,/function payoutCancelButton/);
  assert.match(html,/currentAdminRole!=='super'/);
  assert.match(html,/confirm_not_transferred:true/);
  assert.match(html,/value="payout_cancel"/);
});


test('large cancellation validates every order with bounded SQL calls and preserves all safety checks',()=>{
  const size=300,pointId='cancel-batch-point';
  const mid=Number(db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)').run('M-CANCEL-BATCH','cancel-batch-mgr','hash','Менеджер пакета','79990002222').lastInsertRowid);
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)').run(pointId,'Пакетный салон','Адрес','x',mid);
  const pid=Number(db.prepare('INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES(?,?,?,?,?,?,?,?)').run('P-CANCEL-BATCH','cancel-batch-partner','hash','Грумер пакета','79990002223',pointId,'Пакетный салон',0.15).lastInsertRowid);
  const oid=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES(?,?,?,?,?,?)').run('cancel-batch-owner','hash','Владелец пакета','79990002224',pointId,0.05).lastInsertRowid);
  const insert=db.prepare('INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const orderIds=[];
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<size;i++)orderIds.push(Number(insert.run('CANCEL-BATCH-'+i,'Клиент','79001112233','Пакетный салон',pointId,pid,250,250,'sbp','paid',0.15).lastInsertRowid));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const ledger=[
    ['partner',pid,partner.createPartnerPayout(pid,admin),()=>partner.getUnpaidSummary(pid).amount],
    ['owner',oid,owner.createOwnerPayout(oid,admin),()=>owner.getOwnerUnpaidSummary(oid).amount],
    ['manager',mid,manager.createManagerCommissionPayout(mid,admin),()=>manager.getManagerUnpaidSummary(mid).amount]
  ];
  for(const [role,id,payout,pending] of ledger){
    const c=reports.roleConfig(role),body=bodyFor(role,payout),lastOrder=orderIds.at(-1);
    assert.equal(payout.orders_count,size);
    db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(lastOrder);
    assert.throws(()=>cancelPayout(db,body,adminId),/Заказ или получатель изменился/);
    db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(lastOrder);
    // One changed assignment in the tail must still block the whole reversal.
    if(role==='partner')db.prepare('UPDATE orders SET partner_id=NULL WHERE id=?').run(lastOrder);
    else if(role==='owner')db.prepare('UPDATE salon_owners SET point_id=NULL WHERE id=?').run(id);
    else db.prepare('UPDATE points SET manager_id=NULL WHERE id=?').run(pointId);
    assert.throws(()=>cancelPayout(db,body,adminId),/Заказ или получатель изменился/);
    if(role==='partner')db.prepare('UPDATE orders SET partner_id=? WHERE id=?').run(id,lastOrder);
    else if(role==='owner')db.prepare('UPDATE salon_owners SET point_id=? WHERE id=?').run(pointId,id);
    else db.prepare('UPDATE points SET manager_id=? WHERE id=?').run(id,pointId);
    const saved=reports.fromPayout(db,role,payout.id,adminId);
    db.prepare("INSERT INTO payout_report_deliveries(report_id,target_chat_id,status) VALUES(?,?,'pending')").run(saved.id,'batch-test');
    assert.throws(()=>cancelPayout(db,body,adminId),/Отчёт сейчас отправляется/);
    db.prepare("UPDATE payout_report_deliveries SET status='sent' WHERE report_id=?").run(saved.id);
    const item=db.prepare('SELECT id,order_code FROM '+c.items+' WHERE payout_id=? ORDER BY id LIMIT 1').get(payout.id);
    db.prepare('INSERT INTO commission_refund_offsets(role,recipient_id,original_item_id,original_payout_id,order_code,payout_id,amount,refunded_amount) VALUES(?,?,?,?,?,?,?,?)').run(role,id,item.id,payout.id,item.order_code,999999,1,1);
    assert.throws(()=>cancelPayout(db,body,adminId),/связанные удержания/);
    db.prepare('DELETE FROM commission_refund_offsets WHERE role=? AND original_payout_id=? AND payout_id=999999').run(role,payout.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM '+c.items+' WHERE payout_id=?').get(payout.id).n,size);
    assert.equal(pending(),0);
    const prepare=db.prepare;let reads=0;
    db.prepare=function(sql){
      if(/^\s*SELECT\b/i.test(sql))reads++;
      return prepare.call(this,sql);
    };
    let result;
    try{result=cancelPayout(db,body,adminId);}
    finally{db.prepare=prepare;}
    assert.ok(reads<=12,'cancellation must not issue one query per order: '+role+' '+reads);
    assert.equal(pending(),payout.amount);
    assert.equal(JSON.parse(db.prepare('SELECT snapshot_json FROM payout_cancellations WHERE id=?').get(result.cancellation_id).snapshot_json).items.length,size);
    assert.throws(()=>assertReportActive(db,saved.id),/аннулирован/);
    console.log('[payout-cancel-batch] '+role+' '+size+' orders: '+reads+' SELECT preparations');
  }
  for(const [index,sql] of [
    ['idx_commission_offsets_original_payout',"SELECT 1 FROM commission_refund_offsets WHERE role='owner' AND original_payout_id=1 LIMIT 1"],
    ['idx_commission_offsets_payout',"SELECT * FROM commission_refund_offsets WHERE role='owner' AND payout_id=1"]
  ]){
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all();
    assert.ok(plan.some(step=>step.detail.includes(index)),JSON.stringify(plan));
  }
});
