// owner-payouts.js — расчёт невыплаченной комиссии и реестр выплат
// владельцам салонов. Механика совпадает с выплатами грумерам: оплаченный
// заказ попадает ровно в одну выплату.
'use strict';

const db = require('./db');
const {netOrder,isPayable,planCommission,verifyPlan,recordOffsets}=require('./commission-refunds');
const { snapshotPayout } = require('./payout-reports');

function getOwnerUnpaidOrders(ownerId) {
  return db.prepare(`
    SELECT
      o.id,
      o.order_code,
      o.total, o.refund_status, o.refunded_amount,
      o.created_at,
      so.commission_rate
    FROM salon_owners so
    JOIN orders o ON o.point_id = so.point_id
    LEFT JOIN owner_payout_items opi ON opi.order_id = o.id
    WHERE so.id = ?
      AND o.status = 'paid'
      AND opi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(ownerId).map(netOrder);
}

function getOwnerUnpaidSummary(ownerId) {
  const orders = getOwnerUnpaidOrders(ownerId).filter(isPayable);
  const plan=planCommission(db,'owner',ownerId,orders);
  return {
    amount: plan.amount,
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

function createOwnerPayout(ownerId, adminPayload, options = {}) {
  if(!options.inTransaction) db.exec('BEGIN IMMEDIATE');
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

    const pending = getOwnerUnpaidOrders(owner.id).filter(isPayable);
    const orders = options.statementOrders ? require('./payout-statement-orders').selectStatementOrders(db,pending,options.statementOrders) : pending;
    const plan=verifyPlan(planCommission(db,'owner',owner.id,orders),options);
    const amount=plan.amount;
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
    recordOffsets(db,'owner',owner.id,payoutId,plan);
    const payout = db.prepare(payoutSelect('WHERE id = ?')).get(payoutId, 1);
    const report = snapshotPayout(db, 'owner', { ...owner, code: owner.owner_code }, orders, payout, adminPayload.id,plan.adjustments);
    if(!options.inTransaction) db.exec('COMMIT');
    return { ...payout, report_id: report.id };
  } catch (error) {
    try { if(!options.inTransaction) db.exec('ROLLBACK'); } catch (_) { /* сохраняем исходную ошибку */ }
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
