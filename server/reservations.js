// reservations.js — атомарный резерв товара и косточек на время оплаты.
// Физический доступный остаток уменьшается при создании платежа, а не после
// вебхука. При успехе резерв только фиксируется как consumed; при отмене
// товар и косточки возвращаются ровно один раз.
'use strict';

const db = require('./db');
const { reserveBones, consumeReservedBones, releaseReservedBones } = require('./bones');

const DEFAULT_TTL_MINUTES = 15;
const configuredTtl = Number(process.env.RESERVATION_TTL_MINUTES);
const RESERVATION_TTL_MINUTES = Number.isFinite(configuredTtl)
  ? Math.max(5, Math.min(30, Math.round(configuredTtl)))
  : DEFAULT_TTL_MINUTES;

function reservationError(message, code, statusCode = 409, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function sqliteDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function newReservationExpiry() {
  return sqliteDateTime(new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000));
}

function withImmediateTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* исходная ошибка важнее */ }
    throw error;
  }
}

function resolveInventorySource({ fulfillmentType, pointId, needsDelivery, cityId }) {
  if (fulfillmentType === 'home_delivery') {
    const city = cityId && db.prepare('SELECT id FROM cities WHERE id = ? AND active = 1').get(cityId);
    if (!city) {
      throw reservationError('Выберите город доставки и попробуйте снова', 'DELIVERY_CITY_REQUIRED', 400);
    }
    return { type: 'warehouse', id: city.id };
  }

  if (!pointId) {
    throw reservationError('Для оплаты выберите минимаркет из списка', 'POINT_REQUIRED', 400);
  }
  const point = db.prepare('SELECT id, city_id FROM points WHERE id = ? AND active = 1').get(pointId);
  if (!point) {
    throw reservationError('Выбранная точка не найдена или временно не работает', 'POINT_UNAVAILABLE', 400);
  }
  return needsDelivery
    ? { type: 'warehouse', id: point.city_id }
    : { type: 'point', id: point.id };
}

function reserveInventory(source, items) {
  const reservePoint = db.prepare(`
    UPDATE stock SET qty = qty - ?
    WHERE point_id = ? AND variant_id = ? AND qty >= ?
  `);
  const reserveWarehouse = db.prepare(`
    UPDATE warehouse_stock SET qty = qty - ?
    WHERE city_id = ? AND variant_id = ? AND qty >= ?
  `);

  for (const item of items) {
    const stmt = source.type === 'point' ? reservePoint : reserveWarehouse;
    const result = stmt.run(item.qty, source.id, item.variantId, item.qty);
    if (result.changes !== 1) {
      throw reservationError(
        `«${item.name} (${item.weight})» уже закончился или нужного количества нет. Выберите другую точку или уменьшите количество.`,
        'STOCK_UNAVAILABLE',
        409,
        { variantId: item.variantId, requestedQty: item.qty }
      );
    }
  }
}

function restoreInventory(sourceType, sourceId, items) {
  if (!sourceType || !sourceId) return 0;
  const restorePoint = db.prepare(`
    INSERT INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(variant_id, point_id) DO UPDATE SET qty = qty + excluded.qty
  `);
  const restoreWarehouse = db.prepare(`
    INSERT INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)
    ON CONFLICT(city_id, variant_id) DO UPDATE SET qty = qty + excluded.qty
  `);
  let restored = 0;
  for (const item of items) {
    let variantId = item.variant_id || item.variantId;
    if (!variantId && item.name && item.weight) {
      const legacy = db.prepare(`
        SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.name = ? AND v.weight = ?
      `).get(item.name, item.weight);
      variantId = legacy && legacy.id;
    }
    if (!variantId || item.is_custom) continue;
    if (sourceType === 'point') restorePoint.run(variantId, sourceId, item.qty);
    else if (sourceType === 'warehouse') restoreWarehouse.run(sourceId, variantId, item.qty);
    else continue;
    restored++;
  }
  return restored;
}

// Вызывается внутри уже открытой транзакции сразу после вставки заказа/items.
function reserveForOrder(orderId, source, items, bonesCustomerId, bonesAmount) {
  reserveInventory(source, items);
  if (bonesAmount > 0) {
    const reserved = reserveBones(bonesCustomerId, bonesAmount, orderId, 'Резерв косточек на время оплаты');
    if (reserved !== bonesAmount) {
      throw reservationError('Баланс косточек изменился. Обновите страницу и попробуйте снова.', 'BONES_UNAVAILABLE', 409);
    }
  }
}

// Вариант без собственной BEGIN/COMMIT — только для вызывающего кода, который
// уже открыл транзакцию. Нужен, например, при атомарном удалении заказа:
// SQLite не допускает BEGIN внутри другой активной транзакции.
function releaseOrderReservationInTransaction(orderId, nextOrderStatus = 'failed', reason = 'Оплата отменена или время резерва истекло') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.reservation_status !== 'active') return { released: false, order };
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND is_custom = 0').all(order.id);
  restoreInventory(order.inventory_source_type, order.inventory_source_id, items);
  releaseReservedBones(order.id, reason);
  db.prepare(`
    UPDATE orders SET reservation_status = 'released',
      status = CASE WHEN ? IS NULL THEN status ELSE ? END
    WHERE id = ? AND reservation_status = 'active'
  `).run(nextOrderStatus, nextOrderStatus, order.id);
  return { released: true, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), items };
}

function releaseOrderReservation(orderId, nextOrderStatus = 'failed', reason = 'Оплата отменена или время резерва истекло') {
  return withImmediateTransaction(() =>
    releaseOrderReservationInTransaction(orderId, nextOrderStatus, reason)
  );
}

function consumeOrderReservation(orderId) {
  return withImmediateTransaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || order.reservation_status !== 'active') return { consumed: false, order };
    consumeReservedBones(order.id, 'Оплата заказа ' + order.order_code);
    db.prepare(`
      UPDATE orders SET reservation_status = 'consumed', status = 'paid'
      WHERE id = ? AND reservation_status = 'active'
    `).run(order.id);
    return {
      consumed: true,
      order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id),
      items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id),
    };
  });
}

function listExpiredActiveReservations() {
  return db.prepare(`
    SELECT * FROM orders
    WHERE status = 'pending' AND reservation_status = 'active'
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at <= datetime('now')
    ORDER BY id ASC
  `).all();
}

// Возврат оплаченного товара на исходное место хранения. Для новых заказов
// источник зафиксирован в заказе; старые заказы продолжают восстанавливаться
// на точку по прежнему правилу.
function restorePaidOrderInventory(order, items) {
  const sourceType = order.inventory_source_type || (order.point_id ? 'point' : null);
  const sourceId = order.inventory_source_id || order.point_id;
  if (!sourceType || !sourceId) return 0;
  return restoreInventory(sourceType, sourceId, items);
}

module.exports = {
  RESERVATION_TTL_MINUTES,
  newReservationExpiry,
  withImmediateTransaction,
  resolveInventorySource,
  reserveForOrder,
  releaseOrderReservation,
  releaseOrderReservationInTransaction,
  consumeOrderReservation,
  listExpiredActiveReservations,
  restorePaidOrderInventory,
};
