'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-report-query-efficiency-'));
const db = require('./db');
const { collectWeeklyReport, collectWeeklyBscReport, getCachedWeeklyBsc } = require('./weekly-report');
const { PAID_PHONE_KEY_SQL } = require('./report-phone-key');

const now = new Date('2026-11-12T12:00:00.000Z');
const products = [
  Number(db.prepare("INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,1)")
    .run('report-fast-liver','Report Treat 1','treats','🐾','Unit test','[]').lastInsertRowid),
  Number(db.prepare("INSERT INTO products(slug,name,category,icon,desc,comp,active) VALUES(?,?,?,?,?,?,1)")
    .run('report-fast-heart','Report Treat 2','treats','🐾','Unit test','[]').lastInsertRowid),
];
const variant = Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,cost_price,active) VALUES(?,?,?,?,1)'
).run(products[0],'50 г',250,90).lastInsertRowid);
const inactiveVariant = Number(db.prepare(
  'INSERT INTO product_variants(product_id,weight,price,cost_price,active) VALUES(?,?,?,?,0)'
).run(products[1],'100 г',500,190).lastInsertRowid);

for (let i=0; i<70; i++) {
  const id='report-fast-'+i;
  db.prepare('INSERT INTO points(id,name,addr,icon,active,is_hub) VALUES(?,?,?,?,?,0)')
    .run(id,'Report Point '+String(i).padStart(3,'0'),'Красноярск','🏪',i===69?0:1);
  if (i<69) {
    db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?)')
      .run(variant,id,i%4);
    db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES(?,?,?)')
      .run(inactiveVariant,id,12);
  }
}
function order(code, point, when, total, status='paid', refunded=0, phone='79998887766') {
  const id=db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,'+
    'subtotal,total,payment_method,status,refund_status,refunded_amount,created_at,commission_rate) '+
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code,'Report customer',phone,'Report Point',point,total,total,
    'sbp',status,refunded>=total?'refunded':refunded?'partial':'none',
    refunded,when,0.15).lastInsertRowid;
  db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES(?,?,?,?,?)')
    .run(id,'Report Treat 1','50 г',total,1);
}
order('RPT-EARLY','report-fast-0','2026-10-29 09:00:00',200);
order('RPT-PREV','report-fast-1','2026-10-31 09:00:00',150);
order('RPT-CURRENT-1','report-fast-0','2026-11-03 09:00:00',300);
order('RPT-CURRENT-2','report-fast-1','2026-11-04 09:00:00',450,'paid',50);
order('RPT-REFUND','report-fast-1','2026-11-05 09:00:00',400,'paid',400);
order('RPT-PENDING','report-fast-2','2026-11-05 11:00:00',1000,'pending');
order('RPT-CURRENT-3','report-fast-3','2026-11-06 12:00:00',220,'paid',0,'79135553322');

test('full management report and lightweight BSC preserve exactly the same scored KPIs', () => {
  const full = collectWeeklyReport(now);
  const lean = collectWeeklyBscReport(now);

  assert.equal(full.period.start_local,'2026-11-02');
  assert.deepEqual(lean.period,full.period);
  assert.deepEqual(lean.points,full.points,'point revenue and stock aggregation unchanged');
  assert.deepEqual(lean.customers,full.customers,'repeat-customer calculations unchanged');
  assert.deepEqual(lean.current,full.current,'core period metrics unchanged');
  assert.deepEqual(lean.previous,full.previous);
  assert.deepEqual(lean.bsc.perspectives,full.bsc.perspectives);
  assert.deepEqual(lean.bsc.points,full.bsc.points);
  assert.deepEqual(lean.bsc.readiness,full.bsc.readiness);
  assert.deepEqual(lean.bsc.initiatives_summary,full.bsc.initiatives_summary);
  assert.equal(lean.bsc.overall_score,full.bsc.overall_score);
  assert.equal(lean.bsc.status,full.bsc.status);
  assert.deepEqual(lean.bsc.responsibility_matrix,full.bsc.responsibility_matrix);
  assert.equal(lean.current.revenue, 920); // 300 + 400 + 0 refund + 220
  assert.equal(lean.points.find(p=>p.id==='report-fast-0').revenue, 300);
  assert.equal(lean.points.find(p=>p.id==='report-fast-1').revenue, 400);
  assert.equal(lean.points.find(p=>p.id==='report-fast-2').revenue, 0);
  assert.equal(lean.points.find(p=>p.id==='report-fast-69').active,false);
  assert.equal(lean.points.find(p=>p.id==='report-fast-0').out_count,1);
  assert.equal(lean.points.find(p=>p.id==='report-fast-0').retail_stock_value,0);
  assert.equal(lean.points.find(p=>p.id==='report-fast-3').retail_stock_value,750);
  assert.equal(lean.points.find(p=>p.id==='report-fast-3').low_count,0);
  assert.equal(lean.points.length,70);
  assert.equal(lean.growth_plan,undefined,'BSC must not build the growth model');
  assert.equal(lean.products,undefined,'BSC must not compute product leaderboard');
  assert.equal(lean.daily,undefined,'BSC must not compute daily charts');
});

test('full report order rows do not join point/city tables unnecessarily',()=>{
  const source=fs.readFileSync(path.join(__dirname,'weekly-report.js'),'utf8');
  const getOrders=source.split('function getOrders(start, end) {')[1].split('function effectiveRevenue(order) {')[0];
  assert.match(getOrders,/SELECT o\.\*/);
  assert.doesNotMatch(getOrders,/LEFT JOIN points|LEFT JOIN cities/);
  const report=collectWeeklyReport(now);
  assert.ok(report.current.orders.length>0);
  assert.ok(report.points.every(point => typeof point.city==='string' && point.city.length>0));
});

test('daily series groups paid orders once and keeps refunds, gaps, previous days', () => {
  const source=fs.readFileSync(path.join(__dirname,'weekly-report.js'),'utf8');
  const body=source.split('function buildDaily(current, previous, period) {')[1].split('function buildOperations(period) {')[0];
  assert.match(body,/const groupDays = \(orders\) =>/);
  assert.doesNotMatch(body,/paidOrders\.filter\(/);
  assert.equal(body.match(/groupDays\((?:current|previous)\.paidOrders\)/g)?.length,2);
  const report=collectWeeklyReport(now);
  assert.equal(report.daily.length,7);
  assert.deepEqual(report.daily.find(d=>d.date==='2026-11-03'),{
    date:'2026-11-03',revenue:300,orders_count:1,
    previous_revenue:0,previous_orders_count:0,
  });
  assert.deepEqual(report.daily.find(d=>d.date==='2026-11-05'),{
    date:'2026-11-05',revenue:0,orders_count:1,
    previous_revenue:200,previous_orders_count:1,
  });
  assert.deepEqual(report.daily.find(d=>d.date==='2026-11-07'),{
    date:'2026-11-07',revenue:0,orders_count:0,
    previous_revenue:150,previous_orders_count:1,
  });
});

test('point summary remains batch-based when the number of points grows', () => {
  const source=fs.readFileSync(path.join(__dirname,'weekly-report.js'),'utf8');
  const section=source.split('function buildPoints(current, previous) {')[1]
    .split('function buildProducts(')[0];
  assert.match(section,/GROUP BY s\.point_id/,'one grouped SQLite read for every point');
  assert.match(section,/new Map\(stockRows\.map/);
  assert.doesNotMatch(section,/\.get\(point\.id\)/,'no SQLite query for each point');
  assert.doesNotMatch(section,/current\.paidOrders\.filter\(/,'no full-order scan per point');
});

test('founder dashboard and weekly reports use the shared lightweight BSC dataset', () => {
  const weekly=fs.readFileSync(path.join(__dirname,'weekly-report.js'),'utf8');
  const founderRoute=fs.readFileSync(path.join(__dirname,'routes-business-founders.js'),'utf8');
  assert.match(weekly,/function collectWeeklyBscReport\(/);
  assert.match(weekly,/function getCachedWeeklyBsc\(/);
  assert.match(founderRoute,/const report=getCachedWeeklyBsc\(\)/);
  assert.doesNotMatch(founderRoute,/calculateBsc\(report\)/,'must not rescore an already scored BSC');
});


test('scored BSC is shared within TTL and invalidates after a stock change', () => {
  const first = getCachedWeeklyBsc(now);
  const second = getCachedWeeklyBsc(now);
  assert.strictEqual(first, second, 'admin and founders must share one scored BSC');
  assert.equal(JSON.stringify(first).includes('79998887766'), false,
    'cached BSC must not contain customer phone numbers');
  const before = first.bsc.points.find(p=>p.id==='report-fast-0').stock_alerts;
  db.prepare('UPDATE stock SET qty = 7 WHERE point_id=? AND variant_id=?')
    .run('report-fast-0', variant);
  const after = getCachedWeeklyBsc(now);
  assert.notStrictEqual(first, after, 'revenue/stock/settings writes invalidate immediately');
  assert.notEqual(after.bsc.points.find(p=>p.id==='report-fast-0').stock_alerts, before);
  assert.strictEqual(getCachedWeeklyBsc(now), after, 'unchanged revision reuses the result');
});

test('SQL phone keys match legacy formatted customer numbers and preserve returning-customer counts', () => {
  order('RPT-PHONE-OLD','report-fast-7','2026-10-20 10:00:00',90,
    'paid',0,'+7 (999) 123-45-67');
  order('RPT-PHONE-RETURN','report-fast-7','2026-11-04 10:00:00',130,
    'paid',0,'8 999 123 45 67');
  order('RPT-PHONE-NEW','report-fast-7','2026-11-05 10:00:00',170,
    'paid',0,'+7-999-000-11-22');
  order('RPT-PHONE-NBSP-OLD','report-fast-7','2026-10-22 10:00:00',110,
    'paid',0,'+7\u202F(999)\u202F456\u201178\u201190');
  order('RPT-PHONE-NBSP-RETURN','report-fast-7','2026-11-04 14:00:00',200,
    'paid',0,'8 999 456 78 90');
  const report=collectWeeklyBscReport(now);
  const legacyRows=db.prepare(
    "SELECT customer_phone, MIN(created_at) AS first_paid_at FROM orders WHERE status='paid' GROUP BY customer_phone"
  ).all();
  const normalize = value => String(value || '').replace(/\D/g,'').slice(-10);
  const earliest=new Map();
  for (const row of legacyRows) {
    const key=normalize(row.customer_phone);
    if(!key) continue;
    if(!earliest.has(key) || row.first_paid_at<earliest.get(key)) earliest.set(key,row.first_paid_at);
  }
  const weekly=new Map();
  for (const row of report.current.paidOrders) {
    const key=normalize(row.customer_phone);
    if(key) weekly.set(key,(weekly.get(key)||0)+1);
  }
  const newBuyers=[...weekly.keys()].filter(key=>
    earliest.get(key)>=report.period.start_utc && earliest.get(key)<report.period.end_utc_exclusive
  ).length;
  assert.equal(report.customers.unique,weekly.size);
  assert.equal(report.customers.new_customers,newBuyers);
  assert.equal(report.customers.returning_customers,weekly.size-newBuyers);
  const key=db.prepare('SELECT ' + PAID_PHONE_KEY_SQL + ' AS k FROM orders WHERE order_code=?')
    .get('RPT-PHONE-RETURN').k;
  assert.equal(key,'9991234567');
  const index=db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get('idx_orders_paid_phone_key_created');
  assert.equal(index?.name,'idx_orders_paid_phone_key_created');
});

test('business founder monthly sales are grouped in SQL without six full order loads', () => {
  const founderRoute=fs.readFileSync(path.join(__dirname,'routes-business-founders.js'),'utf8');
  const month=founderRoute.split('function monthHistory(now) {')[1]
    .split('function pointRanking(start) {')[0];
  assert.match(month,/GROUP BY month/);
  assert.doesNotMatch(month,/ordersInRange\(/);
  assert.match(month,/strftime\('%Y-%m', created_at, '\+7 hours'\)/);
});
