// owner-payouts.js — расчёт невыплаченной комиссии и реестр выплат
// владельцам салонов. Механика совпадает с выплатами грумерам: оплаченный
// заказ попадает ровно в одну выплату.
'use strict';

const db = require('./db');

function getOwnerUnpaidOrders(ownerId) {
  return db.prepare(`
    SELECT
      o.id,
      o.order_code,
      o.total,
      so.commission_rate
    FROM salon_owners so
    JOIN orders o ON o.point_id = so.point_id
    LEFT JOIN owner_payout_items opi ON opi.order_id = o.id
    WHERE so.id = ?
      AND o.status = 'paid'
      AND opi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(ownerId).map((order) => ({
    ...order,
    commission_amount: Math.round(Number(order.total || 0) * Number(order.commission_rate || 0)),
  }));
}

function getOwnerUnpaidSummary(ownerId) {
  const orders = getOwnerUnpaidOrders(ownerId);
  return {
    amount: orders.reduce((sum, order) => sum + order.commission_amount, 0),
    orders_count: orders.length,
  };
}

function payoutSelect(whereClause) {
  return `
    SELECT
      id, owner_id, owner_name, owner_code, point_id, point_name,
      amount, orders_count, paid_by_admin_id, paid_by_admin_login, paid_at
    FROM owner_payouts
    ${whereClause}
    ORDER BY paid_at DESC, id DESC
    LIMIT ?
  `;
}

function listOwnerPayouts(ownerId, limit = 100) {
  return db.prepare(payoutSelect('WHERE owner_id = ?')).all(ownerId, limit);
}

function listAllOwnerPayouts(limit = 100) {
  return db.prepare(payoutSelect('')).all(limit);
}

function createOwnerPayout(ownerId, adminPayload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare(`
      SELECT so.id, so.full_name, so.owner_code, so.point_id, p.name AS point_name
      FROM salon_owners so
      LEFT JOIN points p ON p.id = so.point_id
      WHERE so.id = ?
    `).get(ownerId);
    if (!owner) {
      const error = new Error('Владелец салона не найден');
      error.code = 'OWNER_NOT_FOUND';
      throw error;
    }

    const orders = getOwnerUnpaidOrders(owner.id);
    const amount = orders.reduce((sum, order) => sum + order.commission_amount, 0);
    if (!orders.length || amount <= 0) {
      const error = new Error('У владельца сейчас нет невыплаченного вознаграждения');
      error.code = 'NOTHING_TO_PAY';
      throw error;
    }

    const payoutInfo = db.prepare(`
      INSERT INTO owner_payouts
        (owner_id, owner_name, owner_code, point_id, point_name,
         amount, orders_count, paid_by_admin_id, paid_by_admin_login)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      owner.id,
      owner.full_name,
      owner.owner_code || null,
      owner.point_id || null,
      owner.point_name || null,
      amount,
      orders.length,
      adminPayload.id || null,
      adminPayload.login || null
    );
    const payoutId = Number(payoutInfo.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO owner_payout_items
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
  createOwnerPayout,
  getOwnerUnpaidOrders,
  getOwnerUnpaidSummary,
  listAllOwnerPayouts,
  listOwnerPayouts,
};
