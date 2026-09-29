// unpaid-order-alerts.js — оперативные уведомления в служебный Telegram,
// когда клиент не завершил оплату или платёж завершился ошибкой.
'use strict';

const db = require('./db');
const { sendTelegram } = require('./telegram');

const configuredDelay = Number(process.env.UNPAID_ORDER_ALERT_MINUTES || 3);
const ALERT_DELAY_MINUTES = Math.max(1, Math.min(30, Number.isFinite(configuredDelay) ? configuredDelay : 3));

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paymentLabel(method) {
  if (method === 'sbp') return 'СБП';
  if (method === 'card' || method === 'bank_card') return 'Карта';
  return 'ЮKassa';
}

function getOrderWithItems(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  return {
    order,
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id),
  };
}

function buildUnpaidOrderMessage(order, items, alertType, reason) {
  const heading = alertType === 'failed'
    ? '❌ <b>Платёж не состоялся — помогите клиенту</b>'
    : '⚠️ <b>Заказ не оплачен ' + ALERT_DELAY_MINUTES + ' минуты</b>';
  const itemLines = items.map((item) =>
    '• ' + escapeHtml(item.name) + ' (' + escapeHtml(item.weight) + ') × ' + Number(item.qty || 0) +
    ' — ' + (Number(item.price || 0) * Number(item.qty || 0)) + ' ₽'
  );
  const customerName = (String(order.customer_name || '') + ' ' + String(order.customer_lname || '')).trim() || 'Клиент';
  const lines = [
    heading,
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    '👤 ' + escapeHtml(customerName),
    '📞 ' + escapeHtml(order.customer_phone),
    '📍 ' + escapeHtml(order.pickup_point),
    '',
    ...itemLines,
    '',
    '💳 Способ: ' + paymentLabel(order.payment_method),
    '💵 Сумма: ' + Number(order.total || 0) + ' ₽',
  ];
  if (reason) lines.push('ℹ️ Причина: ' + escapeHtml(reason));
  lines.push('', '→ Свяжитесь с клиентом и помогите завершить оплату. Товар пока не выдавать.');
  return lines.join('\n');
}

async function sendUnpaidOrderAlert(orderId, alertType = 'pending', reason = null) {
  const data = getOrderWithItems(orderId);
  if (!data) return { ok: false, skipped: true, error: 'Заказ не найден' };
  const { order, items } = data;

  // Предупреждение об ожидании уже не актуально, если заказ успел изменить
  // статус между выборкой планировщика и фактической отправкой.
  if (alertType === 'pending' && order.status !== 'pending') {
    return { ok: false, skipped: true, error: 'Статус заказа уже изменился' };
  }
  if (order.status === 'paid') return { ok: false, skipped: true, error: 'Заказ уже оплачен' };

  const reservation = db.prepare(`
    INSERT OR IGNORE INTO unpaid_order_alert_log (order_id, alert_type, reason, status)
    VALUES (?, ?, ?, 'pending')
  `).run(order.id, alertType, reason ? String(reason).slice(0, 500) : null);
  if (!reservation.changes) return { ok: false, skipped: true, error: 'Оповещение уже создавалось' };

  let result;
  try {
    result = await sendTelegram(buildUnpaidOrderMessage(order, items, alertType, reason));
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const ok = !!(result && result.ok);
  const error = ok ? null : String((result && result.error) || (result && result.skipped ? 'Telegram не настроен' : 'Неизвестная ошибка')).slice(0, 500);
  db.prepare(`
    UPDATE unpaid_order_alert_log
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE order_id = ? AND alert_type = ?
  `).run(ok ? 'sent' : 'failed', error, ok ? 1 : 0, order.id, alertType);
  return { ok, error };
}

function pendingOrderIds() {
  return db.prepare(`
    SELECT o.id FROM orders o
    LEFT JOIN unpaid_order_alert_log a ON a.order_id = o.id AND a.alert_type = 'pending'
    WHERE o.status = 'pending' AND o.reservation_status = 'active'
      AND o.created_at <= datetime('now', '-' || ? || ' minutes')
      AND o.created_at >= datetime('now', '-30 minutes')
      AND a.id IS NULL
    ORDER BY o.id
  `).all(ALERT_DELAY_MINUTES).map((row) => row.id);
}

async function runUnpaidOrderAlertCheck() {
  const results = [];
  for (const orderId of pendingOrderIds()) {
    results.push({ order_id: orderId, ...(await sendUnpaidOrderAlert(orderId, 'pending')) });
  }
  return results;
}

let schedulerStarted = false;
function scheduleUnpaidOrderAlerts() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const first = setTimeout(() => runUnpaidOrderAlertCheck().catch((error) => console.warn('Неоплаченные заказы: ошибка проверки:', error.message)), 15000);
  const interval = setInterval(() => runUnpaidOrderAlertCheck().catch((error) => console.warn('Неоплаченные заказы: ошибка проверки:', error.message)), 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  if (typeof interval.unref === 'function') interval.unref();
}

module.exports = {
  ALERT_DELAY_MINUTES,
  buildUnpaidOrderMessage,
  pendingOrderIds,
  runUnpaidOrderAlertCheck,
  scheduleUnpaidOrderAlerts,
  sendUnpaidOrderAlert,
};
