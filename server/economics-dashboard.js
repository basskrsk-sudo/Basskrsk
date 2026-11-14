'use strict';
// Stream paid orders once. Keep original JS arithmetic and ONE final rounding
// per role; SQL SUM or joins to manager_points can alter monetary results.
const {trackSync}=require('./runtime-diagnostics');
const TAX_RATE=0.06,ACQUIRING_FEE_RATE=0.02;
function parseDateParam(value,fallback){
  if(!value)return fallback;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?fallback:date.toISOString();
}
function buildEconomicsDashboard(database,query={}){
  const from=parseDateParam(query.from,'2000-01-01T00:00:00.000Z');
  const to=parseDateParam(query.to,'2100-01-01T00:00:00.000Z');
  const cityFilter=query.city||null;
  // Keep legacy Map behavior when a point has multiple manager/owner rows.
  const rates=trackSync('economics_rates_load',()=>({
    manager:new Map(database.prepare(
      'SELECT point_id, commission_rate FROM manager_points WHERE point_id IS NOT NULL'
    ).all().map(row=>[row.point_id,row.commission_rate])),
    owner:new Map(database.prepare(
      'SELECT point_id, commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active = 1'
    ).all().map(row=>[row.point_id,row.commission_rate])),
  }));
  let revenue=0,ordersCount=0,partnerTotal=0,managerTotal=0,ownerTotal=0;
  trackSync('economics_orders_scan',()=>{
    const orders=cityFilter
      ?database.prepare(
        'SELECT o.id,o.total,o.commission_rate,o.point_id,o.created_at '+
        'FROM orders o JOIN points p ON p.id=o.point_id '+
        "WHERE o.status='paid' AND o.created_at BETWEEN ? AND ? AND p.city_id=?"
      ).iterate(from,to,cityFilter)
      :database.prepare(
        'SELECT id,total,commission_rate,point_id,created_at FROM orders '+
        "WHERE status='paid' AND created_at BETWEEN ? AND ?"
      ).iterate(from,to);
    for(const order of orders){
      revenue+=order.total;
      ordersCount++;
      partnerTotal+=order.total*(order.commission_rate||0);
      const managerRate=order.point_id?rates.manager.get(order.point_id):null;
      managerTotal+=managerRate?order.total*managerRate:0;
      const ownerRate=order.point_id?rates.owner.get(order.point_id):null;
      ownerTotal+=ownerRate?order.total*ownerRate:0;
    }
  });
  const partnerCommission=Math.round(partnerTotal);
  const managerCommission=Math.round(managerTotal);
  const ownerCommission=Math.round(ownerTotal);
  const tax=Math.round(revenue*TAX_RATE);
  const acquiringFee=Math.round(revenue*ACQUIRING_FEE_RATE);
  const expensesByCategory=trackSync('economics_expenses_scan',()=>cityFilter
    ?database.prepare('SELECT category,SUM(amount) AS total FROM expenses '+
      'WHERE expense_date BETWEEN ? AND ? AND city_id=? GROUP BY category ORDER BY total DESC'
    ).all(from.slice(0,10),to.slice(0,10),cityFilter)
    :database.prepare('SELECT category,SUM(amount) AS total FROM expenses '+
      'WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC'
    ).all(from.slice(0,10),to.slice(0,10)));
  const cogs=expensesByCategory.reduce((sum,row)=>sum+row.total,0);
  const totalCosts=partnerCommission+managerCommission+ownerCommission+tax+acquiringFee+cogs;
  const netProfit=revenue-totalCosts;
  const marginPercent=revenue>0?Math.round(netProfit/revenue*1000)/10:0;
  return {
    period:{from,to},revenue,orders_count:ordersCount,
    costs:{cogs,expenses_by_category:expensesByCategory,
      partner_commission:partnerCommission,manager_commission:managerCommission,
      owner_commission:ownerCommission,tax,acquiring_fee:acquiringFee,total:totalCosts},
    net_profit:netProfit,margin_percent:marginPercent,
    rates_used:{tax_rate:TAX_RATE,acquiring_fee_rate:ACQUIRING_FEE_RATE},
  };
}
module.exports={buildEconomicsDashboard};
