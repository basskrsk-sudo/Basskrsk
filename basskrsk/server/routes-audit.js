// routes-audit.js — журнал опасных административных действий.
// Доступен только супер-администратору: обычный админ не видит раздел в
// интерфейсе и получает 403 при прямом обращении к API.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { requireSuperAdmin } = require('./routes-auth');

function registerAuditRoutes(router) {
  router.get('/api/admin/audit-log', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;

    const requestedLimit = Number(ctx.query.limit);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(500, Math.max(1, requestedLimit))
      : 200;
    const type = String(ctx.query.type || '').trim();

    const customerEvents = type && type !== 'customer_delete' ? [] : db.prepare(`
      SELECT
        'customer_delete' AS type,
        id,
        created_at,
        admin_id,
        admin_login,
        reason,
        customer_id,
        phone,
        full_name,
        orders_count,
        total_spent,
        bones_balance
      FROM customer_deletion_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit);

    const warehouseEvents = type && type !== 'warehouse_delete' ? [] : db.prepare(`
      SELECT
        'warehouse_delete' AS type,
        w.id,
        w.created_at,
        w.admin_id,
        w.admin_login,
        w.reason,
        w.city_id,
        COALESCE(c.name, w.city_id) AS city_name,
        w.variant_id,
        w.product_name,
        w.weight,
        w.old_qty,
        w.new_qty,
        w.action
      FROM warehouse_stock_adjustments w
      LEFT JOIN cities c ON c.id = w.city_id
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT ?
    `).all(limit);

    const managerEvents = type && type !== 'manager_action' ? [] : db.prepare(`
      SELECT
        'manager_action' AS type,
        id,
        created_at,
        manager_id,
        manager_name,
        manager_login,
        action,
        target_type,
        target_id,
        target_name,
        details
      FROM manager_action_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit);

    const orderPartnerEvents = type && type !== 'order_partner_change' ? [] : db.prepare(`
      SELECT
        'order_partner_change' AS type,
        id,
        created_at,
        admin_id,
        admin_login,
        reason,
        order_id,
        order_code,
        old_partner_id,
        old_partner_name,
        old_commission_rate,
        new_partner_id,
        new_partner_name,
        new_commission_rate
      FROM order_partner_change_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit);

    const events = customerEvents.concat(warehouseEvents, managerEvents, orderPartnerEvents)
      .sort((a, b) => {
        const byDate = String(b.created_at).localeCompare(String(a.created_at));
        if (byDate) return byDate;
        return Number(b.id) - Number(a.id);
      })
      .slice(0, limit);

    sendJson(res, 200, { events, count: events.length });
  });
}

module.exports = { registerAuditRoutes };
