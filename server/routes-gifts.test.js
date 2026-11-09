'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'hvost-gifts-'));
process.env.TOKEN_SECRET='gift-campaign-unit-tests-secret';
const db=require('./db');
const {signToken}=require('./auth');
const {registerGiftRoutes,todayKrasnoyarsk,dayNumber,SLUG}=require('./routes-gifts');
const {Router}=require('./http-utils');
const router=new Router();
registerGiftRoutes(router);
db.prepare('INSERT INTO cities(id,name) VALUES (?,?)').run('gift-city','Красноярск');
for(const id of ['gift-point-a','gift-point-b']){
 db.prepare('INSERT INTO points(id,name,addr,icon,city_id) VALUES (?,?,?,?,?)').run(id,'Салон '+id,'Адрес тест','🐾','gift-city');
}
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES (?,?,?,?,?)').run(101,'gift-admin','unused','admin',1);
db.prepare('INSERT INTO admins(id,login,password_hash,role,active) VALUES (?,?,?,?,?)').run(102,'gift-disabled','unused','admin',0);
const adminToken=signToken({role:'admin',id:101,login:'gift-admin',adminRole:'admin'});
const disabledToken=signToken({role:'admin',id:102,login:'gift-disabled',adminRole:'admin'});
const buyerToken=signToken({role:'customer',id:1,login:'buyer'});
const variantId=db.prepare('SELECT variant_id FROM gift_campaigns WHERE id=1').get().variant_id;
function call(method,route,{body={},token=null,query={}}={}){
 const match=router.match(method,route);
 assert.ok(match,'Missing route '+method+' '+route);
 const headers=token?{authorization:'Bearer '+token}:{};
 const req={headers};
 const res={status:0,data:null,setHeader(){},writeHead(status){this.status=status;return this},end(data){this.data=JSON.parse(data)}};
 match.handler(req,res,{params:match.params,query,body});
 return res;
}
const a='gift-point-a',b='gift-point-b';
function stock(point=a){return db.prepare('SELECT qty FROM stock WHERE point_id=? AND variant_id=?').get(point,variantId)?.qty||0}
function setStock(qty,point=a){db.prepare('INSERT INTO stock(point_id,variant_id,qty) VALUES (?,?,?) ON CONFLICT(variant_id,point_id) DO UPDATE SET qty=excluded.qty').run(point,variantId,qty)}
function issue(count=2,point=a,start=todayKrasnoyarsk(),end=start){
 return call('POST','/api/gifts/admin/batches',{token:adminToken,body:{point_id:point,count,starts_on:start,ends_on:end}});
}
function claim(url,phone='79990001122',additional={}){
 return call('POST','/api/gifts/'+url.split('/').pop()+'/redeem',{body:{phone,guide_seen:true,privacy_acknowledged:true,...additional}});
}
test('dedicated SKU stays hidden and inactive; campaign defaults to disabled',()=>{
 const p=db.prepare('SELECT active,name FROM products WHERE slug=?').get(SLUG);
 assert.ok(p);assert.equal(p.active,0);
 const v=db.prepare('SELECT price,weight,active FROM product_variants WHERE id=?').get(variantId);
 assert.deepEqual({...v},{price:0,weight:'30 г',active:0});
 const c=call('GET','/api/gifts/admin',{token:adminToken});
 assert.equal(c.status,200);assert.equal(c.data.campaign.active,0);
 assert.equal(c.data.points.find(p=>p.id===a).gift_stock,0);
});
test('admin endpoints require active administrator; buyers and anonymous cannot issue',()=>{
 for(const token of [null,buyerToken,disabledToken]){
  assert.notEqual(call('GET','/api/gifts/admin',{token}).status,200);
  assert.notEqual(call('POST','/api/gifts/admin/batches',{token,body:{point_id:a,count:1,starts_on:todayKrasnoyarsk(),ends_on:todayKrasnoyarsk()}}).status,201);
  assert.notEqual(call('PUT','/api/gifts/admin/active',{token,body:{active:true}}).status,200);
 }
});
test('rejects too many, negative, past or more-than-week date ranges',()=>{
 const now=todayKrasnoyarsk();
 const earlier=new Date(dayNumber(now)-86400000).toISOString().slice(0,10);
 const weekPlus=new Date(dayNumber(now)+7*86400000).toISOString().slice(0,10);
 for(const body of [
  {count:0},{count:201},{count:2.5},{point_id:'unknown'},{starts_on:earlier,ends_on:earlier},
  {starts_on:now,ends_on:weekPlus},{starts_on:'2026-02-30'},{ends_on:'nope'}
 ]){
  const result=call('POST','/api/gifts/admin/batches',{token:adminToken,body:{point_id:a,count:2,starts_on:now,ends_on:now,...body}});
  assert.notEqual(result.status,201,JSON.stringify(body));
 }
});
test('physical stock moves from city warehouse to salon only with admin confirmation and audit',()=>{
 const incoming={city_id:'gift-city',qty:5,supplier_note:'Накладная №12345',physical_received:true};
 for(const token of [null,buyerToken,disabledToken]){
  assert.notEqual(call('POST','/api/gifts/admin/intake',{token,body:incoming}).status,201);
  assert.notEqual(call('POST','/api/gifts/admin/transfer',{token,body:{point_id:b,qty:2,note:'Тестовая доставка',physical_delivered:true}}).status,201);
 }
 assert.equal(call('POST','/api/gifts/admin/intake',{token:adminToken,body:{...incoming,physical_received:false}}).status,400);
 assert.equal(call('POST','/api/gifts/admin/intake',{token:adminToken,body:{...incoming,qty:2.5}}).status,400);
 assert.equal(call('POST','/api/gifts/admin/intake',{token:adminToken,body:incoming}).status,201);
 const warehouse=()=>db.prepare('SELECT qty FROM warehouse_stock WHERE city_id=? AND variant_id=?').get('gift-city',variantId)?.qty||0;
 assert.equal(warehouse(),5);
 const transfer={point_id:b,qty:2,note:'Проверка доставки №1',physical_delivered:true};
 assert.equal(call('POST','/api/gifts/admin/transfer',{token:adminToken,body:{...transfer,physical_delivered:false}}).status,400);
 assert.equal(call('POST','/api/gifts/admin/transfer',{token:adminToken,body:{...transfer,qty:10}}).status,409);
 assert.equal(stock(b),0);
 assert.equal(call('POST','/api/gifts/admin/transfer',{token:adminToken,body:transfer}).status,201);
 assert.equal(stock(b),2);
 assert.equal(warehouse(),3);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM gift_stock_transfers').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouse_receipts WHERE variant_id=?').get(variantId).n,1);
 const snapshot=call('GET','/api/gifts/admin',{token:adminToken}).data;
 assert.equal(snapshot.cities.find(c=>c.id==='gift-city').gift_warehouse_stock,3);
});

test('active flag is guarded by real stock and codes',()=>{
 assert.equal(call('PUT','/api/gifts/admin/active',{token:adminToken,body:{active:true}}).status,409);
 const batch=issue();
 assert.equal(batch.status,201);
 assert.equal(batch.data.cards.length,2);
 assert.notEqual(batch.data.cards[0],batch.data.cards[1]);
 const token=batch.data.cards[0].split('/').pop();
 assert.equal(db.prepare('SELECT COUNT(*) count FROM gift_codes WHERE code_hash LIKE ?').get('%'+token+'%').count,0);
 assert.equal(call('GET','/api/gifts/'+token).status,409);
 assert.equal(call('PUT','/api/gifts/admin/active',{token:adminToken,body:{active:true}}).status,409);
 setStock(2);
 assert.equal(call('PUT','/api/gifts/admin/active',{token:adminToken,body:{active:true}}).status,200);
 assert.equal(call('GET','/api/gifts/'+token).data.price,0);
});
test('one gift per QR uses point stock atomically; duplicate cannot issue twice',()=>{
 const codes=db.prepare('SELECT code_hash FROM gift_codes').all();
 assert.equal(codes.length,2);
 // Batch issued in previous test; obtain a fresh batch to exercise claims.
 const batch=issue(2);
 const first=batch.data.cards[0],second=batch.data.cards[1];
 const beforeOrders=db.prepare('SELECT COUNT(*) n FROM orders').get().n;
 const beforeItems=db.prepare('SELECT COUNT(*) n FROM order_items').get().n;
 assert.equal(claim(first,'79990001122',{guide_seen:false}).status,400);
 assert.equal(claim(first,'not-phone').status,400);
 assert.equal(stock(),2);
 const result=claim(first);
 assert.equal(result.status,200);
 assert.equal(result.data.weight,'30 г');
 assert.equal(stock(),1);
 assert.equal(claim(first).status,410);
 assert.equal(stock(),1);
 assert.equal(claim(second,'79990001122').status,200); // A second haircut can yield another single-use ticket.
 assert.equal(stock(),0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,beforeOrders);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items').get().n,beforeItems);
 assert.equal(call('GET','/api/gifts/'+first.split('/').pop()).status,410);
 const data=call('GET','/api/gifts/admin',{token:adminToken}).data;
 const row=data.batches.find(x=>x.id===batch.data.batch_id);
 assert.equal(row.redeemed,2);
 assert.equal(row.unique_phones,1);
});
test('zero stock rejects without burning ticket or stock from other point',()=>{
 const batch=issue(1,a);
 setStock(7,b);
 assert.equal(claim(batch.data.cards[0]).status,409);
 assert.equal(stock(b),7);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM gift_codes WHERE redeemed_at IS NOT NULL').get().n,2);
});
test('revoking a batch blocks only unused codes',()=>{
 const batch=issue(2);
 const res=call('POST','/api/gifts/admin/batches/'+batch.data.batch_id+'/revoke',{token:adminToken});
 assert.equal(res.status,200);assert.equal(res.data.revoked,2);
 setStock(3);
 assert.equal(claim(batch.data.cards[0]).status,410);
 assert.equal(stock(),3);
});
test('turning off campaign immediately blocks claims, without altering stock',()=>{
 const batch=issue(1);
 assert.equal(call('PUT','/api/gifts/admin/active',{token:adminToken,body:{active:false}}).status,200);
 assert.equal(claim(batch.data.cards[0]).status,409);
 assert.equal(stock(),3);
});
