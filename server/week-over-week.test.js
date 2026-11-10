'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hm-week-over-week-'));
process.env.TOKEN_SECRET='week-over-week-unit-test-key';
const db=require('./db');
const {Router}=require('./http-utils');
const {signToken}=require('./auth');
const {registerWeeklyReportRoutes}=require('./routes-weekly-reports');
const {readComparison,weekForOffset,percentChange,customComparisonPeriod}=require('./week-over-week');
const NOW=new Date('2026-11-08T00:00:00.000Z');
const period=weekForOffset(0,NOW);

db.prepare("INSERT OR IGNORE INTO cities(id,name,active) VALUES('krsk','Красноярск',1)").run();
db.prepare("INSERT OR IGNORE INTO cities(id,name,active) VALUES('spb','Санкт-Петербург',1)").run();
db.prepare("INSERT INTO points(id,name,addr,icon,city_id,active) VALUES(?,?,?,?,?,1)")
  .run('w-comp-a','Точка А','Красноярск','🏪','krsk');
db.prepare("INSERT INTO points(id,name,addr,icon,city_id,active) VALUES(?,?,?,?,?,1)")
  .run('w-comp-b','Точка Б','Красноярск','🏪','krsk');
db.prepare("INSERT INTO points(id,name,addr,icon,city_id,active) VALUES(?,?,?,?,?,1)")
  .run('w-comp-c','Точка в СПБ','Санкт-Петербург','🏪','spb');

function order(code,utc,amount,status='paid',point='w-comp-a',refunded=0,phone='79131234567'){
  return Number(db.prepare(
    'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,'+
    'subtotal,total,payment_method,status,refunded_amount,created_at,commission_rate) '+
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code,'Покупатель',phone,point,point,amount,amount,'sbp',status,refunded,utc,0.1).lastInsertRowid);
}
function item(orderId,name,price,qty=1){
  db.prepare('INSERT INTO order_items(order_id,name,weight,price,qty) VALUES(?,?,?,?,?)')
    .run(orderId,name,'50 г',price,qty);
}
const older=order('W-OLDER','2026-10-22 05:00:00',300);
item(older,'Лёгкое говяжье',300);
const newer=order('W-NEWER','2026-10-29 05:00:00',500,'paid','w-comp-a',100);
item(newer,'Лёгкое говяжье',500);
const second=order('W-SECOND','2026-10-30 05:00:00',200,'paid','w-comp-b',0,'79131112233');
item(second,'Сердце говяжье',200);
const pending=order('W-PENDING','2026-10-31 05:00:00',1000,'pending');
item(pending,'Неоплаченный товар',1000);
const cityOther=order('W-OTHER-CITY','2026-10-29 05:00:00',900,'paid','w-comp-c');
item(cityOther,'Товар из другого города',900);
db.prepare("INSERT INTO expenses(expense_date,category,amount,city_id,investor_name) VALUES(?,?,?,?,?)")
  .run('2026-10-23','Закуп товара',100,'krsk','Соколов Виталий');
db.prepare("INSERT INTO expenses(expense_date,category,amount,city_id,investor_name) VALUES(?,?,?,?,?)")
  .run('2026-10-29','Закуп товара',175,'krsk','Соколов Виталий');
db.prepare("INSERT INTO expenses(expense_date,category,amount,city_id,investor_name) VALUES(?,?,?,?,?)")
  .run('2026-10-29','Реклама',75,'spb','Лакомых Алексей');

test('week spans full Monday-Sunday local Krasnoyarsk periods',()=>{
  assert.deepEqual(
    [period.start_local,period.end_local,period.previous_start_local,period.previous_end_local],
    ['2026-10-26','2026-11-01','2026-10-19','2026-10-25']);
  assert.equal(period.start_utc,'2026-10-25 17:00:00');
  assert.equal(period.previous_start_utc,'2026-10-18 17:00:00');
  const week=weekForOffset(1,NOW);
  assert.equal(week.start_local,'2026-10-19');
  assert.equal(week.end_local,'2026-10-25');
  assert.throws(()=>weekForOffset(-1),RangeError);
  assert.throws(()=>weekForOffset(53),RangeError);
  assert.equal(percentChange(10,0),null);
  assert.equal(percentChange(0,0),0);
  assert.equal(percentChange(15,10),50);
  assert.equal(percentChange(5,10),-50);
});

test('net weekly sales, refunds, expenses and per-point reports use paid orders',()=>{
  const report=readComparison({now:NOW,city:'krsk'});
  assert.deepEqual([report.current.revenue,report.previous.revenue],[600,300]);
  assert.deepEqual([report.current.paid_orders,report.previous.paid_orders],[2,1]);
  assert.equal(report.current.created_orders,3);
  assert.equal(report.current.avg_check,300);
  assert.equal(report.current.refunds,100);
  assert.equal(report.current.customers,2);
  assert.equal(report.current.points_with_sales,2);
  assert.equal(report.current.expenses,175);
  assert.equal(report.previous.expenses,100);
  assert.equal(report.current.estimated_profit,600-(175+60+36+12));
  assert.equal(report.changes.revenue.percent,100);
  assert.equal(report.changes.paid_orders.percent,100);
  assert.equal(report.changes.avg_check.percent,0);
  assert.equal(report.changes.expenses.delta,75);
  assert.equal(report.points_total,2);
  const a=report.points.find(p=>p.id==='w-comp-a');
  const b=report.points.find(p=>p.id==='w-comp-b');
  assert.deepEqual([a.current,a.previous,a.current_orders],[400,300,1]);
  assert.deepEqual([b.current,b.previous,b.percent],[200,0,null]);
  assert.equal(report.daily.length,7);
  assert.equal(report.daily.reduce((sum,d)=>sum+d.current,0),600);
  assert.equal(report.daily.reduce((sum,d)=>sum+d.previous,0),300);
  assert.deepEqual(report.expense_categories.map(row=>row.name),['Закуп товара']);
  assert.ok(!report.products.some(p=>p.name==='Неоплаченный товар'));
  assert.ok(!report.products.some(p=>p.name==='Товар из другого города'));
  assert.equal(report.products.find(p=>p.name==='Сердце говяжье').current_units,1);
  assert.equal(report.products.find(p=>p.name==='Лёгкое говяжье').previous_units,1);
  assert.ok(report.calculation_note.includes('управленческая'));
});

test('network view includes all cities, historical week returns older data',()=>{
  const all=readComparison({now:NOW});
  assert.equal(all.current.revenue,1500);
  assert.equal(all.current.paid_orders,3);
  assert.equal(all.current.expenses,250);
  assert.equal(all.points_total,3);
  const olderWeek=readComparison({now:NOW,offset:1,city:'krsk'});
  assert.equal(olderWeek.current.revenue,300);
  assert.equal(olderWeek.previous.revenue,0);
  assert.equal(olderWeek.changes.revenue.percent,null);
  assert.equal(olderWeek.daily.length,7);
  assert.throws(()=>readComparison({now:NOW,city:'not-found'}),RangeError);
});

test('date correction updates the selected week without modifying other expense fields',()=>{
  const before=readComparison({now:NOW,city:'krsk'});
  const original=db.prepare("SELECT id,amount,investor_name FROM expenses WHERE expense_date='2026-10-29' AND city_id='krsk'").get();
  db.prepare('UPDATE expenses SET expense_date=? WHERE id=?').run('2026-10-23',original.id);
  const after=readComparison({now:NOW,city:'krsk'});
  assert.equal(after.current.expenses,before.current.expenses-175);
  assert.equal(after.previous.expenses,before.previous.expenses+175);
  const row=db.prepare('SELECT amount,investor_name FROM expenses WHERE id=?').get(original.id);
  assert.equal(row.amount,original.amount);
  assert.equal(row.investor_name,original.investor_name);
  db.prepare('UPDATE expenses SET expense_date=? WHERE id=?').run('2026-10-29',original.id);
});

test('HTTP route is strictly admin-only, rejects malicious filters and never mutates data',()=>{
  db.prepare("INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)")
    .run(99100,'w-comp-admin','ignored','admin',1);
  db.prepare("INSERT INTO admins(id,login,password_hash,role,active) VALUES(?,?,?,?,?)")
    .run(99101,'w-comp-disabled','ignored','admin',0);
  const router=new Router();
  registerWeeklyReportRoutes(router);
  function run(query,role,id){
    const match=router.match('GET','/api/weekly-reports/comparison');
    assert.ok(match);
    const token=role ? signToken({role,id}) : '';
    const req={headers:token?{authorization:'Bearer '+token}:{}};
    const res={
      status:0,data:null,headers:{},
      setHeader(k,v){this.headers[k]=v;},
      writeHead(code,h){this.status=code;Object.assign(this.headers,h||{});return this;},
      end(raw){this.data=JSON.parse(raw);}
    };
    match.handler(req,res,{params:match.params,query});
    return res;
  }
  assert.equal(run({},null).status,401);
  assert.equal(run({},'manager',99100).status,401);
  assert.equal(run({},'admin',99101).status,401);
  assert.equal(run({offset:'53'},'admin',99100).status,400);
  assert.equal(run({offset:'0;DROP TABLE orders'},'admin',99100).status,400);
  assert.equal(run({city:'krsk%27--'},'admin',99100).status,400);
  assert.equal(run({city:'unknown'},'admin',99100).status,400);
  const before=db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const ok=run({city:'krsk'},'admin',99100);
  assert.equal(ok.status,200,JSON.stringify(ok.data));
  assert.equal(ok.data.city,'krsk');
  assert.equal(ok.headers['Cache-Control'],'private, no-store');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,before);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_created_at_weekly'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_expenses_date_city_weekly'").get());
});

test('admin week comparison tab is reachable and rendered through separate script',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
  const js=fs.readFileSync(path.join(__dirname,'../public/week-over-week.js'),'utf8');
  assert.match(html,/id="sec-week-comparison"/);
  const reports=fs.readFileSync(path.join(__dirname,'../public/admin-report-center.js'),'utf8');
   const navigation=fs.readFileSync(path.join(__dirname,'../public/admin-navigation.js'),'utf8');
   assert.match(reports,/type:'weekcompare'/);
   assert.match(reports,/target:'week-comparison'/);
  assert.match(navigation,/id === 'week-comparison'\) await renderWeekComparison/);
  assert.match(html,/<script src="\/week-over-week.js"><\/script>/);
  assert.match(js,/authFetch\('\/api\/weekly-reports\/comparison/);
  assert.match(js,/function renderWeekComparison\(\)/);
  assert.match(js,/function changeWeekComparison\(delta\)/);
  assert.doesNotThrow(()=>new Function(js));
});


test('custom comparison accepts independent ranges and normalizes unequal periods',()=>{
  const custom={
    current_start:'2026-10-29',current_end:'2026-10-30',
    previous_start:'2026-10-22',previous_end:'2026-10-22',
  };
  const period=customComparisonPeriod(custom,NOW);
  assert.equal(period.start_utc,'2026-10-28 17:00:00');
  assert.equal(period.end_utc_exclusive,'2026-10-30 17:00:00');
  assert.deepEqual([period.current_days,period.previous_days],[2,1]);
  assert.equal(period.equal_length,false);
  assert.equal(period.mode,'custom');

  const result=readComparison({now:NOW,custom,city:'krsk'});
  assert.deepEqual([result.current.revenue,result.previous.revenue],[600,300]);
  assert.deepEqual([result.current.paid_orders,result.previous.paid_orders],[2,1]);
  assert.deepEqual([result.current.avg_daily_revenue,result.previous.avg_daily_revenue],[300,300]);
  assert.deepEqual([result.current.avg_daily_orders,result.previous.avg_daily_orders],[1,1]);
  assert.equal(result.changes.avg_daily_revenue.percent,0);
  assert.equal(result.current.expenses,175);
  assert.equal(result.previous.expenses,0,'expense on Oct 23 must not leak into Oct 22');
  assert.equal(result.daily.length,2);
  assert.deepEqual(result.daily.map(d=>d.date),['2026-10-29','2026-10-30']);
  assert.deepEqual(result.daily.map(d=>d.previous_date),['2026-10-22',null]);
  assert.equal(result.daily[1].previous,null);
  assert.equal(result.daily[1].previous_orders,null);
  assert.equal(result.daily.reduce((sum,d)=>sum+Number(d.current||0),0),600);
  assert.equal(result.daily.reduce((sum,d)=>sum+Number(d.previous||0),0),300);
  assert.match(result.calculation_note,/Периоды разной длины/);
  assert.equal(result.products.find(p=>p.name==='Лёгкое говяжье').previous_units,1);
  assert.equal(result.products.find(p=>p.name==='Сердце говяжье').current_units,1);
});

test('date windows include the last day and exclude adjacent dates',()=>{
  const report=readComparison({now:NOW,city:'krsk',custom:{
    current_start:'2026-10-29',current_end:'2026-10-30',
    previous_start:'2026-10-22',previous_end:'2026-10-23',
  }});
  assert.equal(report.previous.expenses,100,'October 23 is included in the baseline');
  assert.equal(report.current.expenses,175);
  assert.equal(report.period.equal_length,true);
  assert.deepEqual(report.daily.map(r=>r.previous_date),['2026-10-22','2026-10-23']);
});

test('a distant custom comparison uses only the two selected windows, not dates between them',()=>{
  const custom={
    current_start:'2026-10-30',current_end:'2026-10-30',
    previous_start:'2026-10-22',previous_end:'2026-10-22',
  };
  const result=readComparison({now:NOW,custom,city:'krsk'});
  assert.deepEqual([result.current.revenue,result.previous.revenue],[200,300]);
  assert.deepEqual([result.current.paid_orders,result.previous.paid_orders],[1,1]);
  assert.equal(result.current.expenses,0);
  assert.equal(result.previous.expenses,0,'baseline includes only Oct 22, not Oct 23');
  assert.equal(result.daily.length,1);
  assert.equal(result.period.equal_length,true);
  assert.doesNotMatch(result.calculation_note,/Периоды разной длины/);
});

test('custom comparison date validation rejects malformed, impossible, future, overlapping and long ranges',()=>{
  const good={
    current_start:'2026-10-29',current_end:'2026-10-30',
    previous_start:'2026-10-22',previous_end:'2026-10-22',
  };
  const bad=[
    [{current_start:''},/дату начала/],
    [{current_start:'2026-02-30'},/Некорректная календарная дата/],
    [{current_end:'2026-10-28'},/окончания/],
    [{previous_end:'2026-10-24',previous_start:'2026-10-25'},/окончания/],
    [{previous_end:'2026-10-29'},/пересечения/],
    [{current_start:'2026-09-01',current_end:'2026-10-02'},/31 дня/],
    [{current_end:'2999-01-01'},/2020–2100/],
    [{current_start:'2026-11-08',current_end:'2026-11-09'},/будущие даты/],
    [{previous_start:'2019-01-01'},/2020–2100/],
  ];
  for(const [patch,expected] of bad){
    assert.throws(()=>customComparisonPeriod({...good,...patch},NOW),expected,JSON.stringify(patch));
  }
});

test('custom date API enforces complete fields and accepts dates without mutating data',()=>{
  const {Router}=require('./http-utils');
  const {signToken}=require('./auth');
  const {registerWeeklyReportRoutes}=require('./routes-weekly-reports');
  const router=new Router();
  registerWeeklyReportRoutes(router);
  const query={
    city:'krsk',
    current_start:'2026-10-29',current_end:'2026-10-30',
    previous_start:'2026-10-22',previous_end:'2026-10-22',
  };
  function request(params){
    const match=router.match('GET','/api/weekly-reports/comparison');
    const req={headers:{authorization:'Bearer '+signToken({id:99100,role:'admin'})}};
    const res={status:0,data:null,headers:{},
      setHeader(k,v){this.headers[k]=v;},
      writeHead(code,headers){this.status=code;Object.assign(this.headers,headers||{});return this;},
      end(raw){this.data=JSON.parse(raw);},
    };
    match.handler(req,res,{params:match.params,query:params});
    return res;
  }
  assert.equal(request({current_start:query.current_start}).status,400);
  assert.equal(request({...query,previous_end:'2026-10-29'}).status,400);
  assert.equal(request({...query,current_end:'2099-01-01'}).status,400);
  const before=db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
  const result=request(query);
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.period.mode,'custom');
  assert.equal(result.data.period.current_days,2);
  assert.equal(result.data.period.previous_days,1);
  assert.equal(result.data.offset,null);
  assert.equal(result.data.current.revenue,600);
  assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,before);
});

test('admin UI contains both range selectors and date controls validate correctly on mobile',()=>{
  const vm=require('node:vm');
  const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
  const js=fs.readFileSync(path.join(__dirname,'../public/week-over-week.js'),'utf8');
  for(const id of ['wc-current-start','wc-current-end','wc-previous-start','wc-previous-end',
    'wc-length-warning','wc-earlier']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/onclick="applyWeekComparisonDates\(\)"/);
  assert.match(html,/onclick="resetWeekComparisonDates\(\)"/);
  assert.match(js,/params\.set\(key,value\)/);
  assert.match(js,/avg_daily_revenue/);
  assert.match(js,/wcValidateDates/);
  assert.doesNotThrow(()=>new Function(js));
  const context=vm.createContext({});
  vm.runInContext(js,context);
  const valid=vm.runInContext(
    "wcValidateDates({current_start:'2026-10-29',current_end:'2026-10-30',"+
    "previous_start:'2026-10-22',previous_end:'2026-10-22'})",context);
  assert.equal(valid.current_days,2);
  assert.equal(valid.previous_days,1);
  assert.throws(()=>vm.runInContext(
    "wcValidateDates({current_start:'2026-10-29',current_end:'2026-10-30',"+
    "previous_start:'2026-10-29',previous_end:'2026-10-29'})",context),/пересечение/);
});
