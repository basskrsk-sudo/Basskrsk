'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The receipt helper loads the DB module. Never touch live or developer data.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-qr-recovery-'));
process.env.DATA_DIR = temp;
const { storedQrPaymentArgs } = require('./qr-payment-recovery');
const order = {
  order_code:'TG-1795194600000-abcdef1234567890',
  customer_phone:'+79130000001',customer_email:null,
  payment_method:'yookassa',payment_return_url:'https://xn--80adktilqfjfx.xn--p1ai/p/salon/lung?payment_return=TG-1795194600000-abcdef1234567890',
  fulfillment_type:'pickup',point_id:'salon',
  subtotal:250,discount:50,total:200,delivery_fee:0,bones_used:0,
};
const items=[{variant_id:1,name:'Лёгкое',weight:'50 г',price:250,qty:1}];
test('ambiguous QR payment reconstructs identical receipt and stable return URL',()=>{
  const args=storedQrPaymentArgs(order,items);
  assert.equal(args.amount,200);
  assert.equal(args.orderCode,order.order_code);
  assert.equal(args.confirmationMode,'redirect');
  assert.equal(args.returnUrl,order.payment_return_url);
  assert.equal(args.receiptItems[0].amount.value,'200.00');
});
test('legacy, incomplete and non-QR orders cannot be recreated automatically',()=>{
  assert.equal(storedQrPaymentArgs({...order,order_code:'TG-1699'},items),null);
  assert.equal(storedQrPaymentArgs({...order,payment_return_url:null},items),null);
  assert.equal(storedQrPaymentArgs({...order,total:999},items),null);
  assert.equal(storedQrPaymentArgs({...order,fulfillment_type:'home_delivery'},items),null);
});
test.after(()=>{
  try { require('./db').close(); } catch(_) {}
  fs.rmSync(temp, { recursive:true, force:true });
});
