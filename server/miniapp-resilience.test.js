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
 assert.match(html,/state\.pendingCode=orderCode;var data=await api/);
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
