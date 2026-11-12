'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-report-query-efficiency-'));
const db = require('./db');
const { collectWeeklyReport, collectWeeklyBscReport } = require('./weekly-report');

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

test('point summary remains batch-based when the number of points grows', () => {
  const source=fs.readFileSync(path.join(__dirname,'weekly-report.js'),'utf8');
  const section=source.split('function buildPoints(current, previous) {')[1]
    .split('function buildProducts(')[0];
  assert.match(section,/GROUP BY s\.point_id/,'one grouped SQLite read for every point');
  assert.match(section,/new Map\(stockRows\.map/);
  assert.doesNotMatch(section,/\.get\(point\.id\)/,'no SQLite query for each point');
  assert.doesNotMatch(section,/current\.paidOrders\.filter\(/,'no full-order scan per point');
});

test('BSC/admin and founder routes request the lightweight weekly dataset', () => {
  const bscRoute=fs.readFileSync(path.join(__dirname,'routes-bsc.js'),'utf8');
  const founderRoute=fs.readFileSync(path.join(__dirname,'routes-business-founders.js'),'utf8');
  assert.match(bscRoute,/const bsc = collectWeeklyBscReport\(\)\.bsc/);
  assert.doesNotMatch(bscRoute,/calculateBsc\(report\)/,'must not rescore an already scored BSC');
  assert.match(founderRoute,/const report=collectWeeklyBscReport\(\)/);
});
