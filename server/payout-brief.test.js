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
  collectPayoutBrief,buildPayoutBriefCsv,formatPayoutBriefMessage,formatRecipientPayoutMessage,
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
// Historical line items and dates must be reproduced from orders, not current catalog.
db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-10-23 07:20:00',order1);
db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-10-24 08:15:00',order2);
db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-10-24 09:30:00',order3);
const addItem=db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES (?,?,?,?,?)');
addItem.run(order1,'Бычий корень','50 г',500,2);
addItem.run(order2,'Кроличья лапка','1 шт.',500,1);
addItem.run(order3,'Лёгкое говяжье','50 г',250,2);
const snapshotBefore=db.prepare("SELECT COUNT(*) AS n FROM partner_payouts").get().n;
const report=collectPayoutBrief(new Date('2026-10-25T13:00:00Z'));

test('same person groomer+manager receives one statement and other same-name groomer stays separate',()=>{
  assert.equal(report.people.length,3);
  const dual=report.people.find(p=>p.roles.includes('partner')&&p.roles.includes('manager'));
  assert.ok(dual);
  assert.deepEqual(new Set(dual.roles),new Set(['partner','manager']));
  assert.equal(dual.statements.length,2);
  assert.equal(dual.commission,413);
  assert.equal(dual.bonus,1000);
  assert.equal(dual.total,1413);
  assert.equal(report.people.filter(p=>p.name.includes('Иван')).length,2);
  assert.ok(report.identities_to_verify.includes('Иван Иванов'));
});
test('outstanding bonuses, refunds and other recipient roles use existing ledgers',()=>{
  assert.equal(report.total,1608);
  assert.equal(report.commission,608);
  assert.equal(report.bonus,1000);
  assert.equal(report.role_totals.partner,380);
  assert.equal(report.role_totals.manager,1133);
  assert.equal(report.role_totals.owner,95);
  assert.equal(report.held_orders,0,'partial refund is automatically recalculated');
  const owner=report.people.find(p=>p.roles.includes('owner'));
  assert.equal(owner.total,95);
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
  assert.ok(pages.length>=1+report.people.length,'summary and at least one page for each payee');
  const combined=pages.filter(p=>p.includes('Грумер + Менеджер')).join('\n');
  assert.ok(combined);
  assert.match(combined,/Бонус за запуск/);
  assert.match(combined,/ИТОГО к выплате/);
});
test('each recipient gets a standalone itemized sales report with a precise period',()=>{
  const dual=report.people.find(p=>p.roles.includes('partner')&&p.roles.includes('manager'));
  assert.ok(dual);
  // The statement includes both orders and the bonus accrued on 20 October.
  assert.equal(dual.period.label,'20.10.2026 — 24.10.2026');
  const message=formatRecipientPayoutMessage(dual,report.generated_at).replace(/\u00a0|\u202f/g,' ');
  assert.match(message,/Период расчётов: 20\.10\.2026 — 24\.10\.2026/);
  assert.match(message,/Бычий корень/);
  assert.match(message,/Стоимость продажи|Продажа: 1 000 ₽/);
  assert.match(message,/20% \(Грумер\)/);
  assert.match(message,/7% \(Менеджер\)/);
  assert.match(message,/Вознаграждение: 200 ₽/);
  const csv=buildPayoutBriefCsv(report);
  assert.match(csv,/Дата заказа\/продажи \(Красноярск\)/);
  assert.match(csv,/Наименования товаров/);
  assert.match(csv,/ORDER-A/);
  assert.match(csv,/23\.10\.2026/);
  assert.match(csv,/Бычий корень/);
  assert.match(csv,/ORDER-PARTIAL/,'partial refund included with reduced commission');
  const pages=payoutBriefPdfPages(report,'/usr/share/fonts/dejavu/DejaVuSans.ttf',{recipient:dual});
  assert.ok(pages.length>=1);
  const document=pages.join('\n').replace(/\u00a0|\u202f/g,' ');
  assert.match(document,/Получатель: Иван Иванов/);
  assert.match(document,/Даты начислений: 20\.10\.2026 — 24\.10\.2026/);
  const cutoff='2026-11-24T18:30:00.000Z'; // Nov 25 in Krasnoyarsk, still Nov 24 UTC.
  const cutoffPdf=payoutBriefPdfPages({...report,generated_at:cutoff},'/usr/share/fonts/dejavu/DejaVuSans.ttf',{recipient:dual}).join('\n');
  assert.match(cutoffPdf,/Срез начислений: 25\.11\.2026,?\s+01:30 \(Красноярск\)/);
  assert.match(cutoffPdf,/Даты начислений: 20\.10\.2026 — 24\.10\.2026/);
  assert.match(document,/Бычий корень/);
  assert.match(document,/Стоимость продажи: 1 000 ₽/);
  assert.match(document,/Ставка \(Грумер\): 20%/);
  assert.match(document,/Вознаграждение: 200 ₽/);
  assert.doesNotMatch(document,/Петрова Анна/,'must not include other recipient');
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

test('personal collection preserves amounts and merged roles without including other payees',()=>{
 for(const person of report.people){
  const selected=collectPayoutBrief(new Date(report.generated_at),{recipientKey:person.selection_key});
  assert.equal(selected.people.length,1);
  assert.deepEqual({...selected.people[0],index:person.index},person);
 }
 assert.deepEqual(collectPayoutBrief(new Date(report.generated_at),{recipientKey:'0000000000000000'}).people,[]);
});

test('full returns are absent from groomer and owner remuneration reports; partial returns and actual corrections remain',()=>{
 const code='ORDER-FULL-REFUND-HIDDEN',legacy='ORDER-LEGACY-REFUND-HIDDEN';
 const id=insertOrder(code,groomer2,777,'paid',777);
 const legacyId=insertOrder(legacy,groomer2,888,'paid');
 db.prepare("UPDATE orders SET refund_status='refunded',created_at='2026-10-24 10:00:00' WHERE id IN (?,?)").run(id,legacyId);
 db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES (?,?,?,?,?)').run(id,'ПОЛНОСТЬЮВОЗВРАЩЕННЫЙТОВАР','',777,1);
 const fresh=collectPayoutBrief(new Date(report.generated_at));
 assert.equal(fresh.total,report.total);
 const owner=fresh.people.find(p=>p.roles.includes('owner'));
 const groomer=fresh.people.find(p=>p.statements.some(s=>s.account_id===groomer2&&s.role==='partner'));
 const manager=fresh.people.find(p=>p.roles.includes('manager'));
 assert.ok(manager.statements.find(s=>s.role==='manager').refund_orders.some(o=>o.order_code===code));
 for(const person of [owner,groomer]){
   const r={...fresh,people:[person]};
   const text=formatRecipientPayoutMessage(person,fresh.generated_at);
   const csv=buildPayoutBriefCsv(r);
   const pdf=payoutBriefPdfPages(r,'/usr/share/fonts/dejavu/DejaVuSans.ttf',{recipient:person}).join('\n');
   for(const out of [text,csv,pdf]){assert.doesNotMatch(out,/ORDER-(FULL|LEGACY)-REFUND-HIDDEN|Полный возврат|ПОЛНОСТЬЮВОЗВРАЩЕННЫЙТОВАР/);}
   assert.ok(person.statements.every(s=>s.refund_orders.every(o=>o.net>0)));
 }
 const {generatePeriodReport,printableReport}=require('./payout-reports');
 const {payoutPdfPages}=require('./payout-report-pdf');
 for(const [role,recipient] of [['owner',owner.statements[0].account_id],['partner',groomer2]]){
   const period=generatePeriodReport(db,role,recipient,'2026-10-23','2026-10-24');
   assert.ok(period.items.every(i=>i.order_code!==code&&i.order_code!==legacy));
   assert.equal(period.accrued,role==='owner'?95:100);
   if(role==='owner')assert.equal(period.items.find(i=>i.order_code==='ORDER-PARTIAL').refunded_amount,100);
   // Simulate an older saved period report and a real deduction. Filtering
   // the rendered rows must leave the underlying stored values unchanged.
   const oldRow={order_code:code,base:0,amount:0,rate:.2,original_total:777,refunded_amount:777,products:[{name:'ПОЛНОСТЬЮВОЗВРАЩЕННЫЙТОВАР',qty:1}]};
   const archived={...period,items:[...period.items,oldRow],refund_adjustments:[{order_code:'PAID-CORRECTION',amount:15,refunded_amount:777}],refund_adjustment_total:15};
   const before=JSON.stringify(archived);
   const html=printableReport(archived), pdf=payoutPdfPages(archived,'/test/font.ttf').join('\n');
   for(const out of [html,pdf]){
    assert.doesNotMatch(out,/ПОЛНОСТЬЮВОЗВРАЩЕННЫЙТОВАР|Корректировка возврата/);
    assert.match(out,/Корректировка ранее выплаченной комиссии/);
    assert.match(out,/PAID-CORRECTION/);
   }
   assert.equal(JSON.stringify(archived),before);
 }
});
