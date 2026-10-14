'use strict';

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}
function integer(value, label, min = 0, max = 10000000) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('Некорректное поле: ' + label);
  return value;
}
function initializeRecovery(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_recovery_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    order_code TEXT NOT NULL UNIQUE,
    payment_id TEXT NOT NULL UNIQUE,
    admin_id INTEGER, admin_login TEXT, reason TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
async function verifyRecoveryPayment(db, gateway, paymentId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(paymentId || ''))) fail('Укажите корректный ID платежа ЮKassa');
  if (!gateway.isConfigured()) fail('ЮKassa не настроена на сервере', 503);
  if (db.prepare('SELECT id FROM orders WHERE yookassa_payment_id = ?').get(paymentId) ||
      db.prepare('SELECT id FROM order_recovery_log WHERE payment_id = ?').get(paymentId)) fail('Этот платёж уже учтён в базе или журнале восстановления', 409);
  const payment = await gateway.getPayment(paymentId);
  if (payment.id !== paymentId || payment.status !== 'succeeded' || payment.paid !== true || payment.test === true) fail('Можно восстановить только успешно оплаченный реальный платёж', 409);
  if (payment.amount?.currency !== 'RUB' || !/^\d+\.\d{2}$/.test(String(payment.amount?.value || ''))) fail('Некорректная сумма платежа', 409);
  if (Number(payment.refunded_amount?.value || 0) > 0) fail('Платёж с возвратом требует отдельной сверки и не может быть восстановлен этой формой', 409);
  return payment;
}

async function recoverOrder(db, gateway, body, admin) {
  const code = String(body.order_code || '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(code)) fail('Укажите исходный номер заказа');
  const reason = String(body.reason || '').trim();
  if (reason.length < 5 || reason.length > 1000) fail('Укажите причину восстановления (5–1000 символов)');
  let phone = String(body.customer_phone || '').replace(/\D/g, '');
  if (phone.length === 11 && phone[0] === '8') phone = '7' + phone.slice(1);
  if (!/^7\d{10}$/.test(phone)) fail('Укажите телефон клиента в формате +7…');
  const dateText = String(body.created_at || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[37]:00$/.test(dateText)) fail('Укажите дату, время и часовой пояс заказа');
  const date = new Date(dateText);
  const offsetMs = Number(dateText.slice(20, 22)) * 3600000;
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() ||
      new Date(date.getTime() + offsetMs).toISOString().slice(0, 19) !== dateText.slice(0, 19)) fail('Некорректная дата заказа');
  const createdAt = date.toISOString().slice(0, 19).replace('T', ' ');
  if (!['already_accounted', 'deduct'].includes(body.inventory_mode)) fail('Укажите, учтено ли списание товара в остатках');
  if (typeof body.adjust_bones !== 'boolean') fail('Укажите, нужно ли восстанавливать баланс косточек');
  const used = integer(body.bones_used, 'списанные косточки');
  const earned = integer(body.bones_earned, 'начисленные косточки');
  const discount = integer(body.discount, 'скидка');
  const total = integer(body.total, 'сумма оплаты', 1);
  const rate = Number(body.commission_percent);
  if (typeof body.commission_percent !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) fail('Укажите историческую ставку грумера от 0 до 100%');
  if (typeof body.is_self_order !== 'boolean') fail('Укажите, является ли заказ самозаказом грумера');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) fail('Добавьте от 1 до 50 позиций');
  const payment = await verifyRecoveryPayment(db, gateway, body.payment_id);
  if (Math.round(Number(payment.amount.value) * 100) !== total * 100) fail('Сумма заказа не совпадает с оплатой ЮKassa', 409);
  if (!payment.metadata?.order_code || payment.metadata.order_code !== code) fail('Исходный номер заказа не совпадает с metadata.order_code платежа', 409);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT id FROM orders WHERE order_code = ? OR yookassa_payment_id = ?').get(code, payment.id) ||
        db.prepare('SELECT id FROM order_recovery_log WHERE order_code = ? OR payment_id = ?').get(code, payment.id)) fail('Заказ или платёж уже восстановлен', 409);
    const point = db.prepare('SELECT id, name, addr FROM points WHERE id = ?').get(body.point_id);
    if (!point) fail('Точка не найдена');
    let partner = null;
    if (body.partner_id) {
      partner = db.prepare('SELECT id, full_name, point_id, phone FROM partners WHERE id = ?').get(integer(body.partner_id, 'грумер', 1));
      if (!partner || String(partner.point_id) !== point.id) fail('Грумер не относится к выбранной точке');
    } else if (rate !== 0 || body.is_self_order) fail('Без выбранного грумера ставка должна быть 0%');
    if (body.is_self_order && (used || earned)) fail('Самозаказ грумера не использует косточки');
    const seen = new Set();
    const items = body.items.map(item => {
      const variantId = integer(item.variant_id, 'фасовка', 1);
      if (seen.has(variantId)) fail('Объедините одинаковые фасовки в одну строку');
      seen.add(variantId);
      const variant = db.prepare('SELECT v.id, v.weight, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?').get(variantId);
      if (!variant) fail('Фасовка не найдена');
      return { ...variant, price: integer(item.price, 'историческая цена'), qty: integer(item.qty, 'количество', 1, 1000) };
    });
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal - discount - used !== total) fail('Состав заказа минус скидка и списанные косточки должен совпадать с оплатой');
    const info = db.prepare(`INSERT INTO orders
      (order_code, customer_name, customer_phone, pickup_point, point_id, partner_id, partner_name,
       subtotal, discount, total, payment_method, commission_rate, is_partner_self_order,
       bones_used, status, reservation_status, inventory_source_type, inventory_source_id, yookassa_payment_id, created_at, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yookassa', ?, ?, ?, 'paid', 'consumed', 'point', ?, ?, ?, ?)`)
      .run(code, String(body.customer_name || 'Клиент').trim().slice(0, 150), phone,
        point.name + (point.addr ? ' — ' + point.addr : ''), point.id, partner?.id || null, partner?.full_name || null,
        subtotal, discount, total, rate / 100, body.is_self_order ? 1 : 0, used, point.id, payment.id, createdAt, 'Восстановлен: ' + reason);
    const id = Number(info.lastInsertRowid);
    for (const item of items) {
      db.prepare('INSERT INTO order_items (order_id, variant_id, name, weight, price, qty) VALUES (?, ?, ?, ?, ?, ?)').run(id, item.id, item.name, item.weight, item.price, item.qty);
      if (body.inventory_mode === 'deduct') {
        const result = db.prepare('UPDATE stock SET qty = qty - ? WHERE point_id = ? AND variant_id = ? AND qty >= ?').run(item.qty, point.id, item.id, item.qty);
        if (result.changes !== 1) fail('Недостаточно остатка: ' + item.name + ' (' + item.weight + ')', 409);
      }
    }
    db.prepare(`INSERT INTO customers (phone, name, first_order_at, last_order_at, orders_count, total_spent)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(phone) DO UPDATE SET orders_count = orders_count + 1, total_spent = total_spent + excluded.total_spent,
      first_order_at = CASE WHEN first_order_at IS NULL OR first_order_at > excluded.first_order_at THEN excluded.first_order_at ELSE first_order_at END,
      last_order_at = CASE WHEN last_order_at IS NULL OR last_order_at < excluded.last_order_at THEN excluded.last_order_at ELSE last_order_at END`)
      .run(phone, String(body.customer_name || 'Клиент').slice(0, 150), createdAt, createdAt, total);
    const customer = db.prepare('SELECT id, bones_balance FROM customers WHERE phone = ?').get(phone);
    if (body.adjust_bones) {
      if (customer.bones_balance < used) fail('Недостаточно косточек для восстановления списания', 409);
      db.prepare('UPDATE customers SET bones_balance = bones_balance + ? - ? WHERE id = ?').run(earned, used, customer.id);
      for (const [amount, type] of [[-used, 'spend'], [earned, 'cashback']]) {
        if (amount) db.prepare('INSERT INTO bone_transactions (customer_id, amount, type, description, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(customer.id, amount, type, 'Восстановление заказа ' + code, id, createdAt);
      }
    }
    db.prepare('INSERT INTO order_recovery_log (order_id, order_code, payment_id, admin_id, admin_login, reason, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, code, payment.id, admin.id || null, admin.login || null, reason, JSON.stringify({ ...body, items, verified_amount: payment.amount, payment_created_at: payment.created_at }));
    db.exec('COMMIT');
    return { id, order_code: code, total, created_at: createdAt };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { initializeRecovery, verifyRecoveryPayment, recoverOrder };
