// payout-reminders.js — предпросмотр и отправка уведомления после того,
// как администратор фактически подтвердил выплату.
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');
const { sendMaxMessage } = require('./max-bot');
const { getUnpaidOrders } = require('./partner-payouts');
const { getOwnerUnpaidOrders } = require('./owner-payouts');
const { getTierProgress, TIERS } = require('./partner-tiers');

const TIME_ZONE = 'Asia/Krasnoyarsk';
const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function asDate(value) {
  if (value instanceof Date) return value;
  const raw = String(value || '');
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
}

function dateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(asDate(value || new Date()));
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
}

function dateLabel(value) {
  const parts = dateParts(value);
  return parts.day + ' ' + MONTHS_RU[parts.month - 1] + ' ' + parts.year;
}

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU') + ' ₽';
}

function cabinetUrl(pathname) {
  const base = String(process.env.PUBLIC_URL || process.env.SITE_URL || 'https://xn----7sbal3ajopsm.xn--p1ai').replace(/\/$/, '');
  return base + pathname;
}

function lowStockCount(pointId) {
  if (!pointId) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM stock s
    JOIN product_variants v ON v.id = s.variant_id AND v.active = 1
    JOIN products p ON p.id = v.product_id AND p.active = 1
    WHERE s.point_id = ? AND s.qty <= 2
  `).get(pointId);
  return Number(row.count || 0);
}

function summarize(orders) {
  const amount = orders.reduce((sum, order) => sum + Number(order.commission_amount || 0), 0);
  const revenue = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  return {
    amount,
    orders_count: orders.length,
    revenue,
    average_check: orders.length ? Math.round(revenue / orders.length) : 0,
  };
}

function partnerTierName(rate) {
  const tier = TIERS.find((item) => Math.abs(Number(item.rate) - Number(rate)) < 0.0001);
  return tier ? tier.name : 'Индивидуальный тариф';
}

function partnerMessage(partner, summary, paidAt) {
  const progress = getTierProgress(partner.id);
  const lines = [
    '✅ Выплата выполнена — ХвостМаркет',
    '',
    'Здравствуйте, ' + partner.full_name + '!',
    'Дата выплаты: ' + dateLabel(paidAt),
    '',
    'Выплачено: ' + money(summary.amount),
    'Учтено оплаченных заказов: ' + summary.orders_count,
    'Выручка этих заказов: ' + money(summary.revenue),
    'Средний чек: ' + money(summary.average_check),
    'Ваш уровень: ' + partnerTierName(partner.commission_rate) + ' · ' + Math.round(Number(partner.commission_rate || 0) * 100) + '%',
  ];
  if (progress && progress.nextTier) {
    lines.push(
      'До уровня «' + progress.nextTier.name + '» (' + Math.round(Number(progress.nextTier.rate) * 100) + '%): ' +
      money(progress.nextTier.revenueLeft) + ' выручки или ' + progress.nextTier.referralsLeft + ' приглашённых партнёров.'
    );
  } else if (progress) {
    lines.push('Вы на максимальном уровне комиссии.');
  }
  if (progress && progress.graceWarning) {
    lines.push('⚠️ Сейчас действует льготный месяц: без подтверждения показателей уровень снизится до «' + progress.graceWarning.willDropTo + '».');
  }
  const stockLow = lowStockCount(partner.point_id);
  if (stockLow > 0) {
    lines.push('📦 На точке заканчиваются ' + stockLow + ' поз. товара — проверьте остатки и отправьте заявку на пополнение.');
  }
  lines.push('', 'Открыть кабинет: ' + cabinetUrl('/taiga-groomer.html'));
  return lines.join('\n');
}

function ownerMessage(owner, summary, paidAt) {
  const month = db.prepare(`
    SELECT COUNT(*) AS orders_count, COALESCE(SUM(total), 0) AS revenue
    FROM orders
    WHERE point_id = ? AND status = 'paid'
      AND created_at >= datetime('now', 'start of month')
  `).get(owner.point_id);
  const unassigned = db.prepare(`
    SELECT COUNT(*) AS count
    FROM orders
    WHERE point_id = ? AND status = 'paid'
      AND partner_id IS NULL AND commission_rate IS NULL
      AND created_at >= datetime('now', 'start of month')
  `).get(owner.point_id);
  const lines = [
    '✅ Выплата выполнена — ХвостМаркет',
    '',
    'Здравствуйте, ' + owner.full_name + '!',
    'Дата выплаты: ' + dateLabel(paidAt),
    'Точка: ' + (owner.point_name || 'не указана'),
    '',
    'Выплачено: ' + money(summary.amount),
    'Ставка владельца: ' + Math.round(Number(owner.commission_rate || 0) * 100) + '%',
    'Учтено оплаченных заказов: ' + summary.orders_count,
    'Выручка этих заказов: ' + money(summary.revenue),
    'Средний чек: ' + money(summary.average_check),
    '',
    'За текущий месяц: ' + Number(month.orders_count || 0) + ' заказов · ' + money(month.revenue),
  ];
  if (Number(unassigned.count || 0) > 0) {
    lines.push('⚠️ Без указания грумера: ' + Number(unassigned.count) + ' заказов — их стоит проверить в админке.');
  }
  const stockLow = lowStockCount(owner.point_id);
  if (stockLow > 0) {
    lines.push('📦 На точке заканчиваются ' + stockLow + ' поз. товара — проверьте выкладку и остатки.');
  }
  lines.push('', 'Открыть кабинет: ' + cabinetUrl('/taiga-owner.html'));
  return lines.join('\n');
}

function getPartnerAccount(partnerId) {
  return db.prepare(`
    SELECT id, full_name, point_id, point_name, commission_rate,
           telegram_chat_id, max_chat_id
    FROM partners WHERE id = ?
  `).get(partnerId);
}

function getOwnerAccount(ownerId) {
  return db.prepare(`
    SELECT so.id, so.full_name, so.point_id, so.commission_rate,
           so.telegram_chat_id, so.max_chat_id, p.name AS point_name
    FROM salon_owners so
    LEFT JOIN points p ON p.id = so.point_id
    WHERE so.id = ?
  `).get(ownerId);
}

function previewPartnerPayout(partnerId) {
  const account = getPartnerAccount(partnerId);
  if (!account) return null;
  const summary = summarize(getUnpaidOrders(partnerId));
  return {
    recipient_name: account.full_name,
    amount: summary.amount,
    orders_count: summary.orders_count,
    channels: { telegram: !!account.telegram_chat_id, max: !!account.max_chat_id },
    message: partnerMessage(account, summary, new Date()),
  };
}

function previewOwnerPayout(ownerId) {
  const account = getOwnerAccount(ownerId);
  if (!account) return null;
  const summary = summarize(getOwnerUnpaidOrders(ownerId));
  return {
    recipient_name: account.full_name,
    amount: summary.amount,
    orders_count: summary.orders_count,
    channels: { telegram: !!account.telegram_chat_id, max: !!account.max_chat_id },
    message: ownerMessage(account, summary, new Date()),
  };
}

function paidPartnerSummary(payoutId) {
  const orders = db.prepare(`
    SELECT pi.commission_amount, o.total
    FROM partner_payout_items pi
    LEFT JOIN orders o ON o.id = pi.order_id
    WHERE pi.payout_id = ?
  `).all(payoutId);
  return summarize(orders);
}

function paidOwnerSummary(payoutId) {
  const orders = db.prepare(`
    SELECT pi.commission_amount, o.total
    FROM owner_payout_items pi
    LEFT JOIN orders o ON o.id = pi.order_id
    WHERE pi.payout_id = ?
  `).all(payoutId);
  return summarize(orders);
}

function telegramPlainText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function deliver(role, account, payoutId, channel, message) {
  const reservation = db.prepare(`
    INSERT OR IGNORE INTO payout_notification_log
      (recipient_role, recipient_id, payout_id, channel, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(role, account.id, payoutId, channel);
  if (!reservation.changes) return { channel, ok: false, skipped: true, error: 'Уведомление уже обрабатывалось' };

  let result;
  try {
    result = channel === 'telegram'
      ? await sendToChat(account.telegram_chat_id, telegramPlainText(message))
      : await sendMaxMessage(account.max_chat_id, message);
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  // Telegram возвращает { ok }, MAX при успехе возвращает сам объект
  // сообщения без поля ok, а при ошибке наш адаптер возвращает { ok:false }.
  const ok = channel === 'max'
    ? !!(result && result.ok !== false && !result.error)
    : !!(result && result.ok);
  const error = ok ? null : String((result && result.error) || 'Канал не настроен или не ответил').slice(0, 500);
  db.prepare(`
    UPDATE payout_notification_log
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE recipient_role = ? AND payout_id = ? AND channel = ?
  `).run(ok ? 'sent' : 'failed', error, ok ? 1 : 0, role, payoutId, channel);
  return { channel, ok, error };
}

async function sendPartnerPayoutNotification(partnerId, payout, approvedMessage) {
  const account = getPartnerAccount(partnerId);
  if (!account) return [];
  const message = approvedMessage || partnerMessage(account, paidPartnerSummary(payout.id), payout.paid_at);
  const deliveries = [];
  if (account.telegram_chat_id) deliveries.push(await deliver('partner', account, payout.id, 'telegram', message));
  if (account.max_chat_id) deliveries.push(await deliver('partner', account, payout.id, 'max', message));
  return deliveries;
}

async function sendOwnerPayoutNotification(ownerId, payout, approvedMessage) {
  const account = getOwnerAccount(ownerId);
  if (!account) return [];
  const message = approvedMessage || ownerMessage(account, paidOwnerSummary(payout.id), payout.paid_at);
  const deliveries = [];
  if (account.telegram_chat_id) deliveries.push(await deliver('owner', account, payout.id, 'telegram', message));
  if (account.max_chat_id) deliveries.push(await deliver('owner', account, payout.id, 'max', message));
  return deliveries;
}

module.exports = {
  previewOwnerPayout,
  previewPartnerPayout,
  sendOwnerPayoutNotification,
  sendPartnerPayoutNotification,
};
