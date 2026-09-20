// routes-managers.js — управление менеджерами и их привязанными точками.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

function nextMgrCode() {
  const row = db.prepare("SELECT mgr_code FROM managers ORDER BY id DESC LIMIT 1").get();
  const year = new Date().getFullYear();
  const lastNum = row ? parseInt(row.mgr_code.split('-').pop(), 10) : 0;
  return `MGR-${year}-` + String(lastNum + 1).padStart(3, '0');
}

function safeMgr(a) {
  const { password_hash, ...rest } = a;
  return rest;
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
  router.post('/api/managers', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { full_name, phone, login, password, legal_form, inn, bank_details, city_id } = ctx.body || {};
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
      INSERT INTO managers (mgr_code, login, password_hash, full_name, phone, legal_form, inn, bank_details, city_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(code, login, hashPassword(password), full_name, phone, legal_form || null, inn || null, bank_details || null, cityId);
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
    const { active, full_name, phone, legal_form, inn, bank_details } = ctx.body || {};
    db.prepare('UPDATE managers SET active=?, full_name=?, phone=?, legal_form=?, inn=?, bank_details=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      full_name ?? existing.full_name,
      phone ?? existing.phone,
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
}

module.exports = { registerManagerRoutes, computeManagerCommissionRate };
