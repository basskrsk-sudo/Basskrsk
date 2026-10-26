// business-year-report.js — помесячный P&L и итоги года для внутреннего Telegram-бота.
// Только оплаченные заказы; полные возвраты исключены, частичные вычтены.
// Время продаж — Красноярск (UTC+7), расходы — по дате expense_date.
// Не заменяет бухгалтерский отчёт: комиссии менеджеров и владельцев оценочные.
'use strict';

const db = require('./db');

const KRASNOYARSK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAX_RATE = 0.06;
const ACQUIRING_RATE = 0.02;
const MIN_YEAR = 2020;
const MONTH_NAMES = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
  'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const VALID_SALE = "o.status = 'paid' " +
  "AND COALESCE(o.refund_status,'none') != 'refunded' " +
  "AND o.total > COALESCE(o.refunded_amount,0)";
const formatWhole = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

function pad(value) { return String(value).padStart(2, '0'); }
function localParts(now) {
  const local = new Date(now.getTime() + KRASNOYARSK_OFFSET_MS);
  return {
    year: local.getUTCFullYear(), month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}
function currentKrasnoyarskYear(now = new Date()) {
  return localParts(now).year;
}
function localMidnightAsUtc(year, month, day = 1) {
  return new Date(Date.UTC(year, month - 1, day) - KRASNOYARSK_OFFSET_MS)
    .toISOString().slice(0, 19).replace('T', ' ');
}
function isoUtc(now) {
  return now.toISOString().slice(0, 19).replace('T', ' ');
}
function monthKey(year, month) { return year + '-' + pad(month); }
function number(value) { return Number(value) || 0; }
function rub(value) { return formatWhole.format(Math.round(number(value))) + ' ₽'; }
function signedRub(value) { return (number(value) > 0 ? '+' : '') + rub(value); }
function changePercent(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round((current - previous) / previous * 1000) / 10;
}
function changeText(current, previous) {
  const value = changePercent(current, previous);
  if (value === null) return 'с нуля';
  return (value > 0 ? '+' : '') + value.toLocaleString('ru-RU') + '%';
}
function mapRates(rows) {
  return new Map(rows.map((row) => [String(row.point_id), number(row.commission_rate)]));
}
function blankMonth(year, month) {
  return {
    key: monthKey(year, month), name: MONTH_NAMES[month - 1], number: month,
    revenue: 0, sales: 0, refunds: 0,
    manual_expenses: 0, partner_commission: 0, manager_commission: 0,
    owner_commission: 0, tax: 0, acquiring: 0, total_costs: 0, net_profit: 0,
    average_check: 0, margin_percent: 0, active_points: 0, new_points: 0,
    revenue_change_percent: 0, revenue_change_text: '0%',
    sales_change_text: '0%', profit_change: null,
  };
}

/**
 * @param {number|undefined} requestedYear календарный год по Красноярску
 * @param {Date} now время формирования отчёта (фиксируется один раз)
 */
function collectBusinessYearReport(requestedYear, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Некорректная текущая дата');
  }
  const today = localParts(now);
  const year = requestedYear === undefined ? today.year : Number(requestedYear);
  if (!Number.isSafeInteger(year) || year < MIN_YEAR || year > today.year) {
    const error = new Error('Выберите год от ' + MIN_YEAR + ' до ' + today.year);
    error.code = 'INVALID_BUSINESS_YEAR';
    throw error;
  }
  const isCurrentYear = year === today.year;
  const includedMonths = isCurrentYear ? today.month : 12;
  const untilUtc = isCurrentYear ? isoUtc(now) : localMidnightAsUtc(year + 1, 1);
  // Начало предыдущего декабря позволяет честно посчитать изменение января.
  const fromUtc = localMidnightAsUtc(year - 1, 12);

  const months = Array.from({ length: includedMonths }, (_, i) => blankMonth(year, i + 1));
  const byKey = new Map(months.map((row) => [row.key, row]));
  const monthlyPointSets = new Map(months.map((row) => [row.key, new Set()]));
  const yearPointSet = new Set();

  // Группировка выполняется SQLite: не выгружаем в Node.js все чеки сети.
  // Ставка грумера — снимок из заказа, остальные ставки из справочников
  // (по аналогии с существующим weekly-report.js и админкой экономики).
  const managerRates = mapRates(db.prepare(
    'SELECT point_id, commission_rate FROM manager_points WHERE point_id IS NOT NULL ORDER BY id'
  ).all());
  const ownerRates = mapRates(db.prepare(
    'SELECT point_id, commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active = 1 ORDER BY id'
  ).all());

  const orders = db.prepare(`
    SELECT strftime('%Y-%m',o.created_at,'+7 hours') AS month,
           o.point_id AS point_id,
           COUNT(*) AS sales,
           COALESCE(SUM(o.total - COALESCE(o.refunded_amount,0)),0) AS revenue,
           COALESCE(SUM((o.total - COALESCE(o.refunded_amount,0)) *
             COALESCE(o.commission_rate,0)),0) AS partner_commission_raw,
           COALESCE(SUM(COALESCE(o.refunded_amount,0)),0) AS refunds
    FROM orders o
    WHERE ${VALID_SALE} AND o.created_at >= ? AND o.created_at < ?
    GROUP BY month, o.point_id ORDER BY month, o.point_id
  `).all(fromUtc, untilUtc);

  let previousDecemberRevenue = 0;
  let previousDecemberSales = 0;
  for (const sale of orders) {
    const revenue = number(sale.revenue);
    if (sale.month === monthKey(year - 1, 12)) {
      previousDecemberRevenue += revenue;
      previousDecemberSales += number(sale.sales);
      continue;
    }
    const month = byKey.get(sale.month);
    if (!month) continue;
    month.sales += number(sale.sales);
    month.revenue += revenue;
    month.refunds += number(sale.refunds);
    month.partner_commission += number(sale.partner_commission_raw);
    if (sale.point_id) {
      const point = String(sale.point_id);
      month.manager_commission += revenue * (managerRates.get(point) || 0);
      month.owner_commission += revenue * (ownerRates.get(point) || 0);
      monthlyPointSets.get(month.key).add(point);
      yearPointSet.add(point);
    }
  }

  // Открытие точки = дата создания записи points, а НЕ первая продажа.
  // Исторические точки без подтверждённого created_at не распределяются
  // произвольно между месяцами. Источники: автоматическая отметка INSERT,
  // журнал создания менеджером или уточнённая суперадмином дата.
  const createdPoints = db.prepare(`
    SELECT id, strftime('%Y-%m', created_at, '+7 hours') AS created_month
    FROM points
    WHERE created_at IS NOT NULL AND TRIM(created_at) != ''
      AND created_at < ?
  `).all(untilUtc);
  for (const point of createdPoints) {
    const m = byKey.get(point.created_month);
    if (m) m.new_points++;
  }
  const unknownCreationDates = number(db.prepare(`
    SELECT COUNT(*) AS total FROM points
    WHERE created_at IS NULL OR TRIM(created_at) = ''
      OR strftime('%Y-%m',created_at,'+7 hours') IS NULL
  `).get().total);

  // Траты учитываем по дате их фактического совершения, а не ввода в бот.
  const endExpensesExclusive = isCurrentYear
    ? new Date(Date.UTC(today.year, today.month - 1, today.day) + DAY_MS)
      .toISOString().slice(0, 10)
    : String(year + 1) + '-01-01';
  const expenses = db.prepare(`
    SELECT substr(expense_date,1,7) AS month, SUM(amount) AS total
    FROM expenses
    WHERE expense_date >= ? AND expense_date < ?
    GROUP BY substr(expense_date,1,7)
  `).all(year + '-01-01', endExpensesExclusive);
  for (const expense of expenses) {
    const m = byKey.get(expense.month);
    if (m) m.manual_expenses += number(expense.total);
  }

  let priorRevenue = previousDecemberRevenue;
  let priorSales = previousDecemberSales;
  let priorProfit = null;
  for (const m of months) {
    m.active_points = monthlyPointSets.get(m.key).size;
    m.partner_commission = Math.round(m.partner_commission);
    m.manager_commission = Math.round(m.manager_commission);
    m.owner_commission = Math.round(m.owner_commission);
    m.tax = Math.round(m.revenue * TAX_RATE);
    m.acquiring = Math.round(m.revenue * ACQUIRING_RATE);
    m.total_costs = m.manual_expenses + m.partner_commission +
      m.manager_commission + m.owner_commission + m.tax + m.acquiring;
    m.net_profit = m.revenue - m.total_costs;
    m.average_check = m.sales ? Math.round(m.revenue / m.sales) : 0;
    m.margin_percent = m.revenue ? Math.round(m.net_profit / m.revenue * 1000) / 10 : 0;
    m.revenue_change_percent = changePercent(m.revenue, priorRevenue);
    m.revenue_change_text = changeText(m.revenue, priorRevenue);
    m.sales_change_text = changeText(m.sales, priorSales);
    m.profit_change = priorProfit === null ? null : m.net_profit - priorProfit;
    priorRevenue = m.revenue;
    priorSales = m.sales;
    priorProfit = m.net_profit;
  }

  const totals = blankMonth(year, 1);
  totals.key = 'ИТОГО ' + year;
  totals.name = 'Год';
  totals.number = null;
  totals.revenue_change_percent = null;
  totals.revenue_change_text = '';
  totals.sales_change_text = '';
  for (const m of months) {
    for (const field of [
      'sales','revenue','refunds','manual_expenses','partner_commission',
      'manager_commission','owner_commission','tax','acquiring',
      'total_costs','net_profit','new_points',
    ]) totals[field] += m[field];
  }
  totals.active_points = yearPointSet.size; // Уникальные точки за год, НЕ сумма по месяцам.
  totals.average_check = totals.sales ? Math.round(totals.revenue / totals.sales) : 0;
  totals.margin_percent = totals.revenue ? Math.round(totals.net_profit / totals.revenue * 1000) / 10 : 0;

  return {
    year, is_current_year: isCurrentYear, months, totals,
    unknown_creation_dates: unknownCreationDates,
    period: {
      from_local: year + '-01-01',
      through_local: isCurrentYear
        ? monthKey(today.year, today.month) + '-' + pad(today.day)
        : year + '-12-31',
      timezone: 'Asia/Krasnoyarsk',
    },
    assumptions: {
      tax_rate: TAX_RATE, acquiring_rate: ACQUIRING_RATE,
      new_point_definition: 'point_record_created_at',
      profit_is_estimate: true,
    },
  };
}

function formatBusinessYearReport(report) {
  const t = report.totals;
  const lines = [
    '📈 ХвостМаркет · бизнес ' + report.year,
    '🗓 01.01–' + report.period.through_local.slice(5).split('-').reverse().join('.') +
      '.' + report.year + ' · Красноярск' +
      (report.is_current_year ? ' (год ещё не завершён)' : ''),
    '',
    '📊 По месяцам (в скобках — выручка к предыдущему месяцу):',
  ];
  for (const m of report.months) {
    lines.push(
      m.name + ': 💚 ' + rub(m.revenue) + ' (' + m.revenue_change_text + ')' +
      ' · 🧾 ' + m.sales + ' (' + m.sales_change_text + ')' +
      ' · 🛍 ' + rub(m.average_check),
      '   💸 затраты ' + rub(m.total_costs) +
      ' · 📈 прибыль ' + signedRub(m.net_profit) +
      (m.profit_change === null ? '' : ' (Δ ' + signedRub(m.profit_change) + ')') +
      ' · 🏪 ' + m.active_points + ' / +' + m.new_points
    );
  }
  lines.push(
    '',
    '📅 ИТОГО ' + report.year + (report.is_current_year ? ' (с начала года)' : ''),
    '💚 Выручка: ' + rub(t.revenue),
    '🧾 Оплаченных заказов: ' + t.sales + ' · средний чек: ' + rub(t.average_check),
    '💸 Учтённые затраты: ' + rub(t.total_costs) +
      ' (из них внесено вручную: ' + rub(t.manual_expenses) + ')',
    '📈 Расчётная прибыль: ' + signedRub(t.net_profit) +
      ' · маржа: ' + t.margin_percent.toLocaleString('ru-RU') + '%',
    '🏪 Точек с продажами: ' + t.active_points +
      ' · зарегистрировано точек: ' + t.new_points,
    '💼 Комиссии: грумеры ' + rub(t.partner_commission) +
      ', менеджеры ' + rub(t.manager_commission) +
      ', владельцы ' + rub(t.owner_commission),
    '🧾 Налог 6%: ' + rub(t.tax) + ' · эквайринг 2%: ' + rub(t.acquiring),
    '',
    '🏪 В строке месяца: точки с продажами / новые созданные карточки.',
    ...(report.unknown_creation_dates ? [
      '⚠️ Точек без подтверждённой даты создания: ' + report.unknown_creation_dates +
      '. В новых точках по месяцам они не учтены.'
    ] : []),
    'ℹ️ Это управленческая оценка, не бухгалтерская прибыль: ' +
      'учтены внесённые траты и расчётные комиссии/налог/эквайринг. ' +
      'Заказы — по дате создания, выручка после возвратов. ' +
      'Подробная таблица — в CSV.'
  );
  const message = lines.join('\n');
  if (message.length > 4000) throw new Error('Годовой отчёт превышает лимит Telegram');
  return message;
}

function csvCell(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}
function buildBusinessYearCsv(report) {
  const fields = [
    'Месяц (Красноярск)','Выручка после возвратов, ₽','Оплаченных заказов',
    'Средний чек, ₽','Ручные расходы, ₽','Комиссия грумерам, ₽',
    'Комиссия менеджерам, ₽','Комиссия владельцам, ₽','Налог 6%, ₽',
    'Эквайринг 2%, ₽','Учтённые затраты, ₽','Расчётная прибыль, ₽',
    'Маржа, %','Точки с продажами','Новые точки (создание карточки)',
    'Динамика выручки к предыдущему месяцу',
    'Динамика заказов к предыдущему месяцу',
    'Изменение прибыли к предыдущему месяцу, ₽',
    'Точек без даты создания (во всей базе)',
  ];
  const lines = [fields.map(csvCell).join(';')];
  for (const m of [...report.months, report.totals]) {
    lines.push([
      m.key, m.revenue, m.sales, m.average_check, m.manual_expenses,
      m.partner_commission, m.manager_commission, m.owner_commission,
      m.tax, m.acquiring, m.total_costs, m.net_profit, m.margin_percent,
      m.active_points, m.new_points, m.revenue_change_text || '',
      m.sales_change_text || '', m.profit_change === null ? '' : m.profit_change,
      m === report.totals ? report.unknown_creation_dates : '',
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  MIN_YEAR, currentKrasnoyarskYear, localMidnightAsUtc,
  changePercent, collectBusinessYearReport,
  formatBusinessYearReport, buildBusinessYearCsv,
};
