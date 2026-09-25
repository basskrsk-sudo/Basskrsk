// partner-payouts.js — расчёт невыплаченной комиссии и реестр выплат грумерам.
'use strict';

const db = require('./db');

function getUnpaidOrders(partnerId) {
  return db.prepare(`
    SELECT
      o.id,
      o.order_code,
      o.total,
      COALESCE(o.commission_rate, p.commission_rate, 0) AS commission_rate
    FROM orders o
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN partner_payout_items pi ON pi.order_id = o.id
    WHERE o.partner_id = ?
      AND o.status = 'paid'
      AND pi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(partnerId).map((order) => ({
    ...order,
    commission_amount: Math.round(Number(order.total || 0) * Number(order.commission_rate || 0)),
  }));
}

function getUnpaidSummary(partnerId) {
  const orders = getUnpaidOrders(partnerId);
  return {
    amount: orders.reduce((sum, order) => sum + order.commission_amount, 0),
    orders_count: orders.length,
  };
}

function payoutSelect(whereClause) {
  return `
    SELECT
      id, partner_id, partner_name, partner_code,
      manager_id, manager_name, amount, orders_count,
      paid_by_admin_id, paid_by_admin_login, paid_at
    FROM partner_payouts
    ${whereClause}
    ORDER BY paid_at DESC, id DESC
    LIMIT ?
  `;
}

function listPartnerPayouts(partnerId, limit = 100) {
  return db.prepare(payoutSelect('WHERE partner_id = ?')).all(partnerId, limit);
}

function listManagerPartnerPayouts(managerId, limit = 100) {
  return db.prepare(payoutSelect('WHERE manager_id = ?')).all(managerId, limit);
}

function listAllPartnerPayouts(limit = 100) {
  return db.prepare(payoutSelect('')).all(limit);
}

function createPartnerPayout(partnerId, adminPayload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const partner = db.prepare(`
      SELECT
        p.id, p.full_name, p.partner_code,
        pt.manager_id,
        m.full_name AS manager_name
      FROM partners p
      LEFT JOIN points pt ON pt.id = p.point_id
      LEFT JOIN managers m ON m.id = pt.manager_id
      WHERE p.id = ?
    `).get(partnerId);
    if (!partner) {
      const error = new Error('Партнёр не найден');
      error.code = 'PARTNER_NOT_FOUND';
      throw error;
    }

    const orders = getUnpaidOrders(partner.id);
    const amount = orders.reduce((sum, order) => sum + order.commission_amount, 0);
    if (!orders.length || amount <= 0) {
      const error = new Error('У партнёра нет невыплаченного вознаграждения');
      error.code = 'NOTHING_TO_PAY';
      throw error;
    }

    const payoutInfo = db.prepare(`
      INSERT INTO partner_payouts
        (partner_id, partner_name, partner_code, manager_id, manager_name,
         amount, orders_count, paid_by_admin_id, paid_by_admin_login)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      partner.id,
      partner.full_name,
      partner.partner_code || null,
      partner.manager_id || null,
      partner.manager_name || null,
      amount,
      orders.length,
      adminPayload.id || null,
      adminPayload.login || null
    );
    const payoutId = Number(payoutInfo.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO partner_payout_items
        (payout_id, order_id, order_code, commission_amount)
      VALUES (?, ?, ?, ?)
    `);
    orders.forEach((order) => {
      insertItem.run(payoutId, order.id, order.order_code, order.commission_amount);
    });
    db.exec('COMMIT');
    return db.prepare(payoutSelect('WHERE id = ?')).get(payoutId, 1);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* сохраняем исходную ошибку */ }
    throw error;
  }
}

module.exports = {
  createPartnerPayout,
  getUnpaidOrders,
  getUnpaidSummary,
  listAllPartnerPayouts,
  listManagerPartnerPayouts,
  listPartnerPayouts,
};
