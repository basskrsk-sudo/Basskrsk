'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-manager-compensation-'));
const db=require('./db');
const {signToken}=require('./auth');
const {
  getManagerUnpaidOrders,getManagerPayableOrders,getManagerUnpaidSummary,
  getManagerPeriodAccrual,
}=require('./manager-payouts');
const {registerManagerRoutes}=require('./routes-managers');
const {previewManagerCommissionPayout}=require('./payout-reminders');

function mgr(code) {
  return Number(db.prepare(
    'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)'
  ).run(code,code,'hash',code,'79130000000').lastInsertRowid);
}
function salon(id,name,managerId) {
  db.prepare('INSERT INTO points(id,name,addr,icon,manager_id) VALUES(?,?,?,?,?)')
    .run(id,name,'Красноярск','🏪',managerId);
}
function ledger(managerId,pointId,name,rate,bonus=0) {
  return Number(db.prepare(
    'INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,bonus_paid,bonus_manager_amount) '+
    'VALUES(?,?,?,?,?,?,?)'
  ).run(managerId,pointId,name,'Груминг',rate,bonus,bonus?500:0).lastInsertRowid);
}
function sale(code,pointId,total,date,status='paid',refund='none',refunded=null) {
  const result=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,'+
    'payment_method,status,refund_status,refunded_amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code,'Покупатель','79131234567','Салон',pointId,total,total,'sbp',status,refund,refunded,date);
  return Number(result.lastInsertRowid);
}
const angelina=mgr('angelina');
const other=mgr('other-manager');
salon('main-point','БаркЛай',angelina);
salon('other-point','Чужая точка',other);
ledger(angelina,null,'Груминг Пушок',0.07);
ledger(angelina,'main-point','Старое имя',0.07);
ledger(angelina,'main-point','БаркЛай',0.07,1);
ledger(other,'other-point','Чужая точка',0.07);
sale('CURRENT-1','main-point',1000,'2026-11-02 13:00:00');
sale('CURRENT-2','main-point',2000,'2026-10-30 13:00:00');
sale('PREV','main-point',1000,'2026-10-24 13:00:00');
sale('FULL-RETURN','main-point',500,'2026-11-02 13:30:00','paid','refunded',500);
sale('PARTIAL-RETURN','main-point',400,'2026-11-02 14:00:00','paid','refunded',100);
const paidOrder=sale('ALREADY-PAID','main-point',600,'2026-11-02 15:00:00');
sale('NOT-PAID','main-point',1200,'2026-11-02 16:00:00','pending');
sale('WRONG-MANAGER','other-point',900,'2026-11-02 17:00:00');
const payout=Number(db.prepare(
  'INSERT INTO manager_commission_payouts(manager_id,manager_name,amount,orders_count) VALUES(?,?,?,?)'
).run(angelina,'Ангелина',42,1).lastInsertRowid);
db.prepare(
  'INSERT INTO manager_commission_payout_items(payout_id,order_id,order_code,point_id,point_name,'+
  'commission_rate,commission_amount) VALUES(?,?,?,?,?,?,?)'
).run(payout,paidOrder,'ALREADY-PAID','main-point','БаркЛай',0.07,42);

test('duplicate and deleted manager_point history does not multiply a single sale',()=>{
  const all=getManagerUnpaidOrders(angelina);
  assert.equal(all.length,5,'paid unsettled orders, including 2 refunds for reconciliation');
  assert.equal(new Set(all.map(x=>x.order_code)).size,all.length);
  assert.equal(all.some(o=>o.point_name==='Груминг Пушок'),false);
  const payable=getManagerPayableOrders(angelina);
  assert.deepEqual(payable.map(x=>x.order_code).sort(),['CURRENT-1','CURRENT-2','PREV']);
  assert.equal(getManagerUnpaidSummary(angelina).amount,280);
  assert.equal(getManagerUnpaidSummary(angelina).orders_count,3);
  const preview=previewManagerCommissionPayout(angelina);
  assert.equal(preview.amount,280,'Telegram payout preview matches ledger');
  assert.equal(preview.orders_count,3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_commission_payouts').get().n,1,
    'read-only dashboard never creates additional payments');
});

test('selected period includes paid accrual even if already transferred, but not fake history',()=>{
 const overview=getManagerPeriodAccrual(angelina,7,new Date('2026-11-03T12:00:00Z'));
 assert.equal(overview.days,7);
 assert.equal(overview.period_residual,273);
 assert.equal(overview.previous_period_residual,70);
 assert.equal(overview.period_orders_count,4);
 assert.equal(overview.period_points.length,1);
 assert.equal(overview.period_points[0].point_name,'БаркЛай');
 assert.equal(overview.period_points[0].revenue,3900);
 assert.equal(overview.earn.reduce((sum,x)=>sum+x,0),overview.period_residual);
 assert.notEqual(overview.period_change_percent,8,'no fabricated +8%');
});

test('authenticated full and mini app manager compensation endpoints share one source',()=>{
 const map=new Map();
 const router={};
 for(const verb of ['get','post','put','delete'])router[verb]=(url,fn)=>map.set(verb.toUpperCase()+' '+url,fn);
 registerManagerRoutes(router);
 function invoke(route,role='manager',id=angelina) {
   const result={status:0,writeHead(code){this.status=code;},end(body){this.body=JSON.parse(body);}};
   const handler=map.get('GET '+route); assert.ok(handler);
   handler({headers:{authorization:'Bearer '+signToken({role,id})}},result,{params:{},query:{days:'7'}});
   return result;
 }
 const result=invoke('/api/managers/me/compensation');
 assert.equal(result.status,200);
 assert.equal(result.body.commission_unpaid,280);
 assert.equal(result.body.launch_bonus_unpaid,500);
 assert.equal(result.body.total_unpaid,780);
 assert.equal(typeof result.body.period_residual,'number',
   'period accrued uses current system time (not a hardcoded screenshot)');
 assert.equal(invoke('/api/managers/me/compensation','partner').status,403);
 const daily=invoke('/api/managers/me/daily-residual');
 assert.equal(daily.status,200);
 assert.deepEqual(daily.body.earn,result.body.earn);
});

test('full manager screen only shows actual pending payouts, period accrual and not a fake +8% gain',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/taiga-manager.html'),'utf8');
 const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
   .map(match=>match[1]).filter(body=>body.trim().length);
 for(const source of inline){assert.doesNotThrow(()=>new vm.Script(source));}
 assert.match(html,/api\/managers\/me\/compensation\?days=/);
 assert.doesNotMatch(html,/↑ \+8% к пред\. периоду/);
 assert.doesNotMatch(html,/residual\+bonuses/);
 assert.match(html,/Заявка автоматически не отправлялась/);
});
