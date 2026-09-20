// bones.js — «косточки», внутренняя валюта «Тайги» (1 косточка = 1 ₽ при
// оплате). Единая точка входа для начисления/списания — везде, где меняется
// баланс, проходит через эти функции, чтобы customers.bones_balance (кэш для
// быстрого чтения) никогда не разъезжался с историей в bone_transactions.
'use strict';

const db = require('./db');

function getBonesBalance(customerId) {
  const row = db.prepare('SELECT bones_balance FROM customers WHERE id = ?').get(customerId);
  return row ? row.bones_balance : 0;
}

// Начисление — реферальная награда, подарок от «Тайги», возврат при отмене
// заказа и т.п. amount округляется и должен быть положительным.
function awardBones(customerId, amount, type, description, orderId) {
  const rounded = Math.round(amount);
  if (!customerId || !Number.isFinite(rounded) || rounded <= 0) return 0;
  db.prepare('UPDATE customers SET bones_balance = bones_balance + ? WHERE id = ?').run(rounded, customerId);
  db.prepare(`
    INSERT INTO bone_transactions (customer_id, amount, type, description, order_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(customerId, rounded, type, description || null, orderId || null);
  return rounded;
}

// Списание при оплате заказа. Не уводит баланс в минус: если к моменту
// реального списания (подтверждение оплаты) косточек на счету оказалось
// меньше, чем заявляли при оформлении (гонка, повторный заказ и т.п.),
// списывает сколько есть, а не бросает ошибку — деньги уже приняты, откатывать
// платёж из-за этого не нужно. Возвращает фактически списанную сумму.
function spendBones(customerId, amount, orderId, description) {
  const rounded = Math.round(amount);
  if (!customerId || !Number.isFinite(rounded) || rounded <= 0) return 0;
  const balance = getBonesBalance(customerId);
  const actual = Math.min(rounded, balance);
  if (actual <= 0) return 0;
  db.prepare('UPDATE customers SET bones_balance = bones_balance - ? WHERE id = ?').run(actual, customerId);
  db.prepare(`
    INSERT INTO bone_transactions (customer_id, amount, type, description, order_id)
    VALUES (?, ?, 'spend', ?, ?)
  `).run(customerId, -actual, description || 'Оплата заказа косточками', orderId || null);
  return actual;
}

// Возврат косточек, списанных за заказ, который потом отменили/вернули.
function refundBones(customerId, amount, orderId, description) {
  return awardBones(customerId, amount, 'refund', description || 'Возврат косточек за отменённый заказ', orderId);
}

// Сколько косточек реально можно списать с заказа. amountBeforeBones — сумма
// к оплате ПОСЛЕ всех остальных скидок и доставки, но ДО списания косточек.
//
// Ступенчатый лимит по сумме заказа — чем больше корзина, тем больше можно
// списать: до 300₽ — 10%, 300–800₽ — 20%, от 800₽ — 30% (прежний единый
// потолок, теперь только для действительно наполненной корзины). Раньше был
// единый флаг 30% для всех сумм — экономика показала, что на мелких чеках
// (один товар) это уходит в минус после всех комиссий (партнёр + менеджер +
// владелец точки + эквайринг + налог), а на крупных — есть запас. Параметр
// isSelfOrder оставлен в сигнатуре (вызывающий код его передаёт) на случай,
// если понадобится снова развести лимиты по сценариям.
const BONES_SHARE_TIERS = [
  { minAmount: 800, share: 0.30 },
  { minAmount: 300, share: 0.20 },
  { minAmount: 0,   share: 0.10 },
];
function getMaxBonesShare(amountBeforeBones) {
  const tier = BONES_SHARE_TIERS.find((t) => amountBeforeBones >= t.minAmount);
  return tier ? tier.share : 0;
}
function computeMaxUsableBones(balance, amountBeforeBones, isSelfOrder) {
  const maxSpendable = Math.floor(amountBeforeBones * getMaxBonesShare(amountBeforeBones));
  return Math.max(0, Math.min(Math.max(0, balance), maxSpendable));
}

module.exports = { getBonesBalance, awardBones, spendBones, refundBones, computeMaxUsableBones, getMaxBonesShare, BONES_SHARE_TIERS };
