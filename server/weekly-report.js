// weekly-report.js — управленческий отчёт за предыдущую завершённую неделю.
// Формируется по запросу администратора, сохраняется в /data/reports и
// возвращает два файла: Excel-совместимую книгу SpreadsheetML и PDF.
'use strict';

const db = require('./db');
const fs = require('node:fs');
const path = require('node:path');
const { findFont, writePdfFromJpegs } = require('./weekly-report-pdf');
const { renderWeeklyPdf } = require('./weekly-report-pdf-runner');
const { sendTelegram, sendTelegramDocument } = require('./telegram');
const { calculateBsc } = require('./bsc');
const { createAnalyticsCache } = require('./analytics-cache');
const { PAID_PHONE_KEY_SQL } = require('./report-phone-key');
const { buildGrowthPlanDashboard, syncGrowthPlanTasks } = require('./growth-plan');

const REPORTS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'reports');
const KRASNOYARSK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAX_RATE = 0.06;
const ACQUIRING_RATE = 0.02;

function pad(value) { return String(value).padStart(2, '0'); }

function localDateKeyFromMs(localMs) {
  const date = new Date(localMs);
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

function previousCompletedWeek(now = new Date()) {
  const localNow = new Date(now.getTime() + KRASNOYARSK_OFFSET_MS);
  const dayFromMonday = (localNow.getUTCDay() + 6) % 7;
  const currentMondayLocal = Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() - dayFromMonday
  );
  const startLocal = currentMondayLocal - 7 * DAY_MS;
  const endLocalExclusive = currentMondayLocal;
  return {
    start_local: localDateKeyFromMs(startLocal),
    end_local: localDateKeyFromMs(endLocalExclusive - DAY_MS),
    previous_start_local: localDateKeyFromMs(startLocal - 7 * DAY_MS),
    previous_end_local: localDateKeyFromMs(startLocal - DAY_MS),
    start_utc: new Date(startLocal - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    end_utc_exclusive: new Date(endLocalExclusive - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    previous_start_utc: new Date(startLocal - 7 * DAY_MS - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    previous_end_utc_exclusive: new Date(startLocal - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
  };
}

// Произвольный период по локальным (красноярским) датам ГГГГ-ММ-ДД, обе
// включительно. Проверяет формат и границы, бросает Error с понятным текстом —
// маршрут отдаёт его администратору как есть. «Предыдущий» период для сравнения
// — окно той же длины непосредственно перед выбранным.
const MAX_PERIOD_DAYS = 31;

function customPeriod(startLocal, endLocal) {
  const format = /^\d{4}-\d{2}-\d{2}$/;
  if (!format.test(startLocal) || !format.test(endLocal)) {
    throw new Error('Укажите даты периода в формате ГГГГ-ММ-ДД');
  }
  const startMs = Date.parse(startLocal + 'T00:00:00Z');
  const endMs = Date.parse(endLocal + 'T00:00:00Z');
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('Некорректные даты периода');
  if (endMs < startMs) throw new Error('Дата окончания периода раньше даты начала');
  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw new Error('Период не может быть длиннее ' + MAX_PERIOD_DAYS + ' дня — для более длинных интервалов формируйте отчёт по частям');
  }
  const todayLocalMs = Date.parse(localDateKeyFromMs(Date.now() + KRASNOYARSK_OFFSET_MS) + 'T00:00:00Z');
  if (endMs > todayLocalMs) throw new Error('Период не может выходить за пределы сегодняшнего дня');
  const endExclusiveMs = endMs + DAY_MS;
  return {
    start_local: startLocal,
    end_local: endLocal,
    previous_start_local: localDateKeyFromMs(startMs - days * DAY_MS),
    previous_end_local: localDateKeyFromMs(startMs - DAY_MS),
    start_utc: new Date(startMs - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    end_utc_exclusive: new Date(endExclusiveMs - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    previous_start_utc: new Date(startMs - days * DAY_MS - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
    previous_end_utc_exclusive: new Date(startMs - KRASNOYARSK_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' '),
  };
}

function localDateKey(utcSqlDate) {
  const date = new Date(String(utcSqlDate).replace(' ', 'T') + 'Z');
  return localDateKeyFromMs(date.getTime() + KRASNOYARSK_OFFSET_MS);
}

function normalizePhone(value) { return String(value || '').replace(/\D/g, '').slice(-10); }
function sum(rows, field) { return rows.reduce((total, row) => total + Number(row[field] || 0), 0); }
function pctChange(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round((current - previous) / previous * 1000) / 10;
}
function percent(value) { return Math.round(Number(value || 0) * 10) / 10; }

function getOrders(start, end) {
  return db.prepare(`
    SELECT o.*, p.name AS point_name, p.city_id, c.name AS city_name
    FROM orders o
    LEFT JOIN points p ON p.id = o.point_id
    LEFT JOIN cities c ON c.id = p.city_id
    WHERE o.created_at >= ? AND o.created_at < ?
    ORDER BY o.created_at, o.id
  `).all(start, end);
}

function effectiveRevenue(order) {
  return Math.max(0, Number(order.total || 0) - Number(order.refunded_amount || 0));
}

function getPeriodItems(start, end) {
  return db.prepare(`
    SELECT oi.name, oi.weight,
           SUM(CASE WHEN COALESCE(o.refunded_amount, 0) < o.total THEN oi.qty ELSE 0 END) AS units,
           SUM(oi.price * oi.qty *
             CASE WHEN o.total > 0 THEN MAX(0, o.total - COALESCE(o.refunded_amount, 0)) * 1.0 / o.total ELSE 0 END
           ) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' AND o.created_at >= ? AND o.created_at < ?
    GROUP BY oi.name, oi.weight
    ORDER BY revenue DESC, units DESC, oi.name
  `).all(start, end).map((row) => ({
    ...row, units: Number(row.units || 0), revenue: Math.round(Number(row.revenue || 0)),
  }));
}

function getExpenses(period) {
  return db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM expenses
    WHERE expense_date BETWEEN ? AND ?
    GROUP BY category ORDER BY total DESC
  `).all(period.start_local, period.end_local).map((row) => ({
    category: row.category, total: Number(row.total || 0),
  }));
}

function collectMetrics(start, end, periodForExpenses) {
  const orders = getOrders(start, end);
  const paidOrders = orders.filter((order) => order.status === 'paid');
  const revenue = paidOrders.reduce((total, order) => total + effectiveRevenue(order), 0);
  const refunds = paidOrders.reduce((total, order) => total + Number(order.refunded_amount || 0), 0);
  const units = paidOrders.length ? Number(db.prepare(`
    SELECT COALESCE(SUM(oi.qty), 0) AS total
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' AND COALESCE(o.refunded_amount, 0) < o.total
      AND o.created_at >= ? AND o.created_at < ?
  `).get(start, end).total || 0) : 0;
  const phones = new Set(paidOrders.map((order) => normalizePhone(order.customer_phone)).filter(Boolean));
  const partnerCommission = Math.round(paidOrders.reduce(
    (total, order) => total + effectiveRevenue(order) * Number(order.commission_rate || 0), 0
  ));
  const managerRates = new Map(db.prepare(
    'SELECT point_id, commission_rate FROM manager_points WHERE point_id IS NOT NULL'
  ).all().map((row) => [String(row.point_id), Number(row.commission_rate || 0)]));
  const ownerRates = new Map(db.prepare(
    'SELECT point_id, commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active = 1'
  ).all().map((row) => [String(row.point_id), Number(row.commission_rate || 0)]));
  const managerCommission = Math.round(paidOrders.reduce(
    (total, order) => total + effectiveRevenue(order) * Number(managerRates.get(String(order.point_id)) || 0), 0
  ));
  const ownerCommission = Math.round(paidOrders.reduce(
    (total, order) => total + effectiveRevenue(order) * Number(ownerRates.get(String(order.point_id)) || 0), 0
  ));
  const expenses = periodForExpenses ? getExpenses(periodForExpenses) : [];
  const manualExpenses = sum(expenses, 'total');
  const tax = Math.round(revenue * TAX_RATE);
  const acquiring = Math.round(revenue * ACQUIRING_RATE);
  const totalCosts = partnerCommission + managerCommission + ownerCommission + manualExpenses + tax + acquiring;
  const netProfit = revenue - totalCosts;
  return {
    orders, paidOrders, revenue, refunds, units, unique_customers: phones.size,
    average_check: paidOrders.length ? Math.round(revenue / paidOrders.length) : 0,
    payment_conversion: orders.length ? percent(paidOrders.length / orders.length * 100) : 0,
    expenses,
    costs: { partnerCommission, managerCommission, ownerCommission, manualExpenses, tax, acquiring, totalCosts },
    net_profit: netProfit,
    margin_percent: revenue ? percent(netProfit / revenue * 100) : 0,
  };
}

function buildPoints(current, previous) {
  const points = db.prepare(`
    SELECT p.id, p.name, p.addr, p.active, p.city_id, c.name AS city_name
    FROM points p LEFT JOIN cities c ON c.id = p.city_id
    ORDER BY p.active DESC, c.name, p.name
  `).all();

  // Aggregate once in memory. Filtering every order once per point was
  // O(points * orders), and SQLite was queried separately for every point.
  const paidByPoint = new Map();
  for (const order of current.paidOrders) {
    const id = String(order.point_id);
    let totals = paidByPoint.get(id);
    if (!totals) {
      totals = { revenue: 0, count: 0 };
      paidByPoint.set(id, totals);
    }
    totals.revenue += effectiveRevenue(order);
    totals.count++;
  }
  const previousRevenue = new Map();
  for (const order of previous.paidOrders) {
    const id = String(order.point_id || 'other');
    previousRevenue.set(id, (previousRevenue.get(id) || 0) + effectiveRevenue(order));
  }

  const stockRows = db.prepare(`
    SELECT s.point_id, COUNT(*) AS positions,
           SUM(CASE WHEN s.qty = 0 THEN 1 ELSE 0 END) AS out_count,
           SUM(CASE WHEN s.qty BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS low_count,
           COALESCE(SUM(s.qty * v.price), 0) AS retail_value
    FROM stock s
    JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
    JOIN products pr ON pr.id = v.product_id AND pr.active = 1
    GROUP BY s.point_id
  `).all();
  const stockByPoint = new Map(stockRows.map(row => [String(row.point_id), row]));

  return points.map(point => {
    const id = String(point.id);
    const currentTotals = paidByPoint.get(id) || { revenue: 0, count: 0 };
    const revenue = currentTotals.revenue;
    const count = currentTotals.count;
    const stock = stockByPoint.get(id) || {};
    const prevRevenue = previousRevenue.get(id) || 0;
    return {
      id: point.id, name: point.name, city: point.city_name || point.city_id || '—', active: !!point.active,
      revenue, previous_revenue: prevRevenue, change_percent: pctChange(revenue, prevRevenue),
      orders_count: count, average_check: count ? Math.round(revenue / count) : 0,
      out_count: Number(stock.out_count || 0), low_count: Number(stock.low_count || 0),
      retail_stock_value: Number(stock.retail_value || 0),
    };
  }).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'));
}

function buildProducts(period, previousPeriod) {
  const current = getPeriodItems(period.start_utc, period.end_utc_exclusive);
  const previous = getPeriodItems(previousPeriod.start, previousPeriod.end);
  const previousMap = new Map(previous.map((item) => [item.name + '\u0000' + item.weight, item]));
  return current.map((item) => {
    const prev = previousMap.get(item.name + '\u0000' + item.weight);
    return {
      ...item,
      previous_units: prev ? prev.units : 0,
      previous_revenue: prev ? prev.revenue : 0,
      change_percent: pctChange(item.revenue, prev ? prev.revenue : 0),
    };
  });
}

function buildCustomers(current, period) {
  const counts = new Map();
  current.paidOrders.forEach(order => {
    const phone = normalizePhone(order.customer_phone);
    if (phone) counts.set(phone, (counts.get(phone) || 0) + 1);
  });
  const phones = Array.from(counts.keys());

  // Query only phones present in this period. The matching expression is
  // indexed for paid orders, so historical phones stay in SQLite, not in JS.
  const firstByPhone = new Map();
  for (let i = 0; i < phones.length; i += 200) {
    const batch = phones.slice(i, i + 200);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT ${PAID_PHONE_KEY_SQL} AS phone_key, MIN(created_at) AS first_paid_at
      FROM orders WHERE status = 'paid'
        AND ${PAID_PHONE_KEY_SQL} IN (${placeholders})
      GROUP BY ${PAID_PHONE_KEY_SQL}
    `).all(...batch);
    rows.forEach(row => firstByPhone.set(row.phone_key, row.first_paid_at));
  }
  const newCustomers = phones.filter(phone => {
    const first = firstByPhone.get(phone);
    return first && first >= period.start_utc && first < period.end_utc_exclusive;
  }).length;
  const repeatWithinWeek = phones.filter(phone => counts.get(phone) > 1).length;
  const returning = phones.length - newCustomers;
  const bones = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS accrued,
      COALESCE(ABS(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)), 0) AS spent
    FROM bone_transactions
    WHERE created_at >= ? AND created_at < ?
  `).get(period.start_utc, period.end_utc_exclusive);
  return {
    unique: phones.length, new_customers: newCustomers, returning_customers: returning,
    returning_share: phones.length ? percent(returning / phones.length * 100) : 0,
    repeat_within_week: repeatWithinWeek,
    bones_accrued: Number(bones.accrued || 0), bones_spent: Number(bones.spent || 0),
  };
}

function buildDaily(current, previous, period) {
  const rows = [];
  const startLocalMs = Date.parse(period.start_local + 'T00:00:00Z');
  // Длина выбранного периода в днях: для недели — 7, для произвольного — сколько выбрали.
  // Сравнение идёт день-в-день с окном той же длины непосредственно перед периодом.
  const days = Math.round((Date.parse(period.end_local + 'T00:00:00Z') - startLocalMs) / DAY_MS) + 1;
  for (let index = 0; index < days; index += 1) {
    const date = localDateKeyFromMs(startLocalMs + index * DAY_MS);
    const currentOrders = current.paidOrders.filter((order) => localDateKey(order.created_at) === date);
    const previousDate = localDateKeyFromMs(startLocalMs + (index - days) * DAY_MS);
    const previousOrders = previous.paidOrders.filter((order) => localDateKey(order.created_at) === previousDate);
    rows.push({
      date,
      revenue: currentOrders.reduce((total, order) => total + effectiveRevenue(order), 0),
      orders_count: currentOrders.length,
      previous_revenue: previousOrders.reduce((total, order) => total + effectiveRevenue(order), 0),
      previous_orders_count: previousOrders.length,
    });
  }
  return rows;
}

function buildOperations(period) {
  const stock = db.prepare(`
    SELECT
      SUM(CASE WHEN s.qty = 0 THEN 1 ELSE 0 END) AS out_positions,
      SUM(CASE WHEN s.qty BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS low_positions,
      COALESCE(SUM(s.qty * v.price), 0) AS retail_value,
      COALESCE(SUM(s.qty * COALESCE(v.cost_price, 0)), 0) AS cost_value
    FROM stock s
    JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
    JOIN products p ON p.id = v.product_id AND p.active = 1
    JOIN points pt ON pt.id = s.point_id AND pt.active = 1
  `).get();
  const warehouse = db.prepare(`
    SELECT COALESCE(SUM(ws.qty), 0) AS units,
           COALESCE(SUM(ws.qty * v.price), 0) AS retail_value,
           COALESCE(SUM(ws.qty * COALESCE(v.cost_price, 0)), 0) AS cost_value
    FROM warehouse_stock ws
    JOIN product_variants v ON v.id = ws.variant_id AND v.active = 1
  `).get();
  const movements = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' AND reviewed_at >= ? AND reviewed_at < ? THEN 1 ELSE 0 END) AS approved_week
    FROM stock_movements
  `).get(period.start_utc, period.end_utc_exclusive);
  const payouts = {
    partner: Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM partner_payouts WHERE paid_at >= ? AND paid_at < ?').get(period.start_utc, period.end_utc_exclusive).total || 0),
    owner: Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM owner_payouts WHERE paid_at >= ? AND paid_at < ?').get(period.start_utc, period.end_utc_exclusive).total || 0),
  };
  const team = {
    new_partners: Number(db.prepare('SELECT COUNT(*) AS count FROM partners WHERE created_at >= ? AND created_at < ?').get(period.start_utc, period.end_utc_exclusive).count || 0),
    new_owners: Number(db.prepare('SELECT COUNT(*) AS count FROM salon_owners WHERE created_at >= ? AND created_at < ?').get(period.start_utc, period.end_utc_exclusive).count || 0),
    new_managers: Number(db.prepare('SELECT COUNT(*) AS count FROM managers WHERE created_at >= ? AND created_at < ?').get(period.start_utc, period.end_utc_exclusive).count || 0),
    active_points: Number(db.prepare('SELECT COUNT(*) AS count FROM points WHERE active = 1').get().count || 0),
  };
  return {
    stock: {
      out_positions: Number(stock.out_positions || 0), low_positions: Number(stock.low_positions || 0),
      retail_value: Number(stock.retail_value || 0), cost_value: Number(stock.cost_value || 0),
    },
    warehouse: {
      units: Number(warehouse.units || 0), retail_value: Number(warehouse.retail_value || 0), cost_value: Number(warehouse.cost_value || 0),
    },
    movements: { pending: Number(movements.pending || 0), approved_week: Number(movements.approved_week || 0) },
    payouts, team,
  };
}

function buildAlerts(report) {
  const alerts = [];
  const revenueChange = report.comparison.revenue_change_percent;
  if (revenueChange !== null && revenueChange <= -15) alerts.push('Выручка снизилась на ' + Math.abs(revenueChange) + '% к предыдущей неделе.');
  if (report.current.payment_conversion < 85 && report.current.orders.length > 0) alerts.push('Конверсия созданных заказов в оплату ниже 85%: ' + report.current.payment_conversion + '%.');
  if (report.current.margin_percent < 0) alerts.push('Неделя закрыта с отрицательной расчётной маржой: ' + report.current.margin_percent + '%.');
  const zeroSales = report.points.filter((point) => point.active && point.orders_count === 0);
  if (zeroSales.length) alerts.push('Без продаж: ' + zeroSales.slice(0, 5).map((point) => point.name).join(', ') + (zeroSales.length > 5 ? ' и ещё ' + (zeroSales.length - 5) : '') + '.');
  if (report.operations.stock.out_positions) alerts.push('На активных точках отсутствуют ' + report.operations.stock.out_positions + ' товарных позиций.');
  if (report.operations.stock.low_positions) alerts.push('Критически низкий остаток (1–2 шт.) у ' + report.operations.stock.low_positions + ' позиций.');
  if (report.operations.movements.pending) alerts.push('Ожидают проверки отчёты о перемещении товара: ' + report.operations.movements.pending + '.');
  if (report.growth_plan && report.growth_plan.progress.status === 'red') {
    alerts.push('План 1000 точек: отставание от цели на текущую дату — ' + Math.abs(report.growth_plan.progress.gap_to_date) + ' активных точек.');
  }
  if (!alerts.length) alerts.push('Критических отклонений по данным системы за неделю не выявлено.');
  return alerts;
}

function collectWeeklyReportForPeriod(period) {
  const current = collectMetrics(period.start_utc, period.end_utc_exclusive, period);
  const previous = collectMetrics(period.previous_start_utc, period.previous_end_utc_exclusive, {
    start_local: period.previous_start_local,
    end_local: period.previous_end_local,
  });
  const points = buildPoints(current, previous);
  const products = buildProducts(period, { start: period.previous_start_utc, end: period.previous_end_utc_exclusive });
  const report = {
    period, current, previous, points, products,
    customers: buildCustomers(current, period),
    daily: buildDaily(current, previous, period),
    operations: buildOperations(period),
    comparison: {
      revenue_change_percent: pctChange(current.revenue, previous.revenue),
      orders_change_percent: pctChange(current.paidOrders.length, previous.paidOrders.length),
      average_check_change_percent: pctChange(current.average_check, previous.average_check),
      customers_change_percent: pctChange(current.unique_customers, previous.unique_customers),
    },
    generated_at: new Date().toISOString(),
  };
  report.growth_plan = buildGrowthPlanDashboard();
  report.alerts = buildAlerts(report);
  report.bsc = calculateBsc(report);
  return report;
}

// BSC needs the core weekly KPIs, point stock and one movement count. Avoid
// generating product rankings, daily series, full operations, growth forecasts
// and PDF-only alerts every time an owner opens a dashboard.
function collectWeeklyBscReport(now = new Date()) {
  const period = previousCompletedWeek(now);
  const current = collectMetrics(period.start_utc, period.end_utc_exclusive, period);
  const previous = collectMetrics(period.previous_start_utc, period.previous_end_utc_exclusive, {
    start_local: period.previous_start_local,
    end_local: period.previous_end_local,
  });
  const points = buildPoints(current, previous);
  const customers = buildCustomers(current, period);
  const pending = db.prepare(
    "SELECT COUNT(*) AS count FROM stock_movements WHERE status='pending'"
  ).get();
  const report = {
    period, current, previous, points, customers,
    operations: { movements: { pending: Number(pending.count || 0) } },
    comparison: {
      revenue_change_percent: pctChange(current.revenue, previous.revenue),
      orders_change_percent: pctChange(current.paidOrders.length, previous.paidOrders.length),
    },
  };
  report.bsc = calculateBsc(report);
  return report;
}

// Share only scored BSC and its period across the administrator and founders.
// Raw orders, phone numbers, personal investments, payment state and stock
// availability for checkout are never cached.
const revisionChanges = db.prepare('SELECT total_changes() AS n');
const revisionExternal = db.prepare('PRAGMA data_version');
const bscCache = createAnalyticsCache(
  () => revisionChanges.get().n + ':' + revisionExternal.get().data_version,
  { ttlMs: 30000, maxEntries: 2 }
);
function getCachedWeeklyBsc(now = new Date()) {
  const period = previousCompletedWeek(now);
  return bscCache.get(period.start_utc, () => {
    const report = collectWeeklyBscReport(now);
    return { period: report.period, bsc: report.bsc };
  });
}

function collectWeeklyReport(now = new Date()) {
  return collectWeeklyReportForPeriod(previousCompletedWeek(now));
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xlsCell(value, style) {
  const type = typeof value === 'number' && Number.isFinite(value) ? 'Number' : 'String';
  return '<Cell' + (style ? ' ss:StyleID="' + style + '"' : '') + '><Data ss:Type="' + type + '">' + xmlEscape(value) + '</Data></Cell>';
}
function xlsRow(values, style) { return '<Row>' + values.map((value) => xlsCell(value, style)).join('') + '</Row>'; }
function xlsSheet(name, rows, widths) {
  return '<Worksheet ss:Name="' + xmlEscape(name.slice(0, 31)) + '"><Table>' +
    (widths || []).map((width) => '<Column ss:Width="' + width + '"/>').join('') + rows.join('') +
    '</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>';
}
function changeLabel(value) { return value === null ? 'нет базы' : (value > 0 ? '+' : '') + value + '%'; }

function buildSpreadsheet(report) {
  const growthRows = [
    xlsRow(['План 1000 активных точек', 'Факт на дату формирования'], 'Title'),
    xlsRow(['Активные 30 дней', report.growth_plan.facts.active_30d]),
    xlsRow(['Включено в системе', report.growth_plan.facts.active_system]),
    xlsRow(['План на текущую дату', report.growth_plan.progress.target_to_date]),
    xlsRow(['Прогноз на конец года', report.growth_plan.progress.forecast_year_end]),
    xlsRow(['Требуемый темп в месяц', report.growth_plan.progress.required_per_month]),
    xlsRow(['Вложения в 998 запусков, ₽', report.growth_plan.financial.totals.expansion_investment]),
    xlsRow(['Расчётное внешнее финансирование, ₽', report.growth_plan.financial.totals.external_funding]),
    xlsRow([]),
    xlsRow(['Год','Новых точек','Цель сети','Темп / мес.','Выручка модели, ₽','Деньги бизнеса, ₽','Запуски, ₽','Денежный поток, ₽','Транш инвесторов, ₽'], 'Header'),
    ...report.growth_plan.financial.rows.map((row) => xlsRow([
      row.year, row.new_points, row.target_points, row.launches_per_month, row.revenue,
      row.business_cash, row.expansion_investment, row.net_cash, row.investor_tranche,
    ])),
    xlsRow([]),
    xlsRow(['Сценарий','Точек в 2031','Выручка за 5 лет, ₽','Вложения в запуски, ₽','Внешний капитал, ₽','Поток после расширения, ₽'], 'Header'),
    ...report.growth_plan.scenarios.map((row) => xlsRow([row.name,row.target_2031,row.revenue_5y,row.expansion_investment,row.external_funding,row.net_cash])),
    xlsRow([]),
    xlsRow(['Мощность команды и воронки','Факт','Требуется','Покрытие'], 'Header'),
    xlsRow(['Команда всего', report.growth_plan.capacity.current_team, report.growth_plan.capacity.team_target, '']),
    xlsRow(['Активные менеджеры', report.growth_plan.capacity.active_managers, report.growth_plan.capacity.required_managers, report.growth_plan.capacity.manager_gap >= 0 ? 'достаточно' : 'дефицит ' + Math.abs(report.growth_plan.capacity.manager_gap)]),
    xlsRow(['Лиды на месяц', report.growth_plan.capacity.leads.actual, report.growth_plan.capacity.leads.required, report.growth_plan.capacity.leads.coverage_percent + '%']),
    xlsRow(['Встречи на месяц', report.growth_plan.capacity.meetings.actual, report.growth_plan.capacity.meetings.required, report.growth_plan.capacity.meetings.coverage_percent + '%']),
    xlsRow(['Согласования на месяц', report.growth_plan.capacity.agreements.actual, report.growth_plan.capacity.agreements.required, report.growth_plan.capacity.agreements.coverage_percent + '%']),
    xlsRow([]),
    xlsRow(['Квартальный календарь','Новых точек','Сеть','Выручка, ₽','Деньги бизнеса, ₽','Запуски, ₽','Поток, ₽','Накоплено, ₽','Транш, ₽'], 'Header'),
    ...report.growth_plan.quarterly.quarters.map((row) => xlsRow([row.period,row.new_points,row.target_points,row.revenue,row.business_cash,row.expansion_investment,row.net_cash,row.cumulative_cash,row.investor_tranche])),
    xlsRow([]),
    xlsRow(['Условия масштабирования','Факт','Цель','Стоп-сигнал','Статус','Ответственный'], 'Header'),
    ...report.growth_plan.gates.gates.map((row) => xlsRow([row.name,row.actual === null ? 'нет данных' : row.actual + ' ' + row.unit,row.target + ' ' + row.unit,row.stop + ' ' + row.unit,row.status,row.owner])),
  ];
  const bscRows = [
    xlsRow(['Сбалансированная система показателей', report.period.start_local + ' — ' + report.period.end_local], 'Title'),
    xlsRow(['Общий индекс', report.bsc.overall_score + ' из 100']),
    xlsRow(['Рекомендация', report.bsc.readiness.title]),
    xlsRow(['Направление', 'Вес', 'Оценка', 'Статус', 'Показатель', 'Факт', 'Цель'], 'Header'),
  ];
  report.bsc.perspectives.forEach((perspective) => {
    perspective.kpis.forEach((kpi, index) => {
      bscRows.push(xlsRow([
        index === 0 ? perspective.name : '', index === 0 ? perspective.weight + '%' : '', index === 0 ? perspective.score : '',
        kpi.status === 'green' ? 'Цель достигнута' : (kpi.status === 'yellow' ? 'Требует внимания' : (kpi.status === 'red' ? 'Отклонение' : 'Нет базы')),
        kpi.name, kpi.actual === null ? 'нет базы' : kpi.actual + ' ' + kpi.unit, kpi.target + ' ' + kpi.unit,
      ]));
    });
  });
  bscRows.push(xlsRow([]), xlsRow(['Открытые планы улучшения'], 'Header'));
  bscRows.push(xlsRow(['План', 'Ответственный', 'Срок', 'Статус'], 'Header'));
  report.bsc.initiatives_summary.items.forEach((item) => bscRows.push(xlsRow([
    item.title, item.responsible, item.due_date, item.overdue ? 'Просрочен' : (item.status === 'in_progress' ? 'В работе' : 'Запланирован'),
  ])));
  const summary = [
    xlsRow(['Отчёт для планёрки ГД', report.period.start_local + ' — ' + report.period.end_local], 'Title'),
    xlsRow(['Показатель', 'Неделя', 'Предыдущая неделя', 'Изменение'], 'Header'),
    xlsRow(['Выручка, ₽', report.current.revenue, report.previous.revenue, changeLabel(report.comparison.revenue_change_percent)]),
    xlsRow(['Оплаченные заказы', report.current.paidOrders.length, report.previous.paidOrders.length, changeLabel(report.comparison.orders_change_percent)]),
    xlsRow(['Средний чек, ₽', report.current.average_check, report.previous.average_check, changeLabel(report.comparison.average_check_change_percent)]),
    xlsRow(['Уникальные покупатели', report.current.unique_customers, report.previous.unique_customers, changeLabel(report.comparison.customers_change_percent)]),
    xlsRow(['Товаров продано, шт.', report.current.units, report.previous.units, changeLabel(pctChange(report.current.units, report.previous.units))]),
    xlsRow(['Возвраты, ₽', report.current.refunds, report.previous.refunds, '']),
    xlsRow(['Конверсия заказ → оплата', report.current.payment_conversion + '%', report.previous.payment_conversion + '%', '']),
    xlsRow(['Чистая расчётная прибыль, ₽', report.current.net_profit, report.previous.net_profit, changeLabel(pctChange(report.current.net_profit, report.previous.net_profit))]),
    xlsRow(['Маржа', report.current.margin_percent + '%', report.previous.margin_percent + '%', '']),
    xlsRow([]), xlsRow(['Риски и вопросы для планёрки'], 'Header'),
    ...report.alerts.map((alert) => xlsRow([alert])),
  ];
  const pointRows = [xlsRow(['Точка', 'Город', 'Выручка', 'Заказов', 'Средний чек', 'Выручка ранее', 'Изменение', 'Нет в наличии', 'Осталось 1–2', 'Товар на полке, ₽'], 'Header')]
    .concat(report.points.map((point) => xlsRow([
      point.name, point.city, point.revenue, point.orders_count, point.average_check, point.previous_revenue,
      changeLabel(point.change_percent), point.out_count, point.low_count, point.retail_stock_value,
    ])));
  const productRows = [xlsRow(['Товар', 'Вариант', 'Продано, шт.', 'Выручка, ₽', 'Продано ранее', 'Выручка ранее', 'Изменение'], 'Header')]
    .concat(report.products.map((product) => xlsRow([
      product.name, product.weight, product.units, product.revenue, product.previous_units,
      product.previous_revenue, changeLabel(product.change_percent),
    ])));
  const dailyRows = [xlsRow(['Дата', 'Выручка', 'Заказов', 'Выручка ранее', 'Заказов ранее'], 'Header')]
    .concat(report.daily.map((day) => xlsRow([day.date, day.revenue, day.orders_count, day.previous_revenue, day.previous_orders_count])));
  const financeRows = [
    xlsRow(['Статья', 'Сумма, ₽'], 'Header'),
    xlsRow(['Выручка после возвратов', report.current.revenue]),
    xlsRow(['Комиссия грумерам', report.current.costs.partnerCommission]),
    xlsRow(['Комиссия менеджерам', report.current.costs.managerCommission]),
    xlsRow(['Комиссия владельцам', report.current.costs.ownerCommission]),
    xlsRow(['Налог 6%', report.current.costs.tax]),
    xlsRow(['Эквайринг 2%', report.current.costs.acquiring]),
    ...report.current.expenses.map((expense) => xlsRow([expense.category, expense.total])),
    xlsRow(['Всего затрат', report.current.costs.totalCosts], 'Strong'),
    xlsRow(['Чистая расчётная прибыль', report.current.net_profit], 'Strong'),
    xlsRow(['Маржа', report.current.margin_percent + '%'], 'Strong'),
  ];
  const customerRows = [
    xlsRow(['Показатель', 'Значение'], 'Header'),
    xlsRow(['Уникальные покупатели', report.customers.unique]),
    xlsRow(['Новые покупатели', report.customers.new_customers]),
    xlsRow(['Вернувшиеся покупатели', report.customers.returning_customers]),
    xlsRow(['Доля вернувшихся', report.customers.returning_share + '%']),
    xlsRow(['Купили более одного раза за неделю', report.customers.repeat_within_week]),
    xlsRow(['Начислено косточек', report.customers.bones_accrued]),
    xlsRow(['Потрачено косточек', report.customers.bones_spent]),
    xlsRow(['Создано заказов', report.current.orders.length]),
    xlsRow(['Оплачено', report.current.paidOrders.length]),
    xlsRow(['Конверсия в оплату', report.current.payment_conversion + '%']),
    xlsRow(['Возвращено клиентам, ₽', report.current.refunds]),
  ];
  const operationRows = [
    xlsRow(['Показатель', 'Значение'], 'Header'),
    xlsRow(['Активных точек', report.operations.team.active_points]),
    xlsRow(['Позиций нет в наличии', report.operations.stock.out_positions]),
    xlsRow(['Позиций с остатком 1–2', report.operations.stock.low_positions]),
    xlsRow(['Розничная стоимость товара на точках, ₽', report.operations.stock.retail_value]),
    xlsRow(['Себестоимость товара на точках, ₽', report.operations.stock.cost_value]),
    xlsRow(['Единиц на центральных складах', report.operations.warehouse.units]),
    xlsRow(['Розничная стоимость центральных складов, ₽', report.operations.warehouse.retail_value]),
    xlsRow(['Перемещений согласовано за неделю', report.operations.movements.approved_week]),
    xlsRow(['Перемещений ожидает проверки', report.operations.movements.pending]),
    xlsRow(['Выплачено грумерам, ₽', report.operations.payouts.partner]),
    xlsRow(['Выплачено владельцам, ₽', report.operations.payouts.owner]),
    xlsRow(['Новых грумеров', report.operations.team.new_partners]),
    xlsRow(['Новых владельцев', report.operations.team.new_owners]),
    xlsRow(['Новых менеджеров', report.operations.team.new_managers]),
  ];
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles>' +
      '<Style ss:ID="Default"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>' +
      '<Style ss:ID="Title"><Font ss:Bold="1" ss:Size="15" ss:Color="#1C3A2F"/><Interior ss:Color="#D9F0E5" ss:Pattern="Solid"/></Style>' +
      '<Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1C3A2F" ss:Pattern="Solid"/></Style>' +
      '<Style ss:ID="Strong"><Font ss:Bold="1"/><Interior ss:Color="#FFF1D6" ss:Pattern="Solid"/></Style>' +
    '</Styles>' +
    xlsSheet('План 1000 точек', growthRows, [90,95,90,90,125,125,105,125,125]) +
    xlsSheet('BSC · Стратегия', bscRows, [190, 70, 75, 115, 230, 100, 100]) +
    xlsSheet('Резюме', summary, [220, 120, 120, 100]) +
    xlsSheet('Точки', pointRows, [180, 110, 80, 65, 80, 85, 80, 80, 80, 105]) +
    xlsSheet('Товары', productRows, [210, 90, 80, 85, 85, 90, 80]) +
    xlsSheet('Динамика по дням', dailyRows, [90, 90, 70, 100, 90]) +
    xlsSheet('P&L', financeRows, [230, 110]) +
    xlsSheet('Клиенты и оплаты', customerRows, [260, 110]) +
    xlsSheet('Операции и остатки', operationRows, [290, 110]) +
    '</Workbook>';
}

function telegramSummary(report) {
  return [
    '📊 <b>Отчёт для планёрки ГД</b>',
    report.period.start_local + ' — ' + report.period.end_local,
    '',
    'Выручка: <b>' + rub(report.current.revenue) + '</b> (' + metricChange(report.comparison.revenue_change_percent) + ')',
    'Оплачено заказов: <b>' + report.current.paidOrders.length + '</b>',
    'Средний чек: <b>' + rub(report.current.average_check) + '</b>',
    'Чистая расчётная прибыль: <b>' + rub(report.current.net_profit) + '</b> · маржа ' + report.current.margin_percent + '%',
    'Платёжная конверсия: <b>' + report.current.payment_conversion + '%</b>',
    'Индекс BSC: <b>' + report.bsc.overall_score + ' из 100</b> · ' + telegramEscape(report.bsc.readiness.title),
    'План 1000 точек: <b>' + report.growth_plan.facts.active_30d + ' активных</b> при плане на дату ' + report.growth_plan.progress.target_to_date + ' · прогноз года ' + report.growth_plan.progress.forecast_year_end,
    'Мощность: <b>' + report.growth_plan.capacity.active_managers + ' из ' + report.growth_plan.capacity.required_managers + ' менеджеров</b> · лиды закрывают ' + report.growth_plan.capacity.leads.coverage_percent + '% потребности',
    'Квартальный резерв: <b>' + rub(report.growth_plan.quarterly.totals.external_funding) + '</b>' + (report.growth_plan.quarterly.first_funding ? ' · первый транш ' + report.growth_plan.quarterly.first_funding.period : ''),
    'Решение по масштабированию: <b>' + telegramEscape(report.growth_plan.gates.title) + '</b>',
    '',
    '<b>Главный фокус:</b> ' + telegramEscape(report.alerts[0]),
    '',
    'PDF и Excel приложены следующими сообщениями.',
  ].join('\n');
}

function telegramEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function createWeeklyReport(adminPayload, options = {}) {
  await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
  // Период: либо выбранный администратором (options.period от customPeriod),
  // либо предыдущая завершённая неделя, как раньше.
  const report = options.period
    ? collectWeeklyReportForPeriod(options.period)
    : collectWeeklyReport(options.now || new Date());
  // Красные и жёлтые отклонения пятилетнего плана превращаются в поручения.
  // source_key не позволяет создавать дубли при повторном формировании отчёта.
  syncGrowthPlanTasks(report.growth_plan, adminPayload.login || 'Отчёт ГД');
  const baseName = 'weekly-gd-' + report.period.start_local + '_' + report.period.end_local;
  const excelName = baseName + '.xls';
  const pdfName = baseName + '.pdf';
  const excelPath = path.join(REPORTS_DIR, excelName);
  const pdfPath = path.join(REPORTS_DIR, pdfName);
  await fs.promises.writeFile(excelPath, buildSpreadsheet(report), 'utf8');
  await renderWeeklyPdf(report, pdfPath);

  // skipTelegram — администратор снял галочку отправки: файлы просто сохраняются
  // в архиве, статус 'skipped' показываем в архиве как «Не отправлялся».
  let telegramStatus = options.skipTelegram ? 'skipped' : 'not_configured';
  let telegramError = null;
  if (!options.skipTelegram && process.env.TG_TOKEN && process.env.TG_CHAT_ID) {
    try {
      const summaryResult = await sendTelegram(telegramSummary(report));
      const pdfResult = await sendTelegramDocument(pdfPath, 'Отчёт для планёрки ГД · PDF · ' + report.period.start_local + ' — ' + report.period.end_local);
      const excelResult = await sendTelegramDocument(excelPath, 'Отчёт для планёрки ГД · Excel · ' + report.period.start_local + ' — ' + report.period.end_local);
      telegramStatus = summaryResult.ok && pdfResult.ok && excelResult.ok ? 'sent' : 'failed';
      if (telegramStatus === 'failed') telegramError = 'Один или несколько файлов не отправлены';
    } catch (error) {
      telegramStatus = 'failed';
      telegramError = error.message;
    }
  }

  db.prepare(`
    INSERT INTO weekly_reports
      (week_start, week_end, excel_file, pdf_file, generated_by_admin_id,
       generated_by_admin_login, summary_json, telegram_status, telegram_error, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(week_start) DO UPDATE SET
      week_end = excluded.week_end,
      excel_file = excluded.excel_file,
      pdf_file = excluded.pdf_file,
      generated_by_admin_id = excluded.generated_by_admin_id,
      generated_by_admin_login = excluded.generated_by_admin_login,
      summary_json = excluded.summary_json,
      telegram_status = excluded.telegram_status,
      telegram_error = excluded.telegram_error,
      generated_at = datetime('now')
  `).run(
    report.period.start_local, report.period.end_local, excelName, pdfName,
    adminPayload.id || null, adminPayload.login || null,
    JSON.stringify({
      revenue: report.current.revenue,
      orders_count: report.current.paidOrders.length,
      average_check: report.current.average_check,
      net_profit: report.current.net_profit,
      margin_percent: report.current.margin_percent,
      payment_conversion: report.current.payment_conversion,
      revenue_change_percent: report.comparison.revenue_change_percent,
      bsc_score: report.bsc.overall_score,
      bsc_readiness: report.bsc.readiness.title,
      primary_alert: report.alerts[0],
      growth_active_points: report.growth_plan.facts.active_30d,
      growth_target_to_date: report.growth_plan.progress.target_to_date,
      growth_forecast_year_end: report.growth_plan.progress.forecast_year_end,
      growth_status: report.growth_plan.progress.status,
      growth_quarterly_funding: report.growth_plan.quarterly.totals.external_funding,
      growth_first_funding_period: report.growth_plan.quarterly.first_funding && report.growth_plan.quarterly.first_funding.period,
      growth_scale_decision: report.growth_plan.gates.title,
    }),
    telegramStatus, telegramError
  );
  const record = db.prepare('SELECT * FROM weekly_reports WHERE week_start = ?').get(report.period.start_local);
  return { record, report, telegram: { status: telegramStatus, error: telegramError } };
}

function listWeeklyReports(limit = 30) {
  return db.prepare('SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT ?').all(limit).map((row) => {
    let summary = {};
    try { summary = JSON.parse(row.summary_json || '{}'); } catch (_) { /* старая запись */ }
    return { ...row, summary };
  });
}

function resolveReportFile(record, format) {
  const fileName = format === 'excel' ? record.excel_file : record.pdf_file;
  if (!fileName || path.basename(fileName) !== fileName) return null;
  const filePath = path.join(REPORTS_DIR, fileName);
  if (!filePath.startsWith(REPORTS_DIR + path.sep) || !fs.existsSync(filePath)) return null;
  return { filePath, fileName };
}

module.exports = {
  findFont,
  writePdfFromJpegs,
  REPORTS_DIR,
  buildSpreadsheet,
  collectWeeklyReport,
  collectWeeklyBscReport,
  getCachedWeeklyBsc,
  collectWeeklyReportForPeriod,
  createWeeklyReport,
  customPeriod,
  listWeeklyReports,
  previousCompletedWeek,
  resolveReportFile,
};
