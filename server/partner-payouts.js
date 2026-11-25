// partner-payouts.js — расчёт невыплаченной комиссии и реестр выплат грумерам.
'use strict';

const db = require('./db');
const {netOrder,isPayable,planCommission,verifyPlan,recordOffsets}=require('./commission-refunds');
const { snapshotPayout } = require('./payout-reports');
const {parseActualPayoutMethod}=require('./payout-methods');

function getUnpaidOrders(partnerId) {
  return db.prepare(`
    SELECT
      o.id,
      o.order_code,
      o.total, o.refund_status, o.refunded_amount,
      o.created_at,
      COALESCE(o.commission_rate, p.commission_rate, 0) AS commission_rate
    FROM orders o
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN partner_payout_items pi ON pi.order_id = o.id
    WHERE o.partner_id = ?
      AND o.status = 'paid'
      AND pi.id IS NULL
    ORDER BY o.created_at, o.id
  `).all(partnerId).map(netOrder);
}

function getUnpaidSummary(partnerId) {
  const orders = getUnpaidOrders(partnerId).filter(isPayable);
  const plan=planCommission(db,'partner',partnerId,orders);
  return {
    amount: plan.amount,
    orders_count: orders.length,
  };
}

function payoutSelect(whereClause) {
  return `
    SELECT
      id, partner_id, partner_name, partner_code,
      manager_id, manager_name, amount, orders_count,
      paid_by_admin_id, paid_by_admin_login, paid_at, payout_method
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

function createPartnerPayout(partnerId, adminPayload, options = {}) {
  if(!options.inTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const partner = db.prepare(`
      SELECT
        p.id, p.full_name, p.partner_code, p.inn, pt.name AS point_name,
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

    const pending = getUnpaidOrders(partner.id).filter(isPayable);
    const orders = options.statementOrders ? require('./payout-statement-orders').selectStatementOrders(db,pending,options.statementOrders) : pending;
    const plan=verifyPlan(planCommission(db,'partner',partner.id,orders),options);
    const amount=plan.amount;
    if (!orders.length || amount <= 0) {
      const error = new Error('У партнёра нет невыплаченного вознаграждения');
      error.code = 'NOTHING_TO_PAY';
      throw error;
    }

    const payoutInfo = db.prepare(`
      INSERT INTO partner_payouts
        (partner_id, partner_name, partner_code, manager_id, manager_name,
         amount, orders_count, paid_by_admin_id, paid_by_admin_login,payout_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      partner.id,
      partner.full_name,
      partner.partner_code || null,
      partner.manager_id || null,
      partner.manager_name || null,
      amount,
      orders.length,
      adminPayload.id || null,
      adminPayload.login || null,
      parseActualPayoutMethod(options.payout_method)
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
    recordOffsets(db,'partner',partner.id,payoutId,plan);
    const payout = db.prepare(payoutSelect('WHERE id = ?')).get(payoutId, 1);
    const report = snapshotPayout(db, 'partner', { ...partner, code: partner.partner_code }, orders, payout, adminPayload.id,plan.adjustments);
    if(!options.inTransaction) db.exec('COMMIT');
    return { ...payout, report_id: report.id };
  } catch (error) {
    try { if(!options.inTransaction) db.exec('ROLLBACK'); } catch (_) { /* сохраняем исходную ошибку */ }
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
