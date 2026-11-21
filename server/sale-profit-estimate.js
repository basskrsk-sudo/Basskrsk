'use strict';
// One paid-order management estimate. Shared between the private superadmin
// Telegram message and the on-demand admin order drilldown. NO writes.
// Assumptions match point-period-finance.js (tax 7%, fallback COGS 50%).
const {POINT_SALES_TAX_RATE,ESTIMATED_COST_SHARE}=require('./point-economics-rates');
const {visibleOrderNumber}=require('./order-display-number');
const rub=value=>Math.round((Number(value)||0)*100)/100;
const num=value=>Number.isFinite(Number(value))?Number(value):0;
const payout=value=>Math.round(num(value));
const PCT=value=>num(value)/100;

function loadSaleProfitEstimate(database,order,assumptions=null){
  if(!order||order.status!=='paid'||!Number.isSafeInteger(Number(order.id)))
    throw new RangeError('Расчёт доступен только для оплаченного заказа');
  // Query catalog ONLY when explicitly requested or after confirmed payment.
  // The original order line price is kept; catalog cost can have changed.
  const items=database.prepare(
    'SELECT oi.name,oi.weight,oi.qty,oi.price,oi.is_custom,'+
    'v.cost_price,v.price AS variant_price '+
    'FROM order_items oi LEFT JOIN product_variants v ON v.id=oi.variant_id '+
    'WHERE oi.order_id=? ORDER BY oi.id'
  ).all(order.id);
  const rates=database.prepare(
    'SELECT '+
    '(SELECT commission_rate FROM partners WHERE id=?) AS partner_rate,'+
    '(SELECT commission_rate FROM salon_owners WHERE point_id=? AND active=1 '+
    'ORDER BY id DESC LIMIT 1) AS salon_rate,'+
    '(SELECT commission_amount FROM partner_payout_items WHERE order_id=? LIMIT 1) AS partner_paid,'+
    '(SELECT commission_amount FROM owner_payout_items WHERE order_id=? LIMIT 1) AS salon_paid'
  ).get(order.partner_id,order.point_id,order.id,order.id);
  const setting=assumptions||require('./unit-economics').getUnitEconomicsSettings().assumptions;
  const shares=database.prepare(
    'SELECT full_name,share_percent FROM business_founders ORDER BY id'
  ).all();
  const total=num(order.total);
  const net=order.refund_status==='refunded'?0:Math.max(0,total-num(order.refunded_amount));
  const factor=total>0?Math.min(1,net/total):0;
  let fallbackQty=0,rawCost=0;
  const lines=items.map(i=>{
    const qty=num(i.qty);
    const known=i.cost_price!=null&&num(i.cost_price)>=0&&Number.isFinite(Number(i.cost_price));
    const unitCost=known?num(i.cost_price):num(i.variant_price??i.price)*ESTIMATED_COST_SHARE;
    if(!known)fallbackQty+=qty;
    rawCost+=qty*unitCost;
    return {name:String(i.name||'Товар'),weight:String(i.weight||''),qty,
      price:num(i.price),unit_cost:rub(unitCost),cost_estimated:!known,
      net_cost:rub(qty*unitCost*factor)};
  });
  const missingItems=items.length===0&&net>0;
  const cogs=net<=0?0:missingItems?net*ESTIMATED_COST_SHARE:rawCost*factor;
  const rate=order.commission_rate==null?num(rates.partner_rate):num(order.commission_rate);
  const salonRate=rates.salon_rate==null?0:num(rates.salon_rate);
  // Existing paid transfers are respected. With no ledger entry, use the
  // same unrounded/net per-order commission logic as founder point finance.
  const partnerCommission=rates.partner_paid!=null?num(rates.partner_paid):
    order.partner_id!=null?payout(net*rate):0;
  const salonCommission=rates.salon_paid!=null?num(rates.salon_paid):
    rates.salon_rate!=null?payout(net*salonRate):0;
  const tax=rub(net*POINT_SALES_TAX_RATE);
  const manager=rub(net*PCT(setting.manager_commission_percent));
  const acquiring=rub(net*PCT(setting.acquiring_percent));
  const logistics=rub(net*PCT(setting.logistics_percent));
  // Compute in raw precision before one final rounding; do not add
  // suspended write-off/IT reserves or invented overhead allocations.
  const profit=rub(net-cogs-tax-partnerCommission-salonCommission-
    net*(PCT(setting.manager_commission_percent)+PCT(setting.acquiring_percent)+
         PCT(setting.logistics_percent)));
  const totalShares=shares.reduce((acc,f)=>acc+num(f.share_percent),0);
  const splitValid=shares.length>0&&Math.abs(totalShares-100)<0.00001;
  let cents=Math.round(profit*100);
  const owners=splitValid?shares.map((f,index)=>{
    const share=num(f.share_percent);
    const allocated=index===shares.length-1?cents:Math.round(profit*share);
    cents-=allocated;
    return {name:String(f.full_name||''),share_percent:share,profit_est:allocated/100};
  }):[];
  return {
    order_id:Number(order.id),order_number:visibleOrderNumber(order),
    point_name:String(order.pickup_point||''),partner_name:String(order.partner_name||''),
    created_at:String(order.created_at||''),status:'paid',
    original_total:rub(total),revenue:rub(net),refund_amount:rub(total-net),
    refund_status:String(order.refund_status||'none'),
    items:lines,items_missing:missingItems,fallback_item_qty:fallbackQty,
    cogs_est:rub(cogs),partner_commission:rub(partnerCommission),
    partner_rate_percent:rub(rate*100),salon_commission:rub(salonCommission),
    salon_rate_percent:rub(salonRate*100),
    tax_est:tax,tax_rate_percent:rub(POINT_SALES_TAX_RATE*100),
    manager_est:manager,manager_rate_percent:rub(num(setting.manager_commission_percent)),
    acquiring_est:acquiring,acquiring_rate_percent:rub(num(setting.acquiring_percent)),
    logistics_est:logistics,logistics_rate_percent:rub(num(setting.logistics_percent)),
    founder_profit_est:profit,founder_shares:owners,founder_split_available:splitValid,
    assumptions_note:'Управленческая оценка вклада заказа в результат проекта, не выплата собственникам. '+
      'Себестоимость — текущий каталог (если отсутствует, оценка 50%); '+
      'налог, эквайринг, менеджер и логистика — расчётные. '+
      'Постоянные расходы, бонусы, возвраты после отправки уведомления '+
      'и исторические изменения закупочной цены не включены.',
  };
}
module.exports={loadSaleProfitEstimate};
