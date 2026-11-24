'use strict';
const { buildReceiptItems } = require('./order-pricing');
const { redirectPaymentPath } = require('./redirect-payment-capability');
// Identical request body + original idempotency key; only new opaque QR codes.
function storedQrPaymentArgs(order, items) {
  if (!redirectPaymentPath(order) ||
      !['pickup','home_delivery'].includes(order.fulfillment_type) ||
      (order.fulfillment_type==='pickup'&&!order.point_id) ||
      !Array.isArray(items) || items.length < 1 || items.length > 50 ||
      items.some(i=>!i.variant_id||!Number.isSafeInteger(i.qty)||i.qty<1||i.qty>99||!Number.isSafeInteger(i.price)||i.price<1)) return null;
  const subtotal=Number(order.subtotal), discount=Number(order.discount||0);
  const bones=Number(order.bones_used||0), deliveryFee=Number(order.delivery_fee||0);
  const amount=Number(order.total);
  if (![subtotal,discount,bones,deliveryFee,amount].every(Number.isSafeInteger) ||
      subtotal <= 0 || amount < 1 || discount < 0 || bones < 0 ||
      deliveryFee < 0 || subtotal-discount+deliveryFee-bones !== amount) return null;
  if(items.reduce((sum,i)=>sum+i.price*i.qty,0)!==subtotal)return null;
  // Only opaque codes issued for a hosted redirect may be reconstructed.
  if(order.fulfillment_type==='home_delivery'&&redirectPaymentPath(order)!=='/')return null;
  const goodsAfterPromo=subtotal-discount;
  const adjustedGoods=goodsAfterPromo-Math.min(bones,goodsAfterPromo);
  const adjustedDelivery=deliveryFee-(bones-Math.min(bones,goodsAfterPromo));
  if (adjustedGoods < 0 || adjustedDelivery < 0) return null;
  return {
    amount, description: 'Заказ ХвостМаркет ' + order.order_code,
    orderCode: order.order_code,
    receiptItems: buildReceiptItems(items, adjustedGoods, adjustedDelivery),
    customerPhone: order.customer_phone, customerEmail: order.customer_email,
    method: order.payment_method, confirmationMode: 'redirect',
    returnUrl: order.payment_return_url,
  };
}
module.exports={storedQrPaymentArgs};
