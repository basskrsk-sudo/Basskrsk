// routes-warehouse.js — центральный склад, приход от поставщика (кладовщик)
// и еженедельные заявки менеджеров/грумеров на пополнение точек
// (транзитная модель: забрал утром — развёз в тот же день).
//
// С появлением нескольких городов склад больше не один общий на всю
// систему — у каждого города свой отдельный остаток (см. миграцию
// warehouse_stock в db.js). Кладовщик и менеджер жёстко привязаны к
// своему городу (city_id) и всегда действуют только в его рамках;
// администратор городом не привязан и обязан явно его указать.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireAuth } = require('./routes-auth');
const { logManagerAction } = require('./audit-log');

function slugify(str) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(str).toLowerCase().split('').map((ch) => (map[ch] !== undefined ? map[ch] : ch)).join('')
    .replace(/[«»"']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'point';
}

// Определяет, в рамках какого города действует запрос. Кладовщик и
// менеджер жёстко привязаны к своему городу — используем его всегда,
// даже если в запросе явно передали другой (нельзя подделать город через
// параметр). Админ городом не привязан — обязан передать его явно.
function resolveCityId(payload, explicitCityId) {
  if (payload.role === 'warehouse') {
    const row = db.prepare('SELECT city_id FROM warehouse_keepers WHERE id = ?').get(payload.id);
    return row ? row.city_id : null;
  }
  if (payload.role === 'manager') {
    // Менеджер обычно ведёт точки в своём городе, но это не гарантировано
    // (админ ничем не ограничивает назначение менеджера на точку в другом
    // городе). Если явно передан город — используем его, но только если
    // среди точек этого менеджера реально есть хоть одна в этом городе,
    // иначе менеджер мог бы подсмотреть чужой склад, просто подставив
    // ?city= в запрос.
    if (explicitCityId) {
      const ownsPointInCity = db.prepare('SELECT 1 FROM points WHERE manager_id = ? AND city_id = ?').get(payload.id, explicitCityId);
      if (ownsPointInCity) return explicitCityId;
    }
    const row = db.prepare('SELECT city_id FROM managers WHERE id = ?').get(payload.id);
    return row ? row.city_id : null;
  }
  return explicitCityId || null; // admin
}

function registerWarehouseRoutes(router) {
  // GET /api/warehouse/stock — видно админу, кладовщику и менеджеру.
  // Кладовщик/менеджер всегда видят только склад своего города; админ
  // обязан передать ?city=krsk явно.
  router.get('/api/warehouse/stock', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse', 'manager'])(req, res, ctx);
    if (!payload) return;
    const cityId = resolveCityId(payload, ctx.query.city);
    if (!cityId) return sendJson(res, 400, { error: 'Не удалось определить город — укажите ?city=' });

    const rows = db.prepare(`
      SELECT ws.variant_id, ws.qty, v.weight, v.price, p.name AS product_name, p.slug
      FROM warehouse_stock ws
      JOIN product_variants v ON v.id = ws.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE ws.city_id = ?
      ORDER BY p.name, v.sort_order
    `).all(cityId);
    sendJson(res, 200, { stock: rows, city_id: cityId });
  });

  // PUT /api/warehouse/stock — прямая корректировка остатка (инвентаризация/исправление ошибки).
  // Обычный приход товара должен идти через /api/warehouse/receipts — там сохраняется история.
  router.put('/api/warehouse/stock', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const { variant_id, qty, city_id } = ctx.body || {};
    if (!variant_id || typeof qty !== 'number' || qty < 0) {
      return sendJson(res, 400, { error: 'Укажите variant_id и неотрицательное qty' });
    }
    const cityId = resolveCityId(payload, city_id);
    if (!cityId) return sendJson(res, 400, { error: 'Не удалось определить город — укажите city_id' });

    db.prepare('INSERT OR REPLACE INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)').run(cityId, variant_id, qty);
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/warehouse/stock/:variantId — убрать лишнюю позицию именно
  // со склада выбранного города. Каталожный товар и остатки на точках не
  // затрагиваются. Операция доступна только администраторам и сохраняется
  // в отдельном журнале складских корректировок.
  router.delete('/api/warehouse/stock/:variantId', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    const variantId = Number(ctx.params.variantId);
    const { city_id, reason } = ctx.body || {};
    const cityId = resolveCityId(payload, city_id);
    if (!Number.isInteger(variantId) || variantId <= 0 || !cityId) {
      return sendJson(res, 400, { error: 'Укажите товар и город склада' });
    }

    const row = db.prepare(`
      SELECT ws.qty, p.name AS product_name, v.weight
      FROM warehouse_stock ws
      JOIN product_variants v ON v.id = ws.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE ws.city_id = ? AND ws.variant_id = ?
    `).get(cityId, variantId);
    if (!row) return sendJson(res, 404, { error: 'Этой позиции уже нет на складе выбранного города' });

    const activeReservation = db.prepare(`
      SELECT o.order_code
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.reservation_status = 'active'
        AND o.inventory_source_type = 'warehouse'
        AND o.inventory_source_id = ?
        AND oi.variant_id = ?
      LIMIT 1
    `).get(cityId, variantId);
    if (activeReservation) {
      return sendJson(res, 409, {
        error: 'Позицию нельзя удалить: товар зарезервирован в заказе ' + activeReservation.order_code,
      });
    }

    const pendingMovement = db.prepare(`
      SELECT sm.id
      FROM stock_movements sm
      JOIN stock_movement_items smi ON smi.movement_id = sm.id
      WHERE sm.status = 'pending' AND sm.city_id = ? AND smi.variant_id = ?
      LIMIT 1
    `).get(cityId, variantId);
    if (pendingMovement) {
      return sendJson(res, 409, {
        error: 'Позицию нельзя удалить: товар указан в перемещении №' + pendingMovement.id + ', ожидающем проверки',
      });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO warehouse_stock_adjustments
          (city_id, variant_id, product_name, weight, old_qty, new_qty, action, reason, admin_id, admin_login)
        VALUES (?, ?, ?, ?, ?, NULL, 'delete', ?, ?, ?)
      `).run(
        cityId,
        variantId,
        row.product_name,
        row.weight,
        row.qty,
        String(reason || '').trim() || null,
        payload.id,
        payload.login || null
      );
      const deleted = db.prepare('DELETE FROM warehouse_stock WHERE city_id = ? AND variant_id = ?')
        .run(cityId, variantId);
      if (deleted.changes !== 1) throw new Error('Складской остаток изменился во время удаления');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* сохраняем исходную ошибку */ }
      console.error('Не удалось удалить позицию со склада:', error);
      return sendJson(res, 500, { error: 'Не удалось удалить позицию со склада' });
    }

    sendJson(res, 200, {
      ok: true,
      deleted: { variant_id: variantId, city_id: cityId, qty: row.qty, product_name: row.product_name, weight: row.weight },
    });
  });

  // POST /api/warehouse/receipts — приход товара от поставщика (кладовщик или админ)
  router.post('/api/warehouse/receipts', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const { variant_id, qty, supplier_note, city_id } = ctx.body || {};
    if (!variant_id || typeof qty !== 'number' || qty <= 0) {
      return sendJson(res, 400, { error: 'Укажите variant_id и qty больше нуля' });
    }
    const cityId = resolveCityId(payload, city_id);
    if (!cityId) return sendJson(res, 400, { error: 'Не удалось определить город — укажите city_id' });

    const keeperId = payload.role === 'warehouse' ? payload.id : null;
    db.prepare('INSERT INTO warehouse_receipts (variant_id, qty, supplier_note, keeper_id, city_id) VALUES (?, ?, ?, ?, ?)')
      .run(variant_id, qty, supplier_note || null, keeperId, cityId);
    const row = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(cityId, variant_id);
    const newQty = (row ? row.qty : 0) + qty;
    db.prepare('INSERT OR REPLACE INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)').run(cityId, variant_id, newQty);
    sendJson(res, 201, { ok: true, new_qty: newQty });
  });

  // GET /api/warehouse/receipts — история приходов своего города (админ может указать ?city=)
  router.get('/api/warehouse/receipts', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const cityId = resolveCityId(payload, ctx.query.city);
    if (!cityId) return sendJson(res, 400, { error: 'Не удалось определить город — укажите ?city=' });

    const rows = db.prepare(`
      SELECT wr.*, v.weight, p.name AS product_name, k.full_name AS keeper_name
      FROM warehouse_receipts wr
      JOIN product_variants v ON v.id = wr.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN warehouse_keepers k ON k.id = wr.keeper_id
      WHERE wr.city_id = ?
      ORDER BY wr.id DESC
      LIMIT 200
    `).all(cityId);
    sendJson(res, 200, { receipts: rows });
  });

  // POST /api/restock-requests — менеджер оформляет еженедельную заявку (город — свой, всегда)
  router.post('/api/restock-requests', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const { items } = ctx.body || {}; // [{ variant_id, qty }]
    if (!Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: 'Укажите items — список variant_id и qty' });
    }
    const cityId = resolveCityId(payload, null);
    const info = db.prepare('INSERT INTO restock_requests (manager_id, city_id) VALUES (?, ?)').run(payload.id, cityId);
    const requestId = info.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO restock_request_items (request_id, variant_id, qty_requested) VALUES (?, ?, ?)');
    for (const item of items) insItem.run(requestId, item.variant_id, item.qty);
    sendJson(res, 201, { ok: true, request_id: requestId });
  });

  // GET /api/restock-requests — админ и кладовщик видят заявки своего города
  // (админ может указать ?city=), менеджер — только свои
  router.get('/api/restock-requests', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse', 'manager'])(req, res, ctx);
    if (!payload) return;
    let requests;
    if (payload.role === 'manager') {
      requests = db.prepare('SELECT * FROM restock_requests WHERE manager_id = ? ORDER BY id DESC').all(payload.id);
    } else {
      const cityId = resolveCityId(payload, ctx.query.city);
      if (!cityId) return sendJson(res, 400, { error: 'Не удалось определить город — укажите ?city=' });
      requests = db.prepare('SELECT * FROM restock_requests WHERE city_id = ? ORDER BY id DESC').all(cityId);
    }
    const getItems = db.prepare(`
      SELECT rri.*, v.weight, p.name AS product_name
      FROM restock_request_items rri
      JOIN product_variants v ON v.id = rri.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE rri.request_id = ?
    `);
    const getDeliveries = db.prepare('SELECT * FROM restock_deliveries WHERE request_id = ?');
    sendJson(res, 200, {
      requests: requests.map((r) => ({ ...r, items: getItems.all(r.id), deliveries: getDeliveries.all(r.id) })),
    });
  });

  // PUT /api/restock-requests/:id/fulfill — кладовщик (или админ) выдаёт со склада своего города.
  // Кладовщик не может выдать заявку из ЧУЖОГО города — она физически не про его склад.
  router.put('/api/restock-requests/:id/fulfill', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'warehouse'])(req, res, ctx);
    if (!payload) return;
    const request = db.prepare('SELECT * FROM restock_requests WHERE id = ?').get(ctx.params.id);
    if (!request) return sendJson(res, 404, { error: 'Заявка не найдена' });
    if (request.status !== 'pending') return sendJson(res, 400, { error: 'Заявка уже обработана' });
    if (payload.role === 'warehouse') {
      const keeperCity = resolveCityId(payload, null);
      if (keeperCity !== request.city_id) {
        return sendJson(res, 403, { error: 'Эта заявка из другого города — не может быть выдана с вашего склада' });
      }
    }

    const { allocations } = ctx.body || {}; // [{ item_id, qty_allocated }] — опционально, иначе выдаём как просили
    const items = db.prepare('SELECT * FROM restock_request_items WHERE request_id = ?').all(request.id);

    for (const item of items) {
      const override = allocations && allocations.find((a) => a.item_id === item.id);
      const qtyToGive = override ? override.qty_allocated : item.qty_requested;
      const warehouseRow = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(request.city_id, item.variant_id);
      const available = warehouseRow ? warehouseRow.qty : 0;
      const actualQty = Math.min(qtyToGive, available); // не даём больше, чем реально есть на складе
      db.prepare('UPDATE restock_request_items SET qty_allocated = ? WHERE id = ?').run(actualQty, item.id);
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)')
        .run(request.city_id, item.variant_id, Math.max(0, available - actualQty));
    }

    const keeperId = payload.role === 'warehouse' ? payload.id : null;
    db.prepare("UPDATE restock_requests SET status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ? WHERE id = ?")
      .run(keeperId, request.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/restock-requests/:id/deliveries — менеджер отмечает развоз по конкретной точке
  // (можно вызывать несколько раз за день — по одной точке за визит). Точка уже своя по
  // определению (stock — per-point, не per-город), город тут ни на что не влияет напрямую.
  router.post('/api/restock-requests/:id/deliveries', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const request = db.prepare('SELECT * FROM restock_requests WHERE id = ?').get(ctx.params.id);
    if (!request) return sendJson(res, 404, { error: 'Заявка не найдена' });
    if (request.manager_id !== payload.id) return sendJson(res, 403, { error: 'Это не ваша заявка' });
    if (request.status !== 'fulfilled') return sendJson(res, 400, { error: 'Заявка ещё не выдана со склада' });

    const { point_id, items } = ctx.body || {}; // [{ variant_id, qty }]
    if (!point_id || !Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: 'Укажите point_id и items' });
    }
    const point = db.prepare('SELECT * FROM points WHERE id = ? AND manager_id = ?').get(point_id, payload.id);
    if (!point) return sendJson(res, 400, { error: 'Точка не найдена или не принадлежит вам' });

    const insDelivery = db.prepare('INSERT INTO restock_deliveries (request_id, point_id, variant_id, qty) VALUES (?, ?, ?, ?)');
    for (const item of items) {
      insDelivery.run(request.id, point_id, item.variant_id, item.qty);
      const stockRow = db.prepare('SELECT qty FROM stock WHERE variant_id = ? AND point_id = ?').get(item.variant_id, point_id);
      const newQty = (stockRow ? stockRow.qty : 0) + item.qty;
      db.prepare('INSERT OR REPLACE INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)').run(item.variant_id, point_id, newQty);
    }
    sendJson(res, 201, { ok: true });
  });

  // ── ПЕРЕМЕЩЕНИЕ ТОВАРА НА ТОЧКУ (без кладовщика) ─────────────────────
  // Менеджер физически привозит товар на точку самостоятельно, ПОСЛЕ этого
  // отчитывается здесь — сколько и какого товара разместил. Остаток склада
  // и точки меняется только в момент одобрения администратором, не раньше.

  // POST /api/stock-movements — менеджер подаёт отчёт о размещении
  router.post('/api/stock-movements', (req, res, ctx) => {
    const payload = requireAuth(['manager'])(req, res, ctx);
    if (!payload) return;
    const { point_id, items, comment } = ctx.body || {}; // items: [{ variant_id, qty }]
    if (!point_id || !Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: 'Укажите point_id и items — список variant_id и qty' });
    }
    if (items.some((i) => !i.variant_id || !(i.qty > 0))) {
      return sendJson(res, 400, { error: 'У каждой позиции должны быть variant_id и qty больше нуля' });
    }
    const point = db.prepare('SELECT * FROM points WHERE id = ? AND manager_id = ?').get(point_id, payload.id);
    if (!point) return sendJson(res, 400, { error: 'Точка не найдена или не закреплена за вами' });

    // Город берём у САМОЙ ТОЧКИ, а не у менеджера — менеджер в принципе может
    // вести точку в другом городе (админ ничем не ограничивает это при
    // назначении). Раньше бралось resolveCityId(payload, null), что для роли
    // 'manager' всегда возвращает город самого менеджера — при рассинхроне
    // это списывало бы остаток со склада не того города, где физически
    // находится точка.
    const cityId = point.city_id;
    const info = db.prepare('INSERT INTO stock_movements (manager_id, point_id, city_id, comment) VALUES (?, ?, ?, ?)')
      .run(payload.id, point_id, cityId, comment || null);
    const movementId = info.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO stock_movement_items (movement_id, variant_id, qty) VALUES (?, ?, ?)');
    for (const item of items) insItem.run(movementId, item.variant_id, item.qty);

    const manager = db.prepare('SELECT id, full_name, login FROM managers WHERE id = ?').get(payload.id);
    const totalQty = items.reduce((sum, item) => sum + Math.round(Number(item.qty)), 0);
    logManagerAction(payload.id, 'Отчёт о перемещении товара', {
      type: 'stock_movement',
      id: movementId,
      name: point.name,
      details: items.length + ' поз. · ' + totalQty + ' шт.' + (comment ? ' · ' + String(comment).trim() : ''),
    }, manager);

    sendJson(res, 201, { ok: true, movement_id: movementId });
  });

  // GET /api/stock-movements — менеджер видит только свои отчёты, админ —
  // все (можно сузить по ?city= и/или ?status=)
  router.get('/api/stock-movements', (req, res, ctx) => {
    const payload = requireAuth(['admin', 'manager'])(req, res, ctx);
    if (!payload) return;
    let sql = `
      SELECT sm.*, p.name AS point_name, p.addr AS point_addr, p.icon AS point_icon, m.full_name AS manager_name
      FROM stock_movements sm
      JOIN points p ON p.id = sm.point_id
      JOIN managers m ON m.id = sm.manager_id
    `;
    const conditions = [];
    const params = [];
    if (payload.role === 'manager') {
      conditions.push('sm.manager_id = ?');
      params.push(payload.id);
    } else if (ctx.query.city) {
      conditions.push('sm.city_id = ?');
      params.push(ctx.query.city);
    }
    if (ctx.query.status) {
      conditions.push('sm.status = ?');
      params.push(ctx.query.status);
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY sm.id DESC';
    const rows = db.prepare(sql).all(...params);

    const getItems = db.prepare(`
      SELECT smi.*, v.weight, p.name AS product_name
      FROM stock_movement_items smi
      JOIN product_variants v ON v.id = smi.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE smi.movement_id = ?
    `);
    sendJson(res, 200, { movements: rows.map((r) => ({ ...r, items: getItems.all(r.id) })) });
  });

  // PUT /api/stock-movements/:id/approve — администратор согласовывает отчёт:
  // товар списывается с городского склада и зачисляется на точку. Если по
  // какой-то позиции на складе не хватает — не одобряем ничего частично,
  // возвращаем ошибку с указанием, чего именно не хватает (частичное
  // согласование только запутает и менеджера, и учёт остатков).
  router.put('/api/stock-movements/:id/approve', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(ctx.params.id);
    if (!movement) return sendJson(res, 404, { error: 'Отчёт не найден' });
    if (movement.status !== 'pending') return sendJson(res, 400, { error: 'Отчёт уже обработан' });

    const items = db.prepare('SELECT * FROM stock_movement_items WHERE movement_id = ?').all(movement.id);
    for (const item of items) {
      const warehouseRow = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(movement.city_id, item.variant_id);
      const available = warehouseRow ? warehouseRow.qty : 0;
      if (available < item.qty) {
        const productRow = db.prepare(`
          SELECT p.name, v.weight FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
        `).get(item.variant_id);
        return sendJson(res, 400, {
          error: 'На складе не хватает «' + (productRow ? productRow.name + ' (' + productRow.weight + ')' : 'товара') +
            '» — нужно ' + item.qty + ', на складе ' + available,
        });
      }
    }

    for (const item of items) {
      const warehouseRow = db.prepare('SELECT qty FROM warehouse_stock WHERE city_id = ? AND variant_id = ?').get(movement.city_id, item.variant_id);
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (city_id, variant_id, qty) VALUES (?, ?, ?)')
        .run(movement.city_id, item.variant_id, warehouseRow.qty - item.qty);
      const stockRow = db.prepare('SELECT qty FROM stock WHERE variant_id = ? AND point_id = ?').get(item.variant_id, movement.point_id);
      const newQty = (stockRow ? stockRow.qty : 0) + item.qty;
      db.prepare('INSERT OR REPLACE INTO stock (variant_id, point_id, qty) VALUES (?, ?, ?)').run(item.variant_id, movement.point_id, newQty);
    }

    db.prepare("UPDATE stock_movements SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
      .run(payload.login || null, movement.id);
    sendJson(res, 200, { ok: true });
  });

  // PUT /api/stock-movements/:id/reject — администратор отклоняет отчёт
  // (например, менеджер ошибся точкой или количеством) — остатки не трогаем.
  router.put('/api/stock-movements/:id/reject', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(ctx.params.id);
    if (!movement) return sendJson(res, 404, { error: 'Отчёт не найден' });
    if (movement.status !== 'pending') return sendJson(res, 400, { error: 'Отчёт уже обработан' });
    const { reason } = ctx.body || {};
    db.prepare("UPDATE stock_movements SET status = 'rejected', reject_reason = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
      .run(reason || null, payload.login || null, movement.id);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { registerWarehouseRoutes, slugify };
