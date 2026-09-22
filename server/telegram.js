// telegram.js — отправка уведомлений в Telegram с сервера. Здесь нет проблем
// мобильных сетей клиента — простой POST с разумным тайм-аутом, без всех
// костылей (GET/POST-фолбэк, keepalive), которые были нужны в браузере.
'use strict';

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptSend(text, targetChatId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, error: e.message };
  }
}

async function sendToChatWithRetry(targetChatId, text) {
  if (!TG_TOKEN || !targetChatId) {
    return { ok: false, skipped: true };
  }

  const startedAt = Date.now();
  let result = await attemptSend(text, targetChatId);
  const elapsedMs = Date.now() - startedAt;

  // Повторяем только при БЫСТРОМ сетевом сбое (запрос почти наверняка не
  // успел уйти дальше нашего сервера — DNS, обрыв соединения и т.п.).
  // Если сбой случился близко к 10-секундному тайм-ауту — сообщение могло
  // реально дойти до Telegram, просто ответ потерялся на обратном пути;
  // повтор в этом случае рискует задвоением уведомления, поэтому пропускаем.
  if (!result.ok && result.error && elapsedMs < 7000) {
    console.warn('Telegram: быстрый сетевой сбой (' + elapsedMs + ' мс), пробуем ещё раз через 2 сек —', result.error);
    await sleep(2000);
    result = await attemptSend(text, targetChatId);
  } else if (!result.ok && result.error) {
    console.warn('Telegram: сбой близко к тайм-ауту (' + elapsedMs + ' мс) — не повторяем, чтобы не задвоить сообщение —', result.error);
  }

  if (!result.ok) {
    console.error('Ошибка отправки в Telegram (после повтора):', result.error || JSON.stringify(result.data));
  }
  return result;
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn('Telegram не настроен (TG_TOKEN/TG_CHAT_ID пусты) — уведомление пропущено');
    return { ok: false, skipped: true };
  }
  return sendToChatWithRetry(TG_CHAT_ID, text);
}

// Отправка сообщения ПРОИЗВОЛЬНОМУ получателю (например, клиенту по его
// telegram_chat_id) — в отличие от sendTelegram() выше, который всегда пишет
// в фиксированный служебный чат владельца/команды.
async function sendToChat(chatId, text) {
  if (!TG_TOKEN) {
    console.warn('Telegram не настроен (TG_TOKEN пуст) — сообщение получателю пропущено');
    return { ok: false, skipped: true };
  }
  if (!chatId) return { ok: false, skipped: true, error: 'chat_id не указан' };
  return sendToChatWithRetry(chatId, text);
}

function buildOrderMessage(order, items) {
  const itemsText = items.map((i) =>
    (i.is_custom ? '✏️ [НЕ ИЗ КАТАЛОГА] ' : '• ') + i.name + ' (' + i.weight + ') × ' + i.qty + ' — ' + (i.price * i.qty) + ' ₽'
  ).join('\n');
  const hasCustom = items.some((i) => i.is_custom);
  const isHomeDelivery = order.fulfillment_type === 'home_delivery';
  const deliveryFlag = isHomeDelivery
    ? '🚚 <b>ДОСТАВКА НА ДОМ — курьером/своими силами!</b>\n\n'
    : (order.needs_delivery ? '🚚 <b>ТРЕБУЕТСЯ ДОВОЗ — этого веса нет на стойке!</b>\n\n' : '');
  const customFlag = hasCustom
    ? '✏️ <b>В ЗАКАЗЕ ЕСТЬ ТОВАР НЕ ИЗ КАТАЛОГА — сверьте название и цену при выдаче!</b>\n\n' : '';
  const commentLine = order.comment ? '💬 Пожелание: ' + order.comment + '\n' : '';
  const promoLine = order.promo_code ? '🏷 Промокод: ' + order.promo_code + '\n' : '';
  const bonesLine = order.bones_used > 0 ? '🦴 Оплачено косточками: ' + order.bones_used + ' ₽\n' : '';
  const deliveryFeeLine = isHomeDelivery ? '🚚 Доставка: ' + (order.delivery_fee > 0 ? order.delivery_fee + ' ₽' : 'бесплатно') + '\n' : '';
  // Самозаказ грумера — определяем по зафиксированной на заказе ставке 0%
  // (обычные тарифы партнёров — 15/18/20%, никогда не бывают нулевыми;
  // у заказов без привязки к партнёру ставка не 0, а null — не спутать).
  const selfOrderLine = order.commission_rate === 0
    ? '👤 <b>САМОЗАКАЗ ГРУМЕРА</b> — комиссия на этот заказ не начислена (0%, партнёр не платит себе сам), плюс грумер получит 10% кэшбэком косточками как клиент.\n'
    : '';
  const actionLine = (isHomeDelivery
    ? '→ Соберите заказ, передайте курьеру или отвезите по адресу сами, свяжитесь с клиентом для согласования времени.'
    : (order.needs_delivery
      ? '→ Привезите нужный вес на точку и свяжитесь с клиентом по телефону, когда товар будет готов к выдаче.'
      : ''));
  const customActionLine = hasCustom
    ? '→ Товар «не из каталога» — при первой возможности добавьте его в реальный каталог на сайте.'
    : '';
  const actionLines = [actionLine, customActionLine].filter(Boolean);

  return [
    deliveryFlag + customFlag + '💰 <b>Новая продажа — ХвостМаркет</b>',
    '',
    '📋 Заказ: ' + order.order_code,
    '👤 ' + (order.customer_name + ' ' + (order.customer_lname || '')).trim(),
    '📞 ' + order.customer_phone,
    (isHomeDelivery ? '🏠 Адрес доставки: ' + order.delivery_address : '📍 Точка: ' + order.pickup_point),
    '',
    itemsText,
    '',
    commentLine + promoLine + bonesLine + deliveryFeeLine + selfOrderLine + '💳 Оплата: ' + (
      order.payment_method === 'sbp' ? 'СБП'
        : (order.payment_method === 'bank_card' || order.payment_method === 'card') ? 'Карта (ЮKassa)'
          : 'ЮKassa'
    ),
    '💵 Сумма: ' + order.total + ' ₽',
    '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' }),
    ...(actionLines.length ? ['', ...actionLines] : []),
  ].join('\n');
}

module.exports = { sendTelegram, sendToChat, buildOrderMessage };
