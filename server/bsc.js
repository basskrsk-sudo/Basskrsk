// bsc.js — расчёт сбалансированной системы показателей ХвостМаркета.
'use strict';

const db = require('./db');

const PERSPECTIVES = [
  { key: 'finance', name: 'Финансы', defaultWeight: 35, accountable: 'Лакомых Алексей' },
  { key: 'customers', name: 'Клиенты и партнёры', defaultWeight: 25, accountable: 'Лакомых Алексей' },
  { key: 'processes', name: 'Внутренние процессы', defaultWeight: 25, accountable: 'Соколов Виталий' },
  { key: 'team', name: 'Команда и развитие', defaultWeight: 15, accountable: 'Лакомых Алексей' },
];

const RESPONSIBILITY_MATRIX = [
  {
    name: 'Лакомых Алексей',
    role: 'Собственник · операционное и коммерческое управление',
    responsibility: 'Финансы, продажи, сайт, клиентский сервис, партнёры и команда',
  },
  {
    name: 'Соколов Виталий',
    role: 'Собственник · продукт, закупки и логистика',
    responsibility: 'Остатки, пополнение, перемещения, качество и документы на товар',
  },
  {
    name: 'Кучкин Николай',
    role: 'Собственник · стратегия и бизнес-процессы',
    responsibility: 'Методология BSC, аналитика, полнота данных, регламенты, право и риски',
  },
  {
    name: 'Менеджер',
    role: 'Операционный исполнитель',
    responsibility: 'Запуск и активность точек, CRM, удержание партнёров, остатки и обращения',
  },
];

const KPI_DEFINITIONS = [
  { key: 'margin_percent', perspective: 'finance', name: 'Маржинальность', target: 25, unit: '%', direction: 'up', weight: 40, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Лакомых Алексей', description: 'Чистая расчётная прибыль относительно выручки.' },
  { key: 'revenue_growth', perspective: 'finance', name: 'Рост выручки', target: 10, unit: '%', direction: 'up', weight: 30, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Изменение к предыдущей завершённой неделе.' },
  { key: 'average_check', perspective: 'finance', name: 'Средний чек', target: 350, unit: '₽', direction: 'up', weight: 30, format: 'money', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Выручка после возвратов на оплаченный заказ.' },

  { key: 'payment_conversion', perspective: 'customers', name: 'Конверсия в оплату', target: 85, unit: '%', direction: 'up', weight: 40, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Лакомых Алексей', description: 'Доля оплаченных заказов среди созданных.' },
  { key: 'returning_share', perspective: 'customers', name: 'Вернувшиеся покупатели', target: 25, unit: '%', direction: 'up', weight: 30, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Доля покупателей, которые совершали покупки раньше.' },
  { key: 'paid_orders_growth', perspective: 'customers', name: 'Рост оплаченных заказов', target: 10, unit: '%', direction: 'up', weight: 30, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Изменение количества оплаченных заказов к прошлой неделе.' },

  { key: 'stock_availability', perspective: 'processes', name: 'Доступность ассортимента', target: 95, unit: '%', direction: 'up', weight: 35, format: 'percent', accountable: 'Соколов Виталий', executor: 'Менеджер', description: 'Доля активных складских позиций с положительным остатком.' },
  { key: 'low_stock_share', perspective: 'processes', name: 'Критически низкие остатки', target: 10, unit: '%', direction: 'down', weight: 20, format: 'percent', accountable: 'Соколов Виталий', executor: 'Менеджер', description: 'Доля позиций, где осталось 1–2 единицы.' },
  { key: 'pending_movements', perspective: 'processes', name: 'Ожидающие перемещения', target: 0, unit: 'шт.', direction: 'down', weight: 20, format: 'number', accountable: 'Соколов Виталий', executor: 'Менеджер', description: 'Заявки на перемещение, ожидающие проверки.' },
  { key: 'order_data_completeness', perspective: 'processes', name: 'Полнота данных заказов', target: 98, unit: '%', direction: 'up', weight: 25, format: 'percent', accountable: 'Кучкин Николай', executor: 'Менеджер', description: 'Оплаченные заказы с точкой, телефоном и зафиксированной ставкой.' },

  { key: 'manager_coverage', perspective: 'team', name: 'Точки закреплены за менеджерами', target: 100, unit: '%', direction: 'up', weight: 40, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Лакомых Алексей', description: 'Доля активных точек, у которых назначен менеджер.' },
  { key: 'partner_channel_connection', perspective: 'team', name: 'Грумеры подключены к уведомлениям', target: 80, unit: '%', direction: 'up', weight: 30, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Доля активных грумеров с Telegram или MAX.' },
  { key: 'partner_coverage', perspective: 'team', name: 'Точки с активными грумерами', target: 100, unit: '%', direction: 'up', weight: 30, format: 'percent', accountable: 'Лакомых Алексей', executor: 'Менеджер', description: 'Доля активных точек, где есть хотя бы один активный грумер.' },
];

function round(value, precision = 1) {
  const multiplier = 10 ** precision;
  return Math.round(Number(value || 0) * multiplier) / multiplier;
}

function seedSettings() {
  const insertKpi = db.prepare('INSERT OR IGNORE INTO bsc_kpi_settings (kpi_key, target_value) VALUES (?, ?)');
  KPI_DEFINITIONS.forEach((item) => insertKpi.run(item.key, item.target));
  const insertPerspective = db.prepare('INSERT OR IGNORE INTO bsc_perspective_settings (perspective_key, weight) VALUES (?, ?)');
  PERSPECTIVES.forEach((item) => insertPerspective.run(item.key, item.defaultWeight));
}

function scoreMetric(actual, target, direction) {
  if (actual === null || actual === undefined || !Number.isFinite(Number(actual))) return null;
  const value = Number(actual);
  const goal = Number(target);
  if (direction === 'down') {
    if (value <= goal) return 100;
    if (goal > 0) return round(Math.max(0, Math.min(100, goal / value * 100)));
    return round(Math.max(0, 100 - value * 20));
  }
  if (value >= goal) return 100;
  if (goal <= 0) return value >= goal ? 100 : 0;
  return round(Math.max(0, Math.min(100, value / goal * 100)));
}

function statusFromScore(score) {
  if (score === null) return 'unknown';
  if (score >= 100) return 'green';
  if (score >= 85) return 'yellow';
  return 'red';
}

function statusFromIndex(score) {
  if (score === null) return 'unknown';
  if (score >= 85) return 'green';
  if (score >= 70) return 'yellow';
  return 'red';
}

function calculateSupportingMetrics(report) {
  const stock = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN s.qty = 0 THEN 1 ELSE 0 END) AS out_count,
           SUM(CASE WHEN s.qty BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS low_count
    FROM stock s
    JOIN points p ON p.id = s.point_id AND p.active = 1
    JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
    JOIN products pr ON pr.id = v.product_id AND pr.active = 1
  `).get();
  const stockTotal = Number(stock.total || 0);
  const activePoints = Number(db.prepare('SELECT COUNT(*) AS count FROM points WHERE active = 1 AND is_hub = 0').get().count || 0);
  const managedPoints = Number(db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS count
    FROM points p
    LEFT JOIN manager_points mp ON mp.point_id = p.id AND mp.active = 1
    WHERE p.active = 1 AND p.is_hub = 0 AND (p.manager_id IS NOT NULL OR mp.manager_id IS NOT NULL)
  `).get().count || 0);
  const partnerPoints = Number(db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS count
    FROM points p JOIN partners pt ON pt.point_id = p.id AND pt.active = 1
    WHERE p.active = 1 AND p.is_hub = 0
  `).get().count || 0);
  const partners = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN NULLIF(TRIM(telegram_chat_id), '') IS NOT NULL OR NULLIF(TRIM(max_chat_id), '') IS NOT NULL THEN 1 ELSE 0 END) AS connected
    FROM partners WHERE active = 1
  `).get();
  const paidOrders = report.current.paidOrders || [];
  const completeOrders = paidOrders.filter((order) =>
    order.point_id && String(order.customer_phone || '').replace(/\D/g, '').length >= 10 && order.commission_rate !== null
  ).length;
  return {
    stock_availability: stockTotal ? round((stockTotal - Number(stock.out_count || 0)) / stockTotal * 100) : 0,
    low_stock_share: stockTotal ? round(Number(stock.low_count || 0) / stockTotal * 100) : 0,
    order_data_completeness: paidOrders.length ? round(completeOrders / paidOrders.length * 100) : 0,
    manager_coverage: activePoints ? round(managedPoints / activePoints * 100) : 0,
    partner_coverage: activePoints ? round(partnerPoints / activePoints * 100) : 0,
    partner_channel_connection: Number(partners.total || 0) ? round(Number(partners.connected || 0) / Number(partners.total) * 100) : 0,
  };
}

function calculateBsc(report) {
  seedSettings();
  const targets = new Map(db.prepare('SELECT kpi_key, target_value FROM bsc_kpi_settings').all().map((row) => [row.kpi_key, Number(row.target_value)]));
  const perspectiveWeights = new Map(db.prepare('SELECT perspective_key, weight FROM bsc_perspective_settings').all().map((row) => [row.perspective_key, Number(row.weight)]));
  const supporting = calculateSupportingMetrics(report);
  const actuals = {
    margin_percent: report.current.margin_percent,
    revenue_growth: report.comparison.revenue_change_percent,
    average_check: report.current.average_check,
    payment_conversion: report.current.payment_conversion,
    returning_share: report.customers.returning_share,
    paid_orders_growth: report.comparison.orders_change_percent,
    stock_availability: supporting.stock_availability,
    low_stock_share: supporting.low_stock_share,
    pending_movements: report.operations.movements.pending,
    order_data_completeness: supporting.order_data_completeness,
    manager_coverage: supporting.manager_coverage,
    partner_channel_connection: supporting.partner_channel_connection,
    partner_coverage: supporting.partner_coverage,
  };
  const metrics = KPI_DEFINITIONS.map((definition) => {
    const target = targets.has(definition.key) ? targets.get(definition.key) : definition.target;
    const actual = actuals[definition.key];
    const score = scoreMetric(actual, target, definition.direction);
    return { ...definition, actual, target, score, status: statusFromScore(score) };
  });
  const perspectives = PERSPECTIVES.map((definition) => {
    const kpis = metrics.filter((metric) => metric.perspective === definition.key);
    const available = kpis.filter((metric) => metric.score !== null);
    const totalKpiWeight = available.reduce((sum, metric) => sum + metric.weight, 0);
    const score = totalKpiWeight
      ? round(available.reduce((sum, metric) => sum + metric.score * metric.weight, 0) / totalKpiWeight)
      : null;
    return {
      key: definition.key,
      name: definition.name,
      accountable: definition.accountable,
      weight: perspectiveWeights.has(definition.key) ? perspectiveWeights.get(definition.key) : definition.defaultWeight,
      score,
      status: statusFromIndex(score),
      kpis,
    };
  });
  const availablePerspectives = perspectives.filter((item) => item.score !== null);
  const totalWeight = availablePerspectives.reduce((sum, item) => sum + item.weight, 0);
  const overallScore = totalWeight
    ? round(availablePerspectives.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight)
    : 0;
  const weakestPerspectiveScore = availablePerspectives.length
    ? Math.min(...availablePerspectives.map((item) => item.score))
    : 0;
  const today = new Date().toISOString().slice(0, 10);
  const openInitiatives = db.prepare(`
    SELECT id, perspective_key, kpi_key, title, responsible, due_date, status
    FROM bsc_initiatives
    WHERE status IN ('planned', 'in_progress')
    ORDER BY due_date, id DESC LIMIT 10
  `).all().map((item) => ({ ...item, overdue: item.due_date < today }));
  const initiativeCounts = db.prepare(`
    SELECT COUNT(*) AS open,
           SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue
    FROM bsc_initiatives WHERE status IN ('planned', 'in_progress')
  `).get(today);
  const overdueInitiatives = Number(initiativeCounts.overdue || 0);
  let readiness;
  // Высокий общий балл не должен скрывать провал одного направления: это и
  // есть смысл сбалансированной системы. Для ускорения каждое направление
  // обязано набрать хотя бы 70, для сохранения темпа — хотя бы 55.
  if (overallScore >= 85 && weakestPerspectiveScore >= 70 && overdueInitiatives === 0) readiness = { code: 'accelerate', title: 'Можно ускорять расширение', description: 'Система показателей подтверждает готовность к следующей партии точек.' };
  else if (overallScore >= 70 && weakestPerspectiveScore >= 55 && overdueInitiatives === 0) readiness = { code: 'steady', title: 'Развиваться текущим темпом', description: 'Критических ограничений нет, но отклонения нужно держать под контролем.' };
  else if (overallScore >= 55) readiness = { code: 'restrict', title: 'Ограничить новые открытия', description: 'Сначала исправьте красные показатели и завершите планы улучшения.' };
  else readiness = { code: 'pause', title: 'Приостановить масштабирование', description: 'Текущая модель требует стабилизации до открытия новых точек.' };
  return {
    period: report.period,
    generated_at: new Date().toISOString(),
    overall_score: overallScore,
    status: statusFromIndex(overallScore),
    readiness,
    perspectives,
    initiatives_summary: {
      open: Number(initiativeCounts.open || 0),
      overdue: overdueInitiatives,
      items: openInitiatives,
    },
    responsibility_matrix: RESPONSIBILITY_MATRIX.map((member) => ({
      ...member,
      owned_kpis: metrics.filter((metric) => metric.accountable === member.name).map((metric) => metric.name),
      executed_kpis: metrics.filter((metric) => metric.executor === member.name).map((metric) => metric.name),
    })),
    points: report.points.map((point) => ({
      id: point.id, name: point.name, city: point.city, revenue: point.revenue,
      orders_count: point.orders_count, change_percent: point.change_percent,
      stock_alerts: point.out_count + point.low_count,
      status: point.orders_count === 0 || point.out_count > 0 ? 'red' : (point.low_count > 0 ? 'yellow' : 'green'),
    })),
  };
}

module.exports = { KPI_DEFINITIONS, PERSPECTIVES, RESPONSIBILITY_MATRIX, calculateBsc, seedSettings };
