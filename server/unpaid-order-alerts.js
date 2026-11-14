// Оповещение ответственного менеджера и администратора ХвостМаркета через минуту.
// Независимые журналы защищают от повторов и пропуска администратора, если
// менеджер не подключил Telegram.
'use strict';

const db = require('./db');
const {visibleOrderNumber} = require('./order-display-number');
const { trackSync, trackAsync } = require('./runtime-diagnostics');
const { sendToChat } = require('./telegram');
const { connectedChatId, findManagerAndPoint } = require('./order-notifications');

// The operational SLA is fixed: an old Amvera environment override must
// never silently keep the historical 3-minute notification threshold.
const ALERT_DELAY_MINUTES = 1;
const POLL_INTERVAL_MS = 15 * 1000;
const IDLE_INTERVAL_MS = 5 * 60 * 1000;

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
  // One indexed join reads only 30-minute pending reservation IDs and their
  // delivery ledgers. Avoid the previous N * (admins + manager) SQL lookups.
  // Full customer contacts and item descriptions remain outside this scan.
  const rows = trackSync('unpaid_order_sql', () => db.prepare(
    "SELECT o.id, o.point_id, ml.order_id AS manager_logged, " +
    "al.target_chat_id AS admin_chat_id, al.status AS admin_status, " +
    "al.created_at<=datetime('now','-30 seconds') AS admin_retry_due " +
    "FROM orders o " +
    "LEFT JOIN unpaid_order_alert_log ml " +
    "ON ml.order_id=o.id AND ml.alert_type='pending' " +
    "LEFT JOIN unpaid_order_admin_alert_log al " +
    "ON al.order_id=o.id AND al.alert_type='pending' " +
    "WHERE o.status='pending' AND o.reservation_status='active' " +
    "AND o.created_at<=datetime('now','-1 minute') " +
    "AND o.created_at>=datetime('now','-30 minutes') ORDER BY o.id"
  ).all());
  // An idle five-minute check should not even fetch admin recipients.
  if (!rows.length) return [];

  const orders = new Map();
  for (const row of rows) {
    let record = orders.get(row.id);
    if (!record) {
      record = {
        id: row.id, point_id: row.point_id,
        managerLogged: row.manager_logged != null,
        adminLog: new Map(),
      };
      orders.set(row.id, record);
    }
    if (row.admin_chat_id != null) {
      record.adminLog.set(String(row.admin_chat_id), {
        status: row.admin_status, retryDue: !!row.admin_retry_due,
      });
    }
  }

  const adminChats = new Set(adminRecipientChats(options));
  // Different pending orders at the same point share one responsible manager.
  // Only cache within this synchronous scan: reassignment after the scan
  // still gets checked again before any customer details are sent.
  const managersByPoint = new Map();
  return [...orders.values()].filter(order => {
    const pointId = order.point_id;
    let managerChat = null;
    if (pointId) {
      if (!managersByPoint.has(pointId)) {
        managersByPoint.set(pointId, responsibleManagerChat(order));
      }
      managerChat = managersByPoint.get(pointId);
    }
    const managerDue = managerChat && !adminChats.has(managerChat) && !order.managerLogged;
    const adminDue = [...adminChats].some(chatId => {
      const delivery = order.adminLog.get(chatId);
      return !delivery || (delivery.status === 'failed' && delivery.retryDue);
    });
    return !!(managerDue || adminDue);
  }).map(order => order.id);
}

async function runUnpaidOrderAlertCheck(options = {}) {
  const results = [];
  for (const orderId of pendingOrderIds(options)) {
    const result = await sendUnpaidOrderAlert(orderId, 'pending', null, options);
    if (!result.skipped) results.push({ order_id: orderId, ...result });
  }
  return results;
}

// The payment path explicitly wakes this scheduler after a successful order
// reservation. No orders: check for legacy/recovered orders every five minutes.
// Newly reserved orders: wake at their earliest one-minute reminder deadline.
// Pending due orders: retain the old 15-second cadence (including retries).
// The partial orders index prevents reading the paid sales history.
function nextUnpaidAlertDelay(nowMs = Date.now(), database = db) {
  const row = database.prepare(
    "SELECT MIN(created_at) AS oldest FROM orders " +
    "WHERE status='pending' AND reservation_status='active' " +
    "AND created_at>=datetime('now','-30 minutes')"
  ).get();
  if (!row || !row.oldest) return IDLE_INTERVAL_MS;
  const createdMs = Date.parse(String(row.oldest).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(createdMs)) return POLL_INTERVAL_MS;
  const dueMs = createdMs + ALERT_DELAY_MINUTES * 60 * 1000;
  if (nowMs >= dueMs) return POLL_INTERVAL_MS;
  // SQLite timestamps are second precision. A one-second cushion prevents
  // checking before the exact due timestamp, not the alert SLA.
  return Math.max(1000, Math.min(IDLE_INTERVAL_MS, dueMs - nowMs + 1000));
}
function createUnpaidAlertScheduler({
  database = db,
  scan = () => trackAsync('unpaid_order_scan', () => runUnpaidOrderAlertCheck()),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  let started = false, running = false, timer = null, dueAt = Infinity;
  let wakeRequested = false;
  function schedule(delayMs) {
    if (!started) return;
    const delay = Math.max(0, Math.round(delayMs));
    const due = now() + delay;
    if (timer && dueAt <= due) return;
    if (timer) clearTimer(timer);
    dueAt = due;
    timer = setTimer(() => {
      timer = null; dueAt = Infinity;
      void tick();
    }, delay);
    timer?.unref?.();
  }
  async function tick() {
    if (!started) return;
    if (running) { wakeRequested = true; return; }
    running = true;
    let delay = POLL_INTERVAL_MS;
    try {
      await scan();
      delay = nextUnpaidAlertDelay(now(), database);
    } catch (error) {
      console.warn('Неоплаченные заказы: ошибка проверки:', error.message);
    } finally {
      running = false;
    }
    if (!started) return;
    const wake = wakeRequested;
    wakeRequested = false;
    schedule(wake ? 0 : delay);
  }
  return {
    start() {
      if (started) return;
      started = true;
      schedule(3000); // Recover work quickly after a restart.
    },
    wake() {
      if (!started) return;
      if (running) wakeRequested = true;
      else schedule(0);
    },
    stop() {
      started = false; wakeRequested = false;
      if (timer) clearTimer(timer);
      timer = null; dueAt = Infinity;
    },
  };
}
const unpaidAlertScheduler = createUnpaidAlertScheduler();
function scheduleUnpaidOrderAlerts() {
  unpaidAlertScheduler.start();
}
function wakeUnpaidOrderAlertScheduler() {
  unpaidAlertScheduler.wake();
}

module.exports = {
  ALERT_DELAY_MINUTES,
  POLL_INTERVAL_MS,
  IDLE_INTERVAL_MS, nextUnpaidAlertDelay, createUnpaidAlertScheduler,
  wakeUnpaidOrderAlertScheduler,
  buildUnpaidOrderMessage,
  responsibleManagerChat,
  adminRecipientChats,
  buildAdminUnpaidMessage,
  pendingOrderIds,
  runUnpaidOrderAlertCheck,
  scheduleUnpaidOrderAlerts,
  sendUnpaidOrderAlert,
};
