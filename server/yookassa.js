// yookassa.js — минимальный клиент к API ЮKassa. Секретный ключ используется
// только здесь, на сервере — в браузер он никогда не попадает.
'use strict';

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const API_BASE = 'https://api.yookassa.ru/v3';

function authHeader() {
  const token = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
  return `Basic ${token}`;
}

function isConfigured() {
  return Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY);
}

// Оборачивает fetch таймаутом — без этого при проблемах с сетью до ЮKassa
// (или зависшем ответе) запрос мог бы висеть до тех пор, пока сама платформа
// хостинга не оборвёт его по своему таймауту и не покажет СВОЮ HTML-страницу
// с ошибкой вместо нормального JSON-ответа от нашего сервера.
// 8 секунд, а не больше — сокращено специально: если у прокси/шлюза Amvera
// таймаут короче наших прежних 15 секунд, он сдаётся первым и подменяет
// наш ответ своей HTML-страницей "502 Bad Gateway" — тогда клиент получает
// именно её вместо валидного JSON-ответа от этого кода, каким бы он ни был.
async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  console.log(`[ЮKassa] → запрос: ${options.method || 'GET'} ${url}`);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    console.log(`[ЮKassa] ← ответ за ${Date.now() - startedAt} мс, статус ${res.status}`);
    return res;
  } catch (e) {
    console.error(`[ЮKassa] ✕ сбой за ${Date.now() - startedAt} мс: ${e.name} ${e.message}` + (e.cause ? ` | причина: ${JSON.stringify({ code: e.cause.code, errno: e.cause.errno, syscall: e.cause.syscall, address: e.cause.address })}` : ' (без деталей причины)'));
    if (e.name === 'AbortError') {
      const err = new Error('ЮKassa не ответила за ' + (timeoutMs / 1000) + ' секунд — похоже на проблему с сетью до api.yookassa.ru');
      err.statusCode = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ЮKassa в норме всегда отвечает JSON, даже при ошибках — но если ответ всё же
// оказался не JSON (например, страница от прокси/файрвола на пути к api.yookassa.ru),
// даём понятную ошибку вместо невнятного "Unexpected token '<'".
async function parseJsonSafe(res, context) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('ЮKassa вернула не JSON-ответ при ' + context + ' (похоже на сетевую проблему или блокировку до api.yookassa.ru), HTTP ' + res.status);
    err.statusCode = 502;
    throw err;
  }
}

// Создаёт платёж для встроенного JS-виджета или для резервного перехода на
// защищённую страницу ЮKassa, если виджет не загрузился в браузере клиента.
// receiptItems — уже готовый по формату ЮKassa состав чека (собирается на фронтенде
// с учётом пропорционального распределения скидок по позициям).
async function createPayment({ amount, description, orderCode, receiptItems, customerPhone, customerEmail, method, confirmationMode, returnUrl }) {
  const idempotenceKey = orderCode + '-' + Date.now();
  const useRedirect = confirmationMode === 'redirect';
  const body = {
    amount: { value: amount.toFixed(2), currency: 'RUB' },
    capture: true,
    description: description || ('Заказ ' + orderCode),
    confirmation: useRedirect
      ? { type: 'redirect', return_url: returnUrl, enforce: true }
      : { type: 'embedded' },
    metadata: { order_code: orderCode },
  };
  // Новые клиенты передают "yookassa": тогда сам виджет/страница ЮKassa
  // показывает все доступные покупателю способы. Явные значения оставлены
  // для обратной совместимости со старыми открытыми версиями сайта.
  if (method === 'sbp' || method === 'bank_card') {
    body.payment_method_data = { type: method === 'sbp' ? 'sbp' : 'bank_card' };
  }
  if (receiptItems && receiptItems.length) {
    // Важно: "Чеки от ЮKassa" доставляют чек только на email — доставка по SMS
    // недоступна в принципе (подтверждено документацией ЮKassa). Email теперь
    // необязателен для клиента (меньше трения на чекауте) — если его нет,
    // чек всё равно фискализируется и уходит в налоговую, просто не долетает
    // до конкретного покупателя напрямую через этот канал.
    const customer = {};
    if (customerEmail) customer.email = customerEmail;
    if (customerPhone) customer.phone = customerPhone.replace(/\D/g, '');
    body.receipt = {
      customer: Object.keys(customer).length ? customer : undefined,
      items: receiptItems,
    };
  }

  const res = await fetchWithTimeout(`${API_BASE}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
      'Idempotence-Key': idempotenceKey,
    },
    body: JSON.stringify(body),
  });
  const data = await parseJsonSafe(res, 'создании платежа');
  if (!res.ok) {
    // ЮKassa при 400 обычно возвращает {type, id, code, description, parameter} —
    // выводим всё целиком в лог, иначе причина отказа остаётся невидимой.
    console.error(`[ЮKassa] Полный ответ на ошибку ${res.status}:`, JSON.stringify(data));
    const details = [data.code, data.parameter].filter(Boolean).join(', ');
    const err = new Error((data.description || 'Ошибка создания платежа в ЮKassa') + (details ? ` (${details})` : ''));
    err.statusCode = 502;
    err.details = data;
    throw err;
  }
  return data; // { id, status, confirmation: { confirmation_token }, ... }
}

async function getPayment(paymentId) {
  const res = await fetchWithTimeout(`${API_BASE}/payments/${paymentId}`, {
    headers: { 'Authorization': authHeader() },
  });
  const data = await parseJsonSafe(res, 'получении статуса платежа');
  if (!res.ok) {
    const err = new Error(data.description || 'Ошибка получения статуса платежа');
    err.statusCode = 502;
    throw err;
  }
  return data;
}

// Отменяет ещё не завершённый платёж перед освобождением 15-минутного
// резерва. Пока ЮKassa не подтвердила status='canceled', товар не возвращаем
// в доступный остаток — иначе поздний успех мог бы привести к перепродаже.
async function cancelPayment(paymentId) {
  const res = await fetchWithTimeout(`${API_BASE}/payments/${paymentId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
      'Idempotence-Key': `cancel-${paymentId}`,
    },
    body: '{}',
  });
  const data = await parseJsonSafe(res, 'отмене платежа');
  if (!res.ok) {
    const err = new Error(data.description || 'Ошибка отмены платежа в ЮKassa');
    err.statusCode = 502;
    err.details = data;
    throw err;
  }
  return data;
}

// Создаёт возврат (полный или частичный) уже проведённого платежа. ЮKassa
// сама формирует чек возврата на основе данных исходного платежа — заново
// передавать receipt не нужно.
async function createRefund({ paymentId, amount, description, orderCode }) {
  const idempotenceKey = 'refund-' + orderCode + '-' + Date.now();
  const res = await fetchWithTimeout(`${API_BASE}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
      'Idempotence-Key': idempotenceKey,
    },
    body: JSON.stringify({
      amount: { value: amount.toFixed(2), currency: 'RUB' },
      payment_id: paymentId,
      description: description || ('Возврат по заказу ' + orderCode),
    }),
  });
  const data = await parseJsonSafe(res, 'создании возврата');
  if (!res.ok) {
    const err = new Error(data.description || 'Ошибка создания возврата в ЮKassa');
    err.statusCode = 502;
    err.details = data;
    throw err;
  }
  return data; // { id, status, amount, payment_id, ... }
}

module.exports = { createPayment, getPayment, cancelPayment, createRefund, isConfigured };
