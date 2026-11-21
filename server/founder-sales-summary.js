'use strict';

// Bounded-memory, READ-ONLY founder summary. Per-order pricing, tax rounding,
// historic commission rates and payout reconciliation are unchanged.
// The caller supplies the same manager/owner maps as legacy economics.
const { createFounderPaidSalesReader }=require('./founder-sales-batches');
const { createPointPayoutProfitAccumulator }=require('./point-period-finance');
const { netPaidRevenue }=require('./net-paid-revenue');
const { POINT_SALES_TAX_RATE }=require('./point-economics-rates');

function collectCurrentFounderSales(database,period,assumptions,rates,{pageSize=200}={}){
  const reader=createFounderPaidSalesReader(database,period,{pageSize});
  const payout=createPointPayoutProfitAccumulator(database,assumptions);
  const totals={
    revenue:0,orders:0,partner:0,manager:0,owner:0,
    missingPartnerRates:0,tax:0,
  };
  const pointSales=new Map();
  for(const page of reader.pages()){
    for(const order of page){
      const net=netPaidRevenue(order);
      if(net<=0)continue;
      totals.revenue+=net;
      totals.orders++;
      totals.tax+=Math.round(net*POINT_SALES_TAX_RATE*100)/100;
      if(order.commission_rate==null)totals.missingPartnerRates++;
      else totals.partner+=net*Number(order.commission_rate||0);
      totals.manager+=net*(rates.manager.get(order.point_id)||0);
      totals.owner+=net*(rates.owner.get(order.point_id)||0);
      if(order.point_id){
        const point=pointSales.get(order.point_id)||{revenue:0,orders:0,tax:0};
        point.revenue+=net;
        point.orders++;
        point.tax+=Math.round(net*POINT_SALES_TAX_RATE*100)/100;
        pointSales.set(order.point_id,point);
      }
    }
    payout.addPage(page);
  }
  const revenue=Math.round(totals.revenue),count=totals.orders;
  return {
    sales:{revenue,orders:count,avg_check:count?Math.round(revenue/count):0},
    financeTotals:totals,
    pointSales,pointFinance:payout.finish(),
  };
}
module.exports={collectCurrentFounderSales};
