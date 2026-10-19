'use strict';

// Presentation only. All compensation amounts are read from the original
// report calculation: never recalculate them from grouped revenue.
function summarizeCompensation(report) {
  const groups = new Map();
  for (const item of report.items || []) {
    const point = String(item.point || report.recipient?.point || 'Продажи').trim();
    const rate = item.rate == null ? null : Number(item.rate);
    const hasBase = item.base != null;
    const key = JSON.stringify([item.point_id || point, point, rate, hasBase]);
    if (!groups.has(key)) groups.set(key, { point, rate, orders: 0, base: hasBase ? 0 : null, amount: 0 });
    const row = groups.get(key);
    row.orders++;
    if (hasBase) row.base += Number(item.base);
    row.amount += Number(item.amount || 0);
  }
  return {
    groups: [...groups.values()],
    commission: Number(report.commission_accrued || 0),
    bonus: Number(report.bonus_accrued || 0),
    accrued: Number(report.accrued || 0),
    alreadyPaid: Number(report.already_paid || 0),
    unpaid: Number(report.unpaid || 0),
    payoutAmount: report.payout_amount == null ? null : Number(report.payout_amount),
    hasUndatedBonuses: !!report.undated_bonuses?.length,
  };
}

const TIME_ZONE = 'Asia/Krasnoyarsk';
function localDateTime(value) {
  if (!value) return 'Не сохранено';
  const raw = String(value).trim();
  // SQLite stores created_at in UTC, without an explicit timezone suffix.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(raw) ? raw.replace(' ', 'T') + 'Z'
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(raw) ? raw + 'Z' : raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return 'Не сохранено';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date).replace(',', '');
}
function shortDate(value) {
  return value ? String(value).slice(0,10).split('-').reverse().join('.') : '—';
}
function itemNames(order) {
  if (!Array.isArray(order.products) || order.products.length === 0) return ['Состав заказа не сохранён'];
  return order.products.map(product => {
    const name = String(product.name || 'Товар').trim();
    const weight = String(product.weight || '').trim();
    const quantity = Math.max(1, Number(product.qty) || 1);
    return name + (weight && !name.includes(weight) ? ' · ' + weight : '') + ' × ' + quantity;
  });
}
const rub = value => value == null ? 'Нет данных' : Number(value).toLocaleString('ru-RU') + ' ₽';
const rate = value => value == null ? '—' : (Number(value) * 100).toLocaleString('ru-RU', {maximumFractionDigits:2}) + '%';
function printableReport(report) {
  const view = summarizeCompensation(report);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const role = report.role === 'manager' ? 'Менеджер' : report.role === 'owner' ? 'Владелец салона' : 'Грумер';
  const isPayout = report.kind === 'payout';
  const line = (label, value, highlight) => '<div class="line' + (highlight ? ' total' : '') + '"><span>' + esc(label) + '</span><b>' + esc(rub(value)) + '</b></div>';
  const rows = (report.items || []).map(order => '<tr><td>' + esc(localDateTime(order.date)) +
    '</td><td>' + itemNames(order).map(esc).join('<br>') +
    (report.role === 'manager' && order.point ? '<small>Точка: ' + esc(order.point) + '</small>' : '') +
    '</td><td class="number">' + esc(rub(order.base)) + '</td><td class="number">' + esc(rate(order.rate)) +
    '</td><td class="number"><b>' + esc(rub(order.amount)) + '</b></td></tr>').join('');
  const bonusLines = (report.bonuses || []).map(b => line('Бонус · ' + (b.point || b.point_name || 'за точку'), b.amount, false)).join('');
  return ['<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ХвостМаркет — вознаграждение</title>',
    '<style>body{max-width:850px;margin:25px auto;padding:0 20px;font:14px Arial,sans-serif;color:#22382c}.brand{font-weight:700;color:#21623f;letter-spacing:.09em;margin:0 0 10px}h1{font-size:24px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 12px}.meta{line-height:1.6;color:#55655a;margin:0 0 12px}.sub{font-size:11px;color:#66756a}table{width:100%;border-collapse:collapse;font-size:13px}th{background:#eaf2ec;color:#36503f}th,td{padding:10px 8px;border-bottom:1px solid #dfe5e0;text-align:left;vertical-align:top}.number{text-align:right;white-space:nowrap}td small{display:block;color:#718077;margin-top:3px}.line{display:flex;justify-content:space-between;gap:15px;border-bottom:1px solid #e5eae6;padding:10px 5px}.total{border-top:2px solid #276447;font-size:19px;font-weight:bold}.note{font-size:11px;color:#6c786f;line-height:1.55}button{padding:9px 16px;margin-bottom:14px}@media print{button{display:none}body{margin:0;max-width:none;padding:0}@page{size:A4;margin:15mm}tr{break-inside:avoid}}</style></head><body>',
    '<button onclick="window.print()">Печать / сохранить PDF</button>',
    '<p class="brand">ХВОСТМАРКЕТ</p><h1>Расчёт вознаграждения</h1>',
    '<p class="meta">' + esc(role) + ': <b>' + esc(report.recipient.name) + '</b><br>Период: ' + esc(shortDate(report.period_start)) + ' — ' + esc(shortDate(report.period_end)) +
      (report.recipient.point ? '<br>Точка: ' + esc(report.recipient.point) : '') + (report.id ? '<br>Отчёт № ' + esc(report.id) : '') + '</p>',
    '<h2>Проданные товары <span class="sub">(дата и время создания оплаченного заказа, Красноярск)</span></h2>',
    (report.items || []).length ? '<table><thead><tr><th>Дата и время</th><th>Товар</th><th class="number">Продажи</th><th class="number">%</th><th class="number">Вознаграждение</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="meta">Продаж в отчёте нет.</p>',
    line('Вознаграждение с продаж', view.commission, false),
    bonusLines ? '<h2>Бонусы</h2>' + bonusLines : '',
    line('Всего начислено', view.accrued, false),
    isPayout ? line('Сумма выплаты' + (report.paid_at ? ' (' + shortDate(report.paid_at) + ')' : ''), view.payoutAmount, true) :
      line('Уже выплачено', view.alreadyPaid, false) + line('Осталось выплатить', view.unpaid, true),
    report.lifetime_earned == null ? '' : line('Заработано всего (за всё время)', report.lifetime_earned, false),
    '<p class="note">Вознаграждение округляется для каждого заказа отдельно. Сумма строк — итог расчёта. Период выбирается по дате создания заказа в UTC.</p>',
    view.hasUndatedBonuses ? '<p class="note">Бонусы без даты начисления не включены в расчёт периода.</p>' : '',
    '<p class="note">Отчёт справочный, не является банковским подтверждением или подписанным актом. Суммы указаны до возможных налоговых удержаний.</p>',
    '</body></html>'].join('');
}

module.exports = { summarizeCompensation, printableReport, localDateTime, shortDate, itemNames, rub, rate };
