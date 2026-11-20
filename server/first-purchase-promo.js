'use strict';

const db = require('./db');
const { PAID_PHONE_KEY_SQL } = require('./report-phone-key');

const {
  getFirstPurchasePromoPolicy,
  lookupStoredFirstPurchasePromoCode,
  firstPurchasePromoNotice,
} = require('./first-purchase-promo-policy');

function normalizePromoCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizePromoPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : '';
}

function hasPaidOrderForPhone(phone) {
  const normalized = normalizePromoPhone(phone);
  if (!normalized) return false;
  // Reuse the existing partial, indexed phone key. Never download the entire
  // paid-order history into JS just to approve a discount.
  return !!db.prepare(
    "SELECT 1 FROM orders WHERE status='paid' AND " + PAID_PHONE_KEY_SQL + " = ? LIMIT 1"
  ).get(normalized);
}

// The claim is a TEMPORARY hold, not proof of a purchase. A payment that has
// been conclusively canceled, failed and released must never burn a discount.
// Do not clear active/pending claims: the bank might still confirm payment.
const CLAIM_TABLES = ['first_purchase_promo_claims', 'first_purchase_point_promo_claims'];
function hasUnsettledPromoClaim(phone) {
  for (const table of CLAIM_TABLES) {
    const claim = db.prepare('SELECT order_id FROM ' + table + ' WHERE phone=?').get(phone);
    if (!claim) continue;
    const order = db.prepare('SELECT status,reservation_status FROM orders WHERE id=?').get(claim.order_id);
    const inactive = !order ||
      (order.status !== 'paid' && order.reservation_status === 'released') ||
      ((order.status === 'failed' || order.status === 'cancelled' ||
        order.status === 'canceled') && order.reservation_status !== 'active');
    if (inactive) {
      // Self-heal claims from earlier deployments where a reservation was
      // released by an admin/cleanup route without deleting the promo hold.
      db.prepare('DELETE FROM ' + table + ' WHERE phone=? AND order_id=?')
        .run(phone, claim.order_id);
      continue;
    }
    return true;
  }
  return false;
}

function validateFirstPurchasePromo(code, phone, pointId = null, now = Date.now()) {
  const promoCode = normalizePromoCode(code);
  // Read-only alias: after 1 December both HV20 and HV15 point/partner codes
  // resolve to the same original code stored in SQLite. Old QR labels survive.
  const storedCode = lookupStoredFirstPurchasePromoCode(promoCode, now);
  const policy = getFirstPurchasePromoPolicy(now);
  const normalizedPhone = normalizePromoPhone(phone);
  if (!promoCode) return { valid: false, error: 'Введите промокод на первую покупку' };
  if (!normalizedPhone) return { valid: false, error: 'Сначала укажите корректный номер телефона' };

  const point = db.prepare('SELECT id, name, first_purchase_promo_code FROM points WHERE UPPER(first_purchase_promo_code) = ? AND active = 1').get(storedCode);
  const alias = point ? null : db.prepare('SELECT p.id, p.name, p.first_purchase_promo_code FROM first_purchase_point_promo_aliases a JOIN points p ON p.id=a.point_id WHERE UPPER(a.promo_code)=? AND p.active=1').get(storedCode);
  const salon = point || alias;
  const partner = salon ? null : db.prepare(`
    SELECT id, full_name, first_purchase_promo_code
    FROM partners
    WHERE UPPER(first_purchase_promo_code) = ? AND active = 1
  `).get(storedCode);
  if (!salon && !partner) return { valid: false, error: 'Промокод не найден или неактивен' };
  if (salon && (!pointId || String(salon.id) !== String(pointId))) return { valid: false, error: 'Промокод действует при покупке в указанном салоне' };
  if (hasPaidOrderForPhone(normalizedPhone)) {
    return { valid: false, error: 'Скидка действует только на первую покупку по этому номеру телефона' };
  }
  if (hasUnsettledPromoClaim(normalizedPhone)) return { valid: false, error: 'Промокод для этого номера уже использован или ожидает оплаты' };

  return {
    valid: true,
    // Keep exactly the code the buyer entered, not a hidden rewrite.
    promoCode,
    partnerId: partner ? partner.id : null,
    partnerName: partner ? partner.full_name : null,
    pointId: salon ? salon.id : null,
    pointName: salon ? salon.name : null,
    discountPercent: policy.discountPercent,
    notice: firstPurchasePromoNotice(promoCode, now),
    normalizedPhone,
  };
}

function claimFirstPurchasePromo(validation, orderId) {
  if (!validation || !validation.valid) return;
  if (hasPaidOrderForPhone(validation.normalizedPhone)) {
    const error = new Error('Скидка действует только на первую покупку по этому номеру телефона');
    error.statusCode = 409;
    error.code = 'FIRST_PURCHASE_PROMO_ALREADY_USED';
    throw error;
  }
  if (hasUnsettledPromoClaim(validation.normalizedPhone)) {
    const error = new Error('Промокод для этого номера уже использован или ожидает оплаты');
    error.statusCode = 409; error.code = 'FIRST_PURCHASE_PROMO_ALREADY_USED'; throw error;
  }
  try {
    if (validation.pointId) {
      db.prepare('INSERT INTO first_purchase_point_promo_claims (phone, point_id, promo_code, order_id) VALUES (?, ?, ?, ?)')
        .run(validation.normalizedPhone, validation.pointId, validation.promoCode, orderId);
      return;
    }
    db.prepare(`
      INSERT INTO first_purchase_promo_claims (phone, partner_id, promo_code, order_id)
      VALUES (?, ?, ?, ?)
    `).run(validation.normalizedPhone, validation.partnerId, validation.promoCode, orderId);
  } catch (cause) {
    const error = new Error('Промокод для этого номера уже использован или ожидает оплаты');
    error.statusCode = 409;
    error.code = 'FIRST_PURCHASE_PROMO_ALREADY_USED';
    error.cause = cause;
    throw error;
  }
}

function releaseFirstPurchasePromoClaim(orderId) {
  db.prepare('DELETE FROM first_purchase_promo_claims WHERE order_id = ?').run(orderId);
  db.prepare('DELETE FROM first_purchase_point_promo_claims WHERE order_id = ?').run(orderId);
}

module.exports = {
  getFirstPurchasePromoPolicy,
  normalizePromoCode,
  normalizePromoPhone,
  validateFirstPurchasePromo,
  claimFirstPurchasePromo,
  releaseFirstPurchasePromoClaim,
};
