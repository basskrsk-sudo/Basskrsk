// reservations.js — атомарный резерв товара и косточек на время оплаты.
// Физический доступный остаток уменьшается при создании платежа, а не после
// вебхука. При успехе резерв только фиксируется как consumed; при отмене
// товар и косточки возвращаются ровно один раз.
'use strict';

const db = require('./db');
const { releaseFirstPurchasePromoClaim } = require('./first-purchase-promo');
const { EXPIRED_RESERVATIONS_BATCH_SQL } = require('./reservation-cleanup-query');
const { reserveBones, consumeReservedBones, releaseReservedBones } = require('./bones');

// Explicit one-minute policy for QR checkout. Ignore old Amvera
// RESERVATION_TTL_MINUTES=15 overrides so deploys cannot silently retain
// the previous lock time. A payment must still be confirmed cancelled before
// returning its stock to sale.
const RESERVATION_TTL_MINUTES = 1;

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

function reserveInventory(source, items, orderId, confirmation) {
  const reservePoint = db.prepare(`
    UPDATE stock SET qty = qty - ?
    WHERE point_id = ? AND variant_id = ? AND qty >= ?
  `);
  const reserveWarehouse = db.prepare(`
    UPDATE warehouse_stock SET qty = qty - ?
    WHERE city_id = ? AND variant_id = ? AND qty >= ?
  `);

  const shortages=[];
  // Fast path: same conditional stock decrement as before, no extra read.
  for (const item of items) {
    const stmt = source.type === 'point' ? reservePoint : reserveWarehouse;
    const result = stmt.run(item.qty, source.id, item.variantId, item.qty);
    if (result.changes === 1) continue;
    if(source.type!=='point'){
      throw reservationError(
        '«'+item.name+' ('+item.weight+')» уже закончился или нужного количества нет. Уменьшите количество.',
        'STOCK_UNAVAILABLE',409,{variantId:item.variantId,requestedQty:item.qty});
    }
    const available=Number(db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?')
      .get(source.id,item.variantId)?.qty??0);
    if(!Number.isSafeInteger(available)||available<0)
      throw reservationError('Остаток требует проверки сотрудником. Попробуйте другой товар.','STOCK_UNAVAILABLE');
    // Do not treat units already reserved by a different customer as a stock
    // discrepancy. This also serializes concurrent shortage confirmations.
    const competing=db.prepare("SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id "+
      "WHERE o.point_id=? AND o.id<>? AND o.status='pending' AND o.reservation_status='active' "+
      "AND o.inventory_source_type='point' AND o.inventory_source_id=? AND i.variant_id=? LIMIT 1")
      .get(source.id,orderId,source.id,item.variantId);
    if(competing)throw reservationError('Этот товар сейчас зарезервирован другой покупкой. Повторите через несколько минут или измените корзину.',
      'STOCK_UNAVAILABLE',409,{variantId:item.variantId,requestedQty:item.qty});
    shortages.push({variantId:item.variantId,name:item.name,weight:item.weight,requestedQty:item.qty,availableQty:available});
  }
  if(!shortages.length)return;
  // Confirmation is scoped to the selected physical point and exact
  // purchased quantities. Client cannot choose how many units to add.
  const approved=new Map();
  if(confirmation&&confirmation.pointId===source.id&&Array.isArray(confirmation.items)&&confirmation.items.length<=50){
    for(const entry of confirmation.items){
      if(entry&&Number.isSafeInteger(entry.variantId)&&Number.isSafeInteger(entry.qty)&&entry.qty>0&&entry.qty<=99)
        approved.set(entry.variantId,entry.qty);
    }
  }
  if(shortages.some(item=>approved.get(item.variantId)!==item.requestedQty)){
    throw reservationError('По учёту товара недостаточно. Подтвердите, что все указанные упаковки действительно у вас на руках.',
      'STOCK_CONFIRMATION_REQUIRED',409,{pointId:source.id,items:shortages});
  }
  const mark=db.prepare('UPDATE order_items SET physical_stock_added_qty=? WHERE order_id=? AND variant_id=? AND is_custom=0');
  for(const item of shortages){
    const missing=item.requestedQty-item.availableQty;
    if(item.availableQty>0&&reservePoint.run(item.availableQty,source.id,item.variantId,item.availableQty).changes!==1)
      throw Error('Physical stock changed inside reservation transaction');
    // Only the actual recorded stock is reserved now. The customer-confirmed
    // shortfall is a pending adjustment, not available inventory.
    if(mark.run(missing,orderId,item.variantId).changes!==1)
      throw Error('Cannot mark confirmed stock adjustment');
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
function reserveForOrder(orderId, source, items, bonesCustomerId, bonesAmount, physicalStockConfirmation) {
  reserveInventory(source, items, orderId, physicalStockConfirmation);
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
  if (!order || order.reservation_status !== 'active' || order.status === 'paid') return { released: false, order };
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND is_custom = 0').all(order.id);
  // A cancelled, unpaid order must not manufacture new available stock.
  const recordedItems=items.map(item=>({...item,qty:item.qty-Number(item.physical_stock_added_qty||0)})).filter(item=>item.qty>0);
  restoreInventory(order.inventory_source_type, order.inventory_source_id, recordedItems);
  releaseReservedBones(order.id, reason);
  db.prepare(`
    UPDATE orders SET reservation_status = 'released',
      status = CASE WHEN ? IS NULL THEN status ELSE ? END
    WHERE id = ? AND reservation_status = 'active'
  `).run(nextOrderStatus, nextOrderStatus, order.id);
  // Stock and promotional eligibility are released in the SAME transaction,
  // regardless of which cancellation/admin route called this function.
  releaseFirstPurchasePromoClaim(order.id);
  return { released: true, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), items };
}

function releaseOrderReservation(orderId, nextOrderStatus = 'failed', reason = 'Оплата отменена или время резерва истекло') {
  return withImmediateTransaction(() =>
    releaseOrderReservationInTransaction(orderId, nextOrderStatus, reason)
  );
}

function consumeOrderReservation(orderId, {onPaid}={}) {
  return withImmediateTransaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || order.reservation_status !== 'active') return { consumed: false, order };
    const items=db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    // The physically observed missing units are received and immediately
    // consumed only once, together with the verified paid transition.
    // No warehouse transfer is fabricated. The order line keeps the audit.
    if(order.inventory_source_type==='point'&&order.inventory_source_id){
      const adjusted=items.filter(item=>Number(item.physical_stock_added_qty)>0);
      if(adjusted.length){
        const receive=db.prepare("INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?) "+
          "ON CONFLICT(variant_id,point_id) DO UPDATE SET qty=qty+excluded.qty");
        const deduct=db.prepare("UPDATE stock SET qty=qty-? WHERE variant_id=? AND point_id=?");
        for(const item of adjusted){
          const qty=Number(item.physical_stock_added_qty);
          if(!Number.isSafeInteger(qty)||qty<1||qty>item.qty||!item.variant_id||item.is_custom)
            throw Error('Invalid confirmed stock adjustment');
          receive.run(item.variant_id,order.inventory_source_id,qty);
          if(deduct.run(qty,item.variant_id,order.inventory_source_id).changes!==1)
            throw Error('Cannot consume confirmed stock adjustment');
        }
      }
    }
    consumeReservedBones(order.id, 'Оплата заказа ' + order.order_code);
    db.prepare(`
      UPDATE orders SET reservation_status = 'consumed', status = 'paid'
      WHERE id = ? AND reservation_status = 'active'
    `).run(order.id);
    const paidOrder=db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const afterPaid=typeof onPaid==='function'?onPaid(paidOrder):false;
    return {
      consumed: true,
      order: paidOrder,
      items,
      afterPaid,
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

// Paginate overdue reservations rather than rechecking the entire old backlog
// every minute. Only fields required by the payment reconciliation are read.
function listExpiredActiveReservationsBatch(afterId = 0, limit = 8) {
  const cursor = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
  const size = Number.isSafeInteger(limit) ? Math.max(1, Math.min(20, limit)) : 8;
  return db.prepare(EXPIRED_RESERVATIONS_BATCH_SQL).all(cursor, size);
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
  listExpiredActiveReservationsBatch,
  restorePaidOrderInventory,
};
