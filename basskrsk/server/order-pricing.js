// order-pricing.js — единственный источник истины для состава и суммы заказа.
// Браузер передаёт выбранные variantId и количество, но никогда не определяет
// цену, название, вес, доставку или итог к оплате: всё это повторно считается
// здесь по актуальным данным базы непосредственно перед созданием платежа.
'use strict';

const db = require('./db');

const HOME_DELIVERY_FEE = 300;
const FREE_DELIVERY_THRESHOLD = 2000;
const MAX_CART_LINES = 50;
const MAX_ITEM_QTY = 99;
const MAX_ORDER_TOTAL = 1_000_000;

function pricingError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function resolveVariant(item) {
  const rawId = item && (item.variantId ?? item.variant_id);
  const variantId = Number(rawId);
  if (Number.isInteger(variantId) && variantId > 0) {
    return db.prepare(`
      SELECT v.id AS variant_id, v.product_id, v.weight, v.price,
             p.name, p.active AS product_active, v.active AS variant_active
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ?
    `).get(variantId);
  }

  // Совместимость с уже открытыми/закэшированными страницами старой версии:
  // они ещё могут прислать name+weight. Цена из такого запроса всё равно
  // игнорируется — вариант находится в базе, и берётся только серверная цена.
  if (item && item.name && item.weight) {
    const rows = db.prepare(`
      SELECT v.id AS variant_id, v.product_id, v.weight, v.price,
             p.name, p.active AS product_active, v.active AS variant_active
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.name = ? AND v.weight = ?
    `).all(String(item.name), String(item.weight));
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      throw pricingError('Не удалось однозначно определить фасовку товара. Обновите страницу и соберите корзину заново.', 'AMBIGUOUS_VARIANT', 409);
    }
  }
  return null;
}

function priceCatalogCart(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw pricingError('Корзина пуста', 'EMPTY_CART');
  }
  if (cartItems.length > MAX_CART_LINES) {
    throw pricingError('В корзине слишком много разных позиций', 'TOO_MANY_LINES');
  }

  const merged = new Map();
  for (const item of cartItems) {
    if (item && (item.isCustom || item.is_custom)) {
      throw pricingError('Товары не из каталога нельзя оплатить автоматически. Оставьте заявку через раздел «Хочу такое».', 'CUSTOM_ITEM_NOT_ALLOWED');
    }
    const qty = Number(item && item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QTY) {
      throw pricingError(`Количество каждой позиции должно быть от 1 до ${MAX_ITEM_QTY}`, 'INVALID_QUANTITY');
    }
    const variant = resolveVariant(item);
    if (!variant) throw pricingError('Один из товаров не найден. Обновите каталог и соберите корзину заново.', 'VARIANT_NOT_FOUND', 409);
    if (!variant.product_active || !variant.variant_active) {
      throw pricingError(`«${variant.name} (${variant.weight})» больше не продаётся`, 'VARIANT_INACTIVE', 409);
    }
    if (!Number.isInteger(variant.price) || variant.price <= 0) {
      throw pricingError(`Для «${variant.name} (${variant.weight})» не задана корректная цена`, 'INVALID_CATALOG_PRICE', 409);
    }
    const existing = merged.get(variant.variant_id);
    const mergedQty = (existing ? existing.qty : 0) + qty;
    if (mergedQty > MAX_ITEM_QTY) {
      throw pricingError(`Количество «${variant.name} (${variant.weight})» не может быть больше ${MAX_ITEM_QTY}`, 'INVALID_QUANTITY');
    }
    merged.set(variant.variant_id, {
      variantId: variant.variant_id,
      productId: variant.product_id,
      name: variant.name,
      weight: variant.weight,
      price: variant.price,
      qty: mergedQty,
      isCustom: false,
    });
  }

  const items = [...merged.values()];
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0 || subtotal > MAX_ORDER_TOTAL) {
    throw pricingError('Некорректная сумма заказа', 'INVALID_ORDER_TOTAL');
  }
  return { items, subtotal };
}

function calculateDeliveryFee(fulfillmentType, subtotal) {
  if (fulfillmentType !== 'home_delivery') return 0;
  return subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : HOME_DELIVERY_FEE;
}

// Распределяет итоговую сумму товаров по строкам и единицам с точностью до
// копейки. Если из-за скидки цена единиц одной строки отличается на копейку,
// строка делится максимум на две записи — сумма фискального чека сходится
// с суммой платежа ровно, а quantity остаётся корректным.
function buildReceiptItems(items, adjustedGoodsTotal, adjustedDeliveryFee) {
  const targetCents = Math.round(adjustedGoodsTotal * 100);
  const baseCents = items.map((item) => item.price * item.qty * 100);
  const baseTotal = baseCents.reduce((sum, value) => sum + value, 0);
  const exact = baseCents.map((value) => baseTotal > 0 ? value * targetCents / baseTotal : 0);
  const lineCents = exact.map(Math.floor);
  let remainder = targetCents - lineCents.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remainder; i++) lineCents[remainderOrder[i % remainderOrder.length].index]++;

  const receipt = [];
  items.forEach((item, index) => {
    const total = lineCents[index];
    const low = Math.floor(total / item.qty);
    const highCount = total - low * item.qty;
    const addGroup = (unitCents, quantity) => {
      if (quantity <= 0 || unitCents <= 0) return;
      receipt.push({
        description: `${item.name} (${item.weight})`.slice(0, 128),
        amount: { value: (unitCents / 100).toFixed(2), currency: 'RUB' },
        vat_code: 1,
        quantity: String(quantity),
        payment_subject: 'commodity',
        payment_mode: 'full_payment',
      });
    };
    addGroup(low + 1, highCount);
    addGroup(low, item.qty - highCount);
  });

  if (adjustedDeliveryFee > 0) {
    receipt.push({
      description: 'Доставка',
      amount: { value: adjustedDeliveryFee.toFixed(2), currency: 'RUB' },
      vat_code: 1,
      quantity: '1',
      payment_subject: 'service',
      payment_mode: 'full_payment',
    });
  }
  return receipt;
}

module.exports = {
  priceCatalogCart,
  calculateDeliveryFee,
  buildReceiptItems,
  HOME_DELIVERY_FEE,
  FREE_DELIVERY_THRESHOLD,
};
