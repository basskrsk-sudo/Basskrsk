// routes-owners.js — владельцы салонов: создание аккаунтов (админ) и
// дашборд статистики по своей точке (сам владелец). Один владелец видит
// одну точку целиком — общую выручку, разбивку по каждому грумеру на ней
// и по менеджеру, который её курирует.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');
const { logManagerAction } = require('./audit-log');
const {
  createOwnerPayout,
  getOwnerUnpaidSummary,
  listAllOwnerPayouts,
  listOwnerPayouts,
} = require('./owner-payouts');

function safeOwner(o) {
  const { password_hash, telegram_chat_id, ...rest } = o;
  return { ...rest, telegram_connected: !!telegram_chat_id };
}

function registerOwnerRoutes(router) {
  // POST /api/salon-owners — админ создаёт аккаунт владельца, сразу
  // привязывая к точке.
  router.post('/api/salon-owners', async (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    const { full_name, phone, login, password, point_id } = ctx.body || {};
    if (!full_name || !phone || !login || !password) {
      return sendJson(res, 400, { error: 'Заполните ФИО, телефон, логин и пароль' });
    }
    // Менеджер может регистрировать владельца только на СВОЮ точку — админ,
    // как и раньше, может указать любую точку или вовсе оставить пустой.
    if (payload.role === 'manager') {
      if (!point_id) return sendJson(res, 400, { error: 'Выберите точку' });
      const point = db.prepare('SELECT id, manager_id FROM points WHERE id = ?').get(point_id);
      if (!point) return sendJson(res, 400, { error: 'Точка с таким id не найдена' });
      if (point.manager_id !== payload.id) {
        return sendJson(res, 403, { error: 'Эта точка не закреплена за вами' });
      }
    } else if (point_id) {
      const point = db.prepare('SELECT id FROM points WHERE id = ?').get(point_id);
      if (!point) return sendJson(res, 400, { error: 'Точка с таким id не найдена' });
    }
    if (point_id) {
      const existingOwner = db.prepare('SELECT id FROM salon_owners WHERE point_id = ?').get(point_id);
      if (existingOwner) return sendJson(res, 409, { error: 'На эту точку уже зарегистрирован владелец' });
    }
    const existingLogin = db.prepare('SELECT id FROM salon_owners WHERE login = ?').get(login);
    if (existingLogin) return sendJson(res, 409, { error: 'Такой логин уже занят' });

    const info = db.prepare(`
      INSERT INTO salon_owners (login, password_hash, full_name, phone, point_id, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(login, hashPassword(password), full_name, phone, point_id || null);
    // Реферальный код присваивается сразу после вставки — включает
    // собственный id владельца, поэтому не может быть частью самого INSERT.
    const ownerCode = 'OWN-' + String(info.lastInsertRowid).padStart(3, '0');
    db.prepare('UPDATE salon_owners SET owner_code = ? WHERE id = ?').run(ownerCode, info.lastInsertRowid);

    const pointRow = point_id ? db.prepare('SELECT name FROM points WHERE id = ?').get(point_id) : null;
    const creatorLine = payload.role === 'manager'
      ? '👤 Создал менеджер: ' + payload.login
      : '👤 Создал администратор: ' + payload.login;
    await sendTelegram([
      '🏠 <b>Новый владелец салона</b>',
      '',
      '👤 ' + full_name + ' (' + ownerCode + ')',
      '📞 ' + phone,
      '🔑 Логин: ' + login,
      '📍 Точка: ' + (pointRow ? pointRow.name : 'не привязана'),
      creatorLine,
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' }),
    ].join('\n'));

    if (payload.role === 'manager') {
      logManagerAction(payload.id, 'Регистрация владельца салона', {
        type: 'salon_owner', id: info.lastInsertRowid, name: full_name,
        details: 'Точка: ' + (pointRow ? pointRow.name : point_id),
      });
    }

    sendJson(res, 201, { ok: true, id: info.lastInsertRowid, owner_code: ownerCode });
  });

  // GET /api/salon-owners — список для админки
  router.get('/api/salon-owners', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const rows = db.prepare(`
      SELECT
        so.*,
        p.name AS point_name,
        COUNT(o.id) AS paid_orders_count,
        COALESCE(SUM(o.total), 0) AS paid_revenue,
        COALESCE(SUM(
          CASE
            WHEN o.created_at >= datetime('now', 'start of month') THEN o.total
            ELSE 0
          END
        ), 0) AS month_paid_revenue
      FROM salon_owners so
      LEFT JOIN points p ON p.id = so.point_id
      LEFT JOIN orders o ON o.point_id = so.point_id AND o.status = 'paid'
      GROUP BY so.id
      ORDER BY so.id DESC
    `).all();
    const owners = rows.map((row) => {
      const commissionRate = Number(row.commission_rate || 0);
      const unpaid = getOwnerUnpaidSummary(row.id);
      return safeOwner({
        ...row,
        paid_orders_count: Number(row.paid_orders_count || 0),
        paid_revenue: Number(row.paid_revenue || 0),
        accrued_earnings: Math.round(Number(row.paid_revenue || 0) * commissionRate),
        month_earnings: Math.round(Number(row.month_paid_revenue || 0) * commissionRate),
        current_earnings: unpaid.amount,
        unpaid_orders_count: unpaid.orders_count,
      });
    });
    sendJson(res, 200, { owners });
  });

  // Реестр всех выплат владельцам для административного кабинета.
  router.get('/api/owner-payouts', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const limit = Math.max(1, Math.min(500, parseInt(ctx.query.limit, 10) || 100));
    sendJson(res, 200, { payouts: listAllOwnerPayouts(limit) });
  });

  // Администратор подтверждает фактическую выплату владельцу. Запись выплаты
  // и привязка всех вошедших в неё заказов выполняются одной транзакцией.
  router.post('/api/salon-owners/:id/payouts', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      const payout = createOwnerPayout(Number(ctx.params.id), payload);
      sendJson(res, 201, { ok: true, payout });
    } catch (error) {
      if (error.code === 'OWNER_NOT_FOUND') return sendJson(res, 404, { error: error.message });
      if (error.code === 'NOTHING_TO_PAY') return sendJson(res, 409, { error: error.message });
      console.error('[owner-payout] Не удалось зафиксировать выплату:', error);
      sendJson(res, 500, { error: 'Не удалось зафиксировать выплату владельцу' });
    }
  });

  // PUT /api/salon-owners/:id — активировать/деактивировать, поменять
  // данные или переназначить точку
  router.put('/api/salon-owners/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM salon_owners WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Владелец не найден' });
    const { active, full_name, phone, point_id } = ctx.body || {};
    if (point_id) {
      const point = db.prepare('SELECT id FROM points WHERE id = ?').get(point_id);
      if (!point) return sendJson(res, 400, { error: 'Точка с таким id не найдена' });
    }
    db.prepare('UPDATE salon_owners SET active=?, full_name=?, phone=?, point_id=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      full_name ?? existing.full_name,
      phone ?? existing.phone,
      point_id !== undefined ? (point_id || null) : existing.point_id,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/salon-owners/:id/reset-password — админ сбрасывает пароль
  router.post('/api/salon-owners/:id/reset-password', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT id FROM salon_owners WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Владелец не найден' });
    const newPassword = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE salon_owners SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), ctx.params.id);
    sendJson(res, 200, { ok: true, new_password: newPassword });
  });

  // GET /api/owner/me — собственный кабинет
  router.get('/api/owner/me', (req, res, ctx) => {
    const payload = requireAuth(['owner'])(req, res, ctx);
    if (!payload) return;
    const owner = db.prepare('SELECT * FROM salon_owners WHERE id = ?').get(payload.id);
    if (!owner) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { owner: safeOwner(owner) });
  });

  // GET /api/owner/dashboard — вся статистика по точке владельца: общая
  // выручка, разбивка по каждому грумеру, разбивка по менеджеру.
  router.get('/api/owner/dashboard', (req, res, ctx) => {
    const payload = requireAuth(['owner'])(req, res, ctx);
    if (!payload) return;
    const owner = db.prepare('SELECT * FROM salon_owners WHERE id = ?').get(payload.id);
    if (!owner) return sendJson(res, 404, { error: 'Не найдено' });
    if (!owner.point_id) return sendJson(res, 200, { noPoint: true, message: 'Вам ещё не назначена точка — обратитесь к администратору «Тайги».' });

    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(owner.point_id);
    if (!point) return sendJson(res, 200, { noPoint: true, message: 'Назначенная вам точка не найдена — обратитесь к администратору.' });

    const orders = db.prepare(`
      SELECT id, total, partner_id, commission_rate, payment_method, created_at
      FROM orders WHERE point_id = ? AND status = 'paid'
      ORDER BY created_at DESC
    `).all(owner.point_id);

    const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
    const totalOrders = orders.length;

    // Текущий календарный месяц (UTC, как и хранятся даты в SQLite datetime('now'))
    const now = new Date();
    const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 19).replace('T', ' ');
    const thisMonthOrders = orders.filter((o) => o.created_at >= monthStartIso);
    const thisMonthRevenue = thisMonthOrders.reduce((s, o) => s + o.total, 0);

    // Разбивка по грумерам этой точки — включая неактивных (могли работать
    // раньше и оставить след в статистике), но помечаем активность отдельно.
    const partners = db.prepare('SELECT id, full_name, commission_rate, active FROM partners WHERE point_id = ?').all(owner.point_id);
    const groomers = partners.map((p) => {
      const pOrders = orders.filter((o) => o.partner_id === p.id);
      const revenue = pOrders.reduce((s, o) => s + o.total, 0);
      const commissionEarned = pOrders.reduce((s, o) => s + o.total * (o.commission_rate ?? p.commission_rate), 0);
      return {
        id: p.id,
        full_name: p.full_name,
        active: !!p.active,
        tier_percent: Math.round(p.commission_rate * 100),
        orders_count: pOrders.length,
        revenue,
        commission_earned: Math.round(commissionEarned),
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const unassignedOrdersCount = orders.filter((o) => !o.partner_id).length;

    // Заработок самого владельца — фиксированные 5% с выручки точки,
    // отдельная выплата поверх комиссий грумера и менеджера (не за их счёт).
    const ownerUnpaid = getOwnerUnpaidSummary(owner.id);
    const ownerEarnings = {
      tier_percent: Math.round(owner.commission_rate * 100),
      total: Math.round(totalRevenue * owner.commission_rate),
      this_month: Math.round(thisMonthRevenue * owner.commission_rate),
      unpaid: ownerUnpaid.amount,
      unpaid_orders_count: ownerUnpaid.orders_count,
    };

    // Менеджер, курирующий эту точку (если назначен)
    const mgrPoint = db.prepare(`
      SELECT mp.commission_rate, m.full_name, m.phone
      FROM manager_points mp JOIN managers m ON m.id = mp.manager_id
      WHERE mp.point_id = ?
    `).get(owner.point_id);
    const manager = mgrPoint ? {
      full_name: mgrPoint.full_name,
      phone: mgrPoint.phone,
      tier_percent: Math.round(mgrPoint.commission_rate * 100),
      commission_earned: Math.round(orders.reduce((s, o) => s + o.total * mgrPoint.commission_rate, 0)),
    } : null;

    // Последние 20 заказов точки — для быстрого просмотра без захода в админку
    const recentOrders = orders.slice(0, 20).map((o) => ({
      id: o.id, total: o.total, payment_method: o.payment_method, created_at: o.created_at,
      is_self_order: o.commission_rate === 0,
    }));

    // Реферальные бонусы — сколько владелец заработал, приведя новых грумеров
    // по своему промокоду (аналогично реферальной программе у грумеров).
    const referralRows = db.prepare(`
      SELECT mp.point_name, mp.referred_owner_amount, mp.bonus_paid
      FROM manager_points mp
      WHERE mp.referred_owner_id = ? AND mp.bonus_paid = 1
    `).all(owner.id);
    const referralTotal = referralRows.reduce((s, r) => s + (r.referred_owner_amount || 0), 0);

    sendJson(res, 200, {
      point: { id: point.id, name: point.name, addr: point.addr, city_id: point.city_id },
      owner_code: owner.owner_code,
      totals: {
        revenue: totalRevenue,
        orders: totalOrders,
        avg_order: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
        this_month_revenue: thisMonthRevenue,
        this_month_orders: thisMonthOrders.length,
      },
      owner_earnings: ownerEarnings,
      payouts: listOwnerPayouts(owner.id, 100),
      groomers,
      unassigned_orders_count: unassignedOrdersCount,
      manager,
      recent_orders: recentOrders,
      referral_bonuses: { rows: referralRows, total: referralTotal },
    });
  });

  // DELETE /api/salon-owners/:id — админ удаляет владельца безвозвратно.
  // Если он уже приводил партнёров по своему промокоду и им УЖЕ выплачен
  // реферальный бонус — удаление запрещено (та же логика, что и у менеджера),
  // иначе просто отвязываем ссылку на владельца у таких партнёров и удаляем.
  router.delete('/api/salon-owners/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const id = ctx.params.id;
    const existing = db.prepare('SELECT id FROM salon_owners WHERE id = ?').get(id);
    if (!existing) return sendJson(res, 404, { error: 'Владелец не найден' });

    const paidReferrals = db.prepare('SELECT COUNT(*) AS c FROM manager_points WHERE referred_owner_id = ? AND bonus_paid = 1').get(id).c;
    if (paidReferrals > 0) {
      return sendJson(res, 400, {
        error: 'Владельцу уже выплачено ' + paidReferrals + ' реферальных бонус(ов) — удаление скроет эту историю. Деактивируйте вместо удаления.',
      });
    }

    db.prepare('UPDATE partners SET referred_by_owner_id = NULL WHERE referred_by_owner_id = ?').run(id);
    db.prepare('DELETE FROM salon_owners WHERE id = ?').run(id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerOwnerRoutes };
