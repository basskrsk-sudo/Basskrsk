'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=file=>fs.readFileSync(path.join(__dirname,'../public',file),'utf8');
function browser(){
  const children=[],listeners={};
  function node(tag){return {tag,style:{},children:[],isConnected:true,setAttribute(){},appendChild(e){this.children.push(e);},remove(){this.removed=true;},focus(){document.activeElement=this;}};}
  const document={body:node('body'),createElement:node,addEventListener:(k,v)=>listeners[k]=v,removeEventListener:k=>delete listeners[k]};
  const window={document};vm.runInNewContext(source('physical-stock-confirmation.js'),{window});
  return {api:window.HvostPhysicalStock,document,children,listeners};
}
const body={orderId:'same-order',pointId:'salon',fulfillmentType:'pickup',pickupPoint:'Салон',amount:250,cartItems:[{variantId:1,qty:2},{variantId:3,qty:1}],promoCode:'HV15'};
const error={code:'STOCK_CONFIRMATION_REQUIRED',details:{pointId:'salon',items:[{variantId:1,requestedQty:2,availableQty:0,name:'Лёгкое',weight:'50 г'}]}};
test('explicit yes confirms exact quantity and same order, no leaves body unchanged',async()=>{
  const {api,document}=browser();
  const pending=api.resolve(error,body);
  const panel=document.body.children[0].children[0];
  const buttons=panel.children.filter(c=>c.tag==='button');
  assert.equal(buttons.length,2);assert.equal(document.activeElement,buttons[1]);
  assert.match(panel.children[0].textContent,/у вас в руках/);
  buttons[0].onclick();
  const next=await pending;
  assert.equal(next.orderId,body.orderId);assert.equal(next.amount,body.amount);assert.equal(next.promoCode,body.promoCode);
  assert.deepEqual(JSON.parse(JSON.stringify(next.physicalStockConfirmation)),{pointId:'salon',items:[{variantId:1,qty:2}]});
  assert.equal(body.physicalStockConfirmation,undefined);
  const denied=api.resolve(error,body);
  document.body.children[1].children[0].children.filter(c=>c.tag==='button')[1].onclick();
  assert.equal(await denied,null);
});
test('reject cross-point, delivery, quantity changes and unavailable catalog errors',()=>{
  const {api}=browser();
  assert.equal(api.proposal(error,{...body,pointId:'other'}),null);
  assert.equal(api.proposal(error,{...body,fulfillmentType:'home_delivery'}),null);
  assert.equal(api.proposal(error,{...body,cartItems:[{variantId:1,qty:3}]}),null);
  assert.equal(api.proposal({code:'STOCK_UNAVAILABLE'},body),null);
  const p=api.proposal(error,body),next=api.confirmedBody(body,p);
  const second={...error,details:{pointId:'salon',items:[{variantId:3,requestedQty:1,name:'Игрушка'}]}};
  const both=api.confirmedBody(next,api.proposal(second,next));
  assert.equal(both.physicalStockConfirmation.items.length,2);
});
test('all checkout entry points handle server confirmation without disabling zero-stock catalog goods',()=>{
  for(const file of ['p.html','index.html','miniapp.html','pay.html']){
    const html=source(file);assert.match(html,/physical-stock-confirmation\.js\?v=1/);
    for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
  }
  const qr=source('p.html'),catalog=source('index.html'),mini=source('miniapp.html'),handoff=source('payment-handoff.js');
  for(const code of [qr,catalog,mini,handoff])assert.match(code,/HvostPhysicalStock\.resolve/);
  assert.match(qr,/CTX\.selVariant = avail\[0\] \|\| CTX\.variants\[0\]/);
  assert.match(qr,/QR_CART_AVAILABLE\[i\.variantId\]==null/);
  assert.match(qr,/savePendingQrPayment\(saved\)/);
  assert.match(catalog,/Есть на стойке\? Купить/);
  assert.match(mini,/function purchasableVariants/);
  assert.doesNotMatch(mini,/pointStock\(v\)<i\.qty/);
  assert.match(handoff,/snapshot\(code\)/);
  new vm.Script(handoff);
});
