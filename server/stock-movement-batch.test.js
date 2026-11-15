'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-movements-batch-'));
process.env.DATA_DIR = directory;
const db = require('./db');
const { hydrateStockMovements } = require('./stock-movement-batch');

db.prepare('INSERT INTO cities(id,name) VALUES (?,?)').run('batch-city', 'Красноярск');
const manager = Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)'
).run('MGR-BATCH','batch-manager','hash','Тестовый менеджер','79000000001').lastInsertRowid);
db.prepare('INSERT INTO points(id,name,addr,icon) VALUES(?,?,?,?)')
  .run('batch-point','Тестовый салон','Тестовая, 1','🐾');
const product = Number(db.prepare(
  'INSERT INTO products(slug,name,category,icon,desc,comp) VALUES(?,?,?,?,?,?)'
).run('batch-treat','Лёгкое','treats','🐾','Тест','[]').lastInsertRowid);
const variant = Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price) VALUES(?,?,?)'
).run(product,'50 г',250).lastInsertRowid);
const movementStatement = db.prepare(
  'INSERT INTO stock_movements(manager_id,point_id,city_id,comment) VALUES(?,?,?,?)'
);
const itemStatement = db.prepare(
  'INSERT INTO stock_movement_items(movement_id,variant_id,qty) VALUES(?,?,?)'
);
for (let i = 0; i < 252; i++) {
  const id = Number(movementStatement.run(manager,'batch-point','batch-city','batch ' + i).lastInsertRowid);
  if (i === 0) {
    itemStatement.run(id,variant,2);
    itemStatement.run(id,variant,4);
  }
  if (i === 251) itemStatement.run(id,variant,1);
}
const rows = db.prepare('SELECT * FROM stock_movements ORDER BY id DESC').all();

test('batched movement listing returns exactly the same shape and values as legacy queries', () => {
  const oldItems = db.prepare(
    'SELECT smi.*, p.name AS product_name, v.weight ' +
    'FROM stock_movement_items smi JOIN product_variants v ON v.id=smi.variant_id ' +
    'JOIN products p ON p.id=v.product_id WHERE smi.movement_id=?'
  );
  const oldPoint = db.prepare('SELECT name,addr,icon FROM points WHERE id=?');
  const oldManager = db.prepare('SELECT full_name,phone FROM managers WHERE id=?');
  const legacy = rows.map(m => ({
    ...m,
    items: oldItems.all(m.id),
    point: oldPoint.get(m.point_id),
    manager: oldManager.get(m.manager_id),
  }));
  assert.deepEqual(hydrateStockMovements(db, rows), legacy);
});
test('252 movement records use six SQL calls, not 756, and retain order', () => {
  let queries = 0;
  const wrapped = {
    prepare(sql) {
      queries++;
      return db.prepare(sql);
    },
  };
  const actual = hydrateStockMovements(wrapped, rows);
  assert.equal(actual.length, 252);
  assert.equal(queries, 6);
  assert.equal(actual[0].id, rows[0].id);
  assert.equal(actual[251].id, rows[251].id);
  assert.equal(actual[0].items.length, 1);
  assert.equal(actual[251].items.length, 2);
});
test('empty response does not execute SQL and preserves empty array', () => {
  const wrapped = { prepare() { throw Error('SQL must not execute'); } };
  assert.deepEqual(hydrateStockMovements(wrapped, []), []);
});
test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(directory, { recursive: true, force: true });
});
