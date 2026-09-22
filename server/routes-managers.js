// routes-managers.js — управление менеджерами и их привязанными точками.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');
const { logManagerAction } = require('./audit-log');
const { getUnpaidSummary, listManagerPartnerPayouts } = require('./partner-payouts');

function nextMgrCode() {
  const row = db.prepare("SELECT mgr_code FROM managers ORDER BY id DESC LIMIT 1").get();
  const year = new Date().getFullYear();
  const lastNum = row ? parseInt(row.mgr_code.split('-').pop(), 10) : 0;
  return `MGR-${year}-` + String(lastNum + 1).padStart(3, '0');
}

function safeMgr(a) {
  const { password_hash, telegram_chat_id, ...rest } = a;
  return { ...rest, telegram_connected: !!telegram_chat_id };
}

// Вознаграждение менеджера — постоянная ставка 7% со всех точек, без
// ступеней по числу привлечённых точек.
const MANAGER_COMMISSION_RATE = 0.07;

function computeManagerCommissionRate() {
  return MANAGER_COMMISSION_RATE;
}

function mgrWithPoints(a) {
  // revenue у manager_points — это исторически хранимая колонка, которая
  // нигде не увеличивается при реальных продажах (заводится нулём при
  // создании точки/назначении менеджера и так и остаётся). Раньше кабинет
  // менеджера показывал именно её — то есть доход всегда был 0, сколько бы
  // ни было настоящих продаж. Теперь считаем выручку живым запросом по
  // реальным оплаченным заказам этой точки, а не по замороженной колонке.
  const points = db.prepare(`
    SELECT ap.*, rp.full_name AS referred_groomer_name, rp.partner_code AS referred_groomer_code,
           p.city_id AS actual_point_city_id, p.icon AS actual_point_icon,
           COALESCE((SELECT SUM(o.total) FROM orders o WHERE o.point_id = ap.point_id AND o.status = 'paid'), 0) AS live_revenue
    FROM manager_points ap
    LEFT JOIN partners rp ON rp.id = ap.referred_groomer_id
    LEFT JOIN points p ON p.id = ap.point_id
    WHERE ap.manager_id = ?
  `).all(a.id).map((row) => ({ ...row, revenue: row.live_revenue }));
  return { ...safeMgr(a), points };
}

function registerManagerRoutes(router) {
  // POST /api/managers — админ создаёт нового менеджера (по договорённости, не самостоятельная регистрация)
  router.post('/api/managers', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { full_name, phone, email, login, password, legal_form, inn, bank_details, city_id } = ctx.body || {};
    if (!full_name || !phone || !login || !password) {
      return sendJson(res, 400, { error: 'Заполните ФИО, телефон, логин и пароль' });
    }
    const existingLogin = db.prepare('SELECT id FROM managers WHERE login = ?').get(login);
    if (existingLogin) return sendJson(res, 409, { error: 'Такой логин уже занят' });
    const cityId = city_id || 'krsk';
    if (!db.prepare('SELECT id FROM cities WHERE id = ?').get(cityId)) {
      return sendJson(res, 400, { error: 'Неизвестный город: ' + cityId });
    }

    const code = nextMgrCode();
    const info = db.prepare(`
      INSERT INTO managers (mgr_code, login, password_hash, full_name, phone, email, legal_form, inn, bank_details, city_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(code, login, hashPassword(password), full_name, phone, email || null, legal_form || null, inn || null, bank_details || null, cityId);

    const cityRow = db.prepare('SELECT name FROM cities WHERE id = ?').get(cityId);
    await sendTelegram([
      '🌟 <b>Новый менеджер</b>',
      '',
      '👤 ' + full_name + ' (' + code + ')',
      '📞 ' + phone,
      '🔑 Логин: ' + login,
      '🏙 ' + (cityRow ? cityRow.name : cityId),
      '👤 Создал администратор: ' + payload.login,
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' }),
    ].join('\n'));

    sendJson(res, 201, { ok: true, mgr_code: code, id: info.lastInsertRowid });
  });

  // GET /api/managers — список для админки, можно отфильтровать по городу (?city=krsk)
  router.get('/api/managers', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const cityFilter = ctx.query.city || null;
    const rows = cityFilter
      ? db.prepare('SELECT * FROM managers WHERE city_id = ? ORDER BY id DESC').all(cityFilter)
      : db.prepare('SELECT * FROM managers ORDER BY id DESC').all();
    sendJson(res, 200, { managers: rows.map(mgrWithPoints) });
  });

  // PUT /api/managers/:id — админ меняет активность/данные
  router.put('/api/managers/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM managers WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Менеджер не найден' });
    const { active, full_name, phone, email, legal_form, inn, bank_details } = ctx.body || {};
    db.prepare('UPDATE managers SET active=?, full_name=?, phone=?, email=?, legal_form=?, inn=?, bank_details=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      full_name ?? existing.full_name,
      phone ?? existing.phone,
      email !== undefined ? email : existing.email,
      legal_form !== undefined ? legal_form : existing.legal_form,
      inn !== undefined ? inn : existing.inn,
      bank_details !== undefined ? bank_details : existing.bank_details,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/managers/:id/reset-password — админ сбрасывает пароль менеджеру
  router.post('/api/managers/:id/reset-password', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT id FROM managers WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Менеджер не найден' });
    const newPassword = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), ctx.params.id);
    sendJson(res, 200, { ok: true, new_password: newPassword });
  });

  // POST /api/managers/:id/points — добавить привлечённую точку.
  // Если передан address — точка сразу заводится в общий справочник points
  // с полноценным складским учётом (нужно для еженедельных заявок на пополнение).
  router.post('/api/managers/:id/points', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    if (payload.role === 'manager' && String(payload.id) !== String(ctx.params.id)) {
      return sendJson(res, 403, { error: 'Можно добавлять точки только себе' });
    }
    const { point_name, point_type, address, icon } = ctx.body || {};
    if (!point_name || !point_type) return sendJson(res, 400, { error: 'Укажите point_name и point_type' });

    let pointId = null;
    if (address) {
      const { slugify } = require('./routes-warehouse');
      let base = slugify(point_name);
      let candidate = base, i = 1;
      while (db.prepare('SELECT id FROM points WHERE id = ?').get(candidate)) candidate = base + '-' + (++i);
      pointId = candidate;
      db.prepare('INSERT INTO points (id, name, addr, icon, manager_id, is_hub) VALUES (?, ?, ?, ?, ?, 0)')
        .run(pointId, point_name, address, icon || '📍', ctx.params.id);
      const products = db.prepare('SELECT id FROM products').all();
      for (const p of products) {
        const variants = db.prepare('SELECT id FROM product_variants WHERE product_id = ?').all(p.id);
        for (const v of variants) {
          db.prepare('INSERT OR IGNORE INTO stock (variant_id, point_id, qty) VALUES (?, ?, 0)').run(v.id, pointId);
        }
      }
    }

    const info = db.prepare(`
      INSERT INTO manager_points (manager_id, point_id, point_name, point_type, revenue, commission_rate, active, bonus_paid)
      VALUES (?, ?, ?, ?, 0, ?, 1, 0)
    `).run(ctx.params.id, pointId, point_name, point_type, computeManagerCommissionRate());
    if (payload.role === 'manager') {
      logManagerAction(payload.id, 'Создание точки', {
        type: 'point', id: pointId || info.lastInsertRowid, name: point_name,
        details: address ? String(address) : String(point_type),
      });
    }
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid, point_id: pointId });
  });

  // GET /api/managers/me — собственный кабинет менеджера
  router.get('/api/managers/me', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const mgr = db.prepare('SELECT * FROM managers WHERE id = ?').get(payload.id);
    if (!mgr) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { manager: mgrWithPoints(mgr) });
  });

  // PUT /api/manager/profile — менеджер сохраняет собственные контактные данные.
  // Отдельный путь исключает пересечение с административным /api/managers/:id.
  // и реквизиты. Запись идёт в SQLite в /data, поэтому переживает новый деплой.
  router.put('/api/manager/profile', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM managers WHERE id = ?').get(payload.id);
    if (!existing) return sendJson(res, 404, { error: 'Менеджер не найден' });

    const body = ctx.body || {};
    const fullName = body.full_name !== undefined ? String(body.full_name).trim() : existing.full_name;
    const phone = body.phone !== undefined ? String(body.phone).trim() : existing.phone;
    const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : (existing.email || '');
    const legalForm = body.legal_form !== undefined ? String(body.legal_form).trim() : (existing.legal_form || '');
    const inn = body.inn !== undefined ? String(body.inn).replace(/\D/g, '') : (existing.inn || '');
    const bankDetails = body.bank_details !== undefined ? String(body.bank_details).trim() : (existing.bank_details || '');

    if (!fullName) return sendJson(res, 400, { error: 'Укажите ФИО' });
    if (phone.replace(/\D/g, '').length < 10) return sendJson(res, 400, { error: 'Укажите корректный телефон' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: 'Укажите корректный email' });
    }
    if (legalForm && !['npd', 'ip', 'ooo'].includes(legalForm)) {
      return sendJson(res, 400, { error: 'Неизвестная форма работы' });
    }
    if (inn && ![10, 12].includes(inn.length)) {
      return sendJson(res, 400, { error: 'ИНН должен содержать 10 или 12 цифр' });
    }
    if (fullName.length > 200 || phone.length > 40 || email.length > 254 || bankDetails.length > 3000) {
      return sendJson(res, 400, { error: 'Одно из полей слишком длинное' });
    }

    db.prepare(`
      UPDATE managers
      SET full_name = ?, phone = ?, email = ?, legal_form = ?, inn = ?, bank_details = ?
      WHERE id = ?
    `).run(fullName, phone, email || null, legalForm || null, inn || null, bankDetails || null, payload.id);
    const updated = db.prepare('SELECT * FROM managers WHERE id = ?').get(payload.id);
    logManagerAction(payload.id, 'Обновление профиля', { type: 'manager', id: payload.id, name: fullName });
    sendJson(res, 200, { ok: true, manager: mgrWithPoints(updated) });
  });

  // GET /api/managers/me/orders?days=N — заказы только с точек текущего
  // менеджера. Имя грумера берём из снимка в заказе, а для старых записей
  // используем действующую карточку партнёра.
  router.get('/api/managers/me/orders', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const days = Math.max(1, Math.min(365, parseInt(ctx.query.days, 10) || 30));
    const limit = Math.max(1, Math.min(500, parseInt(ctx.query.limit, 10) || 200));
    const orders = db.prepare(`
      SELECT o.id, o.order_code, o.customer_name, o.customer_lname,
             o.pickup_point, o.point_id, o.total, o.payment_method,
             o.status, o.refund_status, o.refunded_amount, o.created_at,
             pt.name AS point_name,
             COALESCE(o.partner_name, pr.full_name) AS partner_name
      FROM orders o
      JOIN points pt ON pt.id = o.point_id
      LEFT JOIN partners pr ON pr.id = o.partner_id
      WHERE pt.manager_id = ?
        AND o.created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY o.id DESC
      LIMIT ?
    `).all(payload.id, days, limit);
    const getItems = db.prepare('SELECT variant_id, name, weight, price, qty, is_custom FROM order_items WHERE order_id = ?');
    sendJson(res, 200, {
      orders: orders.map((order) => ({ ...order, items: getItems.all(order.id) })),
      days,
    });
  });

  // DELETE /api/managers/:id — админ удаляет менеджера безвозвратно. Точки,
  // которые он вёл, НЕ удаляются — просто теряют привязку (manager_id
  // становится NULL), их можно назначить другому менеджеру позже. Если
  // менеджеру уже выплачивались реальные бонусы за запуск точек — удаление
  // запрещено, чтобы не потерять эту историю (в этом случае предлагаем
  // деактивацию вместо удаления).
  router.delete('/api/managers/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const id = ctx.params.id;
    const existing = db.prepare('SELECT id FROM managers WHERE id = ?').get(id);
    if (!existing) return sendJson(res, 404, { error: 'Менеджер не найден' });

    const { force } = ctx.body || {};
    const paidBonuses = db.prepare('SELECT COUNT(*) AS c FROM manager_points WHERE manager_id = ? AND bonus_paid = 1').get(id).c;
    if (paidBonuses > 0 && !force) {
      return sendJson(res, 400, {
        error: 'Менеджеру уже выплачено ' + paidBonuses + ' бонус(ов) за точки — удаление скроет эту историю. Деактивируйте вместо удаления, либо удалите принудительно.',
        hasPaidBonuses: true,
        paidBonuses,
      });
    }

    db.prepare('UPDATE points SET manager_id = NULL WHERE manager_id = ?').run(id);
    db.prepare('DELETE FROM manager_points WHERE manager_id = ?').run(id);
    db.prepare('DELETE FROM managers WHERE id = ?').run(id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/managers/me/daily-residual?days=N — реальный резидуал по дням
  // за период, по ВСЕМ точкам менеджера сразу. Раньше график "Residual по
  // дням" в кабинете рисовал случайные цифры (genDays на фронтенде),
  // никак не связанные с настоящими продажами.
  router.get('/api/managers/me/daily-residual', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const days = Math.max(1, Math.min(365, parseInt(ctx.query.days, 10) || 7));

    const rows = db.prepare(`
      SELECT o.created_at AS date, o.total * mp.commission_rate AS residual
      FROM orders o
      JOIN manager_points mp ON mp.point_id = o.point_id AND mp.manager_id = ?
      WHERE o.status = 'paid' AND o.created_at >= datetime('now', '-' || ? || ' days')
    `).all(payload.id, days);

    const byDate = {};
    rows.forEach((r) => {
      const key = r.date.slice(0, 10);
      byDate[key] = (byDate[key] || 0) + r.residual;
    });

    const labels = [], earn = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }));
      earn.push(Math.round(byDate[key] || 0));
    }
    sendJson(res, 200, { labels, earn });
  });
  // GET /api/managers/me/stock — остатки по ВСЕМ точкам менеджера сразу,
  // сгруппированные по точке. Товары с нулевым остатком тоже показываем —
  // это как раз то, что менеджеру нужно увидеть в первую очередь (что
  // закончилось, куда нужно везти пополнение).
  router.get('/api/managers/me/stock', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const points = db.prepare('SELECT id, name, icon FROM points WHERE manager_id = ? ORDER BY name').all(payload.id);
    const result = points.map((point) => {
      const rows = db.prepare(`
        SELECT s.variant_id, s.qty, v.weight, p.name AS product_name
        FROM stock s
        JOIN product_variants v ON v.id = s.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE s.point_id = ?
        ORDER BY p.name, v.sort_order
      `).all(point.id);
      return { point_id: point.id, point_name: point.name, point_icon: point.icon, items: rows };
    });
    sendJson(res, 200, { points: result });
  });
  // GET /api/managers/me/partners — партнёры на ВСЕХ точках менеджера, с
  // реальными результатами продаж за период. Показывает менеджеру, кто
  // сейчас работает на его точках и как у них идут дела — без этого
  // менеджер видел только свою собственную выручку по точке в целом, не
  // видя, кто конкретно из партнёров её приносит.
  router.get('/api/managers/me/partners', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const days = Math.max(1, Math.min(365, parseInt(ctx.query.days, 10) || 30));

    const points = db.prepare('SELECT id, name, icon FROM points WHERE manager_id = ? ORDER BY name').all(payload.id);
    const result = points.map((point) => {
      const partners = db.prepare(`
        SELECT id, partner_code, full_name, phone, commission_rate, active
        FROM partners WHERE point_id = ? ORDER BY full_name
      `).all(point.id);
      const withStats = partners.map((p) => {
        const stats = db.prepare(`
          SELECT COUNT(*) AS orders_count, COALESCE(SUM(total), 0) AS revenue
          FROM orders
          WHERE partner_id = ? AND status = 'paid' AND created_at >= datetime('now', '-' || ? || ' days')
        `).get(p.id, days);
        return {
          id: p.id,
          partner_code: p.partner_code,
          full_name: p.full_name,
          phone: p.phone,
          commission_rate: p.commission_rate,
          active: !!p.active,
          orders_count: stats.orders_count,
          revenue: stats.revenue,
          commission_earned: Math.round(stats.revenue * p.commission_rate),
          unpaid_earnings: getUnpaidSummary(p.id).amount,
        };
      });
      return { point_id: point.id, point_name: point.name, point_icon: point.icon, partners: withStats };
    });
    sendJson(res, 200, { points: result });
  });

  // Выплаты грумерам, закреплённым за точками этого менеджера. manager_id и
  // имя фиксируются в момент выплаты, поэтому история не меняется при
  // последующем переназначении точки другому менеджеру.
  router.get('/api/managers/me/partner-payouts', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.max(1, Math.min(200, parseInt(ctx.query.limit, 10) || 100));
    sendJson(res, 200, { payouts: listManagerPartnerPayouts(payload.id, limit) });
  });
}

module.exports = { registerManagerRoutes, computeManagerCommissionRate };
