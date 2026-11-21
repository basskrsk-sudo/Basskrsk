'use strict';

// Read-only founder analytics for paid orders in the selected SALES period.
// "Paid" means a transfer was recorded against an order in the payout ledger,
// even if the actual transfer occurred in a later calendar month.
// "Pending" is not a cash outflow; it is a commission liability.
// Refunded orders without a payout are kept for reconciliation, not treated as
// automatically payable. Never modify payout or order ledgers here.

const { POINT_SALES_TAX_RATE, ESTIMATED_COST_SHARE } = require('./point-economics-rates');
const rub = value => Math.round((Number(value)||0)*100)/100;
const payoutRub = value => Math.round(Number(value)||0);
const number = value => Number.isFinite(Number(value))?Number(value):0;
const empty = () => ({
  partner_accrued:0, partner_paid:0, partner_pending:0, partner_refund_hold:0,
  owner_accrued:0, owner_paid:0, owner_pending:0, owner_refund_hold:0,
  profit_revenue:0, profit_cogs:0, profit_tax:0,
  profit_manager_est:0, profit_other_costs_est:0,
  founder_profit_est:0, profit_missing_item_orders:0, profit_fallback_item_qty:0,
  commission_refund_review_orders:0,
});

function loadCommissionRateMaps(database){
  const partnerRates=new Map(database.prepare(
    'SELECT id,commission_rate FROM partners'
  ).all().map(r=>[Number(r.id),number(r.commission_rate)]));
  const ownerRates=new Map();
  // Newest active owner is the expected recipient of pending commission.
  for(const row of database.prepare(
    'SELECT point_id,commission_rate FROM salon_owners WHERE active=1 AND point_id IS NOT NULL ORDER BY id DESC'
  ).all()){
    if(!ownerRates.has(row.point_id))ownerRates.set(row.point_id,number(row.commission_rate));
  }
  return {partnerRates,ownerRates};
}

function loadPointPayoutProfit(database,orders,assumptions,period=null,options={}) {
  const includeOrderDetails=options.includeOrderDetails===true;
  const boundedSummary=options.boundedSummary===true;
  // Drilldown uses only the 20 selected sales. The new summary path accepts
  // up to 200 selected IDs per page; it never fetches year-long payout/cost
  // maps in one request. Legacy callers retain their existing behavior.
  const selectedIds=(includeOrderDetails||boundedSummary)
    ?orders.map(o=>Number(o.id)).filter(Number.isSafeInteger):[];
  if((includeOrderDetails||boundedSummary)&&!selectedIds.length)return new Map();
  if(boundedSummary&&selectedIds.length>200)
    throw new RangeError('Point finance batch exceeds 200 paid orders');
  const where=(includeOrderDetails||boundedSummary)
    ?' AND o.id IN ('+selectedIds.map(()=>'?').join(',')+')'
    :(period?.from && period?.to ? " AND o.created_at>=? AND o.created_at<?":'');
  const args=(includeOrderDetails||boundedSummary)?selectedIds:
    (where?[period.from,period.to]:[]);
  const fetchPaid=(table)=>{
    const data=database.prepare(
      `SELECT pi.order_id,pi.commission_amount FROM ${table} pi
       JOIN orders o ON o.id=pi.order_id
       WHERE o.status='paid'${where}`
    ).all(...args);
    return new Map(data.map(r=>[Number(r.order_id),number(r.commission_amount)]));
  };
  const partnerPaid=fetchPaid('partner_payout_items');
  const ownerPaid=fetchPaid('owner_payout_items');
  const {partnerRates,ownerRates}=options.rateMaps||loadCommissionRateMaps(database);
  const costs=new Map(database.prepare(
    `SELECT o.id AS order_id,
       SUM(oi.qty * CASE
         WHEN v.cost_price IS NOT NULL AND v.cost_price>=0 THEN v.cost_price
         ELSE COALESCE(v.price,oi.price,0)*${ESTIMATED_COST_SHARE}
       END) AS cogs,
       SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price<0 THEN oi.qty ELSE 0 END) AS fallback_qty,
       COUNT(*) AS item_count
     FROM orders o
     JOIN order_items oi ON oi.order_id=o.id
     LEFT JOIN product_variants v ON v.id=oi.variant_id
     WHERE o.status='paid'${where}
     GROUP BY o.id`
  ).all(...args).map(row=>[Number(row.order_id),row]));
  const itemsByOrder=new Map();
  if(includeOrderDetails){
    const placeholders=selectedIds.map(()=>'?').join(',');
    const detailItems=database.prepare(
      'SELECT oi.order_id,oi.name,oi.weight,oi.qty,oi.price,oi.is_custom,'+
      'v.cost_price,v.price AS variant_price FROM order_items oi '+
      'LEFT JOIN product_variants v ON v.id=oi.variant_id '+
      'WHERE oi.order_id IN ('+placeholders+') ORDER BY oi.order_id,oi.id'
    ).all(...selectedIds);
    for(const item of detailItems){
      const unitCost=item.cost_price!=null&&Number(item.cost_price)>=0
        ?Number(item.cost_price):
        number(item.variant_price??item.price)*ESTIMATED_COST_SHARE;
      const id=Number(item.order_id);
      const list=itemsByOrder.get(id)||[];
      list.push({name:String(item.name||'Товар'),weight:String(item.weight||''),
        qty:number(item.qty),unit_price:number(item.price),
        unit_cost:rub(unitCost),cost_estimated:!(item.cost_price!=null&&Number(item.cost_price)>=0),
        line_cost:unitCost*number(item.qty)});
      itemsByOrder.set(id,list);
    }
  }
  const results=new Map();
  // Only active variable expenses are deducted. The previous hypothetical
  // 1.5% write-off + 1.5% IT/other-bonuses reserves are suspended, even if
  // a stale settings object still contains their old percentages.
  const otherRate=(
    number(assumptions.manager_commission_percent)+
    number(assumptions.acquiring_percent)+
    number(assumptions.logistics_percent)
  )/100;
  const managerRate=number(assumptions.manager_commission_percent)/100;

  for(const order of orders){
    if(!order.point_id || order.net_revenue!==undefined)continue;
    const row=results.get(order.point_id)||empty();
    // The refund endpoint uses 'refunded' even for partial amounts.
    // The amount (when positive) is the source of truth for net revenue.
    const legacyFullRefund=order.refund_status==='refunded'&&number(order.refunded_amount)<=0;
    const net=legacyFullRefund?0:
      Math.max(0,number(order.total)-number(order.refunded_amount));
    const refund=order.refund_status==='refunded'||number(order.refunded_amount)>0;
    const id=Number(order.id);
    const ownerRecorded=ownerPaid.has(id),partnerRecorded=partnerPaid.has(id);
    const partnerRate=order.commission_rate==null
      ?(partnerRates.get(Number(order.partner_id))||0):number(order.commission_rate);
    const ownerRate=ownerRates.get(order.point_id)||0;
    const partnerPlanned=order.partner_id!=null&&!partnerRecorded ?
      payoutRub(net*partnerRate):0;
    const ownerPlanned=ownerRates.has(order.point_id)&&!ownerRecorded ?
      payoutRub(net*ownerRate):0;
    const partnerActual=partnerRecorded?partnerPaid.get(id):0;
    const ownerActual=ownerRecorded?ownerPaid.get(id):0;
    row.partner_paid+=partnerActual;
    row.owner_paid+=ownerActual;
    if(refund){
      row.partner_refund_hold+=partnerPlanned;
      row.owner_refund_hold+=ownerPlanned;
      if(partnerPlanned||ownerPlanned)row.commission_refund_review_orders++;
    }else{
      row.partner_pending+=partnerPlanned;
      row.owner_pending+=ownerPlanned;
    }
    row.partner_accrued+=partnerActual+partnerPlanned;
    row.owner_accrued+=ownerActual+ownerPlanned;
    row.profit_revenue+=net;
    const orderTax=rub(net*POINT_SALES_TAX_RATE);
    row.profit_tax+=orderTax;
    const c=costs.get(id);
    // When order lines were not retained, the 50% gross-cost fallback is
    // explicit. For refunds, only a proportional allocation is possible.
    let orderCogs=0;
    const refundFactor=number(order.total)>0?
      Math.min(1,net/number(order.total)):0;
    if(net>0){
      if(c?.item_count){
        orderCogs=number(c.cogs)*refundFactor;
        row.profit_cogs+=orderCogs;
        row.profit_fallback_item_qty+=number(c.fallback_qty);
      }else{
        orderCogs=net*ESTIMATED_COST_SHARE;
        row.profit_cogs+=orderCogs;
        row.profit_missing_item_orders++;
      }
    }
    if(includeOrderDetails){
      const rawItems=itemsByOrder.get(id)||[];
      const items=rawItems.map(item=>{
        const {line_cost,...safe}=item;
        return {...safe,net_cost:rub(line_cost*refundFactor)};
      });
      const partnerTotal=partnerActual+partnerPlanned;
      const ownerTotal=ownerActual+ownerPlanned;
      const managerCost=net*managerRate;
      const acquiring=net*number(assumptions.acquiring_percent)/100;
      const logistics=net*number(assumptions.logistics_percent)/100;
      const founderProfit=rub(net-orderCogs-orderTax-partnerTotal-ownerTotal-
        managerCost-acquiring-logistics);
      if(!row.order_details)row.order_details=[];
      row.order_details.push({
        id,number:String(order.display_number||order.order_code||'Заказ №'+id),
        created_at:String(order.created_at||''),
        partner_name:order.partner_id==null?null:String(order.partner_name||'Грумер'),
        total:number(order.total),
        refund_amount:rub(number(order.total)-net),
        revenue:rub(net),
        refund_status:String(order.refund_status||'none'),
        items,items_missing:items.length===0,
        item_cost_fallback_qty:number(c?.fallback_qty||0),
        cogs_est:rub(orderCogs),tax_est:orderTax,
        partner_paid:rub(partnerActual),
        partner_pending:refund?0:rub(partnerPlanned),
        partner_refund_hold:refund?rub(partnerPlanned):0,
        partner_total:rub(partnerTotal),
        partner_rate_percent:rub(partnerRate*100),
        owner_paid:rub(ownerActual),
        owner_pending:refund?0:rub(ownerPlanned),
        owner_refund_hold:refund?rub(ownerPlanned):0,
        owner_total:rub(ownerTotal),
        owner_rate_percent:rub(ownerRate*100),
        manager_est:rub(managerCost),
        acquiring_est:rub(acquiring),logistics_est:rub(logistics),
        // Keep legacy fields at zero for compatibility with older mini-app builds.
        writeoffs_est:0,it_est:0,
        founder_profit_est:founderProfit,
      });
    }
    row.profit_manager_est+=net*managerRate;
    row.profit_other_costs_est+=net*(otherRate-managerRate);
    results.set(order.point_id,row);
  }
  return options.rawResults===true?results:finalizePointProfit(results);
}
function finalizePointProfit(results) {
  for(const [pointId,raw] of results){
    for(const key of Object.keys(raw))if(key!=='profit_missing_item_orders'&&
      key!=='profit_fallback_item_qty'&&key!=='commission_refund_review_orders'&&
      key!=='order_details')
      raw[key]=rub(raw[key]);
    const totalCommission=raw.partner_paid+raw.partner_pending+raw.partner_refund_hold+
      raw.owner_paid+raw.owner_pending+raw.owner_refund_hold;
    raw.founder_profit_est=rub(raw.profit_revenue-raw.profit_cogs-raw.profit_tax-
      raw.profit_manager_est-raw.profit_other_costs_est-totalCommission);
    results.set(pointId,raw);
  }
  return results;
}

// Accumulate raw per-sale amounts across bounded pages, and only round once
// per point. This preserves the old annual/full-period arithmetic exactly.
function createPointPayoutProfitAccumulator(database,assumptions){
  const rateMaps=loadCommissionRateMaps(database);
  const totals=new Map();
  return {
    addPage(page){
      if(!Array.isArray(page)||page.length>200)
        throw new RangeError('Expected an array of at most 200 orders');
      if(!page.length)return;
      const part=loadPointPayoutProfit(database,page,assumptions,null,
        {boundedSummary:true,rateMaps,rawResults:true});
      for(const [pointId,row] of part){
        const total=totals.get(pointId)||empty();
        for(const key of Object.keys(total)){
          if(key==='founder_profit_est')continue;
          total[key]+=row[key];
        }
        totals.set(pointId,total);
      }
    },
    finish(){ return finalizePointProfit(totals); },
  };
}
module.exports={loadPointPayoutProfit,createPointPayoutProfitAccumulator};
