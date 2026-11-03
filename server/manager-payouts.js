// manager-payouts.js — начисления и реестр фактических выплат менеджерам.
'use strict';

const db = require('./db');
const { snapshotPayout, snapshotBonusPayout } = require('./payout-reports');

function getManagerUnpaidOrders(managerId) {
  // Every paid order can accrue commission ONCE. manager_points is a
  // historical/referral ledger: joining all its rows duplicates a sale when a
  // point was reassigned/recreated. Use the latest relevant rate only.
  // Returned orders are held for review (same rule as payout-brief.js), never
  // paid automatically. Existing payout snapshots are not modified.
  return db.prepare(`
    SELECT o.id, o.order_code, o.total, o.point_id, o.created_at,
           o.refund_status, o.refunded_amount,
           p.name AS point_name,
           COALESCE((
             SELECT mp.commission_rate FROM manager_points mp
             WHERE mp.point_id = p.id AND mp.manager_id = p.manager_id
             ORDER BY mp.active DESC, mp.id DESC LIMIT 1
           ), 0.07) AS commission_rate
    FROM orders o
    JOIN points p ON p.id = o.point_id AND p.manager_id = ?
    LEFT JOIN manager_commission_payout_items pi ON pi.order_id = o.id
    WHERE o.status = 'paid' AND pi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(managerId).map((order) => ({
    ...order,
    commission_amount: Math.round(Number(order.total || 0) * Number(order.commission_rate || 0)),
  }));
}

// A refund is held for administrative reconciliation. Keep such rows visible
// to payout-brief.js, while excluding them from sums and actual transfer flows.
function isManagerOrderPayable(order) {
  return order.refund_status !== 'refunded' && Number(order.refunded_amount || 0) === 0;
}

function getManagerPayableOrders(managerId) {
  return getManagerUnpaidOrders(managerId).filter(isManagerOrderPayable);
}

function getManagerUnpaidSummary(managerId) {
  const orders = getManagerPayableOrders(managerId);
  return {
    amount: orders.reduce((sum, order) => sum + order.commission_amount, 0),
    revenue: orders.reduce((sum, order) => sum + Number(order.total || 0), 0),
    orders_count: orders.length,
  };
}

// Accrued commission IN a selected calendar-day window is NOT the amount
// still owed. This is the read-only source for the full cabinet's period KPI,
// its chart and the miniapp's explanation of pending payout amounts.
function getManagerPeriodAccrual(managerId, days = 7, now = new Date()) {
  const periodDays = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 7));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = today - (periodDays - 1) * dayMs;
  const previousMs = startMs - periodDays * dayMs;
  const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT o.id, o.created_at, o.total, o.refund_status, o.refunded_amount,
           p.id AS point_id, p.name AS point_name,
           COALESCE((
             SELECT mp.commission_rate FROM manager_points mp
             WHERE mp.point_id = p.id AND mp.manager_id = p.manager_id
             ORDER BY mp.active DESC, mp.id DESC LIMIT 1
           ), 0.07) AS commission_rate
    FROM orders o
    JOIN points p ON p.id = o.point_id
    WHERE p.manager_id = ? AND o.status = 'paid'
      AND o.created_at >= ? AND o.created_at <= ?
    ORDER BY o.created_at, o.id
  `).all(managerId, sqlTime(previousMs), sqlTime(now.getTime()));

  const daily = new Map(), points = new Map();
  let accrued = 0, previous = 0, paidCount = 0;
  for (const row of rows) {
    const net = row.refund_status === 'refunded' && row.refunded_amount == null
      ? 0 : Math.max(0, Number(row.total || 0) - Number(row.refunded_amount || 0));
    if (net <= 0) continue;
    const amount = Math.round(net * Number(row.commission_rate || 0));
    if (row.created_at < sqlTime(startMs)) { previous += amount; continue; }
    accrued += amount;
    paidCount++;
    const key = String(row.created_at).slice(0, 10);
    daily.set(key, (daily.get(key) || 0) + amount);
    const point = points.get(row.point_id) || {
      point_id: row.point_id, point_name: row.point_name, revenue: 0,
      commission: 0, orders: 0,
    };
    point.revenue += net;
    point.commission += amount;
    point.orders++;
    points.set(row.point_id, point);
  }
  const labels = [], earn = [];
  for (let i = 0; i < periodDays; i++) {
    const t = startMs + i * dayMs;
    const key = new Date(t).toISOString().slice(0, 10);
    labels.push(new Date(t).toLocaleDateString('ru-RU', {
      timeZone: 'UTC', day: 'numeric', month: 'short',
    }));
    earn.push(daily.get(key) || 0);
  }
  return {
    days: periodDays, period_residual: accrued, previous_period_residual: previous,
    period_change_percent: previous > 0 ? Math.round((accrued - previous) * 1000 / previous) / 10 : null,
    period_orders_count: paidCount, labels, earn,
    period_points: [...points.values()].sort((a,b) =>
      b.commission - a.commission || a.point_name.localeCompare(b.point_name, 'ru')),
  };
}

function getLaunchBonusSummary(managerPointId) {
  return db.prepare(`
    SELECT mp.id AS manager_point_id, mp.manager_id, mp.point_id, mp.point_name,
           mp.bonus_paid AS bonus_accrued, mp.bonus_accrued_at,
           COALESCE(mp.bonus_manager_amount, 2000) AS amount,
           m.full_name AS manager_name, m.mgr_code,
           bp.id AS payout_id, bp.paid_at
    FROM manager_points mp
    JOIN managers m ON m.id = mp.manager_id
    LEFT JOIN manager_launch_bonus_payouts bp ON bp.manager_point_id = mp.id
    WHERE mp.id = ?
  `).get(managerPointId);
}

function createManagerCommissionPayout(managerId, adminPayload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const manager = db.prepare('SELECT id, full_name, mgr_code, inn FROM managers WHERE id = ?').get(managerId);
    if (!manager) throw Object.assign(new Error('Менеджер не найден'), { code: 'MANAGER_NOT_FOUND' });
    const orders = getManagerPayableOrders(managerId);
    const amount = orders.reduce((sum, order) => sum + order.commission_amount, 0);
    if (!orders.length || amount <= 0) {
      throw Object.assign(new Error('У менеджера нет невыплаченного вознаграждения 7%'), { code: 'NOTHING_TO_PAY' });
    }
    const info = db.prepare(`
      INSERT INTO manager_commission_payouts
        (manager_id, manager_name, manager_code, amount, orders_count,
         paid_by_admin_id, paid_by_admin_login)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(manager.id, manager.full_name, manager.mgr_code, amount, orders.length,
      adminPayload.id || null, adminPayload.login || null);
    const payoutId = Number(info.lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO manager_commission_payout_items
        (payout_id, order_id, order_code, point_id, point_name, commission_rate, commission_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    orders.forEach((order) => insert.run(
      payoutId, order.id, order.order_code, order.point_id, order.point_name,
      order.commission_rate, order.commission_amount
    ));
    const payout=db.prepare('SELECT * FROM manager_commission_payouts WHERE id = ?').get(payoutId);
    const report=snapshotPayout(db,'manager',{...manager,code:manager.mgr_code},orders,payout,adminPayload.id);
    db.exec('COMMIT');
    return {...payout,report_id:report.id};
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function createManagerLaunchBonusPayout(managerPointId, adminPayload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const bonus = getLaunchBonusSummary(managerPointId);
    if (!bonus) throw Object.assign(new Error('Точка менеджера не найдена'), { code: 'POINT_NOT_FOUND' });
    if (!bonus.bonus_accrued) throw Object.assign(new Error('Бонус за запуск этой точки ещё не начислен'), { code: 'NOT_ACCRUED' });
    if (bonus.payout_id) throw Object.assign(new Error('Бонус за запуск этой точки уже выплачен'), { code: 'ALREADY_PAID' });
    const info = db.prepare(`
      INSERT INTO manager_launch_bonus_payouts
        (manager_point_id, manager_id, manager_name, manager_code, point_id,
         point_name, amount, paid_by_admin_id, paid_by_admin_login)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bonus.manager_point_id, bonus.manager_id, bonus.manager_name, bonus.mgr_code,
      bonus.point_id || null, bonus.point_name, bonus.amount,
      adminPayload.id || null, adminPayload.login || null
    );
    const payout=db.prepare('SELECT * FROM manager_launch_bonus_payouts WHERE id = ?').get(Number(info.lastInsertRowid));
    const report=snapshotBonusPayout(db,'manager',{id:bonus.manager_id,full_name:bonus.manager_name,code:bonus.mgr_code},payout,adminPayload.id,'launch_bonus',bonus.bonus_accrued_at);
    db.exec('COMMIT');
    return {...payout,report_id:report.id};
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function listManagerPayouts(limit = 100) {
  return db.prepare(`
    SELECT * FROM (
      SELECT id, 'commission' AS payout_type, manager_id, manager_name, manager_code,
             NULL AS point_name, amount, orders_count, paid_by_admin_login, paid_at
      FROM manager_commission_payouts
      UNION ALL
      SELECT id, 'launch_bonus' AS payout_type, manager_id, manager_name, manager_code,
             point_name, amount, 0 AS orders_count, paid_by_admin_login, paid_at
      FROM manager_launch_bonus_payouts
    ) ORDER BY paid_at DESC, id DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  createManagerCommissionPayout,
  createManagerLaunchBonusPayout,
  getLaunchBonusSummary,
  getManagerUnpaidOrders,
  getManagerPayableOrders,
  getManagerUnpaidSummary,
  getManagerPeriodAccrual,
  listManagerPayouts,
};
