// routes-economics.js — экономика проекта в реальном времени. Затраты на
// закуп товара админ вносит вручную (реальные суммы по факту закупки —
// точнее, чем оценка от cost_price за штуку, не учитывающая оптовые скидки,
// доставку, порчу и т.п.). Остальные статьи расходов (комиссии партнёру,
// менеджеру, владельцу точки, налог УСН, эквайринг) считаются автоматически
// из уже накопленных в системе данных — ставки у каждой роли уже хранятся
// в базе (orders.commission_rate — ставка партнёра, зафиксированная на
// момент заказа; manager_points.commission_rate; salon_owners.commission_rate).
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

// Те же допущения, что и в Excel-модели unit-экономики (taiga_unit_economics):
// налог УСН 6% с выручки, эквайринг ЮKassa ~2%.
const TAX_RATE = 0.06;
const ACQUIRING_FEE_RATE = 0.02;

function parseDateParam(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function registerEconomicsRoutes(router) {
  // GET /api/economics/dashboard?from=&to=&city= — агрегированная экономика за период.
  // from/to — ISO-даты (включительно). city — необязательный фильтр по городу
  // (заказы фильтруются через точку, у orders нет своего city_id напрямую).
  // Без параметров — весь период и все города сразу.
  router.get('/api/economics/dashboard', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    const from = parseDateParam(ctx.query.from, '2000-01-01T00:00:00.000Z');
    const to = parseDateParam(ctx.query.to, '2100-01-01T00:00:00.000Z');
    const cityFilter = ctx.query.city || null;

    const orders = cityFilter
      ? db.prepare(`
          SELECT o.id, o.total, o.commission_rate, o.point_id, o.created_at
          FROM orders o
          JOIN points p ON p.id = o.point_id
          WHERE o.status = 'paid' AND o.created_at BETWEEN ? AND ? AND p.city_id = ?
        `).all(from, to, cityFilter)
      : db.prepare(`
          SELECT id, total, commission_rate, point_id, created_at
          FROM orders
          WHERE status = 'paid' AND created_at BETWEEN ? AND ?
        `).all(from, to);

    const revenue = orders.reduce((s, o) => s + o.total, 0);
    const ordersCount = orders.length;

    // Комиссия партнёра — ставка ЗАФИКСИРОВАНА на момент заказа (см.
    // комментарий к orders.commission_rate), поэтому берём её из самого
    // заказа, а не текущую ставку партнёра — это честно отражает, сколько
    // реально было выплачено, даже если тариф партнёра с тех пор изменился.
    const partnerCommission = Math.round(
      orders.reduce((s, o) => s + o.total * (o.commission_rate || 0), 0)
    );

    // Комиссия менеджера — по каждой точке своя ставка (обычно 7%, но не
    // всегда — см. manager_points.commission_rate), точки без назначенного
    // менеджера ничего не добавляют.
    const managerRateByPoint = new Map(
      db.prepare('SELECT point_id, commission_rate FROM manager_points WHERE point_id IS NOT NULL').all()
        .map((r) => [r.point_id, r.commission_rate])
    );
    const managerCommission = Math.round(
      orders.reduce((s, o) => {
        const rate = o.point_id ? managerRateByPoint.get(o.point_id) : null;
        return s + (rate ? o.total * rate : 0);
      }, 0)
    );

    // Комиссия владельца точки — фиксированные 5% (но берём реальную ставку
    // из базы, а не хардкодим — вдруг в будущем станет настраиваемой),
    // только для точек, где вообще зарегистрирован владелец.
    const ownerRateByPoint = new Map(
      db.prepare('SELECT point_id, commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active = 1').all()
        .map((r) => [r.point_id, r.commission_rate])
    );
    const ownerCommission = Math.round(
      orders.reduce((s, o) => {
        const rate = o.point_id ? ownerRateByPoint.get(o.point_id) : null;
        return s + (rate ? o.total * rate : 0);
      }, 0)
    );

    const tax = Math.round(revenue * TAX_RATE);
    const acquiringFee = Math.round(revenue * ACQUIRING_FEE_RATE);

    // Расходы — единственная статья, которую вносит человек, а не считает
    // система: закуп товара, непредвиденные расходы и т.п. Берём по дате
    // самого расхода (expense_date), а не дате внесения записи в систему.
    // Группируем по категории, чтобы в P&L каждая шла отдельной строкой —
    // не сваливаем всё в одну общую сумму «затраты». Если указан город —
    // считаем расходы только по нему, иначе по всей сети сразу.
    const expensesByCategory = cityFilter
      ? db.prepare(`
          SELECT category, SUM(amount) AS total
          FROM expenses
          WHERE expense_date BETWEEN ? AND ? AND city_id = ?
          GROUP BY category
          ORDER BY total DESC
        `).all(from.slice(0, 10), to.slice(0, 10), cityFilter)
      : db.prepare(`
          SELECT category, SUM(amount) AS total
          FROM expenses
          WHERE expense_date BETWEEN ? AND ?
          GROUP BY category
          ORDER BY total DESC
        `).all(from.slice(0, 10), to.slice(0, 10));
    const cogs = expensesByCategory.reduce((s, r) => s + r.total, 0);

    const totalCosts = partnerCommission + managerCommission + ownerCommission + tax + acquiringFee + cogs;
    const netProfit = revenue - totalCosts;
    const marginPercent = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0;

    sendJson(res, 200, {
      period: { from, to },
      revenue,
      orders_count: ordersCount,
      costs: {
        cogs,
        expenses_by_category: expensesByCategory,
        partner_commission: partnerCommission,
        manager_commission: managerCommission,
        owner_commission: ownerCommission,
        tax,
        acquiring_fee: acquiringFee,
        total: totalCosts,
      },
      net_profit: netProfit,
      margin_percent: marginPercent,
      rates_used: { tax_rate: TAX_RATE, acquiring_fee_rate: ACQUIRING_FEE_RATE },
    });
  });

  // GET /api/economics/expenses?from=&to=&city= — список расходов за период (для таблицы в админке)
  router.get('/api/economics/expenses', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const from = ctx.query.from || '2000-01-01';
    const to = ctx.query.to || '2100-01-01';
    const cityFilter = ctx.query.city || null;
    const rows = cityFilter
      ? db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? AND city_id = ? ORDER BY expense_date DESC, id DESC').all(from, to, cityFilter)
      : db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC').all(from, to);
    sendJson(res, 200, { expenses: rows });
  });

  // POST /api/economics/expenses — добавить расход (город обязателен — расход
  // всегда относится к конкретному складу/точке, даже если это общий закуп)
  router.post('/api/economics/expenses', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { expense_date, category, amount, note, city_id } = ctx.body || {};
    const amountNum = Math.round(Number(amount));
    if (!expense_date || !Number.isFinite(amountNum) || amountNum <= 0) {
      return sendJson(res, 400, { error: 'Укажите дату и сумму расхода (больше нуля)' });
    }
    const cityId = city_id || 'krsk';
    if (!db.prepare('SELECT id FROM cities WHERE id = ?').get(cityId)) {
      return sendJson(res, 400, { error: 'Неизвестный город: ' + cityId });
    }
    const info = db.prepare(`
      INSERT INTO expenses (expense_date, category, amount, note, created_by, city_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(expense_date, (category || 'Закуп товара').trim(), amountNum, (note || '').trim() || null, payload.login || null, cityId);
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // DELETE /api/economics/expenses/:id — удалить ошибочную запись
  router.delete('/api/economics/expenses/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    db.prepare('DELETE FROM expenses WHERE id = ?').run(ctx.params.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerEconomicsRoutes };
