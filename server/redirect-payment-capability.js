'use strict';

// Only opaque order codes explicitly issued for a hosted redirect checkout
// can act as capabilities. Never expose a bank link via a short public number
// or the old predictable TG-<timestamp> / TMA-<timestamp>-<short> codes.
function redirectPaymentPath(order) {
  if(!order||order.payment_method!=='yookassa'||!order.payment_return_url)return null;
  const code=String(order.order_code||'');
  const match=/^(TG|TMA)-\d{13}-[a-f0-9]{16}$/.exec(code);
  if(!match)return null;
  try{
    const url=new URL(order.payment_return_url);
    if(!/^https?:$/.test(url.protocol)||url.username||url.password||
      url.searchParams.get('payment_return')!==code)return null;
    const path=url.pathname;
    if(match[1]==='TG'&&(path==='/'||/^\/p\/[-A-Za-z0-9._~%]+\/[-A-Za-z0-9._~%]+\/?$/.test(path)))return path;
    if(match[1]==='TMA'&&path==='/miniapp.html')return path;
  }catch(_){}
  return null;
}
function safeProviderUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch(_){return null;}
}
function paymentMatchesOrder(order,payment){
  return !!(payment&&payment.id&&payment.metadata?.order_code===order.order_code&&
    payment.amount?.currency==='RUB'&&Math.round(Number(payment.amount.value)*100)===Math.round(Number(order.total)*100)&&
    (!order.yookassa_payment_id||payment.id===order.yookassa_payment_id));
}
function redirectContinuation(order,payment,now=Date.now()){
  const path=redirectPaymentPath(order);
  if(!path)return {};
  const expiry=Date.parse(String(order.reservation_expires_at||'').replace(' ','T')+'Z');
  const active=order.status==='pending'&&order.reservation_status==='active'&&Number.isFinite(expiry)&&expiry>now;
  const url=active&&paymentMatchesOrder(order,payment)&&payment.status==='pending'&&
    payment.confirmation?.type==='redirect'?safeProviderUrl(payment.confirmation.confirmation_url):null;
  return {return_path:path+'?payment_return='+encodeURIComponent(order.order_code),
    confirmation_url:url||null,reservation_expires_at:order.reservation_expires_at||null,
    reservation_expired:order.status==='pending'&&Number.isFinite(expiry)&&expiry<=now,
    can_recover:!!(active&&!order.yookassa_payment_id)};
}
module.exports={redirectPaymentPath,safeProviderUrl,paymentMatchesOrder,redirectContinuation};
