// order-notifications.js — персональные Telegram-уведомления после оплаты.
// Бот может написать только тому, кто хотя бы один раз сам открыл его через
// вход по Telegram. Отсутствие chat_id не считается ошибкой заказа.
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');
const { preference } = require('./notification-preferences');

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
  // Only accept historical tokens that were explicitly verified for this
  // role AND account. Phone-only matches can route private notices incorrectly.
  if (!Number.isSafeInteger(Number(account.id)) || Number(account.id)<1) return null;
  const token = db.prepare(`
    SELECT chat_id FROM telegram_login_tokens
    WHERE role=? AND account_id=? AND verified=1
      AND TRIM(COALESCE(chat_id,''))<>''
    ORDER BY id DESC LIMIT 1
  `).get(role,account.id);
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
  const selfOrder = order.is_partner_self_order
    ? '\n🐾 Самозаказ: вознаграждение по тарифу; косточки не списываются и не начисляются.'
    : '';
  const finalLine = isDelivery
    ? 'Мы сообщим, когда заказ будет передан в доставку.'
    : 'Товар можно самостоятельно забрать из минимаркета — обращаться к сотруднику не обязательно.';
  return [
    '✅ <b>Заказ оплачен — ХвостМаркет</b>',
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    destination,
    '',
    itemsText(items),
    '',
    '💵 Оплачено: <b>' + money(order.total) + '</b>' + bones + selfOrder,
    '',
    '→ ' + finalLine,
  ].join('\n');
}

function buildPartnerMessage(order, items, partner) {
  const rate = Number(order.commission_rate || 0);
  const reward = Math.round(Number(order.total || 0) * rate);
  const rewardLine = rate > 0
    ? '💸 Ваше вознаграждение: <b>' + money(reward) + '</b> (' + Math.round(rate * 100) + '%)'
    : 'ℹ️ Вознаграждение по этому заказу не начисляется.';
  return [
    '💰 <b>Новая продажа у вас</b>',
    '',
    '📋 Заказ: ' + escapeHtml(order.order_code),
    '📍 Точка: ' + escapeHtml(order.pickup_point || partner.point_name || ''),
    // Staff receives order details, not the customer's personal contacts.
    '',
    itemsText(items),
    '',
    '💵 Сумма продажи: <b>' + money(order.total) + '</b>',
    rewardLine,
    ...(order.is_partner_self_order ? ['🐾 Самозаказ: косточки не списываются и не начисляются.'] : []),
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
    // No personal customer data in a manager's optional sales notice.
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
  if (normalized.length !== 10) return null;
  const matches=db.prepare('SELECT id,phone,telegram_chat_id FROM customers').all()
    .filter(row=>phoneLast10(row.phone)===normalized);
  // An ambiguous legacy phone must not cause an order receipt to reach
  // a randomly selected customer's linked Telegram account.
  return matches.length===1?matches[0]:null;
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
  // Assigned point.manager_id wins. If the assigned manager is inactive,
  // do not route a sale to a different historical manager.
  if (point.manager_id != null) {
    const manager=db.prepare('SELECT * FROM managers WHERE id=? AND active=1')
      .get(point.manager_id)||null;
    const link=manager ? db.prepare(
      'SELECT commission_rate FROM manager_points WHERE manager_id=? AND point_id=? AND active=1'
    ).get(manager.id,point.id) : null;
    return {manager,point,rate:link?link.commission_rate:null};
  }
  // On older points, fall back only to ONE distinct, active manager.
  const candidates=db.prepare(`
    SELECT m.*,mp.commission_rate AS point_commission_rate
    FROM manager_points mp JOIN managers m ON m.id=mp.manager_id
    WHERE mp.point_id=? AND mp.active=1 AND m.active=1
  `).all(point.id);
  const unique=new Map(candidates.map(row=>[row.id,row]));
  if(unique.size!==1)return {manager:null,point,rate:null};
  const manager=[...unique.values()][0];
  return {manager,point,rate:manager.point_commission_rate};
}

function buildMinimalSaleNotice(order, items, kind) {
  return [
    '🐾 <b>' + escapeHtml(kind) + '</b>',
    '',
    '🏪 ' + escapeHtml(order.pickup_point || 'Партнёрская точка'),
    '📋 Заказ: ' + escapeHtml(order.order_code),
    itemsText(items),
    '',
    '💚 <b>' + money(order.total) + '</b>',
  ].join('\n');
}

function optedInSaleSubscribers(order) {
  if (!order.point_id) return [];
  const result = [];
  // Owners are scoped ONLY to their assigned salon. New owner messages are
  // off by default until their own account explicitly enables the toggle.
  const owners = db.prepare('SELECT id, telegram_chat_id FROM salon_owners WHERE point_id=? AND active=1 AND telegram_chat_id IS NOT NULL').all(order.point_id);
  for (const account of owners) {
    if (preference('owner',account.id,'sales')) result.push({role:'owner',account});
  }
  for (const role of ['admin','founder']) {
    const table = role === 'admin' ? 'admins' : 'business_founders';
    const accounts = db.prepare('SELECT id,telegram_chat_id FROM '+table+' WHERE active=1 AND telegram_chat_id IS NOT NULL').all();
    for (const account of accounts) {
      if(preference(role,account.id,'sales')) result.push({role,account});
    }
  }
  return result;
}

async function sendPaidOrderNotifications(order, items) {
  const customer = findCustomer(order.customer_phone);
  const partner = findPartner(order);
  const { manager, point, rate } = findManagerAndPoint(order);
  // One PRIVATE notice per Telegram chat and order, even when the person
  // holds several roles. Prefer payment receipt, then groomer, manager,
  // salon owner and explicitly subscribed network roles.
  const byChat=new Map();
  function add(role,chat,text){
    const id=String(chat||'').trim();
    if(!/^[0-9]{1,20}$/.test(id))return;
    if(!byChat.has(id))byChat.set(id,{role,chat:id,text});
  }
  const customerChatId=connectedChatId('customer',customer);
  if(customerChatId && preference('customer',customer.id,'purchase'))
    add('customer',customerChatId,buildCustomerMessage(order,items));
  const partnerChatId=connectedChatId('partner',partner);
  if(partnerChatId && preference('partner',partner.id,'sales'))
    add('partner',partnerChatId,buildPartnerMessage(order,items,partner));
  const managerChatId=connectedChatId('manager',manager);
  if(managerChatId && preference('manager',manager.id,'sales'))
    add('manager',managerChatId,buildManagerMessage(order,items,manager,point,partner,rate));
  for(const {role,account} of optedInSaleSubscribers(order)){
    // The service chat already receives its own full paid-order notification.
    // An admin/founder who opted into personal sales should not get a duplicate
    // copy in that same Telegram chat.
    if((role==='admin'||role==='founder') &&
       String(account.telegram_chat_id)===String(process.env.TG_CHAT_ID||''))continue;
    add(role,account.telegram_chat_id,buildMinimalSaleNotice(order,items,
      role==='owner'?'Новая продажа вашего салона':'Новая продажа ХвостМаркета'));
  }
  const deliveries=[...byChat.values()];
  const settled=await Promise.allSettled(deliveries.map(item=>sendToChat(item.chat,item.text)));
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
  findManagerAndPoint,
};
