'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every test uses an isolated SQLite database, never /data from Amvera.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-manager-live-points-'));
const db = require('./db');
const { listCurrentManagerPoints } = require('./routes-managers');

function manager(code) {
  return Number(db.prepare(
    'INSERT INTO managers (mgr_code, login, password_hash, full_name, phone) VALUES (?, ?, ?, ?, ?)'
  ).run(code, code, 'hash', code, '79130000000').lastInsertRowid);
}

function point(id, name, managerId, active = 1) {
  db.prepare('INSERT INTO points (id,name,addr,icon,manager_id,active) VALUES (?,?,?,?,?,?)')
    .run(id, name, 'Красноярск, тест', '🏪', managerId, active);
}

function order(id, pointId, status, refundStatus, total) {
  db.prepare(
    'INSERT INTO orders (order_code, customer_name, customer_phone, pickup_point, point_id, ' +
    'subtotal, total, payment_method, status, refund_status) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, 'Покупатель', '79130000001', 'Точка', pointId, total, total, 'sbp', status, refundStatus);
}

test('current manager network only counts real active assigned points, not ghost history or another manager', () => {
  const angelina = manager('angelina-test');
  const another = manager('another-test');
  point('barklay-live', 'БаркЛай', angelina);
  point('second-live', 'Zveryuga', angelina);
  point('inactive', 'Старая закрытая', angelina, 0);
  point('other', 'Чужая точка', another);
  point('unassigned', 'Точка без менеджера', null);

  // Legacy referrals may contain no real point, an old name, or duplicates.
  db.prepare(
    'INSERT INTO manager_points (manager_id, point_id, point_name, point_type) VALUES (?,?,?,?)'
  ).run(angelina, null, 'Груминг Пушок', 'Груминг');
  db.prepare(
    'INSERT INTO manager_points (manager_id, point_id, point_name, point_type) VALUES (?,?,?,?)'
  ).run(angelina, 'barklay-live', 'Сир Барсик (старое название)', 'Груминг');
  db.prepare(
    'INSERT INTO manager_points (manager_id, point_id, point_name, point_type) VALUES (?,?,?,?)'
  ).run(angelina, 'barklay-live', 'Дубль', 'Груминг');

  order('paid-live', 'barklay-live', 'paid', 'none', 500);
  order('refunded-live', 'barklay-live', 'paid', 'refunded', 170);
  order('pending-live', 'barklay-live', 'pending', 'none', 400);
  order('paid-inactive', 'inactive', 'paid', 'none', 800);
  order('paid-other', 'other', 'paid', 'none', 900);

  const result = listCurrentManagerPoints(angelina);
  assert.deepEqual(result.map(row => row.point_name).sort(), ['Zveryuga','БаркЛай']);
  assert.equal(result.find(row => row.point_id === 'barklay-live').live_revenue, 500);
  assert.equal(result.find(row => row.point_id === 'second-live').live_revenue, 0);
  assert.equal(result.some(row => row.point_name.includes('Пушок')), false);
  assert.equal(result.some(row => row.point_id === 'inactive'), false);
  assert.equal(result.some(row => row.point_id === 'other'), false);
  assert.equal(result.some(row => row.point_id === 'unassigned'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_points WHERE manager_id=?')
    .get(angelina).n, 3, 'legacy referrals and payout history must not be deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 5,
    'financial history is retained, even for inactive salons');
});
