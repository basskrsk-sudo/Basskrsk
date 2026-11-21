'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {periodBounds,buildFinanceSummary,buildPayoutSnapshot}=require('./finance-compact');
const {queryExpenses,validPage}=require('./routes-finance-compact');
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE points(id TEXT PRIMARY KEY,name TEXT,active INTEGER,is_hub INTEGER,manager_id INTEGER);'+
    'CREATE TABLE orders(id INTEGER PRIMARY KEY,point_id TEXT,status TEXT,'+
    'created_at TEXT,total INTEGER,refund_status TEXT,refunded_amount INTEGER,'+
    'partner_id INTEGER,commission_rate REAL);'+
    'CREATE TABLE expenses(id INTEGER PRIMARY KEY,expense_date TEXT,amount INTEGER,'+
    'category TEXT,investor_name TEXT,note TEXT,city_id TEXT);'+
    'CREATE TABLE partners(id INTEGER PRIMARY KEY,commission_rate REAL);'+
    'CREATE TABLE salon_owners(id INTEGER PRIMARY KEY,point_id TEXT,commission_rate REAL,active INTEGER);'+
    'CREATE TABLE manager_points(id INTEGER PRIMARY KEY,point_id TEXT,manager_id INTEGER,commission_rate REAL,active INTEGER);'+
    'CREATE TABLE partner_payout_items(id INTEGER PRIMARY KEY,order_id INTEGER);'+
    'CREATE TABLE owner_payout_items(id INTEGER PRIMARY KEY,order_id INTEGER);'+
    'CREATE TABLE manager_commission_payout_items(id INTEGER PRIMARY KEY,order_id INTEGER);'+
    'CREATE TABLE partner_payouts(amount INTEGER);'+
    'CREATE TABLE owner_payouts(amount INTEGER);'+
    'CREATE TABLE manager_commission_payouts(amount INTEGER);'+
    "INSERT INTO points VALUES('a','Салон А',1,0,2),('b','Салон Б',1,0,NULL),"+
      "('old','Архив',0,0,NULL),('hub','Склад',1,1,NULL);"+
    'INSERT INTO partners VALUES(1,0.2);'+
    "INSERT INTO salon_owners VALUES(1,'a',0.05,1);"+
    "INSERT INTO manager_points VALUES(1,'a',2,0.07,1);"+
    'INSERT INTO orders VALUES '+
      "(1,'a','paid','2026-11-02 12:00:00',250,'none',0,1,0.2),"+
      "(2,'a','paid','2026-11-07 12:00:00',360,'none',0,1,0.15),"+
      "(3,'b','failed','2026-11-09 11:00:00',300,'none',0,NULL,0),"+
      "(4,'a','paid','2026-11-20 23:30:00',100,'refunded',100,1,0.15),"+
      "(5,'old','paid','2026-11-10 12:00:00',100,'none',0,NULL,0),"+
      "(6,'a','paid','2026-10-01 12:00:00',500,'none',0,1,0.2),"+
      "(7,'b','paid','2026-11-14 12:00:00',500,'partial',100,NULL,0);"+
    "INSERT INTO expenses VALUES(1,'2026-11-03',100,'Упаковка','Лакомых Алексей','Первая закупка','krsk'),"+
      "(2,'2026-11-21',20,'Транспорт','Лакомых Алексей',NULL,'krsk'),"+
      "(3,'2026-10-01',999,'Оборудование','Соколов Виталий',NULL,'krsk');"+
    'INSERT INTO partner_payouts VALUES(50);'+
    'INSERT INTO owner_payouts VALUES(30);'+
    'INSERT INTO manager_commission_payouts VALUES(20);'
  );
  return db;
}
const NOW=new Date('2026-11-21T09:00:00Z');
test('month and rolling 30-day ranges use local Krasnoyarsk date boundaries',()=>{
  const month=periodBounds('month',new Date('2026-11-20T18:00:00Z'));
  assert.equal(month.from,'2026-10-31 17:00:00');
  assert.equal(month.to_exclusive,'2026-11-30 17:00:00');
  assert.equal(month.from_day,'2026-11-01');
  assert.equal(month.next_day,'2026-12-01');
  const rolling=periodBounds('30d',NOW);
  assert.equal(rolling.to_day,'2026-11-21');
  assert.equal(rolling.from_day,'2026-10-23');
  assert.throws(()=>periodBounds('year',NOW),RangeError);
});
test('summary subtracts refunds and excludes failed orders without dropping archived revenue',()=>{
 const db=fixture();
 try{
  const result=buildFinanceSummary(db,{now:NOW});
  assert.equal(result.revenue,1110);
  assert.equal(result.expenses,120);
  assert.equal(result.sales_less_recorded_spending,990);
  assert.equal(result.orders_count,4);
  assert.deepEqual(result.point_rows.map(x=>[x.point_id,x.revenue,x.orders_count]),
    [['a',610,2],['b',400,1]]);
  assert.equal(result.active_points,2);
  assert.match(result.disclaimer,/не является чистой прибылью|Не является чистой прибылью/);
 }finally{db.close();}
});
test('payouts are only provisional; paid payouts remain separated and refunded orders held',()=>{
 const db=fixture();
 try {
   const s=buildPayoutSnapshot(db);
   assert.equal(s.roles.partner.pending,204);
   assert.equal(s.roles.partner.refund_review,15);
   assert.equal(s.roles.owner.pending,13+18+25);
   assert.equal(s.roles.manager.pending,18+25);
   assert.equal(s.paid_total,100);
   assert.equal(s.pending_total,s.roles.partner.pending+s.roles.owner.pending+s.roles.manager.pending);
   assert.match(s.disclaimer,/Предварительный ориентир/);
 }finally{db.close();}
});
test('expenses query returns only 20 small rows and filters by exact investor',()=>{
 const db=fixture();
 try{
   let r=queryExpenses(db,{now:NOW});
   assert.equal(r.total_count,2);
   assert.equal(r.total_amount,120);
   assert.equal(r.expenses.length,2);
   assert.equal(r.expenses[0].amount,20);
   assert.ok(!Object.hasOwn(r.expenses[0],'documents'));
   r=queryExpenses(db,{now:NOW,investor:'Соколов Виталий'});
   assert.equal(r.total_count,0);
   assert.equal(r.total_amount,0);
   r=queryExpenses(db,{now:NOW,page:2});
   assert.equal(r.expenses.length,0);
   assert.throws(()=>queryExpenses(db,{now:NOW,page:0}),RangeError);
   assert.throws(()=>validPage({page:'1.4'}),RangeError);
 }finally{db.close();}
});
test('finance endpoint requires active admin and never exposes public financial data',()=>{
 const code=fs.readFileSync(path.join(__dirname,'routes-finance-compact.js'),'utf8');
 assert.equal((code.match(/requireActiveAdmin\(req,res,ctx\)/g)||[]).length,3);
 assert.doesNotMatch(code,/POST.*finance|INSERT INTO|UPDATE expenses|DELETE FROM/);
});
