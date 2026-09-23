// routes-partners.js — регистрация и управление партнёрами (грумерами).
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');
const { requireAuth, tryAuth } = require('./routes-auth');
const { reverseAndDeleteOrdersBy } = require('./order-reversal');
const { sendTelegram } = require('./telegram');
const { computeManagerCommissionRate } = require('./routes-managers');
const { normalizePhone } = require('./routes-customers');
const { logManagerAction } = require('./audit-log');
const {
  createPartnerPayout,
  getUnpaidSummary,
  listAllPartnerPayouts,
  listPartnerPayouts,
} = require('./partner-payouts');

function nextPartnerCode() {
  const row = db.prepare("SELECT partner_code FROM partners ORDER BY id DESC LIMIT 1").get();
  const lastNum = row ? parseInt(row.partner_code.split('-')[1], 10) : 0;
  return 'GR-' + String(lastNum + 1).padStart(3, '0');
}

function safePartner(p) {
  const { password_hash, telegram_chat_id, ...rest } = p;
  return { ...rest, telegram_connected: !!telegram_chat_id };
}

function registerPartnerRoutes(router) {
  // POST /api/partners/register — публичная регистрация (форма на сайте)
  // GET /api/points/:pointId/partners — публичный, список активных партнёров
  // (грумеров) на этой точке. Нужен для чекаута: если на точке несколько
  // грумеров, клиент выбирает, кто его обслуживал.
  router.get('/api/points/:pointId/partners', (req, res, ctx) => {
    const rows = db.prepare('SELECT id, full_name FROM partners WHERE point_id = ? AND active = 1 ORDER BY full_name').all(ctx.params.pointId);
    sendJson(res, 200, { partners: rows });
  });

  // GET /api/points/:pointId/is-self-order?phone=... — публичный, для
  // предупреждения В ЧЕКАУТЕ: "вы покупаете сами у себя, комиссия не
  // начислится". Намеренно отдаём только true/false, а не сам телефон
  // партнёра — иначе с этого эндпоинта можно было бы вытягивать чужие
  // номера подбором точек.
  router.get('/api/points/:pointId/is-self-order', (req, res, ctx) => {
    const phoneDigits = String(ctx.query.phone || '').replace(/\D/g, '').slice(-10);
    if (phoneDigits.length < 10) return sendJson(res, 200, { isSelfOrder: false });
    const partners = db.prepare('SELECT phone FROM partners WHERE point_id = ? AND active = 1').all(ctx.params.pointId);
    const isSelfOrder = partners.some((p) => String(p.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits);
    sendJson(res, 200, { isSelfOrder });
  });

  router.post('/api/partners/register', (req, res, ctx) => {
    // Регистрация остаётся публичной для обычной формы сайта. Если запрос
    // пришёл из авторизованного кабинета менеджера, фиксируем именно его как
    // автора действия, но только когда выбранная точка закреплена за ним.
    const managerPayload = tryAuth(['manager'])(req);
    const {
      full_name, phone, point_id,
      legal_form, inn, bank_details, manager_code, referral_code,
      login, password,
      display_stand, display_poster, display_basket,
    } = ctx.body || {};

    if (!full_name || !phone || !point_id || !login || !password) {
      return sendJson(res, 400, { error: 'Заполните ФИО, телефон, выберите минимаркет, укажите логин и пароль' });
    }
    if (String(password).length < 6) {
      return sendJson(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
    }
    const existingLogin = db.prepare('SELECT id FROM partners WHERE login = ?').get(login);
    if (existingLogin) return sendJson(res, 409, { error: 'Такой логин уже занят' });

    // Регистрация возможна только на уже существующий минимаркет — его
    // заранее создаёт администратор или менеджер. Свободный ввод названия
    // и адреса убран: раньше грумер мог "создать" точку прямо в форме, что
    // приводило к дублям и точкам без реального контроля со стороны сети.
    const point = db.prepare('SELECT * FROM points WHERE id = ? AND active = 1').get(point_id);
    if (!point) return sendJson(res, 400, { error: 'Минимаркет не найден или отключён' });
    // На одной точке может работать несколько партнёров одновременно (см.
    // orders.partner_id и выбор грумера в чекауте на сайте — это штатный,
    // уже реализованный сценарий, не ограничение "один партнёр на точку").
    // Раньше здесь была жёсткая блокировка второй и последующей регистрации
    // на ту же точку — реального технического или бизнес-ограничения под
    // ней не было, только историческая случайность первой версии формы.

    // Формат размещения на точке — стойка/постер/корзинка, можно сочетать.
    // Если ничего явно не передали (старые клиенты формы, прямые вызовы API) —
    // по умолчанию считаем, что это классическая стойка, как было всегда.
    const dStand = display_stand === undefined ? true : !!display_stand;
    const dPoster = !!display_poster;
    const dBasket = !!display_basket;
    if (!dStand && !dPoster && !dBasket) {
      return sendJson(res, 400, { error: 'Выберите хотя бы один формат размещения: стойка, картинка или корзинка' });
    }

    // Промокод для привлечения новой точки — принимает код и грумера
    // (partner_code, например GR-001), и владельца салона (owner_code,
    // например OWN-001). Один и тот же код не может принадлежать обеим
    // ролям одновременно, так что порядок проверки не важен.
    let referrerPartner = null;
    let referrerOwner = null;
    if (referral_code) {
      referrerPartner = db.prepare('SELECT id FROM partners WHERE partner_code = ? AND active = 1').get(referral_code);
      if (!referrerPartner) {
        referrerOwner = db.prepare('SELECT id FROM salon_owners WHERE owner_code = ? AND active = 1').get(referral_code);
      }
      if (!referrerPartner && !referrerOwner) {
        return sendJson(res, 400, { error: 'Промокод не найден или неактивен' });
      }
    }

    // Менеджер — берётся у самой точки (назначается при её создании), если
    // явно не передан код другого менеджера. Хаб-точки могут не иметь
    // менеджера вовсе (is_hub) — тогда manager_code можно указать отдельно.
    let managerRow = null;
    if (manager_code) {
      managerRow = db.prepare('SELECT id, city_id, mgr_code FROM managers WHERE mgr_code = ? AND active = 1').get(manager_code);
      if (!managerRow) return sendJson(res, 400, { error: 'Код менеджера не найден или неактивен' });
    } else if (point.manager_id) {
      managerRow = db.prepare('SELECT id, city_id, mgr_code FROM managers WHERE id = ?').get(point.manager_id);
    }

    const pointId = point.id;

    const partnerCode = nextPartnerCode();
    const info = db.prepare(`
      INSERT INTO partners
        (partner_code, login, password_hash, full_name, phone, point_id, point_name, point_address,
         legal_form, inn, bank_details, commission_rate, manager_code, referred_by_partner_id, referred_by_owner_id, active,
         display_stand, display_poster, display_basket)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.15, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      partnerCode, login, hashPassword(password), full_name, phone, pointId, point.name, point.addr,
      legal_form || null, inn || null, bank_details || null, managerRow ? managerRow.mgr_code : null,
      referrerPartner ? referrerPartner.id : null, referrerOwner ? referrerOwner.id : null,
      dStand ? 1 : 0, dPoster ? 1 : 0, dBasket ? 1 : 0
    );

    // Привязываем ту же точку к менеджеру — раньше это приходилось делать
    // вручную по Telegram-уведомлению. Если точку создавал администратор
    // вручную, запись в manager_points могла ещё не появиться — заводим её
    // здесь при первой регистрации партнёра, но не дублируем, если она
    // почему-то уже есть.
    if (managerRow) {
      const existingLink = db.prepare('SELECT id FROM manager_points WHERE point_id = ?').get(pointId);
      if (!existingLink) {
        db.prepare(`
          INSERT INTO manager_points (manager_id, point_id, point_name, point_type, revenue, commission_rate, active, bonus_paid)
          VALUES (?, ?, ?, 'Грумминг', 0, ?, 1, 0)
        `).run(managerRow.id, pointId, point.name, computeManagerCommissionRate());
      }
    }

    // Грумеры тоже клиенты «Тайги» — заводим (или находим) карточку клиента
    // с тем же номером телефона. Косточек за саму регистрацию НЕ начисляем
    // (убрано по решению — только customer-registration-бонус остаётся
    // общим механизмом), но карточка нужна, чтобы уже с первого заказа
    // сработал автоматический Gold-кэшбэк для партнёров (см. isActivePartnerPhone
    // в routes-customers.js) — без неё первый заказ ушёл бы по ветке "совсем
    // новый клиент", где кэшбэк вообще не считается.
    const partnerPhoneDigits = normalizePhone(phone);
    if (partnerPhoneDigits) {
      const custRow = db.prepare('SELECT id FROM customers WHERE phone = ?').get(partnerPhoneDigits);
      if (!custRow) {
        db.prepare(`
          INSERT INTO customers (phone, name, orders_count, total_spent)
          VALUES (?, ?, 0, 0)
        `).run(partnerPhoneDigits, full_name || null);
      }
    }

    if (managerPayload && Number(point.manager_id) === Number(managerPayload.id)) {
      logManagerAction(managerPayload.id, 'Регистрация партнёра', {
        type: 'partner', id: info.lastInsertRowid, name: full_name,
        details: partnerCode + ' · точка: ' + point.name,
      });
    }

    sendJson(res, 201, {
      ok: true,
      partner_code: partnerCode,
      id: info.lastInsertRowid,
      message: 'Партнёр зарегистрирован и уже может входить в свой кабинет.',
    });

    // Уведомление уходит уже после ответа клиенту — не задерживаем регистрацию
    sendTelegram([
      '🖊 <b>Новая заявка партнёра — ХвостМаркет</b>',
      '',
      '📋 Код: ' + partnerCode,
      '👤 ' + full_name,
      '📞 ' + phone,
      '📍 Точка: ' + point.name + ' — ' + point.addr,
      legal_form ? '⚖️ Форма: ' + legal_form : '',
      inn ? '🧾 ИНН: ' + inn : '',
      manager_code ? '🌟 Менеджер: ' + manager_code : '',
      referrerPartner ? '🤝 Приведён по промокоду грумера: ' + referral_code + ' (когда точка заработает компании 2 000 ₽ прибыли, по 1 000 ₽ достанется грумеру и менеджеру)' : '',
      referrerOwner ? '🏠 Приведён по промокоду владельца салона: ' + referral_code + ' (когда точка заработает компании 2 000 ₽ прибыли, по 1 000 ₽ достанется владельцу и менеджеру)' : '',
      '📐 Формат: ' + [dStand && 'стойка', dPoster && 'картинка', dBasket && 'корзинка'].filter(Boolean).join(', '),
      '',
      '→ Проверьте заявку в админке (раздел «Партнёры») и активируйте, если всё в порядке.',
    ].filter(Boolean).join('\n')).catch(function() {});
  });

  // GET /api/partners — список всех (для админки)
  router.get('/api/partners', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const requestedDays = Number.parseInt(ctx.query && ctx.query.days, 10);
    const days = Number.isFinite(requestedDays) && requestedDays >= 1 && requestedDays <= 365
      ? requestedDays
      : 7;
    const rows = db.prepare('SELECT * FROM partners ORDER BY id DESC').all();
    // Считаем начисление так же, как в кабинете грумера: только оплаченные
    // заказы, а процент берём из снимка commission_rate самого заказа.
    // Округление выполняется по каждому заказу отдельно, поэтому итог в
    // админке совпадает с суммой строк в партнёрском кабинете.
    const paidOrders = db.prepare(`
      SELECT partner_id, total, commission_rate
      FROM orders
      WHERE status = 'paid'
        AND partner_id IS NOT NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
    `).all(days);
    const earningsByPartner = new Map();
    const orderCountByPartner = new Map();
    paidOrders.forEach((order) => {
      const partnerId = Number(order.partner_id);
      const commission = Math.round(Number(order.total || 0) * Number(order.commission_rate || 0));
      earningsByPartner.set(partnerId, (earningsByPartner.get(partnerId) || 0) + commission);
      orderCountByPartner.set(partnerId, (orderCountByPartner.get(partnerId) || 0) + 1);
    });
    const partners = rows.map((row) => {
      const unpaid = getUnpaidSummary(row.id);
      return {
        ...safePartner(row),
        current_earnings: unpaid.amount,
        unpaid_orders_count: unpaid.orders_count,
        period_earnings: earningsByPartner.get(Number(row.id)) || 0,
        period_paid_orders_count: orderCountByPartner.get(Number(row.id)) || 0,
      };
    });
    sendJson(res, 200, { partners, period_days: days });
  });

  // История всех выплат грумерам для административного кабинета.
  router.get('/api/partner-payouts', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.max(1, Math.min(500, parseInt(ctx.query.limit, 10) || 100));
    sendJson(res, 200, { payouts: listAllPartnerPayouts(limit) });
  });

  // Администратор подтверждает фактическую выплату. В одну транзакцию
  // записываем саму выплату и все заказы, комиссия по которым в неё вошла.
  router.post('/api/partners/:id/payouts', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      const payout = createPartnerPayout(Number(ctx.params.id), payload);
      sendJson(res, 201, { ok: true, payout });
    } catch (error) {
      if (error.code === 'PARTNER_NOT_FOUND') return sendJson(res, 404, { error: error.message });
      if (error.code === 'NOTHING_TO_PAY') return sendJson(res, 409, { error: error.message });
      console.error('[partner-payout] Не удалось зафиксировать выплату:', error);
      sendJson(res, 500, { error: 'Не удалось зафиксировать выплату' });
    }
  });

  // PUT /api/partners/me — партнёр сам меняет формат размещения на своей точке
  // (стойка/картинка/корзинка, можно сочетать). Больше ничего через этот
  // эндпоинт менять нельзя — остальные поля (тариф, статус и т.п.) правит
  // только админ через /api/partners/:id.
  // ВАЖНО: регистрируется ДО '/api/partners/:id' — иначе роутер (простое
  // сопоставление по порядку регистрации) примет 'me' за :id и эта ручка
  // никогда не сработает.
  router.put('/api/partners/me', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM partners WHERE id = ?').get(payload.id);
    if (!existing) return sendJson(res, 404, { error: 'Партнёр не найден' });
    const { display_stand, display_poster, display_basket } = ctx.body || {};

    const nextStand = display_stand !== undefined ? !!display_stand : !!existing.display_stand;
    const nextPoster = display_poster !== undefined ? !!display_poster : !!existing.display_poster;
    const nextBasket = display_basket !== undefined ? !!display_basket : !!existing.display_basket;
    if (!nextStand && !nextPoster && !nextBasket) {
      return sendJson(res, 400, { error: 'Нужно оставить хотя бы один формат размещения: стойка, картинка или корзинка' });
    }

    db.prepare('UPDATE partners SET display_stand = ?, display_poster = ?, display_basket = ? WHERE id = ?')
      .run(nextStand ? 1 : 0, nextPoster ? 1 : 0, nextBasket ? 1 : 0, payload.id);
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/partners/:id — админ активирует/меняет тариф/деактивирует
  router.put('/api/partners/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM partners WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Партнёр не найден' });
    const {
      active, commission_rate, full_name, phone, point_name, point_address, point_id,
      display_stand, display_poster, display_basket,
    } = ctx.body || {};

    // Привязка к существующей точке — так несколько грумеров могут работать
    // с одной и той же точкой (общий складской учёт), а не заводить каждый
    // свою отдельную с нуля.
    if (point_id !== undefined && point_id !== existing.point_id) {
      if (point_id) {
        const pointRow = db.prepare('SELECT * FROM points WHERE id = ?').get(point_id);
        if (!pointRow) return sendJson(res, 400, { error: 'Точка с таким id не найдена' });
      }
    }

    // Если формат размещения передан явно (хотя бы одно из трёх полей) —
    // проверяем, что хотя бы один вариант остаётся включённым.
    const formatTouched = display_stand !== undefined || display_poster !== undefined || display_basket !== undefined;
    const nextStand = display_stand !== undefined ? !!display_stand : !!existing.display_stand;
    const nextPoster = display_poster !== undefined ? !!display_poster : !!existing.display_poster;
    const nextBasket = display_basket !== undefined ? !!display_basket : !!existing.display_basket;
    if (formatTouched && !nextStand && !nextPoster && !nextBasket) {
      return sendJson(res, 400, { error: 'Нужно оставить хотя бы один формат размещения: стойка, картинка или корзинка' });
    }

    db.prepare(`
      UPDATE partners SET
        active = ?, commission_rate = ?, full_name = ?, phone = ?, point_name = ?, point_address = ?, point_id = ?,
        display_stand = ?, display_poster = ?, display_basket = ?
      WHERE id = ?
    `).run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      commission_rate ?? existing.commission_rate,
      full_name ?? existing.full_name,
      phone ?? existing.phone,
      point_name ?? existing.point_name,
      point_address !== undefined ? point_address : existing.point_address,
      point_id !== undefined ? (point_id || null) : existing.point_id,
      nextStand ? 1 : 0, nextPoster ? 1 : 0, nextBasket ? 1 : 0,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/partners/:id/reset-password — админ сбрасывает пароль партнёру,
  // видит новый пароль один раз и сообщает лично (email/телефон в базе нет).
  router.post('/api/partners/:id/reset-password', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT id FROM partners WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Партнёр не найден' });
    const newPassword = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE partners SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), ctx.params.id);
    sendJson(res, 200, { ok: true, new_password: newPassword });
  });

  // GET /api/partners/me/referral-bonuses — сколько заработал за приведённых грумеров
  router.get('/api/partners/me/referral-bonuses', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare(`
      SELECT ap.point_name, ap.referred_groomer_amount, ap.bonus_paid,
             p.full_name AS referred_partner_name
      FROM manager_points ap
      JOIN partners p ON p.point_id = ap.point_id
      WHERE ap.referred_groomer_id = ? AND ap.bonus_paid = 1
    `).all(payload.id);
    const total = rows.reduce((s, r) => s + (r.referred_groomer_amount || 0), 0);
    sendJson(res, 200, { bonuses: rows, total });
  });

  // GET /api/partners/me — собственный кабинет партнёра
  router.get('/api/partners/me', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(payload.id);
    if (!partner) return sendJson(res, 404, { error: 'Не найдено' });
    // city_id живёт на самой точке, не на партнёре — подтягиваем отдельно,
    // чтобы кабинет мог показать город, в котором физически работает грумер.
    const point = partner.point_id ? db.prepare('SELECT city_id FROM points WHERE id = ?').get(partner.point_id) : null;
    sendJson(res, 200, { partner: { ...safePartner(partner), city_id: point ? point.city_id : null } });
  });

  // GET /api/partners/me/tier-progress — сколько осталось до следующего
  // уровня комиссии (по выручке за 30 дней или числу рефералов).
  router.get('/api/partners/me/tier-progress', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const { getTierProgress } = require('./partner-tiers');
    const progress = getTierProgress(payload.id);
    if (!progress) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, progress);
  });

  // GET /api/partners/me/stock — остатки на своей точке (только если включён складской учёт)
  router.get('/api/partners/me/stock', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(payload.id);
    if (!partner) return sendJson(res, 404, { error: 'Не найдено' });
    if (!partner.point_id) return sendJson(res, 200, { stock: [], point_id: null });
    const rows = db.prepare(`
      SELECT s.variant_id, s.qty, v.weight, v.price, p.name AS product_name
      FROM stock s
      JOIN product_variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE s.point_id = ?
      ORDER BY p.name, v.sort_order
    `).all(partner.point_id);
    sendJson(res, 200, { stock: rows, point_id: partner.point_id });
  });

  // POST /api/partners/me/restock-signal — грумер сигнализирует о нехватке товара на своей точке.
  // Заявка автоматически привязывается к менеджеру, ответственному за точку
  // (если он есть) — именно он физически привезёт пополнение.
  router.post('/api/partners/me/restock-signal', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(payload.id);
    if (!partner) return sendJson(res, 404, { error: 'Не найдено' });
    if (!partner.point_id) {
      return sendJson(res, 400, { error: 'У вашей точки не включён складской учёт — обратитесь к администратору' });
    }
    const { items } = ctx.body || {}; // [{ variant_id, qty }]
    if (!Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: 'Укажите items — список variant_id и qty' });
    }
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(partner.point_id);
    const info = db.prepare(`
      INSERT INTO restock_requests (manager_id, point_id, initiated_by, status)
      VALUES (?, ?, 'partner', 'pending')
    `).run(point.manager_id || null, partner.point_id);
    const requestId = info.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO restock_request_items (request_id, variant_id, qty_requested) VALUES (?, ?, ?)');
    for (const item of items) insItem.run(requestId, item.variant_id, item.qty);

    sendTelegram([
      '📦 <b>Грумер запросил пополнение — ХвостМаркет</b>',
      '',
      '👤 ' + partner.full_name + ' (' + partner.partner_code + ')',
      '📍 Точка: ' + partner.point_name,
      '',
      items.length + ' позиций — подробности в админке, раздел «Заявки на пополнение»',
    ].join('\n')).catch(() => {});

    sendJson(res, 201, { ok: true, request_id: requestId });
  });

  // DELETE /api/partners/:id — админ удаляет партнёра безвозвратно (для
  // очистки тестовых данных). Если по партнёру уже прошли реальные оплаченные
  // заказы (комиссия начисляется от истории заказов, а не хранится отдельной
  // пометкой) или ему уже выплачен реферальный бонус за привлечение точки —
  // удаление запрещено, чтобы не потерять эту историю. Точка, к которой был
  // привязан партнёр, НЕ удаляется — просто теряет партнёра, как раньше было
  // с менеджером на точке.
  router.delete('/api/partners/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const id = ctx.params.id;
    const existing = db.prepare('SELECT id FROM partners WHERE id = ?').get(id);
    if (!existing) return sendJson(res, 404, { error: 'Партнёр не найден' });

    const { force, restore_stock } = ctx.body || {};
    const paidOrders = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE partner_id = ? AND status = 'paid'").get(id).c;
    if (paidOrders > 0 && !force) {
      return sendJson(res, 400, {
        error: 'По партнёру есть ' + paidOrders + ' оплаченных заказ(ов) — удаление скроет эту историю. Деактивируйте вместо удаления, либо удалите принудительно (это также откатит и удалит эти заказы).',
        hasPaidOrders: true,
        paidOrders,
      });
    }
    const paidReferralBonus = db.prepare('SELECT COUNT(*) AS c FROM manager_points WHERE referred_groomer_id = ? AND bonus_paid = 1').get(id).c;
    if (paidReferralBonus > 0 && !force) {
      return sendJson(res, 400, {
        error: 'Партнёру уже выплачен реферальный бонус за привлечённую точку — удаление скроет эту историю. Деактивируйте вместо удаления, либо удалите принудительно.',
        hasPaidReferralBonus: true,
      });
    }

    // Принудительное удаление — сначала откатываем последствия (статистика
    // клиента, косточки, опционально остаток) и удаляем все оплаченные
    // заказы партнёра, как при принудительном удалении отдельного заказа.
    // Только для тестовых данных.
    if (paidOrders > 0 && force) {
      reverseAndDeleteOrdersBy('partner_id', id, !!restore_stock);
    } else {
      db.prepare('UPDATE orders SET partner_id = NULL WHERE partner_id = ?').run(id);
    }
    db.prepare('UPDATE partners SET referred_by_partner_id = NULL WHERE referred_by_partner_id = ?').run(id);
    db.prepare('UPDATE manager_points SET referred_groomer_id = NULL WHERE referred_groomer_id = ?').run(id);
    db.prepare('DELETE FROM partners WHERE id = ?').run(id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/partners/me/orders?days=N — реальные заказы партнёра за период,
  // с реальной комиссией по каждому. Раньше кабинет грумера (Главная, Мои
  // начисления, Мои продажи) показывал СЛУЧАЙНО СГЕНЕРИРОВАННЫЕ демо-данные
  // (genOrders/genDays на фронтенде) — партнёр никогда не видел настоящих
  // продаж, сколько бы их ни было. Теперь отдаём реальную историю.
  router.get('/api/partners/me/orders', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const days = Math.max(1, Math.min(365, parseInt(ctx.query.days, 10) || 7));

    const orders = db.prepare(`
      SELECT id, order_code, customer_name, customer_lname, total, commission_rate, status, created_at
      FROM orders
      WHERE partner_id = ? AND status = 'paid' AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `).all(payload.id, days);

    const result = orders.map((o) => {
      const items = db.prepare('SELECT name, weight, qty, price FROM order_items WHERE order_id = ? AND is_custom = 0').all(o.id);
      const productLabel = items.map((i) => i.name + ' (' + i.weight + ')' + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ') || 'Товар не из каталога';
      const commission = Math.round(o.total * (o.commission_rate ?? 0));
      return {
        id: o.id,
        order_code: o.order_code,
        customer_name: (o.customer_name + ' ' + (o.customer_lname || '')).trim(),
        product: productLabel,
        items: items.map((i) => ({ name: i.name, qty: i.qty, commission: Math.round(i.price * i.qty * (o.commission_rate ?? 0)) })),
        sum: o.total,
        commission,
        date: o.created_at,
      };
    });

    sendJson(res, 200, { orders: result });
  });

  // Текущий невыплаченный баланс и история фактических выплат для кабинета
  // самого грумера. Начисления за выбранный период остаются в /me/orders.
  router.get('/api/partners/me/payouts', (req, res, ctx) => {
    const payload = requireAuth(['partner'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.max(1, Math.min(200, parseInt(ctx.query.limit, 10) || 100));
    const unpaid = getUnpaidSummary(payload.id);
    sendJson(res, 200, {
      unpaid_amount: unpaid.amount,
      unpaid_orders_count: unpaid.orders_count,
      payouts: listPartnerPayouts(payload.id, limit),
    });
  });
}


module.exports = { registerPartnerRoutes };
