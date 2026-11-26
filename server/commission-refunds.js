'use strict';
const {netPaidRevenue}=require('./net-paid-revenue');
const CONFIG={
 partner:['partner_payout_items','partner_payouts','partner_id'],
 owner:['owner_payout_items','owner_payouts','owner_id'],
 manager:['manager_commission_payout_items','manager_commission_payouts','manager_id'],
};
function initializeRefundOffsets(db){
 db.exec(`CREATE TABLE IF NOT EXISTS commission_refund_offsets (
  role TEXT NOT NULL CHECK(role IN ('partner','owner','manager')),
  recipient_id INTEGER NOT NULL, original_item_id INTEGER NOT NULL,
  original_payout_id INTEGER NOT NULL, order_code TEXT NOT NULL,
  payout_id INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
  refunded_amount REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(role,original_item_id,payout_id)
 );
 CREATE INDEX IF NOT EXISTS idx_commission_offsets_recipient ON commission_refund_offsets(role,recipient_id);
 CREATE INDEX IF NOT EXISTS idx_commission_offsets_original_payout ON commission_refund_offsets(role,original_payout_id);
 CREATE INDEX IF NOT EXISTS idx_commission_offsets_payout ON commission_refund_offsets(role,payout_id);`);
}
function netOrder(order){
 const gross=Number(order.total)||0, net=netPaidRevenue(order);
 return {...order,original_total:gross,total:net,
  return_amount:Math.max(0,gross-net),commission_amount:Math.round(net*Number(order.commission_rate||0))};
}
function isPayable(order){return !(order.return_amount>0 && order.total<=0)&&!(order.refund_status==='refunded'&&order.total<=0);}
function corrections(db,role,id=null){
 const config=CONFIG[role];if(!config)throw Error('Invalid payout role');
 const [items,payouts,recipient]=config;
 const batch=Array.isArray(id);
 if(batch){
  if(id.length>64||id.some(value=>!Number.isSafeInteger(value)||value<=0))throw Error('Invalid payout recipient batch');
  if(!id.length)return {due:[],review:[]};
 }
 const recipientFilter=id==null?'p.'+recipient+' IS NOT NULL':batch?'p.'+recipient+' IN ('+id.map(()=>'?').join(',')+')':'p.'+recipient+'=?';
 // Only paid ledger rows whose source order was returned; preserve the frozen
 // commission, not the recipient's mutable current rate. No background writes.
 const rows=db.prepare(`SELECT p.${recipient} AS recipient_id,i.id AS item_id,i.payout_id AS original_payout_id,i.order_code,
  i.commission_amount AS paid_commission,${role==='manager'?'i.commission_rate':'NULL'} AS stored_rate,
  o.id AS order_id,o.total,o.refund_status,o.refunded_amount,
  r.snapshot_json,
  COALESCE((SELECT SUM(x.amount) FROM commission_refund_offsets x
    WHERE x.role=? AND x.original_item_id=i.id),0) AS recovered
  FROM ${payouts} p JOIN ${items} i ON i.payout_id=p.id JOIN orders o ON o.id=i.order_id
  LEFT JOIN payout_reports r ON r.role=? AND r.payout_id=p.id
  WHERE ${recipientFilter} AND (o.refund_status='refunded' OR COALESCE(o.refunded_amount,0)>0)
  ORDER BY i.id`).all(role,role,...(id==null?[]:batch?id:[id]));
 const due=[],review=[];
 for(const row of rows){
  const net=netPaidRevenue(row),returned=Math.max(0,Number(row.total||0)-net);
  let rate=row.stored_rate;
  if(rate==null&&row.snapshot_json){
   try{const saved=JSON.parse(row.snapshot_json).items?.find(x=>x.order_code===row.order_code&&Number(x.amount)===Number(row.paid_commission));
    if(saved?.rate!=null)rate=Number(saved.rate);
   }catch(_){}
  }
  const base={recipient_id:row.recipient_id,item_id:row.item_id,original_payout_id:row.original_payout_id,order_id:row.order_id,
   order_code:row.order_code,refunded_amount:returned,paid_commission:Number(row.paid_commission),recovered:Number(row.recovered)};
  if(net>0&&(rate==null||!Number.isFinite(Number(rate))||Number(rate)<0)){
   if(base.paid_commission>base.recovered)review.push(base);continue;
  }
  const corrected=net<=0?0:Math.round(net*Number(rate));
  const loss=Math.max(0,base.paid_commission-corrected);
  const amount=Math.max(0,loss-base.recovered);
  if(amount>0)due.push({...base,corrected_commission:corrected,amount});
 }
 return {due,review};
}
function debtByRecipient(db,role){
 const result=new Map();
 for(const x of corrections(db,role).due)result.set(Number(x.recipient_id),(result.get(Number(x.recipient_id))||0)+x.amount);
 return result;
}
function planCommission(db,role,id,orders){
 return planCommissionFromCorrections(orders,corrections(db,role,id));
}
function planCommissionFromCorrections(orders,{due,review}){
 const gross=orders.reduce((s,o)=>s+Number(o.commission_amount||0),0);
 const debt=due.reduce((s,o)=>s+o.amount,0);
 // Do not create fictional zero or negative cash payments. If this role's
 // commission cannot cover the deduction, retain the entire balance until
 // a positive transfer can be confirmed. Never offset unrelated bonuses.
 const amount=Math.max(0,gross-debt);
 return {gross,amount,debt,adjustments:amount>0?due:[],outstanding:due,
   carried:amount>0?0:debt,review};
}
function verifyPlan(plan,options={}){
 if(options.statementOrders){
  const expected=options.statementAdjustments||[];
  if(JSON.stringify(expected)!==JSON.stringify(plan.adjustments))throw require('./payout-statement-orders').staleStatement();
 }
 return plan;
}
function recordOffsets(db,role,id,payoutId,plan){
 const insert=db.prepare(`INSERT INTO commission_refund_offsets
 (role,recipient_id,original_item_id,original_payout_id,order_code,payout_id,amount,refunded_amount)
 VALUES(?,?,?,?,?,?,?,?)`);
 for(const x of plan.adjustments)insert.run(role,id,x.item_id,x.original_payout_id,x.order_code,payoutId,x.amount,x.refunded_amount);
}
module.exports={initializeRefundOffsets,netOrder,isPayable,corrections,debtByRecipient,planCommission,planCommissionFromCorrections,verifyPlan,recordOffsets};
