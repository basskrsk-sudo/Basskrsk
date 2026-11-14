'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'hm-econ-stream-'));
process.env.DATA_DIR=work;
process.env.TOKEN_SECRET='economics-dashboard-test-key';
const db=require('./db');
const {Router}=require('./http-utils');
const {signToken}=require('./auth');
const {buildEconomicsDashboard}=require('./economics-dashboard');
const {registerEconomicsRoutes}=require('./routes-economics');
const {snapshotOperations}=require('./runtime-diagnostics');
const ci1='econ-ci-1',ci2='econ-ci-2',pt1='econ-pt-1',pt2='econ-pt-2';
for(const [id,name] of [[ci1,'Город А'],[ci2,'Город Б']])
  db.prepare('INSERT INTO cities(id,name,active) VALUES(?,?,1)').run(id,name);
for(const [id,city] of [[pt1,ci1],[pt2,ci2]])
  db.prepare('INSERT INTO points(id,name,addr,icon,city_id,active) VALUES(?,?,?,?,?,1)')
    .run(id,'Точка '+id,'Адрес','🐾',city);
const mgrId=Number(db.prepare(
  'INSERT INTO managers(mgr_code,login,password_hash,full_name,phone) VALUES(?,?,?,?,?)'
).run('ECON-TEST-MGR','econ-test-manager','hash','Менеджер тест','79990000001').lastInsertRowid);
const managerPoint=db.prepare(
  'INSERT INTO manager_points(manager_id,point_id,point_name,point_type,commission_rate,active) VALUES(?,?,?,?,?,?)'
);
managerPoint.run(mgrId,pt1,'Точка 1','Груминг',0.07,1);
managerPoint.run(mgrId,pt1,'Точка 1','Груминг',0.11,0);
managerPoint.run(mgrId,pt2,'Точка 2','Груминг',0.09,1);
const owner=db.prepare(
  'INSERT INTO salon_owners(login,password_hash,full_name,phone,point_id,commission_rate,active) VALUES(?,?,?,?,?,?,?)'
);
owner.run('econ-owner-1','hash','Владелец 1','79990000002',pt1,0.15,1);
owner.run('econ-owner-2','hash','Владелец 2','79990000003',pt2,0.20,0);
const orders=db.prepare(
  'INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status,created_at,commission_rate) '+
  'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
);
for(let n=1;n<=501;n++){
  const point=n%5===0?null:(n%2?pt1:pt2);
  const status=n%11===0?'pending':(n%13===0?'failed':'paid');
  const date=n%4===0?'2026-10-23':'2026-11-08';
  const total=99+(n%53)*13;
  const rate=n%7===0?null:(n%3?0.125:0.21);
  orders.run('ECON-STREAM-'+n,'Клиент','79990000004','Точка',point,total,total,
    'sbp',status,date+' 10:20:30',rate);
}
const expense=db.prepare(
  'INSERT INTO expenses(expense_date,category,amount,investor_name,city_id) VALUES(?,?,?,?,?)'
);
expense.run('2026-11-01','Закупка',3000,'Инвестор А',ci1);
expense.run('2026-11-07','Закупка',800,'Инвестор Б',ci2);
expense.run('2026-11-07','Логистика',150,'Инвестор А',ci1);
expense.run('2026-10-25','Закупка',500,'Инвестор Б',ci2);
const admin=Number(db.prepare(
  "INSERT INTO admins(login,password_hash,role,active) VALUES(?,?,'admin',1)"
).run('econ-stream-admin','hash').lastInsertRowid);

// Independent transcription of the previous public dashboard's data flow.
function oldDashboard(query={}){
  const parse=(value,fallback)=>{
    if(!value)return fallback;
    const date=new Date(value);
    return Number.isNaN(date.getTime())?fallback:date.toISOString();
  };
  const from=parse(query.from,'2000-01-01T00:00:00.000Z');
  const to=parse(query.to,'2100-01-01T00:00:00.000Z');
  const city=query.city||null;
  const history=city
    ?db.prepare(
      'SELECT o.id,o.total,o.commission_rate,o.point_id,o.created_at '+
      'FROM orders o JOIN points p ON p.id=o.point_id '+
      "WHERE o.status='paid' AND o.created_at BETWEEN ? AND ? AND p.city_id=?"
    ).all(from,to,city)
    :db.prepare(
      'SELECT id,total,commission_rate,point_id,created_at FROM orders '+
      "WHERE status='paid' AND created_at BETWEEN ? AND ?"
    ).all(from,to);
  const revenue=history.reduce((sum,row)=>sum+row.total,0);
  const partnerCommission=Math.round(history.reduce(
    (sum,row)=>sum+row.total*(row.commission_rate||0),0
  ));
  const managers=new Map(db.prepare(
    'SELECT point_id,commission_rate FROM manager_points WHERE point_id IS NOT NULL'
  ).all().map(row=>[row.point_id,row.commission_rate]));
  const managerCommission=Math.round(history.reduce((sum,row)=>{
    const rate=row.point_id?managers.get(row.point_id):null;
    return sum+(rate?row.total*rate:0);
  },0));
  const owners=new Map(db.prepare(
    'SELECT point_id,commission_rate FROM salon_owners WHERE point_id IS NOT NULL AND active=1'
  ).all().map(row=>[row.point_id,row.commission_rate]));
  const ownerCommission=Math.round(history.reduce((sum,row)=>{
    const rate=row.point_id?owners.get(row.point_id):null;
    return sum+(rate?row.total*rate:0);
  },0));
  const tax=Math.round(revenue*0.06);
  const acquiringFee=Math.round(revenue*0.02);
  const grouped=city
    ?db.prepare(
      'SELECT category,SUM(amount) AS total FROM expenses '+
      'WHERE expense_date BETWEEN ? AND ? AND city_id=? GROUP BY category ORDER BY total DESC'
    ).all(from.slice(0,10),to.slice(0,10),city)
    :db.prepare(
      'SELECT category,SUM(amount) AS total FROM expenses '+
      'WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC'
    ).all(from.slice(0,10),to.slice(0,10));
  const cogs=grouped.reduce((sum,row)=>sum+row.total,0);
  const totalCosts=partnerCommission+managerCommission+ownerCommission+tax+acquiringFee+cogs;
  const profit=revenue-totalCosts;
  return {
    period:{from,to},revenue,orders_count:history.length,
    costs:{cogs,expenses_by_category:grouped,
      partner_commission:partnerCommission,manager_commission:managerCommission,
      owner_commission:ownerCommission,tax,acquiring_fee:acquiringFee,total:totalCosts},
    net_profit:profit,
    margin_percent:revenue>0?Math.round(profit/revenue*1000)/10:0,
    rates_used:{tax_rate:0.06,acquiring_fee_rate:0.02},
  };
}
test('single-pass metrics exactly equal legacy financial results for all periods and cities',()=>{
  const samples=[
    {},{city:ci1},{city:ci2},
    {from:'2026-11-01',to:'2026-11-30'},
    {from:'2026-11-01',to:'2026-11-30',city:ci1},
    {from:'2026-10-01',to:'2026-11-30',city:ci2},
    {from:'2026-12-01',to:'2026-12-31'}
  ];
  for(const query of samples){
    assert.deepEqual(buildEconomicsDashboard(db,query),oldDashboard(query),
      'financial drift for '+JSON.stringify(query));
  }
  assert.ok(buildEconomicsDashboard(db,{}).orders_count>350);
});
test('paid orders are streamed without creating a large in-memory list',()=>{
  let streaming=0;
  const wrapper={prepare(sql){
    const stmt=db.prepare(sql);
    if(!/FROM orders(?:\s|$)|FROM orders o/.test(sql))return stmt;
    return {
      iterate(...params){streaming++;return stmt.iterate(...params);},
      all(){throw Error('Order history must not be materialized with all()');}
    };
  }};
  assert.deepEqual(buildEconomicsDashboard(wrapper,{}),oldDashboard({}));
  assert.equal(streaming,1,'a single iterator is expected');
  const timings=snapshotOperations();
  for(const name of ['economics_orders_scan','economics_rates_load','economics_expenses_scan'])
    assert.ok(timings.some(item=>item.name===name),name+' must be monitored');
});
test('existing paid-order and expenses indexes are used by SQL query planner',()=>{
  const queries=[
    ["SELECT id,total,commission_rate,point_id,created_at FROM orders WHERE status='paid' AND created_at BETWEEN ? AND ?",
      ['2000-01-01','2100-01-01'],'idx_orders_status_created'],
    ["SELECT category,SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC",
      ['2026-01-01','2026-12-31'],'idx_expenses_date_city_weekly']
  ];
  for(const [sql,params,index] of queries){
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params)
      .map(row=>String(row.detail||'')).join('\n');
    assert.match(plan,new RegExp(index),plan);
  }
});
test('economics route remains admin-only with unchanged JSON output and duration metrics',()=>{
  const router=new Router();
  registerEconomicsRoutes(router);
  const route=router.match('GET','/api/economics/dashboard');
  assert.ok(route);
  function call(token,query={}){
    const response={status:0,data:null,
      writeHead(status){this.status=status;return this;},
      end(data){this.data=JSON.parse(data||'{}');}};
    route.handler({headers:{authorization:token?'Bearer '+token:''}},
      response,{params:route.params,query});
    return response;
  }
  assert.ok([401,403].includes(call(null).status));
  const token=signToken({role:'admin',id:admin,login:'econ-stream-admin',adminRole:'admin'});
  const result=call(token,{city:ci1});
  assert.equal(result.status,200);
  assert.deepEqual(result.data,JSON.parse(JSON.stringify(oldDashboard({city:ci1}))));
  assert.ok(snapshotOperations().some(row=>row.name==='economics_dashboard_build'));
});
test.after(()=>{
  try{db.close();}catch(_){}
  fs.rmSync(work,{recursive:true,force:true});
});
