'use strict';

// The refund endpoint records both partial and full refunds with status
// "refunded". A positive refunded_amount therefore determines net revenue.
// For legacy rows without a recorded amount, preserve the old zero-revenue
// treatment of refunded orders.
function netPaidRevenue(order){
  const total=Number(order?.total)||0;
  const returned=Number(order?.refunded_amount)||0;
  return order?.refund_status==='refunded' && returned<=0
    ?0:Math.max(0,total-returned);
}
const NET_PAID_REVENUE_SQL = "CASE WHEN refund_status='refunded' AND " +
  "COALESCE(refunded_amount,0)<=0 THEN 0 ELSE " +
  "MAX(0,COALESCE(total,0)-COALESCE(refunded_amount,0)) END";

module.exports={netPaidRevenue,NET_PAID_REVENUE_SQL};
