'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-admin-orders-batch-'));
process.env.DATA_DIR = dir;

const db = require('./db');
const { signToken } = require('./auth');
const { registerOrderRoutes } = require('./routes-orders');

const routes = new Map();
registerOrderRoutes({
  get: (path, handler) => routes.set('GET ' + path, handler),
  post() {}, put() {}, delete() {},
});

function list(query = {}, token = signToken({ role:'admin', id:1, login:'admin-batch-test', adminRole:'super' })) {
  const res = {
    statusCode: 0, payload: null,
    writeHead(code) { this.statusCode = code; return this; },
    end(raw) { this.payload = JSON.parse(raw); },
  };
  routes.get('GET /api/orders')({
    headers: token ? { authorization: 'Bearer ' + token } : {},
  }, res, { query, params:{} });
  return res;
}

const insertOrder = db.prepare(
  'INSERT INTO orders (order_code, customer_name, customer_phone, pickup_point, ' +
  'subtotal, total, payment_method, status, partner_name) VALUES (?,?,?,?,?,?,?,?,?)'
);
const insertItem = db.prepare(
  'INSERT INTO order_items (order_id, name, weight, price, qty, is_custom) VALUES (?,?,?,?,?,?)'
);
function order(code, status, itemNames = []) {
  const id = Number(insertOrder.run(code, 'Покупатель', '79990001122', 'БаркЛай',
    250, 250, 'sbp', status, 'Грумер').lastInsertRowid);
  itemNames.forEach((name, i) => insertItem.run(id, name, '50 г', 250, i + 1, 0));
  return id;
}

test('empty list preserves shape and does not generate a batch IN () query', () => {
  const res = list({ limit:'500' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.orders, []);
});

test('admin list preserves order, item sequence and fields with status filter', () => {
  const first = order('batch-1', 'paid', ['Лёгкое', 'Сердце']);
  const second = order('batch-2', 'pending');
  order('batch-3', 'paid', ['Печень']);

  const res = list({ limit:'20' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.orders.map(o=>o.order_code), ['batch-3','batch-2','batch-1']);
  assert.deepEqual(res.payload.orders[2].items.map(i=>i.name), ['Лёгкое','Сердце']);
  assert.deepEqual(res.payload.orders[1].items, []);
  assert.equal(res.payload.orders[2].items[0].qty, 1);
  assert.equal(res.payload.orders[2].items[1].qty, 2);
  assert.equal(res.payload.orders[2].items[0].is_custom, 0);
  assert.equal(res.payload.orders[2].partner_name, 'Грумер');
  assert.equal(res.payload.orders[2].recovered, 0);
  assert.equal(res.payload.orders[2].id, first);
  assert.equal(res.payload.orders[1].id, second);
  assert.deepEqual(Object.keys(res.payload.orders[2].items[0]).sort(),
    ['variant_id','name','weight','price','qty','is_custom'].sort());

  const paid = list({ status:'paid', limit:'10' });
  assert.deepEqual(paid.payload.orders.map(o=>o.order_code), ['batch-3','batch-1']);
  assert.equal(list({}, '').statusCode, 401);
});

test('500-order request stays within SQLite binding limit and returns correct items', () => {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < 510; i++) {
      order('batch-extra-' + i, 'paid', i % 3 === 0 ? ['Игрушка'] : []);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const res = list({ limit:'99999' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.orders.length, 500, 'legacy maximum remains 500');
  assert.equal(res.payload.orders[0].order_code, 'batch-extra-509');
  assert.equal(res.payload.orders[0].items.length, 0);
  assert.equal(res.payload.orders[2].items[0].name, 'Игрушка');
});

test('batch uses existing order-items index and avoids per-order SQL calls', () => {
  const source = fs.readFileSync(path.join(__dirname, 'routes-orders.js'), 'utf8');
  const section = source.split("router.get('/api/orders',")[1].split("router.get('/api/orders/:id'")[0];
  assert.doesNotMatch(section, /getItems\.all\(o\.id\)/);
  assert.match(section, /WHERE order_id IN \(\$\{markers\}\)/);
  assert.match(section, /ORDER BY order_id, id/);
  const details = db.prepare(
    'EXPLAIN QUERY PLAN SELECT order_id, name FROM order_items ' +
    'WHERE order_id IN (?,?,?) ORDER BY order_id,id'
  ).all(1,2,3).map(row => String(row.detail)).join(' ');
  assert.match(details, /idx_order_items_order/);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive:true, force:true });
});
