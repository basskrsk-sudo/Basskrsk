'use strict';

const db = require('./db');

const FIRST_PURCHASE_DISCOUNT_PERCENT = 20;

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
  const rows = db.prepare("SELECT customer_phone FROM orders WHERE status = 'paid'").all();
  return rows.some((row) => normalizePromoPhone(row.customer_phone) === normalized);
}

function validateFirstPurchasePromo(code, phone) {
  const promoCode = normalizePromoCode(code);
  const normalizedPhone = normalizePromoPhone(phone);
  if (!promoCode) return { valid: false, error: 'Введите промокод грумера' };
  if (!normalizedPhone) return { valid: false, error: 'Сначала укажите корректный номер телефона' };

  const partner = db.prepare(`
    SELECT id, full_name, first_purchase_promo_code
    FROM partners
    WHERE UPPER(first_purchase_promo_code) = ? AND active = 1
  `).get(promoCode);
  if (!partner) return { valid: false, error: 'Промокод не найден или неактивен' };
  if (hasPaidOrderForPhone(normalizedPhone)) {
    return { valid: false, error: 'Скидка действует только на первую покупку по этому номеру телефона' };
  }
  const claim = db.prepare('SELECT order_id FROM first_purchase_promo_claims WHERE phone = ?').get(normalizedPhone);
  if (claim) return { valid: false, error: 'Промокод для этого номера уже использован или ожидает оплаты' };

  return {
    valid: true,
    promoCode: partner.first_purchase_promo_code,
    partnerId: partner.id,
    partnerName: partner.full_name,
    discountPercent: FIRST_PURCHASE_DISCOUNT_PERCENT,
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
  try {
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
}

module.exports = {
  FIRST_PURCHASE_DISCOUNT_PERCENT,
  normalizePromoCode,
  normalizePromoPhone,
  validateFirstPurchasePromo,
  claimFirstPurchasePromo,
  releaseFirstPurchasePromoClaim,
};
