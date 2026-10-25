'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-payout-brief-'));
process.env.DATA_DIR=temp;
const db=require('./db');
const {
  collectPayoutBrief,buildPayoutBriefCsv,formatPayoutBriefMessage,
  sameRecipient,normalizePhone,
}=require('./payout-brief');
const {payoutBriefPdfPages}=require('./payout-brief-pdf');

db.prepare("INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES (?,?,?,?,?)")
  .run('M-1','manager1','hash','Иванов Иван','+7 999 111-22-33');
const managerId=db.prepare("SELECT id FROM managers WHERE mgr_code='M-1'").get().id;
db.prepare("INSERT INTO points(id,name,addr,icon,manager_id) VALUES (?,?,?,?,?)")
  .run('salon-a','БаркЛай','Улица, 1','🐾',managerId);
db.prepare("INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES (?,?,?,?,?,?,?,?)")
  .run('G-1','groomer1','hash','Иван Иванов','8 (999) 111-22-33','salon-a','БаркЛай',0.2);
db.prepare("INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate) VALUES (?,?,?,?,?,?,?,?)")
  .run('G-2','groomer2','hash','Иван Иванов','+7 900 000-00-01','salon-a','БаркЛай',0.2);
const groomer1=db.prepare("SELECT id FROM partners WHERE partner_code='G-1'").get().id;
const groomer2=db.prepare("SELECT id FROM partners WHERE partner_code='G-2'").get().id;
db.prepare("INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES (?,?,?,?,?,?)")
  .run('owner1','hash','Петрова Анна','+7 911 111-22-33','salon-a',0.05);
db.prepare("INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,bonus_paid,bonus_manager_amount,bonus_accrued_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(managerId,'salon-a','БаркЛай','Грумминг',0.07,1,1000,'2026-10-20 10:00:00');

function insertOrder(code,partnerId,amount,status,refundAmount=0){
  const info=db.prepare(
    "INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,"+
    "subtotal,total,payment_method,status,commission_rate,refund_status,refunded_amount)"+
    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(code,'Покупатель','79990000000','БаркЛай','salon-a',partnerId,
      amount,amount,'sbp',status,0.2,refundAmount?'partial':'none',refundAmount);
  return Number(info.lastInsertRowid);
}
const order1=insertOrder('ORDER-A',groomer1,1000,'paid');
const order2=insertOrder('ORDER-PARTIAL',groomer1,500,'paid',100);
const order3=insertOrder('ORDER-OTHER',groomer2,500,'paid');
insertOrder('ORDER-PENDING',groomer1,250,'pending');
const snapshotBefore=db.prepare("SELECT COUNT(*) AS n FROM partner_payouts").get().n;
const report=collectPayoutBrief(new Date('2026-10-25T13:00:00Z'));

test('same person groomer+manager receives one statement and other same-name groomer stays separate',()=>{
  assert.equal(report.people.length,3);
  const dual=report.people.find(p=>p.roles.includes('partner')&&p.roles.includes('manager'));
  assert.ok(dual);
  assert.deepEqual(new Set(dual.roles),new Set(['partner','manager']));
  assert.equal(dual.statements.length,2);
  assert.equal(dual.commission,305);
  assert.equal(dual.bonus,1000);
  assert.equal(dual.total,1305);
  assert.equal(report.people.filter(p=>p.name.includes('Иван')).length,2);
  assert.ok(report.identities_to_verify.includes('Иван Иванов'));
});
test('outstanding bonuses, refunds and other recipient roles use existing ledgers',()=>{
  assert.equal(report.total,1480);
  assert.equal(report.commission,480);
  assert.equal(report.bonus,1000);
  assert.equal(report.role_totals.partner,300);
  assert.equal(report.role_totals.manager,1105);
  assert.equal(report.role_totals.owner,75);
  assert.equal(report.held_orders,1,'one refunded order represented in three roles must count once');
  const owner=report.people.find(p=>p.roles.includes('owner'));
  assert.equal(owner.total,75);
  assert.equal(report.people.find(p=>p.statements.some(s=>s.account_id===groomer2&&s.role==='partner')).total,100);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM partner_payouts").get().n,snapshotBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM manager_commission_payouts").get().n,0);
});
test('CSV and PDF both include one combined personal section and explicit role breakdown',()=>{
  const csv=buildPayoutBriefCsv(report);
  const text=formatPayoutBriefMessage(report);
  const pages=payoutBriefPdfPages(report,'/usr/share/fonts/dejavu/DejaVuSans.ttf');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv,/ИТОГО/);
  assert.match(csv,/Менеджер/);
  assert.match(csv,/Грумер/);
  assert.match(text,/1. Иван Иванов/);
  assert.equal(pages.length,4,'summary and one page for each payee');
  const combined=pages.filter(p=>p.includes('Грумер + Менеджер'));
  assert.equal(combined.length,1);
  assert.match(combined[0],/Бонус за запуск/);
  assert.match(combined[0],/ИТОГО к выплате/);
});
test('identity matching uses confirmed contact, not name alone',()=>{
  assert.equal(normalizePhone('8 (999) 111-22-33'),'9991112233');
  assert.equal(normalizePhone('+7 999 111-22-33'),'9991112233');
  assert.equal(sameRecipient({full_name:'Иван Иванов',phone:'79991112233'},
    {full_name:'Иван Иванов',phone:'79000000001'}),false);
  assert.equal(sameRecipient({full_name:'Иван Иванов',phone:'79991112233'},
    {full_name:'Петрова Анна',phone:'79000000001',telegram_chat_id:'1234567890'}),false);
});
test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(temp,{recursive:true,force:true});
});
