// routes-payment.js — создание платежа в ЮKassa, вебхук подтверждения,
// проверка статуса. Заказ создаётся сразу (status='pending'), товар и
// косточки резервируются на 15 минут, а уведомление уходит только после
// подтверждения реальной оплаты вебхуком — не по клиентскому колбэку.
'use strict';

const db = require('./db');
const yookassa = require('./yookassa');
const { sendTelegram, buildOrderMessage } = require('./telegram');
const { sendPaidOrderNotifications } = require('./order-notifications');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');
const { recordCustomerOrder, normalizePhone } = require('./routes-customers');
const { spendBones, computeMaxUsableBones, getMaxBonesShare } = require('./bones');
const { sendEmail } = require('./email');
const { checkAndPayManagerBonus } = require('./bonus-logic');
const { priceCatalogCart, calculateDeliveryFee, buildReceiptItems } = require('./order-pricing');
const {
  RESERVATION_TTL_MINUTES,
  newReservationExpiry,
  withImmediateTransaction,
  resolveInventorySource,
  reserveForOrder,
  releaseOrderReservation,
  consumeOrderReservation,
  listExpiredActiveReservations,
} = require('./reservations');


// Если грумер покупает САМ У СЕБЯ на своей точке (тем же номером телефона,
// каким зарегистрирован как партнёр) — комиссия на этот конкретный заказ
// не его обычный уровень (15/18/20%), а 0%. Партнёр не платит себе
// комиссию сам себе — иначе Экспертный уровень (20%) в сочетании с
// максимальным кэшбэком клиенту (10% — грумерам он положен всегда, см.
// routes-customers.js) делает самозаказы слишком выгодной лазейкой для
// грумера и заметно режет маржу компании.
const SELF_ORDER_COMMISSION_RATE = 0;

// Оплаченный демо-заказ опасен как неявный запасной сценарий: отсутствие или
// опечатка в ключах ЮKassa не должны превращать неоплаченный заказ в продажу.
// Тестовый режим включается только явно и только точным значением true.
function isDemoModeEnabled() {
  return process.env.DEMO_MODE === 'true';
}

function paymentReturnUrl(req, orderCode) {
  const configuredBase = String(process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (configuredBase) return configuredBase + '/?payment_return=' + encodeURIComponent(orderCode);

  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(forwardedHost) ? forwardedHost : 'xn----7sbal3ajopsm.xn--p1ai';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : (safeHost.includes('localhost') || safeHost.startsWith('127.') ? 'http' : 'https');
  return `${protocol}://${safeHost}/?payment_return=${encodeURIComponent(orderCode)}`;
}

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

// Раньше здесь был захардкожен демонстрационный список точек — задумывался
// как защита от мусорных/пустых point_id, но по факту блокировал списание
// остатков для ЛЮБОЙ точки за пределами исходных трёх (включая все новые
// точки, зарегистрированные позже, и точки в других городах). Проверяем
// реальное существование точки в базе — так защита работает как задумано,
// не блокируя настоящие точки.
function tryDecrementStock(pointId, variantId, qty, legacyName, legacyWeight) {
  if (!pointId) return;
  const pointExists = db.prepare('SELECT 1 FROM points WHERE id = ?').get(pointId);
  if (!pointExists) return;
  let variant = variantId
    ? db.prepare('SELECT id FROM product_variants WHERE id = ?').get(variantId)
    : null;
  // Заказы, которые уже ожидали оплаты в момент обновления сайта, могли быть
  // созданы до появления order_items.variant_id. Для них один раз используем
  // старую безопасную привязку name+weight, чтобы вебхук всё ещё списал товар.
  if (!variant && legacyName && legacyWeight) {
    variant = db.prepare(`
      SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.name = ? AND v.weight = ?
    `).get(legacyName, legacyWeight);
  }
  if (!variant) return;
  const row = db.prepare('SELECT qty FROM stock WHERE variant_id = ? AND point_id = ?').get(variant.id, pointId);
  const newQty = Math.max(0, (row ? row.qty : 0) - qty);
  db.prepare('INSERT OR REPLACE INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)')
    .run(variant.id, pointId, newQty);
}

function createReservedOrder(orderData, pricedItems, inventorySource, bonesCustomerId) {
  return withImmediateTransaction(() => {
    const info = db.prepare(`
      INSERT INTO orders
        (order_code, customer_name, customer_lname, customer_phone, customer_email, pickup_point, point_id, partner_id, partner_name, comment,
         subtotal, discount, total, promo_code, payment_method, needs_delivery, has_custom_item,
         fulfillment_type, delivery_address, delivery_fee, referral_code, bones_used, commission_rate, status,
         reservation_status, reservation_expires_at, inventory_source_type, inventory_source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', ?, ?, ?)
    `).run(
      orderData.orderId, orderData.customerName, orderData.customerLname || null,
      orderData.customerPhone, orderData.customerEmail || null, orderData.pickupPoint,
      orderData.pointId || null, orderData.partnerId || null, orderData.partnerName || null, orderData.comment || null,
      orderData.subtotal, 0, orderData.total, orderData.promoCode || null,
      orderData.method || 'yookassa', orderData.needsDelivery ? 1 : 0, 0,
      orderData.fulfillmentType, orderData.deliveryAddress || null, orderData.deliveryFee,
      orderData.referralCode || null, orderData.bonesUsed, orderData.commissionRate,
      newReservationExpiry(), inventorySource.type, inventorySource.id
    );
    const orderRowId = info.lastInsertRowid;
    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, variant_id, name, weight, price, qty, is_custom) VALUES (?, ?, ?, ?, ?, ?, 0)'
    );
    for (const item of pricedItems) {
      insertItem.run(orderRowId, item.variantId, item.name, item.weight, item.price, item.qty);
    }
    reserveForOrder(orderRowId, inventorySource, pricedItems, bonesCustomerId, orderData.bonesUsed);
    return orderRowId;
  });
}

async function runPaidOrderSideEffects(order, items, demo = false) {
  recordCustomerOrder(
    order.customer_phone, order.customer_name, order.customer_lname, order.total,
    order.customer_email, order.referral_code, order.bones_used
  );
  if (order.point_id) {
    try {
      await checkAndPayManagerBonus(order.point_id);
    } catch (e) {
      console.error('[paid-order] checkAndPayManagerBonus упал:', e);
    }
  }
  try {
    await checkPartnerTierForOrder(order.point_id, order.partner_id);
  } catch (e) {
    console.error('[paid-order] checkPartnerTierForOrder упал:', e);
  }
  const prefix = demo ? '🧪 <b>ДЕМО-РЕЖИМ</b>\n\n' : '';
  // Служебный чат, email и три персональных Telegram-уведомления независимы:
  // сбой одного канала не отменяет оплаченную продажу и не блокирует другие.
  const notificationResults = await Promise.allSettled([
    sendTelegram(prefix + buildOrderMessage(order, items)),
    sendEmail({
      subject: (demo ? 'Новый заказ (демо) ' : 'Новый заказ ') + order.order_code,
      text: (demo ? '[ДЕМО-РЕЖИМ]\n\n' : '') + buildOrderMessage(order, items).replace(/<\/?b>/g, ''),
    }),
    sendPaidOrderNotifications(order, items),
  ]);
  ['служебный Telegram', 'email', 'персональный Telegram'].forEach((channel, index) => {
    const result = notificationResults[index];
    if (result.status === 'rejected') {
      console.error('[paid-order] Канал «' + channel + '» завершился ошибкой:', result.reason && result.reason.message);
    }
  });
}

// Идемпотентно завершает оплаченный заказ. Для pending-заказов, созданных до
// появления резервов, оставлен прежний путь списания — обновление не ломает
// платёж, который уже был открыт в браузере на момент деплоя.
async function finalizePaidOrder(orderId, demo = false) {
  const before = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!before || before.status === 'paid') return false;

  let finalized;
  if (before.reservation_status === 'active') {
    finalized = consumeOrderReservation(before.id);
    if (!finalized.consumed) return false;
  } else if (before.reservation_status === 'none') {
    finalized = withImmediateTransaction(() => {
      const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(before.id);
      if (!current || current.status === 'paid') return { consumed: false };
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(current.id);
      if (!current.needs_delivery && current.point_id) {
        for (const item of items) {
          if (!item.is_custom) tryDecrementStock(current.point_id, item.variant_id, item.qty, item.name, item.weight);
        }
      }
      if (current.bones_used > 0) {
        const customer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(normalizePhone(current.customer_phone));
        if (customer) spendBones(customer.id, current.bones_used, current.id, 'Оплата заказа ' + current.order_code);
      }
      db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(current.id);
      return {
        consumed: true,
        order: db.prepare('SELECT * FROM orders WHERE id = ?').get(current.id),
        items,
      };
    });
    if (!finalized.consumed) return false;
  } else {
    console.error(`[paid-order] Заказ ${before.order_code}: платёж успешен, но резерв уже ${before.reservation_status}`);
    return false;
  }

  await runPaidOrderSideEffects(finalized.order, finalized.items, demo);
  return true;
}

let reservationCleanupStarted = false;
async function reconcileExpiredReservations() {
  const expired = listExpiredActiveReservations();
  for (const order of expired) {
    try {
      if (!order.yookassa_payment_id) {
        releaseOrderReservation(order.id, 'failed');
        continue;
      }
      if (!yookassa.isConfigured()) {
        console.warn(`[reservations] Заказ ${order.order_code}: ключи ЮKassa недоступны, резерв сохранён до безопасной сверки платежа`);
        continue;
      }
      let payment = await yookassa.getPayment(order.yookassa_payment_id);
      if (payment.status === 'succeeded') {
        await finalizePaidOrder(order.id);
        continue;
      }
      if (payment.status !== 'canceled') {
        payment = await yookassa.cancelPayment(order.yookassa_payment_id);
      }
      if (payment.status === 'canceled') {
        releaseOrderReservation(order.id, 'failed');
      }
    } catch (e) {
      // При сетевой ошибке резерв намеренно остаётся активным: освобождать
      // товар до подтверждённой отмены опаснее, чем подержать его дольше.
      console.warn(`[reservations] Не удалось сверить/освободить заказ ${order.order_code}: ${e.message}`);
    }
  }
}

function startReservationCleanup() {
  if (reservationCleanupStarted) return;
  reservationCleanupStarted = true;
  const firstRun = setTimeout(() => { reconcileExpiredReservations().catch(() => {}); }, 5000);
  const interval = setInterval(() => { reconcileExpiredReservations().catch(() => {}); }, 60 * 1000);
  if (typeof firstRun.unref === 'function') firstRun.unref();
  if (typeof interval.unref === 'function') interval.unref();
}

function registerPaymentRoutes(router) {
  startReservationCleanup();
  // POST /api/create-payment — создаёт заказ (pending) и платёж в ЮKassa
  router.post('/api/create-payment', async (req, res, ctx) => {
    const {
      amount, orderId, method, customerPhone, customerEmail,
      customerName, customerLname, pickupPoint, pointId, partnerId, comment,
      promoCode, cartItems,
      fulfillmentType, deliveryAddress, cityId, referralCode, bonesUsed,
      confirmationMode,
    } = ctx.body || {};

    if (!orderId || typeof amount !== 'number' || !customerPhone ||
        !pickupPoint || !Array.isArray(cartItems) || cartItems.length === 0) {
      return sendJson(res, 400, {
        error: 'Заполните orderId, amount, customerPhone, pickupPoint и cartItems',
      });
    }
    if (fulfillmentType === 'home_delivery' && !deliveryAddress) {
      return sendJson(res, 400, { error: 'Укажите адрес доставки' });
    }

    // Браузер не является источником цены. Получаем каждую фасовку заново из
    // базы, игнорируем присланные name/weight/price/subtotal/discount и только
    // после этого рассчитываем доставку, косточки и сумму платежа.
    let pricedCart;
    try {
      pricedCart = priceCatalogCart(cartItems);
    } catch (e) {
      return sendJson(res, e.statusCode || 400, { error: e.message, code: e.code || 'PRICING_ERROR' });
    }
    const authoritativeFulfillment = fulfillmentType === 'home_delivery' ? 'home_delivery' : 'pickup';
    const authoritativeDeliveryFee = calculateDeliveryFee(authoritativeFulfillment, pricedCart.subtotal);
    // Довоз недостающего веса в точку больше не предлагается. Не доверяем
    // устаревшим клиентам, которые ещё могут прислать needsDelivery=true.
    const authoritativeNeedsDelivery = false;

    let authoritativePickupPoint = pickupPoint;
    if (authoritativeFulfillment === 'home_delivery') {
      authoritativePickupPoint = 'Доставка на дом — ' + String(deliveryAddress).trim();
    } else if (pointId) {
      const point = db.prepare('SELECT id, name, addr FROM points WHERE id = ? AND active = 1').get(pointId);
      if (!point) return sendJson(res, 400, { error: 'Выбранная точка не найдена или временно не работает', code: 'POINT_UNAVAILABLE' });
      authoritativePickupPoint = point.name + (point.addr ? ' — ' + point.addr : '');
    }
    let selectedPartnerName = null;
    if (partnerId) {
      const selectedPartner = db.prepare('SELECT id, point_id, full_name FROM partners WHERE id = ? AND active = 1').get(partnerId);
      if (!selectedPartner || !pointId || selectedPartner.point_id !== pointId) {
        return sendJson(res, 400, { error: 'Выбранный сотрудник не работает на этой точке', code: 'PARTNER_POINT_MISMATCH' });
      }
      selectedPartnerName = selectedPartner.full_name;
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
      const amountBeforeBones = pricedCart.subtotal + authoritativeDeliveryFee;
      const maxUsable = computeMaxUsableBones(bonesCustomer.bones_balance, amountBeforeBones, isSelfOrder);
      if (requestedBones > maxUsable) {
        const actualSharePercent = Math.round(getMaxBonesShare(amountBeforeBones) * 100);
        console.error(`[create-payment] Заказ ${orderId}: запрошено ${requestedBones} косточек, максимум разрешено ${maxUsable} (баланс ${bonesCustomer.bones_balance}, к оплате до списания ${amountBeforeBones} ₽, лимит ${actualSharePercent}% для этой суммы${isSelfOrder ? ' — самозаказ' : ''}) — заказ отклонён`);
        return sendJson(res, 400, { error: `Косточками нельзя списать больше допустимого (максимум ${actualSharePercent}% от суммы этого заказа, или на балансе недостаточно косточек). Обновите страницу и попробуйте снова.` });
      }
      bonesToDeduct = requestedBones;
      bonesCustomerId = bonesCustomer.id;
    }

    const authoritativeAmount = pricedCart.subtotal + authoritativeDeliveryFee - bonesToDeduct;
    if (!Number.isSafeInteger(authoritativeAmount) || authoritativeAmount < 1) {
      return sendJson(res, 400, { error: 'Некорректная итоговая сумма заказа', code: 'INVALID_ORDER_TOTAL' });
    }
    // amount теперь только контрольное ожидание клиента. Если цена успела
    // измениться после загрузки каталога, не списываем неожиданную сумму —
    // просим обновить корзину и явно подтвердить новый итог.
    if (Math.round(amount * 100) !== authoritativeAmount * 100) {
      return sendJson(res, 409, {
        error: 'Цена заказа изменилась. Корзина обновлена — проверьте новый итог и подтвердите оплату ещё раз.',
        code: 'ORDER_TOTAL_CHANGED',
        pricing: { subtotal: pricedCart.subtotal, deliveryFee: authoritativeDeliveryFee, bonesUsed: bonesToDeduct, total: authoritativeAmount, items: pricedCart.items },
      });
    }
    const bonesAgainstGoods = Math.min(bonesToDeduct, pricedCart.subtotal);
    const adjustedGoodsTotal = pricedCart.subtotal - bonesAgainstGoods;
    const adjustedDeliveryFee = authoritativeDeliveryFee - (bonesToDeduct - bonesAgainstGoods);
    const authoritativeReceiptItems = buildReceiptItems(pricedCart.items, adjustedGoodsTotal, adjustedDeliveryFee);

    if (!yookassa.isConfigured() && !isDemoModeEnabled()) {
      console.error(`[create-payment] Заказ ${orderId}: оплата заблокирована — ЮKassa не настроена, DEMO_MODE выключен`);
      return sendJson(res, 503, {
        error: 'Оплата временно недоступна. Мы уже занимаемся настройкой — попробуйте позже.',
        code: 'PAYMENT_NOT_CONFIGURED',
      });
    }

    let inventorySource;
    try {
      inventorySource = resolveInventorySource({
        fulfillmentType: authoritativeFulfillment,
        pointId,
        needsDelivery: authoritativeNeedsDelivery,
        cityId,
      });
    } catch (e) {
      return sendJson(res, e.statusCode || 409, { error: e.message, code: e.code || 'RESERVATION_ERROR', details: e.details });
    }

    let orderRowId;
    try {
      orderRowId = createReservedOrder({
        orderId, customerName: String(customerName || 'Клиент').trim() || 'Клиент', customerLname, customerPhone, customerEmail,
        pickupPoint: authoritativePickupPoint, pointId, partnerId, partnerName: selectedPartnerName, comment,
        subtotal: pricedCart.subtotal, total: authoritativeAmount, promoCode, method,
        needsDelivery: authoritativeNeedsDelivery, fulfillmentType: authoritativeFulfillment,
        deliveryAddress: authoritativeFulfillment === 'home_delivery' ? String(deliveryAddress).trim() : null,
        deliveryFee: authoritativeDeliveryFee, referralCode, bonesUsed: bonesToDeduct,
        commissionRate: orderCommissionRate,
      }, pricedCart.items, inventorySource, bonesCustomerId);
    } catch (e) {
      console.warn(`[create-payment] Заказ ${orderId}: резерв не создан — ${e.message}`);
      return sendJson(res, e.statusCode || 409, { error: e.message, code: e.code || 'RESERVATION_ERROR', details: e.details });
    }

    if (!yookassa.isConfigured() && isDemoModeEnabled()) {
      // Явный тестовый режим проходит через ту же атомарную логику резерва,
      // после чего сразу превращает резерв в оплаченное списание.
      await finalizePaidOrder(orderRowId, true);
      return sendJson(res, 200, { demo: true, order_id: orderRowId });
    }

    try {
      console.log(`[create-payment] Заказ ${orderId}: начинаем создание платежа в ЮKassa на ${authoritativeAmount} ₽`);
      const payment = await yookassa.createPayment({
        amount: authoritativeAmount,
        description: 'Заказ ХвостМаркет ' + orderId,
        orderCode: orderId,
        receiptItems: authoritativeReceiptItems,
        customerPhone,
        customerEmail,
        method,
        confirmationMode: confirmationMode === 'redirect' ? 'redirect' : 'embedded',
        returnUrl: paymentReturnUrl(req, orderId),
      });
      console.log(`[create-payment] Заказ ${orderId}: платёж создан, payment_id=${payment.id}`);
      db.prepare('UPDATE orders SET yookassa_payment_id = ? WHERE id = ?').run(payment.id, orderRowId);
      sendJson(res, 201, {
        order_id: orderRowId,
        payment_id: payment.id,
        confirmation_token: payment.confirmation && payment.confirmation.confirmation_token,
        confirmation_url: payment.confirmation && payment.confirmation.confirmation_url,
        reservation_expires_at: db.prepare('SELECT reservation_expires_at FROM orders WHERE id = ?').get(orderRowId).reservation_expires_at,
        reservation_minutes: RESERVATION_TTL_MINUTES,
      });
    } catch (e) {
      console.error(`[create-payment] Заказ ${orderId}: ОШИБКА создания платежа — ${e.message}`);
      releaseOrderReservation(orderRowId, 'failed', 'Платёж не удалось создать — резерв освобождён');
      sendJson(res, e.statusCode || 502, { error: e.message });
    }
  });

  // GET /api/payment-status/:id — фронтенд перепроверяет статус после события
  // success виджета. Если вебхук ещё не успел прийти, сами сверяем платёж с
  // ЮKassa и завершаем заказ. Экран «Оплата прошла» нельзя показывать только
  // по клиентскому событию — исключительно после статуса paid на сервере.
  router.get('/api/payment-status/:id', async (req, res, ctx) => {
    let order = db.prepare('SELECT * FROM orders WHERE yookassa_payment_id = ?').get(ctx.params.id);
    if (!order) return sendJson(res, 200, { paid: false, status: 'unknown' });

    if (order.status === 'pending' && yookassa.isConfigured()) {
      try {
        const payment = await yookassa.getPayment(ctx.params.id);
        if (payment.status === 'succeeded') {
          await finalizePaidOrder(order.id);
        } else if (payment.status === 'canceled') {
          releaseOrderReservation(order.id, 'failed', 'Платёж отменён — резерв освобождён');
          if (order.reservation_status === 'none') {
            db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(order.id);
          }
        }
        order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      } catch (e) {
        // Временный сбой ЮKassa не превращаем в неуспешную оплату: фронтенд
        // продолжит опрос, а вебхук остаётся вторым независимым каналом.
        console.warn(`[payment-status] Не удалось сверить платёж ${ctx.params.id}: ${e.message}`);
      }
    }

    sendJson(res, 200, {
      paid: order.status === 'paid',
      status: order.status,
      order_code: order.order_code,
    });
  });

  // Возврат с резервной страницы ЮKassa содержит только код заказа. Не отдаём
  // публично ни телефон, ни сумму, ни выбранную точку — только результат.
  router.get('/api/order-payment-status/:orderCode', async (req, res, ctx) => {
    let order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(ctx.params.orderCode);
    if (!order) return sendJson(res, 404, { error: 'Заказ не найден' });

    if (order.status === 'pending' && order.yookassa_payment_id && yookassa.isConfigured()) {
      try {
        const payment = await yookassa.getPayment(order.yookassa_payment_id);
        if (payment.status === 'succeeded') {
          await finalizePaidOrder(order.id);
        } else if (payment.status === 'canceled') {
          releaseOrderReservation(order.id, 'failed', 'Платёж отменён — резерв освобождён');
        }
        order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      } catch (e) {
        console.warn(`[order-payment-status] Не удалось сверить заказ ${order.order_code}: ${e.message}`);
      }
    }

    sendJson(res, 200, {
      paid: order.status === 'paid',
      status: order.status,
      order_code: order.order_code,
    });
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

    // Обычно находим по payment_id. Фолбэк по metadata.order_code закрывает
    // редкую гонку, когда вебхук пришёл сразу после ответа ЮKassa, но раньше,
    // чем сервер успел сохранить payment_id в заказ.
    const verifiedOrderCode = verified.metadata && verified.metadata.order_code;
    const order = db.prepare('SELECT * FROM orders WHERE yookassa_payment_id = ?').get(object.id)
      || (verifiedOrderCode ? db.prepare('SELECT * FROM orders WHERE order_code = ?').get(verifiedOrderCode) : null);
    if (!order) return sendJson(res, 404, { error: 'Заказ для этого платежа не найден' });
    if (!order.yookassa_payment_id) {
      db.prepare('UPDATE orders SET yookassa_payment_id = ? WHERE id = ?').run(object.id, order.id);
    }

    if (verified.status === 'succeeded' && order.status !== 'paid') {
      await finalizePaidOrder(order.id);
    } else if (verified.status === 'canceled') {
      releaseOrderReservation(order.id, 'failed', 'Платёж отменён — резерв освобождён');
      if (order.reservation_status === 'none') {
        db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(order.id);
      }
    }

    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPaymentRoutes };
