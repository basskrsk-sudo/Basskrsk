'use strict';

// Read-only owner dashboard: aggregate paid sales in SQLite instead of loading
// every historic order into the single-threaded HTTP process.
// Preserve the existing net-refund rule and frozen per-order groomer rates.
const {corrections}=require('./commission-refunds');
const NET = `CASE WHEN o.refund_status='refunded' AND COALESCE(o.refunded_amount,0)<=0 THEN 0
  ELSE MAX(0,o.total-COALESCE(o.refunded_amount,0)) END`;

const TOTALS_SQL = `
  WITH sales AS (
    SELECT o.partner_id,o.created_at,${NET} AS net
    FROM orders o WHERE o.point_id=? AND o.status='paid'
  )
  SELECT COUNT(*) AS orders,COALESCE(SUM(net),0) AS revenue,
    COALESCE(SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END),0) AS this_month_orders,
    COALESCE(SUM(CASE WHEN created_at>=? THEN net ELSE 0 END),0) AS this_month_revenue,
    COALESCE(SUM(CASE WHEN partner_id IS NULL OR partner_id=0 THEN 1 ELSE 0 END),0) AS unassigned_orders_count
  FROM sales WHERE net>0
`;

const GROOMERS_SQL = `
  WITH grouped AS (
    SELECT o.partner_id,COUNT(*) AS orders_count,
      COALESCE(SUM(${NET}),0) AS revenue,
      COALESCE(SUM(${NET} * COALESCE(o.commission_rate,p.commission_rate,0)),0) AS commission_earned
    FROM orders o JOIN partners p ON p.id=o.partner_id AND p.point_id=o.point_id
    WHERE o.point_id=? AND o.status='paid' AND ${NET}>0
    GROUP BY o.partner_id
  )
  SELECT p.id,p.full_name,p.commission_rate,p.active,
    COALESCE(g.orders_count,0) AS orders_count,
    COALESCE(g.revenue,0) AS revenue,
    COALESCE(g.commission_earned,0) AS commission_earned
  FROM partners p LEFT JOIN grouped g ON g.partner_id=p.id
  WHERE p.point_id=?
  ORDER BY revenue DESC,p.id
`;

const RECENT_SQL = `
  SELECT o.id,${NET} AS total,o.payment_method,o.created_at,
    o.is_partner_self_order AS is_self_order
  FROM orders o
  WHERE o.point_id=? AND o.status='paid' AND ${NET}>0
  ORDER BY o.created_at DESC LIMIT 20
`;

// Net unpaid commission uses the same per-order rounding as the ledger.
const UNPAID_SQL = `
  SELECT COUNT(*) AS orders_count,
    COALESCE(SUM(ROUND((${NET}) * so.commission_rate)),0) AS amount
  FROM salon_owners so
  JOIN orders o ON o.point_id=so.point_id
  LEFT JOIN owner_payout_items opi ON opi.order_id=o.id
  WHERE so.id=? AND o.status='paid' AND opi.id IS NULL
    AND ((${NET})>0 OR (COALESCE(o.refunded_amount,0)=0 AND COALESCE(o.refund_status,'none')<>'refunded'))
`;

function loadOwnerDashboardSales(database,pointId,ownerId,monthStartIso) {
  if (!pointId || !Number.isSafeInteger(Number(ownerId)) ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(monthStartIso)) {
    throw new TypeError('Invalid owner dashboard parameters');
  }
  const sum=database.prepare(TOTALS_SQL).get(pointId,monthStartIso,monthStartIso);
  const revenue=Number(sum.revenue||0),orders=Number(sum.orders||0);
  const groomers=database.prepare(GROOMERS_SQL).all(pointId,pointId).map(p=>({
    id:p.id,full_name:p.full_name,active:!!p.active,
    tier_percent:Math.round(Number(p.commission_rate||0)*100),
    orders_count:Number(p.orders_count||0),revenue:Number(p.revenue||0),
    commission_earned:Math.round(Number(p.commission_earned||0)),
  }));
  const recent_orders=database.prepare(RECENT_SQL).all(pointId).map(o=>({
    id:o.id,total:Number(o.total||0),payment_method:o.payment_method,
    created_at:o.created_at,is_self_order:!!o.is_self_order,
  }));
  const unpaid=database.prepare(UNPAID_SQL).get(ownerId);
  const debt=corrections(database,'owner',ownerId).due.reduce((s,x)=>s+x.amount,0);
  return {
    totals:{
      revenue,orders,avg_order:orders?Math.round(revenue/orders):0,
      this_month_revenue:Number(sum.this_month_revenue||0),
      this_month_orders:Number(sum.this_month_orders||0),
    },
    groomers,unassigned_orders_count:Number(sum.unassigned_orders_count||0),
    recent_orders,
    unpaid:{amount:Math.max(0,Number(unpaid.amount||0)-debt),orders_count:Number(unpaid.orders_count||0)},
  };
}
module.exports={loadOwnerDashboardSales,TOTALS_SQL,GROOMERS_SQL,RECENT_SQL,UNPAID_SQL};
