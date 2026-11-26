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
const club=require('./routes-partner-club');

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
// A concurrent read-only maintenance connection can briefly hold a DELETE
// journal read lock. The client and webhook must tolerate a retryable response,
// but the test requires eventual confirmation and exact-once accounting.
function retryable(r){
  return r.status===202&&r.body.status==='initializing'||
    r.status===503&&['CHECKOUT_STORAGE_BUSY','PAYMENT_STATUS_TEMPORARY'].includes(r.body.code)||
    r.status===500&&/database is locked|database table is locked/i.test(r.body.error||'');
}
async function untilResponse(operation,accept){
  let last;
  for(let attempt=0;attempt<20;attempt++){
    last=await operation();
    if(accept(last))return last;
    assert.ok(retryable(last)||last.status===200&&last.body.status==='pending',JSON.stringify(last));
    await sleep(50);
  }
  assert.fail('Original request did not recover: '+JSON.stringify(last));
}
async function settlePaid(body){
  providerStatus(body.orderId,'succeeded');
  const results=await Promise.all([hook(body),poll(body),hook(body)]);
  assert.ok(results.every(r=>r.status===200||retryable(r)),JSON.stringify(results));
  const verified=await untilResponse(()=>poll(body),r=>r.status===200&&r.body.paid===true);
  assert.equal(verified.body.items.length,2);
  assert.equal((await untilResponse(()=>post(body),r=>r.status===200&&r.body.paid===true)).body.paid,true);
}

test('checkout and retry expose one server-clock deadline without extending the same payment',async()=>{
  const p=point('countdown-deadline'),body=orderBody(p);
  const created=await post(body);
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.ok(Number.isFinite(created.body.server_now_ms));
  const deadline=created.body.payment_deadline_ms;
  assert.ok(deadline-created.body.server_now_ms>295000&&deadline-created.body.server_now_ms<=300000);
  const status=await poll(body);
  assert.equal(status.status,200);
  assert.equal(status.body.payment_deadline_ms,deadline);
  assert.ok(status.body.server_now_ms>=created.body.server_now_ms);
  const retry=await post(body);
  assert.equal(retry.status,200);
  assert.equal(retry.body.payment_deadline_ms,deadline);
  assert.equal(retry.body.reservation_expires_at,created.body.reservation_expires_at);
  assert.equal(orderCount(body),1);
});

test('a legacy demo flag cannot turn a missing YooKassa configuration into a paid order',async()=>{
  const gateway=require('./yookassa');
  const original=gateway.isConfigured;
  const previous=process.env.DEMO_MODE;
  const p=point('no-gateway-demo-flag'),body=orderBody(p);
  const before=quantities(p),calls=postCalls.length;
  try {
    process.env.DEMO_MODE='true';
    gateway.isConfigured=()=>false;
    const result=await post(body);
    assert.equal(result.status,503);
    assert.equal(result.body.code,'PAYMENT_NOT_CONFIGURED');
    assert.equal(orderCount(body),0);
    assert.deepEqual(quantities(p),before);
    assert.equal(postCalls.length,calls);
    assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,p.id).valid,true);
  } finally {
    gateway.isConfigured=original;
    if(previous===undefined)delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE=previous;
  }
});

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
        // A real brief DELETE-journal reader lock can coincide with the
        // synthetic file delay. Retry only the explicit pre-reservation
        // busy response; prove no order or provider operation was created.
        const first=await untilResponse(async()=>{
          const result=await post(body);
          if(result.status===503&&result.body.code==='CHECKOUT_STORAGE_BUSY'){
            assert.equal(orderCount(body),0);
            assert.equal(postCalls.filter(call=>call.code===body.orderId).length,0);
            assert.deepEqual(quantities(s.p),[20,20]);
          }else assert.equal(result.status,202,JSON.stringify(result));
          return result;
        },r=>r.status===202&&r.body.status==='initializing');
        assert.equal(first.status,202,JSON.stringify(first));
        checkReserved(s.p,body);
        assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,s.p.id).valid,false,'unsettled claim held');
        if(s.kind==='late-webhook'){
          // The provider already accepted the payment, but the original
          // response was lost for >8s. A webhook can arrive before attachment.
          providerStatus(body.orderId,'succeeded');
          const race=await Promise.all([hook(body),post(body),poll(body),hook(body)]);
          assert.ok(race.every(r=>r.status===200||retryable(r)),JSON.stringify(race));
          await untilResponse(()=>poll(body),r=>r.status===200&&r.body.paid===true);
          checkPaid(s.p,body);
        }else{
          const retry=await Promise.all([post(body),post(body)]);
          assert.ok(retry.every(r=>r.status===200||retryable(r)),JSON.stringify(retry));
          const expectedId=gatewayPayment(body.orderId).payment.id;
          assert.ok(retry.filter(r=>r.status===200).every(r=>r.body.payment_id===expectedId));
          const resumed=await untilResponse(()=>post(body),r=>r.status===200&&r.body.payment_id===expectedId);
          assert.equal(resumed.body.payment_id,expectedId);
          checkReserved(s.p,body);
          assert.equal((await post({...body,amount:681})).status,409);
          if(s.kind==='canceled'){
            providerStatus(body.orderId,'canceled');
            const cancelled=await Promise.all([hook(body),poll(body),hook(body)]);
            assert.ok(cancelled.every(r=>r.status===200||retryable(r)),JSON.stringify(cancelled));
            await untilResponse(()=>poll(body),r=>r.status===200&&r.body.status==='failed');
            assert.equal(order(body).status,'failed');assert.equal(order(body).reservation_status,'released');
            assert.deepEqual(quantities(s.p),[20,20]);assert.equal(promoCount(body),0);
            assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,s.p.id).valid,true);
            assert.equal((await post(body)).status,409);
            const fresh=orderBody(s.p,body.customerPhone);
            const created=await untilResponse(()=>post(fresh),r=>[200,201].includes(r.status)&&!!r.body.payment_id);
            assert.equal(created.body.payment_id,gatewayPayment(fresh.orderId).payment.id);
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

test('customer accounting failure rolls back paid transition and retry records it exactly once',async()=>{
  const p=point('stress-customer-atomic'),body=orderBody(p);
  await untilResponse(()=>post(body),r=>[200,201].includes(r.status)&&!!r.body.payment_id);
  const phone=body.customerPhone.replace(/\D/g,'');
  providerStatus(body.orderId,'succeeded');
  // Simulate failure at the customer write after reservation consumption.
  // No timing or race is required to exercise the former loss window.
  db.exec("CREATE TEMP TRIGGER fail_customer_accounting BEFORE INSERT ON customers WHEN NEW.phone='"+phone+"' BEGIN SELECT RAISE(ABORT,'test customer accounting failure'); END;");
  try{
    const status=await poll(body);
    assert.equal(status.status,200);
    assert.equal(status.body.paid,false);
    checkReserved(p,body);
    assert.equal(db.prepare('SELECT id FROM customers WHERE phone=?').get(phone),undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_club_sale_jobs WHERE order_id=?').get(order(body).id).n,0);
  }finally{db.exec('DROP TRIGGER fail_customer_accounting');}
  await settlePaid(body);
  checkPaid(p,body);
  await settlePaid(body);
  checkPaid(p,body);
});

test('paid checkout survives stopped Club worker and produces one moderated draft after storage recovers',{timeout:12000},async()=>{
  const p=point('stress-club-outbox');
  const body=orderBody(p);
  db.prepare('INSERT INTO partner_club_settings(id,config_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json')
    .run(JSON.stringify({enabled:true,chat_id:'-100123',club_started_at:'2026-01-01 00:00:00',
      sales:true,first_sale:true,record_check:false,record_day:false}));
  try{
    const created=await untilResponse(()=>post(body),r=>[200,201].includes(r.status)&&!!r.body.payment_id);
    assert.ok(created.body.payment_id);
    await settlePaid(body);checkPaid(p,body);
    const row=order(body);
    const jobs=()=>db.prepare('SELECT COUNT(*) n FROM partner_club_sale_jobs WHERE order_id=?').get(row.id).n;
    const drafts=()=>db.prepare('SELECT COUNT(*) n FROM partner_club_events WHERE event_key=? OR event_key=?').get('first-sale:point:'+p.id,'paid:'+row.id).n;
    assert.equal(jobs(),1);assert.equal(drafts(),0,'checkout does not format drafts');
    const lock=await holdSqliteWriter(300);
    try{
      assert.throws(()=>club.drainPaidClubSales(),/database is locked/i);
      assert.equal(jobs(),1);assert.equal(drafts(),0);
      assert.equal((await poll(body)).body.paid,true);
    }finally{await lock.done;}
    club.drainPaidClubSales();
    assert.equal(jobs(),0);assert.equal(drafts(),1);
    await settlePaid(body);club.drainPaidClubSales();
    assert.equal(jobs(),0);assert.equal(drafts(),1);checkPaid(p,body);
    console.log('[checkout-stress] paid Club outbox survived writer lock and duplicate webhook');
  }finally{
    db.prepare('DELETE FROM partner_club_settings WHERE id=1').run();
  }
});

// A prior payment's cleanup reader can briefly hold a shared lock in
// DELETE journal mode. Fixture setup must be atomic and retry the lock,
// just as the real checkout requests do; never retry assertion failures.
async function physicalStockFixture(id){
  const {withImmediateTransaction}=require('./reservations');
  for(let attempt=0;attempt<40;attempt++){
    try{
      return withImmediateTransaction(()=>{
        const p=point(id);
        db.prepare('UPDATE stock SET qty=1 WHERE point_id=? AND variant_id=1').run(p.id);
        db.prepare('DELETE FROM stock WHERE point_id=? AND variant_id=2').run(p.id);
        return p;
      });
    }catch(error){
      if(attempt===39||!/database (?:table )?is locked|database is busy/i.test(error.message))throw error;
      await sleep(50);
    }
  }
}
test('physical shelf confirmation permits zero and partial stock without creating fake available inventory',{timeout:15000},async()=>{
  const p=await physicalStockFixture('stress-physical-stock');
  const body=orderBody(p);
  const initial=await untilResponse(()=>post(body),r=>r.status===409&&r.body.code==='STOCK_CONFIRMATION_REQUIRED');
  assert.equal(initial.status,409,JSON.stringify(initial));
  assert.equal(initial.body.code,'STOCK_CONFIRMATION_REQUIRED');
  assert.equal(initial.body.details.pointId,p.id);
  assert.deepEqual(initial.body.details.items.map(i=>[i.variantId,i.requestedQty,i.availableQty]),[[1,2,1],[2,1,0]]);
  assert.equal(orderCount(body),0);assert.equal(payments.has(body.orderId),false);
  assert.deepEqual(quantities(p),[1]);
  assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,p.id).valid,true);
  const wrong={...body,physicalStockConfirmation:{pointId:'other',items:[{variantId:1,qty:2},{variantId:2,qty:1}]}};
  assert.equal((await untilResponse(()=>post(wrong),r=>r.status===409&&r.body.code==='STOCK_CONFIRMATION_REQUIRED')).body.code,'STOCK_CONFIRMATION_REQUIRED');
  const approved={...body,physicalStockConfirmation:{pointId:p.id,items:[{variantId:1,qty:2},{variantId:2,qty:1}]}};
  const created=await untilResponse(()=>post(approved),r=>[200,201].includes(r.status)&&!!r.body.payment_id);
  assert.equal(created.body.payment_id,gatewayPayment(body.orderId).payment.id);
  const row=order(body);
  const adjusted=()=>db.prepare('SELECT variant_id,qty,physical_stock_added_qty FROM order_items WHERE order_id=? ORDER BY variant_id').all(row.id).map(i=>[i.variant_id,i.qty,i.physical_stock_added_qty]);
  assert.deepEqual(adjusted(),[[1,2,1],[2,1,1]]);
  assert.deepEqual(quantities(p),[0],'pending correction is not available');
  const other=orderBody(p);
  other.physicalStockConfirmation=approved.physicalStockConfirmation;
  assert.equal((await untilResponse(()=>post(other),r=>r.status===409&&r.body.code==='STOCK_UNAVAILABLE')).body.code,'STOCK_UNAVAILABLE','never steal another active reservation');
  assert.equal(orderCount(other),0);assert.equal(payments.has(other.orderId),false);
  await settlePaid(approved);
  assert.equal(order(body).status,'paid');
  assert.deepEqual(quantities(p),[0,0],'shortfall received then immediately consumed');
  assert.deepEqual(adjusted(),[[1,2,1],[2,1,1]]);
  await settlePaid(approved);
  assert.equal(orderCount(body),1);
  assert.deepEqual(quantities(p),[0,0]);
  const customer=db.prepare('SELECT orders_count,total_spent FROM customers WHERE phone=?').get(body.customerPhone.replace(/\D/g,''));
  assert.equal(customer.orders_count,1);assert.equal(customer.total_spent,680);
  assert.equal(promoCount(body),1);
  const message=require('./telegram').buildOrderMessage(order(body),db.prepare('SELECT * FROM order_items WHERE order_id=?').all(row.id));
  assert.match(message,/Расхождение остатков/);
  assert.match(message,/\+1 шт\., сразу списано/);
});
test('cancellation restores only originally recorded units and leaves first-order promo usable',{timeout:15000},async()=>{
  const p=await physicalStockFixture('stress-physical-cancel');
  const body=orderBody(p);
  body.physicalStockConfirmation={pointId:p.id,items:[{variantId:1,qty:2},{variantId:2,qty:1}]};
  await untilResponse(()=>post(body),r=>[200,201].includes(r.status)&&!!r.body.payment_id);
  providerStatus(body.orderId,'canceled');
  await Promise.all([hook(body),hook(body),poll(body)]);
  await untilResponse(()=>poll(body),r=>r.status===200&&r.body.status==='failed');
  assert.deepEqual(quantities(p),[1]);assert.equal(promoCount(body),0);
  assert.equal(validateFirstPurchasePromo('HV15',body.customerPhone,p.id).valid,true);
  assert.equal((await untilResponse(()=>post(body),r=>r.status===409)).status,409);
  assert.deepEqual(quantities(p),[1]);
});
test('physical confirmation never overrides warehouse delivery shortages',()=>{
  const {reserveForOrder,withImmediateTransaction}=require('./reservations');
  assert.throws(()=>withImmediateTransaction(()=>reserveForOrder(999999,{type:'warehouse',id:'krsk'},
    [{variantId:1,name:'Лёгкое',weight:'50 г',qty:99}],null,0,
    {pointId:'krsk',items:[{variantId:1,qty:99}]})),e=>e.code==='STOCK_UNAVAILABLE');
});
