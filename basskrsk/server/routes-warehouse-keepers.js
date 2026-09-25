// routes-warehouse-keepers.js — создание и управление аккаунтами кладовщиков.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');

function safeKeeper(k) {
  const { password_hash, ...rest } = k;
  return rest;
}

function registerWarehouseKeeperRoutes(router) {
  // POST /api/warehouse-keepers — админ создаёт аккаунт кладовщика
  router.post('/api/warehouse-keepers', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const { full_name, phone, login, password, city_id } = ctx.body || {};
    if (!full_name || !phone || !login || !password) {
      return sendJson(res, 400, { error: 'Заполните ФИО, телефон, логин и пароль' });
    }
    const existingLogin = db.prepare('SELECT id FROM warehouse_keepers WHERE login = ?').get(login);
    if (existingLogin) return sendJson(res, 409, { error: 'Такой логин уже занят' });
    const cityId = city_id || 'krsk';
    if (!db.prepare('SELECT id FROM cities WHERE id = ?').get(cityId)) {
      return sendJson(res, 400, { error: 'Неизвестный город: ' + cityId });
    }

    const info = db.prepare(`
      INSERT INTO warehouse_keepers (login, password_hash, full_name, phone, city_id, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(login, hashPassword(password), full_name, phone, cityId);
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // GET /api/warehouse-keepers — список для админки, можно отфильтровать по городу (?city=krsk)
  router.get('/api/warehouse-keepers', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const cityFilter = ctx.query.city || null;
    const rows = cityFilter
      ? db.prepare('SELECT * FROM warehouse_keepers WHERE city_id = ? ORDER BY id DESC').all(cityFilter)
      : db.prepare('SELECT * FROM warehouse_keepers ORDER BY id DESC').all();
    sendJson(res, 200, { keepers: rows.map(safeKeeper) });
  });

  // PUT /api/warehouse-keepers/:id — активировать/деактивировать, поменять данные
  router.put('/api/warehouse-keepers/:id', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM warehouse_keepers WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Кладовщик не найден' });
    const { active, full_name, phone } = ctx.body || {};
    db.prepare('UPDATE warehouse_keepers SET active=?, full_name=?, phone=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      full_name ?? existing.full_name,
      phone ?? existing.phone,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/warehouse-keepers/:id/reset-password — админ сбрасывает пароль кладовщику
  router.post('/api/warehouse-keepers/:id/reset-password', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT id FROM warehouse_keepers WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Кладовщик не найден' });
    const newPassword = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE warehouse_keepers SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), ctx.params.id);
    sendJson(res, 200, { ok: true, new_password: newPassword });
  });

  // GET /api/warehouse-keepers/me — собственный кабинет
  router.get('/api/warehouse-keepers/me', (req, res, ctx) => {
    const payload = requireAuth(['warehouse'])(req, res, ctx);
    if (!payload) return;
    const keeper = db.prepare('SELECT * FROM warehouse_keepers WHERE id = ?').get(payload.id);
    if (!keeper) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { keeper: safeKeeper(keeper) });
  });
}

module.exports = { registerWarehouseKeeperRoutes };
