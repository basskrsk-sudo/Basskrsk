// Оповещение ответственного менеджера и администратора ХвостМаркета через минуту.
// Независимые журналы защищают от повторов и пропуска администратора, если
// менеджер не подключил Telegram.
'use strict';

const db = require('./db');
const {visibleOrderNumber} = require('./order-display-number');
const { createSingleFlightJob } = require('./single-flight-job');
const { trackSync, trackAsync } = require('./runtime-diagnostics');
const { sendToChat } = require('./telegram');
const { connectedChatId, findManagerAndPoint } = require('./order-notifications');

// The operational SLA is fixed: an old Amvera environment override must
// never silently keep the historical 3-minute notification threshold.
const ALERT_DELAY_MINUTES = 1;
const POLL_INTERVAL_MS = 15 * 1000;

// Admin recipients must be deduplicated independently from managers.
db.exec('CREATE TABLE IF NOT EXISTS unpaid_order_admin_alert_log (' +
  'order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,' +
  'alert_type TEXT NOT NULL,target_chat_id TEXT NOT NULL,' +
  "status TEXT NOT NULL DEFAULT 'pending',error TEXT," +
  "created_at TEXT NOT NULL DEFAULT (datetime('now')),sent_at TEXT," +
  'PRIMARY KEY(order_id,alert_type,target_chat_id))');

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
    : '⚠️ <b>Заказ не оплачен 1 минуту</b>';
  const itemLines = items.map((item) =>
    '• ' + escapeHtml(item.name) + ' (' + escapeHtml(item.weight) + ') × ' + Number(item.qty || 0) +
    ' — ' + (Number(item.price || 0) * Number(item.qty || 0)) + ' ₽'
  );
  const customerName = (String(order.customer_name || '') + ' ' + String(order.customer_lname || '')).trim() || 'Клиент';
  const lines = [
    heading,
    '',
    '📋 Заказ: ' + escapeHtml(visibleOrderNumber(order)),
    ...(order.display_number ? ['🔎 Технический код: ' + escapeHtml(order.order_code)] : []),
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

function responsibleManagerChat(order) {
  if (!order || !order.point_id) return null;
  const { manager, point } = findManagerAndPoint(order);
  if (!point || point.active !== 1 || !manager || manager.active !== 1) return null;
  const chatId = connectedChatId('manager', manager);
  if (!chatId || !/^[1-9]\d{0,19}$/.test(String(chatId))) return null;
  return String(chatId);
}

async function sendManagerUnpaidAlert(orderId, alertType = 'pending', reason = null, options = {}) {
  const data = getOrderWithItems(orderId);
  if (!data) return { ok: false, skipped: true, error: 'Заказ не найден' };
  const { order, items } = data;

  // Payment can complete between scheduler selection and the actual send.
  if (order.status === 'paid') return { ok: false, skipped: true, error: 'Заказ уже оплачен' };
  if (alertType === 'pending' && (order.status !== 'pending' ||
      order.reservation_status !== 'active' ||
      !db.prepare("SELECT 1 AS ok FROM orders WHERE id=? AND created_at <= datetime('now', '-1 minute')").get(order.id))) {
    return { ok: false, skipped: true, error: 'Неоплаченный заказ ещё не требует напоминания' };
  }

  // A point's active primary manager wins. Legacy points are routed only
  // when exactly one active manager is uniquely associated with the point.
  // Never send an order's phone number to all managers or service TG_CHAT_ID.
  const chatId = responsibleManagerChat(order);
  if (!chatId) return { ok: false, skipped: true, error: 'У точки нет подключённого ответственного менеджера' };

  // One alert per order/type even if the check overlaps or the server restarts.
  const reservation = db.prepare(`
    INSERT OR IGNORE INTO unpaid_order_alert_log (order_id, alert_type, reason, status)
    VALUES (?, ?, ?, 'pending')
  `).run(order.id, alertType, reason ? String(reason).slice(0, 500) : null);
  if (!reservation.changes) return { ok: false, skipped: true, error: 'Оповещение уже создавалось' };

  // Do not publish information to an unrelated chat when assignment changes
  // after the alert was reserved but before the async Telegram call.
  const latestOrder = db.prepare('SELECT id, status, reservation_status, point_id FROM orders WHERE id=?').get(order.id);
  const latestChat = latestOrder && responsibleManagerChat(latestOrder);
  if (!latestOrder || latestOrder.status === 'paid' ||
      (alertType === 'pending' && latestOrder.status !== 'pending') ||
      latestChat !== chatId) {
    db.prepare(`UPDATE unpaid_order_alert_log SET status='skipped', error=? WHERE order_id=? AND alert_type=?`)
      .run('Статус заказа или ответственный менеджер изменился', order.id, alertType);
    return { ok: false, skipped: true, error: 'Данные заказа изменились до отправки' };
  }

  let result;
  try {
    const send = options.sendToChat || sendToChat;
    result = await send(chatId, buildUnpaidOrderMessage(order, items, alertType, reason));
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const ok = !!(result && result.ok);
  const error = ok ? null : String((result && result.error) ||
    (result && result.skipped ? 'Telegram не настроен' : 'Неизвестная ошибка')).slice(0, 500);
  db.prepare(`
    UPDATE unpaid_order_alert_log
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE order_id = ? AND alert_type = ?
  `).run(ok ? 'sent' : 'failed', error, ok ? 1 : 0, order.id, alertType);
  return { ok, error, ...(ok ? { chat_id: chatId } : {}) };
}

// Admin personal chats + existing operations chat. Deduplicate by actual
// Telegram chat ID (one person may have both manager and admin roles).
function adminRecipientChats(options = {}) {
  const chats = new Set();
  const admins = db.prepare(
    "SELECT telegram_chat_id FROM admins WHERE active=1 AND TRIM(COALESCE(telegram_chat_id,''))<>''"
  ).all();
  for (const admin of admins) {
    const chat = String(admin.telegram_chat_id || '').trim();
    if (/^[1-9]\d{0,19}$/.test(chat)) chats.add(chat);
  }
  // The service chat received these alerts before manager-only routing.
  // It can be a Telegram group with a negative chat ID.
  const service = String(options.businessChatId === undefined ?
    (process.env.TG_CHAT_ID || '') : (options.businessChatId || '')).trim();
  if (/^-?[1-9]\d{0,19}$/.test(service)) chats.add(service);
  return [...chats];
}

function buildAdminUnpaidMessage(order, items, alertType, reason) {
  const assignment = findManagerAndPoint(order);
  const managerName = assignment.manager ? (assignment.manager.full_name || 'Имя не указано') : 'не назначен';
  return buildUnpaidOrderMessage(order, items, alertType, reason) +
    '\n\n👔 Ответственный менеджер: ' + escapeHtml(managerName);
}

function currentUnpaidOrder(orderId, alertType) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || order.status === 'paid') return null;
  if (alertType === 'pending' && (order.status !== 'pending' ||
      order.reservation_status !== 'active')) return null;
  return order;
}

const RETRY_SECONDS = 30;

// Per-recipient ledger: a failed admin delivery can retry separately from
// successful ones, without resending to the manager or other administrators.
function reserveAdminDelivery(orderId, alertType, chatId) {
  const first = db.prepare(
    "INSERT OR IGNORE INTO unpaid_order_admin_alert_log " +
    "(order_id,alert_type,target_chat_id,status) VALUES (?,?,?,'pending')"
  ).run(orderId, alertType, chatId);
  if (first.changes) return true;
  // After a recoverable Telegram failure, permit limited retry in the first
  // 30 minutes; do not replay messages that have already been accepted.
  const retried = db.prepare(
    "UPDATE unpaid_order_admin_alert_log " +
    "SET status='pending', error=NULL, created_at=datetime('now') " +
    "WHERE order_id=? AND alert_type=? AND target_chat_id=? " +
    "AND status='failed' AND created_at<=datetime('now','-30 seconds')"
  ).run(orderId,alertType,chatId);
  return !!retried.changes;
}
function adminDeliveryDue(orderId, alertType, chatId) {
  const row = db.prepare(
    'SELECT status,created_at FROM unpaid_order_admin_alert_log ' +
    'WHERE order_id=? AND alert_type=? AND target_chat_id=?'
  ).get(orderId,alertType,chatId);
  if (!row) return true;
  return row.status === 'failed' && !!db.prepare(
    "SELECT 1 AS due WHERE ? <= datetime('now','-30 seconds')"
  ).get(row.created_at);
}

async function sendAdminUnpaidAlert(order, items, alertType, reason, chatId, options = {}) {
  if (!reserveAdminDelivery(order.id,alertType,chatId)) return {ok:false,skipped:true};
  const latest = currentUnpaidOrder(order.id,alertType);
  if (!latest || !adminRecipientChats(options).includes(chatId)) {
    db.prepare(
      "UPDATE unpaid_order_admin_alert_log SET status='skipped',error=? " +
      'WHERE order_id=? AND alert_type=? AND target_chat_id=?'
    ).run('Заказ оплачен или адресат больше не администратор',order.id,alertType,chatId);
    return {ok:false,skipped:true};
  }
  let result;
  try {
    result = await (options.sendToChat || sendToChat)(
      chatId,buildAdminUnpaidMessage(latest,items,alertType,reason)
    );
  } catch (error) {
    result = {ok:false,error:error.message};
  }
  const ok = !!(result && result.ok);
  const error = ok ? null : String((result && result.error) ||
    (result && result.skipped ? 'Telegram не настроен' : 'Неизвестная ошибка')).slice(0,500);
  db.prepare(
    'UPDATE unpaid_order_admin_alert_log ' +
    "SET status=?,error=?,sent_at=CASE WHEN ?=1 THEN datetime('now') ELSE NULL END " +
    'WHERE order_id=? AND alert_type=? AND target_chat_id=?'
  ).run(ok?'sent':'failed',error,ok?1:0,order.id,alertType,chatId);
  return {ok,error,...(ok?{chat_id:chatId}:{})};
}

async function sendUnpaidOrderAlert(orderId, alertType = 'pending', reason = null, options = {}) {
  const data = getOrderWithItems(orderId);
  if (!data) return {ok:false,skipped:true,error:'Заказ не найден'};
  const {order,items} = data;
  if (!currentUnpaidOrder(orderId,alertType)) return {ok:false,skipped:true,error:'Заказ оплачен или закрыт'};
  if (alertType === 'pending' && !db.prepare(
    "SELECT 1 AS due FROM orders WHERE id=? AND created_at<=datetime('now','-1 minute')"
  ).get(orderId)) return {ok:false,skipped:true,error:'Ещё не прошла 1 минута'};
  const adminChats = adminRecipientChats(options);
  const managerChat = responsibleManagerChat(order);
  const results = [];

  // Do not duplicate a single order in the same Telegram account.
  if (managerChat && !adminChats.includes(managerChat)) {
    const result = await sendManagerUnpaidAlert(orderId,alertType,reason,options);
    if (!result.skipped) results.push({role:'manager',...result});
  }
  // Admin delivery is independent: absent/failed manager cannot suppress it.
  for (const chatId of adminChats) {
    const result = await sendAdminUnpaidAlert(order,items,alertType,reason,chatId,options);
    if (!result.skipped) results.push({role:'admin',...result});
  }
  if (!results.length) return {ok:false,skipped:true,error:'Адресаты уже уведомлены или недоступны'};
  return {
    ok:results.some(r=>r.ok),
    manager_sent:results.some(r=>r.role==='manager'&&r.ok),
    admin_sent:results.some(r=>r.role==='admin'&&r.ok),
    sent_count:results.filter(r=>r.ok).length,
    failed_count:results.filter(r=>!r.ok).length,
  };
}

function pendingOrderIds(options = {}) {
  // Keep the 30-minute recovery window from the previous implementation.
  // An admin may still need the notice after a manager's notification was
  // already logged, and an admin retry must not resend successful chats.
  const rows = trackSync('unpaid_order_sql', () => db.prepare(
    "SELECT * FROM orders WHERE status='pending' AND reservation_status='active' " +
    "AND created_at<=datetime('now','-1 minute') " +
    "AND created_at>=datetime('now','-30 minutes') ORDER BY id"
  ).all());
  const adminChats = adminRecipientChats(options);
  const hasManagerLog = db.prepare(
    "SELECT 1 AS logged FROM unpaid_order_alert_log WHERE order_id=? AND alert_type='pending'"
  );
  return rows.filter(order => {
    const managerChat = responsibleManagerChat(order);
    const managerDue = managerChat && !adminChats.includes(managerChat) &&
      !hasManagerLog.get(order.id);
    const adminDue = adminChats.some(chatId => adminDeliveryDue(order.id,'pending',chatId));
    return !!(managerDue || adminDue);
  }).map(row => row.id);
}

async function runUnpaidOrderAlertCheck(options = {}) {
  const results = [];
  for (const orderId of pendingOrderIds(options)) {
    const result = await sendUnpaidOrderAlert(orderId, 'pending', null, options);
    if (!result.skipped) results.push({ order_id: orderId, ...result });
  }
  return results;
}

let schedulerStarted = false;
function scheduleUnpaidOrderAlerts() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = createSingleFlightJob(
    () => trackAsync('unpaid_order_scan', () => runUnpaidOrderAlertCheck()),
    (error) => console.warn('Неоплаченные заказы: ошибка проверки:', error.message)
  );
  const first = setTimeout(run, 3000);
  const interval = setInterval(run, POLL_INTERVAL_MS);
  if (typeof first.unref === 'function') first.unref();
  if (typeof interval.unref === 'function') interval.unref();
}

module.exports = {
  ALERT_DELAY_MINUTES,
  POLL_INTERVAL_MS,
  buildUnpaidOrderMessage,
  responsibleManagerChat,
  adminRecipientChats,
  buildAdminUnpaidMessage,
  pendingOrderIds,
  runUnpaidOrderAlertCheck,
  scheduleUnpaidOrderAlerts,
  sendUnpaidOrderAlert,
};
