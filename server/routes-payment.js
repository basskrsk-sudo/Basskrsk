// routes-payment.js — создание платежа в ЮKassa, вебхук подтверждения,
// проверка статуса. Заказ создаётся сразу (status='pending'), товар и
// косточки резервируются на 1 минуту до платежа (3 минуты после его создания),
// а уведомление уходит только после
// подтверждения реальной оплаты вебхуком — не по клиентскому колбэку.
'use strict';

const db = require('./db');
const { trackAsync } = require('./runtime-diagnostics');
const {enqueuePaidClubSale,signalPaidClubSaleQueued}=require('./partner-club-sale-outbox');
const { readExpiredReservationsBatch, readEarliestReservationExpiry } = require('./reservation-cleanup-reader');
const { createReservationCleanupScheduler } = require('./reservation-cleanup-scheduler');
const { createSingleFlightJob } = require('./single-flight-job');
const { assignDisplayNumber } = require('./order-display-number');
const { resolveCheckoutGroomer } = require('./auto-groomer');
const yookassa = require('./yookassa');
const { matchesQrPaymentRetry } = require('./qr-payment-retry');
const { storedQrPaymentArgs } = require('./qr-payment-recovery');
const { redirectPaymentPath, paymentMatchesOrder, redirectContinuation } = require('./redirect-payment-capability');
const { sendTelegram, buildOrderMessage } = require('./telegram');
const { sendPaidOrderNotifications } = require('./order-notifications');
const { sendSuperadminSaleProfit } = require('./superadmin-sale-profit');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');
const { recordCustomerOrder, normalizePhone } = require('./routes-customers');
const { spendBones, computeMaxUsableBones, getMaxBonesShare } = require('./bones');
const { sendEmail } = require('./email');
const { checkAndPayManagerBonus } = require('./bonus-logic');
const { sendUnpaidOrderAlert, wakeUnpaidOrderAlertScheduler } = require('./unpaid-order-alerts');
const { priceCatalogCart, calculateDeliveryFee, buildReceiptItems } = require('./order-pricing');
const {
  getFirstPurchasePromoPolicy,
  validateFirstPurchasePromo,
  claimFirstPurchasePromo,
} = require('./first-purchase-promo');
const {
  RESERVATION_TTL_MINUTES,
  newReservationExpiry,
  withImmediateTransaction,
  resolveInventorySource,
  reserveForOrder,
  releaseOrderReservation,
  consumeOrderReservation,
} = require('./reservations');

// A competing SQLite writer is not an inventory or pricing rejection.
function isCheckoutStorageBusy(error) {
  const sqliteCode=Number(error?.errcode);
  return (Number.isInteger(sqliteCode)&&[5,6].includes(sqliteCode&255))||
    /^SQLITE_(BUSY|LOCKED)(_|$)/.test(String(error?.code||''));
}

function releaseFailedOrderAndAlert(orderId, reason) {
  const result = releaseOrderReservation(orderId, 'failed', reason);
  sendUnpaidOrderAlert(orderId, 'failed', reason).catch((error) => {
    console.warn('[unpaid-order] Не удалось обработать срочное оповещение:', error.message);
  });
  return result;
}


// Самозаказ определяется сервером по телефону активного грумера выбранной
// точки. С действительным промокодом первой покупки комиссия равна 0;
// без него применяется обычная ставка. Косточки всегда отключены.

// Оплаченный демо-заказ опасен как неявный запасной сценарий: отсутствие или
// опечатка в ключах ЮKassa не должны превращать неоплаченный заказ в продажу.
// Тестовый режим включается только явно и только точным значением true.
function isDemoModeEnabled() {
  return process.env.DEMO_MODE === 'true';
}

function paymentReturnUrl(req, orderCode, requestedPath) {
  const configuredBase = String(process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  // Быстрая покупка по товарному QR должна вернуться на тот же товар и ту же
  // точку. Принимаем только внутренний путь строгого формата /p/X/Y — полный
  // URL или произвольный путь отклоняется, поэтому open redirect невозможен.
  const candidate = String(requestedPath || '');
  const safePath = candidate === '/miniapp.html'
    ? candidate
    : (/^\/p\/[-A-Za-z0-9._~%]+\/[-A-Za-z0-9._~%]+\/?$/.test(candidate) ? candidate : '/');
  if (configuredBase) return configuredBase + safePath + '?payment_return=' + encodeURIComponent(orderCode);

  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(forwardedHost) ? forwardedHost : 'xn--80adktilqfjfx.xn--p1ai';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : (safeHost.includes('localhost') || safeHost.startsWith('127.') ? 'http' : 'https');
  return `${protocol}://${safeHost}${safePath}?payment_return=${encodeURIComponent(orderCode)}`;
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
function resolveOrderCommission(pointId, partnerId, customerPhone, advisorSelection, firstPurchasePromoApplied = false) {
  let partner = null;
  if (partnerId) {
    partner = db.prepare('SELECT phone, commission_rate FROM partners WHERE id = ?').get(partnerId);
  } else if (advisorSelection === 'self') {
    // Клиент явно указал, что выбрал товар самостоятельно: не приписываем
    // рекомендацию единственному сотруднику точки и фиксируем 0%, чтобы в
    // истории это не смешивалось со старыми заказами без атрибуции.
    return { rate: 0, isSelfOrder: false };
  } else if (pointId) {
    const pointPartners = db.prepare(
      'SELECT phone, commission_rate FROM partners WHERE point_id = ? AND active = 1 LIMIT 2'
    ).all(pointId);
    // Без выбора клиента ставку можно однозначно связать с партнёром только
    // когда он на точке один. При нескольких не выбираем первого случайно.
    partner = pointPartners.length === 1 ? pointPartners[0] : null;
  }
  if (!partner) return { rate: null, isSelfOrder: false };
  const isSelfOrder = phonesMatchLast10(partner.phone, customerPhone);
  return { rate: isSelfOrder && firstPurchasePromoApplied ? 0 : partner.commission_rate, isSelfOrder };
}

const selfOrderingPartnerQuery = db.prepare(`
  SELECT id, point_id, full_name, phone, commission_rate
  FROM partners
  WHERE point_id = ? AND active = 1 AND phone_last10 = ?
  ORDER BY id LIMIT 1
`);
function findSelfOrderingPartner(pointId, customerPhone) {
  if (!pointId) return null;
  const phone = String(customerPhone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) return null;
  return selfOrderingPartnerQuery.get(pointId, phone) || null;
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
  const solePartner = db.prepare(
    'SELECT id FROM partners WHERE point_id = ? AND active = 1 LIMIT 2'
  ).all(pointId);
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
         fulfillment_type, delivery_address, delivery_fee, referral_code, bones_used, commission_rate, is_partner_self_order, status,
         reservation_status, reservation_expires_at, inventory_source_type, inventory_source_id, payment_return_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', ?, ?, ?, ?)
    `).run(
      orderData.orderId, orderData.customerName, orderData.customerLname || null,
      orderData.customerPhone, orderData.customerEmail || null, orderData.pickupPoint,
      orderData.pointId || null, orderData.partnerId || null, orderData.partnerName || null, orderData.comment || null,
      orderData.subtotal, orderData.discount || 0, orderData.total, orderData.promoCode || null,
      orderData.method || 'yookassa', orderData.needsDelivery ? 1 : 0, 0,
      orderData.fulfillmentType, orderData.deliveryAddress || null, orderData.deliveryFee,
      orderData.referralCode || null, orderData.bonesUsed, orderData.commissionRate, orderData.isSelfOrder ? 1 : 0,
      newReservationExpiry(), inventorySource.type, inventorySource.id, orderData.paymentReturnUrl || null
    );
    const orderRowId = Number(info.lastInsertRowid);
    // Assigned inside the same SQLite reservation transaction. Unpaid and
    // failed orders retain their number; no reuse on refunds/deletions.
    assignDisplayNumber(db, orderRowId);
    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, variant_id, name, weight, price, qty, is_custom) VALUES (?, ?, ?, ?, ?, ?, 0)'
    );
    for (const item of pricedItems) {
      insertItem.run(orderRowId, item.variantId, item.name, item.weight, item.price, item.qty);
    }
    claimFirstPurchasePromo(orderData.promoValidation, orderRowId);
    reserveForOrder(orderRowId, inventorySource, pricedItems, bonesCustomerId, orderData.bonesUsed, orderData.physicalStockConfirmation);
    return orderRowId;
  });
}

async function runPaidOrderSideEffects(order, items, demo = false) {
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
    sendSuperadminSaleProfit(db, order, {demo}),
  ]);
  ['служебный Telegram', 'email', 'персональный Telegram', 'личный расчёт суперадмину'].forEach((channel, index) => {
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
    finalized = consumeOrderReservation(before.id,{onPaid:order=>enqueuePaidClubSale(order,demo)});
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
      const paidOrder=db.prepare('SELECT * FROM orders WHERE id = ?').get(current.id);
      return {
        consumed: true,
        order: paidOrder,
        items,
        afterPaid:enqueuePaidClubSale(paidOrder,demo),
      };
    });
    if (!finalized.consumed) return false;
  } else {
    console.error(`[paid-order] Заказ ${before.order_code}: платёж успешен, но резерв уже ${before.reservation_status}`);
    return false;
  }

  if(finalized.afterPaid)signalPaidClubSaleQueued();
  // Commit the paid state BEFORE waiting on Telegram, email or bonus services.
  // A slow notification must never keep the buyer on "Подтверждаем оплату".
  try {
    recordCustomerOrder(
      finalized.order.customer_phone, finalized.order.customer_name, finalized.order.customer_lname,
      finalized.order.total, finalized.order.customer_email, finalized.order.referral_code,
      finalized.order.bones_used, !!finalized.order.is_partner_self_order
    );
  } catch (error) {
    console.error('[paid-order] Не удалось обновить профиль покупателя:', error.message);
  }
  setImmediate(() => {
    runPaidOrderSideEffects(finalized.order, finalized.items, demo).catch((error) =>
      console.error('[paid-order] Ошибка фоновых уведомлений:', error.message));
  });
  return true;
}

const PAYMENT_ACTIVE_RESERVATION_MINUTES = 5;
function attachQrPayment(order, payment) {
  if (!payment?.id) throw new Error('ЮKassa не вернула ID платежа');
  const expiry = new Date(Date.now() + PAYMENT_ACTIVE_RESERVATION_MINUTES * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const update = db.prepare(
    "UPDATE orders SET yookassa_payment_id=?, reservation_expires_at=? " +
    "WHERE id=? AND status='pending' AND reservation_status='active'"
  ).run(payment.id, expiry, order.id);
  reservationCleanupScheduler.wake();
  return { attached: update.changes > 0, expiry };
}
const RESERVATION_CLEANUP_BATCH_SIZE = 8;
let reservationCleanupCursor = 0;
async function reconcileExpiredReservations() {
  // Rotate through all overdue reservations without repeatedly hammering the
  // same unresolved payment. A batch caps both sync SQLite work and API calls.
  const fetchBatch = (cursor) => trackAsync('reservation_cleanup_read',
    () => readExpiredReservationsBatch(db.DB_PATH, cursor, RESERVATION_CLEANUP_BATCH_SIZE));
  let expired = await fetchBatch(reservationCleanupCursor);
  if (!expired.length && reservationCleanupCursor > 0) {
    reservationCleanupCursor = 0;
    expired = await fetchBatch(0);
  }
  if (expired.length) reservationCleanupCursor = expired[expired.length - 1].id;
  for (const order of expired) {
    try {
      if (!order.yookassa_payment_id) {
        // A lost response might mean that YooKassa created the payment.
        // Reissue the same idempotent request and cancel safely if unpaid.
        const existing = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        const args = storedQrPaymentArgs(existing, db.prepare(
          'SELECT * FROM order_items WHERE order_id=? ORDER BY id'
        ).all(order.id));
        if (!args) {
          releaseFailedOrderAndAlert(order.id, 'Платёж не был создан, резерв истёк');
          continue;
        }
        if (!yookassa.isConfigured()) continue;
        const createdAt = Date.parse(String(existing.created_at || '').replace(' ', 'T') + 'Z');
        if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) {
          console.error('[reservations] Требуется ручная сверка неопределённого платежа ' + order.order_code);
          continue; // Never re-create after an uncertain, old provider key.
        }
        const payment = await yookassa.createPayment(args);
        const latest = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        if (latest.status !== 'pending' || latest.reservation_status !== 'active') continue;
        if (payment.status === 'succeeded') {
          db.prepare('UPDATE orders SET yookassa_payment_id=? WHERE id=? AND yookassa_payment_id IS NULL')
            .run(payment.id, order.id);
          await finalizePaidOrder(order.id);
        } else {
          // A customer may have resumed the same payment in parallel.
          if (latest.reservation_expires_at > new Date().toISOString().slice(0,19).replace('T',' ')) continue;
          const canceled = payment.status === 'canceled' ? payment : await yookassa.cancelPayment(payment.id);
          if (canceled.status === 'canceled') {
            const nowOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
            if (nowOrder.status==='pending' && nowOrder.reservation_status==='active' &&
                nowOrder.reservation_expires_at <= new Date().toISOString().slice(0,19).replace('T',' '))
              releaseFailedOrderAndAlert(order.id, 'ЮKassa подтвердила отмену платежа');
          }
        }
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
        releaseFailedOrderAndAlert(order.id, 'ЮKassa отменила платёж');
      }
    } catch (e) {
      // При сетевой ошибке резерв намеренно остаётся активным: освобождать
      // товар до подтверждённой отмены опаснее, чем подержать его дольше.
      console.warn(`[reservations] Не удалось сверить/освободить заказ ${order.order_code}: ${e.message}`);
    }
  }
}
// A slow YuKassa response must not cause overlapping reconciliation sweeps.
const runReservationCleanup = createSingleFlightJob(
  () => trackAsync('reservation_cleanup', reconcileExpiredReservations),
  (error) => console.warn('[reservations] Фоновая сверка не удалась:', error.message)
);

// Deadline selection runs in a read-only worker, so QR checkout never
// synchronously waits for a slow persistent storage MIN query.
const reservationCleanupScheduler = createReservationCleanupScheduler({
  run: () => runReservationCleanup(),
  readExpiry: () => readEarliestReservationExpiry(db.DB_PATH),
});
function startReservationCleanup() {
  reservationCleanupScheduler.start();
}

function registerPaymentRoutes(router) {
  startReservationCleanup();
  router.get('/api/first-purchase-promo/policy', (req, res) => {
    const { UNIVERSAL_PROMO_CODE } = require('./first-purchase-promo-policy');
    const policy = getFirstPurchasePromoPolicy(undefined, UNIVERSAL_PROMO_CODE);
    sendJson(res, 200, {promo_code: UNIVERSAL_PROMO_CODE, discount_percent: policy.discountPercent,
      legacy_discount_percent: getFirstPurchasePromoPolicy().discountPercent,
      effective_on:policy.effectiveOn,timezone:policy.timezone,
      changed:policy.changed});
  });
  router.get('/api/first-purchase-promo/validate', (req, res, ctx) => {
    const result = validateFirstPurchasePromo(ctx.query.code, ctx.query.phone, ctx.query.point_id);
    if (!result.valid) return sendJson(res, 200, result);
    sendJson(res, 200, {
      valid: true,
      promo_code: result.promoCode,
      partner_name: result.partnerName,
      point_name: result.pointName,
      discount_percent: result.discountPercent,
      notice: result.notice,
    });
  });

  // POST /api/create-payment — создаёт заказ (pending) и платёж в ЮKassa
  router.post('/api/create-payment', async (req, res, ctx) => {
    const {
      amount, orderId, method, customerPhone, customerEmail,
      customerName, customerLname, pickupPoint, pointId, partnerId, comment,
      promoCode, cartItems,
      fulfillmentType, deliveryAddress, cityId, referralCode, bonesUsed,
      confirmationMode, returnPath, advisorSelection, physicalStockConfirmation,
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


    // When a QR request timed out on a weak connection, the browser retries
    // the SAME order code. Never reserve a second unit or create a new charge.
    const existingOrder = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(orderId);
    if (existingOrder) {
      const existingItems = db.prepare('SELECT variant_id, qty FROM order_items WHERE order_id = ?').all(existingOrder.id);
      if (!matchesQrPaymentRetry(existingOrder, existingItems, {
        customerPhone, pointId, amount, cartItems, confirmationMode, returnPath,
      })) {
        return sendJson(res, 409, {
          code: 'PAYMENT_RETRY_MISMATCH',
          error: 'Заказ уже существует. Для новой покупки начните оформление заново.',
        });
      }
      const existingSummary = {
        order_id: existingOrder.id,
        display_number: existingOrder.display_number,
        is_partner_self_order: !!existingOrder.is_partner_self_order,
      };
      if (existingOrder.status === 'paid') {
        return sendJson(res, 200, { ...existingSummary, paid: true });
      }
      if (existingOrder.status !== 'pending' || existingOrder.reservation_status !== 'active') {
        return sendJson(res, 409, {
          code: 'PAYMENT_RETRY_REQUIRED',
          error: 'Предыдущий платёж отменён. Вернитесь к товару и начните новую оплату.',
        });
      }
      // YooKassa's idempotency key makes this the SAME payment operation.
      // Reconstruct its original request from persisted, server-priced data.
      if (!existingOrder.yookassa_payment_id) {
        const age=Date.now()-Date.parse(String(existingOrder.created_at||'').replace(' ','T')+'Z');
        if(!Number.isFinite(age)||age>30*60*1000)return sendJson(res,202,{...existingSummary,status:'initializing',error:'Требуется сверка предыдущего платежа. Не оплачивайте повторно.'});
        const args = storedQrPaymentArgs(existingOrder, db.prepare(
          'SELECT * FROM order_items WHERE order_id=? ORDER BY id'
        ).all(existingOrder.id));
        if (!args) return sendJson(res, 202, {
          ...existingSummary, status:'initializing',
          error:'Платёж ещё создаётся. Повторите проверку через несколько секунд.',
        });
        try {
          const recovered = await yookassa.createPayment(args);
          if (recovered.status === 'canceled') {
            releaseFailedOrderAndAlert(existingOrder.id, 'ЮKassa подтвердила отмену платежа');
            return sendJson(res, 409, { code:'PAYMENT_RETRY_REQUIRED',
              error:'Платёж отменён. Начните оплату заново.' });
          }
          const attached = attachQrPayment(existingOrder, recovered);
          if (!attached.attached) {
            const latest = db.prepare('SELECT status FROM orders WHERE id=?').get(existingOrder.id);
            if (latest?.status === 'paid') return sendJson(res, 200, { ...existingSummary,paid:true });
            return sendJson(res, 409, { code:'RESERVATION_CLOSED',
              error:'Время оплаты истекло. Проверьте статус предыдущего платежа.' });
          }
          if (recovered.status === 'succeeded') {
            await finalizePaidOrder(existingOrder.id);
            const updated = db.prepare('SELECT status FROM orders WHERE id=?').get(existingOrder.id);
            return sendJson(res, 200, { ...existingSummary,paid:updated?.status==='paid',
              status:updated?.status||'pending' });
          }
          if (recovered.confirmation?.confirmation_url) {
            return sendJson(res, 200, { ...existingSummary,
              payment_id:recovered.id,confirmation_url:recovered.confirmation.confirmation_url });
          }
          return sendJson(res, 202, { ...existingSummary,status:'initializing' });
        } catch (error) {
          console.warn('[create-payment] Не удалось проверить создание заказа ' + orderId + ': ' + error.message);
          return sendJson(res, 202, { ...existingSummary,status:'initializing',
            error:'Связь с ЮKassa нестабильна. Заказ сохранён.' });
        }
      }
      try {
        const payment = await yookassa.getPayment(existingOrder.yookassa_payment_id);
        if (payment.status === 'succeeded') {
          await finalizePaidOrder(existingOrder.id);
          const paidOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(existingOrder.id);
          return sendJson(res, 200, {
            ...existingSummary, paid: paidOrder?.status === 'paid',
            status: paidOrder?.status || 'pending',
          });
        }
        if (payment.status === 'canceled') {
          releaseFailedOrderAndAlert(existingOrder.id, 'ЮKassa отменила платёж');
          return sendJson(res, 409, {
            code: 'PAYMENT_RETRY_REQUIRED',
            error: 'Платёж отменён. Начните оплату заново.',
          });
        }
        if (payment.confirmation?.type === 'redirect' && payment.confirmation.confirmation_url) {
          return sendJson(res, 200, {
            ...existingSummary, payment_id: payment.id,
            confirmation_url: payment.confirmation.confirmation_url,
          });
        }
        return sendJson(res, 202, {
          ...existingSummary, status: 'initializing',
          error: 'Ожидаем подтверждения от ЮKassa. Повторите проверку чуть позже.',
        });
      } catch (error) {
        console.warn('[create-payment] Не удалось восстановить заказ ' + orderId + ': ' + error.message);
        return sendJson(res, 503, {
          code: 'PAYMENT_STATUS_TEMPORARY',
          error: 'Связь с ЮKassa временно недоступна. Заказ сохранён, проверьте ещё раз.',
        });
      }
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
    let promoValidation = null;
    let promoDiscount = 0;
    if (String(promoCode || '').trim()) {
      promoValidation = validateFirstPurchasePromo(promoCode, customerPhone, pointId);
      if (!promoValidation.valid) {
        return sendJson(res, 409, {
          error: promoValidation.error,
          code: 'FIRST_PURCHASE_PROMO_INVALID',
        });
      }
      // Use this validation's authoritative rate, not a hard-coded 20%.
      // The cutoff is server time, independent of phone timezone.
      promoDiscount = Math.round(pricedCart.subtotal * promoValidation.discountPercent / 100);
    }
    const goodsAfterPromo = pricedCart.subtotal - promoDiscount;
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
    const selfOrderingPartner = authoritativeFulfillment === 'pickup'
      ? findSelfOrderingPartner(pointId, customerPhone)
      : null;
    let attribution;
    try {
      attribution = resolveCheckoutGroomer({
        pointId, partnerId, advisorSelection, selfOrderingPartner,
        fulfillmentType: authoritativeFulfillment,
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error.message, code: error.code || 'ADVISOR_SELECTION_ERROR',
      });
    }
    const authoritativePartnerId = attribution.id;
    const selectedPartnerName = attribution.name;
    if (attribution.source && attribution.source.startsWith('auto_')) {
      console.log('[create-payment] Заказ ' + orderId +
        ': автоматически назначен грумер #' + authoritativePartnerId +
        ' (' + attribution.source + ')');
    }

    // Телефон имеет приоритет над выбором в форме: самозаказ автоматически
    // привязывается к самому грумеру. Валидный промокод первой покупки
    // сохраняет скидку, но обнуляет только комиссию грумера.
    const { rate: orderCommissionRate, isSelfOrder } = resolveOrderCommission(
      pointId, authoritativePartnerId, customerPhone, advisorSelection, !!promoValidation?.valid
    );
    if (isSelfOrder) {
      console.log(`[create-payment] Заказ ${orderId}: самозаказ грумера — вознаграждение ${Math.round(orderCommissionRate * 100)}%, косточки отключены`);
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
    if (isSelfOrder && requestedBones > 0) {
      return sendJson(res, 400, {
        error: 'При самозаказе грумера косточки списать нельзя',
        code: 'SELF_ORDER_BONES_FORBIDDEN',
      });
    }
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
      const amountBeforeBones = goodsAfterPromo + authoritativeDeliveryFee;
      const maxUsable = computeMaxUsableBones(bonesCustomer.bones_balance, amountBeforeBones, isSelfOrder);
      if (requestedBones > maxUsable) {
        const actualSharePercent = Math.round(getMaxBonesShare(amountBeforeBones) * 100);
        console.error(`[create-payment] Заказ ${orderId}: запрошено ${requestedBones} косточек, максимум разрешено ${maxUsable} (баланс ${bonesCustomer.bones_balance}, к оплате до списания ${amountBeforeBones} ₽, лимит ${actualSharePercent}% для этой суммы${isSelfOrder ? ' — самозаказ' : ''}) — заказ отклонён`);
        return sendJson(res, 400, { error: `Косточками нельзя списать больше допустимого (максимум ${actualSharePercent}% от суммы этого заказа, или на балансе недостаточно косточек). Обновите страницу и попробуйте снова.` });
      }
      bonesToDeduct = requestedBones;
      bonesCustomerId = bonesCustomer.id;
    }

    const authoritativeAmount = goodsAfterPromo + authoritativeDeliveryFee - bonesToDeduct;
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
        pricing: { subtotal: pricedCart.subtotal, discount: promoDiscount, deliveryFee: authoritativeDeliveryFee, bonesUsed: bonesToDeduct, total: authoritativeAmount, items: pricedCart.items },
      });
    }
    const bonesAgainstGoods = Math.min(bonesToDeduct, goodsAfterPromo);
    const adjustedGoodsTotal = goodsAfterPromo - bonesAgainstGoods;
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

    // Root/miniapp opaque codes are reserved for hosted redirect checkouts;
    // embedded payments must never be reconstructed with a different mode.
    if (/^(TG|TMA)-\d{13}-[a-f0-9]{16}$/.test(String(orderId)) && confirmationMode!=='redirect') {
      return sendJson(res,400,{code:'INVALID_PAYMENT_MODE',error:'Для этого заказа требуется защищённая страница оплаты'});
    }
    const exactPaymentReturnUrl = paymentReturnUrl(req, orderId, returnPath);
    let orderRowId;
    try {
      orderRowId = createReservedOrder({
        orderId, customerName: String(customerName || 'Клиент').trim() || 'Клиент', customerLname, customerPhone, customerEmail,
        pickupPoint: authoritativePickupPoint, pointId, partnerId: authoritativePartnerId, partnerName: selectedPartnerName, comment,
        subtotal: pricedCart.subtotal, discount: promoDiscount, total: authoritativeAmount,
        promoCode: promoValidation ? promoValidation.promoCode : null, promoValidation, method,
        needsDelivery: authoritativeNeedsDelivery, fulfillmentType: authoritativeFulfillment,
        deliveryAddress: authoritativeFulfillment === 'home_delivery' ? String(deliveryAddress).trim() : null,
        deliveryFee: authoritativeDeliveryFee, referralCode, bonesUsed: bonesToDeduct,
        commissionRate: orderCommissionRate, isSelfOrder,
        paymentReturnUrl: exactPaymentReturnUrl,
        physicalStockConfirmation,
      }, pricedCart.items, inventorySource, bonesCustomerId);
    } catch (e) {
      console.warn(`[create-payment] Заказ ${orderId}: резерв не создан — ${e.message}`);
      if(isCheckoutStorageBusy(e)){
        res.setHeader('Retry-After','2');
        return sendJson(res,503,{code:'CHECKOUT_STORAGE_BUSY',
          error:'Хранилище временно занято. Проверьте и продолжите этот же заказ через несколько секунд.'});
      }
      return sendJson(res, e.statusCode || 409, { error: e.message, code: e.code || 'RESERVATION_ERROR', details: e.details });
    }

    // Display number and expiry are immutable once reserved. Fetch together
    // rather than issuing two separate SQLite SELECTs per new payment.
    const paymentSummary = db.prepare(
      'SELECT display_number,reservation_expires_at FROM orders WHERE id=?'
    ).get(orderRowId);

    // Schedule one-minute unpaid-order reminder and stock reservation expiry
    // separately, without continuous fast polling on an empty queue.
    wakeUnpaidOrderAlertScheduler();
    reservationCleanupScheduler.wake();

    if (!yookassa.isConfigured() && isDemoModeEnabled()) {
      // Явный тестовый режим проходит через ту же атомарную логику резерва,
      // после чего сразу превращает резерв в оплаченное списание.
      await finalizePaidOrder(orderRowId, true);
      return sendJson(res, 200, { demo: true, order_id: orderRowId,
        display_number: paymentSummary?.display_number,
        is_partner_self_order: isSelfOrder });
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
        returnUrl: exactPaymentReturnUrl,
      });
      console.log(`[create-payment] Заказ ${orderId}: платёж создан, payment_id=${payment.id}`);
      // Five minutes for bank confirmation; one minute before creation.
      const attachedResult = attachQrPayment({ id: orderRowId }, payment);
      const paymentExpiry = attachedResult.expiry;
      if (!attachedResult.attached) {
        const latest = db.prepare('SELECT status FROM orders WHERE id=?').get(orderRowId);
        if (latest?.status === 'paid') {
          return sendJson(res, 200, { paid:true, order_id:orderRowId,
            display_number:paymentSummary?.display_number });
        }
        return sendJson(res, 409, { code:'RESERVATION_CLOSED',
          error:'Время оплаты истекло. Проверьте статус предыдущего платежа.' });
      }
      sendJson(res, 201, {
        order_id: orderRowId,
        display_number: paymentSummary?.display_number,
        payment_id: payment.id,
        confirmation_token: payment.confirmation && payment.confirmation.confirmation_token,
        confirmation_url: payment.confirmation && payment.confirmation.confirmation_url,
        reservation_expires_at: paymentExpiry,
        reservation_minutes: PAYMENT_ACTIVE_RESERVATION_MINUTES,
        is_partner_self_order: isSelfOrder,
      });
    } catch (e) {
      console.error(`[create-payment] Заказ ${orderId}: ошибка создания платежа — ${e.message}`);
      if (!e.providerDefinitive) {
        return sendJson(res, 202, {
          status:'initializing',order_id:orderRowId,display_number:paymentSummary?.display_number,
          error:'Связь прервалась. Проверяем тот же платёж без повторной покупки.',
        });
      }
      releaseFailedOrderAndAlert(orderRowId, 'ЮKassa отклонила платёж: ' + e.message);
      return sendJson(res, e.statusCode || 502, { error:e.message });
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
          releaseFailedOrderAndAlert(order.id, 'ЮKassa сообщила об отмене платежа');
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
      display_number: order.display_number || null,
      is_partner_self_order: !!order.is_partner_self_order,
    });
  });

  // Возврат с резервной страницы ЮKassa содержит только код заказа. Не отдаём
  // публично ни телефон, ни сумму, ни выбранную точку — только результат.
  // This GET never creates a payment. A capability is the random technical
  // order code, not the short public order number or the customer's phone.
  router.get('/api/order-payment-status/:orderCode', async (req,res,ctx) => {
    res.setHeader('Cache-Control','no-store, private');
    let order=db.prepare('SELECT * FROM orders WHERE order_code = ?').get(ctx.params.orderCode);
    if(!order)return sendJson(res,404,{error:'Заказ не найден'});
    let payment=null;
    if(order.status==='pending'&&order.yookassa_payment_id&&yookassa.isConfigured()){
      try{
        payment=await yookassa.getPayment(order.yookassa_payment_id);
        // The link/receipt belongs only to the exact provider payment.
        if(redirectPaymentPath(order)&&!paymentMatchesOrder(order,payment))payment=null;
        if(payment?.status==='succeeded')await finalizePaidOrder(order.id);
        else if(payment?.status==='canceled')releaseFailedOrderAndAlert(order.id,'ЮKassa сообщила об отмене платежа');
        order=db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      }catch(e){
        console.warn('[order-payment-status] Не удалось сверить заказ '+order.order_code+': '+e.message);
      }
    }
    const continuation=redirectContinuation(order,payment);
    const qrReceipt=!!redirectPaymentPath(order);
    const paidItems=order.status==='paid'?db.prepare('SELECT name,weight,qty FROM order_items WHERE order_id=? ORDER BY id LIMIT ?').all(order.id,qrReceipt?50:1):[];
    sendJson(res,200,{
      paid:order.status==='paid',status:order.status,order_code:order.order_code,
      display_number:order.display_number||null,is_partner_self_order:!!order.is_partner_self_order,
      item:paidItems[0]||null,items:paidItems,
      ...(qrReceipt?{...continuation,amount:order.total,fulfillment_type:order.fulfillment_type}:{}),
    });
  });

  // Explicit user action after a lost provider response, including another
  // Android browser. Never creates another order, changes totals or extends
  // an already attached payment. Uses the original YooKassa idempotence key.
  const redirectRecoveries=new Map();
  router.post('/api/redirect-payment/:orderCode/resume',async(req,res,ctx)=>{
    res.setHeader('Cache-Control','no-store, private');
    const order=db.prepare('SELECT * FROM orders WHERE order_code=?').get(ctx.params.orderCode);
    if(!redirectPaymentPath(order))return sendJson(res,404,{error:'Заказ не найден'});
    if(order.status!=='pending'||order.yookassa_payment_id)return sendJson(res,200,{status:order.status});
    const age=Date.now()-Date.parse(String(order.created_at||'').replace(' ','T')+'Z');
    if(!redirectContinuation(order,null).can_recover||!Number.isFinite(age)||age>30*60*1000||!yookassa.isConfigured())
      return sendJson(res,202,{status:'initializing',error:'Проверяем предыдущий платёж. Не оплачивайте повторно.'});
    let job=redirectRecoveries.get(order.id);
    if(!job){
      job=(async()=>{
        const args=storedQrPaymentArgs(order,db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(order.id));
        if(!args)return;
        const payment=await yookassa.createPayment(args);
        if(!paymentMatchesOrder(order,payment))throw Error('Несовпадение платежа и заказа');
        const latest=db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        if(latest.status!=='pending'||latest.reservation_status!=='active')return;
        if(latest.yookassa_payment_id&&latest.yookassa_payment_id!==payment.id)throw Error('Несовпадение ID платежа');
        if(payment.status==='canceled'){releaseFailedOrderAndAlert(order.id,'ЮKassa подтвердила отмену платежа');return;}
        if(!latest.yookassa_payment_id)attachQrPayment(latest,payment);
        if(payment.status==='succeeded')await finalizePaidOrder(order.id);
      })();
      redirectRecoveries.set(order.id,job);
    }
    try{await job;sendJson(res,200,{status:'checked'});}
    catch(e){console.warn('[redirect-resume] '+order.order_code+': '+e.message);sendJson(res,202,{status:'initializing',error:'Связь с ЮKassa нестабильна. Проверьте этот же заказ.'});}
    finally{if(redirectRecoveries.get(order.id)===job)redirectRecoveries.delete(order.id);}
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
      releaseFailedOrderAndAlert(order.id, 'ЮKassa сообщила об отмене платежа');
      if (order.reservation_status === 'none') {
        db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'pending'").run(order.id);
      }
    }

    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerPaymentRoutes, findSelfOrderingPartner, resolveOrderCommission };
