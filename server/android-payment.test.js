'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {redirectPaymentPath,redirectContinuation,paymentMatchesOrder}=require('./redirect-payment-capability');
const code='TG-1795194600000-abcdef1234567890';
const now=Date.parse('2026-11-24T12:00:00Z');
const order={order_code:code,total:850,status:'pending',reservation_status:'active',
 reservation_expires_at:'2026-11-24 12:05:00',payment_method:'yookassa',yookassa_payment_id:'pay-one',
 payment_return_url:'https://example.test/p/salon/lung?payment_return='+code};
const payment={id:'pay-one',status:'pending',metadata:{order_code:code},amount:{value:'850.00',currency:'RUB'},confirmation:{type:'redirect',confirmation_url:'https://yookassa.ru/pay/one'}};
test('same pending payment may be continued in another Android browser, not guessed by the short public number',()=>{
 assert.equal(redirectPaymentPath(order),'/p/salon/lung');
 const result=redirectContinuation(order,payment,now);
 assert.equal(result.confirmation_url,payment.confirmation.confirmation_url);
 assert.equal(result.return_path,'/p/salon/lung?payment_return='+code);
 assert.equal(result.can_recover,false);
 for(const o of [{...order,order_code:'TG-1795194600000'},{...order,order_code:'ХМ-00001'},{...order,payment_return_url:'https://example.test/?payment_return=wrong'},{...order,payment_method:'sbp'}])assert.deepEqual(redirectContinuation(o,payment,now),{});
});
test('never show payment link after expiration, payment, cancellation or mismatch',()=>{
 for(const o of [{...order,status:'paid'},{...order,status:'failed'},{...order,reservation_status:'released'},{...order,reservation_expires_at:'2026-11-24 11:59:59'}])assert.equal(redirectContinuation(o,payment,now).confirmation_url,null);
 for(const p of [{...payment,status:'succeeded'},{...payment,id:'pay-other'},{...payment,amount:{value:'849.00',currency:'RUB'}},{...payment,metadata:{order_code:'other'}},{...payment,confirmation:{type:'redirect',confirmation_url:'javascript:alert(1)'}}])assert.equal(redirectContinuation(order,p,now).confirmation_url,null);
 assert.equal(paymentMatchesOrder(order,payment),true);
 assert.equal(redirectContinuation({...order,yookassa_payment_id:null},null,now).can_recover,true);
 assert.equal(redirectContinuation({...order,yookassa_payment_id:null},null,now+6*60000).can_recover,false);
});
test('hosted catalog and Mini App use capability only on the intended return path',()=>{
 const root={...order,payment_return_url:'https://example.test/?payment_return='+code};
 const miniCode=code.replace(/^TG-/,'TMA-');
 const mini={...order,order_code:miniCode,payment_return_url:'https://example.test/miniapp.html?payment_return='+miniCode};
 assert.equal(redirectPaymentPath(root),'/');
 assert.equal(redirectPaymentPath(mini),'/miniapp.html');
 assert.equal(redirectPaymentPath({...mini,payment_return_url:'https://example.test/?payment_return='+miniCode}),null);
});
function store(){const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),values:()=>Array.from(m.values())};}
const source=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
function helper(ua='Android Chrome'){
 const localStorage=store(),sessionStorage=store(),navigations=[];
 const window={navigator:{userAgent:ua},crypto:webcrypto,localStorage,sessionStorage,location:{origin:'https://example.test',assign:x=>navigations.push(x)}};
 vm.runInNewContext(source('android-payment.js'),{window,Date,URL,Uint8Array});
 return{api:window.HvostAndroidPayment,window,localStorage,sessionStorage,navigations};
}
test('Android detection, opaque IDs, tab-local request, matching cleanup and Telegram external link',()=>{
 const h=helper(),a=h.api,c=a.newCode('TMA'),b={orderId:c,confirmationMode:'redirect',customerPhone:'+79990000000',cartItems:[{variantId:1,qty:2}]};
 assert.equal(a.android(),true);assert.equal(helper('iPhone').api.android(),false);
 assert.match(c,/^TMA-\d{13}-[a-f0-9]{16}$/);
 a.remember(c,'miniapp',b);
 assert.equal(a.pending().code,c);assert.equal(a.snapshot(c).cartItems[0].qty,2);
 assert.ok(!h.localStorage.values().join('').includes('79990000000'));
 a.clear(code);assert.equal(a.pending().code,c);
 let external='';a.external(c,{openLink:u=>external=u});
 assert.equal(external,'https://example.test/pay.html?order='+c);
 assert.equal(h.navigations.length,0);
 a.clear(c);assert.equal(a.pending(),null);assert.equal(a.snapshot(c),null);
});
function harness(responses,withSnapshot=false){
 const h=helper(),els={},events={},requests=[];
 const document={hidden:false,getElementById(id){return els[id]||(els[id]={hidden:true,disabled:false,textContent:'',href:'',focus(){},select(){}});},addEventListener:(name,fn)=>events[name]=fn};
 h.window.addEventListener=(name,fn)=>events[name]=fn;
 const body={orderId:code,confirmationMode:'redirect',bonesUsed:0,cartItems:[{variantId:1,qty:2}]};
 h.api.remember(code,'qr',withSnapshot?body:null);
 const fetch=async(url,opts)=>{requests.push({url,method:opts.method,body:opts.body});const r=responses.shift();if(!r)throw Error('unexpected request');if(r.error)throw Error(r.error);return {status:r.status||200,ok:(r.status||200)<300,json:async()=>r.data||{}}};
 const context={window:h.window,document,location:{origin:'https://example.test',search:'?order='+code},URL,URLSearchParams,AbortController,Date,fetch,setTimeout,clearTimeout,navigator:{},localStorage:h.localStorage};
 vm.runInNewContext(source('payment-handoff.js'),context);
 return{...h,els,events,requests};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('bank return checks status without creating payment; terminal state hides bank link',async()=>{
 const h=harness([{data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url,amount:850,return_path:'/p/salon/lung?payment_return='+code}},{data:{status:'paid',paid:true,return_path:'/p/salon/lung?payment_return='+code}}]);
 await flush();
 assert.equal(h.els.payLink.hidden,false);assert.equal(h.requests.length,1);
 h.events.pageshow({persisted:true});await flush();
 assert.equal(h.requests.length,2);assert.ok(h.requests.every(r=>r.method==='GET'));
 assert.equal(h.els.payLink.hidden,true);assert.equal(h.els.result.hidden,false);assert.equal(h.api.pending(),null);
});
test('no POST on automatic retry; explicit recovery uses original existing order',async()=>{
 const h=harness([{data:{status:'pending',can_recover:true}},{data:{status:'checked'}},{data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url}}]);
 await flush();assert.equal(h.requests.length,1);assert.equal(h.els.recover.hidden,false);
 await h.els.recover.onclick();assert.equal(h.requests[1].url,'/api/redirect-payment/'+code+'/resume');assert.equal(h.requests[1].method,'POST');assert.equal(h.requests[2].method,'GET');
});
test('request not received: explicit retry uses exact saved orderId, never creates a fresh code',async()=>{
 const h=harness([{status:404},{status:201,data:{}},{data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url}}],true);
 await flush();assert.equal(h.requests.length,1);assert.equal(h.els.recover.hidden,false);
 await h.els.recover.onclick();assert.equal(h.requests[1].url,'/api/create-payment');assert.equal(JSON.parse(h.requests[1].body).orderId,code);assert.equal(h.requests[2].method,'GET');
});
test('checkout scripts compile and the Android hosted path has no iframe dependency',()=>{
 for(const file of ['index.html','miniapp.html','p.html','pay.html'])for(const match of source(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
 assert.match(source('index.html'),/!androidHosted && await prepareYooKassaWidget/);
 assert.match(source('miniapp.html'),/HvostAndroidPayment\?\.external/);
 assert.match(source('p.html'),/HvostAndroidPayment\.remember\(saved\.orderId,'qr',saved\.body\)/);
 assert.match(source('pay.html'),/name="referrer" content="no-referrer"/);
});
