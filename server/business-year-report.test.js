'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvost-business-year-'));
process.env.DATA_DIR = dir;
const db = require('./db');
const report = require('./business-year-report');

for (const id of [
  'test-business-p1','test-business-p2','test-business-p3',
  'test-business-p4','test-business-p5',
]) {
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES (?,?,?,?,1)')
    .run(id, 'Test ' + id, 'Test address', '🐾');
}
// Даты создания точек отличаются от первых продаж.
// p1 создана в декабре, первая продажа в январе;
// p2 создана в январе, первая продажа в феврале;
// p4 создана в феврале, но не совершила ни одной продажи.
// p5 — старый салон без сохранившейся даты создания.
for (const [pointId, date] of [
  ['test-business-p1','2025-12-20 00:00:00'],
  ['test-business-p2','2026-01-20 00:00:00'],
  ['test-business-p3','2025-12-10 00:00:00'],
  ['test-business-p4','2026-02-14 00:00:00'],
]) {
  db.prepare("UPDATE points SET created_at=?, created_at_source='recorded' WHERE id=?")
    .run(date,pointId);
}
db.prepare("UPDATE points SET created_at=NULL, created_at_source=NULL WHERE id='test-business-p5'")
  .run();
const managerId = db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES (?,?,?,?,?)'
).run('MGR-BUSINESS-TEST','manager-test','hash','Test manager','79990000001').lastInsertRowid;
db.prepare(
  'INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate) VALUES (?,?,?,?,?)'
).run(managerId, 'test-business-p1', 'Test p1', 'Грумминг', 0.07);
db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES (?,?,?,?,?,?)'
).run('business-owner','hash','Owner','79990000002','test-business-p1',0.05);

function order(code,pointId,status,total,createdAt,refundedAmount=0,refundStatus='none',rate=0) {
  db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,' +
    'subtotal,total,payment_method,status,refund_status,refunded_amount,created_at,commission_rate)' +
    ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code, 'Test customer', '79995551100', 'Point', pointId,
    total, total, 'sbp', status, refundStatus, refundedAmount, createdAt, rate);
}
// Сравнение января с декабрём прошлого года; в декабре у p3 уже была продажа.
order('BUSINESS-DEC','test-business-p3','paid',200,'2025-12-30 18:00:00');
order('BUSINESS-JAN-1','test-business-p1','paid',1000,'2025-12-31 17:20:00',0,'none',0.15);
order('BUSINESS-JAN-2','test-business-p1','paid',500,'2026-01-13 12:00:00',100,'partial',0.15);
order('BUSINESS-JAN-PENDING','test-business-p2','pending',900,'2026-01-15 12:00:00');
order('BUSINESS-JAN-REFUNDED','test-business-p2','paid',250,'2026-01-15 13:00:00',250,'refunded');
order('BUSINESS-FEB','test-business-p2','paid',800,'2026-02-01 00:00:00');
order('BUSINESS-MAR-FUTURE','test-business-p3','paid',9999,'2026-03-06 08:00:00');
// На 5 марта трата с датой 6 марта не должна учитываться.
for (const [date,amount] of [
  ['2026-01-15',400],['2026-02-10',300],
  ['2026-03-05',50],['2026-03-06',9999],
]) {
  db.prepare('INSERT INTO expenses(expense_date,category,amount) VALUES (?,?,?)')
    .run(date,'Test expense',amount);
}
const now = new Date('2026-03-05T00:30:00Z');

test('reports exactly elapsed calendar months in Krasnoyarsk', () => {
  const r = report.collectBusinessYearReport(2026, now);
  assert.equal(r.year,2026);
  assert.equal(r.months.length,3);
  assert.equal(r.period.through_local,'2026-03-05');
  assert.equal(r.months[0].key,'2026-01');
  assert.equal(r.months[2].manual_expenses,50);
  assert.equal(r.months[2].sales,0); // future paid order is not included
  assert.equal(r.months[2].net_profit,-50);
});

test('Jan includes paid net sales and costs; growth compares to preceding December', () => {
  const jan = report.collectBusinessYearReport(2026,now).months[0];
  assert.equal(jan.revenue,1400);
  assert.equal(jan.sales,2);
  assert.equal(jan.refunds,100);
  assert.equal(jan.average_check,700);
  assert.equal(jan.partner_commission,210);
  assert.equal(jan.manager_commission,98);
  assert.equal(jan.owner_commission,70);
  assert.equal(jan.tax,84);
  assert.equal(jan.acquiring,28);
  assert.equal(jan.manual_expenses,400);
  assert.equal(jan.total_costs,890);
  assert.equal(jan.net_profit,510);
  assert.equal(jan.active_points,1);
  assert.equal(jan.new_points,1); // p2 registered, although it has no January sales
  assert.equal(jan.revenue_change_percent,600);
  assert.equal(jan.sales_change_text,'+100%');
  assert.equal(jan.profit_change,null);
});

test('Feb counts created point p4 without sales, not the first-sale point p2', () => {
  const feb = report.collectBusinessYearReport(2026,now).months[1];
  assert.equal(feb.revenue,800);
  assert.equal(feb.sales,1);
  assert.equal(feb.active_points,1);
  assert.equal(feb.new_points,1); // p4 created in February, 0 paid orders
  assert.equal(feb.total_costs,364);
  assert.equal(feb.net_profit,436);
  assert.equal(feb.revenue_change_percent,-42.9);
  assert.equal(feb.sales_change_text,'-50%');
  assert.equal(feb.profit_change,-74);
});

test('year totals use unique points, annual margins and avoid double counting', () => {
  const r = report.collectBusinessYearReport(2026,now);
  assert.equal(r.totals.revenue,2200);
  assert.equal(r.totals.sales,3);
  assert.equal(r.totals.active_points,2);
  assert.equal(r.totals.new_points,2);
  assert.equal(r.unknown_creation_dates,1);
  assert.equal(r.total_points_in_registry,5);
  assert.equal(r.points_with_known_registration,4);
  const missing = r.missing_creation_dates.map(p => p.id);
  assert.deepEqual(missing,['test-business-p5']);
  const p4 = r.points.find(p => p.id === 'test-business-p4');
  assert.equal(p4.sales,0); // non-selling points remain in the full report
  assert.equal(p4.revenue,0);
  assert.equal(p4.created_date,'2026-02-14');
  assert.equal(r.points.find(p => p.id === 'test-business-p2').created_date,'2026-01-20');
  assert.equal(r.points.find(p => p.id === 'test-business-p2').sales,1);
  assert.equal(r.months[0].registered_points_known,3);
  assert.equal(r.months[1].registered_points_known,4);
  assert.ok(report.formatBusinessYearReport(r).includes('Дата регистрации неизвестна у точек (1):'));
  assert.match(report.formatBusinessYearReport(r),/test-business-p5/);
  assert.equal(r.totals.manual_expenses,750);
  assert.equal(r.totals.net_profit,896);
  const message = report.formatBusinessYearReport(r);
  assert.match(message,/2026/);
  assert.match(message,/расчётная прибыль/i);
  assert.match(message,/Янв/);
  const csv = report.buildBusinessYearCsv(r);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv,/2026-01/);
  assert.match(csv,/ИТОГО 2026/);
  assert.match(csv,/Изменение прибыли к предыдущему месяцу/);
  assert.match(csv,/Новые точки \(создание карточки\)/);
  assert.match(csv,/Всего точек с датой регистрации к концу месяца/);
  const pointsCsv = report.buildBusinessPointsCsv(r);
  assert.ok(pointsCsv.startsWith('\uFEFF'));
  assert.equal(pointsCsv.trim().split('\r\n').length,6); // header + 5 points
  assert.match(pointsCsv,/Test test-business-p5/);
  assert.match(pointsCsv,/НЕТ ДАННЫХ/);
  assert.match(pointsCsv,/Отключена|Активна/);
  assert.match(pointsCsv,/2026-02-14/);
  assert.match(pointsCsv,/ДА/);
});

test('past year has 12 complete rows, and invalid years are rejected', () => {
  const r = report.collectBusinessYearReport(2025,now);
  assert.equal(r.months.length,12);
  assert.equal(r.totals.revenue,200);
  assert.equal(r.totals.active_points,1);
  assert.throws(() => report.collectBusinessYearReport(2027,now),/Выберите год/);
  assert.throws(() => report.collectBusinessYearReport(2026.5,now),/Выберите год/);
});
test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive:true, force:true });
});
