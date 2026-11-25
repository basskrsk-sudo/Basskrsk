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
function helper(ua='Android Chrome',extra={}){
 const localStorage=store(),sessionStorage=store(),navigations=[];
 const window={navigator:{userAgent:ua,...extra},crypto:webcrypto,localStorage,sessionStorage,location:{origin:'https://example.test',assign:x=>navigations.push(x)}};
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
function harness(responses,withSnapshot=false,ua='Android Chrome',extra={}){
 const h=helper(ua),els={},events={},requests=[];
 const document={hidden:false,getElementById(id){return els[id]||(els[id]={hidden:true,disabled:false,textContent:'',href:'',focus(){},select(){}});},addEventListener:(name,fn)=>events[name]=fn};
 h.window.addEventListener=(name,fn)=>events[name]=fn;
 const body={orderId:code,confirmationMode:'redirect',bonesUsed:0,cartItems:[{variantId:1,qty:2}],...extra.body};
 h.api.remember(code,'qr',withSnapshot?body:null);
 if(extra.seed)extra.seed(h,body);
 const fetch=async(url,opts)=>{requests.push({url,method:opts.method,body:opts.body});const r=responses.shift();if(!r)throw Error('unexpected request');if(r.wait)await r.wait;if(r.error)throw Error(r.error);return {status:r.status||200,ok:(r.status||200)<300,json:async()=>r.data||{}}};
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
test('iPhone Safari, iOS Telegram, iPad desktop mode and Android share hosted checkout; desktop stays unchanged',()=>{
 for(const ua of ['iPhone Safari','iPhone CriOS','iPhone Telegram','iPad Safari','iPod Safari','Android Chrome']){
  assert.equal(helper(ua).api.hosted(),true,ua);
 }
 assert.equal(helper('Macintosh Safari',{platform:'MacIntel',maxTouchPoints:5}).api.hosted(),true);
 assert.equal(helper('Macintosh Safari',{platform:'MacIntel',maxTouchPoints:0}).api.hosted(),false);
 assert.equal(helper('Windows Chrome').api.hosted(),false);
 for(const file of ['index.html','p.html','miniapp.html'])assert.match(source(file),/HvostAndroidPayment\??\.hosted\(\)/);
});
test('iOS storage restrictions keep order pointer and exact snapshot in the original tab',()=>{
 const h=helper('iPhone Safari'),a=h.api,c=a.newCode('TG');
 h.window.localStorage.setItem=()=>{throw Error('storage restricted');};
 const body={orderId:c,confirmationMode:'redirect',customerPhone:'+79990000000',promoCode:'HV20',cartItems:[{variantId:1,qty:2}]};
 a.remember(c,'catalog',body);
 assert.equal(a.pending('catalog').code,c);
 assert.equal(a.snapshot(c).promoCode,'HV20');
 assert.equal(a.snapshot(c).cartItems[0].qty,2);
 a.external(c,{openLink(){throw Error('Telegram unavailable');}});
 assert.equal(h.navigations[0],'/pay.html?order='+c);
 a.clear(c);assert.equal(a.pending(),null);assert.equal(a.snapshot(c),null);
});
test('iOS fast return from bank checks only the same order, hides link after payment',async()=>{
 const h=harness([{data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url}},{data:{status:'paid',paid:true,return_path:'/p/salon/lung?payment_return='+code}}],false,'iPhone Safari');
 await flush();assert.equal(h.els.payLink.hidden,false);
 h.els.payLink.onclick();h.events.focus();await flush();
 assert.equal(h.requests.length,2);
 assert.ok(h.requests.every(r=>r.method==='GET'&&r.url.endsWith(code)));
 assert.equal(h.els.payLink.hidden,true);assert.equal(h.els.result.hidden,false);
});
test('checkout scripts compile and the shared mobile hosted path has no iframe dependency',()=>{
 for(const file of ['index.html','miniapp.html','p.html','pay.html'])for(const match of source(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
 assert.match(source('index.html'),/!androidHosted && await prepareYooKassaWidget/);
 assert.match(source('miniapp.html'),/HvostAndroidPayment\?\.external/);
 assert.match(source('p.html'),/HvostAndroidPayment\.remember\(saved\.orderId,'qr',saved\.body\)/);
 assert.match(source('pay.html'),/name="referrer" content="no-referrer"/);
});

test('reservation expiry is calculated by the server and does not imply payment cancellation',()=>{
 const expired=redirectContinuation(order,payment,now+6*60000);
 assert.equal(expired.reservation_expired,true);
 assert.equal(expired.confirmation_url,null);
 assert.equal(expired.can_recover,false);
 assert.equal(redirectContinuation(order,payment,now).reservation_expired,false);
 assert.equal(redirectContinuation({...order,status:'paid'},payment,now+6*60000).reservation_expired,false);
});
test('expired reservation remains unresolved until confirmed canceled or paid',async()=>{
 const h=harness([{data:{status:'pending',reservation_expired:true,can_recover:false}},{data:{status:'failed',return_path:'/p/salon/lung?payment_return='+code}}]);
 await flush();
 assert.equal(h.els.title.textContent,'Время резерва истекло');
 assert.equal(h.els.payLink.hidden,true);assert.equal(h.els.recover.hidden,true);
 assert.equal(h.els.result.hidden,true);assert.equal(h.api.pending().code,code);
 h.els.check.onclick();await flush();
 assert.equal(h.els.title.textContent,'Платёж отменён');
 assert.equal(h.els.result.hidden,false);assert.equal(h.api.pending(),null);
 assert.ok(h.requests.every(r=>r.method==='GET'));
});
for(const errorCode of ['ADVISOR_SELECTION_REQUIRED','PARTNER_POINT_MISMATCH','FIRST_PURCHASE_PROMO_INVALID','ORDER_TOTAL_CHANGED','AMBIGUOUS_VARIANT','SELF_ORDER_BONES_FORBIDDEN']){
 test('definitive '+errorCode+' and missing order allow editing without clearing basket',async()=>{
  const basket='basket-stays';
  const h=harness([{status:404},{status:409,data:{code:errorCode,error:'Проверьте данные заказа'}},{status:404}],true,'iPhone Safari',{
   body:{pointId:'salon',returnPath:'/p/salon/lung',promoCode:'HV20'},
   seed(h,body){
    h.localStorage.setItem('hm_qr_pending_v1:salon',JSON.stringify({orderId:code,body}));
    h.sessionStorage.setItem('hvost_qr_payment:/p/salon/lung',JSON.stringify({orderId:code,body}));
    h.localStorage.setItem('hm_qr_pending_v1:other',JSON.stringify({orderId:'another'}));
    h.localStorage.setItem('basket',basket);
   }});
  await flush();await h.els.recover.onclick();
  assert.deepEqual(h.requests.map(r=>r.method),['GET','POST','GET']);
  assert.equal(JSON.parse(h.requests[1].body).promoCode,'HV20');
  assert.equal(h.api.pending(),null);assert.equal(h.api.snapshot(code),null);
  assert.equal(h.localStorage.getItem('hm_qr_pending_v1:salon'),null);
  assert.equal(h.sessionStorage.getItem('hvost_qr_payment:/p/salon/lung'),null);
  assert.equal(h.localStorage.getItem('basket'),basket);
  assert.ok(h.localStorage.getItem('hm_qr_pending_v1:other'));
  assert.equal(h.els.result.href,'/p/salon/lung');assert.equal(h.els.result.hidden,false);
  assert.equal(h.els.recover.hidden,true);assert.equal(h.els.check.hidden,true);
 });
}
test('validation failure never removes another attempt or basket',async()=>{
 const h=harness([{status:404},{status:409,data:{code:'PARTNER_POINT_MISMATCH'}},{status:404}],true,'Android Chrome',{
  body:{pointId:'salon',returnPath:'/p/salon/lung'},seed(h){h.localStorage.setItem('hm_qr_pending_v1:salon',JSON.stringify({orderId:'newer'}));}
 });
 await flush();await h.els.recover.onclick();
 assert.equal(JSON.parse(h.localStorage.getItem('hm_qr_pending_v1:salon')).orderId,'newer');
});
test('a validation error cannot discard an existing or paid order',async()=>{
 const h=harness([{status:404},{status:409,data:{code:'PARTNER_POINT_MISMATCH'}},{data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url}}],true);
 await flush();await h.els.recover.onclick();
 assert.equal(h.requests.length,3);
 assert.equal(h.api.pending().code,code);assert.equal(h.els.payLink.hidden,false);
});
test('temporary or ambiguous failures preserve the original checkout',async()=>{
 for(const response of [{status:503,data:{code:'PAYMENT_NOT_CONFIGURED'}},{status:409,data:{code:'PAYMENT_RETRY_MISMATCH'}},{error:'lost response'}]){
  const h=harness([{status:404},response,{status:404}],true);
  await flush();await h.els.recover.onclick();
  assert.equal(h.api.pending().code,code);assert.ok(h.api.snapshot(code));
  assert.equal(h.els.result.hidden,true);assert.equal(h.els.recover.hidden,false);
  assert.deepEqual(h.requests.map(r=>r.method),['GET','POST','GET']);
 }
});
test('missing order in another browser advises returning to original tab without a POST',async()=>{
 const h=harness([{status:404},{status:404}],false,'iPhone Safari');
 await flush();
 assert.match(h.els.message.textContent,/Вернитесь туда/);
 assert.equal(h.els.recover.hidden,true);
 h.els.check.onclick();await flush();
 assert.ok(h.requests.every(r=>r.method==='GET'));
 assert.equal(h.api.pending().code,code);
});
test('bank return and reconnect during in-flight status check queue exactly one read-only check',async()=>{
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const h=harness([{wait:gate,data:{status:'pending',confirmation_url:payment.confirmation.confirmation_url}},{data:{status:'paid',paid:true,return_path:'/p/salon/lung?payment_return='+code}}],false,'iPhone Safari');
 assert.equal(h.requests.length,1);
 h.events.pageshow({persisted:true});h.events.online();h.events.online();
 assert.equal(h.requests.length,1);
 release();await flush();await flush();
 assert.equal(h.requests.length,2);
 assert.ok(h.requests.every(r=>r.method==='GET'));
 assert.equal(h.els.payLink.hidden,true);assert.equal(h.els.result.hidden,false);
});
test('unconfirmed Telegram checkout prefers original tab instead of losing retry snapshot',()=>{
 const mini=source('miniapp.html');
 assert.match(mini,/originalNeeded=!!window\.HvostAndroidPayment\?\.snapshot\(code\)&&publicNumber===code/);
 assert.match(mini,/originalNeeded\?'<a class="btn btn-gold" href="/);
 assert.match(mini,/Открыть оплату в браузере/);
});
