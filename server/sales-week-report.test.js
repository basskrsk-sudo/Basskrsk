'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-sales-week-'));
process.env.DATA_DIR = tmp;
process.env.TG_CHAT_ID = '88';
const db = require('./db');
const report = require('./sales-week-report');

function newOrder(code, status, pointId, phone, total, createdAt, refundStatus = 'none', refundAmount = 0) {
  const result = db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,' +
    'subtotal,total,payment_method,status,refund_status,refunded_amount,created_at)' +
    ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code, 'Test', phone, pointId === 'a' ? 'BarkLay' : 'Zveryuga',
    pointId, total, total, 'sbp', status, refundStatus, refundAmount, createdAt);
  return Number(result.lastInsertRowid);
}
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('a', 'BarkLay', 'Test address A', '🐾');
db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
  .run('b', 'Zveryuga', 'Test address B', '🐾');
const a = newOrder('SALE-A','paid','a','111',250,'2026-10-24 08:00:00');
const b = newOrder('SALE-B','paid','b','222',500,'2026-10-23 08:00:00','partial',100);
newOrder('SALE-UNPAID','pending','a','333',350,'2026-10-24 09:00:00');
newOrder('SALE-RETURNED','paid','a','444',300,'2026-10-23 09:00:00','refunded',300);
newOrder('SALE-OLD','paid','a','555',400,'2026-10-16 10:00:00');
db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES (?,?,?,?,?)')
  .run(a,'Бычье лёгкое','50 г',250,1);
db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES (?,?,?,?,?)')
  .run(b,'Кроличья лапка','1 шт.',250,2);

test('seven-day report includes paid net revenue only', () => {
  const data = report.collectSalesWeekReport(new Date('2026-10-25T12:00:00Z'));
  assert.equal(data.current.sales, 2);
  assert.equal(data.current.revenue, 650);
  assert.equal(data.current.refunds, 100);
  assert.equal(data.current.active_points, 2);
  assert.equal(data.average_check, 325);
  assert.equal(data.previous.sales, 1);
  assert.equal(data.previous.revenue, 400);
  assert.equal(data.points.reduce((s, p) => s + p.revenue, 0), 650);
  assert.equal(data.days.reduce((s, p) => s + p.sales, 0), 2);
  assert.equal(data.pointDays.length, 2);
  assert.equal(data.products.reduce((s,p) => s + p.units, 0), 3);
  assert.match(report.formatSalesWeekReport(data), /650 ₽/);
  const csv = report.buildSalesWeekCsv(data);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /Zveryuga/);
  assert.match(csv, /ИТОГО/);
});
test('report command is restricted to linked active admins or internal private chat ID', () => {
  assert.equal(report.adminCanReadSales('999'), false);
  assert.equal(report.adminCanReadSales('88'), true);
  assert.equal(report.adminCanReadSales('not-a-chat'), false);
  db.prepare("INSERT INTO admins(login,password_hash,telegram_chat_id,active) VALUES('test-admin','hash','77',1)").run();
  db.prepare("INSERT INTO admins(login,password_hash,telegram_chat_id,active) VALUES('test-inactive','hash','66',0)").run();
  assert.equal(report.adminCanReadSales('77'), true);
  assert.equal(report.adminCanReadSales('66'), false);
});
test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});
