// On-demand list of paid orders without an attributed groomer.
// Uses the same "Выбрал сам" rule as the admin orders table:
// no partner ID and commission_rate === 0. Legacy unassigned orders are separate.
'use strict';

const db = require('./db');

const MAX_EXPORT_ORDERS = 20000;
const PREVIEW_ORDERS = 8;
const TIME_ZONE = 'Asia/Krasnoyarsk';
const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

const BASE_WHERE = [
  "o.status = 'paid'",
  "COALESCE(o.refund_status,'none') <> 'refunded'",
  'o.total > COALESCE(o.refunded_amount, 0)',
  '(o.partner_id IS NULL OR o.partner_id = 0)',
  "TRIM(COALESCE(o.partner_name,'')) = ''",
  'COALESCE(o.is_partner_self_order,0) = 0',
].join(' AND ');

function ruDate(value) {
  if (!value) return 'Дата не указана';
  const source = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(source)
    ? source.replace(' ', 'T') + 'Z' : source;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return 'Дата не указана';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
function money(value) {
  return RUB.format(Math.round(Number(value) || 0)) + ' ₽';
}
function clean(value, max = 160) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function reasonForOrder(order) {
  // Also used in public/taiga-admin.html -> renderOrders().
  return Number(order.commission_rate) === 0 && order.commission_rate != null
    ? 'Выбрал сам' : 'Не выбран';
}
function csvCell(value) {
  let text = clean(value, 2000);
  if (/^[=+@-]/.test(text)) text = "'" + text; // Prevent CSV formula injection.
  return '"' + text.replace(/"/g, '""') + '"';
}
function productLabel(item) {
  return clean(item.name, 120) +
    (item.weight ? ' (' + clean(item.weight, 40) + ')' : '') +
    ' ×' + Number(item.qty || 0);
}
function formatProductNames(items) {
  return items.length ? items.map(productLabel).join(', ') : 'Позиции заказа не сохранены';
}
function periodOptions(days, now = new Date()) {
  if (days !== undefined && ![7,30].includes(days)) {
    throw new Error('Укажите /nogroomer, /nogroomer 7 или /nogroomer 30');
  }
  const end = now.getTime();
  if (!Number.isFinite(end)) throw new Error('Некорректная дата отчёта');
  if (!days) return { description: 'За всё время', startUtc: null };
  const startUtc = new Date(end - days * 86400000).toISOString().slice(0,19).replace('T',' ');
  return { description: 'За последние ' + days + ' суток', startUtc };
}

function collectNoGroomerReport(days, now = new Date()) {
  const period = periodOptions(days, now);
  const where = BASE_WHERE + (period.startUtc ? ' AND o.created_at >= ?' : '');
  const params = period.startUtc ? [period.startUtc] : [];

  // The totals cover the entire selected period, even if the CSV export is capped.
  const totals = db.prepare(
    'SELECT COUNT(*) AS count, ' +
    'COALESCE(SUM(o.total-COALESCE(o.refunded_amount,0)),0) AS revenue, ' +
    'COALESCE(SUM(CASE WHEN o.commission_rate = 0 THEN 1 ELSE 0 END),0) AS self_count, ' +
    'COALESCE(SUM(CASE WHEN o.commission_rate IS NULL OR o.commission_rate != 0 THEN 1 ELSE 0 END),0) AS unassigned_count, ' +
    'COALESCE(SUM(CASE WHEN o.commission_rate > 0 THEN 1 ELSE 0 END),0) AS rate_without_partner, ' +
    'MIN(o.created_at) AS first_date, MAX(o.created_at) AS last_date ' +
    'FROM orders o WHERE ' + where
  ).get(...params);

  const rawOrders = db.prepare(
    'SELECT o.id,o.order_code,o.created_at,o.pickup_point,o.point_id, ' +
    'p.name AS point_name,o.total,o.refunded_amount,o.commission_rate, ' +
    'o.fulfillment_type,o.needs_delivery ' +
    'FROM orders o LEFT JOIN points p ON p.id=o.point_id ' +
    'WHERE ' + where + ' ORDER BY o.created_at DESC,o.id DESC LIMIT ?'
  ).all(...params, MAX_EXPORT_ORDERS);

  const productsByOrder = new Map();
  // Batch item lookups to avoid one SQL query per order, including large histories.
  for (let index = 0; index < rawOrders.length; index += 250) {
    const ids = rawOrders.slice(index,index+250).map(order => order.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      'SELECT order_id,name,weight,price,qty FROM order_items ' +
      'WHERE order_id IN (' + placeholders + ') ORDER BY order_id,id'
    ).all(...ids);
    for (const item of rows) {
      if (!productsByOrder.has(item.order_id)) productsByOrder.set(item.order_id, []);
      productsByOrder.get(item.order_id).push({
        name: item.name, weight: item.weight,
        qty: Number(item.qty) || 0, price: Number(item.price) || 0,
      });
    }
  }

  const orders = rawOrders.map(row => {
    const items = productsByOrder.get(row.id) || [];
    return {
      id: row.id, code: clean(row.order_code, 100), date: ruDate(row.created_at),
      point: clean(row.point_name || row.pickup_point || row.point_id || 'Без точки', 125),
      reason: reasonForOrder(row), products: formatProductNames(items),
      items, total: Number(row.total) || 0,
      net: Math.max(0, (Number(row.total) || 0) - (Number(row.refunded_amount) || 0)),
      commission_rate: row.commission_rate,
      is_delivery: row.fulfillment_type === 'home_delivery' || !!row.needs_delivery,
    };
  });
  return {
    period,
    generated_at: now.toISOString(),
    count: Number(totals.count) || 0,
    revenue: Number(totals.revenue) || 0,
    self_count: Number(totals.self_count) || 0,
    unassigned_count: Number(totals.unassigned_count) || 0,
    rate_without_partner: Number(totals.rate_without_partner) || 0,
    first_date: totals.first_date ? ruDate(totals.first_date) : null,
    last_date: totals.last_date ? ruDate(totals.last_date) : null,
    truncated: Number(totals.count) > orders.length,
    orders,
  };
}

function formatNoGroomerReport(report) {
  const lines = [
    '🐾 ХвостМаркет — оплаченные заказы без грумера',
    '🗓 ' + report.period.description +
      (report.first_date ? ' (' + report.first_date.slice(0,10) + ' — ' + report.last_date.slice(0,10) + ')' : ''),
    '',
    '📦 Заказов: ' + report.count,
    '💚 Выручка после возвратов: ' + money(report.revenue),
    '✅ «Выбрал сам»: ' + report.self_count,
    '❔ «Не выбран»: ' + report.unassigned_count,
  ];
  if (report.rate_without_partner) {
    lines.push('⚠️ Заказов с ненулевой ставкой, но без грумера: ' + report.rate_without_partner + '. Проверьте атрибуцию перед выплатами.');
  }
  lines.push('', 'Последние заказы:');
  if (!report.count) lines.push('Таких оплаченных заказов нет.');
  for (const order of report.orders.slice(0,PREVIEW_ORDERS)) {
    const line = '• № ' + order.code + ' · ' + order.date +
      '\n  🏪 ' + clean(order.point,65) + (order.is_delivery ? ' (доставка)' : '') +
      '\n  🦴 ' + clean(order.products,200) +
      '\n  💚 ' + money(order.net) +
      (order.total !== order.net ? ' (до возврата ' + money(order.total) + ')' : '') +
      ' · ' + order.reason;
    if (lines.join('\n').length + line.length + 170 > 3800) break;
    lines.push(line);
  }
  if (report.count > PREVIEW_ORDERS) lines.push('… остальные заказы — в CSV.');
  if (report.truncated) {
    lines.push('⚠️ CSV содержит только ' + report.orders.length +
      ' последних заказов из ' + report.count + ' (ограничение объёма).');
  }
  if (report.count) lines.push('', '📎 Полная доступная детализация: CSV-файл (без персональных данных покупателей).');
  lines.push('Полностью возвращённые и неоплаченные заказы исключены.');
  return lines.join('\n').slice(0,4000);
}

function buildNoGroomerCsv(report) {
  const header = ['Номер заказа','Дата продажи (Красноярск)','Точка',
    'Товары и количество','Сумма заказа, руб.','Сумма после возвратов, руб.',
    'Кто помог','Ставка комиссии, %','Способ получения'];
  const lines = [header.map(csvCell).join(';')];
  for (const order of report.orders) {
    lines.push([
      order.code,order.date,order.point,order.products,order.total,order.net,
      order.reason,order.commission_rate == null ? '' :
        (Number(order.commission_rate)*100).toLocaleString('ru-RU',{maximumFractionDigits:2}),
      order.is_delivery ? 'Доставка' : 'Самовывоз',
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
module.exports = {
  collectNoGroomerReport, formatNoGroomerReport, buildNoGroomerCsv,
  reasonForOrder, periodOptions, BASE_WHERE, MAX_EXPORT_ORDERS,
};
