'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/miniapp-reliability.js'),'utf8');
const sw=fs.readFileSync(path.join(__dirname,'../public/sw.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
function setup(handler,overrides={}){
 const calls=[],events={}, navigator={onLine:true,userAgent:'iPhone',...overrides.navigator};
 const window={Telegram:{WebApp:{platform:'ios',version:'8.1'}},
   addEventListener(name,fn){events[name]=fn;}};
 const document={currentScript:{src:'https://test.local/miniapp-reliability.js?v=12345678901234567890'},
   body:null,addEventListener(){}};
 const fetch=(url,opts)=>{
   calls.push({url,opts});
   if(url==='/api/miniapp/diagnostics')return Promise.resolve({ok:true,status:200});
   return handler(url,opts);
 };
 vm.runInNewContext(source,{window,document,navigator,fetch,
   URL,Promise,Date,console,AbortController,
   setTimeout:overrides.setTimeout||setTimeout,clearTimeout:overrides.clearTimeout||clearTimeout});
 return {calls,events,navigator,reliable:window.HvostMiniAppReliability};
}
test('GET may retry after a failed connection, POST is never replayed',async()=>{
 let getCount=0,postCount=0;
 const h=setup(url=>{
   if(url==='/api/products')return ++getCount===1?Promise.reject(Error('offline')):
     Promise.resolve({ok:true,status:200});
   if(url==='/api/create-payment'){postCount++;return Promise.reject(Error('offline'));}
   throw Error('unexpected '+url);
 });
 const ok=await h.reliable.request('/api/products');
 assert.equal(ok.status,200);
 assert.equal(getCount,2);
 await assert.rejects(h.reliable.request('/api/create-payment',{method:'POST'}),e=>e.code==='network');
 assert.equal(postCount,1);
 const events=h.calls.filter(x=>x.url==='/api/miniapp/diagnostics');
 assert.ok(events.some(x=>JSON.parse(x.opts.body).stage==='payment'));
});
test('unresponsive POST times out and does not retry',async()=>{
 const h=setup(()=>new Promise(()=>{}),{
   setTimeout(fn){Promise.resolve().then(fn);return 1;},clearTimeout(){}});
 await assert.rejects(h.reliable.request('/api/miniapp/accounts',{method:'POST'}),e=>e.code==='timeout');
 assert.equal(h.calls.filter(x=>x.url==='/api/miniapp/accounts').length,1);
});
test('network recovery is bound to online event and does not submit a payment',async()=>{
 const h=setup(()=>Promise.resolve({ok:true}));
 let count=0;
 h.reliable.registerRecovery(async()=>{count++;});
 h.navigator.onLine=false;h.events.offline();
 h.navigator.onLine=true;h.events.online();
 await new Promise(r=>setImmediate(r));
 assert.equal(count,1);
 await h.reliable.retry();
 assert.equal(count,2);
});
test('no PII or raw error messages in runtime diagnostics',()=>{
 const h=setup(()=>Promise.resolve({ok:true}));
 h.events.error({message:'79131234567 Authorization Bearer secret'});
 const payload=JSON.parse(h.calls.find(x=>x.url==='/api/miniapp/diagnostics').opts.body);
 assert.equal(payload.stage,'runtime');
 assert.doesNotMatch(JSON.stringify(payload),/79131234567|Authorization|secret|initData|user_id/);
});
test('Mini App loads reliability before auth and prevents blind payment retries',()=>{
 assert.ok(html.indexOf('src="/miniapp-reliability.js"')<html.indexOf('src="/miniapp-identity.js"'));
 assert.match(html,/registerRecovery\(refreshReadOnlyAfterReconnect\)/);
 assert.match(html,/paymentUncertain/);
 const payment=html.slice(html.indexOf('async function payImpl()'),html.indexOf('function showCheckoutError('));
 assert.match(payment,/state\.pendingCode=orderCode;state\.pendingPublicNumber=null;paymentRequestStarted=true;var data;for\(var round=0;round<4;round\+\+\)\{try\{data=await api/);
 assert.match(payment,/if\(error\.code!=='STOCK_CONFIRMATION_REQUIRED'\|\|round===3\)throw error/);
 assert.match(payment,/var next=await window\.HvostPhysicalStock\.resolve\(\{code:error\.code,details:error\.details\},paymentBody\)/);
 assert.match(payment,/if\(!next\)\{[^}]*state\.pendingCode='';state\.paymentUncertain=false;setView\('cart'\);return;/);
 assert.match(payment,/paymentBody=next;if\(androidHosted\)window\.HvostAndroidPayment\.remember\(orderCode,'miniapp',paymentBody\)/);
 assert.match(html,/if\(paymentRequestStarted&&e&&\['timeout','network','offline','server'\]/);
});
test('Mini App only resubmits the same payment after explicit physical-stock confirmation',async()=>{
 const payment=html.slice(html.indexOf('async function payImpl()'),html.indexOf('function showCheckoutError('));
 for(const scenario of ['yes','no','network']){
  const calls=[],views=[],results=[],remembered=[],cleared=[];
  const fields={buyerName:{value:'Test'},buyerPhone:{value:'+79990001122'},advisorSelect:{value:'self'},promoInput:{value:''},payButton:{}};
  const state={verified:true,pointId:'salon',cart:[{variantId:1,qty:2}],email:'',pendingCode:'',paymentUncertain:false};
  const code='TMA-1795670000000-abcdef1234567890';
  const error=Object.assign(Error('Stock mismatch'),{code:'STOCK_CONFIRMATION_REQUIRED',details:{pointId:'salon',items:[{variantId:1,requestedQty:2,name:'Test'}]}});
  const context={state,window:{HvostAndroidPayment:{hosted:()=>true,newCode:()=>code,remember:(id,flow,body)=>remembered.push({id,flow,body}),clear:id=>cleared.push(id)},HvostPhysicalStock:{resolve:async(data,body)=>{
   assert.equal(data.code,'STOCK_CONFIRMATION_REQUIRED');
   return scenario==='yes'?{...body,physicalStockConfirmation:{pointId:'salon',items:[{variantId:1,qty:2}]}}:null;
  }}},currentPoint:()=>({id:'salon',name:'Salon'}),el:id=>fields[id],
  cleanPhone:x=>x,reloadStock:async()=>true,checkoutTotal:()=>500,money:String,
  api:async(url,opts)=>{assert.equal(url,'/api/create-payment');const body=JSON.parse(opts.body);calls.push(body);
   if(calls.length===1)throw scenario==='network'?Object.assign(Error('Connection lost'),{code:'network'}):error;
   return {display_number:'HM-1',confirmation_url:'https://bank.example'};
  },
  setView:v=>views.push(v),showResult:(...args)=>results.push(args),showCheckoutError:msg=>{throw Error(msg)},toast(){},Date,Math};
  vm.createContext(context);vm.runInContext(payment,context);await context.payImpl();
  assert.equal(calls.length,scenario==='yes'?2:1);
  assert.equal(calls[0].orderId,code);
  if(scenario==='yes'){
   assert.equal(calls[1].orderId,code);
   assert.equal(calls[1].amount,calls[0].amount);
   assert.deepEqual(calls[1].cartItems,calls[0].cartItems);
   assert.deepEqual(calls[1].physicalStockConfirmation,{pointId:'salon',items:[{variantId:1,qty:2}]});
   assert.equal(remembered.length,2);
   assert.equal(state.paymentUncertain,true);
   assert.equal(results[0][0],'pending');
  }else if(scenario==='no'){
   assert.deepEqual(views,['cart']);
   assert.equal(state.pendingCode,'');
   assert.deepEqual(cleared,[code]);
   assert.equal(state.cart.length,1);
  }else{
   assert.equal(state.paymentUncertain,true);
   assert.equal(results[0][0],'pending');
   assert.equal(remembered.length,1);
   assert.equal(cleared.length,0);
  }
 }
});
test('SW never intercepts HTML, APIs, config or unversioned JS',()=>{
 const events={},self={location:{origin:'https://test.local'},
   addEventListener(k,fn){events[k]=fn;},clients:{claim(){}},skipWaiting(){}};
 const caches={keys:async()=>[],open:async()=>({put(){}}),delete:async()=>true,match:async()=>null};
 vm.runInNewContext(sw,{self,caches,fetch:async()=>({ok:true}),URL,Promise});
 const intercept=(path,mode='cors')=>{
   let caught=false;
   events.fetch({request:{method:'GET',url:'https://test.local'+path,mode},
     respondWith(){caught=true;}});
   return caught;
 };
 for(const p of ['/miniapp.html','/api/products','/api/miniapp/accounts',
   '/taiga-groomer.html','/config.js','/sw.js','/miniapp-work.js'])
   assert.equal(intercept(p),false,p);
 assert.equal(intercept('/miniapp-work.js?v=0123456789abcdef0123'),true);
});
