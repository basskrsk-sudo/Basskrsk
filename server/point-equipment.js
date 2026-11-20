'use strict';

// Equipment installed at the FIRST launch of a sales point.
// This is a planning/capex attribute, not a booking in the actual P&L.
// Historic points remain "unknown" until someone verifies their launch setup.
const EQUIPMENT = Object.freeze({
  none: {label:'Без стойки и полки ХвостМаркета',cost:0},
  large_stand: {label:'Большая стойка ХвостМаркета',cost:5000},
  small_stand: {label:'Маленькая стойка ХвостМаркета',cost:2500},
  shelf: {label:'Полка ХвостМаркета',cost:null},
});
const STANDARD_LARGE_STAND_COST = 5000;
const {ESTIMATED_COST_SHARE,POINT_SALES_TAX_RATE}=require('./point-economics-rates');
const {loadPointPayoutProfit}=require('./point-period-finance');
const roundMoney = value => Math.round(Number(value||0)*100)/100;
const MAX_SHELF_COST = 1000000;
function invalid(message){
  const e=new Error(message); e.statusCode=400;e.code='INVALID_POINT_EQUIPMENT'; return e;
}
function normalizePointEquipment(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw invalid('Выберите оснащение при запуске точки');
  const type=value.type;
  if(typeof type!=='string'||!Object.prototype.hasOwnProperty.call(EQUIPMENT,type))
    throw invalid('Неизвестный вид оснащения');
  const def=EQUIPMENT[type];
  if(type==='shelf'){
    const candidate=value.shelf_cost;
    if (candidate===null||candidate===undefined||candidate==='' ||
      typeof candidate==='boolean'||!Number.isSafeInteger(Number(candidate))||
      Number(candidate)<0||Number(candidate)>MAX_SHELF_COST) {
      throw invalid('Укажите фактическую стоимость полки в целых рублях (можно 0, если получена бесплатно)');
    }
    return {type,cost:Number(candidate),label:def.label};
  }
  if(value.shelf_cost!==undefined && value.shelf_cost!==null && value.shelf_cost!=='') {
    // Any cost spoofing on a fixed-price type must be rejected.
    if(Number(value.shelf_cost)!==def.cost)throw invalid('Стоимость стойки фиксирована; для варианта без оснащения — 0 ₽');
  }
  return {type,cost:def.cost,label:def.label};
}
function equipmentLabel(type) { return EQUIPMENT[type]?.label || 'Не указано'; }
function equipmentFromRow(row){
  return {
    type:row?.type||null,
    cost:row?.type?Number(row.cost):null,
    label:equipmentLabel(row?.type),
    updated_at:row?.updated_at||null,
    updated_by:row?.updated_by||null,
  };
}
function getPointEquipment(database,pointId){
  const row=database.prepare('SELECT type,cost,updated_at,updated_by FROM point_launch_equipment WHERE point_id=?')
    .get(pointId);
  return equipmentFromRow(row);
}
function listPointEquipment(database){
  return database.prepare(
    'SELECT p.id AS point_id,p.name AS point_name,p.city_id,p.is_hub,p.active,'+
    'e.type,e.cost,e.updated_at,e.updated_by FROM points p '+
    'LEFT JOIN point_launch_equipment e ON e.point_id=p.id '+
    'WHERE COALESCE(p.is_hub,0)=0 ORDER BY p.name COLLATE NOCASE,p.id'
  ).all().map(p=>({
    point_id:p.point_id,point_name:p.point_name,city_id:p.city_id,active:!!p.active,
    ...equipmentFromRow(p),
  }));
}
// Requires an active BEGIN IMMEDIATE owned by the caller.
// Prevents history entries for no-op resubmissions and is safe inside point creation.
function savePointEquipmentInTransaction(database,pointId,input,actor) {
  const normalized=normalizePointEquipment(input);
  const point=database.prepare('SELECT id,name FROM points WHERE id=?').get(pointId);
  if(!point){const e=new Error('Точка не найдена');e.statusCode=404;throw e;}
  const before=getPointEquipment(database,pointId);
  if(before.type===normalized.type&&before.cost===normalized.cost)
    return {...before,changed:false};
  const updatedBy=String(actor?.login||'администратор').slice(0,120);
  database.prepare(
    "INSERT INTO point_launch_equipment(point_id,type,cost,updated_by,updated_at) "+
    "VALUES(?,?,?,?,datetime('now')) ON CONFLICT(point_id) DO UPDATE SET "+
    "type=excluded.type,cost=excluded.cost,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).run(pointId,normalized.type,normalized.cost,updatedBy);
  database.prepare(
    'INSERT INTO point_launch_equipment_log(point_id,previous_type,previous_cost,new_type,new_cost,admin_id,admin_login) '+
    'VALUES(?,?,?,?,?,?,?)'
  ).run(pointId,before.type,before.cost,normalized.type,normalized.cost,actor?.id||null,updatedBy);
  return {...getPointEquipment(database,pointId),changed:true};
}
function savePointEquipment(database,pointId,input,actor){
  // Project uses node:sqlite DatabaseSync (no better-sqlite3 .transaction()).
  // Explicit write transaction protects both the setting and the audit event.
  database.exec('BEGIN IMMEDIATE');
  try {
    const result=savePointEquipmentInTransaction(database,pointId,input,actor);
    database.exec('COMMIT');
    return result;
  }catch(error){
    try{database.exec('ROLLBACK');}catch(_){}
    throw error;
  }
}

// Uniform factual point-launch valuation, whether or not the point has
// equipment. The global 15,000/20,000-RUB planning baseline is NOT an expense.
// Initial goods come from approved pre-sale movements, and 50% of current
// retail is used for missing historical purchase costs as an estimate.

function estimatePointLaunchCost(item, assumptions, contribution, initialGoods = null, launchBonus = null){
  // Same factual components for ALL points. Never inject default 15k/20k
  // theoretical opening expenses for salons that have no evidence of them.
  const hasEquipment=!!item.type;
  const hasGoods=Number(initialGoods?.movement_count||0)>0;
  const goodsKnown=Math.max(0,Number(initialGoods?.known_value||0));
  const goodsEstimated=Math.max(0,Number(initialGoods?.estimated_value||0));
  const missingQty=Number(initialGoods?.missing_cost_qty||0);
  const unpricedQty=Number(initialGoods?.unpriced_qty||0);
  const managerBonus=Number(launchBonus?.manager_bonus||0);
  const groomerBonus=Number(launchBonus?.groomer_bonus||0);
  const ownerBonus=Number(launchBonus?.owner_bonus||0);
  const bonusTotal=managerBonus+groomerBonus+ownerBonus;
  const incomplete=!hasEquipment||!hasGoods||unpricedQty>0;
  const details={
    initial_goods_recorded:hasGoods,
    initial_goods_known_value:hasGoods?goodsKnown:null,
    initial_goods_estimated_value:hasGoods?goodsEstimated:null,
    initial_goods_total_estimate:hasGoods?Math.round((goodsKnown+goodsEstimated)*100)/100:null,
    initial_goods_missing_cost_qty:hasGoods?missingQty:null,
    initial_goods_missing_cost_variants:hasGoods?Number(initialGoods?.missing_cost_variants||0):null,
    initial_goods_unpriced_qty:hasGoods?unpricedQty:null,
    launch_manager_bonus:managerBonus,
    launch_groomer_bonus:groomerBonus,
    launch_owner_bonus:ownerBonus,
    launch_bonus_total:bonusTotal,
    launch_bonus_referral_role:launchBonus?.referral_role||null,
    estimated_investment_incomplete:incomplete,
    estimated_investment_uses_fallback:hasGoods&&missingQty>0,
  };
  // With no recorded initial shipment and no installed equipment, there is
  // no sound basis to claim a total. Bonuses still appear in their columns.
  if(!hasGoods&&(!hasEquipment||item.type==='none'))
    return {...item,...details,other_launch_cost:0,
      estimated_launch_cost:null,estimated_investment:null,
      estimated_payback_months:null,estimated_orders_to_payback:null};
  const launchCost=(hasEquipment?Number(item.cost||0):0)+goodsKnown+goodsEstimated;
  const investment=Math.round((launchCost+bonusTotal)*100)/100;
  const monthly=Number(contribution.monthly_contribution_per_point||0);
  const perOrder=Number(contribution.contribution_per_order||0);
  return {...item,...details,other_launch_cost:0,
    estimated_launch_cost:Math.round(launchCost*100)/100,
    estimated_investment:investment,
    estimated_payback_months:!incomplete&&monthly>0?Math.round(investment/monthly*10)/10:null,
    estimated_orders_to_payback:!incomplete&&perOrder>0?Math.ceil(investment/perOrder):null};
}

// Batched read of attribution; this remains a PLANNED one-time bonus budget,
// not evidence of an accrual or transfer. Split 2,000 into 1,000 manager
// and 1,000 referring partner when an inviter is recorded. Do not touch ledgers.
function loadPointLaunchBonusAllocations(database,assumptions){
  const budget=Math.max(0,Number(assumptions.manager_launch_bonus||0));
  const records=database.prepare(`
    SELECT p.id AS point_id,mp.id AS manager_point_id,
      mp.referred_groomer_id,mp.referred_groomer_amount,
      mp.referred_owner_id,mp.referred_owner_amount,
      pr.role AS referral_role,pr.recipient_id AS referral_recipient_id,
      pr.amount AS referral_amount
    FROM points p
    LEFT JOIN manager_points mp ON mp.id=(
      SELECT m.id FROM manager_points m WHERE m.point_id=p.id ORDER BY m.id LIMIT 1)
    LEFT JOIN point_referrals pr ON pr.point_id=p.id
    WHERE COALESCE(p.is_hub,0)=0
  `).all();
  return new Map(records.map(row=>{
    const registered=row.referral_recipient_id!=null&&
      ['partner','owner'].includes(row.referral_role)?row.referral_role:null;
    const legacy=row.referred_groomer_id!=null?'partner':
      row.referred_owner_id!=null?'owner':null;
    const role=registered||legacy;
    const oldAmount=role==='partner'?row.referred_groomer_amount:row.referred_owner_amount;
    const recordedAmount=registered?row.referral_amount:oldAmount;
    const referral=role?Math.min(budget,Math.max(0,Number(recordedAmount??1000))):0;
    return [row.point_id,{
      manager_bonus:row.manager_point_id!=null?Math.max(0,budget-referral):0,
      groomer_bonus:role==='partner'?referral:0,
      owner_bonus:role==='owner'?referral:0,
      referral_role:role,
    }];
  }));
}
// One aggregate query for all points: approved deliveries before the first
// paid order, excluding later replenishment. Missing purchase cost is modeled
// as half current retail price (not a historical supplier invoice).
function loadInitialGoodsValuation(database){
  return new Map(database.prepare(`
    SELECT sm.point_id,
      COUNT(DISTINCT sm.id) AS movement_count,
      ROUND(SUM(CASE WHEN v.cost_price IS NOT NULL AND v.cost_price >= 0
        THEN smi.qty * v.cost_price ELSE 0 END),2) AS known_value,
      ROUND(SUM(CASE WHEN (v.cost_price IS NULL OR v.cost_price < 0) AND v.price >= 0
        THEN smi.qty * v.price * ${ESTIMATED_COST_SHARE} ELSE 0 END),2) AS estimated_value,
      SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN smi.qty ELSE 0 END) AS missing_cost_qty,
      SUM(CASE WHEN (v.cost_price IS NULL OR v.cost_price < 0) AND
        (v.price IS NULL OR v.price < 0)
        THEN smi.qty ELSE 0 END) AS unpriced_qty,
      COUNT(DISTINCT CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN smi.variant_id END) AS missing_cost_variants
    FROM stock_movements sm
    JOIN stock_movement_items smi ON smi.movement_id=sm.id
    LEFT JOIN product_variants v ON v.id=smi.variant_id
    LEFT JOIN (
      SELECT point_id,MIN(created_at) AS first_paid_at
      FROM orders WHERE status='paid' GROUP BY point_id
    ) first_sale ON first_sale.point_id=sm.point_id
    WHERE sm.status='approved' AND smi.qty>0
      AND (first_sale.first_paid_at IS NULL OR sm.reported_at<first_sale.first_paid_at)
    GROUP BY sm.point_id
  `).all().map(row=>[row.point_id,row]));
}
// Current stock valuation: catalog cost if known, otherwise 50% retail.
// Separate the estimated share; never write an estimated cost to the catalog.
function loadPointInventoryValuation(database){
  return new Map(database.prepare(`
    SELECT s.point_id, SUM(s.qty) AS qty,
      ROUND(SUM(CASE WHEN v.cost_price IS NOT NULL AND v.cost_price >= 0
        THEN s.qty * v.cost_price ELSE 0 END),2) AS known_value,
      ROUND(SUM(CASE WHEN (v.cost_price IS NULL OR v.cost_price < 0) AND v.price >= 0
        THEN s.qty * v.price * ${ESTIMATED_COST_SHARE} ELSE 0 END),2) AS estimated_value,
      SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN s.qty ELSE 0 END) AS missing_cost_qty,
      SUM(CASE WHEN (v.cost_price IS NULL OR v.cost_price < 0) AND
        (v.price IS NULL OR v.price < 0)
        THEN s.qty ELSE 0 END) AS unpriced_qty,
      SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN 1 ELSE 0 END) AS missing_cost_variants
    FROM stock s
    JOIN product_variants v ON v.id=s.variant_id
    JOIN points p ON p.id=s.point_id
    WHERE s.qty > 0 AND COALESCE(p.is_hub,0)=0
    GROUP BY s.point_id
  `).all().map(row=>[row.point_id,row]));
}
function buildPointEquipmentEconomics(database,assumptions,contribution,orders=[],period=null){
  const inventoryByPoint=loadPointInventoryValuation(database);
  const initialGoodsByPoint=loadInitialGoodsValuation(database);
  const bonusByPoint=loadPointLaunchBonusAllocations(database,assumptions);
  const financeByPoint=loadPointPayoutProfit(database,orders,assumptions,period);
  const sales=new Map();
  // Reuse already fetched anonymized paid orders for founder dashboards.
  // Tax each paid sale separately (to kopecks) on its net amount after refunds.
  // A full refund contributes zero revenue and zero tax.
  for(const order of orders){
    if(!order.point_id)continue;
    const item=sales.get(order.point_id)||{revenue:0,orders:0,tax:0};
    if(order.net_revenue!==undefined){
      // For aggregated historical inputs individual-sale rounding cannot be
      // reconstructed; use the grouped total as an explicit approximation.
      const amount=Math.max(0,Number(order.net_revenue||0));
      item.revenue+=amount;
      item.tax+=roundMoney(amount*POINT_SALES_TAX_RATE);
      item.orders+=Number(order.net_orders||0);
    }else{
      const amount=order.refund_status==='refunded'
        ?0:Math.max(0,Number(order.total||0)-Number(order.refunded_amount||0));
      if(amount<=0)continue;
      item.revenue+=amount;
      item.tax+=roundMoney(amount*POINT_SALES_TAX_RATE);
      item.orders+=1;
    }
    sales.set(order.point_id,item);
  }
  const dateStart=period&&period.from?Date.parse(period.from.replace(' ','T')+'Z'):NaN;
  const dateEnd=period&&period.to?Date.parse(period.to.replace(' ','T')+'Z'):NaN;
  const days=Number.isFinite(dateStart)&&Number.isFinite(dateEnd)&&dateEnd>dateStart
    ? Math.max(1,(dateEnd-dateStart)/86400000):null;
  // calculateUnitEconomics already deducts the configured tax rate (often 6%).
  // Replace that component with 7%; never charge 6% AND 7% together.
  const marginBeforeTax=(Number(contribution.contribution_margin_percent||0)+
    Number(assumptions.tax_percent||0))/100;
  const marginAfterTax=marginBeforeTax-POINT_SALES_TAX_RATE;
  // The launch-estimate payback fields must use the same 7%-tax-adjusted
  // contribution as the actual-period payback; otherwise the API returns
  // contradictory 6% and 7% results for one point.
  const modelOrderRevenue=Number(contribution.revenue_per_order ?? assumptions.average_order_value ?? 0);
  const modelMonthlyRevenue=Number(contribution.monthly_revenue_per_point ??
    modelOrderRevenue*Number(assumptions.monthly_orders_per_point||0));
  const afterTaxContribution={
    ...contribution,
    contribution_per_order:roundMoney(modelOrderRevenue*marginAfterTax),
    monthly_contribution_per_point:roundMoney(modelMonthlyRevenue*marginAfterTax),
  };
  const points=listPointEquipment(database).map(row=>{
    const base=estimatePointLaunchCost(row,assumptions,afterTaxContribution,
      initialGoodsByPoint.get(row.point_id),bonusByPoint.get(row.point_id));
    const actual=sales.get(row.point_id)||{revenue:0,orders:0,tax:0};
    const monthlyRevenue=days?actual.revenue/days*30.4375:null;
    const monthlyContribution=monthlyRevenue===null?null:monthlyRevenue*marginAfterTax;
    const beforeTax=roundMoney(actual.revenue*marginBeforeTax);
    const tax=roundMoney(actual.tax);
    const afterTax=roundMoney(beforeTax-tax);
    const finance=financeByPoint.get(row.point_id)||{};
    // Earnings from period sales after both actual recorded transfers and
    // still outstanding commissions. Do NOT subtract transfers again.
    const ownerProfit=Number(finance.founder_profit_est||0);
    const projectedMonthlyOwnerProfit=days?ownerProfit/days*30.4375:null;
    const payback=base.estimated_investment!=null&&!base.estimated_investment_incomplete&&
      projectedMonthlyOwnerProfit>0
      ? Math.round(base.estimated_investment/projectedMonthlyOwnerProfit*10)/10:null;
    const inventory=inventoryByPoint.get(row.point_id)||{};
    const inventoryQty=Number(inventory.qty||0);
    const inventoryMissingQty=Number(inventory.missing_cost_qty||0);
    const inventoryKnownValue=Number(inventory.known_value||0);
    const inventoryEstimatedValue=Number(inventory.estimated_value||0);
    const inventoryUnpricedQty=Number(inventory.unpriced_qty||0);
    return {...base,
      partner_accrued:Number(finance.partner_accrued||0),
      partner_paid:Number(finance.partner_paid||0),
      partner_pending:Number(finance.partner_pending||0),
      partner_refund_hold:Number(finance.partner_refund_hold||0),
      owner_accrued:Number(finance.owner_accrued||0),
      owner_paid:Number(finance.owner_paid||0),
      owner_pending:Number(finance.owner_pending||0),
      owner_refund_hold:Number(finance.owner_refund_hold||0),
      profit_cogs_est:Number(finance.profit_cogs||0),
      profit_manager_est:Number(finance.profit_manager_est||0),
      profit_other_costs_est:Number(finance.profit_other_costs_est||0),
      profit_missing_item_orders:Number(finance.profit_missing_item_orders||0),
      profit_fallback_item_qty:Number(finance.profit_fallback_item_qty||0),
      commission_refund_review_orders:Number(finance.commission_refund_review_orders||0),
      founder_profit_est:ownerProfit,
      projected_monthly_founder_profit:projectedMonthlyOwnerProfit===null?null:
        roundMoney(projectedMonthlyOwnerProfit),
      inventory_qty:inventoryQty,
      inventory_known_value:inventoryKnownValue,
      inventory_estimated_value:inventoryEstimatedValue,
      inventory_valuation:inventoryUnpricedQty>0?null:
        Math.round((inventoryKnownValue+inventoryEstimatedValue)*100)/100,
      inventory_unpriced_qty:inventoryUnpricedQty,
      inventory_missing_cost_qty:inventoryMissingQty,
      inventory_missing_cost_variants:Number(inventory.missing_cost_variants||0),
      period_revenue:Math.round(actual.revenue*100)/100,
      period_orders:actual.orders,
      period_average_check:actual.orders?Math.round(actual.revenue/actual.orders):0,
      period_tax_est:tax,
      estimated_period_contribution_before_tax:beforeTax,
      estimated_period_contribution:afterTax,
      projected_monthly_contribution:monthlyContribution===null?null:roundMoney(monthlyContribution),
      payback_months_at_current_pace:payback,
    };
  });
  points.sort((a,b)=>b.period_revenue-a.period_revenue||a.point_name.localeCompare(b.point_name,'ru'));
  const configured=points.filter(p=>p.type);
  return {
    assumption:'ВСЕ точки оцениваются одинаково: фактически выбранное оборудование + стартовая выкладка из подтверждённых перемещений ДО первой оплаченной продажи + модельные разовые бонусы менеджеру и пригласившему грумеру/владельцу. Общие условные расходы 15 000 ₽ и 20 000 ₽ не применяются. Для товара без закупочной цены берём 50% розничной цены; последующие пополнения не включаем. Без подтверждения первоначальных поставок выводим нижний предел («от») или прочерк — вымышленных затрат нет. Бюджет запуска обычно 2 000 ₽: без приглашения менеджеру 2 000 ₽, с приглашением 1 000 ₽ менеджеру и 1 000 ₽ партнёру, без двойного учёта.',
    inventory_disclaimer:'Для товаров с указанной закупочной ценой используется она. Для товаров без закупочной цены применяется модельная себестоимость = цена продажи / 2 (50%), такая часть показывается отдельно и не записывается как фактическая закупка. Начальная выкладка берётся из подтверждённых перемещений до первой продажи; текущие остатки показываются отдельно. Для старых поставок используются сегодняшние цены каталога, а не историческая цена покупки. При консигнации товар может принадлежать поставщику: это оценка размещения, не доказательство оплаты.',
    profit_disclaimer:'ПРИБЫЛЬ СОБСТВЕННИКОВ (ОЦЕНКА) = оплаченная выручка за выбранный период после возвратов − себестоимость проданных товаров − налог 7% − начисленные комиссии грумерам и владельцам (как выплаченные, так и ещё не выплаченные) − модельные расходы на менеджера, эквайринг, логистику, списания и IT. Фактические переводы берутся из реестра выплат по заказам периода; они не вычитаются повторно при выплате. Удержанные из-за возвратов комиссии показаны отдельно для сверки и консервативно учтены в оценке. Себестоимость берётся из текущего каталога, при отсутствии закупочной цены = 50% розничной; если строки заказа не сохранились, 50% оплаченной суммы. Ключевые суммы остаются модельными: без общесетевых постоянных расходов, зарплат учредителей, бухгалтерских корректировок, стоимости оборудования и разовых затрат на открытие. Это НЕ фактическая прибыль и НЕ бухгалтерская прибыль. Вклад за период и прибыль собственников могут отличаться: вклад использует типовые проценты комиссий, прибыль — начисления и реестры выплат конкретных точек.',
    equipment_prices:{large_stand:5000,small_stand:2500,none:0,shelf:'вручную'},
    baseline_launch_cost:assumptions.launch_cost,
    baseline_other_launch_cost:Math.max(0,Number(assumptions.launch_cost)-5000),
    manager_launch_bonus:assumptions.manager_launch_bonus,
    model_contribution_margin_percent:Math.round(marginAfterTax*10000)/100,
    model_tax_rate_percent:Math.round(POINT_SALES_TAX_RATE*10000)/100,
    period:period?{key:period.key,from:period.from,to:period.to}:null,
    points,
    summary:{
      configured:configured.length,unknown:points.length-configured.length,
      equipment_cost:configured.reduce((total,row)=>total+row.cost,0),
      estimated_launch_cost:Math.round(points.reduce((total,row)=>total+Number(row.estimated_launch_cost||0),0)*100)/100,
      estimated_investment:Math.round(points.reduce((total,row)=>total+Number(row.estimated_investment||0),0)*100)/100,
      incomplete_launch_points:points.filter(row=>row.estimated_investment_incomplete).length,
      launch_manager_bonus:points.reduce((total,row)=>total+row.launch_manager_bonus,0),
      launch_groomer_bonus:points.reduce((total,row)=>total+row.launch_groomer_bonus,0),
      launch_owner_bonus:points.reduce((total,row)=>total+row.launch_owner_bonus,0),
      inventory_qty:points.reduce((sum,row)=>sum+row.inventory_qty,0),
      inventory_known_value:Math.round(points.reduce((sum,row)=>sum+row.inventory_known_value,0)*100)/100,
      inventory_estimated_value:Math.round(points.reduce((sum,row)=>sum+row.inventory_estimated_value,0)*100)/100,
      inventory_valuation:points.some(row=>row.inventory_unpriced_qty>0)?null:
        Math.round(points.reduce((sum,row)=>sum+Number(row.inventory_valuation||0),0)*100)/100,
      inventory_unpriced_qty:points.reduce((sum,row)=>sum+row.inventory_unpriced_qty,0),
      inventory_missing_cost_qty:points.reduce((sum,row)=>sum+row.inventory_missing_cost_qty,0),
      inventory_missing_cost_variants:points.reduce((sum,row)=>sum+row.inventory_missing_cost_variants,0),
      total_points:points.length,
      period_revenue:roundMoney(points.reduce((sum,row)=>sum+row.period_revenue,0)),
      period_orders:points.reduce((sum,row)=>sum+row.period_orders,0),
      period_tax_est:roundMoney(points.reduce((sum,row)=>sum+row.period_tax_est,0)),
      partner_accrued:roundMoney(points.reduce((sum,row)=>sum+row.partner_accrued,0)),
      partner_paid:roundMoney(points.reduce((sum,row)=>sum+row.partner_paid,0)),
      partner_pending:roundMoney(points.reduce((sum,row)=>sum+row.partner_pending,0)),
      partner_refund_hold:roundMoney(points.reduce((sum,row)=>sum+row.partner_refund_hold,0)),
      owner_accrued:roundMoney(points.reduce((sum,row)=>sum+row.owner_accrued,0)),
      owner_paid:roundMoney(points.reduce((sum,row)=>sum+row.owner_paid,0)),
      owner_pending:roundMoney(points.reduce((sum,row)=>sum+row.owner_pending,0)),
      owner_refund_hold:roundMoney(points.reduce((sum,row)=>sum+row.owner_refund_hold,0)),
      founder_profit_est:roundMoney(points.reduce((sum,row)=>sum+row.founder_profit_est,0)),
      profit_cogs_est:roundMoney(points.reduce((sum,row)=>sum+row.profit_cogs_est,0)),
      profit_manager_est:roundMoney(points.reduce((sum,row)=>sum+row.profit_manager_est,0)),
      profit_other_costs_est:roundMoney(points.reduce((sum,row)=>sum+row.profit_other_costs_est,0)),
      profit_missing_item_orders:points.reduce((sum,row)=>sum+row.profit_missing_item_orders,0),
      profit_fallback_item_qty:points.reduce((sum,row)=>sum+row.profit_fallback_item_qty,0),
      commission_refund_review_orders:points.reduce((sum,row)=>sum+row.commission_refund_review_orders,0),
      estimated_period_contribution_before_tax:roundMoney(
        points.reduce((sum,row)=>sum+row.estimated_period_contribution_before_tax,0)),
      estimated_period_contribution:roundMoney(
        points.reduce((sum,row)=>sum+row.estimated_period_contribution,0)),
    },
  };
}
module.exports={
  EQUIPMENT,STANDARD_LARGE_STAND_COST,ESTIMATED_COST_SHARE,POINT_SALES_TAX_RATE,
  normalizePointEquipment,equipmentLabel,equipmentFromRow,getPointEquipment,
  listPointEquipment,savePointEquipmentInTransaction,savePointEquipment,
  estimatePointLaunchCost,buildPointEquipmentEconomics,
};
