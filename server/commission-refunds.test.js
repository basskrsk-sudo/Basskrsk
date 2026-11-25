'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-refund-commission-'));
const db=require('./db');
const {netOrder,planCommission,corrections}=require('./commission-refunds');
const {getUnpaidOrders,createPartnerPayout}=require('./partner-payouts');
const {getOwnerUnpaidOrders,createOwnerPayout}=require('./owner-payouts');
const {getManagerPayableOrders,createManagerCommissionPayout}=require('./manager-payouts');
const manager=Number(db.prepare('INSERT INTO managers(mgr_code,login,password_hash,full_name) VALUES(?,?,?,?)').run('MR-REF','mr-ref','hash','Manager').lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)').run('refund-test','Salon','Address','X',manager);
const partner=Number(db.prepare('INSERT INTO partners(partner_code,login,password_hash,full_name,point_id,commission_rate) VALUES(?,?,?,?,?,?)').run('G-REF','g-ref','hash','Groomer','refund-test',0.2).lastInsertRowid);
const owner=Number(db.prepare('INSERT INTO salon_owners(login,password_hash,full_name,point_id,commission_rate) VALUES(?,?,?,?,?)').run('o-ref','hash','Owner','refund-test',0.05).lastInsertRowid);
const admin={id:1,login:'admin'};
const roles=[['partner',partner,getUnpaidOrders,createPartnerPayout,200,80,120],['owner',owner,getOwnerUnpaidOrders,createOwnerPayout,50,20,30],['manager',manager,getManagerPayableOrders,createManagerCommissionPayout,70,28,42]];
function sale(code,total,returned=0){return Number(db.prepare("INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,partner_id,subtotal,total,payment_method,status,commission_rate,refund_status,refunded_amount) VALUES(?,?,?,?,?,?,?,?,?,'paid',?,?,?)").run(code,'Client','79990000001','Salon','refund-test',partner,total,total,'sbp',0.2,returned?'refunded':'none',returned).lastInsertRowid);}
test('net amounts, full return, legacy status and rounding',()=>{
 assert.equal(netOrder({total:500,refunded_amount:100,refund_status:'refunded',commission_rate:.15}).commission_amount,60);
 assert.equal(netOrder({total:500,refund_status:'refunded',commission_rate:.15}).commission_amount,0);
 assert.equal(netOrder({total:90,commission_rate:.15}).commission_amount,14);
});
test('all three ledgers recover prior commission once, using original rates and immutable reports',()=>{
 const old=sale('ORIGINAL',1000);
 for(const [role,id,read,pay,gross] of roles){const result=pay(id,admin);assert.equal(result.amount,gross);}
 db.prepare("UPDATE orders SET refund_status='refunded',refunded_amount=400 WHERE id=?").run(old);
 const partial=sale('PARTIAL',1000,400);
 const full=sale('FULL',500,500);
 for(const [role,id,read,pay,gross,loss,net] of roles){
  const {due}=corrections(db,role,id);assert.equal(due.length,1);assert.equal(due[0].amount,loss);
  const result=pay(id,admin);assert.equal(result.amount,net-loss);
  const report=JSON.parse(db.prepare('SELECT snapshot_json FROM payout_reports WHERE id=?').get(result.report_id).snapshot_json);
  assert.equal(report.refund_adjustment_total,loss);assert.equal(report.payout_amount,net-loss);
  assert.ok(report.items.some(x=>x.order_code==='PARTIAL'&&x.base===600));
  assert.ok(!report.items.some(x=>x.order_code==='FULL'));
  assert.equal(corrections(db,role,id).due.length,0);
 }
 sale('NEXT',1000);
 for(const [role,id,read,pay,gross] of roles)assert.equal(pay(id,admin).amount,gross,'no repeat offset');
 db.prepare("UPDATE orders SET refunded_amount=1000 WHERE id=?").run(old);
 sale('SMALL',100);
 for(const [role,id,read,pay,gross,loss,net] of roles){
  const plan=planCommission(db,role,id,read(id));assert.equal(plan.debt,net);
  assert.equal(plan.amount,0);assert.equal(plan.carried,net);
  assert.throws(()=>pay(id,admin),{code:'NOTHING_TO_PAY'});
 }
});
test.after(()=>{db.close();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});});
