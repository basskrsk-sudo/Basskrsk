// weekly-report.js — управленческий отчёт за предыдущую завершённую неделю.
// Формируется по запросу администратора, сохраняется в /data/reports и
// возвращает два файла: Excel-совместимую книгу SpreadsheetML и PDF.
'use strict';

const db = require('./db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { sendTelegram, sendTelegramDocument } = require('./telegram');

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
  const previousRevenue = new Map();
  previous.paidOrders.forEach((order) => {
    const key = String(order.point_id || 'other');
    previousRevenue.set(key, (previousRevenue.get(key) || 0) + effectiveRevenue(order));
  });
  return points.map((point) => {
    const orders = current.paidOrders.filter((order) => String(order.point_id) === String(point.id));
    const revenue = orders.reduce((total, order) => total + effectiveRevenue(order), 0);
    const stock = db.prepare(`
      SELECT COUNT(*) AS positions,
             SUM(CASE WHEN s.qty = 0 THEN 1 ELSE 0 END) AS out_count,
             SUM(CASE WHEN s.qty BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS low_count,
             COALESCE(SUM(s.qty * v.price), 0) AS retail_value
      FROM stock s
      JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
      JOIN products pr ON pr.id = v.product_id AND pr.active = 1
      WHERE s.point_id = ?
    `).get(point.id);
    const prevRevenue = previousRevenue.get(String(point.id)) || 0;
    return {
      id: point.id, name: point.name, city: point.city_name || point.city_id || '—', active: !!point.active,
      revenue, previous_revenue: prevRevenue, change_percent: pctChange(revenue, prevRevenue),
      orders_count: orders.length, average_check: orders.length ? Math.round(revenue / orders.length) : 0,
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
  const firstOrderRows = db.prepare(`
    SELECT customer_phone, MIN(created_at) AS first_paid_at
    FROM orders WHERE status = 'paid' GROUP BY customer_phone
  `).all();
  const firstByPhone = new Map();
  firstOrderRows.forEach((row) => {
    const phone = normalizePhone(row.customer_phone);
    if (!phone) return;
    const existing = firstByPhone.get(phone);
    if (!existing || row.first_paid_at < existing) firstByPhone.set(phone, row.first_paid_at);
  });
  const counts = new Map();
  current.paidOrders.forEach((order) => {
    const phone = normalizePhone(order.customer_phone);
    if (phone) counts.set(phone, (counts.get(phone) || 0) + 1);
  });
  const phones = Array.from(counts.keys());
  const newCustomers = phones.filter((phone) => {
    const first = firstByPhone.get(phone);
    return first && first >= period.start_utc && first < period.end_utc_exclusive;
  }).length;
  const repeatWithinWeek = phones.filter((phone) => counts.get(phone) > 1).length;
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
  for (let index = 0; index < 7; index += 1) {
    const date = localDateKeyFromMs(startLocalMs + index * DAY_MS);
    const currentOrders = current.paidOrders.filter((order) => localDateKey(order.created_at) === date);
    const previousDate = localDateKeyFromMs(startLocalMs - 7 * DAY_MS + index * DAY_MS);
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
  if (!alerts.length) alerts.push('Критических отклонений по данным системы за неделю не выявлено.');
  return alerts;
}

function collectWeeklyReport(now = new Date()) {
  const period = previousCompletedWeek(now);
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
  report.alerts = buildAlerts(report);
  return report;
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
    xlsSheet('Резюме', summary, [220, 120, 120, 100]) +
    xlsSheet('Точки', pointRows, [180, 110, 80, 65, 80, 85, 80, 80, 80, 105]) +
    xlsSheet('Товары', productRows, [210, 90, 80, 85, 85, 90, 80]) +
    xlsSheet('Динамика по дням', dailyRows, [90, 90, 70, 100, 90]) +
    xlsSheet('P&L', financeRows, [230, 110]) +
    xlsSheet('Клиенты и оплаты', customerRows, [260, 110]) +
    xlsSheet('Операции и остатки', operationRows, [290, 110]) +
    '</Workbook>';
}

function findFont() {
  const candidates = [
    process.env.REPORT_FONT_PATH,
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',           // Alpine (пакет font-dejavu)
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',       // старые Alpine / Arch
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  // Debian / Ubuntu
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  // Запасной вариант: ищем DejaVuSans.ttf рекурсивно по стандартным папкам
  // шрифтов — на случай, если пакет в очередной версии ОС переедет в новый путь.
  for (const dir of ['/usr/share/fonts', '/usr/local/share/fonts']) {
    const hit = findFontRecursive(dir, 'DejaVuSans.ttf', 4);
    if (hit) return hit;
  }
  throw new Error('Шрифт DejaVu Sans для PDF не найден');
}

function findFontRecursive(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = dir + '/' + entry.name;
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = findFontRecursive(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function mvgEscape(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' '); }
function wrapText(value, maxChars) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    if (!line || (line + ' ' + word).length <= maxChars) line += (line ? ' ' : '') + word;
    else { lines.push(line); line = word; }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

class ReportPage {
  constructor(font, title, subtitle) {
    this.font = font;
    this.commands = [
      'push graphic-context', 'viewbox 0 0 1240 1754', "fill '#F7F5EF'", 'rectangle 0,0 1240,1754',
      "fill '#1C3A2F'", 'rectangle 0,0 1240,175', "font '" + mvgEscape(font) + "'",
    ];
    this.text(62, 78, title, 38, '#FFFFFF');
    this.text(62, 128, subtitle, 22, '#D9F0E5');
  }
  rect(x1, y1, x2, y2, fill, radius) {
    this.commands.push("fill '" + fill + "'", radius ? 'roundrectangle ' + [x1,y1,x2,y2,radius,radius].join(',') : 'rectangle ' + [x1,y1,x2,y2].join(','));
  }
  text(x, y, value, size, color, bold) {
    this.commands.push("font '" + mvgEscape(this.font) + "'", 'font-size ' + size, "fill '" + (color || '#2A2218') + "'", 'font-weight ' + (bold ? 700 : 400), "text " + x + ',' + y + " '" + mvgEscape(value) + "'");
  }
  wrapped(x, y, value, maxChars, size, color, lineHeight, bold) {
    const lines = wrapText(value, maxChars);
    lines.forEach((line, index) => this.text(x, y + index * (lineHeight || size * 1.35), line, size, color, bold));
    return y + lines.length * (lineHeight || size * 1.35);
  }
  card(x, y, width, height, label, value, accent) {
    this.rect(x, y, x + width, y + height, '#FFFFFF', 20);
    this.text(x + 22, y + 35, label, 18, '#7A7165', false);
    this.text(x + 22, y + 86, value, 31, accent || '#1C3A2F', true);
  }
  table(x, y, widths, headers, rows, options = {}) {
    const rowHeight = options.rowHeight || 52;
    const fontSize = options.fontSize || 17;
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    this.rect(x, y, x + totalWidth, y + rowHeight, '#1C3A2F', 8);
    let cursor = x;
    headers.forEach((header, index) => { this.text(cursor + 10, y + 33, header, 15, '#FFFFFF', true); cursor += widths[index]; });
    rows.forEach((row, rowIndex) => {
      const top = y + rowHeight * (rowIndex + 1);
      this.rect(x, top, x + totalWidth, top + rowHeight, rowIndex % 2 ? '#F3EFE7' : '#FFFFFF', 0);
      let cellX = x;
      row.forEach((cell, index) => {
        const maxChars = Math.max(5, Math.floor(widths[index] / (fontSize * .56)));
        const text = String(cell == null ? '' : cell);
        this.text(cellX + 10, top + 33, text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text, fontSize, '#2A2218', index === 0);
        cellX += widths[index];
      });
    });
    return y + rowHeight * (rows.length + 1);
  }
  finish() { return this.commands.concat(['pop graphic-context']).join('\n'); }
}

function rub(value) { return Math.round(Number(value || 0)).toLocaleString('ru-RU') + ' ₽'; }
function metricChange(value) { return value === null ? 'нет базы' : (value > 0 ? '+' : '') + value + '%'; }

function buildPdfPages(report, font) {
  const pages = [];
  const subtitle = report.period.start_local + ' — ' + report.period.end_local + ' · сформирован ' + new Date(report.generated_at).toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' });
  const first = new ReportPage(font, 'ХвостМаркет · Планёрка ГД', subtitle);
  first.text(62, 225, 'Ключевые показатели', 27, '#1C3A2F', true);
  const cards = [
    ['Выручка', rub(report.current.revenue), metricChange(report.comparison.revenue_change_percent)],
    ['Оплаченные заказы', String(report.current.paidOrders.length), metricChange(report.comparison.orders_change_percent)],
    ['Средний чек', rub(report.current.average_check), metricChange(report.comparison.average_check_change_percent)],
    ['Чистая прибыль', rub(report.current.net_profit), report.current.margin_percent + '% маржа'],
    ['Покупатели', String(report.current.unique_customers), metricChange(report.comparison.customers_change_percent)],
    ['Оплата заказов', report.current.payment_conversion + '%', report.current.orders.length + ' создано'],
  ];
  cards.forEach((card, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 62 + column * 382;
    const y = 255 + row * 145;
    first.card(x, y, 350, 118, card[0], card[1], index === 3 && report.current.net_profit < 0 ? '#9B2335' : '#1C3A2F');
    first.text(x + 22, y + 108, card[2], 14, '#D4872A', true);
  });
  first.text(62, 570, 'Выручка по дням', 27, '#1C3A2F', true);
  const maxDaily = Math.max(1, ...report.daily.flatMap((day) => [day.revenue, day.previous_revenue]));
  report.daily.forEach((day, index) => {
    const x = 92 + index * 158;
    const baseY = 900;
    const currentHeight = Math.round(day.revenue / maxDaily * 250);
    const prevHeight = Math.round(day.previous_revenue / maxDaily * 250);
    first.rect(x, baseY - prevHeight, x + 42, baseY, '#C9C2B7', 5);
    first.rect(x + 48, baseY - currentHeight, x + 90, baseY, '#D4872A', 5);
    first.text(x, baseY + 32, day.date.slice(5), 15, '#7A7165', false);
    first.text(x, baseY - currentHeight - 12, String(day.revenue), 13, '#1C3A2F', true);
  });
  first.text(62, 970, 'Риски и вопросы для обсуждения', 27, '#1C3A2F', true);
  let alertY = 1020;
  report.alerts.slice(0, 8).forEach((alert, index) => {
    first.rect(62, alertY - 28, 1178, alertY + 34, index === 0 && /сниз|отриц|ниже/.test(alert) ? '#FDECEA' : '#FFFFFF', 12);
    first.text(82, alertY + 7, String(index + 1) + '.', 18, '#D4872A', true);
    alertY = first.wrapped(118, alertY + 7, alert, 92, 17, '#2A2218', 24, false) + 22;
  });
  pages.push(first.finish());

  const second = new ReportPage(font, 'Продажи по точкам', subtitle);
  second.text(62, 225, 'Рейтинг точек', 27, '#1C3A2F', true);
  second.table(62, 255, [285,145,145,100,120,120], ['Точка','Город','Выручка','Заказы','Динамика','Низкий остаток'],
    report.points.slice(0, 12).map((point) => [point.name, point.city, rub(point.revenue), point.orders_count, metricChange(point.change_percent), point.out_count + point.low_count]),
    { rowHeight: 56, fontSize: 16 });
  second.text(62, 1030, 'Топ товаров', 27, '#1C3A2F', true);
  second.table(62, 1060, [360,150,150,160,160], ['Товар','Вариант','Штук','Выручка','Динамика'],
    report.products.slice(0, 9).map((product) => [product.name, product.weight, product.units, rub(product.revenue), metricChange(product.change_percent)]),
    { rowHeight: 56, fontSize: 16 });
  pages.push(second.finish());

  const third = new ReportPage(font, 'Финансы и клиенты', subtitle);
  third.text(62, 225, 'P&L недели', 27, '#1C3A2F', true);
  const pnlRows = [
    ['Выручка после возвратов', rub(report.current.revenue)],
    ['Комиссия грумерам', rub(report.current.costs.partnerCommission)],
    ['Комиссия менеджерам', rub(report.current.costs.managerCommission)],
    ['Комиссия владельцам', rub(report.current.costs.ownerCommission)],
    ['Налог 6%', rub(report.current.costs.tax)],
    ['Эквайринг 2%', rub(report.current.costs.acquiring)],
    ['Ручные расходы', rub(report.current.costs.manualExpenses)],
    ['Всего затрат', rub(report.current.costs.totalCosts)],
    ['Чистая прибыль', rub(report.current.net_profit)],
  ];
  third.table(62, 255, [500,300], ['Статья','Сумма'], pnlRows, { rowHeight: 58, fontSize: 18 });
  third.text(62, 880, 'Клиенты и лояльность', 27, '#1C3A2F', true);
  third.table(62, 910, [500,300], ['Показатель','Значение'], [
    ['Уникальные покупатели', report.customers.unique],
    ['Новые покупатели', report.customers.new_customers],
    ['Вернувшиеся покупатели', report.customers.returning_customers + ' · ' + report.customers.returning_share + '%'],
    ['Более одной покупки за неделю', report.customers.repeat_within_week],
    ['Начислено / потрачено косточек', report.customers.bones_accrued + ' / ' + report.customers.bones_spent],
    ['Возвращено клиентам', rub(report.current.refunds)],
  ], { rowHeight: 58, fontSize: 18 });
  pages.push(third.finish());

  const fourth = new ReportPage(font, 'Остатки и развитие сети', subtitle);
  fourth.text(62, 225, 'Операционное состояние', 27, '#1C3A2F', true);
  fourth.table(62, 255, [610,300], ['Показатель','Значение'], [
    ['Активных точек', report.operations.team.active_points],
    ['Позиций нет в наличии', report.operations.stock.out_positions],
    ['Позиций с остатком 1–2 шт.', report.operations.stock.low_positions],
    ['Розничная стоимость товара на точках', rub(report.operations.stock.retail_value)],
    ['Себестоимость товара на точках', rub(report.operations.stock.cost_value)],
    ['Единиц на центральных складах', report.operations.warehouse.units],
    ['Розничная стоимость центральных складов', rub(report.operations.warehouse.retail_value)],
    ['Перемещений согласовано / ожидает', report.operations.movements.approved_week + ' / ' + report.operations.movements.pending],
  ], { rowHeight: 60, fontSize: 18 });
  fourth.text(62, 850, 'Команда и выплаты', 27, '#1C3A2F', true);
  fourth.table(62, 880, [610,300], ['Показатель','Значение'], [
    ['Новых грумеров', report.operations.team.new_partners],
    ['Новых владельцев салонов', report.operations.team.new_owners],
    ['Новых менеджеров', report.operations.team.new_managers],
    ['Фактически выплачено грумерам', rub(report.operations.payouts.partner)],
    ['Фактически выплачено владельцам', rub(report.operations.payouts.owner)],
    ['Начислено комиссий за неделю', rub(report.current.costs.partnerCommission + report.current.costs.managerCommission + report.current.costs.ownerCommission)],
  ], { rowHeight: 60, fontSize: 18 });
  fourth.wrapped(62, 1390, 'Примечание: остатки приведены на момент формирования отчёта. Прибыль является управленческой оценкой на основе внесённых расходов, налога 6%, эквайринга 2% и действующих ставок комиссий.', 105, 17, '#7A7165', 25, false);
  pages.push(fourth.finish());
  return pages;
}

function imageMagickCommand() {
  if (spawnSync('convert', ['-version'], { stdio: 'ignore' }).status === 0) return 'convert';
  if (spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0) return 'magick';
  throw new Error('ImageMagick не найден — PDF не может быть сформирован');
}

// Собираем PDF сами из JPEG-страниц. Это намеренно не поручается ImageMagick:
// в серверных сборках его security policy нередко запрещает PDF-кодер, даже
// когда Ghostscript установлен. JPEG поддерживается тем же ImageMagick,
// который уже обязателен для фотографий товаров, а простой PDF-контейнер не
// требует дополнительных npm-пакетов или системных делегатов.
function writePdfFromJpegs(jpegPaths, outputPath) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const objects = [];
  const pageRefs = jpegPaths.map((_, index) => 3 + index * 3);
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  objects.push(Buffer.from(
    '<< /Type /Pages /Kids [' + pageRefs.map((id) => id + ' 0 R').join(' ') + '] /Count ' + jpegPaths.length + ' >>',
    'ascii'
  ));

  jpegPaths.forEach((jpegPath, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const imageName = 'Im' + (index + 1);
    const image = fs.readFileSync(jpegPath);
    const paint = Buffer.from(
      'q\n' + pageWidth + ' 0 0 ' + pageHeight + ' 0 0 cm\n/' + imageName + ' Do\nQ\n',
      'ascii'
    );
    objects.push(Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] ' +
      '/Resources << /XObject << /' + imageName + ' ' + imageId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>',
      'ascii'
    ));
    objects.push(Buffer.concat([
      Buffer.from('<< /Length ' + paint.length + ' >>\nstream\n', 'ascii'),
      paint,
      Buffer.from('endstream', 'ascii'),
    ]));
    objects.push(Buffer.concat([
      Buffer.from(
        '<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB ' +
        '/BitsPerComponent 8 /Filter /DCTDecode /Length ' + image.length + ' >>\nstream\n',
        'ascii'
      ),
      image,
      Buffer.from('\nendstream', 'ascii'),
    ]));
  });

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = Buffer.concat([
      Buffer.from((index + 1) + ' 0 obj\n', 'ascii'), object, Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(wrapped);
    length += wrapped.length;
  });
  const xrefOffset = length;
  const xref = ['xref', '0 ' + (objects.length + 1), '0000000000 65535 f '];
  for (let id = 1; id <= objects.length; id += 1) {
    xref.push(String(offsets[id]).padStart(10, '0') + ' 00000 n ');
  }
  chunks.push(Buffer.from(
    xref.join('\n') + '\ntrailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n' +
    'startxref\n' + xrefOffset + '\n%%EOF\n',
    'ascii'
  ));
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
}

function buildPdf(report, outputPath) {
  const font = findFont();
  const command = imageMagickCommand();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiga-weekly-report-'));
  try {
    const pageMvgs = buildPdfPages(report, font);
    const pageJpegs = [];
    pageMvgs.forEach((content, index) => {
      const mvgPath = path.join(tempDir, 'page-' + index + '.mvg');
      const jpegPath = path.join(tempDir, 'page-' + index + '.jpg');
      fs.writeFileSync(mvgPath, content, 'utf8');
      execFileSync(command, [
        'mvg:' + mvgPath, '-background', 'white', '-alpha', 'remove', '-strip', '-quality', '90', jpegPath,
      ], { stdio: 'pipe' });
      pageJpegs.push(jpegPath);
    });
    writePdfFromJpegs(pageJpegs, outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const report = collectWeeklyReport(options.now || new Date());
  const baseName = 'weekly-gd-' + report.period.start_local + '_' + report.period.end_local;
  const excelName = baseName + '.xls';
  const pdfName = baseName + '.pdf';
  const excelPath = path.join(REPORTS_DIR, excelName);
  const pdfPath = path.join(REPORTS_DIR, pdfName);
  fs.writeFileSync(excelPath, buildSpreadsheet(report), 'utf8');
  buildPdf(report, pdfPath);

  let telegramStatus = 'not_configured';
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
      primary_alert: report.alerts[0],
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
  REPORTS_DIR,
  buildSpreadsheet,
  collectWeeklyReport,
  createWeeklyReport,
  listWeeklyReports,
  previousCompletedWeek,
  resolveReportFile,
};
