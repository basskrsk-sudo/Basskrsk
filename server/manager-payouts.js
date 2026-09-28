// manager-payouts.js — начисления и реестр фактических выплат менеджерам.
'use strict';

const db = require('./db');

function getManagerUnpaidOrders(managerId) {
  return db.prepare(`
    SELECT o.id, o.order_code, o.total, o.point_id,
           p.name AS point_name, mp.commission_rate
    FROM orders o
    JOIN points p ON p.id = o.point_id AND p.manager_id = ?
    JOIN manager_points mp ON mp.point_id = o.point_id AND mp.manager_id = ?
    LEFT JOIN manager_commission_payout_items pi ON pi.order_id = o.id
    WHERE o.status = 'paid' AND pi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(managerId, managerId).map((order) => ({
    ...order,
    commission_amount: Math.round(Number(order.total || 0) * Number(order.commission_rate || 0)),
  }));
}

function getManagerUnpaidSummary(managerId) {
  const orders = getManagerUnpaidOrders(managerId);
  return {
    amount: orders.reduce((sum, order) => sum + order.commission_amount, 0),
    revenue: orders.reduce((sum, order) => sum + Number(order.total || 0), 0),
    orders_count: orders.length,
  };
}

function getLaunchBonusSummary(managerPointId) {
  return db.prepare(`
    SELECT mp.id AS manager_point_id, mp.manager_id, mp.point_id, mp.point_name,
           mp.bonus_paid AS bonus_accrued,
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
    const manager = db.prepare('SELECT id, full_name, mgr_code FROM managers WHERE id = ?').get(managerId);
    if (!manager) throw Object.assign(new Error('Менеджер не найден'), { code: 'MANAGER_NOT_FOUND' });
    const orders = getManagerUnpaidOrders(managerId);
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
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM manager_commission_payouts WHERE id = ?').get(payoutId);
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
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM manager_launch_bonus_payouts WHERE id = ?').get(Number(info.lastInsertRowid));
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
  getManagerUnpaidSummary,
  listManagerPayouts,
};
