'use strict';

// Keep the legacy marker until the real database and all linked historical
// records have been reviewed. This repair is intentionally non-destructive.
function archiveLegacyDemoPoints(database) {
  const row = database.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN active <> 0 THEN 1 ELSE 0 END),0) AS active_count FROM points WHERE COALESCE(is_hub,0) <> 0'
  ).get();
  const total = Number(row.total || 0);
  const archived = Number(row.active_count || 0);
  if (archived) database.prepare(
    'UPDATE points SET active=0 WHERE COALESCE(is_hub,0) <> 0 AND active <> 0'
  ).run();
  return { total, archived };
}

// Only exposed via the authenticated superadmin route; no background scans.
function auditLegacyDemoPoints(database) {
  return database.prepare(`
    SELECT p.id, p.name, p.active,
      (SELECT COUNT(*) FROM orders o WHERE o.point_id=p.id) AS orders_count,
      (SELECT COUNT(*) FROM orders o WHERE o.point_id=p.id AND o.status='paid') AS paid_orders_count,
      (SELECT COUNT(*) FROM orders o WHERE o.point_id=p.id AND o.status='pending') AS pending_orders_count,
      (SELECT COUNT(*) FROM partners g WHERE g.point_id=p.id) AS partners_count,
      (SELECT COUNT(*) FROM salon_owners so WHERE so.point_id=p.id) AS owners_count,
      (SELECT COUNT(*) FROM manager_points mp WHERE mp.point_id=p.id) AS manager_links_count,
      (SELECT COUNT(*) FROM stock s WHERE s.point_id=p.id AND s.qty<>0) AS stock_positions_count
    FROM points p WHERE COALESCE(p.is_hub,0) <> 0
    ORDER BY p.name, p.id
  `).all();
}
module.exports = { archiveLegacyDemoPoints, auditLegacyDemoPoints };
