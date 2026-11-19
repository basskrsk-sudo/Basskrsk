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
const { listExpenseDocuments, cleanupAfterDeletedExpense } = require('./expense-documents');
const { requireAuth, requireSuperAdmin } = require('./routes-auth');
const { localDate } = require('./task-reminders');
const { trackSync } = require('./runtime-diagnostics');
const { buildEconomicsDashboard } = require('./economics-dashboard');
const {
  calculateUnitEconomics,
  getUnitEconomicsSettings,
  saveUnitEconomicsSettings,
} = require('./unit-economics');

function normalizeExpenseDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function registerEconomicsRoutes(router) {
  // Плановая юнит-экономика не влияет на реальные начисления. Доступ к
  // допущениям и результатам есть только у супер-администратора.
  router.get('/api/economics/unit-model', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    const settings = getUnitEconomicsSettings();
    sendJson(res, 200, {
      ...settings,
      results: calculateUnitEconomics(settings.assumptions),
    });
  });

  router.put('/api/economics/unit-model', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    try {
      const saved = saveUnitEconomicsSettings(ctx.body && ctx.body.assumptions, payload);
      sendJson(res, 200, {
        ok: true,
        ...saved,
        results: calculateUnitEconomics(saved.assumptions),
      });
    } catch (error) {
      if (error.code === 'INVALID_ASSUMPTION') return sendJson(res, 400, { error: error.message });
      throw error;
    }
  });

  // GET /api/economics/dashboard?from=&to=&city= — агрегированная экономика за период.
  // from/to — ISO-даты (включительно). city — необязательный фильтр по городу
  // (заказы фильтруются через точку, у orders нет своего city_id напрямую).
  // Без параметров — весь период и все города сразу.
  router.get('/api/economics/dashboard', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    sendJson(res, 200, trackSync('economics_dashboard_build', () =>
      buildEconomicsDashboard(db, ctx.query || {})));
  });

  // GET /api/economics/expenses?from=&to=&city= — список расходов за период (для таблицы в админке)
  router.get('/api/economics/expenses', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const from = ctx.query.from || '2000-01-01';
    const to = ctx.query.to || '2100-01-01';
    const cityFilter = ctx.query.city || null;
    const investorFilter = String(ctx.query.investor || '').trim();
    const clauses = ['expense_date BETWEEN ? AND ?'];
    const params = [from, to];
    if (cityFilter) {
      clauses.push('city_id = ?');
      params.push(cityFilter);
    }
    if (investorFilter) {
      clauses.push('investor_name LIKE ?');
      params.push('%' + investorFilter + '%');
    }
    const rows = db.prepare(`
      SELECT e.*, c.name AS city_name
      FROM expenses e
      LEFT JOIN cities c ON c.id = e.city_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY expense_date DESC, e.id DESC
    `).all(...params);
    const investorTotals = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(investor_name), ''), 'Не указан') AS investor_name,
             SUM(amount) AS total, COUNT(*) AS entries_count
      FROM expenses
      WHERE ${clauses.join(' AND ')}
      GROUP BY COALESCE(NULLIF(TRIM(investor_name), ''), 'Не указан')
      ORDER BY total DESC, investor_name
    `).all(...params);
    const documents=listExpenseDocuments(rows.map(row=>row.id));
    sendJson(res, 200, {
      expenses: rows.map(row=>({ ...row,documents:documents[row.id]||[] })),
      summary: {
        total: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        entries_count: rows.length,
        investors_count: investorTotals.filter((row) => row.investor_name !== 'Не указан').length,
        by_investor: investorTotals,
      },
    });
  });

  // POST /api/economics/expenses — добавить расход (город обязателен — расход
  // всегда относится к конкретному складу/точке, даже если это общий закуп)
  router.post('/api/economics/expenses', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { expense_date, category, amount, note, city_id, investor_name } = ctx.body || {};
    const amountNum = Math.round(Number(amount));
    const expenseDate = normalizeExpenseDate(expense_date);
    if (!expenseDate || !Number.isFinite(amountNum) || amountNum <= 0) {
      return sendJson(res, 400, { error: 'Укажите дату и сумму расхода (больше нуля)' });
    }
    const cityId = city_id || 'krsk';
    if (!db.prepare('SELECT id FROM cities WHERE id = ?').get(cityId)) {
      return sendJson(res, 400, { error: 'Неизвестный город: ' + cityId });
    }
    const allowedInvestors = new Set(['Лакомых Алексей', 'Соколов Виталий', 'Кучкин Николай']);
    const investorName = String(investor_name || '').trim().slice(0, 200);
    if (!allowedInvestors.has(investorName)) {
      return sendJson(res, 400, { error: 'Выберите инвестора: Алексей, Виталий или Николай' });
    }
    const purpose = String(category || '').trim().slice(0, 500);
    if (!purpose) return sendJson(res, 400, { error: 'Укажите назначение траты' });
    const info = db.prepare(`
      INSERT INTO expenses
        (expense_date, category, amount, investor_name, note, created_by, source, city_id)
      VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)
    `).run(expenseDate, purpose, amountNum, investorName, String(note || '').trim().slice(0, 1000) || null, payload.login || null, cityId);
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // PUT /api/economics/expenses/:id/date — change ONLY the accounting
  // date of an existing expense. Super-admin authorization and a persisted
  // old->new audit event are mandatory. Never alter amount, owner or evidence.
  router.put('/api/economics/expenses/:id/date', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    // A previously issued token must not authorize a revoked/demoted admin.
    const admin = db.prepare(
      "SELECT id,login FROM admins WHERE id=? AND active=1 AND role='super'"
    ).get(payload.id);
    if (!admin) return sendJson(res, 403, {error:'Доступ супер-администратора отозван'});

    const expenseId=Number(ctx.params.id);
    const newDate=normalizeExpenseDate(ctx.body?.expense_date);
    const expectedDate=normalizeExpenseDate(ctx.body?.expected_date);
    const reason=String(ctx.body?.reason||'').trim();
    if(!Number.isSafeInteger(expenseId)||expenseId<1)
      return sendJson(res,400,{error:'Некорректный идентификатор траты'});
    if(!newDate||newDate>localDate())
      return sendJson(res,400,{error:'Укажите существующую дату не позднее сегодняшней'});
    if(!expectedDate)
      return sendJson(res,400,{error:'Нужно указать исходную дату для проверки изменений'});
    if(reason.length<5||reason.length>500)
      return sendJson(res,400,{error:'Укажите причину исправления даты (от 5 до 500 символов)'});

    db.exec('BEGIN IMMEDIATE');
    try {
      const expense=db.prepare(
        'SELECT id,expense_date FROM expenses WHERE id=?'
      ).get(expenseId);
      if(!expense){
        db.exec('ROLLBACK');
        return sendJson(res,404,{error:'Трата не найдена'});
      }
      if(expense.expense_date!==expectedDate){
        db.exec('ROLLBACK');
        return sendJson(res,409,{error:'Дата уже изменена другим пользователем. Обновите журнал трат',
          actual_date:expense.expense_date});
      }
      if(newDate===expense.expense_date){
        db.exec('ROLLBACK');
        return sendJson(res,400,{error:'Новая дата совпадает с текущей'});
      }
      db.prepare('UPDATE expenses SET expense_date=? WHERE id=?').run(newDate,expenseId);
      db.prepare(
        'INSERT INTO expense_date_change_log '+
        '(expense_id,old_date,new_date,reason,admin_id,admin_login) VALUES(?,?,?,?,?,?)'
      ).run(expenseId,expense.expense_date,newDate,reason,admin.id,admin.login);
      db.exec('COMMIT');
      return sendJson(res,200,{ok:true,id:expenseId,old_date:expense.expense_date,new_date:newDate});
    } catch(error){
      try{db.exec('ROLLBACK');}catch(_){}
      throw error;
    }
  });

  // DELETE /api/economics/expenses/:id — удалить ошибочную запись
  router.delete('/api/economics/expenses/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const documents=db.prepare('SELECT storage_name FROM expense_documents WHERE expense_id=?').all(ctx.params.id);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(ctx.params.id);
    cleanupAfterDeletedExpense(documents.map(doc=>doc.storage_name));
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerEconomicsRoutes };
