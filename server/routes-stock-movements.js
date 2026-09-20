// routes-stock-movements.js — перемещение товара с центрального городского
// склада на точку без участия кладовщика (роль убрана). Менеджер физически
// привозит товар на точку САМ, а уже ПОСЛЕ этого отчитывается в системе —
// сколько и какого товара разместил. Пока администратор не подтвердит
// отчёт, остатки нигде не меняются — ни на складе, ни на точке. Только в
// момент подтверждения товар одной операцией списывается со склада города
// и зачисляется на точку.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { sendTelegram } = require('./telegram');

function registerStockMovementRoutes(router) {
  // POST /api/stock-movements — менеджер отчитывается о том, что уже физически
  // разместил на точке (склад и точка ещё не тронуты — ждём подтверждения).
  router.post('/api/stock-movements', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;

    const { point_id, items, comment } = ctx.body || {};
    if (!point_id || !Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: 'Укажите точку и хотя бы один товар с количеством больше нуля' });
    }
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(point_id);
    if (!point) return sendJson(res, 400, { error: 'Точка не найдена' });

    const manager = db.prepare('SELECT * FROM managers WHERE id = ?').get(payload.id);
    const cleanItems = items.filter((i) => i && i.variant_id && Number(i.qty) > 0);
    if (!cleanItems.length) return sendJson(res, 400, { error: 'Укажите количество больше нуля хотя бы для одного товара' });

    const info = db.prepare('INSERT INTO stock_movements (manager_id, point_id, city_id, comment) VALUES (?, ?, ?, ?)')
      .run(payload.id, point_id, manager.city_id, (comment || '').trim() || null);
    const movementId = info.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO stock_movement_items (movement_id, variant_id, qty) VALUES (?, ?, ?)');
    for (const item of cleanItems) insItem.run(movementId, item.variant_id, Math.round(Number(item.qty)));

    const itemsText = cleanItems.map((i) => {
      const v = db.prepare(`
        SELECT p.name, v.weight FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
      `).get(i.variant_id);
      return '• ' + (v ? v.name + ' (' + v.weight + ')' : 'товар #' + i.variant_id) + ' — ' + i.qty + ' шт.';
    }).join('\n');
    sendTelegram(
      '📦 <b>Отчёт о размещении товара — на согласовании</b>\n\n' +
      '👤 Менеджер: ' + manager.full_name + '\n' +
      '📍 Точка: ' + point.name + ' (' + point.addr + ')\n\n' +
      itemsText +
      (comment ? '\n\n💬 ' + comment : '') +
      '\n\n→ Проверьте и согласуйте в панели администратора, раздел «Перемещения товара».'
    ).catch(() => {});

    sendJson(res, 201, { ok: true, movement_id: movementId });
  });

  // GET /api/stock-movements — менеджер видит только свои отчёты; админ —
  // все (можно отфильтровать по городу и/или статусу).
  router.get('/api/stock-movements', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;

    let rows;
    if (payload.role === 'manager') {
      rows = db.prepare('SELECT * FROM stock_movements WHERE manager_id = ? ORDER BY id DESC').all(payload.id);
    } else {
      const cityFilter = ctx.query.city || null;
      const statusFilter = ctx.query.status || null;
      let sql = 'SELECT * FROM stock_movements WHERE 1=1';
      const params = [];
      if (cityFilter) { sql += ' AND city_id = ?'; params.push(cityFilter); }
      if (statusFilter) { sql += ' AND status = ?'; params.push(statusFilter); }
      sql += ' ORDER BY id DESC';
      rows = db.prepare(sql).all(...params);
    }

    const getItems = db.prepare(`
      SELECT smi.*, p.name AS product_name, v.weight
      FROM stock_movement_items smi
      JOIN product_variants v ON v.id = smi.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE smi.movement_id = ?
    `);
    const getPoint = db.prepare('SELECT name, addr, icon FROM points WHERE id = ?');
    const getManager = db.prepare('SELECT full_name, phone FROM managers WHERE id = ?');

    sendJson(res, 200, {
      movements: rows.map((m) => ({
        ...m,
        items: getItems.all(m.id),
        point: getPoint.get(m.point_id),
        manager: getManager.get(m.manager_id),
      })),
    });
  });

  // PUT /api/stock-movements/:id/approve — администратор подтверждает: ровно
  // в этот момент, одной операцией, товар списывается со склада города и
  // зачисляется на точку. Если на складе не хватает — согласовать нельзя,
  // приходится либо скорректировать отчёт, либо сначала оприходовать нужное
  // количество.
  router.put('/api/stock-movements/:id/approve', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(ctx.params.id);
    if (!movement) return sendJson(res, 404, { error: 'Отчёт не найден' });
    if (movement.status !== 'pending') return sendJson(res, 400, { error: 'Отчёт уже обработан' });

    const items = db.prepare('SELECT * FROM stock_movement_items WHERE movement_id = ?').all(movement.id);

    // Сначала проверяем ВСЕ позиции — согласование должно быть всё-или-ничего,
    // не хотим наполовину списать склад, если на середине списка не хватит остатка.
    for (const item of items) {
      const whRow = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(movement.city_id, item.variant_id);
      const available = whRow ? whRow.qty : 0;
      if (available < item.qty) {
        const v = db.prepare(`
          SELECT p.name, v.weight FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
        `).get(item.variant_id);
        return sendJson(res, 400, {
          error: 'Не хватает на складе города: ' + (v ? v.name + ' (' + v.weight + ')' : 'товар #' + item.variant_id) +
            ' — на складе ' + available + ', в отчёте ' + item.qty + '. Пополните склад или скорректируйте отчёт.',
        });
      }
    }

    for (const item of items) {
      const whRow = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(movement.city_id, item.variant_id);
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)')
        .run(movement.city_id, item.variant_id, whRow.qty - item.qty);

      const stockRow = db.prepare('SELECT qty FROM stock WHERE variant_id = ? AND point_id = ?').get(item.variant_id, movement.point_id);
      const newQty = (stockRow ? stockRow.qty : 0) + item.qty;
      db.prepare('INSERT OR REPLACE INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)').run(item.variant_id, movement.point_id, newQty);
    }

    db.prepare("UPDATE stock_movements SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
      .run(payload.login || null, movement.id);
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/stock-movements/:id/reject — администратор отклоняет отчёт
  // (например, менеджер ошибся в количестве) — остатки нигде не меняются.
  router.put('/api/stock-movements/:id/reject', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(ctx.params.id);
    if (!movement) return sendJson(res, 404, { error: 'Отчёт не найден' });
    if (movement.status !== 'pending') return sendJson(res, 400, { error: 'Отчёт уже обработан' });

    const { reason } = ctx.body || {};
    db.prepare("UPDATE stock_movements SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?, reject_reason = ? WHERE id = ?")
      .run(payload.login || null, (reason || '').trim() || null, movement.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerStockMovementRoutes };
