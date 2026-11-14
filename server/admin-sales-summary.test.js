'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hm-sales-summary-'));
process.env.DATA_DIR=tmp;
const db=require('./db');
const {signToken}=require('./auth');
const {registerOrderRoutes}=require('./routes-orders');
const handlers=new Map();
registerOrderRoutes({
  get(route,handler){handlers.set(route,handler);},
  post(){},put(){},delete(){},
});
const auth='Bearer '+signToken({role:'admin',id:1,login:'sales-test',adminRole:'super'});
function call(query={}) {
  const response={statusCode:0,body:null,
    writeHead(code){this.statusCode=code;return this;},
    end(raw){this.body=JSON.parse(raw);},
  };
  handlers.get('/api/admin/sales-summary')(
    {headers:{authorization:auth}},response,{query,params:{}});
  return response;
}
function add(id,status,total,age,point) {
  db.prepare("INSERT INTO orders(order_code,customer_name,customer_phone,pickup_point,point_id,subtotal,total,payment_method,status,created_at)"+
    " VALUES(?,?,?,?,?,?,?,?,?,datetime('now',?))").run('sales-sum-'+id,'Покупатель','79990000000',
      'БаркЛай',point,total,total,'sbp',status,age);
}

test('empty sales dashboard contains no customer records',()=>{
  const res=call({days:'7'});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{days:7,revenue:0,orders_count:0,active_points_count:0,daily:[],points:[]});
});

test('exact sales totals cover 520 orders, never truncated to 500',()=>{
  db.exec('BEGIN IMMEDIATE');
  try {
    for(let i=0;i<520;i++)add(i,'paid',250,'-1 day',i%2?'salon-a':'salon-b');
    add('pending','pending',900,'-1 day','salon-a');
    add('old','paid',360,'-40 days','salon-a');
    add('ancient','paid',700,'-100 days','salon-a');
    add('direct','paid',100,'-1 day',null);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  const week=call({days:'7'});
  assert.equal(week.statusCode,200);
  assert.equal(week.body.orders_count,521);
  assert.equal(week.body.revenue,520*250+100);
  assert.equal(week.body.daily.reduce((a,b)=>a+b.orders_count,0),521);
  assert.equal(week.body.points.length,2,'null point counts toward network revenue but not salon chart');
  const p=new Map(week.body.points.map(x=>[x.point_id,x]));
  assert.equal(p.get('salon-a').orders_count,260);
  assert.equal(p.get('salon-b').orders_count,260);
  assert.equal(p.get('salon-a').revenue,260*250);
  const month=call({days:'30'});
  assert.equal(month.body.orders_count,521);
  const quarter=call({days:'90'});
  assert.equal(quarter.body.orders_count,522);
  assert.equal(quarter.body.revenue,520*250+100+360);
  assert.equal(quarter.body.points.find(x=>x.point_id==='salon-a').orders_count,261);
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,?)')
    .run('salon-a','БаркЛай','Красноярск','🐾',1);
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,?)')
    .run('salon-b','Салон','Красноярск','🐾',1);
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,?)')
    .run('salon-closed','Закрытая точка','Красноярск','🐾',0);
  assert.equal(call({days:'7'}).body.active_points_count,2);
  assert.equal(call({days:'14'}).statusCode,400);
});

test('summary stays indexed and guarded by admin credentials',()=>{
  const route=fs.readFileSync(path.join(__dirname,'routes-orders.js'),'utf8');
  const block=route.split("router.get('/api/admin/sales-summary'")[1]
    .split("router.get('/api/orders'")[0];
  assert.doesNotMatch(block,/order_items|SELECT o\.\*|customer_phone/);
  assert.match(block,/GROUP BY substr\(created_at, 1, 10\), point_id/);
  const plan=db.prepare(
    "EXPLAIN QUERY PLAN SELECT substr(created_at,1,10) AS day, point_id, "+
    "COUNT(*),SUM(total) FROM orders WHERE status='paid' AND created_at >= ? "+
    "GROUP BY substr(created_at,1,10),point_id"
  ).all('2026-11-01 00:00:00');
  assert.match(plan.map(x=>x.detail).join(' '),/idx_orders_status_created/);
  const response={statusCode:0,writeHead(code){this.statusCode=code;return this;},
    end(){}};
  handlers.get('/api/admin/sales-summary')(
    {headers:{}},response,{query:{days:7},params:{}});
  assert.equal(response.statusCode,401);
});

test.after(()=>{try{db.close();}catch(_){}fs.rmSync(tmp,{recursive:true,force:true});});
