// Separate strategy-level, READ-ONLY business-owner dashboard.
// Does not reuse the administrator role or expose personal customer data.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, requireSuperAdmin } = require('./routes-auth');
const { safeFounder, activeFounder, getFounder, configureFounder, FOUNDER_SLOTS } = require('./business-founders');
const { buildGrowthPlanDashboard } = require('./growth-plan');
const { buildOperationsCenter } = require('./routes-operations');

const CAPITAL_PLAN_RUB = 1000000;
const TAX_ESTIMATE_RATE = 0.06;
const ACQUIRING_ESTIMATE_RATE = 0.02;
const DAY = 86400000;
const ZONE_SHIFT = 7 * 3600000;

function ymdUtc(d) { return d.toISOString().slice(0, 10); }
function nowDate(now) { return now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(); }
function periodBounds(key, current) {
  const now = nowDate(current), ms = now.getTime();
  const local = new Date(ms + ZONE_SHIFT);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  let start;
  if (key === 'year') start = Date.UTC(y, 0, 1) - ZONE_SHIFT;
  else if (key === 'month') start = Date.UTC(y, m, 1) - ZONE_SHIFT;
  else start = ms - 30 * DAY;
  const duration = ms - start;
  const prev = start - duration;
  const sqlTime = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  const localDate = value => ymdUtc(new Date(value + ZONE_SHIFT));
  return {
    key: ['month', 'year', '30d'].includes(key) ? key : '30d',
    from: sqlTime(start), to: sqlTime(ms),
    previous_from: sqlTime(prev), previous_to: sqlTime(start),
    date_from: localDate(start), date_to: localDate(ms),
    created_utc: now.toISOString(),
  };
}
function safeNumber(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
function percentChange(current, previous) {
  return previous > 0 ? Math.round((current - previous) / previous * 1000) / 10 : null;
}
function netOrderAmount(order) {
  if (order.refund_status === 'refunded') return 0;
  return Math.max(0, safeNumber(order.total) - safeNumber(order.refunded_amount));
}
function ordersInRange(start, end) {
  return db.prepare(
    'SELECT id, point_id, total, commission_rate, refund_status, refunded_amount, created_at ' +
    'FROM orders WHERE status = ? AND created_at >= ? AND created_at < ?'
  ).all('paid', start, end);
}
function summarizeOrders(orders) {
  const revenue = Math.round(orders.reduce((s, o) => s + netOrderAmount(o), 0));
  const paidCount = orders.filter(o => netOrderAmount(o) > 0).length;
  return { revenue, orders: paidCount, avg_check: paidCount ? Math.round(revenue / paidCount) : 0 };
}
function mapOfRates() {
  const manager = new Map();
  // Prefer active assignment for a point if there are historical duplicates.
  db.prepare(
    'SELECT point_id, commission_rate FROM manager_points WHERE point_id IS NOT NULL ' +
    'ORDER BY active DESC, id DESC'
  ).all().forEach(row => { if (!manager.has(row.point_id)) manager.set(row.point_id, safeNumber(row.commission_rate)); });
  const owner = new Map();
  db.prepare(
    'SELECT point_id, commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active = 1 ORDER BY id DESC'
  ).all().forEach(row => { if (!owner.has(row.point_id)) owner.set(row.point_id, safeNumber(row.commission_rate)); });
  return { manager, owner };
}
function estimatedEconomics(orders, startDate, endDate) {
  const rates = mapOfRates();
  let partner = 0, manager = 0, owner = 0;
  let missingPartnerRates = 0;
  orders.forEach(o => {
    const amount = netOrderAmount(o);
    if (amount <= 0) return;
    if (o.commission_rate == null) missingPartnerRates++;
    else partner += amount * safeNumber(o.commission_rate);
    manager += amount * (rates.manager.get(o.point_id) || 0);
    owner += amount * (rates.owner.get(o.point_id) || 0);
  });
  const manualRows = db.prepare(
    'SELECT category, SUM(amount) AS total FROM expenses ' +
    'WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC'
  ).all(startDate, endDate);
  const manual = Math.round(manualRows.reduce((s, e) => s + safeNumber(e.total), 0));
  const revenue = summarizeOrders(orders).revenue;
  const tax = Math.round(revenue * TAX_ESTIMATE_RATE);
  const acquiring = Math.round(revenue * ACQUIRING_ESTIMATE_RATE);
  const partnerCommission = Math.round(partner);
  const managerCommission = Math.round(manager);
  const ownerCommission = Math.round(owner);
  const total = manual + tax + acquiring + partnerCommission + managerCommission + ownerCommission;
  return {
    revenue,
    manual_expenses: manual,
    expenses_by_category: manualRows.map(row => ({ name: row.category, amount: safeNumber(row.total) })),
    partner_commission_est: partnerCommission,
    manager_commission_est: managerCommission,
    salon_owner_commission_est: ownerCommission,
    tax_est: tax,
    acquiring_est: acquiring,
    estimated_result: revenue - total,
    estimated_margin_percent: revenue ? Math.round((revenue - total) / revenue * 1000) / 10 : 0,
    incomplete_commission_orders: missingPartnerRates,
    disclaimer: 'Расчётная оценка по учтённым расходам и приблизительным ставкам, НЕ бухгалтерская прибыль и НЕ остаток денежных средств. Закупка товара может относиться к будущим продажам; ручные расходы и комиссии могут пересекаться.',
  };
}
function monthHistory(now) {
  const local = new Date(now.getTime() + ZONE_SHIFT);
  const results = [];
  for (let step = 5; step >= 0; step--) {
    const fromMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - step, 1) - ZONE_SHIFT;
    const toMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - step + 1, 1) - ZONE_SHIFT;
    const sql = ms => new Date(ms).toISOString().slice(0,19).replace('T',' ');
    const rows = ordersInRange(sql(fromMs), sql(toMs));
    const summary = summarizeOrders(rows);
    results.push({ month: new Date(fromMs + ZONE_SHIFT).toISOString().slice(0,7), ...summary });
  }
  return results;
}
function pointRanking(start) {
  const points = db.prepare(
    'SELECT id,name,addr,city_id,created_at FROM points WHERE active = 1 AND COALESCE(is_hub,0) = 0 ORDER BY name'
  ).all();
  const sales = db.prepare(
    'SELECT point_id,MAX(created_at) AS last_paid, COUNT(*) AS n,' +
    ' SUM(CASE WHEN refund_status = ? THEN 0 ELSE MAX(0,total-COALESCE(refunded_amount,0)) END) AS net ' +
    'FROM orders WHERE status = ? AND created_at >= ? GROUP BY point_id'
  ).all('refunded','paid',start);
  const map = new Map(sales.map(r=>[r.point_id,r]));
  return points.map(p=>{
    const s=map.get(p.id);
    return {
      id:p.id,name:p.name,city_id:p.city_id,
      revenue:s?Math.round(safeNumber(s.net)):0,orders:s?Number(s.n):0,
      last_sale:s?s.last_paid:null,
    };
  }).sort((a,b)=>b.revenue-a.revenue).slice(0,50);
}
function founderTasks(founder) {
  const name = founder.full_name || '';
  const first = name.split(' ')[1] || name.split(' ')[0] || '';
  const date = ymdUtc(new Date());
  const assigned = db.prepare(
    'SELECT t.id,t.title,t.status,t.priority,t.due_date,COALESCE(a.full_name,\'\') AS assignee ' +
    'FROM meeting_tasks t LEFT JOIN task_assignees a ON a.id=t.assignee_id ' +
    'WHERE t.status NOT IN (\'done\',\'cancelled\') ORDER BY t.due_date,t.id DESC LIMIT 300'
  ).all();
  const mine = assigned.filter(t=>first && t.assignee.toLocaleLowerCase('ru-RU').includes(first.toLocaleLowerCase('ru-RU')));
  const initiatives = db.prepare(
    'SELECT title,status,due_date,responsible FROM bsc_initiatives ' +
    'WHERE status IN (\'planned\',\'in_progress\') AND responsible LIKE ? ' +
    'ORDER BY due_date LIMIT 20'
  ).all('%' + name + '%');
  const toDisplay = row=>({
    title:row.title,
    status:row.status,
    priority:row.priority || null,
    due_date:row.due_date,
    overdue:!!(row.due_date && row.due_date < date),
  });
  return {
    my_active:mine.length,
    my_overdue:mine.filter(t=>t.due_date && t.due_date < date).length,
    total_open:assigned.length,
    items:mine.slice(0,8).map(toDisplay),
    initiatives:initiatives.slice(0,6).map(toDisplay),
  };
}
function investmentSummary(founder) {
  const investorRows = db.prepare(
    'SELECT investor_name,SUM(amount) AS total,COUNT(*) AS entries FROM expenses ' +
    'WHERE investor_name IS NOT NULL AND TRIM(investor_name) != \'\' ' +
    'GROUP BY investor_name ORDER BY total DESC'
  ).all();
  return {
    planned_total_capital:CAPITAL_PLAN_RUB,
    my_planned_share:Math.round(CAPITAL_PLAN_RUB * safeNumber(founder.share_percent)/100),
    personal_expenses_recorded:investorRows.filter(r=>r.investor_name===founder.full_name)
      .reduce((s,r)=>s+safeNumber(r.total),0),
    by_investor:investorRows.map(r=>({ name:r.investor_name,amount:safeNumber(r.total),entries:Number(r.entries) })),
    actual_paid_capital:null,
    note:'Записанные расходы по инвесторам не подтверждают внесённый уставный/договорный капитал. Фактические вклады и дивиденды требуют отдельного подтверждённого реестра.',
  };
}
function strategicReadiness(now) {
  const growth = buildGrowthPlanDashboard(now);
  const g = growth.progress || {};
  const gates = growth.gates || {};
  return {
    goal_2031:growth.settings.target_points,
    current_active_30d:growth.facts.active_30d,
    registered_active:growth.facts.active_system,
    inactive_30d:growth.facts.no_sales_30d,
    plan_year:g.year,year_target:g.target_year_end,
    phase:g.phase,forecast_year_end:g.forecast_year_end,
    required_launches_per_month:g.required_per_month,
    current_launches_per_month:g.current_monthly_pace,
    scale_decision:gates.decision || null,
    scale_gates:(gates.gates||[]).map(gate=>({
      key:gate.key,name:gate.name,actual:gate.actual,target:gate.target,
      status:gate.status,unit:gate.unit,
    })),
    scenarios:(growth.scenarios || []).map(item=>({
      key:item.key,title:item.title,target_2031:item.target_2031,
    })),
    alerts:(growth.alerts||[]).slice(0,8).map(item=>({
      severity:item.severity,title:item.title,detail:item.detail,
    })),
    note:'Стратегический прогноз строится по текущей утверждённой модели. Нулевые центральные расходы и другие допущения не должны приниматься за фактические.',
  };
}
function collectFounderDashboard(founder, period='30d', now=new Date()) {
  const date=nowDate(now);
  const bounds=periodBounds(period,date);
  const current=ordersInRange(bounds.from,bounds.to);
  const previous=ordersInRange(bounds.previous_from,bounds.previous_to);
  const cur=summarizeOrders(current), prev=summarizeOrders(previous);
  const operations=buildOperationsCenter();
  return {
    updated_at:date.toISOString(),
    founder:safeFounder(founder),
    period:bounds,
    sales:{
      ...cur,previous:prev,
      revenue_change_percent:percentChange(cur.revenue,prev.revenue),
      orders_change_percent:percentChange(cur.orders,prev.orders),
      last_six_months:monthHistory(date),
    },
    finance:estimatedEconomics(current,bounds.date_from,bounds.date_to),
    network:{
      active_points:Number(db.prepare(
        'SELECT COUNT(*) AS n FROM points WHERE active=1 AND COALESCE(is_hub,0)=0'
      ).get().n||0),
      sold_points_period:pointRanking(bounds.from).filter(p=>p.orders>0).length,
      top_points:pointRanking(bounds.from).slice(0,7),
      silent_points:pointRanking(bounds.from).filter(p=>p.orders===0).slice(0,7),
    },
    strategy:strategicReadiness(date),
    capital:investmentSummary(founder),
    operations:{
      summary:operations.summary,
      issues:(operations.issues||[]).slice(0,8).map(i=>({
        key:i.key,title:i.title,severity:i.severity,count:i.count,summary:i.summary,
      })),
    },
    tasks:founderTasks(founder),
  };
}

function activeAdminSuper(req,res,ctx) {
  const token = requireSuperAdmin(req,res,ctx);
  if(!token) return null;
  const admin = db.prepare('SELECT active,role FROM admins WHERE id=?').get(token.id);
  if(!admin || admin.active!==1 || admin.role!=='super') {
    sendJson(res,403,{ error:'Недостаточно прав для управления собственниками' });
    return null;
  }
  return token;
}
function registerBusinessFounderRoutes(router) {
  router.get('/api/business-founders', (req,res,ctx)=>{
    if(!activeAdminSuper(req,res,ctx))return;
    const list=db.prepare('SELECT * FROM business_founders ORDER BY id').all();
    sendJson(res,200,{founders:list.map(safeFounder)});
  });
  router.put('/api/business-founders/:id', (req,res,ctx)=>{
    if(!activeAdminSuper(req,res,ctx))return;
    const result=configureFounder(ctx.params.id,ctx.body);
    if(!result.ok)return sendJson(res,result.status,{error:result.error});
    sendJson(res,200,{ok:true,founder:result.founder,
      telegram_reconnect_required:result.telegram_reconnect_required});
  });
  router.get('/api/business-founder/me', (req,res,ctx)=>{
    const payload=requireAuth(['founder'])(req,res,ctx);
    if(!payload)return;
    const founder=activeFounder(payload.id);
    if(!founder)return sendJson(res,401,{error:'Доступ собственника отключён'});
    sendJson(res,200,{founder:safeFounder(founder)});
  });
  router.get('/api/business-founder/dashboard', (req,res,ctx)=>{
    const payload=requireAuth(['founder'])(req,res,ctx);
    if(!payload)return;
    const founder=activeFounder(payload.id);
    if(!founder)return sendJson(res,401,{error:'Доступ собственника отключён'});
    const period=String(ctx.query.period||'30d');
    if(!['month','30d','year'].includes(period))return sendJson(res,400,{error:'Недопустимый период'});
    try {
      sendJson(res,200,collectFounderDashboard(founder,period));
    } catch(error) {
      console.error('Business founder dashboard:',error);
      sendJson(res,500,{error:'Не удалось собрать сводку. Попробуйте обновить её позже.'});
    }
  });
}

module.exports={
  collectFounderDashboard,registerBusinessFounderRoutes,periodBounds,
  summarizeOrders, estimatedEconomics, founderTasks,
};
