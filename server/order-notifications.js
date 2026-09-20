// order-notifications.js — персональные Telegram-уведомления после оплаты.
// Бот может написать только тому, кто хотя бы один раз сам открыл его через
// вход по Telegram. Отсутствие chat_id не считается ошибкой заказа.
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU') + ' ₽';
}

function phoneLast10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function itemsText(items) {
  return items.map((item) =>
    '• ' + escapeHtml(item.name) + (item.weight ? ' (' + escapeHtml(item.weight) + ')' : '') +
    ' × ' + Number(item.qty || 0) + ' — ' + money(Number(item.price || 0) * Number(item.qty || 0))
  ).join('\n');
}

// Фолбэк нужен для людей, которые подключили Telegram до появления полей
// telegram_chat_id в partners/managers. Берём только подтверждённый токен
// соответствующей роли и сверяем телефон по последним десяти цифрам.
function connectedChatId(role, account) {
  if (!account) return null;
  if (account.telegram_chat_id) return String(account.telegram_chat_id);
  const phone = phoneLast10(account.phone);
  if (!phone) return null;
  const tokens = db.prepare(`
    SELECT phone, chat_id FROM telegram_login_tokens
    WHERE role = ? AND verified = 1 AND chat_id IS NOT NULL
    ORDER BY id DESC
  `).all(role);
  const token = tokens.find((row) => phoneLast10(row.phone) === phone);
  return token ? String(token.chat_id) : null;
}

function buildCustomerMessage(order, items) {
  const isDelivery = order.fulfillment_type === 'home_delivery';
  const destination = isDelivery
    ? '🏠 Адрес: ' + escapeHtml(order.delivery_address || '')
    : '📍 Точка: ' + escapeHtml(order.pickup_point || '');
  const bones = Number(order.bones_used || 0) > 0
    ? '\n🦴 Списано косточек: ' + money(order.bones_used)
    : '';
  const finalLine = isDelivery
    ? 'Мы сообщим, когда заказ будет передан в доставку.'
    : 'Товар можно самостоятельно забрать с хвостомата — обращаться к сотруднику не обязательно.';
  return [
    '✅ <b>Заказ оплачен — ХвостМаркет</b>',
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    destination,
    '',
    itemsText(items),
    '',
    '💵 Оплачено: <b>' + money(order.total) + '</b>' + bones,
    '',
    '→ ' + finalLine,
  ].join('\n');
}

function buildPartnerMessage(order, items, partner) {
  const rate = Number(order.commission_rate || 0);
  const reward = Math.round(Number(order.total || 0) * rate);
  const rewardLine = rate > 0
    ? '💸 Ваше вознаграждение: <b>' + money(reward) + '</b> (' + Math.round(rate * 100) + '%)'
    : 'ℹ️ Самозаказ: вознаграждение грумера не начисляется.';
  return [
    '💰 <b>Новая продажа у вас</b>',
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    '📍 Точка: ' + escapeHtml(order.pickup_point || partner.point_name || ''),
    '👤 Клиент: ' + escapeHtml((order.customer_name + ' ' + (order.customer_lname || '')).trim()),
    '📞 ' + escapeHtml(order.customer_phone),
    '',
    itemsText(items),
    '',
    '💵 Сумма продажи: <b>' + money(order.total) + '</b>',
    rewardLine,
  ].join('\n');
}

function buildManagerMessage(order, items, manager, point, partner, managerRate) {
  const hasRate = Number.isFinite(Number(managerRate));
  const reward = hasRate ? Math.round(Number(order.total || 0) * Number(managerRate)) : null;
  const groomerName = order.partner_name || (partner && partner.full_name) || 'не выбран';
  const lines = [
    '📈 <b>Новая продажа на вашей точке</b>',
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    '📍 Точка: ' + escapeHtml((point && point.name) || order.pickup_point || ''),
    '✂️ Грумер: ' + escapeHtml(groomerName),
    '👤 Клиент: ' + escapeHtml((order.customer_name + ' ' + (order.customer_lname || '')).trim()),
    '',
    itemsText(items),
    '',
    '💵 Сумма продажи: <b>' + money(order.total) + '</b>',
  ];
  if (reward !== null) {
    lines.push('💸 Ваше вознаграждение: <b>' + money(reward) + '</b> (' + Math.round(Number(managerRate) * 100) + '%)');
  }
  return lines.join('\n');
}

function findCustomer(phone) {
  const normalized = phoneLast10(phone);
  return db.prepare('SELECT id, phone, telegram_chat_id FROM customers').all()
    .find((row) => phoneLast10(row.phone) === normalized) || null;
}

function findPartner(order) {
  if (order.partner_id) {
    return db.prepare('SELECT * FROM partners WHERE id = ? AND active = 1').get(order.partner_id) || null;
  }
  if (!order.point_id) return null;
  const partners = db.prepare('SELECT * FROM partners WHERE point_id = ? AND active = 1').all(order.point_id);
  return partners.length === 1 ? partners[0] : null;
}

function findManagerAndPoint(order) {
  if (!order.point_id) return { manager: null, point: null, rate: null };
  const point = db.prepare('SELECT * FROM points WHERE id = ?').get(order.point_id) || null;
  if (!point) return { manager: null, point: null, rate: null };
  let manager = point.manager_id
    ? db.prepare('SELECT * FROM managers WHERE id = ? AND active = 1').get(point.manager_id)
    : null;
  let link = manager
    ? db.prepare('SELECT commission_rate FROM manager_points WHERE manager_id = ? AND point_id = ? AND active = 1').get(manager.id, point.id)
    : null;
  if (!manager) {
    const fallback = db.prepare(`
      SELECT m.*, mp.commission_rate AS point_commission_rate
      FROM manager_points mp JOIN managers m ON m.id = mp.manager_id
      WHERE mp.point_id = ? AND mp.active = 1 AND m.active = 1
      ORDER BY mp.id DESC LIMIT 1
    `).get(point.id);
    if (fallback) {
      manager = fallback;
      link = { commission_rate: fallback.point_commission_rate };
    }
  }
  return { manager, point, rate: link ? link.commission_rate : null };
}

async function sendPaidOrderNotifications(order, items) {
  const customer = findCustomer(order.customer_phone);
  const partner = findPartner(order);
  const { manager, point, rate } = findManagerAndPoint(order);
  const deliveries = [];

  const customerChatId = connectedChatId('customer', customer);
  if (customerChatId) deliveries.push({ role: 'customer', promise: sendToChat(customerChatId, buildCustomerMessage(order, items)) });

  const partnerChatId = connectedChatId('partner', partner);
  if (partnerChatId) deliveries.push({ role: 'partner', promise: sendToChat(partnerChatId, buildPartnerMessage(order, items, partner)) });

  const managerChatId = connectedChatId('manager', manager);
  if (managerChatId) deliveries.push({ role: 'manager', promise: sendToChat(managerChatId, buildManagerMessage(order, items, manager, point, partner, rate)) });

  const settled = await Promise.allSettled(deliveries.map((item) => item.promise));
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error('[paid-order] Telegram-уведомление роли ' + deliveries[index].role + ' не отправлено:', result.reason && result.reason.message);
    }
  });
  return {
    attempted: deliveries.map((item) => item.role),
    missing: ['customer', 'partner', 'manager'].filter((role) => !deliveries.some((item) => item.role === role)),
  };
}

module.exports = {
  sendPaidOrderNotifications,
  buildCustomerMessage,
  buildPartnerMessage,
  buildManagerMessage,
  connectedChatId,
};
