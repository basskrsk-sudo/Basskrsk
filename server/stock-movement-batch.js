'use strict';

// Read each movement's children and related entities in bounded batches.
// Legacy response shape is intentionally unchanged; only the number of
// synchronous SQLite calls is reduced from 1 + 3*N to ~1 + 3*ceil(N/250).
const DEFAULT_BATCH_SIZE = 250;

function hydrateStockMovements(database, movements, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!Array.isArray(movements) || movements.length === 0) return [];
  const limit = Math.max(1, Math.min(250, Math.trunc(Number(batchSize) || DEFAULT_BATCH_SIZE)));
  const itemsByMovement = new Map();
  const pointById = new Map();
  const managerById = new Map();

  for (let offset = 0; offset < movements.length; offset += limit) {
    const group = movements.slice(offset, offset + limit);
    const movementIds = group.map(row => row.id);
    const placeholders = movementIds.map(() => '?').join(',');
    const items = database.prepare(
      'SELECT smi.*, p.name AS product_name, v.weight ' +
      'FROM stock_movement_items smi ' +
      'JOIN product_variants v ON v.id = smi.variant_id ' +
      'JOIN products p ON p.id = v.product_id ' +
      'WHERE smi.movement_id IN (' + placeholders + ') ORDER BY smi.id'
    ).all(...movementIds);
    for (const item of items) {
      let list = itemsByMovement.get(item.movement_id);
      if (!list) { list = []; itemsByMovement.set(item.movement_id, list); }
      list.push(item);
    }

    const pointIds = [...new Set(group.map(row => row.point_id))];
    const pointPlaceholders = pointIds.map(() => '?').join(',');
    const points = database.prepare(
      'SELECT id, name, addr, icon FROM points WHERE id IN (' + pointPlaceholders + ')'
    ).all(...pointIds);
    for (const { id, name, addr, icon } of points)
      pointById.set(id, Object.assign(Object.create(null), { name, addr, icon }));

    const managerIds = [...new Set(group.map(row => row.manager_id))];
    const managerPlaceholders = managerIds.map(() => '?').join(',');
    const managers = database.prepare(
      'SELECT id, full_name, phone FROM managers WHERE id IN (' + managerPlaceholders + ')'
    ).all(...managerIds);
    for (const { id, full_name, phone } of managers)
      managerById.set(id, Object.assign(Object.create(null), { full_name, phone }));
  }
  return movements.map(movement => ({
    ...movement,
    items: itemsByMovement.get(movement.id) || [],
    point: pointById.get(movement.point_id),
    manager: managerById.get(movement.manager_id),
  }));
}
module.exports = { DEFAULT_BATCH_SIZE, hydrateStockMovements };
