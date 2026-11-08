'use strict';

// Lightweight, on-demand business comparison of two completed Krasnoyarsk
// weeks. Does not generate PDFs, send messages or modify financial records.
const db = require('./db');
const { previousCompletedWeek } = require('./weekly-report');

const DAY_MS = 86400000;
const LOCAL_OFFSET_MS = 7 * 60 * 60 * 1000;
const TAX_RATE = 0.06;
const ACQUIRING_RATE = 0.02;
const MAX_CUSTOM_DAYS = 31;

function weekForOffset(offset = 0, now = new Date()) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 52) {
    throw new RangeError('Неделю можно выбрать от 0 до 52 недель назад');
  }
  return previousCompletedWeek(new Date(now.getTime() - offset * 7 * DAY_MS));
}


function checkedDate(value, label) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new RangeError('Укажите дату '+label+' в формате ГГГГ-ММ-ДД');
  const [year,month,day]=value.split('-').map(Number);
  if(year<2020||year>2100)
    throw new RangeError('Дата '+label+' должна быть в диапазоне 2020–2100 годов');
  const ms=Date.UTC(year,month-1,day);
  const date=new Date(ms);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)
    throw new RangeError('Некорректная календарная дата: '+label);
  return ms;
}
function checkedWindow(start,end,label,now) {
  const first=checkedDate(start,'начала '+label);
  const last=checkedDate(end,'окончания '+label);
  if(last<first) throw new RangeError('Дата окончания '+label+' раньше даты начала');
  const days=Math.round((last-first)/DAY_MS)+1;
  if(days>MAX_CUSTOM_DAYS) throw new RangeError(
    'Период '+label+' не может быть длиннее '+MAX_CUSTOM_DAYS+' дня'
  );
  const localToday=new Date(now.getTime()+LOCAL_OFFSET_MS).toISOString().slice(0,10);
  if(end>localToday) throw new RangeError('Период '+label+' не может содержать будущие даты');
  return {first,last,days};
}
function toUtcSql(localMs) {
  return new Date(localMs-LOCAL_OFFSET_MS).toISOString().slice(0,19).replace('T',' ');
}

// Two independent, explicitly chosen calendar windows. The baseline must
// precede the current window, but both lengths may differ. In that case
// display daily-normalized measures alongside raw totals.
function customComparisonPeriod(dates,now=new Date()) {
  const {current_start,current_end,previous_start,previous_end}=dates||{};
  const current=checkedWindow(current_start,current_end,'сравниваемого периода',now);
  const previous=checkedWindow(previous_start,previous_end,'базового периода',now);
  if(previous.last>=current.first)
    throw new RangeError('Базовый период должен закончиться до начала сравниваемого; пересечения недопустимы');
  return {
    start_local:current_start,end_local:current_end,
    previous_start_local:previous_start,previous_end_local:previous_end,
    start_utc:toUtcSql(current.first),
    end_utc_exclusive:toUtcSql(current.last+DAY_MS),
    previous_start_utc:toUtcSql(previous.first),
    previous_end_utc_exclusive:toUtcSql(previous.last+DAY_MS),
    current_days:current.days,previous_days:previous.days,
    mode:'custom',equal_length:current.days===previous.days,
  };
}
function decoratePeriod(period,mode) {
  const currentDays=Math.round((Date.parse(period.end_local+'T00:00:00Z')-
    Date.parse(period.start_local+'T00:00:00Z'))/DAY_MS)+1;
  const previousDays=Math.round((Date.parse(period.previous_end_local+'T00:00:00Z')-
    Date.parse(period.previous_start_local+'T00:00:00Z'))/DAY_MS)+1;
  return {...period,current_days:currentDays,previous_days:previousDays,
    mode,equal_length:currentDays===previousDays};
}

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round((current - previous) / Math.abs(previous) * 1000) / 10;
}
function dayKey(utcSql) {
  return new Date(Date.parse(String(utcSql).replace(' ', 'T') + 'Z') +
    LOCAL_OFFSET_MS).toISOString().slice(0, 10);
}
function plusDays(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}
function effectiveRevenue(row) {
  return Math.max(0, Number(row.total || 0) - Number(row.refunded_amount || 0));
}
function money(number) { return Math.round(Number(number || 0)); }
function valueDiff(current, previous) {
  return { current, previous, delta: Math.round((current - previous) * 100) / 100,
    percent: percentChange(current, previous) };
}
function periodFor(period, which) {
  return which === 'current'
    ? {start:period.start_utc,end:period.end_utc_exclusive,
       local_start:period.start_local,local_end:period.end_local,days:period.current_days}
    : {start:period.previous_start_utc,end:period.previous_end_utc_exclusive,
       local_start:period.previous_start_local,local_end:period.previous_end_local,days:period.previous_days};
}

function computeWeek(orders, expenses, pointRates, period) {
  const paid = orders.filter(row => row.status === 'paid');
  const revenue = money(paid.reduce((sum,row) => sum + effectiveRevenue(row), 0));
  const refunds = money(paid.reduce((sum,row) => sum + Number(row.refunded_amount || 0), 0));
  const phoneSet = new Set(paid.map(row =>
    String(row.customer_phone || '').replace(/\D/g,'').slice(-10)).filter(Boolean));
  const salesPoints = new Set(paid.filter(row => effectiveRevenue(row) > 0 && row.point_id)
    .map(row => String(row.point_id)));
  const manual = money(expenses.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const partner = money(paid.reduce((sum,row) =>
    sum + effectiveRevenue(row)*Number(row.commission_rate || 0), 0));
  const manager = money(paid.reduce((sum,row) =>
    sum + effectiveRevenue(row)*Number(pointRates.manager.get(String(row.point_id)) || 0),0));
  const owner = money(paid.reduce((sum,row) =>
    sum + effectiveRevenue(row)*Number(pointRates.owner.get(String(row.point_id)) || 0),0));
  const tax = money(revenue * TAX_RATE);
  const acquiring = money(revenue * ACQUIRING_RATE);
  const costs = {manual,partner,manager,owner,tax,acquiring,
    total:manual+partner+manager+owner+tax+acquiring};
  const profit = revenue - costs.total;
  return {
    revenue, paid_orders:paid.length, created_orders:orders.length,
    avg_check:paid.length ? money(revenue / paid.length) : 0,
    customers:phoneSet.size, points_with_sales:salesPoints.size,
    avg_daily_revenue:money(revenue / period.days),
    avg_daily_orders:Math.round(paid.length / period.days * 10) / 10,
    refunds, expenses:manual, estimated_profit:profit,
    estimated_margin_pct:revenue ? Math.round(profit / revenue * 1000) / 10 : 0,
    conversion_pct:orders.length ? Math.round(paid.length / orders.length * 1000) / 10 : 0,
    costs,period,
  };
}

function readComparison({offset=0,city='',now=new Date(),custom=null}={}) {
  const period=custom ? customComparisonPeriod(custom,now) :
    decoratePeriod(weekForOffset(offset,now),'completed-week');
  const cities=db.prepare('SELECT id,name FROM cities WHERE active=1 ORDER BY name').all();
  if(city && !db.prepare('SELECT id FROM cities WHERE id=?').get(city)){
    throw new RangeError('Город не найден');
  }
  const filter=city ? ' AND p.city_id=?' : '';
  // Query each window separately. A custom baseline may be months away;
  // never scan the entire gap and load it into the event loop.
  const orderStmt=db.prepare(
    'SELECT o.id,o.status,o.total,o.refunded_amount,o.customer_phone,o.commission_rate,'+
    'o.point_id,o.pickup_point,o.created_at,p.name AS point_name,p.city_id '+
    'FROM orders o LEFT JOIN points p ON p.id=o.point_id '+
    'WHERE o.created_at>=? AND o.created_at<?'+filter+' ORDER BY o.created_at,o.id'
  );
  const expenseStmt=db.prepare(
    'SELECT expense_date,category,amount FROM expenses '+
    'WHERE expense_date BETWEEN ? AND ?'+(city?' AND city_id=?':'')
  );
  const selection=(start,end)=>city?[start,end,city]:[start,end];
  const currentPeriod=periodFor(period,'current');
  const previousPeriod=periodFor(period,'previous');
  const currOrders=orderStmt.all(...selection(currentPeriod.start,currentPeriod.end));
  const prevOrders=orderStmt.all(...selection(previousPeriod.start,previousPeriod.end));
  const currExpenses=expenseStmt.all(...selection(period.start_local,period.end_local));
  const prevExpenses=expenseStmt.all(...selection(period.previous_start_local,period.previous_end_local));
  const pointRates={
    manager:new Map(db.prepare(
      'SELECT point_id,commission_rate FROM manager_points WHERE point_id IS NOT NULL ORDER BY id'
    ).all().map(r => [String(r.point_id),Number(r.commission_rate || 0)])),
    owner:new Map(db.prepare(
      'SELECT point_id,commission_rate FROM salon_owners '+
      'WHERE active=1 AND point_id IS NOT NULL ORDER BY id'
    ).all().map(r => [String(r.point_id),Number(r.commission_rate || 0)])),
  };
  const current=computeWeek(currOrders,currExpenses,pointRates,currentPeriod);
  const previous=computeWeek(prevOrders,prevExpenses,pointRates,previousPeriod);
  const keys=['revenue','paid_orders','avg_check','customers','points_with_sales','refunds',
    'expenses','estimated_profit','conversion_pct','avg_daily_revenue','avg_daily_orders'];
  const changes=Object.fromEntries(keys.map(key => [key,valueDiff(current[key],previous[key])]));

  const pointMap=new Map();
  function addPoint(row,which) {
    const key=String(row.point_id || 'unassigned');
    if(!pointMap.has(key)) pointMap.set(key,{
      id:row.point_id || null,name:row.point_name || row.pickup_point || 'Без точки',
      current:0,previous:0,current_orders:0,previous_orders:0,
    });
    const point=pointMap.get(key);
    point[which]+=effectiveRevenue(row);
    point[which+'_orders']++;
  }
  for(const row of currOrders)if(row.status==='paid')addPoint(row,'current');
  for(const row of prevOrders)if(row.status==='paid')addPoint(row,'previous');
  // Include currently active salons with no sales to make inactivity visible.
  const activePoints=db.prepare(
    'SELECT id,name FROM points WHERE active=1'+(city?' AND city_id=?':'')+' ORDER BY name'
  ).all(...(city?[city]:[]));
  for(const point of activePoints)if(!pointMap.has(String(point.id)))
    pointMap.set(String(point.id),{id:point.id,name:point.name,
      current:0,previous:0,current_orders:0,previous_orders:0});
  const allPoints=Array.from(pointMap.values()).map(point=>({
    ...point,delta:money(point.current-point.previous),
    percent:percentChange(point.current,point.previous),
  })).sort((a,b)=>b.current-a.current || a.name.localeCompare(b.name,'ru'));

  // SQL aggregation avoids transferring every item and joining into the
  // main order query, which would multiply order counts.
  const itemStmt=db.prepare(
    'SELECT oi.name,oi.weight,o.created_at,'+
    'oi.qty,oi.price,o.total,o.refunded_amount '+
    'FROM order_items oi JOIN orders o ON o.id=oi.order_id '+
    'LEFT JOIN points p ON p.id=o.point_id '+
    "WHERE o.status='paid' AND o.created_at>=? AND o.created_at<?"+filter
  );
  const itemRows=[
    ...itemStmt.all(...selection(currentPeriod.start,currentPeriod.end))
      .map(row=>({...row,which:'current'})),
    ...itemStmt.all(...selection(previousPeriod.start,previousPeriod.end))
      .map(row=>({...row,which:'previous'})),
  ];
  const products=new Map();
  for(const row of itemRows){
    const key=row.name+'\u0000'+row.weight;
    if(!products.has(key))products.set(key,{name:row.name,weight:row.weight,
      current_units:0,previous_units:0,current_revenue_estimate:0,previous_revenue_estimate:0});
    const product=products.get(key),which=row.which;
    // Same refund allocation as the existing weekly GD report. Product
    // values are estimates and do not allocate order-level discounts.
    const ratio=Number(row.total)>0
      ? Math.max(0,Number(row.total)-Number(row.refunded_amount||0))/Number(row.total):0;
    const units=Number(row.refunded_amount||0)<Number(row.total||0)?Number(row.qty||0):0;
    product[which+'_units']+=units;
    product[which+'_revenue_estimate']+=Number(row.price||0)*Number(row.qty||0)*ratio;
  }
  const sortedProducts=Array.from(products.values()).map(p=>{
    p.current_revenue_estimate=money(p.current_revenue_estimate);
    p.previous_revenue_estimate=money(p.previous_revenue_estimate);
    return {...p,units_change:percentChange(p.current_units,p.previous_units)};
  }).sort((a,b)=>b.current_units-a.current_units||
    b.previous_units-a.previous_units||a.name.localeCompare(b.name,'ru'));

  const daily=[];
  function dayTotals(rows){
    const totals=new Map();
    for(const row of rows){
      if(row.status!=='paid')continue;
      const date=dayKey(row.created_at);
      const value=totals.get(date)||{revenue:0,orders:0};
      value.revenue+=effectiveRevenue(row);
      value.orders++;
      totals.set(date,value);
    }
    return totals;
  }
  const currentDaily=dayTotals(currOrders);
  const previousDaily=dayTotals(prevOrders);
  for(let i=0;i<Math.max(period.current_days,period.previous_days);i++){
    const date=i<period.current_days?plusDays(period.start_local,i):null;
    const previousDate=i<period.previous_days?plusDays(period.previous_start_local,i):null;
    const a=date?(currentDaily.get(date)||{revenue:0,orders:0}):null;
    const b=previousDate?(previousDaily.get(previousDate)||{revenue:0,orders:0}):null;
    daily.push({weekday:i,date,previous_date:previousDate,
      current:a?money(a.revenue):null,previous:b?money(b.revenue):null,
      current_orders:a?a.orders:null,previous_orders:b?b.orders:null});
  }
  const categories=new Map();
  for(const [which,rows] of [['current',currExpenses],['previous',prevExpenses]]){
    for(const exp of rows){
      if(!categories.has(exp.category))
        categories.set(exp.category,{name:exp.category,current:0,previous:0});
      categories.get(exp.category)[which]+=Number(exp.amount||0);
    }
  }
  const expenseCategories=Array.from(categories.values())
    .map(x=>({...x,delta:money(x.current-x.previous)}))
    .sort((a,b)=>b.current-a.current||a.name.localeCompare(b.name,'ru'));
  return {
    period:{start_local:period.start_local,end_local:period.end_local,
      previous_start_local:period.previous_start_local,
      previous_end_local:period.previous_end_local,
      current_days:period.current_days,previous_days:period.previous_days,
      equal_length:period.equal_length,mode:period.mode},
    offset:custom?null:offset,city:city||'',cities,generated_at:new Date().toISOString(),
    current,previous,changes,daily,points:allPoints.slice(0,100),
    points_total:allPoints.length,products:sortedProducts.slice(0,30),
    expense_categories:expenseCategories.slice(0,50),
    calculation_note:'Выручка после учёта возвратов. Расчётный результат = выручка минус '+ 
      'введённые траты, комиссии, налог 6% и эквайринг 2%. Ставки менеджеров и владельцев берутся на дату отчёта. '+
      'Закупки в тратах учитываются как расходы периода; это управленческая, не бухгалтерская прибыль. '+
      'Товарная выручка оценивается без распределения скидок по позициям.'+
      (!period.equal_length?' Периоды разной длины: абсолютные итоги и проценты зависят от числа дней; сравнивайте среднедневные значения.':''),
  };
}
module.exports={weekForOffset,percentChange,dayKey,readComparison,customComparisonPeriod};
