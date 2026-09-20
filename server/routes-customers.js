// routes-customers.js — фиксация клиентов по телефону, автоматическая
// скидка 20% на первый заказ (заменяет старую систему промокодов).
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { hashPassword } = require('./auth');
const { getDiscountSettings } = require('./settings');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Партнёры (грумеры) — привилегия: их телефон сразу даёт максимальный
// уровень кэшбэка лояльности (Gold), без накопления заказов — в благодарность
// за то, что размещают у себя стойку. Телефон партнёров при регистрации
// сохраняется БЕЗ нормализации (см. routes-auth.js) — сравниваем по последним
// 10 цифрам, как и везде в проекте для таблицы partners.
function isActivePartnerPhone(digits) {
  if (!digits) return false;
  const target = digits.slice(-10);
  if (target.length < 10) return false;
  const partners = db.prepare('SELECT phone FROM partners WHERE active = 1').all();
  return partners.some((p) => String(p.phone || '').replace(/\D/g, '').slice(-10) === target);
}

// Уровни программы лояльности — по количеству уже оплаченных заказов ДО
// текущего (0 — это будет первый заказ, кэшбэка лояльности ещё нет).
// Пороги настраиваются из админки (site_settings) — см. settings.js;
// дефолты там СОЗНАТЕЛЬНО совпадают с личным кабинетом (1/3/6 заказов).
// phone (необязательный) — если это номер активного партнёра, всегда
// возвращаем максимальный (Gold) уровень, независимо от числа заказов.
function getLoyaltyPercent(ordersCount, phone) {
  const s = getDiscountSettings();
  if (phone && isActivePartnerPhone(phone)) return s.loyalty_gold_percent;
  if (ordersCount >= s.loyalty_gold_min_orders) return s.loyalty_gold_percent;
  if (ordersCount >= s.loyalty_silver_min_orders) return s.loyalty_silver_percent;
  if (ordersCount >= s.loyalty_bronze_min_orders) return s.loyalty_bronze_percent;
  return 0;
}

// Сравниваем только месяц и день (год рождения не важен — ДР питомца
// повторяется ежегодно). Дата всегда в формате 'YYYY-MM-DD' — берём
// последние 5 символов ('MM-DD'). Часовой пояс — красноярский, как и
// остальные времязависимые места в проекте (Telegram-уведомления и т.п.).
function isPetBirthdayToday(petBirthday) {
  if (!petBirthday) return false;
  const todayMonthDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Krasnoyarsk' }).slice(5);
  return petBirthday.slice(5) === todayMonthDay;
}

// GET /api/customers/check?phone=... — публичный, вызывается с сайта при
// заполнении телефона в чекауте, чтобы показать клиенту, сколько кэшбэка
// косточками он получит после оплаты (сумму на заказ это больше НЕ уменьшает).
function registerCustomerRoutes(router) {
  router.get('/api/customers/check', (req, res, ctx) => {
    const phone = normalizePhone(ctx.query.phone);
    if (!phone) return sendJson(res, 400, { error: 'Укажите phone' });
    const existing = db.prepare('SELECT orders_count, name, lname, pet_name, pet_birthday FROM customers WHERE phone = ?').get(phone);
    const ordersCount = existing ? existing.orders_count : 0;
    const isBirthday = existing ? isPetBirthdayToday(existing.pet_birthday) : false;
    // Кэшбэки не складываются — если сегодня ДР питомца, действует более
    // выгодный из двух (обычно ДР даёт больше, но на всякий случай берём
    // максимум, а не просто подменяем).
    const loyaltyPercent = Math.max(getLoyaltyPercent(ordersCount, phone), isBirthday ? getDiscountSettings().pet_birthday_percent : 0);
    sendJson(res, 200, {
      is_new: !existing,
      loyalty_percent: loyaltyPercent,
      is_pet_birthday: isBirthday,
      pet_name: existing ? existing.pet_name : null,
      orders_count: ordersCount,
      name: existing ? existing.name : null,
      lname: existing ? existing.lname : null,
    });
  });

  // GET /api/customers — список для админки
  router.get('/api/customers', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 500').all();
    sendJson(res, 200, { customers: rows });
  });

  // DELETE /api/customers/:id — очистка тестовых регистраций из админки.
  // Историю реальных продаж не трогаем: при любом связанном заказе админ
  // сначала должен разобраться с ним в разделе «Заказы», а оплаченный заказ
  // полностью блокирует удаление клиента. Зависимые бонусные/игровые данные
  // удаляются одной транзакцией, а сам факт операции остаётся в журнале.
  router.delete('/api/customers/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    const customerId = Number(ctx.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return sendJson(res, 400, { error: 'Некорректный клиент' });
    }
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return sendJson(res, 404, { error: 'Клиент уже удалён или не найден' });

    const customerPhone = normalizePhone(customer.phone);
    const relatedOrders = db.prepare('SELECT id, order_code, status, customer_phone FROM orders').all()
      .filter((order) => normalizePhone(order.customer_phone) === customerPhone);
    const paidOrders = relatedOrders.filter((order) => order.status === 'paid');
    if (paidOrders.length) {
      return sendJson(res, 409, {
        error: 'Клиента нельзя удалить: у него есть оплаченные заказы (' +
          paidOrders.map((order) => order.order_code).join(', ') + '). История продаж должна сохраняться.',
      });
    }
    if (relatedOrders.length) {
      return sendJson(res, 409, {
        error: 'Сначала удалите связанные неоплаченные тестовые заказы в разделе «Заказы»: ' +
          relatedOrders.map((order) => order.order_code).join(', '),
      });
    }

    // Таблица подписок осталась в части старых боевых баз. Не удаляем её
    // записи молча: подписка — отдельное обязательство перед клиентом.
    const hasSubscriptionsTable = !!db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'subscriptions'"
    ).get();
    if (hasSubscriptionsTable) {
      const subscriptions = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ?').get(customerId).n;
      if (subscriptions > 0) {
        return sendJson(res, 409, {
          error: 'Клиента нельзя удалить: у него есть подписка. Сначала отмените или удалите подписку.',
        });
      }
    }

    const reason = String((ctx.body || {}).reason || '').trim();
    const fullName = [customer.name, customer.lname].filter(Boolean).join(' ').trim() || null;

    // Часть старых вспомогательных таблиц привязана не FK, а телефоном.
    // Удаляем только строки с тем же нормализованным номером; для Telegram
    // дополнительно не затрагиваем входы партнёров и менеджеров.
    function deletePhoneRows(table, roleCustomerOnly) {
      const exists = !!db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?"
      ).get(table);
      if (!exists) return;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      if (!columns.includes('id') || !columns.includes('phone')) return;
      const selectColumns = roleCustomerOnly && columns.includes('role') ? 'id, phone, role' : 'id, phone';
      const rows = db.prepare(`SELECT ${selectColumns} FROM ${table}`).all();
      const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const row of rows) {
        if (normalizePhone(row.phone) !== customerPhone) continue;
        if (roleCustomerOnly && columns.includes('role') && row.role !== 'customer') continue;
        remove.run(row.id);
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO customer_deletion_log
          (customer_id, phone, full_name, orders_count, total_spent, bones_balance, reason, admin_id, admin_login)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customer.id,
        customer.phone,
        fullName,
        customer.orders_count || 0,
        customer.total_spent || 0,
        customer.bones_balance || 0,
        reason || null,
        payload.id,
        payload.login || null
      );

      db.prepare('DELETE FROM customer_password_reset_tokens WHERE customer_id = ?').run(customerId);
      db.prepare('UPDATE customers SET referred_by_customer_id = NULL WHERE referred_by_customer_id = ?').run(customerId);
      deletePhoneRows('telegram_login_tokens', true);
      deletePhoneRows('max_login_tokens', false);
      deletePhoneRows('sms_login_codes', false);
      deletePhoneRows('quiz_prizes', false);
      deletePhoneRows('quiz_attempts', false);
      deletePhoneRows('quiz_scores', false);
      deletePhoneRows('chess_prizes', false);
      deletePhoneRows('chess_wins', false);

      const deleted = db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
      if (!deleted.changes) throw new Error('Клиент уже удалён');
      db.exec('COMMIT');
      sendJson(res, 200, { ok: true, deleted_customer_id: customerId });
    } catch (error) {
      db.exec('ROLLBACK');
      console.error('[customers] Не удалось удалить тестового клиента:', error.message);
      sendJson(res, 500, { error: 'Не удалось удалить клиента. Изменения отменены.' });
    }
  });

  // ── ЛИЧНЫЙ КАБИНЕТ КЛИЕНТА ─────────────────────────────────────────
  // Строится из тех же настроек (site_settings), что и getLoyaltyPercent выше —
  // раньше здесь были захардкожены отдельные числа, из-за чего бейдж уровня
  // в личном кабинете мог разъехаться с реальной скидкой в чекауте.
  function getTierNames() {
    const s = getDiscountSettings();
    return [
      { minOrders: s.loyalty_gold_min_orders, key: 'gold', name: 'Лучший друг' },
      { minOrders: s.loyalty_silver_min_orders, key: 'silver', name: 'Близкий друг' },
      { minOrders: s.loyalty_bronze_min_orders, key: 'bronze', name: 'Верный друг' },
    ];
  }
  function getTierInfo(ordersCount, phone) {
    const TIER_NAMES = getTierNames();
    const isPartner = phone && isActivePartnerPhone(phone);
    const tier = isPartner ? TIER_NAMES[0] : TIER_NAMES.find((t) => ordersCount >= t.minOrders);
    const idx = tier ? TIER_NAMES.indexOf(tier) : TIER_NAMES.length;
    const nextTier = idx > 0 ? TIER_NAMES[idx - 1] : null; // следующий уровень выше (в массиве идёт раньше)
    return {
      key: tier ? tier.key : 'none',
      name: tier ? tier.name : 'Новый друг',
      percent: getLoyaltyPercent(ordersCount, phone),
      current_tier_min_orders: tier ? tier.minOrders : 0,
      next_tier_name: nextTier ? nextTier.name : null,
      next_tier_percent: nextTier ? getLoyaltyPercent(nextTier.minOrders) : null,
      next_tier_min_orders: nextTier ? nextTier.minOrders : null,
      orders_to_next_tier: nextTier ? Math.max(0, nextTier.minOrders - ordersCount) : 0,
    };
  }

  // GET /api/customer/me — собственный профиль (для личного кабинета)
  router.get('/api/customer/me', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const customer = db.prepare('SELECT id, phone, name, lname, email, pet_name, pet_birthday, pet_breed, pet_size, pet_notes, orders_count, total_spent, first_order_at, bones_balance, telegram_chat_id FROM customers WHERE id = ?').get(payload.id);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });
    const { telegram_chat_id, ...safeCustomer } = customer;
    sendJson(res, 200, { customer: { ...safeCustomer, telegram_connected: !!telegram_chat_id, tier: getTierInfo(customer.orders_count, customer.phone) } });
  });

  // PUT /api/customer/me — клиент редактирует своё имя/фамилию/email/анкету питомца
  router.put('/api/customer/me', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(payload.id);
    if (!existing) return sendJson(res, 404, { error: 'Клиент не найден' });
    const { name, lname, email, pet_name, pet_birthday, pet_breed, pet_size, pet_notes } = ctx.body || {};
    if (email !== undefined && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: 'Проверьте правильность email' });
    }
    if (pet_birthday !== undefined && pet_birthday && !/^\d{4}-\d{2}-\d{2}$/.test(pet_birthday)) {
      return sendJson(res, 400, { error: 'Некорректный формат даты рождения питомца' });
    }
    if (pet_size !== undefined && pet_size && !['small', 'medium', 'large'].includes(pet_size)) {
      return sendJson(res, 400, { error: 'Некорректный размер питомца' });
    }

    const finalPetName = pet_name !== undefined ? (pet_name || null) : existing.pet_name;
    const finalPetBreed = pet_breed !== undefined ? (pet_breed || null) : existing.pet_breed;

    db.prepare(`
      UPDATE customers SET
        name = ?, lname = ?, email = ?, pet_name = ?, pet_birthday = ?, pet_breed = ?, pet_size = ?, pet_notes = ?
      WHERE id = ?
    `).run(
      name !== undefined ? (name || null) : existing.name,
      lname !== undefined ? (lname || null) : existing.lname,
      email !== undefined ? (email || null) : existing.email,
      finalPetName,
      pet_birthday !== undefined ? (pet_birthday || null) : existing.pet_birthday,
      finalPetBreed,
      pet_size !== undefined ? (pet_size || null) : existing.pet_size,
      pet_notes !== undefined ? (pet_notes || null) : existing.pet_notes,
      payload.id
    );

    // Бонус за регистрацию + анкету питомца: кличка и порода обязательны
    // (дата рождения — по желанию, не блокирует бонус), начисляется один раз
    // на клиента (флаг profile_bones_awarded не даёт получить его повторно
    // при следующих сохранениях профиля). Косточки уже сразу на балансе —
    // тратить можно хоть на первом заказе.
    let bonesAwarded = 0;
    if (!existing.profile_bones_awarded && finalPetName && finalPetBreed) {
      const { awardBones } = require('./bones');
      bonesAwarded = getDiscountSettings().registration_bones;
      awardBones(payload.id, bonesAwarded, 'gift', 'Бонус за регистрацию и анкету питомца');
      db.prepare('UPDATE customers SET profile_bones_awarded = 1 WHERE id = ?').run(payload.id);
    }

    sendJson(res, 200, { ok: true, bonesAwarded });
  });

  // PUT /api/customer/me/password — клиент задаёт/меняет пароль. Отдельного
  // подтверждения старым паролем не требуем: клиент уже авторизован валидным
  // токеном (в том числе через SMS/Telegram/MAX, где пароля могло не быть
  // вовсе) — сам факт действующей сессии и есть подтверждение личности.
  router.put('/api/customer/me/password', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const { new_password } = ctx.body || {};
    if (!new_password || new_password.length < 6) {
      return sendJson(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
    }
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), payload.id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/customer/me/orders — история своих заказов
  router.get('/api/customer/me/orders', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const customer = db.prepare('SELECT phone FROM customers WHERE id = ?').get(payload.id);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });
    const allOrders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all();
    const orders = allOrders.filter((o) => normalizePhone(o.customer_phone) === customer.phone);
    const getItems = db.prepare('SELECT name, weight, price, qty, is_custom FROM order_items WHERE order_id = ?');
    sendJson(res, 200, { orders: orders.map((o) => ({ ...o, items: getItems.all(o.id) })) });
  });

  // GET /api/referral/validate?code=X&phone=Y — публичный, вызывается при
  // чекауте. Награда за "код друга" — косточки после ПЕРВОГО заказа (не
  // скидка на текущий, заказ оплачивается по полной цене), поэтому
  // действует только для НОВОГО клиента (ещё ни одного заказа) — иначе
  // можно было бы применять его бесконечно.
  router.get('/api/referral/validate', (req, res, ctx) => {
    const code = String(ctx.query.code || '').trim().toUpperCase();
    const phone = normalizePhone(ctx.query.phone);
    if (!code) return sendJson(res, 400, { error: 'Укажите code' });

    const referrer = db.prepare('SELECT id, name, phone FROM customers WHERE referral_code = ?').get(code);
    if (!referrer) return sendJson(res, 200, { valid: false, error: 'Такого кода не существует' });

    if (phone && referrer.phone === phone) {
      return sendJson(res, 200, { valid: false, error: 'Нельзя использовать свой же код' });
    }
    if (phone) {
      const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone);
      if (existing && existing.id !== undefined && db.prepare('SELECT orders_count FROM customers WHERE id = ?').get(existing.id).orders_count > 0) {
        return sendJson(res, 200, { valid: false, error: 'Код друга действует только на первый заказ' });
      }
    }
    sendJson(res, 200, { valid: true, bones_awarded: getDiscountSettings().referral_friend_bones, referrer_name: referrer.name || 'друг' });
  });

  // GET /api/customer/me/referral — свой код для программы "Приведи друга"
  // (генерируется при первом обращении, если ещё нет).
  router.get('/api/customer/me/referral', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(payload.id);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });

    let code = customer.referral_code;
    if (!code) {
      code = generateUniqueReferralCode();
      db.prepare('UPDATE customers SET referral_code = ? WHERE id = ?').run(code, customer.id);
    }
    const referredCount = db.prepare('SELECT COUNT(*) AS c FROM customers WHERE referred_by_customer_id = ?').get(customer.id).c;
    const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');
    sendJson(res, 200, {
      code,
      link: (siteUrl || '') + '/?friend=' + code,
      referredCount,
    });
  });

  // GET /api/customer/me/bones — баланс и история косточек для личного кабинета
  router.get('/api/customer/me/bones', (req, res, ctx) => {
    const payload = requireAuth(['customer'])(req, res, ctx);
    if (!payload) return;
    const customer = db.prepare('SELECT bones_balance FROM customers WHERE id = ?').get(payload.id);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });
    const transactions = db.prepare(`
      SELECT amount, type, description, created_at FROM bone_transactions
      WHERE customer_id = ? ORDER BY id DESC LIMIT 50
    `).all(payload.id);
    sendJson(res, 200, { balance: customer.bones_balance, transactions });
  });

  // POST /api/customers/:id/bones — админ начисляет/списывает косточки вручную
  // (подарок от «Тайги», мотивация к возвращению, ручная корректировка).
  // Положительный amount — начисление, отрицательный — списание (баланс в
  // минус не уходит).
  router.post('/api/customers/:id/bones', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const customer = db.prepare('SELECT id, bones_balance FROM customers WHERE id = ?').get(ctx.params.id);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });

    const { amount, description } = ctx.body || {};
    const delta = Math.round(Number(amount));
    if (!Number.isFinite(delta) || delta === 0) {
      return sendJson(res, 400, { error: 'Укажите amount — целое число, не равное 0' });
    }

    const { awardBones, spendBones } = require('./bones');
    if (delta > 0) {
      awardBones(customer.id, delta, 'gift', description || 'Подарок от «Тайги»');
    } else {
      const toSubtract = Math.abs(delta);
      if (toSubtract > customer.bones_balance) {
        return sendJson(res, 400, { error: 'На балансе только ' + customer.bones_balance + ' ₽ — нельзя списать больше' });
      }
      spendBones(customer.id, toSubtract, null, description || 'Корректировка администратором');
    }
    const updated = db.prepare('SELECT bones_balance FROM customers WHERE id = ?').get(customer.id);
    sendJson(res, 200, { ok: true, bones_balance: updated.bones_balance });
  });

  // GET /api/customers/:id/bones/transactions — история для админки
  router.get('/api/customers/:id/bones/transactions', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare(`
      SELECT * FROM bone_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 200
    `).all(ctx.params.id);
    sendJson(res, 200, { transactions: rows });
  });
}

function generateUniqueReferralCode() {
  const crypto = require('node:crypto');
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 символов, например "A3F9C1"
  } while (db.prepare('SELECT id FROM customers WHERE referral_code = ?').get(code));
  return code;
}

// Вызывается при подтверждении оплаты (и в реальном вебхуке ЮKassa, и в
// демо-режиме) — заводит клиента при первом заказе, иначе обновляет счётчики
// и начисляет кэшбэк косточками (лояльность/ДР питомца), если применимо.
// Вызывается при подтверждении оплаты (и в реальном вебхуке ЮKassa, и в
// демо-режиме) — заводит клиента при первом заказе, иначе обновляет счётчики
// и начисляет кэшбэк косточками (лояльность/ДР питомца), если применимо.
// bonesUsed — сколько косточек клиент списал на ЭТОТ заказ: если больше 0,
// кэшбэк на этот же заказ не начисляется (либо тратим, либо зарабатываем —
// не одновременно).
function recordCustomerOrder(phone, name, lname, total, email, referralCode, bonesUsed) {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(normalized);
  if (!existing) {
    let referredBy = null;
    if (referralCode) {
      const referrer = db.prepare('SELECT * FROM customers WHERE referral_code = ?').get(String(referralCode).trim().toUpperCase());
      if (referrer && referrer.phone !== normalized) referredBy = referrer.id;
    }
    const info = db.prepare(`
      INSERT INTO customers (phone, name, lname, email, referred_by_customer_id, first_order_at, last_order_at, orders_count, total_spent)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1, ?)
    `).run(normalized, name || null, lname || null, email || null, referredBy, total);

    if (referredBy) rewardReferralPair(referredBy, info.lastInsertRowid, name);
  } else {
    // Кэшбэк считаем по статусу клиента ДО этого заказа (сколько заказов уже
    // было, какой у питомца день рождения) — то же правило, что действовало
    // бы, если бы это была скидка в чекауте, просто выплачивается постфактум.
    // Если клиент в этом же заказе списал косточки — кэшбэк не начисляем:
    // либо тратим, либо зарабатываем, не одновременно.
    const usedBonesThisOrder = Number(bonesUsed) > 0;
    const loyaltyPercent = usedBonesThisOrder ? 0 : getLoyaltyPercent(existing.orders_count, existing.phone);
    const isBirthday = usedBonesThisOrder ? false : isPetBirthdayToday(existing.pet_birthday);
    const birthdayPercent = getDiscountSettings().pet_birthday_percent;
    const cashbackPercent = Math.max(loyaltyPercent, isBirthday ? birthdayPercent : 0);

    // winback_sent_at сбрасываем в NULL — раз клиент вернулся и заказал сам,
    // при следующем затишье win-back можно будет отправить снова.
    db.prepare(`
      UPDATE customers
      SET orders_count = orders_count + 1, total_spent = total_spent + ?, email = COALESCE(?, email),
          last_order_at = datetime('now'), winback_sent_at = NULL
      WHERE id = ?
    `).run(total, email || null, existing.id);

    if (cashbackPercent > 0) {
      const { awardBones } = require('./bones');
      const cashbackBones = Math.round(total * cashbackPercent / 100);
      if (cashbackBones > 0) {
        awardBones(
          existing.id,
          cashbackBones,
          'cashback',
          isBirthday && cashbackPercent === birthdayPercent
            ? 'Кэшбэк ко дню рождения питомца (' + cashbackPercent + '%)'
            : 'Кэшбэк постоянного клиента (' + cashbackPercent + '%)'
        );
      }
    }
  }
}

// Награда за программу "Приведи друга" — косточки (внутренняя валюта
// «Тайги», 1 косточка = 1 ₽) начисляются ОБЕИМ сторонам сразу после того,
// как приведённый друг оплатит свой первый заказ (по полной цене — заказ
// больше не уменьшается скидкой, награда приходит на баланс уже после).
// Плюс сообщение в Telegram рефереру, если он когда-либо входил через бота
// (у нас остался его chat_id) — иначе награда просто ждёт его в кабинете.
function rewardReferralPair(referrerId, friendCustomerId, friendName) {
  const { awardBones } = require('./bones');
  const referrer = db.prepare('SELECT * FROM customers WHERE id = ?').get(referrerId);
  if (!referrer) return;

  const s = getDiscountSettings();
  const referrerBones = s.referral_reward_bones;
  const friendBones = s.referral_friend_bones;

  awardBones(
    referrerId,
    referrerBones,
    'referral',
    'Приведённый друг' + (friendName ? ' (' + friendName + ')' : '') + ' сделал первый заказ'
  );
  awardBones(
    friendCustomerId,
    friendBones,
    'referral',
    'Первый заказ по коду друга (' + (referrer.name || referrer.phone) + ')'
  );

  try {
    const tokenRow = db.prepare("SELECT chat_id FROM telegram_login_tokens WHERE phone = ? AND role = 'customer' AND chat_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(referrer.phone);
    if (tokenRow && tokenRow.chat_id) {
      const TG_TOKEN = process.env.TG_TOKEN || '';
      if (TG_TOKEN) {
        fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tokenRow.chat_id,
            text: '🎉 Ваш друг' + (friendName ? ' (' + friendName + ')' : '') + ' сделал первый заказ по вашему коду!\n\n🦴 Вам начислено ' + referrerBones + ' косточек — можно потратить на следующий заказ (1 косточка = 1 ₽).',
          }),
        }).catch(() => {});
      }
    }
  } catch (e) { /* уведомление необязательно */ }
}

module.exports = { registerCustomerRoutes, recordCustomerOrder, normalizePhone };
