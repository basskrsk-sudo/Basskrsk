// order-reversal.js — общая логика отката последствий оплаченного заказа:
// статистика клиента, косточки (начисленные и списанные), опционально
// остаток на точке. Используется при принудительном удалении самого заказа
// (routes-orders.js), а также при принудительном удалении точки или партнёра,
// у которых есть привязанные оплаченные заказы (routes-products.js,
// routes-partners.js) — в этом случае сначала откатываются и удаляются все
// их заказы, а уже потом сама точка/партнёр.
'use strict';

const db = require('./db');
const { releaseOrderReservation, restorePaidOrderInventory } = require('./reservations');

function reverseOrderSideEffects(order, restoreStock) {
  // Если заказ уже был возвращён через /refund — статистика клиента,
  // остаток (если галочка стояла) и косточки уже откатились ОДИН раз именно
  // там. Применить всё это ещё раз при последующем удалении того же заказа
  // означало бы задвоить возврат: товар прибавился бы на точку дважды,
  // счётчики клиента откатились бы дважды. Просто ничего больше не трогаем —
  // сам заказ всё равно будет удалён вызывающим кодом.
  if (order.refund_status === 'refunded') return;

  const custPhone = order.customer_phone.replace(/\D/g, '');
  const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(custPhone);
  if (customer) {
    db.prepare('UPDATE customers SET orders_count = MAX(0, orders_count - 1), total_spent = MAX(0, total_spent - ?) WHERE id = ?')
      .run(order.total, customer.id);
  }
  if (order.bones_used > 0 && customer) {
    const { refundBones } = require('./bones');
    refundBones(customer.id, order.bones_used, order.id, 'Удаление заказа ' + order.order_code + ' — возврат списанных косточек');
  }
  if (restoreStock) {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND is_custom = 0').all(order.id);
    restorePaidOrderInventory(order, items);
  }
}

// Откатывает и удаляет ВСЕ заказы, привязанные к точке или партнёру —
// используется при принудительном удалении самой точки/партнёра, чтобы не
// оставлять заказы висеть на уже несуществующей точке.
function reverseAndDeleteOrdersBy(column, value, restoreStock) {
  const orders = db.prepare(`SELECT * FROM orders WHERE ${column} = ?`).all(value);
  let reversedPaid = 0;
  for (const order of orders) {
    if (order.status === 'paid') {
      reverseOrderSideEffects(order, restoreStock);
      reversedPaid++;
    } else if (order.reservation_status === 'active') {
      releaseOrderReservation(order.id, null, 'Связанный объект удалён — резерв освобождён');
    }
  }
  const info = db.prepare(`DELETE FROM orders WHERE ${column} = ?`).run(value);
  return { reversedPaid, deletedTotal: info.changes };
}

module.exports = { reverseOrderSideEffects, reverseAndDeleteOrdersBy };
