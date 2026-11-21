'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {isFinancePeriod,periodBounds,buildFinanceSummary,buildPayoutSnapshot,queryExpenses}=require('./finance-compact');
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
      "(7,'b','paid','2026-11-14 12:00:00',500,'refunded',100,NULL,0);"+
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
  assert.equal(month.to_exclusive,'2026-11-21 17:00:00');
  assert.equal(month.from_day,'2026-11-01');
  assert.equal(month.next_day,'2026-11-22');
  const rolling=periodBounds('30d',NOW);
  assert.equal(rolling.to_day,'2026-11-21');
  assert.equal(rolling.from_day,'2026-10-23');
  assert.equal(isFinancePeriod('2026',NOW),true);
  assert.equal(isFinancePeriod('2025',NOW),false);
  assert.equal(isFinancePeriod('2027',NOW),false);
  assert.equal(isFinancePeriod('all',NOW),true);
  assert.throws(()=>periodBounds('year',NOW),RangeError);
  assert.throws(()=>periodBounds('2027',NOW),RangeError);
  const currentYear=periodBounds('2026',NOW);
  assert.equal(currentYear.from,'2025-12-31 17:00:00');
  assert.equal(currentYear.from_day,'2026-01-01');
  assert.equal(currentYear.to_exclusive,'2026-11-21 17:00:00');
  assert.equal(currentYear.to_day,'2026-11-21');
  const historicalYear=periodBounds('2026',new Date('2027-03-14T11:00:00Z'));
  assert.equal(historicalYear.from_day,'2026-01-01');
  assert.equal(historicalYear.next_day,'2027-01-01');
  assert.equal(historicalYear.to_day,'2026-12-31');
  const followingYear=periodBounds('2027',new Date('2027-03-14T11:00:00Z'));
  assert.equal(followingYear.from_day,'2027-01-01');
  assert.equal(followingYear.to_day,'2027-03-14');
  const all=periodBounds('all',NOW);
  assert.equal(all.from,null);
  assert.equal(all.from_day,null);
  assert.equal(all.to_day,'2026-11-21');
});
test('calendar 2026 differs from rolling 12 months and all-time',()=>{
 const db=fixture();
 try{
  db.exec(
    "INSERT INTO orders VALUES"+
    "(8,'b','paid','2025-12-31 16:59:59',250,'none',0,NULL,0),"+
    "(9,'b','paid','2025-12-31 17:00:00',90,'none',0,NULL,0),"+
    "(10,'b','paid','2027-01-01 00:00:00',100,'none',0,NULL,0),"+
    "(11,'b','paid','2026-12-31 16:59:59',30,'none',0,NULL,0);"+
    "INSERT INTO expenses VALUES"+
    "(4,'2025-12-31',40,'Транспорт','Соколов Виталий',NULL,'krsk'),"+
    "(5,'2026-01-01',30,'Транспорт','Соколов Виталий',NULL,'krsk'),"+
    "(6,'2027-01-01',70,'Транспорт','Соколов Виталий',NULL,'krsk');"
  );
  const current=buildFinanceSummary(db,{period:'2026',now:NOW});
  const all=buildFinanceSummary(db,{period:'all',now:NOW});
  assert.equal(current.revenue,1700,'2026 begins at Jan 1, excludes 2025 sales');
  assert.equal(current.orders_count,6);
  assert.equal(current.expenses,1149);
  assert.equal(all.revenue,1950,'all-time includes December 2025');
  assert.equal(all.expenses,1189);
  assert.equal(buildFinanceSummary(db,{period:'month',now:NOW}).revenue,1110);
  const yearExpenses=queryExpenses(db,{period:'2026',now:NOW,investor:'Соколов Виталий'});
  assert.equal(yearExpenses.total_count,2);
  assert.equal(yearExpenses.total_amount,1029);
  const allExpenses=queryExpenses(db,{period:'all',now:NOW,investor:'Соколов Виталий'});
  assert.equal(allExpenses.total_count,3);
  assert.equal(allExpenses.total_amount,1069);
  const nextYear=new Date('2027-03-14T11:00:00Z');
  const past=buildFinanceSummary(db,{period:'2026',now:nextYear});
  const future=buildFinanceSummary(db,{period:'2027',now:nextYear});
  assert.equal(past.revenue,1730,'completed 2026 includes Dec 31 2026');
  assert.equal(future.revenue,100,'2027 excludes all 2026 revenue');
  assert.equal(queryExpenses(db,{period:'2027',now:nextYear}).total_amount,70);
 }finally{db.close();}
});
test('2028 leap day belongs only to calendar 2028',()=>{
 const b=periodBounds('2028',new Date('2029-03-01T12:00:00Z'));
 assert.equal(b.from_day,'2028-01-01');
 assert.equal(b.to_day,'2028-12-31');
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
test('legacy full-refund record with missing amount remains zero revenue',()=>{
 const db=fixture();
 try{
  db.exec("UPDATE orders SET refunded_amount=NULL WHERE id=4");
  assert.equal(buildFinanceSummary(db,{now:NOW}).revenue,1110);
 }finally{db.close();}
});
test('payouts are only provisional; paid payouts remain separated and refunded orders held',()=>{
 const db=fixture();
 try {
   const s=buildPayoutSnapshot(db);
   assert.equal(s.roles.partner.pending,204);
   assert.equal(s.roles.partner.refund_review,15);
   assert.equal(s.roles.owner.pending,13+18+25);
   assert.equal(s.roles.manager.pending,18+25+35);
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
 }finally{db.close();}
});
test('finance endpoint requires active admin and never exposes public financial data',()=>{
 const code=fs.readFileSync(path.join(__dirname,'routes-finance-compact.js'),'utf8');
 assert.equal((code.match(/requireActiveAdmin\(req,res,ctx\)/g)||[]).length,3);
 assert.doesNotMatch(code,/POST.*finance|INSERT INTO|UPDATE expenses|DELETE FROM/);
});
