'use strict';
// One index-assisted query for the admin owners registry. Keep the historical
// gross-revenue semantics of this screen; only replace per-owner, materialized
// payout lists with SQL SUM of individually rounded order commissions.
// owner_payout_items has UNIQUE(order_id), so its LEFT JOIN cannot duplicate
// paid orders. No background jobs, writes or per-owner queries are introduced.
const OWNERS_REGISTRY_SQL = `
  SELECT so.*,
    p.name AS point_name,
    gp.full_name AS groomer_partner_name,
    COUNT(o.id) AS paid_orders_count,
    COALESCE(SUM(o.total),0) AS paid_revenue,
    COALESCE(SUM(CASE WHEN o.created_at >= datetime('now','start of month')
      THEN o.total ELSE 0 END),0) AS month_paid_revenue,
    COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND opi.id IS NULL
      THEN ROUND(COALESCE(o.total,0)*COALESCE(so.commission_rate,0))
      ELSE 0 END),0) AS current_earnings,
    COALESCE(SUM(CASE WHEN o.id IS NOT NULL AND opi.id IS NULL
      THEN 1 ELSE 0 END),0) AS unpaid_orders_count
  FROM salon_owners so
  LEFT JOIN points p ON p.id=so.point_id
  LEFT JOIN partners gp ON gp.id=so.groomer_partner_id
  LEFT JOIN orders o ON o.point_id=so.point_id AND o.status='paid'
  LEFT JOIN owner_payout_items opi ON opi.order_id=o.id
  GROUP BY so.id
  ORDER BY so.id DESC
`;
function readOwnersRegistry(database) {
  return database.prepare(OWNERS_REGISTRY_SQL).all().map(row => {
    const rate=Number(row.commission_rate||0);
    const paidRevenue=Number(row.paid_revenue||0);
    const monthRevenue=Number(row.month_paid_revenue||0);
    return {
      ...row,
      paid_orders_count:Number(row.paid_orders_count||0),
      paid_revenue:paidRevenue,
      accrued_earnings:Math.round(paidRevenue*rate),
      month_earnings:Math.round(monthRevenue*rate),
      current_earnings:Number(row.current_earnings||0),
      unpaid_orders_count:Number(row.unpaid_orders_count||0),
    };
  });
}
module.exports={readOwnersRegistry,OWNERS_REGISTRY_SQL};
