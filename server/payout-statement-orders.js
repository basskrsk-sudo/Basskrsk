'use strict';
// Limit a payout to the exact orders in a previously generated PDF.
// Called within the payout transaction: later orders are not paid.
function staleStatement(){
  return Object.assign(new Error('Состав или суммы начислений изменились. Ничего не зафиксировано. Проверьте историю выплат и сформируйте новую справку /payouts.'),{code:'STALE_PAYOUT_BRIEF',publicMessage:true});
}
function selectStatementOrders(db,pending,expected){
  if(!Array.isArray(expected)||!expected.length)throw staleStatement();
  const byId=new Map(pending.map(o=>[Number(o.id),o])),seen=new Set();
  return expected.map(line=>{
    const id=Number(line.order_id),order=byId.get(id);
    if(!Number.isSafeInteger(id)||seen.has(id)||!order||
      Number(order.total)!==Number(line.sale_total)||
      Number(order.return_amount||0)!==Number(line.refunded_amount||0)||
      Number(order.commission_rate)!==Number(line.commission_rate)||
      Number(order.commission_amount)!==Number(line.commission_amount)||
      String(order.created_at||'')!==String(line.created_at||''))throw staleStatement();
    if(!require('./commission-refunds').isPayable(order))throw staleStatement();
    seen.add(id);
    return order;
  });
}
module.exports={selectStatementOrders,staleStatement};
