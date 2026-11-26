'use strict';
// Small, bounded, on-demand projections. The single-recipient payout queries
// and reporting batches share the same SQL and commission formula.
const {netOrder,corrections}=require('./commission-refunds');
const RECIPIENT_BATCH_SIZE=64;
function checkedRecipientIds(ids){
  if(!Array.isArray(ids)||ids.length>RECIPIENT_BATCH_SIZE||ids.some(id=>!Number.isSafeInteger(id)||id<=0))
    throw new Error('Invalid payout recipient batch');
  return [...new Set(ids)];
}
function placeholders(ids){return ids.map(()=>'?').join(',');}
const ORDER_QUERIES=Object.freeze({
  partner:(predicate,grouped)=>`
    SELECT
      ${grouped?'p.id AS recipient_id, ':''}o.id,
      o.order_code,
      o.total, o.refund_status, o.refunded_amount,
      o.created_at,
      COALESCE(o.commission_rate, p.commission_rate, 0) AS commission_rate
    FROM orders o
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN partner_payout_items pi ON pi.order_id = o.id
    WHERE o.partner_id ${predicate}
      AND o.status = 'paid'
      AND pi.id IS NULL
    ORDER BY ${grouped?'p.id, ':''}o.created_at, o.id
  `,
  owner:(predicate,grouped)=>`
    SELECT
      ${grouped?'so.id AS recipient_id, ':''}o.id,
      o.order_code,
      o.total, o.refund_status, o.refunded_amount,
      o.created_at,
      so.commission_rate
    FROM salon_owners so
    JOIN orders o ON o.point_id = so.point_id
    LEFT JOIN owner_payout_items opi ON opi.order_id = o.id
    WHERE so.id ${predicate}
      AND o.status = 'paid'
      AND opi.id IS NULL
    ORDER BY ${grouped?'so.id, ':''}o.created_at, o.id
  `,
  manager:(predicate,grouped)=>`
    SELECT ${grouped?'p.manager_id AS recipient_id, ':''}o.id, o.order_code, o.total, o.point_id, o.created_at,
           o.refund_status, o.refunded_amount,
           p.name AS point_name,
           COALESCE((
             SELECT mp.commission_rate FROM manager_points mp
             WHERE mp.point_id = p.id AND mp.manager_id = p.manager_id
             ORDER BY mp.active DESC, mp.id DESC LIMIT 1
           ), 0.07) AS commission_rate
    FROM orders o
    JOIN points p ON p.id = o.point_id AND p.manager_id ${predicate}
    LEFT JOIN manager_commission_payout_items pi ON pi.order_id = o.id
    WHERE o.status = 'paid' AND pi.id IS NULL
    ORDER BY ${grouped?'p.manager_id, ':''}o.created_at, o.id
  `,
});
function unpaidOrderQuery(role,count=null){
  if(!Object.hasOwn(ORDER_QUERIES,role))throw new Error('Invalid payout role');
  if(count!==null&&(!Number.isSafeInteger(count)||count<1||count>RECIPIENT_BATCH_SIZE))throw new Error('Invalid payout recipient count');
  return ORDER_QUERIES[role](count===null?'= ?':'IN ('+Array(count).fill('?').join(',')+')',count!==null);
}
function readUnpaidOrderBatch(db,role,ids){
  ids=checkedRecipientIds(ids);
  const result=new Map(ids.map(id=>[id,[]]));
  if(!ids.length)return result;
  const rows=db.prepare(unpaidOrderQuery(role,ids.length)).all(...ids);
  for(const {recipient_id,...order} of rows)result.get(Number(recipient_id)).push(netOrder(order));
  return result;
}
function readCorrectionBatch(db,role,ids){
  ids=checkedRecipientIds(ids);
  const result=new Map(ids.map(id=>[id,{due:[],review:[]}]));
  if(!ids.length)return result;
  const {due,review}=corrections(db,role,ids);
  for(const row of due)result.get(Number(row.recipient_id)).due.push(row);
  for(const row of review)result.get(Number(row.recipient_id)).review.push(row);
  return result;
}
module.exports={RECIPIENT_BATCH_SIZE,checkedRecipientIds,placeholders,unpaidOrderQuery,readUnpaidOrderBatch,readCorrectionBatch};
