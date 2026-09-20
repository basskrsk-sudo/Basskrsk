// routes-payment.js — создание платежа в ЮKassa, вебхук подтверждения,
// проверка статуса. Заказ создаётся сразу (status='pending'), остатки
// списываются и уведомление в Telegram уходит только после того, как
// вебхук подтвердит реальную оплату — не по клиентскому колбэку.
'use strict';

const db = require('./db');
const yookassa = require('./yookassa');
const { sendTelegram, buildOrderMessage } = require('./telegram');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');
const { recordCustomerOrder, normalizePhone } = require('./routes-customers');
const { spendBones, computeMaxUsableBones, getMaxBonesShare } = require('./bones');
const { sendEmail } = require('./email');
const { checkAndPayManagerBonus } = require('./bonus-logic');


// Если грумер покупает САМ У СЕБЯ на своей точке (тем же номером телефона,
// каким зарегистрирован как партнёр) — комиссия на этот конкретный заказ
// не его обычный уровень (15/18/20%), а 0%. Партнёр не платит себе
// комиссию сам себе — иначе Экспертный уровень (20%) в сочетании с
// максимальным кэшбэком клиенту (10% — грумерам он положен всегда, см.
// routes-customers.js) делает самозаказы слишком выгодной лазейкой для
// грумера и заметно режет маржу компании.
const SELF_ORDER_COMMISSION_RATE = 0;

function phonesMatchLast10(a, b) {
  const da = String(a || '').replace(/\D/g, '').slice(-10);
  const db_ = String(b || '').replace(/\D/g, '').slice(-10);
  return da.length === 10 && da === db_;
}

// Возвращает { rate, isSelfOrder } — ставку комиссии, которую нужно
// зафиксировать на ЭТОМ заказе, и признак самозаказа (для уведомления/лога).
// Смотрим на партнёра, который реально обслуживал заказ (partnerId, если
// клиент его выбрал — актуально для точек с несколькими грумерами), а если
// не выбирали — на единственного активного грумера точки.
function resolveOrderCommission(pointId, partnerId, customerPhone) {
  let partner = null;
  if (partnerId) {
    partner = db.prepare('SELECT phone, commission_rate FROM partners WHERE id = ?').get(partnerId);
  } else if (pointId) {
    partner = db.prepare('SELECT phone, commission_rate FROM partners WHERE point_id = ? AND active = 1 LIMIT 1').get(pointId);
  }
  if (!partner) return { rate: null, isSelfOrder: false };
  const isSelfOrder = phonesMatchLast10(partner.phone, customerPhone);
  return { rate: isSelfOrder ? SELF_ORDER_COMMISSION_RATE : partner.commission_rate, isSelfOrder };
}

// Определяет, чей уровень нужно проверить после этого заказа: если клиент
// явно выбрал грумера — только его; иначе, если на точке всего один активный
// партнёр — его (без неоднозначности); если несколько без явного выбора —
// никого не трогаем (не с кем однозначно связать эту продажу).
async function checkPartnerTierForOrder(pointId, partnerId) {
  const { checkAndUpgradePartnerTier } = require('./partner-tiers');
  if (partnerId) {
    await checkAndUpgradePartnerTier(partnerId);
    return;
  }
  if (!pointId) return;
  const solePartner = db.prepare('SELECT id FROM partners WHERE point_id = ? AND active = 1').all(pointId);
  if (solePartner.length === 1) await checkAndUpgradePartnerTier(solePartner[0].id);
}

// Раньше здесь был захардкожен список ['lapki','aibolit','bereg'] — задумывался
// как защита от мусорных/пустых point_id, но по факту блокировал списание
// остатков для ЛЮБОЙ точки за пределами исходных трёх (включая все новые
// точки, зарегистрированные позже, и точки в других городах). Проверяем
// реальное существование точки в базе — так защита работает как задумано,
// не блокируя настоящие точки.
function tryDecrementStock(pointId, itemName, itemWeight, qty) {
  if (!pointId) return;
  const pointExists = db.prepare('SELECT 1 FROM points WHERE id = ?').get(pointId);
  if (!pointExists) return;
  const product = db.prepare('SELECT id FROM products WHERE name = ?').get(itemName);
  if (!product) return;
  const variant = db.prepare(
    'SELECT id FROM product_variants WHERE product_id = ? AND weight = ?'
  ).get(product.id, itemWeight);
  if (!variant) return;
  const row = db.prepare('SELECT qty FROM stock WHERE variant_id = ? AND point_id = ?').get(variant.id, pointId);
  const newQty = Math.max(0, (row ? row.qty : 0) - qty);
  db.prepare('INSERT OR REPLACE INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)')
    .run(variant.id, pointId, newQty);
}

function registerPaymentRoutes(router) {
  // POST /api/create-payment — создаёт заказ (pending) и платёж в ЮKassa
  router.post('/api/create-payment', async (req, res, ctx) => {
    const {
      amount, description, orderId, method, receiptItems, customerPhone, customerEmail,
      customerName, customerLname, pickupPoint, pointId, partnerId, comment,
      subtotal, discount, promoCode, needsDelivery, cartItems,
      fulfillmentType, deliveryAddress, deliveryFee, referralCode, bonesUsed,
    } = ctx.body || {};

    if (!orderId || typeof amount !== 'number' || !customerPhone || !customerName ||
        !pickupPoint || !Array.isArray(cartItems) || cartItems.length === 0) {
      return sendJson(res, 400, {
        error: 'Заполните orderId, amount, customerName, customerPhone, pickupPoint и cartItems',
      });
    }
    if (fulfillmentType === 'home_delivery' && !deliveryAddress) {
      return sendJson(res, 400, { error: 'Укажите адрес доставки' });
    }

    // Фиксируем ставку комиссии партнёра прямо на заказе — 0% вместо
    // обычного уровня, если это самозаказ (см. комментарий у SELF_ORDER_COMMISSION_RATE выше).
    // Считаем ДО блока с косточками ниже — нужно знать isSelfOrder, чтобы
    // применить более строгий лимит списания для самозаказов (30% вместо 50%).
    const { rate: orderCommissionRate, isSelfOrder } = resolveOrderCommission(pointId, partnerId, customerPhone);
    if (isSelfOrder) {
      console.log(`[create-payment] Заказ ${orderId}: самозаказ грумера (телефон совпадает с партнёром точки) — комиссия зафиксирована на ${Math.round(orderCommissionRate * 100)}%`);
    }

    // ── КОСТОЧКИ ─────────────────────────────────────────────────────────
    // Списывать баланс можно только для авторизованного клиента, и только
    // свой собственный: иначе кто угодно мог бы потратить чужие косточки,
    // просто вписав чужой телефон в форму заказа (сам заказ по телефону
    // никак не подтверждается). Плюс сервер сам, независимо от фронтенда,
    // пересчитывает потолок списания — заказ не должен уйти ниже 1 ₽, даже
    // если косточек на счету больше, чем стоит заказ.
    let bonesToDeduct = 0;
    let bonesCustomerId = null;
    const requestedBones = typeof bonesUsed === 'number' ? Math.round(bonesUsed) : 0;
    if (requestedBones > 0) {
      const authPayload = tryAuth(['customer'])(req);
      if (!authPayload) {
        return sendJson(res, 401, { error: 'Чтобы оплатить косточками, войдите в личный кабинет' });
      }
      const bonesCustomer = db.prepare('SELECT id, phone, bones_balance FROM customers WHERE id = ?').get(authPayload.id);
      if (!bonesCustomer) return sendJson(res, 404, { error: 'Клиент не найден' });
      if (bonesCustomer.phone !== normalizePhone(customerPhone)) {
        return sendJson(res, 400, { error: 'Косточками можно оплатить заказ только на свой номер телефона' });
      }
      const amountBeforeBones =
        (typeof subtotal === 'number' ? subtotal : amount) -
        (typeof discount === 'number' ? discount : 0) +
        (typeof deliveryFee === 'number' ? deliveryFee : 0);
      const maxUsable = computeMaxUsableBones(bonesCustomer.bones_balance, amountBeforeBones, isSelfOrder);
      if (requestedBones > maxUsable) {
        const actualSharePercent = Math.round(getMaxBonesShare(amountBeforeBones) * 100);
        console.error(`[create-payment] Заказ ${orderId}: запрошено ${requestedBones} косточек, максимум разрешено ${maxUsable} (баланс ${bonesCustomer.bones_balance}, к оплате до списания ${amountBeforeBones} ₽, лимит ${actualSharePercent}% для этой суммы${isSelfOrder ? ' — самозаказ' : ''}) — заказ отклонён`);
        return sendJson(res, 400, { error: `Косточками нельзя списать больше допустимого (максимум ${actualSharePercent}% от суммы этого заказа, или на балансе недостаточно косточек). Обновите страницу и попробуйте снова.` });
      }
      bonesToDeduct = requestedBones;
      bonesCustomerId = bonesCustomer.id;
    }

    if (!yookassa.isConfigured()) {
      // Демо-режим (ключи ЮKassa ещё не заданы): реального платежа нет, но
      // заказ всё равно записываем как оплаченный сразу — это единственный
      // способ до одобрения ЮKassa протестировать остальную систему целиком
      // (админку, списание остатков, Telegram). Отвечаем кодом 200 с флагом
      // demo:true, а не 503 — коды ошибок 5xx может подменять встроенная
      // защита браузера (замечено в Яндекс.Браузере), из-за чего фронтенд
      // получал вместо JSON чужую HTML-страницу и заказ не завершался.
      const hasCustomDemo = cartItems.some((i) => i.isCustom);
      const demoInfo = db.prepare(`
        INSERT INTO orders
          (order_code, customer_name, customer_lname, customer_phone, customer_email, pickup_point, point_id, partner_id, comment,
           subtotal, discount, total, promo_code, payment_method, needs_delivery, has_custom_item,
           fulfillment_type, delivery_address, delivery_fee, referral_code, bones_used, commission_rate, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid')
      `).run(
        orderId, customerName, customerLname || null, customerPhone, customerEmail || null, pickupPoint, pointId || null, partnerId || null, comment || null,
        subtotal ?? amount, discount ?? 0, amount, promoCode || null, method || 'card',
        needsDelivery ? 1 : 0, hasCustomDemo ? 1 : 0,
        fulfillmentType || 'pickup', fulfillmentType === 'home_delivery' ? deliveryAddress : null, deliveryFee || 0,
        referralCode || null, bonesToDeduct, orderCommissionRate
      );
      const demoOrderId = demoInfo.lastInsertRowid;
      const insItemDemo = db.prepare(
        'INSERT INTO order_items (order_id, name, weight, price, qty, is_custom) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const item of cartItems) {
        insItemDemo.run(demoOrderId, item.name, item.weight, item.price, item.qty, item.isCustom ? 1 : 0);
        if (!needsDelivery && !item.isCustom && pointId) {
          tryDecrementStock(pointId, item.name, item.weight, item.qty);
        }
      }
      if (bonesToDeduct > 0 && bonesCustomerId) {
        const actuallySpent = spendBones(bonesCustomerId, bonesToDeduct, demoOrderId, 'Оплата заказа ' + orderId);
        if (actuallySpent < bonesToDeduct) {
          console.warn(`[create-payment] Заказ ${orderId}: списано ${actuallySpent} косточек вместо заявленных ${bonesToDeduct} — на балансе оказалось меньше`);
        }
      }
      const demoOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(demoOrderId);
      const demoItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(demoOrderId);
      recordCustomerOrder(customerPhone, customerName, customerLname, amount, customerEmail, referralCode, bonesToDeduct);
      if (pointId) {
        try {
          await checkAndPayManagerBonus(pointId);
        } catch (e) {
          console.error('[create-payment] checkAndPayManagerBonus упал:', e);
        }
      }
      try {
        await checkPartnerTierForOrder(pointId, partnerId);
      } catch (e) {
        console.error('[create-payment] checkPartnerTierForOrder упал:', e);
      }
      await sendTelegram('🧪 <b>ДЕМО-РЕЖИМ (ЮKassa ещё не подключена)</b>\n\n' + buildOrderMessage(demoOrder, demoItems));
      await sendEmail({
        subject: 'Новый заказ (демо) ' + demoOrder.order_code,
        text: '[ДЕМО-РЕЖИМ]\n\n' + buildOrderMessage(demoOrder, demoItems).replace(/<\/?b>/g, ''),
      });

      return sendJson(res, 200, { demo: true, order_id: demoOrderId });
    }

    const hasCustom = cartItems.some((i) => i.isCustom);
    const info = db.prepare(`
      INSERT INTO orders
        (order_code, customer_name, customer_lname, customer_phone, customer_email, pickup_point, point_id, partner_id, comment,
         subtotal, discount, total, promo_code, payment_method, needs_delivery, has_custom_item,
         fulfillment_type, delivery_address, delivery_fee, referral_code, bones_used, commission_rate, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId, customerName, customerLname || null, customerPhone, customerEmail || null, pickupPoint, pointId || null, partnerId || null, comment || null,
      subtotal ?? amount, discount ?? 0, amount, promoCode || null, method || 'card',
      needsDelivery ? 1 : 0, hasCustom ? 1 : 0,
      fulfillmentType || 'pickup', fulfillmentType === 'home_delivery' ? deliveryAddress : null, deliveryFee || 0,
      referralCode || null, bonesToDeduct, orderCommissionRate
    );
    const orderRowId = info.lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, name, weight, price, qty, is_custom) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const item of cartItems) {
      insItem.run(orderRowId, item.name, item.weight, item.price, item.qty, item.isCustom ? 1 : 0);
    }

    try {
      console.log(`[create-payment] Заказ ${orderId}: начинаем создание платежа в ЮKassa на ${amount} ₽`);
      const payment = await yookassa.createPayment({
        amount, description, orderCode: orderId, receiptItems, customerPhone, customerEmail, method,
      });
      console.log(`[create-payment] Заказ ${orderId}: платёж создан, payment_id=${payment.id}`);
      db.prepare('UPDATE orders SET yookassa_payment_id = ? WHERE id = ?').run(payment.id, orderRowId);
      sendJson(res, 201, {
        order_id: orderRowId,
        payment_id: payment.id,
        confirmation_token: payment.confirmation && payment.confirmation.confirmation_token,
      });
    } catch (e) {
      console.error(`[create-payment] Заказ ${orderId}: ОШИБКА создания платежа — ${e.message}`);
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderRowId);
      sendJson(res, e.statusCode || 502, { error: e.message });
    }
  });

  // GET /api/payment-status/:id — фронтенд перепроверяет статус после события "success" виджета
  router.get('/api/payment-status/:id', (req, res, ctx) => {
    const order = db.prepare('SELECT status FROM orders WHERE yookassa_payment_id = ?').get(ctx.params.id);
    sendJson(res, 200, { paid: !!order && order.status === 'paid', status: order ? order.status : 'unknown' });
  });

  // POST /api/yookassa-webhook — ЮKassa уведомляет о смене статуса платежа
  router.post('/api/yookassa-webhook', async (req, res, ctx) => {
    const object = ctx.body && ctx.body.object;
    if (!object || !object.id) return sendJson(res, 400, { error: 'Некорректное тело вебхука' });

    // Не доверяем телу вебхука напрямую — переспрашиваем статус у самой ЮKassa.
    let verified;
    try {
      verified = await yookassa.getPayment(object.id);
    } catch (e) {
      return sendJson(res, 502, { error: 'Не удалось проверить платёж у ЮKassa' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE yookassa_payment_id = ?').get(object.id);
    if (!order) return sendJson(res, 404, { error: 'Заказ для этого платежа не найден' });

    if (verified.status === 'succeeded' && order.status !== 'paid') {
      db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(order.id);
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      if (!order.needs_delivery && order.point_id) {
        for (const item of items) {
          if (!item.is_custom) tryDecrementStock(order.point_id, item.name, item.weight, item.qty);
        }
      }
      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      recordCustomerOrder(updatedOrder.customer_phone, updatedOrder.customer_name, updatedOrder.customer_lname, updatedOrder.total, updatedOrder.customer_email, updatedOrder.referral_code, updatedOrder.bones_used);
      // Косточки списываются только сейчас, при подтверждённой оплате (не при
      // создании 'pending'-заказа) — так же, как остатки на складе: если
      // платёж не завершится, ничего не спишется.
      if (updatedOrder.bones_used > 0) {
        const bonesCustomer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(normalizePhone(updatedOrder.customer_phone));
        if (bonesCustomer) {
          const actuallySpent = spendBones(bonesCustomer.id, updatedOrder.bones_used, updatedOrder.id, 'Оплата заказа ' + updatedOrder.order_code);
          if (actuallySpent < updatedOrder.bones_used) {
            console.warn(`[webhook] Заказ ${updatedOrder.order_code}: списано ${actuallySpent} косточек вместо заявленных ${updatedOrder.bones_used} — на балансе оказалось меньше`);
          }
        }
      }
      if (updatedOrder.point_id) await checkAndPayManagerBonus(updatedOrder.point_id);
      await checkPartnerTierForOrder(updatedOrder.point_id, updatedOrder.partner_id);
      await sendTelegram(buildOrderMessage(updatedOrder, items));
      await sendEmail({
        subject: 'Новый заказ ' + updatedOrder.order_code,
        text: buildOrderMessage(updatedOrder, items).replace(/<\/?b>/g, ''),
      });
    } else if (verified.status === 'canceled') {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
    }

    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPaymentRoutes };
