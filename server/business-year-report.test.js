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

// 2026 — год запуска, отсчёт с сентября. p4 открыта в октябре без продаж,
// p5 — историческая карточка с неизвестной датой.
for (const [pointId, date] of [
  ['test-business-p1','2026-09-05 00:00:00'],
  ['test-business-p2','2026-09-19 00:00:00'],
  ['test-business-p3','2026-09-10 00:00:00'],
  ['test-business-p4','2026-10-14 00:00:00'],
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
).run(managerId,'test-business-p1','Test p1','Грумминг',0.07);
db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate) VALUES (?,?,?,?,?,?)'
).run('business-owner','hash','Owner','79990000002','test-business-p1',0.05);

function order(code,pointId,status,total,createdAt,refundedAmount=0,refundStatus='none',rate=0) {
  db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,' +
    'subtotal,total,payment_method,status,refund_status,refunded_amount,created_at,commission_rate)' +
    ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code,'Test customer','79995551100','Point',pointId,
    total,total,'sbp',status,refundStatus,refundedAmount,createdAt,rate);
}
// Старая продажа/расход в августе НЕ входят в отчёт за год запуска.
order('BUSINESS-AUG','test-business-p5','paid',200,'2026-08-30 18:00:00');
order('BUSINESS-SEP-1','test-business-p1','paid',1000,'2026-09-05 17:20:00',0,'none',0.15);
order('BUSINESS-SEP-2','test-business-p1','paid',500,'2026-09-13 12:00:00',100,'partial',0.15);
order('BUSINESS-SEP-PENDING','test-business-p2','pending',900,'2026-09-25 12:00:00');
order('BUSINESS-SEP-REFUNDED','test-business-p2','paid',250,'2026-09-25 13:00:00',250,'refunded');
order('BUSINESS-OCT','test-business-p2','paid',800,'2026-10-20 00:00:00');
order('BUSINESS-NOV-FUTURE','test-business-p3','paid',9999,'2026-11-06 08:00:00');

for (const [date,amount] of [
  ['2026-08-15',900], ['2026-09-15',400],
  ['2026-10-10',300], ['2026-11-05',50], ['2026-11-06',9999],
]) {
  db.prepare('INSERT INTO expenses(expense_date,category,amount) VALUES (?,?,?)')
    .run(date,'Test expense',amount);
}
const now = new Date('2026-11-05T00:30:00Z');

test('the 2026 report starts on September 1, excluding January–August', () => {
  const r = report.collectBusinessYearReport(2026,now);
  assert.equal(r.year,2026);
  assert.equal(r.period.from_local,'2026-09-01');
  assert.equal(r.period.through_local,'2026-11-05');
  assert.deepEqual(r.months.map(x=>x.key),['2026-09','2026-10','2026-11']);
  assert.equal(r.months[2].manual_expenses,50);
  assert.equal(r.months[2].sales,0); // November 6 is in the future
  assert.equal(r.months[2].net_profit,-50);
  assert.equal(r.totals.revenue,2200); // August 200 is NOT counted
  assert.equal(r.totals.manual_expenses,750); // August 900 is NOT counted
});

test('September shows growth from zero, correct revenue and three registered points', () => {
  const sep = report.collectBusinessYearReport(2026,now).months[0];
  assert.equal(sep.revenue,1400);
  assert.equal(sep.sales,2);
  assert.equal(sep.refunds,100);
  assert.equal(sep.average_check,700);
  assert.equal(sep.partner_commission,210);
  assert.equal(sep.manager_commission,98);
  assert.equal(sep.owner_commission,70);
  assert.equal(sep.tax,84);
  assert.equal(sep.acquiring,28);
  assert.equal(sep.manual_expenses,400);
  assert.equal(sep.total_costs,890);
  assert.equal(sep.net_profit,510);
  assert.equal(sep.active_points,1);
  assert.equal(sep.new_points,3);
  assert.equal(sep.registered_points_known,3);
  assert.equal(sep.revenue_change_text,'с нуля');
  assert.equal(sep.sales_change_text,'с нуля');
});

test('October compares against September and includes unsold new point', () => {
  const oct = report.collectBusinessYearReport(2026,now).months[1];
  assert.equal(oct.revenue,800);
  assert.equal(oct.sales,1);
  assert.equal(oct.new_points,1); // p4 registered in October with no purchases
  assert.equal(oct.registered_points_known,4);
  assert.equal(oct.total_costs,364);
  assert.equal(oct.net_profit,436);
  assert.equal(oct.revenue_change_percent,-42.9);
  assert.equal(oct.sales_change_text,'-50%');
  assert.equal(oct.profit_change,-74);
});

test('compact Telegram layout is readable and financial details remain in CSV', () => {
  const r=report.collectBusinessYearReport(2026,now);
  const message=report.formatBusinessYearReport(r);
  assert.match(message,/ХвостМаркет · бизнес 2026/);
  assert.match(message,/01\.09–05\.11\.2026/);
  assert.match(message,/По месяцам \(в скобках — к предыдущему месяцу\)/);
  assert.match(message,/Сен:\n💚 1\s?400 ₽ \(с нуля\)/);
  assert.match(message,/🏪 \+3 \(с нуля\), всего 3/);
  assert.match(message,/Окт:\n💚 800 ₽ \(-42,9%\)/);
  assert.match(message,/🏪 \+1, всего 4/);
  assert.match(message,/📅 ИТОГО 2026 \(с начала года\)/);
  assert.match(message,/🧾 Оплаченных заказов: 3\n🛍 Средний чек: 733 ₽/);
  assert.match(message,/В реестре всего точек: 5/);
  assert.ok(!message.includes('Янв:'));
  assert.ok(!message.includes('💸 затраты'));
  assert.ok(!message.includes('📈 прибыль'));

  const csv = report.buildBusinessYearCsv(r);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv,/2026-09/);
  assert.match(csv,/2026-10/);
  assert.ok(!csv.includes('2026-01'));
  assert.match(csv,/Учтённые затраты/);
  assert.match(csv,/Расчётная прибыль/);
  const pointsCsv=report.buildBusinessPointsCsv(r);
  assert.ok(pointsCsv.startsWith('\uFEFF'));
  assert.match(pointsCsv,/2026-09: заказов/);
  assert.ok(!pointsCsv.includes('2026-01'));
});

test('all points are included, unknown dates remain visible', () => {
  const r=report.collectBusinessYearReport(2026,now);
  assert.equal(r.totals.sales,3);
  assert.equal(r.totals.active_points,2);
  assert.equal(r.totals.new_points,4);
  assert.equal(r.unknown_creation_dates,1);
  assert.equal(r.total_points_in_registry,5);
  assert.equal(r.points_with_known_registration,4);
  assert.deepEqual(r.missing_creation_dates.map(p=>p.id),['test-business-p5']);
  assert.equal(r.points.find(p=>p.id==='test-business-p4').sales,0);
  assert.equal(r.points.find(p=>p.id==='test-business-p2').created_date,'2026-09-19');
  assert.equal(r.points.find(p=>p.id==='test-business-p2').monthly_sales['2026-10'].sales,1);
  assert.match(report.formatBusinessYearReport(r),/Дата регистрации неизвестна у точек/);
  const pointsCsv=report.buildBusinessPointsCsv(r);
  assert.equal(pointsCsv.trim().split('\r\n').length,6);
  assert.match(pointsCsv,/НЕТ ДАННЫХ/);
});

test('other years keep all twelve months, future years and fractions rejected', () => {
  const r=report.collectBusinessYearReport(2025,now);
  assert.equal(r.months.length,12);
  assert.equal(r.period.from_local,'2025-01-01');
  assert.equal(r.totals.revenue,0);
  assert.throws(()=>report.collectBusinessYearReport(2027,now),/Выберите год/);
  assert.throws(()=>report.collectBusinessYearReport(2026.5,now),/Выберите год/);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir,{recursive:true,force:true});
});
