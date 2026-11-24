'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const page=fs.readFileSync(path.join(__dirname,'../public/p.html'),'utf8');
const cartSource=fs.readFileSync(path.join(__dirname,'../public/qr-cart.js'),'utf8');
const scannerSource=fs.readFileSync(path.join(__dirname,'../public/qr-cart-scanner.js'),'utf8');
function storage(){const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};}
function browser(store=storage()){
  const window={localStorage:store};
  vm.runInNewContext(cartSource,{window,URL,Date});
  return window.HvostQrCart;
}
const lung={variantId:5,productId:11,slug:'lung',name:'Лёгкое',weight:'50 г',price:250};
const toy={variantId:9,productId:12,slug:'toy',name:'Игрушка',weight:'1 шт.',price:300};
test('QR basket persists across pages, sums repeated scans, isolates shops and limits quantities',()=>{
  const store=storage(),a=browser(store),b=browser(store);
  assert.equal(a.add('salon',lung,2).ok,true);
  assert.equal(b.add('salon',lung,2).ok,true);
  assert.equal(a.add('salon',lung,2).ok,false);
  assert.equal(b.add('salon',toy,1).ok,true);
  assert.equal(a.count(a.get('salon').items),3);
  assert.equal(a.total(a.get('salon').items),800);
  assert.equal(a.get('other').items.length,0);
  assert.equal(a.change('salon',5,-1,2).ok,true);
  assert.equal(b.total(b.get('salon').items),550);
  assert.equal(a.change('salon',9,-1,1).ok,true);
  assert.equal(b.get('salon').items.length,1);
});
test('confirmed payment clears only its exact snapshot; old receipt cannot clear newer basket',()=>{
  const a=browser();
  a.add('salon',lung,2);const old=a.get('salon').revision;
  a.add('salon',toy,1);
  assert.equal(a.clearPaid('salon',old),false);
  assert.equal(a.count(a.get('salon').items),2);
  assert.equal(a.clearPaid('salon',a.get('salon').revision),true);
  assert.equal(a.count(a.get('salon').items),0);
});
test('scanner accepts same-origin and legacy printed product QR links, rejects foreign/non-product URLs',()=>{
  const a=browser(),origin='https://xn--80adktilqfjfx.xn--p1ai';
  for(const url of [origin+'/p/salon/lung',origin+'/?ref=salon&product=lung','https://taiga-feed.ru/p/salon/lung']){
    const p=a.parseCode(url,origin);assert.equal(p.point,'salon');assert.equal(p.product,'lung');
  }
  for(const url of ['https://evil.test/p/salon/lung','javascript:alert(1)',origin+'/?ref=salon',origin+'/p/salon/%2Fother',origin+'/account']){
    assert.equal(a.parseCode(url,origin),null,url);
  }
});
test('all inline QR scripts compile and scanning starts only from customer action',()=>{
  for(const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
  new vm.Script(cartSource);new vm.Script(scannerSource);
  assert.match(page,/onclick="scanNextQr\(\)"/);
  assert.match(scannerSource,/getUserMedia/);
  assert.match(scannerSource,/jsQR-1\.4\.0\.js/);
  assert.match(scannerSource,/getTracks\(\)/);
  assert.match(scannerSource,/visibilitychange/);
  assert.doesNotMatch(page,/<script[^>]*src="\/vendor\/jsQR/);
});
test('cart checkout sends every selected item, applies one discount and stores identical retry body',async()=>{
  const api=browser();
  api.add('salon',lung,3);api.add('salon',lung,3);api.add('salon',toy,2);
  const basket=api.get('salon');
  const fields={phone:{value:'+79130000000'},advisor:{value:'self'},qrPromo:{value:'HV20'},payBtn:{isConnected:true}};
  let saved,requested;
  const context={
    QR_PAYMENT_BUSY:false,QR_PAYMENT_PREPARING:false,QR_CHECKOUT_ITEMS:basket.items,QR_CHECKOUT_REVISION:basket.revision,
    QR_PROMO_VALID:true,QR_PROMO_PERCENT:20,QR_PROMO_CODE:'HV20',QR_PUBLIC_NUMBER:'',
    window:{HvostQrCart:api},CTX:{pointId:'salon',point:{name:'Салон',addr:'Адрес'},productSlug:'toy',partners:[{id:1}]},
    location:{pathname:'/p/salon/toy'},Date,document:{getElementById:id=>fields[id]||null},
    readPendingQrPayment:()=>saved||null,savePendingQrPayment:s=>{saved=s;},
    validatePhone:()=>true,normPhone:x=>x,validateQrPromo:async()=>true,rememberPhone(){},
    newQrPaymentCode:()=> 'TG-1795194600000-abcdef1234567890',trackGoalOnce(){},recordQrEvent(){},updateQrPayButton(){},
    runQrPayment:async s=>{requested=s.body;},showErr:m=>{throw Error(m);},showPendingQrPayment(){throw Error('unexpected pending');},
    openQrCart(){throw Error('unexpected cart change');}
  };
  const lines=page.slice(page.indexOf('function qrCheckoutLines()'),page.indexOf('function qrCheckoutSummary('));
  const amount=page.slice(page.indexOf('function qrPayAmount()'),page.indexOf('function updateQrPayButton()'));
  const checkout=page.slice(page.indexOf('async function startPayment()'),page.indexOf('/* ── Экран 4: успех ── */'));
  vm.createContext(context);vm.runInContext(lines+amount+checkout,context);
  await context.startPayment();
  assert.equal(requested.amount,640);
  assert.equal(requested.promoCode,'HV20');
  assert.equal(requested.advisorSelection,'self');
  assert.equal(requested.pointId,'salon');
  assert.deepEqual(JSON.parse(JSON.stringify(requested.cartItems)),[{variantId:5,qty:2},{variantId:9,qty:1}]);
  assert.equal(saved.body,requested);assert.equal(saved.cartRevision,basket.revision);
  assert.equal(saved.items.length,2);
});
test('shared pending checkout survives a new scanned product and cannot be cleared by another receipt',()=>{
  const shared=storage(),session=storage();
  const context={CTX:{pointId:'salon',productSlug:'lung'},location:{pathname:'/p/salon/lung'},localStorage:shared,sessionStorage:session,Date};
  const helpers=page.slice(page.indexOf('var QR_PAYMENT_STORAGE_KEY ='),page.indexOf('function newQrPaymentCode()'));
  vm.createContext(context);vm.runInContext(helpers,context);
  const a={orderId:'TG-test',pointId:'salon',productSlug:'lung',createdAt:Date.now(),body:{cartItems:[{variantId:5,qty:2},{variantId:9,qty:1}]}};
  context.savePendingQrPayment(a);
  context.CTX.productSlug='toy';
  assert.equal(context.readPendingQrPayment().orderId,a.orderId);
  assert.equal(context.readPendingQrPayment().body.cartItems.length,2);
  context.clearPendingQrPayment('other');assert.equal(context.readPendingQrPayment().orderId,a.orderId);
  context.clearPendingQrPayment(a.orderId);assert.equal(context.readPendingQrPayment(),null);
});
