// routes-orders.js — просмотр заказов для админки.
// Создание заказов теперь происходит только через routes-payment.js:
// сначала /api/create-payment (status='pending'), затем вебхук ЮKassa
// подтверждает оплату и переводит заказ в 'paid'. Прямого способа
// создать "оплаченный" заказ в обход реальной оплаты больше нет —
// это было осознанно убрано при переходе на серверную проверку платежей.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth, requireSuperAdmin } = require('./routes-auth');
const { reverseOrderSideEffects } = require('./order-reversal');
const { releaseOrderReservation, restorePaidOrderInventory } = require('./reservations');

function registerOrderRoutes(router) {
  // GET /api/orders — список заказов для админки (последние сверху)
  router.get('/api/orders', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.min(parseInt(ctx.query.limit, 10) || 100, 500);
    const status = ctx.query.status; // необязательный фильтр: 'paid'|'pending'|'failed'
    const orders = status
      ? db.prepare(`
          SELECT o.*, COALESCE(o.partner_name, p.full_name) AS partner_name
          FROM orders o LEFT JOIN partners p ON p.id = o.partner_id
          WHERE o.status = ? ORDER BY o.id DESC LIMIT ?
        `).all(status, limit)
      : db.prepare(`
          SELECT o.*, COALESCE(o.partner_name, p.full_name) AS partner_name
          FROM orders o LEFT JOIN partners p ON p.id = o.partner_id
          ORDER BY o.id DESC LIMIT ?
        `).all(limit);
    const getItems = db.prepare('SELECT variant_id, name, weight, price, qty, is_custom FROM order_items WHERE order_id = ?');
    sendJson(res, 200, {
      orders: orders.map((o) => ({ ...o, items: getItems.all(o.id) })),
    });
  });

  // GET /api/orders/:id — один заказ
  router.get('/api/orders/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const order = db.prepare(`
      SELECT o.*, COALESCE(o.partner_name, p.full_name) AS partner_name
      FROM orders o LEFT JOIN partners p ON p.id = o.partner_id
      WHERE o.id = ?
    `).get(ctx.params.id);
    if (!order) return sendJson(res, 404, { error: 'Заказ не найден' });
    const items = db.prepare('SELECT variant_id, name, weight, price, qty, is_custom FROM order_items WHERE order_id = ?').all(order.id);
    sendJson(res, 200, { order: { ...order, items } });
  });

  // POST /api/orders/:id/refund — оформление возврата (полного или частичного)
  router.post('/api/orders/:id/refund', async (req, res, ctx) => {
    // Денежный возврат через ЮKassa — критичное действие. Одного наличия
    // админского токена недостаточно: сервер проверяет роль супер-админа,
    // поэтому ограничение нельзя обойти ручным запросом к API.
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    const yookassa = require('./yookassa');
    const { sendTelegram, buildOrderMessage } = require('./telegram');

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ctx.params.id);
    if (!order) return sendJson(res, 404, { error: 'Заказ не найден' });
    if (order.status !== 'paid') return sendJson(res, 400, { error: 'Возврат возможен только для оплаченного заказа' });
    if (order.refund_status === 'refunded') return sendJson(res, 400, { error: 'По этому заказу уже оформлен возврат' });

    const { amount, reason, restore_stock } = ctx.body || {};
    const refundAmount = typeof amount === 'number' && amount > 0 ? amount : order.total;
    if (refundAmount > order.total) {
      return sendJson(res, 400, { error: 'Сумма возврата не может быть больше суммы заказа' });
    }

    // Реальный платёж (не демо) — оформляем настоящий возврат через ЮKassa.
    let yookassaRefundId = null;
    if (order.yookassa_payment_id && yookassa.isConfigured()) {
      try {
        const refund = await yookassa.createRefund({
          paymentId: order.yookassa_payment_id,
          amount: refundAmount,
          description: reason || undefined,
          orderCode: order.order_code,
        });
        yookassaRefundId = refund.id;
      } catch (e) {
        return sendJson(res, 502, { error: 'Не удалось оформить возврат в ЮKassa: ' + e.message });
      }
    }
    // Демо-заказ (или ЮKassa ещё не подключена) — возврат фиксируется только локально.

    db.prepare(`
      UPDATE orders SET refund_status = 'refunded', refunded_amount = ?, refund_reason = ?,
        refunded_at = datetime('now'), yookassa_refund_id = ?
      WHERE id = ?
    `).run(refundAmount, reason || null, yookassaRefundId, order.id);

    // Возврат не должен засчитываться в лояльность клиента — откатываем счётчики.
    const custPhone = order.customer_phone.replace(/\D/g, '');
    const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(custPhone);
    if (customer) {
      db.prepare('UPDATE customers SET orders_count = MAX(0, orders_count - 1), total_spent = MAX(0, total_spent - ?) WHERE id = ?')
        .run(refundAmount, customer.id);
    }
    // Если заказ был частично или полностью оплачен косточками — возвращаем
    // их клиенту на баланс (сам возврат денег/скидок это не отменяет).
    if (order.bones_used > 0 && customer) {
      const { refundBones } = require('./bones');
      refundBones(customer.id, order.bones_used, order.id, 'Возврат косточек по заказу ' + order.order_code);
    }

    // Восстановление остатка — по желанию (галочка), по сохранённому variant_id.
    // Для заказов, созданных до появления этого поля, оставлен безопасный
    // best-effort поиск по названию и весу.
    let restoredCount = 0;
    if (restore_stock) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND is_custom = 0').all(order.id);
      restoredCount = restorePaidOrderInventory(order, items);
    }

    const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    await sendTelegram(
      '↩️ <b>Оформлен возврат</b>\n\n' +
      buildOrderMessage(updatedOrder, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)) +
      '\n💸 Возвращено: ' + refundAmount + ' ₽' + (reason ? '\n📝 Причина: ' + reason : '')
    ).catch(() => {});

    sendJson(res, 200, { ok: true, refunded_amount: refundAmount, restored_items: restoredCount, yookassa_refund_id: yookassaRefundId });
  });

  // DELETE /api/orders/:id — удаление одного заказа (для очистки тестовых
  // данных). Оплаченные заказы по умолчанию удалять нельзя — по ним уже
  // могла пройти реальная выплата грумеру/менеджеру (комиссия считается от
  // истории заказов, а не хранится отдельной пометкой на каждом заказе,
  // поэтому единственный надёжный признак «деньги уже были» — статус 'paid').
  // { force: true, restore_stock: true } в теле запроса обходит эту защиту —
  // для случаев вроде тестовых оплаченных заказов, которые нужно стереть
  // целиком: сначала откатывает статистику клиента/косточки/остаток (как
  // при возврате), затем реально удаляет запись.
  router.delete('/api/orders/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(ctx.params.id);
    if (!order) return sendJson(res, 404, { error: 'Заказ не найден' });
    const { force, restore_stock } = ctx.body || {};
    // Возвращённый заказ содержит финансовую историю и связанные операции
    // косточек. Удалять его как тестовый может только супер-администратор.
    if (order.refund_status === 'refunded' && payload.adminRole !== 'super') {
      return sendJson(res, 403, { error: 'Удалять возвращённые заказы может только супер-администратор' });
    }
    if (order.status === 'paid' && !force) {
      return sendJson(res, 400, {
        error: 'Заказ оплачен — по нему уже могла пройти выплата грумеру или менеджеру. Сначала оформите возврат, если заказ нужно аннулировать.',
        paid: true,
      });
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      if (order.status === 'paid' && force) {
        reverseOrderSideEffects(order, !!restore_stock);
      } else if (order.reservation_status === 'active') {
        releaseOrderReservation(order.id, null, 'Заказ удалён — резерв освобождён');
      }
      // bone_transactions намеренно не имеет ON DELETE CASCADE: обычное
      // удаление заказа не должно бесследно стирать историю лояльности.
      // Здесь удаление уже явно подтверждено как очистка тестовых данных.
      // Для возвращённого заказа связанные списание и возврат имеют нулевой
      // суммарный эффект, поэтому баланс клиента повторно не корректируем.
      db.prepare('DELETE FROM bone_transactions WHERE order_id = ?').run(order.id);
      db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error('[orders] Не удалось удалить заказ и связанные записи:', error.message);
      return sendJson(res, 500, { error: 'Не удалось удалить заказ. Изменения отменены.' });
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/orders/bulk-delete — массовая очистка заказов разом (для
  // тестовых данных). По умолчанию оплаченные не трогает — просто пропускает
  // и сообщает, сколько штук пропущено. { force: true } откатывает и удаляет
  // вообще все заказы без исключения — только для полной очистки тестовой
  // базы, использовать с осторожностью на реальном сервере.
  router.post('/api/orders/bulk-delete', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { force, restore_stock } = ctx.body || {};
    // Полная очистка захватывает в том числе оплаченные и возвращённые
    // заказы, поэтому она также доступна только супер-администратору.
    if (force && payload.adminRole !== 'super') {
      return sendJson(res, 403, { error: 'Полностью удалять оплаченные и возвращённые заказы может только супер-администратор' });
    }
    if (!force) {
      const paidCount = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'paid'").get().c;
      const active = db.prepare("SELECT id FROM orders WHERE status != 'paid' AND reservation_status = 'active'").all();
      for (const order of active) releaseOrderReservation(order.id, null, 'Заказ удалён — резерв освобождён');
      const info = db.prepare("DELETE FROM orders WHERE status != 'paid'").run();
      return sendJson(res, 200, { ok: true, deleted: info.changes, skipped_paid: paidCount });
    }
    const allOrders = db.prepare('SELECT * FROM orders').all();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const order of allOrders) {
        if (order.status === 'paid') reverseOrderSideEffects(order, !!restore_stock);
        else if (order.reservation_status === 'active') releaseOrderReservation(order.id, null, 'Заказ удалён — резерв освобождён');
        db.prepare('DELETE FROM bone_transactions WHERE order_id = ?').run(order.id);
      }
      const info = db.prepare('DELETE FROM orders').run();
      db.exec('COMMIT');
      return sendJson(res, 200, { ok: true, deleted: info.changes, skipped_paid: 0 });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error('[orders] Не удалось выполнить полную очистку заказов:', error.message);
      return sendJson(res, 500, { error: 'Не удалось удалить заказы. Изменения отменены.' });
    }
  });
}

module.exports = { registerOrderRoutes };
