// On-demand seven-day sales report for the internal Telegram bot.
'use strict';

const db = require('./db');
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Krasnoyarsk';
const PAID = "o.status='paid' AND COALESCE(o.refund_status,'none')!='refunded' " +
  "AND o.total>COALESCE(o.refunded_amount,0) AND o.created_at>=? AND o.created_at<?";
const NET_REVENUE = 'COALESCE(SUM(o.total-COALESCE(o.refunded_amount,0)),0)';
const POINT_NAME = "COALESCE(NULLIF(p.name,''),NULLIF(o.pickup_point,''),'Без точки')";
const POINT_KEY = "COALESCE(NULLIF(o.point_id,''),'legacy:'||o.pickup_point)";

function sqlUTC(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function periodForSevenDays(now = new Date()) {
  const end = now.getTime();
  if (!Number.isFinite(end)) throw new Error('Некорректная дата отчёта');
  const start = end - DAY_MS * 7;
  return {
    start_utc: sqlUTC(start), end_utc: sqlUTC(end),
    previous_start_utc: sqlUTC(start - DAY_MS * 7), previous_end_utc: sqlUTC(start),
    start_ms: start, end_ms: end, timezone: TIME_ZONE,
  };
}
function number(value) { return Number(value) || 0; }
function totals(start, end) {
  const row = db.prepare(
    'SELECT COUNT(*) AS sales, ' + NET_REVENUE + ' AS revenue, ' +
    "COALESCE(SUM(COALESCE(o.refunded_amount,0)),0) AS refunds, " +
    "COUNT(DISTINCT NULLIF(TRIM(o.customer_phone),'')) AS customers, " +
    "COUNT(DISTINCT COALESCE(NULLIF(o.point_id,''),NULLIF(o.pickup_point,''))) AS active_points " +
    'FROM orders o WHERE ' + PAID
  ).get(start, end);
  return {
    sales: number(row.sales), revenue: number(row.revenue),
    refunds: number(row.refunds), customers: number(row.customers),
    active_points: number(row.active_points),
  };
}
function collectSalesWeekReport(now = new Date()) {
  const period = periodForSevenDays(now);
  const bounds = [period.start_utc, period.end_utc];
  const current = totals(...bounds);
  const previous = totals(period.previous_start_utc, period.previous_end_utc);
  const points = db.prepare(
    'SELECT ' + POINT_NAME + ' AS name, COUNT(*) AS sales, ' + NET_REVENUE + ' AS revenue ' +
    'FROM orders o LEFT JOIN points p ON p.id=o.point_id WHERE ' + PAID +
    ' GROUP BY ' + POINT_KEY + ',name ORDER BY revenue DESC,sales DESC,name'
  ).all(...bounds).map(row => ({
    name: String(row.name || 'Без точки'), sales: number(row.sales), revenue: number(row.revenue),
  }));
  const products = db.prepare(
    'SELECT oi.name,oi.weight,SUM(oi.qty) AS units FROM order_items oi ' +
    'JOIN orders o ON o.id=oi.order_id WHERE ' + PAID +
    ' GROUP BY oi.name,oi.weight ORDER BY units DESC,oi.name LIMIT 7'
  ).all(...bounds).map(row => ({
    name: String(row.name || 'Товар'), weight: String(row.weight || ''), units: number(row.units),
  }));
  const days = db.prepare(
    "SELECT DATE(o.created_at,'+7 hours') AS day, COUNT(*) AS sales, " +
    NET_REVENUE + ' AS revenue FROM orders o WHERE ' + PAID +
    ' GROUP BY day ORDER BY day'
  ).all(...bounds).map(row => ({
    day: row.day, sales: number(row.sales), revenue: number(row.revenue),
  }));
  const pointDays = db.prepare(
    "SELECT DATE(o.created_at,'+7 hours') AS day, " + POINT_NAME +
    ' AS name, COUNT(*) AS sales, ' + NET_REVENUE + ' AS revenue ' +
    'FROM orders o LEFT JOIN points p ON p.id=o.point_id WHERE ' + PAID +
    ' GROUP BY day,' + POINT_KEY + ',name ORDER BY day,name'
  ).all(...bounds).map(row => ({
    day: row.day, name: String(row.name || 'Без точки'),
    sales: number(row.sales), revenue: number(row.revenue),
  }));
  return {
    period, current, previous, points, products, days, pointDays,
    average_check: current.sales ? Math.round(current.revenue / current.sales) : 0,
  };
}
const whole = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
function rubles(value) { return whole.format(Math.round(number(value))) + ' ₽'; }
function localDateTime(ms) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}
function cleanLabel(value, max = 75) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function changeLabel(current, previous) {
  if (!previous) return current ? 'прошлый период: 0' : '0%';
  const percent = (current - previous) / previous * 100;
  return (percent >= 0 ? '+' : '−') + decimal.format(Math.round(Math.abs(percent) * 10) / 10) + '%';
}
function formatSalesWeekReport(report) {
  const { period, current, previous, points, products, days } = report;
  const lines = [
    '📊 ХвостМаркет — продажи за последние 7 суток',
    '🗓 ' + localDateTime(period.start_ms) + ' — ' + localDateTime(period.end_ms) + ' (Красноярск)',
    '',
    '💚 Выручка: ' + rubles(current.revenue) + ' (' + changeLabel(current.revenue, previous.revenue) + ' к предыдущим 7 суткам)',
    '🧾 Оплаченных заказов: ' + current.sales + ' (' + changeLabel(current.sales, previous.sales) + ')',
    '🛍 Средний чек: ' + rubles(report.average_check),
    '🏪 Точек с продажами: ' + current.active_points,
    '👥 Покупателей: ' + current.customers,
    ...(current.refunds ? ['↩️ Частичные возвраты: ' + rubles(current.refunds) + ' (вычтены из выручки)'] : []),
    '',
    '🏪 Продажи по точкам:',
  ];
  if (!points.length) lines.push('За период продаж нет.');
  for (const [i, point] of points.slice(0, 10).entries()) {
    lines.push((i + 1) + '. ' + cleanLabel(point.name, 52) +
      ' — ' + point.sales + ' заказов, ' + rubles(point.revenue));
  }
  if (points.length > 10) lines.push('Остальные ' + (points.length - 10) + ' точек — в CSV-файле.');
  lines.push('', '🦴 Топ товаров:');
  if (!products.length) lines.push('Нет данных.');
  for (const [i, item] of products.slice(0, 5).entries()) {
    lines.push((i + 1) + '. ' + cleanLabel(item.name, 46) +
      (item.weight ? ' (' + cleanLabel(item.weight, 18) + ')' : '') +
      ' — ' + item.units + ' шт.');
  }
  lines.push('', '📅 По дням:');
  if (!days.length) lines.push('Нет данных.');
  for (const day of days) {
    lines.push(day.day + ': ' + day.sales + ' заказов, ' + rubles(day.revenue));
  }
  lines.push('', 'Учтены оплаченные заказы по дате создания. Полные возвраты и неоплаченные заказы исключены. Выручка указана после частичных возвратов. Детализация по точкам и датам — в CSV.');
  return lines.join('\n').slice(0, 4000);
}
function csvCell(value) {
  let text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (/^[=+@-]/.test(text)) text = "'" + text; // Prevent formula injection.
  return '"' + text.replace(/"/g, '""') + '"';
}
function buildSalesWeekCsv(report) {
  const lines = ['Дата (Красноярск);Точка;Оплаченных заказов;Выручка после возвратов (руб.)'];
  for (const row of report.pointDays) {
    lines.push([row.day, row.name, row.sales, row.revenue].map(csvCell).join(';'));
  }
  lines.push(['ИТОГО', '', report.current.sales, report.current.revenue].map(csvCell).join(';'));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
function adminCanReadSales(chatId) {
  const id = String(chatId || '');
  if (!/^\d+$/.test(id)) return false;
  const admin = db.prepare('SELECT id FROM admins WHERE active=1 AND telegram_chat_id=? LIMIT 1').get(id);
  if (admin) return true;
  // The existing internal notification chat may be the owner's private chat.
  return !!(process.env.TG_CHAT_ID && id === String(process.env.TG_CHAT_ID));
}

module.exports = {
  periodForSevenDays, collectSalesWeekReport, formatSalesWeekReport,
  buildSalesWeekCsv, adminCanReadSales,
};