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

// Points without a HvostMarket stand/shelf have NO default 15,000 RUB
// "other costs": those were a planning assumption for outfitted salons,
// not evidenced expenditure at Sir Barsik or other no-equipment locations.
// Their initial product placement is valued from APPROVED stock movements
// before the first paid sale. Current stock and later restocking must not
// silently rewrite the original launch estimate.
// Historical prices are not snapshotted in older movements; use current
// catalog cost_price and clearly flag missing prices as a lower bound.
function estimatePointLaunchCost(item, assumptions, contribution, initialGoods = null){
  const noEquipment=item.type==='none';
  const hasGoods=Number(initialGoods?.movement_count||0)>0;
  const goodsKnown=Math.max(0,Number(initialGoods?.known_value||0));
  const missingQty=Number(initialGoods?.missing_cost_qty||0);
  const initialDetails={
    initial_goods_recorded:hasGoods,
    initial_goods_known_value:hasGoods?goodsKnown:null,
    initial_goods_missing_cost_qty:hasGoods?missingQty:null,
    initial_goods_missing_cost_variants:hasGoods?Number(initialGoods?.missing_cost_variants||0):null,
    estimated_investment_incomplete:noEquipment&&hasGoods&&missingQty>0,
  };
  if(!item.type || (noEquipment&&!hasGoods))
    return {...item,...initialDetails,other_launch_cost:null,
      estimated_launch_cost:null,estimated_investment:null,
      estimated_payback_months:null,estimated_orders_to_payback:null};
  const baseOther=noEquipment
    ?0:Math.max(0,Number(assumptions.launch_cost||0)-STANDARD_LARGE_STAND_COST);
  const launchCost=baseOther+Number(item.cost||0)+(noEquipment?goodsKnown:0);
  const investment=Math.round((launchCost+Number(assumptions.manager_launch_bonus||0))*100)/100;
  const monthly=Number(contribution.monthly_contribution_per_point||0);
  const perOrder=Number(contribution.contribution_per_order||0);
  return {...item,...initialDetails,other_launch_cost:baseOther,
    estimated_launch_cost:Math.round(launchCost*100)/100,
    estimated_investment:investment,
    estimated_payback_months:!initialDetails.estimated_investment_incomplete && monthly>0
      ?Math.round(investment/monthly*10)/10:null,
    estimated_orders_to_payback:!initialDetails.estimated_investment_incomplete && perOrder>0
      ?Math.ceil(investment/perOrder):null};
}

// One aggregate query for all points; includes multiple approved deliveries
// before first paid order and excludes later replenishment. Never infer a
// historical purchase price for a SKU without catalog cost data.
function loadInitialGoodsValuation(database){
  return new Map(database.prepare(`
    SELECT sm.point_id,
      COUNT(DISTINCT sm.id) AS movement_count,
      ROUND(SUM(CASE WHEN v.cost_price IS NOT NULL AND v.cost_price >= 0
        THEN smi.qty * v.cost_price ELSE 0 END),2) AS known_value,
      SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN smi.qty ELSE 0 END) AS missing_cost_qty,
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
// Point stock valuation is a CURRENT inventory snapshot (not a booking or cash expense).
// A single SQL aggregate covers the entire network; unknown prices stay unknown.
function loadPointInventoryValuation(database){
  return new Map(database.prepare(`
    SELECT s.point_id, SUM(s.qty) AS qty,
      ROUND(SUM(CASE WHEN v.cost_price IS NOT NULL AND v.cost_price >= 0
        THEN s.qty * v.cost_price ELSE 0 END),2) AS known_value,
      SUM(CASE WHEN v.cost_price IS NULL OR v.cost_price < 0
        THEN s.qty ELSE 0 END) AS missing_cost_qty,
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
  const sales=new Map();
  // Reuse already fetched anonymized paid orders for founder dashboards.
  // Orders with full refunds contribute zero, matching existing reporting.
  for(const order of orders){
    if(!order.point_id)continue;
    const item=sales.get(order.point_id)||{revenue:0,orders:0};
    if(order.net_revenue!==undefined){
      // SQL grouped path for all-time administrative overview avoids
      // loading an unbounded historical set of orders into Node memory.
      item.revenue+=Number(order.net_revenue||0);
      item.orders+=Number(order.net_orders||0);
    }else{
      const amount=order.refund_status==='refunded'&&order.refunded_amount==null
        ? 0:Math.max(0,Number(order.total||0)-Number(order.refunded_amount||0));
      if(amount<=0)continue;
      item.revenue+=amount;item.orders+=1;
    }
    sales.set(order.point_id,item);
  }
  const dateStart=period&&period.from?Date.parse(period.from.replace(' ','T')+'Z'):NaN;
  const dateEnd=period&&period.to?Date.parse(period.to.replace(' ','T')+'Z'):NaN;
  const days=Number.isFinite(dateStart)&&Number.isFinite(dateEnd)&&dateEnd>dateStart
    ? Math.max(1,(dateEnd-dateStart)/86400000):null;
  const margin=Number(contribution.contribution_margin_percent||0)/100;
  const points=listPointEquipment(database).map(row=>{
    const base=estimatePointLaunchCost(row,assumptions,contribution,
      initialGoodsByPoint.get(row.point_id));
    const actual=sales.get(row.point_id)||{revenue:0,orders:0};
    const monthlyRevenue=days?actual.revenue/days*30.4375:null;
    const monthlyContribution=monthlyRevenue===null?null:monthlyRevenue*margin;
    const payback=base.estimated_investment!=null&&!base.estimated_investment_incomplete&&monthlyContribution>0
      ? Math.round(base.estimated_investment/monthlyContribution*10)/10:null;
    const inventory=inventoryByPoint.get(row.point_id)||{};
    const inventoryQty=Number(inventory.qty||0);
    const inventoryMissingQty=Number(inventory.missing_cost_qty||0);
    const inventoryKnownValue=Number(inventory.known_value||0);
    return {...base,
      inventory_qty:inventoryQty,
      inventory_known_value:inventoryKnownValue,
      inventory_valuation:inventoryMissingQty>0?null:inventoryKnownValue,
      inventory_missing_cost_qty:inventoryMissingQty,
      inventory_missing_cost_variants:Number(inventory.missing_cost_variants||0),
      period_revenue:Math.round(actual.revenue*100)/100,
      period_orders:actual.orders,
      period_average_check:actual.orders?Math.round(actual.revenue/actual.orders):0,
      estimated_period_contribution:Math.round(actual.revenue*margin*100)/100,
      projected_monthly_contribution:monthlyContribution===null?null:Math.round(monthlyContribution*100)/100,
      payback_months_at_current_pace:payback,
    };
  });
  points.sort((a,b)=>b.period_revenue-a.period_revenue||a.point_name.localeCompare(b.point_name,'ru'));
  const configured=points.filter(p=>p.type);
  return {
    assumption:'Для точек без стойки/полки запуск = подтверждённая стартовая выкладка по закупочным ценам каталога + модельный бонус менеджеру. Условные 15 000 ₽ общих расходов не добавляются. Стартовая выкладка определяется по подтверждённым перемещениям ДО первой оплаченной продажи: поздние пополнения не учитываются. При отсутствии данных сумма не выводится; при пропущенных закупочных ценах показана только известная часть («от»). Для точек с собственным оборудованием пока сохраняется ранее принятая модельная смета; текущие остатки не прибавляются к ней.',
    inventory_disclaimer:'Стоимость текущего товара = положительный остаток × закупочная себестоимость варианта. Для точки без стойки вклад стартовой выкладки рассчитан отдельно по ранним подтверждённым перемещениям до первой продажи, а не по сегодняшним остаткам. Для исторических поставок используется актуальная цена из каталога (снимков старых закупочных цен нет). Без цены оценка неполная. При консигнации товар может принадлежать поставщику: это оценка размещения, а не доказательство понесённых денежных затрат.',
    profit_disclaimer:'Вклад рассчитывается из фактически оплаченной выручки и плановой маржинальности заказа. Это НЕ фактическая прибыль, не денежный поток и не учтённые расходы. CAPEX не прибавляется к P&L второй раз.',
    equipment_prices:{large_stand:5000,small_stand:2500,none:0,shelf:'вручную'},
    baseline_launch_cost:assumptions.launch_cost,
    baseline_other_launch_cost:Math.max(0,Number(assumptions.launch_cost)-5000),
    manager_launch_bonus:assumptions.manager_launch_bonus,
    model_contribution_margin_percent:contribution.contribution_margin_percent,
    period:period?{key:period.key,from:period.from,to:period.to}:null,
    points,
    summary:{
      configured:configured.length,unknown:points.length-configured.length,
      equipment_cost:configured.reduce((total,row)=>total+row.cost,0),
      estimated_launch_cost:configured.reduce((total,row)=>total+row.estimated_launch_cost,0),
      inventory_qty:points.reduce((sum,row)=>sum+row.inventory_qty,0),
      inventory_known_value:Math.round(points.reduce((sum,row)=>sum+row.inventory_known_value,0)*100)/100,
      inventory_valuation:points.some(row=>row.inventory_missing_cost_qty>0)?null:
        Math.round(points.reduce((sum,row)=>sum+row.inventory_known_value,0)*100)/100,
      inventory_missing_cost_qty:points.reduce((sum,row)=>sum+row.inventory_missing_cost_qty,0),
      inventory_missing_cost_variants:points.reduce((sum,row)=>sum+row.inventory_missing_cost_variants,0),
      total_points:points.length,
      period_revenue:points.reduce((sum,row)=>sum+row.period_revenue,0),
      period_orders:points.reduce((sum,row)=>sum+row.period_orders,0),
      estimated_period_contribution:Math.round(points.reduce((sum,row)=>sum+row.estimated_period_contribution,0)*100)/100,
    },
  };
}
module.exports={
  EQUIPMENT,STANDARD_LARGE_STAND_COST,
  normalizePointEquipment,equipmentLabel,equipmentFromRow,getPointEquipment,
  listPointEquipment,savePointEquipmentInTransaction,savePointEquipment,
  estimatePointLaunchCost,buildPointEquipmentEconomics,
};
