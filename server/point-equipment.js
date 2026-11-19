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

// The currently configured "launch_cost" model is the baseline FOR a large
// 5,000 ₽ stand. Decompose it into "other costs" + known equipment, so the
// 20,000 ₽ default keeps its original meaning, and no-stand launches save 5,000 ₽.
// This is a model only; actual expenses remain recorded exclusively via expenses.
function estimatePointLaunchCost(item, assumptions, contribution){
  if(!item.type)return {...item,other_launch_cost:null,
    estimated_launch_cost:null,estimated_investment:null,
    estimated_payback_months:null,estimated_orders_to_payback:null};
  const baseOther=Math.max(0,Number(assumptions.launch_cost||0)-STANDARD_LARGE_STAND_COST);
  const launchCost=baseOther+item.cost;
  const investment=launchCost+Number(assumptions.manager_launch_bonus||0);
  const monthly=Number(contribution.monthly_contribution_per_point||0);
  const perOrder=Number(contribution.contribution_per_order||0);
  return {...item,other_launch_cost:baseOther,
    estimated_launch_cost:launchCost,estimated_investment:investment,
    estimated_payback_months:monthly>0?Math.round(investment/monthly*10)/10:null,
    estimated_orders_to_payback:perOrder>0?Math.ceil(investment/perOrder):null};
}
function buildPointEquipmentEconomics(database,assumptions,contribution,orders=[],period=null){
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
    const base=estimatePointLaunchCost(row,assumptions,contribution);
    const actual=sales.get(row.point_id)||{revenue:0,orders:0};
    const monthlyRevenue=days?actual.revenue/days*30.4375:null;
    const monthlyContribution=monthlyRevenue===null?null:monthlyRevenue*margin;
    const payback=base.estimated_investment!=null&&monthlyContribution>0
      ? Math.round(base.estimated_investment/monthlyContribution*10)/10:null;
    return {...base,
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
    assumption:'Базовая смета запуска включает большую стойку за 5 000 ₽; прочие затраты считаются одинаковыми. Это модель, а не оплаченные счета.',
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
