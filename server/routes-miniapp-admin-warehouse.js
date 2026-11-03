'use strict';

// Canonical central warehouse controls for the Telegram administrator cabinet.
// Never create a second stock ledger: all operations use the existing city-scoped
// warehouse_stock, warehouse_receipts and warehouse_stock_adjustments tables.
const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireActiveAdmin } = require('./routes-auth');

const MAX_ADJUSTMENT = 100000;
const MAX_STOCK = 1000000000;
function validQty(value, min, max) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function activeCity(id) {
  if (typeof id !== 'string' || !id || id.length > 100) return null;
  return db.prepare('SELECT id,name FROM cities WHERE id=? AND active=1').get(id) || null;
}
function warehouseItems(cityId) {
  return db.prepare(
    'SELECT v.id AS variant_id,p.name AS product_name,v.weight,v.price, ' +
    'COALESCE(ws.qty,0) AS qty,CASE WHEN ws.variant_id IS NULL THEN 0 ELSE 1 END AS has_stock, ' +
    'CASE WHEN p.active=1 AND v.active=1 THEN 1 ELSE 0 END AS can_add ' +
    'FROM product_variants v JOIN products p ON p.id=v.product_id ' +
    'LEFT JOIN warehouse_stock ws ON ws.variant_id=v.id AND ws.city_id=? ' +
    'WHERE (p.active=1 AND v.active=1) OR ws.variant_id IS NOT NULL ' +
    'ORDER BY p.name COLLATE NOCASE,v.sort_order,v.id'
  ).all(cityId);
}
function reservedQty(cityId, variantId) {
  // Pending placements and unconsumed checkout reservations must not be
  // invalidated by a manual warehouse correction.
  const movements = db.prepare(
    "SELECT COALESCE(SUM(smi.qty),0) AS qty FROM stock_movements sm " +
    "JOIN stock_movement_items smi ON smi.movement_id=sm.id " +
    "WHERE sm.status='pending' AND sm.city_id=? AND smi.variant_id=?"
  ).get(cityId,variantId);
  const orders = db.prepare(
    'SELECT COALESCE(SUM(oi.qty),0) AS qty FROM orders o ' +
    'JOIN order_items oi ON oi.order_id=o.id ' +
    "WHERE o.status='pending' AND o.reservation_status='active' " +
    "AND o.inventory_source_type='warehouse' AND o.inventory_source_id=? AND oi.variant_id=?"
  ).get(cityId,variantId);
  return Number(movements.qty || 0) + Number(orders.qty || 0);
}

function registerMiniAppAdminWarehouseRoutes(router) {
  router.get('/api/miniapp/admin/warehouse', (req,res,ctx) => {
    if (!requireActiveAdmin(req,res,ctx)) return;
    const cities=db.prepare('SELECT id,name FROM cities WHERE active=1 ORDER BY name COLLATE NOCASE').all();
    const requested=ctx.query && ctx.query.city;
    const cityId=requested || (cities.find(x=>x.id==='krsk') || cities[0] || {}).id;
    if (!cityId) return sendJson(res,200,{cities,city_id:null,items:[]});
    if (!activeCity(cityId)) return sendJson(res,400,{error:'Город склада не найден или отключён'});
    return sendJson(res,200,{cities,city_id:cityId,items:warehouseItems(cityId)});
  });

  router.post('/api/miniapp/admin/warehouse/adjust', (req,res,ctx) => {
    const admin=requireActiveAdmin(req,res,ctx);
    if (!admin) return;
    const input=ctx.body || {};
    const {city_id,variant_id,expected_qty,qty,action,reason,confirmed} = input;
    if (!activeCity(city_id)) return sendJson(res,400,{error:'Выберите действующий город склада'});
    if (!validQty(variant_id,1,Number.MAX_SAFE_INTEGER) ||
        !validQty(expected_qty,0,MAX_STOCK) ||
        !['add','decrease','delete'].includes(action)) {
      return sendJson(res,400,{error:'Выберите товар, действие и актуальный исходный остаток'});
    }
    if (action !== 'delete' && !validQty(qty,1,MAX_ADJUSTMENT)) {
      return sendJson(res,400,{error:'Количество должно быть целым числом от 1 до 100 000'});
    }
    if (action === 'delete' && confirmed !== true) {
      return sendJson(res,400,{error:'Подтвердите удаление позиции со склада'});
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
      return sendJson(res,400,{error:'Укажите причину или документ (от 8 до 500 символов)'});
    }

    let opened=false;
    try {
      db.exec('BEGIN IMMEDIATE');
      opened=true;
      const variant=db.prepare(
        'SELECT v.id,v.weight,v.active AS variant_active,p.name AS product_name,p.active AS product_active ' +
        'FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?'
      ).get(variant_id);
      if (!variant) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,404,{error:'Товар не найден в каталоге ХвостМаркета'});
      }
      if (action === 'add' && (!variant.product_active || !variant.variant_active)) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,409,{error:'Архивный товар нельзя пополнять. Активируйте его в каталоге.'});
      }
      const row=db.prepare(
        'SELECT qty FROM warehouse_stock WHERE city_id=? AND variant_id=?'
      ).get(city_id,variant_id);
      const before=row ? row.qty : 0;
      if (before !== expected_qty) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,409,{
          error:'Остаток изменился. Обновите список и повторите действие.',
          current_qty:before,
        });
      }
      if (action !== 'add' && !row) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,404,{error:'Этой позиции нет на выбранном центральном складе'});
      }
      const after=action==='add' ? before+qty :
        action==='decrease' ? before-qty : null;
      if (action==='add' && (!Number.isSafeInteger(after) || after>MAX_STOCK)) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,400,{error:'Итоговый остаток слишком велик'});
      }
      if (action==='decrease' && after<0) {
        db.exec('ROLLBACK');opened=false;
        return sendJson(res,409,{error:'На складе недостаточно товара для списания'});
      }
      if (action!=='add') {
        const reserved=reservedQty(city_id,variant_id);
        if ((action==='delete' && reserved>0) ||
            (action==='decrease' && after<reserved)) {
          db.exec('ROLLBACK');opened=false;
          return sendJson(res,409,{
            error:'Товар задействован в заказах или ожидающих перемещениях. Доступно после резерва: ' +
              Math.max(0,before-reserved) + ' шт.',
            reserved_qty:reserved,
          });
        }
      }
      if (action==='delete') {
        const deleted=db.prepare(
          'DELETE FROM warehouse_stock WHERE city_id=? AND variant_id=? AND qty=?'
        ).run(city_id,variant_id,before);
        if (deleted.changes!==1) throw new Error('Остаток изменился во время удаления');
      } else {
        db.prepare(
          'INSERT INTO warehouse_stock (city_id,variant_id,qty) VALUES (?,?,?) ' +
          'ON CONFLICT(city_id,variant_id) DO UPDATE SET qty=excluded.qty'
        ).run(city_id,variant_id,after);
      }
      if (action==='add') {
        db.prepare(
          'INSERT INTO warehouse_receipts (variant_id,qty,supplier_note,keeper_id,city_id) ' +
          'VALUES (?,?,?,NULL,?)'
        ).run(variant_id,qty,reason.trim(),city_id);
      }
      db.prepare(
        'INSERT INTO warehouse_stock_adjustments ' +
        '(city_id,variant_id,product_name,weight,old_qty,new_qty,action,reason,admin_id,admin_login) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(city_id,variant_id,variant.product_name,variant.weight,before,after,
        action==='add'?'increase':action,reason.trim(),admin.id,admin.login||null);
      db.exec('COMMIT');
      opened=false;
      return sendJson(res,200,{
        ok:true,city_id,variant_id,action,old_qty:before,new_qty:after,
        changed_by:action==='delete'?before:qty,
      });
    } catch (error) {
      if (opened) {try{db.exec('ROLLBACK');}catch (_){}}
      console.error('[miniapp-admin-warehouse] correction failed:',error);
      return sendJson(res,500,{error:'Не удалось сохранить изменение. Остаток не изменён.'});
    }
  });
}

module.exports = {registerMiniAppAdminWarehouseRoutes};
