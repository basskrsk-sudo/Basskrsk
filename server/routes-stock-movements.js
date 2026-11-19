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
const { logManagerAction } = require('./audit-log');
const { hydrateStockMovements } = require('./stock-movement-batch');
const { trackSync } = require('./runtime-diagnostics');
const { approveStockMovement } = require('./stock-inventory-transactions');

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

    const totalQty = cleanItems.reduce((sum, item) => sum + Math.round(Number(item.qty)), 0);
    logManagerAction(payload.id, 'Отчёт о перемещении товара', {
      type: 'stock_movement', id: movementId, name: point.name,
      details: cleanItems.length + ' поз. · ' + totalQty + ' шт.' + (comment ? ' · ' + String(comment).trim() : ''),
    }, manager);

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

    // Batch related rows without changing the existing response or access rules.
    const movements = trackSync('stock_movements_hydrate',
      () => hydrateStockMovements(db, rows));
    sendJson(res, 200, { movements });
  });

  // PUT /api/stock-movements/:id/approve — администратор подтверждает: ровно
  // в этот момент, одной операцией, товар списывается со склада города и
  // зачисляется на точку. Если на складе не хватает — согласовать нельзя,
  // приходится либо скорректировать отчёт, либо сначала оприходовать нужное
  // количество.
  router.put('/api/stock-movements/:id/approve', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    // Keep the compatibility registration in sync with the primary
    // warehouse router. No duplicate approval algorithm remains.
    const result = trackSync('stock_movement_approval',
      () => approveStockMovement(db,ctx.params.id,payload.login));
    if (!result.ok) {
      if (result.code === 'STOCK_UNAVAILABLE') {
        const item = db.prepare(
          'SELECT p.name,v.weight FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?'
        ).get(result.variantId);
        return sendJson(res,400,{
          error:'Не хватает на складе города: '+
            (item ? item.name+' ('+item.weight+')':'товар #'+result.variantId)+
            ' — на складе '+result.available+', в отчёте '+result.required+
            '. Пополните склад или скорректируйте отчёт.',
        });
      }
      return sendJson(res,result.status,{error:result.message});
    }
    sendJson(res,200,{ok:true});
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
