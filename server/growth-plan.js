// growth-plan.js — пятилетний план масштабирования ХвостМаркета до 1000
// активных точек. Цели и допущения хранятся в БД, факт всегда собирается
// из рабочих таблиц: points, orders, partner_leads, чек-листов и менеджеров.
'use strict';

const db = require('./db');
const { getAllPointLaunchSummaries } = require('./point-launch-checklist');

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = 'growth_plan_1000';

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  start_points: 2,
  target_points: 1000,
  quarter_weights: [0.15, 0.20, 0.30, 0.35],
  launch_costs: { stand: 5000, initial_stock: 5000, other: 10000 },
  economics: {
    average_check: 650,
    orders_per_month: 70,
    gross_margin_rate: 0.50,
    groomer_rate: 0.15,
    manager_rate: 0.07,
    owner_rate: 0.05,
    acquiring_rate: 0.027,
    logistics_rate: 0.05,
    writeoff_rate: 0.015,
    variable_it_rate: 0.015,
    tax_rate: 0.06,
    manager_launch_bonus: 2000,
    funding_reserve_rate: 0.20,
  },
  capacity: {
    base_team_without_managers: 3,
    launches_per_manager_month: 4,
    leads_per_launch: 12,
    meetings_per_launch: 4.2,
    agreements_per_launch: 1.45,
  },
  years: [
    { year: 2027, target_points: 20, cities: 1, team: 4, maturity: 0.65, central_costs: 0 },
    { year: 2028, target_points: 80, cities: 3, team: 8, maturity: 0.75, central_costs: 0 },
    { year: 2029, target_points: 250, cities: 12, team: 16, maturity: 0.85, central_costs: 0 },
    { year: 2030, target_points: 550, cities: 30, team: 27, maturity: 0.90, central_costs: 0 },
    { year: 2031, target_points: 1000, cities: 60, team: 38, maturity: 0.92, central_costs: 0 },
  ],
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function round(value) { return Math.round(Number(value || 0)); }
function round1(value) { return Math.round(Number(value || 0) * 10) / 10; }
function isoDate(value = new Date()) { return value.toISOString().slice(0, 10); }

function mergeSettings(raw) {
  const defaults = clone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return defaults;
  return {
    ...defaults,
    ...raw,
    launch_costs: { ...defaults.launch_costs, ...(raw.launch_costs || {}) },
    economics: { ...defaults.economics, ...(raw.economics || {}) },
    capacity: { ...defaults.capacity, ...(raw.capacity || {}) },
    quarter_weights: Array.isArray(raw.quarter_weights) ? raw.quarter_weights : defaults.quarter_weights,
    years: Array.isArray(raw.years) && raw.years.length ? raw.years : defaults.years,
  };
}

function getSettings() {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) {
    const initial = clone(DEFAULT_SETTINGS);
    db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(initial));
    return initial;
  }
  try { return mergeSettings(JSON.parse(row.value)); } catch (_) { return clone(DEFAULT_SETTINGS); }
}

function validateSettings(input) {
  const settings = mergeSettings(input);
  const moneyFields = ['stand', 'initial_stock', 'other'];
  moneyFields.forEach((key) => {
    const value = Number(settings.launch_costs[key]);
    if (!Number.isFinite(value) || value < 0 || value > 10000000) throw new Error('Некорректная стоимость запуска: ' + key);
    settings.launch_costs[key] = round(value);
  });
  const e = settings.economics;
  ['average_check', 'orders_per_month', 'manager_launch_bonus'].forEach((key) => {
    const value = Number(e[key]);
    if (!Number.isFinite(value) || value < 0 || value > 10000000) throw new Error('Некорректное допущение: ' + key);
    e[key] = Number(value);
  });
  ['gross_margin_rate', 'groomer_rate', 'manager_rate', 'owner_rate', 'acquiring_rate',
    'logistics_rate', 'writeoff_rate', 'variable_it_rate', 'tax_rate', 'funding_reserve_rate'].forEach((key) => {
    const value = Number(e[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Ставка должна быть от 0 до 1: ' + key);
    e[key] = value;
  });
  ['launches_per_manager_month', 'leads_per_launch', 'meetings_per_launch', 'agreements_per_launch'].forEach((key) => {
    const value = Number(settings.capacity[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) throw new Error('Некорректный норматив мощности: ' + key);
    settings.capacity[key] = value;
  });
  const baseTeam = Number(settings.capacity.base_team_without_managers);
  if (!Number.isFinite(baseTeam) || baseTeam < 0 || baseTeam > 1000) throw new Error('Некорректная базовая команда');
  settings.capacity.base_team_without_managers = round(baseTeam);
  if (!Array.isArray(settings.years) || settings.years.length !== 5) throw new Error('План должен содержать пять лет');
  let previous = Number(settings.start_points || 0);
  settings.years = settings.years.map((row, index) => {
    const year = Number(row.year);
    const target = Number(row.target_points);
    const cities = Number(row.cities);
    const team = Number(row.team);
    const maturity = Number(row.maturity);
    const centralCosts = Number(row.central_costs || 0);
    if (year !== 2027 + index) throw new Error('Годы плана должны идти с 2027 по 2031');
    if (!Number.isFinite(target) || target <= previous) throw new Error('Цель по точкам должна ежегодно расти');
    if (![cities, team, maturity, centralCosts].every(Number.isFinite) || cities < 1 || team < 1 || maturity <= 0 || maturity > 1 || centralCosts < 0) {
      throw new Error('Проверьте города, команду, зрелость и центральные расходы за ' + year + ' год');
    }
    previous = target;
    return { year, target_points: round(target), cities: round(cities), team: round(team), maturity, central_costs: round(centralCosts) };
  });
  settings.start_points = round(settings.start_points);
  settings.target_points = settings.years[settings.years.length - 1].target_points;
  if (!Array.isArray(settings.quarter_weights) || settings.quarter_weights.length !== 4) throw new Error('Нужно указать четыре квартальных веса');
  settings.quarter_weights = settings.quarter_weights.map((value) => Number(value));
  if (settings.quarter_weights.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Некорректные квартальные веса');
  const quarterWeightTotal = settings.quarter_weights.reduce((sum, value) => sum + value, 0);
  if (Math.abs(quarterWeightTotal - 1) > 0.001) throw new Error('Сумма квартальных весов должна быть равна 100%');
  return settings;
}

function saveSettings(input, actor) {
  const settings = validateSettings(input);
  const before = getSettings();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')")
      .run(SETTINGS_KEY, JSON.stringify(settings));
    db.prepare('INSERT INTO growth_plan_settings_log (admin_id, admin_login, previous_json, settings_json) VALUES (?, ?, ?, ?)')
      .run(actor && actor.id || null, actor && actor.login || null, JSON.stringify(before), JSON.stringify(settings));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return settings;
}

function financialModel(settings) {
  const launchCost = Object.values(settings.launch_costs).reduce((sum, value) => sum + Number(value || 0), 0);
  const e = settings.economics;
  const variableRate = e.groomer_rate + e.manager_rate + e.owner_rate + e.acquiring_rate + e.logistics_rate + e.writeoff_rate + e.variable_it_rate + e.tax_rate;
  const contributionRate = e.gross_margin_rate - variableRate;
  let startPoints = Number(settings.start_points || 0);
  let cumulativeCash = 0;
  let peakDeficit = 0;
  let previousFunding = 0;
  const rows = settings.years.map((target) => {
    const newPoints = target.target_points - startPoints;
    const averagePoints = (startPoints + target.target_points) / 2;
    const matureEquivalent = averagePoints * target.maturity;
    const revenue = matureEquivalent * e.average_check * e.orders_per_month * 12;
    const contributionBeforeLaunch = revenue * contributionRate - newPoints * e.manager_launch_bonus;
    const businessCash = contributionBeforeLaunch - target.central_costs;
    const expansionInvestment = newPoints * launchCost;
    const netCash = businessCash - expansionInvestment;
    cumulativeCash += netCash;
    peakDeficit = Math.max(peakDeficit, -cumulativeCash, 0);
    const recommendedFunding = peakDeficit * (1 + e.funding_reserve_rate);
    const investorTranche = Math.max(0, recommendedFunding - previousFunding);
    previousFunding = recommendedFunding;
    const row = {
      ...target,
      start_points: startPoints,
      new_points: newPoints,
      launches_per_month: round1(newPoints / 12),
      launches_per_week: round1(newPoints / 52),
      launch_cost: launchCost,
      revenue: round(revenue),
      contribution_rate: round1(contributionRate * 100),
      business_cash: round(businessCash),
      expansion_investment: round(expansionInvestment),
      net_cash: round(netCash),
      cumulative_cash: round(cumulativeCash),
      recommended_funding: round(recommendedFunding),
      investor_tranche: round(investorTranche),
    };
    startPoints = target.target_points;
    return row;
  });
  return {
    launch_cost: launchCost,
    variable_rate_percent: round1(variableRate * 100),
    contribution_rate_percent: round1(contributionRate * 100),
    rows,
    totals: {
      launches: settings.target_points - settings.start_points,
      expansion_investment: rows.reduce((sum, row) => sum + row.expansion_investment, 0),
      business_cash: rows.reduce((sum, row) => sum + row.business_cash, 0),
      net_cash: rows.reduce((sum, row) => sum + row.net_cash, 0),
      external_funding: rows.reduce((sum, row) => sum + row.investor_tranche, 0),
    },
  };
}

function scenarioSettings(base, key) {
  const settings = clone(base);
  if (key === 'conservative') {
    // Медленнее подключение и слабее продажи. Последний год показывает риск
    // недостижения 1000 точек, а не подменяет утверждённую базовую цель.
    const targets = [15, 55, 180, 420, 800];
    settings.years.forEach((row, index) => {
      row.target_points = targets[index];
      row.maturity = Math.max(0.3, row.maturity * 0.9);
    });
    settings.target_points = targets[targets.length - 1];
    settings.economics.average_check *= 0.9;
    settings.economics.orders_per_month *= 0.8;
    Object.keys(settings.launch_costs).forEach((name) => { settings.launch_costs[name] *= 1.15; });
  }
  if (key === 'accelerated') {
    // Финальная цель та же, но значительная часть запусков переносится на
    // первые четыре года. Экономика точки не улучшается искусственно.
    const targets = [30, 120, 350, 700, 1000];
    settings.years.forEach((row, index) => { row.target_points = targets[index]; });
    settings.target_points = 1000;
  }
  return settings;
}

function scenarioModels(settings) {
  return [
    { key: 'conservative', name: 'Консервативный', description: 'Продажи ниже, запуск дороже, к 2031 году — 800 точек.' },
    { key: 'base', name: 'Базовый', description: 'Утверждённый план 20 → 80 → 250 → 550 → 1000.' },
    { key: 'accelerated', name: 'Ускоренный', description: 'Больше запусков в первые четыре года, итоговая цель не меняется.' },
  ].map((definition) => {
    const model = financialModel(scenarioSettings(settings, definition.key));
    return {
      ...definition,
      target_2031: model.rows[model.rows.length - 1].target_points,
      revenue_5y: model.rows.reduce((sum, row) => sum + row.revenue, 0),
      ...model.totals,
      annual: model.rows.map((row) => ({ year: row.year, target_points: row.target_points, investor_tranche: row.investor_tranche })),
    };
  });
}

function allocateInteger(total, weights) {
  const raw = weights.map((weight) => total * weight);
  const values = raw.map(Math.floor);
  let remainder = total - values.reduce((sum, value) => sum + value, 0);
  raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .forEach((item) => { if (remainder > 0) { values[item.index] += 1; remainder -= 1; } });
  return values;
}

function quarterlyModel(settings) {
  const launchCost = Object.values(settings.launch_costs).reduce((sum, value) => sum + Number(value || 0), 0);
  const e = settings.economics;
  const variableRate = e.groomer_rate + e.manager_rate + e.owner_rate + e.acquiring_rate + e.logistics_rate + e.writeoff_rate + e.variable_it_rate + e.tax_rate;
  const contributionRate = e.gross_margin_rate - variableRate;
  let points = Number(settings.start_points || 0);
  let cumulativeCash = 0;
  let peakDeficit = 0;
  let previousFunding = 0;
  const quarters = [];
  settings.years.forEach((yearRow) => {
    const annualLaunches = yearRow.target_points - points;
    const launchesByQuarter = allocateInteger(annualLaunches, settings.quarter_weights);
    launchesByQuarter.forEach((newPoints, index) => {
      const startPoints = points;
      const endPoints = startPoints + newPoints;
      const averagePoints = (startPoints + endPoints) / 2;
      const revenue = averagePoints * yearRow.maturity * e.average_check * e.orders_per_month * 3;
      const businessCash = revenue * contributionRate - newPoints * e.manager_launch_bonus - yearRow.central_costs / 4;
      const expansionInvestment = newPoints * launchCost;
      const netCash = businessCash - expansionInvestment;
      cumulativeCash += netCash;
      peakDeficit = Math.max(peakDeficit, -cumulativeCash, 0);
      const recommendedFunding = peakDeficit * (1 + e.funding_reserve_rate);
      const investorTranche = Math.max(0, recommendedFunding - previousFunding);
      previousFunding = recommendedFunding;
      points = endPoints;
      quarters.push({
        year: yearRow.year, quarter: index + 1, period: yearRow.year + ' · Q' + (index + 1),
        start_points: startPoints, new_points: newPoints, target_points: endPoints,
        revenue: round(revenue), business_cash: round(businessCash),
        expansion_investment: round(expansionInvestment), net_cash: round(netCash),
        cumulative_cash: round(cumulativeCash), investor_tranche: round(investorTranche),
      });
    });
  });
  const fundingQuarters = quarters.filter((row) => row.investor_tranche > 0);
  return {
    weights: settings.quarter_weights,
    quarters,
    totals: {
      expansion_investment: quarters.reduce((sum, row) => sum + row.expansion_investment, 0),
      business_cash: quarters.reduce((sum, row) => sum + row.business_cash, 0),
      net_cash: quarters.reduce((sum, row) => sum + row.net_cash, 0),
      external_funding: quarters.reduce((sum, row) => sum + row.investor_tranche, 0),
    },
    funding_schedule: fundingQuarters.map((row) => ({ period: row.period, amount: row.investor_tranche })),
    first_funding: fundingQuarters.length ? { period: fundingQuarters[0].period, amount: fundingQuarters[0].investor_tranche } : null,
  };
}

function factSnapshot(now = new Date()) {
  const date = isoDate(now);
  const active30Start = new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  const activeSystem = Number(db.prepare('SELECT COUNT(*) AS c FROM points WHERE active = 1 AND COALESCE(is_hub,0) = 0').get().c || 0);
  const active30 = Number(db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS c FROM points p
    JOIN orders o ON o.point_id = p.id AND o.status = 'paid' AND o.created_at >= ?
    WHERE p.active = 1 AND COALESCE(p.is_hub,0) = 0
  `).get(active30Start).c || 0);
  const stable90 = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT p.id, MIN(o.created_at) first_sale, MAX(o.created_at) last_sale
      FROM points p JOIN orders o ON o.point_id=p.id AND o.status='paid'
      WHERE p.active=1 AND COALESCE(p.is_hub,0)=0 GROUP BY p.id
      HAVING first_sale <= datetime(?, '-90 days') AND last_sale >= datetime(?, '-30 days')
    )
  `).get(date, date).c || 0);
  const noSales30 = Math.max(0, activeSystem - active30);
  const revenue30 = Number(db.prepare(`
    SELECT COALESCE(SUM(MAX(0, o.total - COALESCE(o.refunded_amount,0))),0) AS total
    FROM orders o JOIN points p ON p.id=o.point_id
    WHERE o.status='paid' AND o.created_at >= ? AND p.active=1 AND COALESCE(p.is_hub,0)=0
  `).get(active30Start).total || 0);
  const stockState = db.prepare(`
    SELECT COUNT(*) AS positions, SUM(CASE WHEN s.qty <= 0 THEN 1 ELSE 0 END) AS out_positions
    FROM stock s JOIN points p ON p.id=s.point_id AND p.active=1 AND COALESCE(p.is_hub,0)=0
    JOIN product_variants v ON v.id=s.variant_id AND v.active=1
  `).get();
  const firstSales = db.prepare(`
    SELECT p.id, p.name, p.city_id, p.manager_id, MIN(o.created_at) AS first_sale
    FROM points p JOIN orders o ON o.point_id=p.id AND o.status='paid'
    WHERE COALESCE(p.is_hub,0)=0 GROUP BY p.id
  `).all();
  const checklist = getAllPointLaunchSummaries(true);
  return {
    date, active_system: activeSystem, active_30d: active30, stable_90d: stable90,
    no_sales_30d: noSales30, revenue_30d: revenue30,
    stock_positions: Number(stockState.positions || 0), out_positions: Number(stockState.out_positions || 0),
    first_sales: firstSales, checklist,
  };
}

function planProgress(settings, facts, now = new Date()) {
  const year = now.getUTCFullYear();
  const planStart = settings.years[0].year;
  const planEnd = settings.years[settings.years.length - 1].year;
  const effectiveYear = Math.max(planStart, Math.min(planEnd, year));
  const targetRow = settings.years.find((row) => row.year === effectiveYear);
  const previousTarget = effectiveYear === planStart ? settings.start_points : settings.years.find((row) => row.year === effectiveYear - 1).target_points;
  const yearStart = Date.UTC(effectiveYear, 0, 1);
  const yearEnd = Date.UTC(effectiveYear + 1, 0, 1);
  const nowMs = now.getTime();
  const elapsedRatio = year < planStart ? 0 : (year > planEnd ? 1 : Math.max(0, Math.min(1, (nowMs - yearStart) / (yearEnd - yearStart))));
  const targetToDate = Math.round(previousTarget + (targetRow.target_points - previousTarget) * elapsedRatio);
  const target = targetRow.target_points;
  const planStarted = year >= planStart;
  const ratio = targetToDate > 0 ? facts.active_30d / targetToDate : 1;
  const status = !planStarted ? 'preparation' : ratio >= 0.95 ? 'green' : ratio >= 0.80 ? 'yellow' : 'red';
  const daysRemaining = year < planStart ? 365 : Math.max(0, Math.ceil((yearEnd - nowMs) / DAY_MS));
  const remaining = Math.max(0, target - (year < planStart ? settings.start_points : facts.active_30d));
  const trailingStart = new Date(now.getTime() - 90 * DAY_MS);
  const trailingLaunches = facts.first_sales.filter((row) => new Date(String(row.first_sale).replace(' ', 'T') + 'Z') >= trailingStart).length;
  const monthlyPace = trailingLaunches / 3;
  const forecast = Math.round(Math.min(target, facts.active_30d + monthlyPace * (daysRemaining / 30.44)));
  const monthsTo1000 = monthlyPace > 0 ? Math.ceil(Math.max(0, settings.target_points - facts.active_30d) / monthlyPace) : null;
  const reachDate = monthsTo1000 === null ? null : isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsTo1000, now.getUTCDate())));
  return {
    phase: !planStarted ? 'preparation' : (year > planEnd ? 'completed_period' : 'execution'),
    year: effectiveYear,
    status,
    target_to_date: targetToDate,
    target_year_end: target,
    actual_active: facts.active_30d,
    gap_to_date: facts.active_30d - targetToDate,
    remaining_to_year_target: remaining,
    required_per_month: daysRemaining ? round1(remaining / Math.max(daysRemaining / 30.44, 1 / 30.44)) : 0,
    required_per_week: daysRemaining ? round1(remaining / Math.max(daysRemaining / 7, 1 / 7)) : 0,
    trailing_90d_launches: trailingLaunches,
    current_monthly_pace: round1(monthlyPace),
    forecast_year_end: forecast,
    forecast_gap: forecast - target,
    forecast_reach_1000: reachDate,
    days_remaining: daysRemaining,
  };
}

function annualFacts(settings, facts, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  return settings.years.map((row) => {
    const activatedByEnd = facts.first_sales.filter((point) => Number(String(point.first_sale).slice(0, 4)) <= row.year).length;
    return {
      year: row.year,
      target_points: row.target_points,
      target_cities: row.cities,
      target_team: row.team,
      actual_points: row.year < currentYear ? activatedByEnd : (row.year === currentYear ? facts.active_30d : null),
      status: row.year > currentYear ? 'future' : ((row.year === currentYear ? facts.active_30d : activatedByEnd) >= row.target_points ? 'green' : 'red'),
    };
  });
}

function pipelineData(facts) {
  const leadRows = db.prepare('SELECT status, COUNT(*) AS c FROM partner_leads GROUP BY status').all();
  const lead = Object.fromEntries(leadRows.map((row) => [row.status, Number(row.c || 0)]));
  const ready = facts.checklist.filter((row) => row.ready).length;
  const preparing = facts.checklist.filter((row) => !row.ready).length;
  return [
    { key: 'leads', label: 'В базе', value: (lead.to_call || 0) + (lead.no_answer || 0) + (lead.meeting_scheduled || 0) + (lead.meeting_held || 0) + (lead.signed || 0) },
    { key: 'meetings', label: 'Встречи', value: (lead.meeting_scheduled || 0) + (lead.meeting_held || 0) },
    { key: 'signed', label: 'Согласовано', value: lead.signed || 0 },
    { key: 'preparing', label: 'На подготовке', value: preparing },
    { key: 'launched', label: 'Чек-лист закрыт', value: ready },
    { key: 'active', label: 'Активны 30 дней', value: facts.active_30d },
  ];
}

function breakdowns(facts) {
  const cityRows = db.prepare(`
    SELECT COALESCE(c.name,p.city_id,'Не указан') AS name,
      COUNT(DISTINCT CASE WHEN p.active=1 AND COALESCE(p.is_hub,0)=0 THEN p.id END) AS system_points,
      COUNT(DISTINCT CASE WHEN p.active=1 AND COALESCE(p.is_hub,0)=0 AND EXISTS (
        SELECT 1 FROM orders o WHERE o.point_id=p.id AND o.status='paid' AND o.created_at >= datetime('now','-30 days')
      ) THEN p.id END) AS active_points
    FROM points p LEFT JOIN cities c ON c.id=p.city_id GROUP BY COALESCE(c.name,p.city_id,'Не указан') ORDER BY active_points DESC, name
  `).all();
  const managerRows = db.prepare(`
    SELECT m.id, m.full_name AS name,
      COUNT(DISTINCT CASE WHEN p.active=1 THEN p.id END) AS system_points,
      COUNT(DISTINCT CASE WHEN p.active=1 AND EXISTS (
        SELECT 1 FROM orders o WHERE o.point_id=p.id AND o.status='paid' AND o.created_at >= datetime('now','-30 days')
      ) THEN p.id END) AS active_points,
      (SELECT COUNT(*) FROM partner_leads l WHERE l.assigned_manager_id=m.id AND l.status NOT IN ('signed','declined')) AS open_leads
    FROM managers m LEFT JOIN points p ON p.manager_id=m.id AND COALESCE(p.is_hub,0)=0
    WHERE m.active=1 GROUP BY m.id ORDER BY active_points DESC, m.full_name
  `).all();
  return {
    cities: cityRows.map((row) => ({ ...row, system_points: Number(row.system_points || 0), active_points: Number(row.active_points || 0) })),
    managers: managerRows.map((row) => ({ ...row, system_points: Number(row.system_points || 0), active_points: Number(row.active_points || 0), open_leads: Number(row.open_leads || 0) })),
  };
}

function capacityPlan(settings, progress, facts) {
  const norm = settings.capacity;
  const yearRow = settings.years.find((row) => row.year === progress.year) || settings.years[0];
  const previousTarget = progress.year === settings.years[0].year
    ? settings.start_points
    : (settings.years.find((row) => row.year === progress.year - 1) || {}).target_points || settings.start_points;
  const annualLaunches = yearRow.target_points - previousTarget;
  const plannedMonthly = annualLaunches / 12;
  const requiredMonthly = Math.max(plannedMonthly, progress.required_per_month);
  const activeManagers = Number(db.prepare('SELECT COUNT(*) AS c FROM managers WHERE active=1').get().c || 0);
  const requiredManagers = Math.max(1, Math.ceil(requiredMonthly / norm.launches_per_manager_month));
  const pipeline = pipelineData(facts);
  const leadsNow = Number((pipeline.find((row) => row.key === 'leads') || {}).value || 0);
  const meetingsNow = Number((pipeline.find((row) => row.key === 'meetings') || {}).value || 0);
  const signedNow = Number((pipeline.find((row) => row.key === 'signed') || {}).value || 0);
  const requiredLeads = Math.ceil(requiredMonthly * norm.leads_per_launch);
  const requiredMeetings = Math.ceil(requiredMonthly * norm.meetings_per_launch);
  const requiredAgreements = Math.ceil(requiredMonthly * norm.agreements_per_launch);
  return {
    year: progress.year,
    planned_launches_month: round1(plannedMonthly),
    required_launches_month: round1(requiredMonthly),
    launches_per_manager_month: norm.launches_per_manager_month,
    active_managers: activeManagers,
    required_managers: requiredManagers,
    manager_gap: activeManagers - requiredManagers,
    current_team: norm.base_team_without_managers + activeManagers,
    leads: { actual: leadsNow, required: requiredLeads, coverage_percent: requiredLeads ? round1(leadsNow / requiredLeads * 100) : 100 },
    meetings: { actual: meetingsNow, required: requiredMeetings, coverage_percent: requiredMeetings ? round1(meetingsNow / requiredMeetings * 100) : 100 },
    agreements: { actual: signedNow, required: requiredAgreements, coverage_percent: requiredAgreements ? round1(signedNow / requiredAgreements * 100) : 100 },
    team_target: yearRow.team,
    city_target: yearRow.cities,
  };
}

function alertsForDashboard(progress, facts, pipeline, financial, capacity) {
  const alerts = [];
  if (progress.status === 'red') alerts.push({ key: 'pace', severity: 'critical', owner: 'Лакомых Алексей', title: 'Темп сети ниже плана', detail: 'Отставание на ' + Math.abs(progress.gap_to_date) + ' активных точек. Требуется ' + progress.required_per_month + ' запуска в месяц.' });
  else if (progress.status === 'yellow') alerts.push({ key: 'pace', severity: 'warning', owner: 'Лакомых Алексей', title: 'Темп сети требует внимания', detail: 'Выполнение текущей цели ниже 95%.' });
  if (facts.no_sales_30d > 0) alerts.push({ key: 'inactive', severity: 'warning', owner: 'Менеджер', title: 'Есть точки без продаж 30 дней', detail: 'Не продают: ' + facts.no_sales_30d + '. Нужен план развития или закрытия.' });
  const meetings = (pipeline.find((item) => item.key === 'meetings') || {}).value || 0;
  if (progress.phase === 'execution' && meetings < Math.ceil(progress.required_per_month * 3)) alerts.push({ key: 'pipeline', severity: 'warning', owner: 'Менеджер', title: 'Недостаточная воронка встреч', detail: 'В работе ' + meetings + ', для темпа желательно не менее ' + Math.ceil(progress.required_per_month * 3) + '.' });
  if (financial.contribution_rate_percent < 3) alerts.push({ key: 'margin', severity: 'critical', owner: 'Лакомых Алексей', title: 'Маржинальность модели ниже стоп-порога', detail: 'После переменных затрат остаётся ' + financial.contribution_rate_percent + '%.' });
  if (progress.phase === 'execution' && capacity.manager_gap < 0) alerts.push({ key: 'manager_capacity', severity: 'critical', owner: 'Лакомых Алексей', title: 'Недостаточно менеджеров для темпа роста', detail: 'Требуется ' + capacity.required_managers + ', активно ' + capacity.active_managers + '. Дефицит: ' + Math.abs(capacity.manager_gap) + '.' });
  if (progress.phase === 'execution' && capacity.leads.coverage_percent < 80) alerts.push({ key: 'lead_capacity', severity: 'warning', owner: 'Менеджер', title: 'База лидов не обеспечивает план запусков', detail: 'Покрытие месячной потребности: ' + capacity.leads.coverage_percent + '%.' });
  return alerts;
}

function gateStatus(actual, target, stop, direction) {
  if (actual === null || actual === undefined || !Number.isFinite(Number(actual))) return 'no_data';
  if (direction === 'lower') {
    if (actual <= target) return 'green';
    if (actual > stop) return 'red';
    return 'yellow';
  }
  if (actual >= target) return 'green';
  if (actual < stop) return 'red';
  return 'yellow';
}

function scaleGates(settings, facts, financial, capacity) {
  const launchCost = financial.launch_cost;
  const monthlyContribution = settings.economics.average_check * settings.economics.orders_per_month * financial.contribution_rate_percent / 100;
  const payback = monthlyContribution > 0 ? round1((launchCost + settings.economics.manager_launch_bonus) / monthlyContribution) : null;
  const revenuePerPoint = facts.active_30d ? round(facts.revenue_30d / facts.active_30d) : null;
  const activeShare = facts.active_system ? round1(facts.active_30d / facts.active_system * 100) : null;
  const checklistShare = facts.checklist.length ? round1(facts.checklist.filter((row) => row.ready).length / facts.checklist.length * 100) : null;
  const stockoutShare = facts.stock_positions ? round1(facts.out_positions / facts.stock_positions * 100) : null;
  const definitions = [
    { key:'sales', name:'Продажи активной точки / 30 дней', actual:revenuePerPoint, target:45500, stop:30000, unit:'₽', direction:'higher', owner:'Лакомых Алексей' },
    { key:'margin', name:'Маржинальность после переменных затрат', actual:financial.contribution_rate_percent, target:6, stop:3, unit:'%', direction:'higher', owner:'Лакомых Алексей' },
    { key:'payback', name:'Окупаемость запуска', actual:payback, target:9, stop:12, unit:'мес.', direction:'lower', owner:'Лакомых Алексей' },
    { key:'active_share', name:'Доля активных точек', actual:activeShare, target:90, stop:80, unit:'%', direction:'higher', owner:'Менеджер' },
    { key:'checklist', name:'Готовность чек-листов запуска', actual:checklistShare, target:100, stop:80, unit:'%', direction:'higher', owner:'Менеджер' },
    { key:'stock', name:'Отсутствие товара на точках', actual:stockoutShare, target:5, stop:8, unit:'%', direction:'lower', owner:'Соколов Виталий' },
    { key:'pipeline', name:'Покрытие потребности лидами', actual:capacity.leads.coverage_percent, target:100, stop:80, unit:'%', direction:'higher', owner:'Лакомых Алексей' },
  ];
  const gates = definitions.map((item) => ({ ...item, status: gateStatus(item.actual, item.target, item.stop, item.direction) }));
  const hasRed = gates.some((item) => item.status === 'red');
  const hasYellow = gates.some((item) => item.status === 'yellow');
  const hasNoData = gates.some((item) => item.status === 'no_data');
  return {
    decision: hasRed ? 'stop' : (hasYellow ? 'caution' : (hasNoData ? 'not_ready' : 'go')),
    title: hasRed ? 'Приостановить ускорение' : (hasYellow ? 'Масштабировать осторожно' : (hasNoData ? 'Недостаточно данных для ускорения' : 'Можно масштабировать')),
    gates,
  };
}

function buildGrowthPlanDashboard(now = new Date()) {
  const settings = getSettings();
  const financial = financialModel(settings);
  const facts = factSnapshot(now);
  const progress = planProgress(settings, facts, now);
  const pipeline = pipelineData(facts);
  const split = breakdowns(facts);
  const capacity = capacityPlan(settings, progress, facts);
  const alerts = alertsForDashboard(progress, facts, pipeline, financial, capacity);
  const quarterly = quarterlyModel(settings);
  const gates = scaleGates(settings, facts, financial, capacity);
  if (gates.decision === 'stop') {
    const failed = gates.gates.filter((item) => item.status === 'red');
    alerts.push({
      key: 'scale_gates', severity: 'critical', owner: 'Лакомых Алексей',
      title: 'Не выполнены условия масштабирования',
      detail: failed.map((item) => item.name).join('; ') + '. Сначала устранить отклонения, затем увеличивать темп.',
    });
  }
  return {
    generated_at: new Date().toISOString(),
    settings,
    progress,
    facts: {
      active_system: facts.active_system,
      active_30d: facts.active_30d,
      stable_90d: facts.stable_90d,
      no_sales_30d: facts.no_sales_30d,
      revenue_30d: facts.revenue_30d,
      stock_positions: facts.stock_positions,
      out_positions: facts.out_positions,
      checklists_ready: facts.checklist.filter((row) => row.ready).length,
      checklists_total: facts.checklist.length,
    },
    annual: annualFacts(settings, facts, now),
    pipeline,
    financial,
    scenarios: scenarioModels(settings),
    capacity,
    quarterly,
    gates,
    breakdowns: split,
    alerts,
    definitions: {
      active: 'Точка включена и имеет хотя бы один оплаченный заказ за последние 30 дней.',
      stable: 'Первая продажа была не менее 90 дней назад и есть продажи за последние 30 дней.',
      central_costs: 'В базовом сценарии центральные расходы временно равны нулю.',
    },
  };
}

function taskDueDate(days) { return isoDate(new Date(Date.now() + days * DAY_MS)); }

function findAssigneeId(owner) {
  const aliases = owner === 'Менеджер' ? ['Ангелина', 'Менеджер'] : [owner];
  for (const alias of aliases) {
    const row = db.prepare('SELECT id FROM task_assignees WHERE active=1 AND full_name LIKE ? ORDER BY id LIMIT 1').get('%' + alias + '%');
    if (row) return row.id;
  }
  return null;
}

function syncGrowthPlanTasks(dashboard, actor) {
  const data = dashboard || buildGrowthPlanDashboard();
  let created = 0;
  data.alerts.forEach((alert) => {
    if (!['critical', 'warning'].includes(alert.severity)) return;
    const sourceKey = 'growth-plan:' + data.progress.year + ':' + alert.key;
    const existing = db.prepare("SELECT id FROM meeting_tasks WHERE source_key=? AND status NOT IN ('done','cancelled')").get(sourceKey);
    if (existing) return;
    db.prepare(`
      INSERT OR IGNORE INTO meeting_tasks
        (source_key, meeting_date, title, description, assignee_id, due_date, priority, status, reminder_enabled, created_by)
      VALUES (?, date('now'), ?, ?, ?, ?, ?, 'new', 1, ?)
    `).run(sourceKey, alert.title, alert.detail, findAssigneeId(alert.owner), taskDueDate(alert.severity === 'critical' ? 3 : 7), alert.severity === 'critical' ? 'critical' : 'high', actor || 'План 1000 точек');
    created += Number(db.prepare('SELECT changes() AS c').get().c || 0);
  });
  return { created, alerts: data.alerts.length };
}

module.exports = {
  DEFAULT_SETTINGS,
  buildGrowthPlanDashboard,
  financialModel,
  quarterlyModel,
  getSettings,
  saveSettings,
  syncGrowthPlanTasks,
};
