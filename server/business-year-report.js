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
const FIRST_MONTH_2026 = 9; // ХвостМаркет начал работу в сентябре 2026.
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
    registered_points_known: 0,
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
  // Год основания ХвостМаркета начался в сентябре. Для других лет период
  // остаётся календарным (с января); месяцы до сентября 2026 исключаем и
  // из сообщения, и из финансовых итогов, и из обоих CSV.
  const firstMonth = year === 2026 ? FIRST_MONTH_2026 : 1;
  const includedMonths = isCurrentYear
    ? Math.max(0, today.month - firstMonth + 1) : 13 - firstMonth;
  const untilUtc = isCurrentYear ? isoUtc(now) : localMidnightAsUtc(year + 1, 1);
  // Для январского отчёта прошлый декабрь нужен лишь для % сравнения.
  // В сентябре 2026 начинаем с нуля без сравнения с августом.
  const fromUtc = firstMonth === 1
    ? localMidnightAsUtc(year - 1, 12)
    : localMidnightAsUtc(year, firstMonth);

  const months = Array.from({ length: includedMonths }, (_, i) => blankMonth(year, firstMonth + i));
  const byKey = new Map(months.map((row) => [row.key, row]));
  const monthlyPointSets = new Map(months.map((row) => [row.key, new Set()]));
  const yearPointSet = new Set();
  const annualPointSales = new Map();

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
      let annual = annualPointSales.get(point);
      if (!annual) {
        annual = {sales:0, revenue:0, months:new Set(), by_month:new Map()};
        annualPointSales.set(point,annual);
      }
      annual.sales += number(sale.sales);
      annual.revenue += revenue;
      annual.months.add(month.key);
      let monthlyPoint = annual.by_month.get(month.key);
      if (!monthlyPoint) {
        monthlyPoint = { sales: 0, revenue: 0 };
        annual.by_month.set(month.key, monthlyPoint);
      }
      monthlyPoint.sales += number(sale.sales);
      monthlyPoint.revenue += revenue;
    }
  }

  // Включаем ВСЕ существующие в реестре точки: действующие, отключённые,
  // без продаж и без известной даты регистрации. Дата создания берётся
  // исключительно из points.created_at, никогда из даты первого заказа.
  // Для выбранного прошлого года показываем нынешний реестр (снимков
  // удалённых точек в системе нет), но их продажи — только за этот год.
  const points = db.prepare(`
    SELECT p.id, p.name, p.addr, p.city_id, c.name AS city_name,
           p.active, p.is_hub, p.created_at, p.created_at_source,
           strftime('%Y-%m', p.created_at, '+7 hours') AS created_month,
           strftime('%Y-%m-%d', p.created_at, '+7 hours') AS created_local_date
    FROM points p LEFT JOIN cities c ON c.id = p.city_id
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all().map((point) => {
    const paid = annualPointSales.get(String(point.id));
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(point.created_local_date || ''));
    return {
      id: String(point.id), name: String(point.name || point.id),
      address: String(point.addr || ''), city: String(point.city_name || point.city_id || '—'),
      active: !!point.active, is_hub: !!point.is_hub,
      created_at: validDate ? String(point.created_at) : null,
      created_date: validDate ? point.created_local_date : null,
      created_month: validDate ? point.created_month : null,
      created_source: validDate ? (point.created_at_source || 'unknown') : null,
      sales: paid ? paid.sales : 0, revenue: paid ? paid.revenue : 0,
      months_with_sales: paid ? paid.months.size : 0,
      monthly_sales: paid ? Object.fromEntries(paid.by_month) : {},
    };
  });
  const pointsMissingDates = points.filter((point) => !point.created_date);
  const unknownCreationDates = pointsMissingDates.length;
  const datedBeforeReport = points.filter((point) =>
    point.created_at && point.created_at < untilUtc);
  for (const point of datedBeforeReport) {
    const m = byKey.get(point.created_month);
    if (m) m.new_points++;
  }
  for (const m of months) {
    // Зарегистрированные к концу месяца, включая точки без продаж.
    // Неизвестные даты не приписываются произвольному месяцу.
    m.registered_points_known = datedBeforeReport.filter(
      (point) => point.created_month <= m.key
    ).length;
  }

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
  `).all(monthKey(year, firstMonth) + '-01', endExpensesExclusive);
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
    if (year === 2026 && m.number === FIRST_MONTH_2026) {
      // Первому месяцу работы не с чем сравнивать; условная база — ноль.
      m.revenue_change_percent = null;
      m.revenue_change_text = 'с нуля';
      m.sales_change_text = 'с нуля';
    }
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
  totals.registered_points_known = datedBeforeReport.length;
  totals.average_check = totals.sales ? Math.round(totals.revenue / totals.sales) : 0;
  totals.margin_percent = totals.revenue ? Math.round(totals.net_profit / totals.revenue * 1000) / 10 : 0;

  return {
    year, is_current_year: isCurrentYear, months, totals,
    unknown_creation_dates: unknownCreationDates,
    points, missing_creation_dates: pointsMissingDates,
    total_points_in_registry: points.length,
    points_with_known_registration: points.length - unknownCreationDates,
    period: {
      from_local: monthKey(year, firstMonth) + '-01',
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
  const startDate = report.period.from_local.slice(5).split('-').reverse().join('.');
  const endDate = report.period.through_local.slice(5).split('-').reverse().join('.');
  const lines = [
    'ХвостМаркет · бизнес ' + report.year,
    '',
    '🗓 ' + startDate + '–' + endDate + '.' + report.year +
      ' · Красноярск' +
      (report.is_current_year ? ' (год ещё не завершён)' : ''),
    '',
    '📊 По месяцам (в скобках — к предыдущему месяцу):',
    '',
  ];

  for (const m of report.months) {
    const isInitialPeriod = report.year === 2026 && m.number === FIRST_MONTH_2026;
    const beforeMonth = m.registered_points_known - m.new_points;
    const fromZero = isInitialPeriod && beforeMonth === 0
      ? ' (с нуля)' : '';
    lines.push(
      m.name + ':',
      '💚 ' + rub(m.revenue) + ' (' + m.revenue_change_text + ') ·',
      '🧾 ' + m.sales + ' (' + m.sales_change_text + ') ·',
      '🛍 ' + rub(m.average_check),
      '🏪 +' + m.new_points + fromZero + ', всего ' + m.registered_points_known,
      ''
    );
  }

  lines.push(
    '📅 ИТОГО ' + report.year + (report.is_current_year ? ' (с начала года)' : ''),
    '💚 Выручка: ' + rub(t.revenue),
    '🧾 Оплаченных заказов: ' + t.sales,
    '🛍 Средний чек: ' + rub(t.average_check),
    '🏪 Точек с продажами: ' + t.active_points +
      ' · новых зарегистрировано: ' + t.new_points,
    '🗂 В реестре всего точек: ' + report.total_points_in_registry +
      ' (из них ' + report.points.filter((point) => point.sales === 0).length +
      ' без продаж за отчётный год)'
  );

  // Исторические точки без даты остаются в реестре, но не приписываются к
  // определённому месяцу. Нужные данные запрашиваем прямо в том же отчёте.
  if (report.unknown_creation_dates) {
    lines.push(
      '',
      '⚠️ Дата регистрации неизвестна у точек (' + report.unknown_creation_dates + '):',
      ...report.missing_creation_dates.slice(0, 8).map((point) =>
        '— ' + cleanReportLabel(point.name, 44) + ' (' + cleanReportLabel(point.id, 30) + ')'),
      ...(report.missing_creation_dates.length > 8
        ? ['…ещё ' + (report.missing_creation_dates.length - 8) + ' — в CSV «Все точки».']
        : []),
      '❓ Уточните даты создания этих точек в админке → Точки → Уточнить.'
    );
  }

  const message = lines.join('\n');
  if (message.length > 4000) throw new Error('Годовой отчёт превышает лимит Telegram');
  return message;
}

function cleanReportLabel(value, length) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,length);
}
function csvCell(value) {
  let out = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  // Не допускаем выполнения формул Excel из имени/адреса партнёрской точки.
  if (typeof value !== 'number' && /^[=+@-]/.test(out)) out = "'" + out;
  return '"' + out.replace(/"/g, '""') + '"';
}
function buildBusinessYearCsv(report) {
  const fields = [
    'Месяц (Красноярск)','Выручка после возвратов, ₽','Оплаченных заказов',
    'Средний чек, ₽','Ручные расходы, ₽','Комиссия грумерам, ₽',
    'Комиссия менеджерам, ₽','Комиссия владельцам, ₽','Налог 6%, ₽',
    'Эквайринг 2%, ₽','Учтённые затраты, ₽','Расчётная прибыль, ₽',
    'Маржа, %','Точки с продажами','Новые точки (создание карточки)',
    'Всего точек с датой регистрации к концу месяца',
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
      m.active_points, m.new_points, m.registered_points_known, m.revenue_change_text || '',
      m.sales_change_text || '', m.profit_change === null ? '' : m.profit_change,
      m === report.totals ? report.unknown_creation_dates : '',
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function buildBusinessPointsCsv(report) {
  const columns = [
    'Точка', 'ID точки', 'Город', 'Адрес', 'Статус', 'Тип',
    'Дата регистрации точки (Красноярск)', 'Источник даты',
    'Оплаченных заказов за ' + report.year, 'Выручка за ' + report.year + ', ₽',
    'Месяцев с продажами', 'Требуется уточнить дату?',
    ...report.months.flatMap((month) =>
      [month.key + ': заказов', month.key + ': выручка, ₽']),
  ];
  const sourceName = {
    recorded: 'Автоматически зафиксирована при создании',
    manager_action_log: 'Восстановлена из журнала менеджера',
    manual_date_only: 'Уточнена супер-администратором',
  };
  const lines = [columns.map(csvCell).join(';')];
  for (const p of report.points) {
    lines.push([
      p.name, p.id, p.city, p.address,
      p.active ? 'Активна' : 'Отключена',
      p.is_hub ? 'Хаб' : 'Точка',
      p.created_date || 'НЕТ ДАННЫХ',
      p.created_date ? (sourceName[p.created_source] || 'Историческая дата') : 'Требуется уточнение',
      p.sales, p.revenue, p.months_with_sales,
      p.created_date ? 'Нет' : 'ДА',
      ...report.months.flatMap((month) => {
        const values = p.monthly_sales[month.key];
        return [values ? values.sales : 0, values ? values.revenue : 0];
      }),
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  MIN_YEAR, currentKrasnoyarskYear, localMidnightAsUtc,
  changePercent, collectBusinessYearReport,
  formatBusinessYearReport, buildBusinessYearCsv, buildBusinessPointsCsv,
};
