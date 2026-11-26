'use strict';
// Integration stress suite: real HTTP routing, real SQLite and real YooKassa
// request construction. Only external network and storage latency are faked.
// No production database, credentials, email, Telegram or actual charges.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Worker}=require('node:worker_threads');
const {once}=require('node:events');
const {performance}=require('node:perf_hooks');
const {setTimeout:sleep}=require('node:timers/promises');
const {createHash}=require('node:crypto');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hm-checkout-stress-'));
process.env.DATA_DIR=directory;
process.env.TOKEN_SECRET='checkout-stress-isolated';
process.env.PUBLIC_URL='https://checkout-stress.invalid';
process.env.YOOKASSA_SHOP_ID='isolated-fake-shop';
process.env.YOOKASSA_SECRET_KEY='isolated-fake-secret';
process.env.DEMO_MODE='false';
delete process.env.TG_TOKEN;
delete process.env.MAX_BOT_TOKEN;
const originalFetch=global.fetch;
const payments=new Map(),byKey=new Map(),faults=new Map(),postCalls=[];
const providerErrors=[];
let unexpectedNetwork=0;
function response(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});}
function gatewayPayment(code){const row=payments.get(code);assert.ok(row,'payment missing '+code);return row;}
function providerStatus(code,status){
  const row=gatewayPayment(code);
  row.payment.status=status;row.payment.paid=status==='succeeded';
}
global.fetch=async(url,options={})=>{
  const u=new URL(String(url));
  if(u.origin!=='https://api.yookassa.ru'){
    unexpectedNetwork++;throw Error('Unexpected external request in checkout stress suite');
  }
  if(u.pathname==='/v3/payments'&&options.method==='POST'){
    const key=options.headers['Idempotence-Key'];
    const body=JSON.parse(options.body);
    const code=body.metadata.order_code;
    postCalls.push({code,key});
    const expected=createHash('sha256').update(code).digest('hex');
    if(key!==expected){providerErrors.push('unstable key');return response({description:'bad key'},400);}
    let row=byKey.get(key);
    if(row){
      try{assert.deepEqual(body,row.body);}
      catch(error){providerErrors.push(error.message);return response({description:'idempotent body mismatch'},409);}
    }else{
      const id='fake-payment-'+(byKey.size+1);
      row={body,payment:{id,status:'pending',paid:false,amount:body.amount,metadata:body.metadata,
        confirmation:{type:'redirect',confirmation_url:'https://bank.example.invalid/'+id}}};
      byKey.set(key,row);payments.set(code,row);
      const fault=faults.get(code);
      if(fault==='lost')throw new TypeError('Simulated connection loss after provider accepted payment');
      if(fault==='rate_limit')return response({description:'Simulated provider rate limit'},429);
      if(fault==='timeout'){
        // The real YooKassa client's eight-second AbortController must fire.
        await new Promise((resolve,reject)=>{
          const aborted=()=>reject(Object.assign(new Error('Simulated provider timeout'),{name:'AbortError'}));
          if(options.signal.aborted)aborted();
          else options.signal.addEventListener('abort',aborted,{once:true});
        });
      }
    }
    return response(row.payment);
  }
  const match=/^\/v3\/payments\/([^/]+)$/.exec(u.pathname);
  if(match){
    const row=[...byKey.values()].find(r=>r.payment.id===match[1]);
    return row?response(row.payment):response({description:'not found'},404);
  }
  unexpectedNetwork++;throw Error('Unexpected provider route '+u.pathname);
};
const db=require('./db');
// Prevent external notification side effects without replacing any order,
// reservation, promo, pricing or customer-account calculation.
const noSend=async()=>({ok:true});
const telegram=require('./telegram');
telegram.sendTelegram=noSend;telegram.sendToChat=noSend;
require('./email').sendEmail=noSend;
require('./order-notifications').sendPaidOrderNotifications=noSend;
require('./superadmin-sale-profit').sendSuperadminSaleProfit=noSend;
const {registerPaymentRoutes}=require('./routes-payment');
const {Router,parseJsonBody,sendJson}=require('./http-utils');
const {writeNotificationMarker}=require('./deployment-notification');
const {validateFirstPurchasePromo}=require('./first-purchase-promo');

const router=new Router();registerPaymentRoutes(router);
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    const match=router.match(req.method,u.pathname);
    if(!match)return sendJson(res,404,{error:'not found'});
    const body=req.method==='POST'?await parseJsonBody(req):{};
    await match.handler(req,res,{params:match.params,query:Object.fromEntries(u.searchParams),body});
  }catch(error){if(!res.headersSent)sendJson(res,error.statusCode||500,{error:error.message});else res.destroy();}
});
let port;
test.before(async()=>{
  server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
  db.prepare('INSERT INTO products(id,slug,name,category,icon,desc,comp,active) VALUES(1,?,?,?,?,?,?,1)')
    .run('stress-lung','Лёгкое','treats','🐾','Тест','[]');
  db.prepare('INSERT INTO products(id,slug,name,category,icon,desc,comp,active) VALUES(2,?,?,?,?,?,?,1)')
    .run('stress-toy','Игрушка','toys','🐾','Тест','[]');
  db.prepare('INSERT INTO product_variants(id,product_id,weight,price) VALUES(1,1,?,250)').run('50 г');
  db.prepare('INSERT INTO product_variants(id,product_id,weight,price) VALUES(2,2,?,300)').run('1 шт.');
});
test.after(async()=>{
  try{await new Promise(resolve=>setImmediate(resolve));}
  finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
    global.fetch=originalFetch;
    try{db.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}
  }
});
function request(method,route,body){
  return new Promise((resolve,reject)=>{
    const start=performance.now();
    const encoded=body===undefined?null:JSON.stringify(body);
    const req=http.request({host:'127.0.0.1',port,path:route,method,
      headers:encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{}},
    res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks)),ms:Math.round(performance.now()-start)});}
        catch(error){reject(error);}
      });
    });
    req.on('error',reject);
    req.setTimeout(30000,()=>req.destroy(new Error('Local checkout HTTP timeout')));
    req.end(encoded||undefined);
  });
}
let sequence=0;
function point(id){
  db.prepare('INSERT INTO points(id,name,addr,icon,active) VALUES(?,?,?,?,1)')
    .run(id,'Тестовый салон '+id,'Тестовый адрес','🐾');
  db.prepare('INSERT INTO stock(variant_id,point_id,qty) VALUES(1,?,20),(2,?,20)').run(id,id);
  const partner=Number(db.prepare(
    'INSERT INTO partners(partner_code,login,password_hash,full_name,phone,point_id,point_name,commission_rate,active) VALUES(?,?,?,?,?,?,?,?,1)'
  ).run('STRESS-'+id,'stress-'+id,'test-only','Тестовый грумер','+79880000000',id,id,0.15).lastInsertRowid);
  return {id,partner};
}
function orderBody(p,phone){
  const n=++sequence;
  return {orderId:'TG-'+Date.now()+'-'+n.toString(16).padStart(16,'0'),
    amount:680,customerPhone:phone||('+7999000'+String(n).padStart(4,'0')),
    customerName:'Тестовый клиент',pickupPoint:p.id,pointId:p.id,partnerId:p.partner,
    method:'yookassa',fulfillmentType:'pickup',confirmationMode:'redirect',
    returnPath:'/p/'+p.id+'/stress-lung',promoCode:'HV15',bonesUsed:0,
    cartItems:[{variantId:1,qty:2},{variantId:2,qty:1}]};
}
const post=body=>request('POST','/api/create-payment',body);
const poll=body=>request('GET','/api/order-payment-status/'+encodeURIComponent(body.orderId));
const hook=body=>request('POST','/api/yookassa-webhook',{object:{id:gatewayPayment(body.orderId).payment.id}});
const order=body=>db.prepare('SELECT * FROM orders WHERE order_code=?').get(body.orderId);
const orderCount=body=>db.prepare('SELECT COUNT(*) n FROM orders WHERE order_code=?').get(body.orderId).n;
const quantities=p=>db.prepare('SELECT qty FROM stock WHERE point_id=? ORDER BY variant_id').all(p.id).map(x=>x.qty);
const promoCount=body=>db.prepare('SELECT COUNT(*) n FROM first_purchase_point_promo_claims WHERE order_id=?').get(order(body).id).n;
function checkReserved(p,body){
  const row=order(body);assert.equal(row.status,'pending');assert.equal(row.reservation_status,'active');
  assert.equal(orderCount(body),1);assert.equal(row.total,680);assert.equal(row.discount,120);
  assert.equal(row.commission_rate,0.15);assert.deepEqual(quantities(p),[18,19]);assert.equal(promoCount(body),1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items WHERE order_id=?').get(row.id).n,2);
}
function checkPaid(p,body){
  const row=order(body);assert.equal(row.status,'paid');assert.equal(row.reservation_status,'consumed');
  assert.equal(orderCount(body),1);assert.equal(row.total,680);assert.equal(row.commission_rate,0.15);
  assert.deepEqual(quantities(p),[18,19]);assert.equal(promoCount(body),1);
  const customer=db.prepare('SELECT orders_count,total_spent FROM customers WHERE phone=?').get(body.customerPhone.replace(/\D/g,''));
  assert.ok(customer,'customer profile recorded');
  assert.equal(customer.orders_count,1);assert.equal(customer.total_spent,680);
  assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,p.id).valid,false);
  assert.equal([...byKey.values()].filter(r=>r.body.metadata.order_code===body.orderId).length,1);
}
async function settlePaid(body){
  providerStatus(body.orderId,'succeeded');
  const results=await Promise.all([hook(body),poll(body),hook(body)]);
  assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
  const verified=await poll(body);assert.equal(verified.body.paid,true);
  assert.equal(verified.body.items.length,2);
  assert.equal((await post(body)).body.paid,true);
}

test('checkout completes while unrelated persistent file operations take 5s, 10s and 20s',{timeout:70000},async()=>{
  const scenarios=[
    {ms:5000,fault:'lost',kind:'paid'},
    {ms:10000,fault:'rate_limit',kind:'canceled'},
    {ms:20000,fault:'timeout',kind:'late-webhook'},
  ].map(spec=>({...spec,p:point('stress-'+spec.ms),marker:path.join(directory,'slow-marker-'+spec.ms+'.json')}));
  const originalRename=fs.promises.rename;
  const markers=new Map(scenarios.map(s=>[s.marker,s]));
  const markerJobs=[],cases=[];
  fs.promises.rename=async function(from,to){
    const s=markers.get(String(to));
    if(s){s.started=performance.now();s.enter();await sleep(s.ms);}
    return originalRename.call(this,from,to);
  };
  try{
    for(const s of scenarios){
      const entered=new Promise(resolve=>s.enter=resolve);
      s.markerDone=false;
      const job=writeNotificationMarker(s.marker,{build_id:'stress-'+s.ms}).then(()=>{
        s.markerDone=true;s.actualMs=Math.round(performance.now()-s.started);
      });
      markerJobs.push(job);job.catch(()=>{});
      const run=(async()=>{
        await entered;
        const body=orderBody(s.p);faults.set(body.orderId,s.fault);
        const first=await post(body);
        assert.equal(first.status,202,JSON.stringify(first));
        checkReserved(s.p,body);
        assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,s.p.id).valid,false,'unsettled claim held');
        if(s.kind==='late-webhook'){
          // The provider already accepted the payment, but the original
          // response was lost for >8s. A webhook can arrive before attachment.
          providerStatus(body.orderId,'succeeded');
          const race=await Promise.all([hook(body),post(body),poll(body),hook(body)]);
          assert.ok(race.every(r=>[200,202].includes(r.status)),JSON.stringify(race));
          assert.equal((await poll(body)).body.paid,true);
          checkPaid(s.p,body);
        }else{
          const retry=await Promise.all([post(body),post(body)]);
          assert.ok(retry.every(r=>r.status===200),JSON.stringify(retry));
          assert.ok(retry.every(r=>r.body.payment_id===gatewayPayment(body.orderId).payment.id));
          checkReserved(s.p,body);
          assert.equal((await post({...body,amount:681})).status,409);
          if(s.kind==='canceled'){
            providerStatus(body.orderId,'canceled');
            const cancelled=await Promise.all([hook(body),poll(body),hook(body)]);
            assert.ok(cancelled.every(r=>r.status===200));
            assert.equal(order(body).status,'failed');assert.equal(order(body).reservation_status,'released');
            assert.deepEqual(quantities(s.p),[20,20]);assert.equal(promoCount(body),0);
            assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,s.p.id).valid,true);
            assert.equal((await post(body)).status,409);
            const fresh=orderBody(s.p,body.customerPhone);
            assert.equal((await post(fresh)).status,201);
            await settlePaid(fresh);checkPaid(s.p,fresh);
          }else{await settlePaid(body);checkPaid(s.p,body);}
        }
        assert.equal(s.markerDone,false,'checkout must finish before background storage operation');
        s.checkoutMs=Math.round(performance.now()-s.started);
        console.log('[checkout-stress] simulated file delay='+s.ms+'ms; checkout='+s.checkoutMs+'ms; case='+s.kind);
      })();
      cases.push(run);run.catch(()=>{});
    }
    const results=await Promise.allSettled(cases);
    const writes=await Promise.allSettled(markerJobs);
    for(const r of [...results,...writes])if(r.status==='rejected')throw r.reason;
    for(const s of scenarios){
      assert.ok(s.actualMs>=s.ms-50,'actual delay was not simulated');
      assert.ok(s.checkoutMs<s.actualMs);
      console.log('[checkout-stress] marker completed in '+s.actualMs+'ms');
    }
    assert.deepEqual(providerErrors,[]);assert.equal(unexpectedNetwork,0);
  }finally{
    await Promise.allSettled([...cases,...markerJobs]);fs.promises.rename=originalRename;
  }
});

async function holdSqliteWriter(ms){
  const worker=new Worker(
    "const {parentPort,workerData}=require('node:worker_threads');"+
    "const {DatabaseSync}=require('node:sqlite');"+
    "const db=new DatabaseSync(workerData.source);"+
    "db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');"+
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,workerData.ms);"+
    "db.exec('ROLLBACK');db.close();",
    {eval:true,workerData:{source:db.DB_PATH,ms}});
  const done=once(worker,'exit').then(([code])=>{assert.equal(code,0);});
  done.catch(()=>{});
  const [message]=await once(worker,'message');assert.equal(message,'locked');
  return {worker,done};
}
test('real SQLite writer lock for 20s: no partial order, no duplicate charge, verified payment recovers',{timeout:50000},async()=>{
  const paidPoint=point('stress-lock-paid'),newPoint=point('stress-lock-new');
  const existing=orderBody(paidPoint),fresh=orderBody(newPoint);
  assert.equal((await post(existing)).status,201);
  checkReserved(paidPoint,existing);
  const lock=await holdSqliteWriter(20000),started=performance.now();
  let released=false;lock.done.then(()=>{released=true;},()=>{});
  try{
    providerStatus(existing.orderId,'succeeded');
    for(const offset of [0,5000,10000]){
      await sleep(Math.max(0,offset-(performance.now()-started)));
      const result=await post(fresh);
      assert.equal(result.status,503,JSON.stringify(result));
      assert.equal(result.body.code,'CHECKOUT_STORAGE_BUSY');
      assert.equal(result.headers['retry-after'],'2');
      assert.equal(orderCount(fresh),0);assert.deepEqual(quantities(newPoint),[20,20]);
      assert.equal(validateFirstPurchasePromo('HV15',fresh.customerPhone,newPoint.id).valid,true);
      assert.equal(payments.has(fresh.orderId),false,'no payment before reservation commits');
      const observed=await poll(existing);
      assert.equal(observed.body.paid,false);assert.equal(observed.body.status,'pending');
      assert.equal(order(existing).reservation_status,'active');
      assert.deepEqual(quantities(paidPoint),[18,19]);
      assert.equal(released,false,'writer lock was not held for expected interval');
      console.log('[checkout-stress] real SQLite lock at '+offset+'ms: new checkout HTTP '+result.status+' in '+result.ms+'ms, existing payment remains pending');
    }
    await lock.done;
    assert.ok(performance.now()-started>=19900,'writer lock must actually last 20 seconds');
    await settlePaid(existing);checkPaid(paidPoint,existing);
    const recovered=await post(fresh);assert.equal(recovered.status,201,JSON.stringify(recovered));
    await settlePaid(fresh);checkPaid(newPoint,fresh);
    assert.deepEqual(providerErrors,[]);assert.equal(unexpectedNetwork,0);
    console.log('[checkout-stress] after real 20s lock: both original orders paid exactly once');
  }finally{
    if(!released)await lock.worker.terminate().catch(()=>{});
    await lock.done.catch(()=>{});
  }
});
