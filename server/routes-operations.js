// routes-operations.js — единый операционный центр администратора.
// Собирает только проблемы, по которым можно совершить действие прямо сейчас.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { getAllPointLaunchSummaries } = require('./point-launch-checklist');
const { buildGrowthPlanDashboard } = require('./growth-plan');

function addIssue(issues, issue) {
  if (Number(issue.count || 0) > 0) issues.push(issue);
}

function money(value) {
  return Math.round(Number(value || 0));
}

function buildOperationsCenter() {
  const issues = [];

  const growthPlan = buildGrowthPlanDashboard();
  const growthAlerts = growthPlan.alerts.filter((alert) => ['critical', 'warning'].includes(alert.severity));
  if (growthAlerts.length) {
    addIssue(issues, {
      key: 'growth_plan',
      severity: growthAlerts.some((alert) => alert.severity === 'critical') ? 'critical' : 'warning',
      icon: '📍', title: 'План 1000 точек', count: growthAlerts.length,
      summary: 'План: ' + growthPlan.progress.target_to_date + ' · активны 30 дней: ' + growthPlan.facts.active_30d + ' · прогноз года: ' + growthPlan.progress.forecast_year_end,
      section: 'growth-plan', action_label: 'Открыть план',
      details: growthAlerts.slice(0, 5).map((alert) => ({ title: alert.title, meta: alert.detail, badge: alert.owner })),
    });
  }

  // Только свежие проблемы оплаты: старые тестовые/отменённые заказы не
  // должны годами висеть красным на главной. Pending считаем проблемой через
  // 3 минуты — тот же порог используется срочным Telegram-оповещением.
  const paymentRows = db.prepare(`
    SELECT id, order_code, customer_phone, pickup_point, total, status, created_at
    FROM orders
    WHERE (
      status = 'pending'
      AND created_at <= datetime('now', '-3 minutes')
      AND created_at >= datetime('now', '-1 day')
    ) OR (
      status = 'failed'
      AND created_at >= datetime('now', '-1 day')
    )
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
  `).all();
  addIssue(issues, {
    key: 'payments', severity: 'critical', icon: '💳', title: 'Проблемы с оплатой',
    count: paymentRows.length,
    summary: 'Неоплаченные и неуспешные заказы за последние 24 часа',
    section: 'orders', action_label: 'Открыть заказы',
    details: paymentRows.slice(0, 5).map((row) => ({
      title: row.order_code + ' · ' + money(row.total).toLocaleString('ru-RU') + ' ₽',
      meta: row.customer_phone + ' · ' + row.pickup_point,
      badge: row.status === 'pending' ? 'Ожидает оплату' : 'Ошибка оплаты',
    })),
  });

  // Нулевой остаток показываем только по товарам, которые реально продавались
  // на этой точке за 30 дней. Иначе каждая ещё не заполненная матрица создала
  // бы десятки ложных тревог. Остаток 1–2 единицы всегда требует внимания.
  const stockRows = db.prepare(`
    SELECT s.point_id, pt.name AS point_name, pr.name AS product_name,
           pv.weight, s.qty,
           CASE WHEN s.qty <= 0 THEN 1 ELSE 0 END AS is_out
    FROM stock s
    JOIN points pt ON pt.id = s.point_id AND pt.active = 1
    JOIN product_variants pv ON pv.id = s.variant_id AND pv.active = 1
    JOIN products pr ON pr.id = pv.product_id AND pr.active = 1
    WHERE s.qty BETWEEN 1 AND 2
       OR (s.qty <= 0 AND EXISTS (
         SELECT 1 FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.variant_id = s.variant_id AND o.point_id = s.point_id
           AND o.status = 'paid' AND o.created_at >= datetime('now', '-30 days')
       ))
    ORDER BY is_out DESC, s.qty, pt.name, pr.name
  `).all();
  const outCount = stockRows.filter((row) => row.is_out).length;
  addIssue(issues, {
    key: 'stock', severity: outCount ? 'critical' : 'warning', icon: '📦',
    title: outCount ? 'Товар закончился или заканчивается' : 'Товар заканчивается',
    count: stockRows.length,
    summary: outCount
      ? 'Нет в наличии: ' + outCount + ' поз.; остаток 1–2 шт.: ' + (stockRows.length - outCount)
      : 'На точках осталось по 1–2 единицы товара',
    section: 'stock', action_label: 'Открыть остатки',
    details: stockRows.slice(0, 5).map((row) => ({
      title: row.product_name + ' · ' + row.weight,
      meta: row.point_name,
      badge: row.qty <= 0 ? 'Нет в наличии' : 'Осталось ' + row.qty,
    })),
  });

  const noSalesRows = db.prepare(`
    SELECT p.id, p.name, p.addr, MAX(o.created_at) AS last_sale
    FROM points p
    LEFT JOIN orders o ON o.point_id = p.id AND o.status = 'paid'
    WHERE p.active = 1
    GROUP BY p.id
    HAVING last_sale IS NULL OR last_sale < datetime('now', '-7 days')
    ORDER BY CASE WHEN last_sale IS NULL THEN 0 ELSE 1 END, last_sale
  `).all();
  addIssue(issues, {
    key: 'silent_points', severity: 'warning', icon: '📉', title: 'Точки без продаж',
    count: noSalesRows.length,
    summary: 'Нет оплаченных заказов более 7 дней',
    section: 'points', action_label: 'Открыть точки',
    details: noSalesRows.slice(0, 5).map((row) => ({
      title: row.name,
      meta: row.addr,
      badge: row.last_sale ? 'Последняя: ' + row.last_sale.slice(0, 10) : 'Продаж ещё не было',
    })),
  });

  const setupRows = getAllPointLaunchSummaries(true).filter((row) => !row.ready);
  addIssue(issues, {
    key: 'point_setup', severity: 'warning', icon: '🧩', title: 'Не завершён запуск точек',
    count: setupRows.length,
    summary: 'Есть незакрытые обязательные пункты чек-листа открытия',
    section: 'points', action_label: 'Открыть чек-листы',
    details: setupRows.slice(0, 5).map((row) => ({
      title: row.point_name,
      meta: row.addr,
      badge: row.percent + '% · осталось ' + row.remaining,
    })),
  });

  const taskRows = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, a.full_name AS assignee_name,
           CASE WHEN t.due_date IS NOT NULL AND t.due_date < date('now') THEN 1 ELSE 0 END AS overdue
    FROM meeting_tasks t
    LEFT JOIN task_assignees a ON a.id = t.assignee_id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND (t.status = 'blocked' OR t.assignee_id IS NULL
           OR (t.due_date IS NOT NULL AND t.due_date < date('now')))
    ORDER BY overdue DESC, CASE t.status WHEN 'blocked' THEN 0 ELSE 1 END,
             CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.due_date
  `).all();
  const overdueCount = taskRows.filter((row) => row.overdue).length;
  addIssue(issues, {
    key: 'tasks', severity: overdueCount ? 'critical' : 'warning', icon: '✅',
    title: 'Поручения требуют решения', count: taskRows.length,
    summary: 'Просрочено: ' + overdueCount + ' · без ответственного или заблокировано: ' + (taskRows.length - overdueCount),
    section: 'tasks', action_label: 'Открыть поручения',
    details: taskRows.slice(0, 5).map((row) => ({
      title: row.title,
      meta: row.assignee_name || 'Ответственный не назначен',
      badge: row.overdue ? 'Просрочено: ' + row.due_date : (row.status === 'blocked' ? 'Заблокировано' : 'Без ответственного'),
    })),
  });

  const movementRows = db.prepare(`
    SELECT sm.id, sm.reported_at, p.name AS point_name, m.full_name AS manager_name,
           (SELECT COALESCE(SUM(qty), 0) FROM stock_movement_items WHERE movement_id = sm.id) AS total_qty
    FROM stock_movements sm
    JOIN points p ON p.id = sm.point_id
    JOIN managers m ON m.id = sm.manager_id
    WHERE sm.status = 'pending'
    ORDER BY sm.reported_at
  `).all();
  addIssue(issues, {
    key: 'movements', severity: 'warning', icon: '🚚', title: 'Перемещения на согласовании',
    count: movementRows.length,
    summary: 'Остатки изменятся только после подтверждения администратора',
    section: 'restock', action_label: 'Проверить перемещения',
    details: movementRows.slice(0, 5).map((row) => ({
      title: row.point_name + ' · ' + row.total_qty + ' шт.',
      meta: row.manager_name,
      badge: row.reported_at.slice(0, 16),
    })),
  });

  // Те же формулы, что в реестрах выплат, но агрегированные запросы вместо
  // отдельного запроса на каждого человека. Это принципиально для сети из
  // сотен и тысяч точек: время открытия дашборда не растёт линейно с людьми.
  const payoutDetails = [];
  let payoutAmount = 0;
  const partnerAccruals = db.prepare(`
    SELECT p.id, p.full_name, COUNT(o.id) AS orders_count,
           CAST(SUM(ROUND(o.total * COALESCE(o.commission_rate, p.commission_rate, 0))) AS INTEGER) AS amount
    FROM partners p
    JOIN orders o ON o.partner_id = p.id AND o.status = 'paid'
    LEFT JOIN partner_payout_items pi ON pi.order_id = o.id
    WHERE p.active = 1 AND pi.id IS NULL
    GROUP BY p.id HAVING amount > 0
  `).all();
  partnerAccruals.forEach((row) => {
    payoutAmount += money(row.amount);
    payoutDetails.push({ title: row.full_name, meta: 'Грумер · ' + row.orders_count + ' заказ(ов)', amount: money(row.amount), section: 'partners' });
  });

  const ownerAccruals = db.prepare(`
    SELECT so.id, so.full_name, COUNT(o.id) AS orders_count,
           CAST(SUM(ROUND(o.total * COALESCE(so.commission_rate, 0))) AS INTEGER) AS amount
    FROM salon_owners so
    JOIN orders o ON o.point_id = so.point_id AND o.status = 'paid'
    LEFT JOIN owner_payout_items pi ON pi.order_id = o.id
    WHERE so.active = 1 AND pi.id IS NULL
    GROUP BY so.id HAVING amount > 0
  `).all();
  ownerAccruals.forEach((row) => {
    payoutAmount += money(row.amount);
    payoutDetails.push({ title: row.full_name, meta: 'Владелец · ' + row.orders_count + ' заказ(ов)', amount: money(row.amount), section: 'owners' });
  });

  const managerAccruals = db.prepare(`
    SELECT m.id, m.full_name, COUNT(o.id) AS orders_count,
           CAST(SUM(ROUND(o.total * COALESCE((
             SELECT mp.commission_rate FROM manager_points mp
             WHERE mp.manager_id = m.id AND mp.point_id = o.point_id AND mp.active = 1
             ORDER BY mp.id DESC LIMIT 1
           ), 0))) AS INTEGER) AS amount
    FROM managers m
    JOIN points pt ON pt.manager_id = m.id
    JOIN orders o ON o.point_id = pt.id AND o.status = 'paid'
    LEFT JOIN manager_commission_payout_items pi ON pi.order_id = o.id
    WHERE m.active = 1 AND pi.id IS NULL
    GROUP BY m.id HAVING amount > 0
  `).all();
  managerAccruals.forEach((row) => {
    payoutAmount += money(row.amount);
    payoutDetails.push({ title: row.full_name, meta: 'Менеджер · 7% · ' + row.orders_count + ' заказ(ов)', amount: money(row.amount), section: 'managers' });
  });
  const launchBonuses = db.prepare(`
    SELECT m.full_name, mp.point_name, COALESCE(mp.bonus_manager_amount, 2000) AS amount
    FROM manager_points mp JOIN managers m ON m.id = mp.manager_id
    LEFT JOIN manager_launch_bonus_payouts bp ON bp.manager_point_id = mp.id
    WHERE mp.bonus_paid = 1 AND bp.id IS NULL
  `).all();
  launchBonuses.forEach((row) => {
    payoutAmount += money(row.amount);
    payoutDetails.push({ title: row.full_name, meta: 'Бонус запуска · ' + row.point_name, amount: money(row.amount), section: 'managers' });
  });
  payoutDetails.sort((a, b) => b.amount - a.amount);
  addIssue(issues, {
    key: 'payouts', severity: 'info', icon: '₽', title: 'Начислено к выплате',
    count: payoutDetails.length,
    summary: payoutAmount.toLocaleString('ru-RU') + ' ₽ по всем ролям',
    section: 'partners', action_label: 'Открыть выплаты',
    details: payoutDetails.slice(0, 5).map((row) => ({
      title: row.title,
      meta: row.meta,
      badge: row.amount.toLocaleString('ru-RU') + ' ₽',
      section: row.section,
    })),
  });

  const notificationRows = db.prepare(`
    SELECT 'Оплата' AS source, 'Telegram' AS channel, error, created_at
    FROM unpaid_order_alert_log WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
    UNION ALL
    SELECT 'Выплата', channel, error, created_at
    FROM payout_notification_log WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
    UNION ALL
    SELECT 'Напоминание о выплате', channel, error, created_at
    FROM payout_reminder_log WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
    UNION ALL
    SELECT 'Поручение', channel, error, created_at
    FROM task_reminder_log WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC
  `).all();
  addIssue(issues, {
    key: 'notifications', severity: 'warning', icon: '🔔', title: 'Ошибки уведомлений',
    count: notificationRows.length,
    summary: 'Не доставлены сообщения Telegram или MAX за 7 дней',
    section: 'tasks', action_label: 'Проверить подключения',
    details: notificationRows.slice(0, 5).map((row) => ({
      title: row.source + ' · ' + String(row.channel).toUpperCase(),
      meta: row.error || 'Причина не указана',
      badge: row.created_at.slice(0, 16),
    })),
  });

  const priority = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => priority[a.severity] - priority[b.severity] || b.count - a.count);
  const summary = { critical: 0, warning: 0, info: 0, total: 0 };
  issues.forEach((issue) => {
    summary[issue.severity] += issue.count;
    summary.total += issue.count;
  });
  return { generated_at: new Date().toISOString(), summary, issues };
}

function registerOperationsRoutes(router) {
  router.get('/api/operations-center', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 200, buildOperationsCenter());
  });
}

module.exports = { buildOperationsCenter, registerOperationsRoutes };
