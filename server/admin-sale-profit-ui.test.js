'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hm-super-profit-route-'));
process.env.DATA_DIR=dir;
const db=require('./db');
const {signToken}=require('./auth');
require('./business-founders');
const {registerOrderRoutes}=require('./routes-orders');
const handlers=new Map();
registerOrderRoutes({
  get:(p,h)=>handlers.set('GET '+p,h),
  post(){},put(){},delete(){}
});
const get=handlers.get('GET /api/orders/:id/profit');
function call(id,token){
  const res={statusCode:200,payload:null,headers:{},
    setHeader(name,value){this.headers[name]=value;},
    writeHead(status){this.statusCode=status;return this;},
    end(value){this.payload=JSON.parse(value);},
  };
  get({headers:token?{authorization:'Bearer '+token}:{}},res,
    {params:{id:String(id)},query:{}});
  return res;
}
const create=db.prepare(
  'INSERT INTO orders (order_code,customer_name,customer_phone,pickup_point,'+
  'subtotal,total,payment_method,status) VALUES (?,?,?,?,?,?,?,?)'
);
function order(status){
 const info=create.run('profit-test-'+Math.random(),'Customer','79990000000',
   'Салон А',250,250,'sbp',status);
 const id=Number(info.lastInsertRowid);
 db.prepare(
   'INSERT INTO order_items (order_id,name,weight,qty,price,is_custom) VALUES (?,?,?,?,?,?)'
 ).run(id,'Лёгкое', '50 г',1,250,0);
 return id;
}
test('endpoint only serves a PAID order to ACTIVE superadmins',()=>{
  const superId=Number(db.prepare(
    "INSERT INTO admins(login,password_hash,role,active) VALUES ('profit-super','no-login','super',1)"
  ).run().lastInsertRowid);
  const adminId=Number(db.prepare(
    "INSERT INTO admins(login,password_hash,role,active) VALUES ('profit-regular','no-login','admin',1)"
  ).run().lastInsertRowid);
  const inactiveId=Number(db.prepare(
    "INSERT INTO admins(login,password_hash,role,active) VALUES ('profit-inactive','no-login','super',0)"
  ).run().lastInsertRowid);
  const superToken=signToken({role:'admin',adminRole:'super',login:'profit-super',id:superId});
  const regularToken=signToken({role:'admin',adminRole:'admin',login:'profit-regular',id:adminId});
  const inactiveToken=signToken({role:'admin',adminRole:'super',login:'profit-inactive',id:inactiveId});
  const paid=order('paid');
  const pending=order('pending');
  assert.equal(call(paid,null).statusCode,401);
  assert.equal(call(paid,regularToken).statusCode,403);
  assert.equal(call(paid,inactiveToken).statusCode,403);
  assert.equal(call(pending,superToken).statusCode,404);
  assert.equal(call(-1,superToken).statusCode,400);
  const result=call(paid,superToken);
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.equal(result.payload.sale.order_id,paid);
  assert.equal(result.payload.sale.revenue,250);
  assert.equal(result.payload.sale.items[0].name,'Лёгкое');
  assert.equal(result.payload.sale.founder_shares.length,3);
  assert.equal(Object.hasOwn(result.payload.sale,'customer_phone'),false);
});
test('order list remains batched, profit is queried only when opened',()=>{
 const route=fs.readFileSync(path.join(__dirname,'routes-orders.js'),'utf8');
 const list=route.split("router.get('/api/orders',")[1].split("router.get('/api/orders/:id'")[0];
 assert.doesNotMatch(list,/loadSaleProfitEstimate/);
 const html=fs.readFileSync(path.join(__dirname,'..','public','taiga-admin.html'),'utf8');
 assert.match(html,/id="order-profit-modal"/);
 assert.match(html,/function openOrderProfit\(orderId\)/);
 assert.match(html,/currentAdminRole!=='super'/);
 assert.match(html,/o\.status === 'paid' && currentAdminRole === 'super'/);
 assert.match(html,/\/api\/orders\/'\+Number\(orderId\)\+'\/profit'/);
 assert.match(html,/Расчётная прибыль собственников/);
 assert.match(html,/escape\(x\.assumptions_note\)/);
 assert.match(html,/cost_estimated/);
});
test.after(()=>{
 try{db.close();}catch(_){}
 fs.rmSync(dir,{recursive:true,force:true});
});
