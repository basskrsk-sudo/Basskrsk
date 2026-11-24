/* QR basket: local, point-scoped, no background network activity. */
(function(root){
  'use strict';
  var MAX_LINES=50, MAX_QTY=99, TTL=24*60*60*1000;
  var memory=Object.create(null);
  function key(point){return 'hm_qr_cart_v1:'+String(point);}
  function get(point){
    var raw;
    try{raw=root.localStorage.getItem(key(point));}catch(_){raw=memory[key(point)];}
    try{
      var b=JSON.parse(raw||'null');
      if(!b||Date.now()-b.updatedAt>TTL||!Array.isArray(b.items))return {items:[],revision:''};
      var seen=new Set();
      return {revision:String(b.revision||''),items:b.items.slice(0,MAX_LINES).filter(function(i){
        if(!i||!Number.isSafeInteger(i.variantId)||i.variantId<1||seen.has(i.variantId)||
          !Number.isSafeInteger(i.qty)||i.qty<1||i.qty>MAX_QTY||!Number.isSafeInteger(i.price)||i.price<1)return false;
        seen.add(i.variantId);return true;
      })};
    }catch(_){return {items:[],revision:''};}
  }
  function save(point,items){
    var b={items:items,updatedAt:Date.now(),revision:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)};
    var raw=JSON.stringify(b);
    memory[key(point)]=raw;
    try{root.localStorage.setItem(key(point),raw);}catch(_){}
    return b;
  }
  function add(point,item,available){
    var b=get(point),id=Number(item.variantId),existing=b.items.find(function(i){return i.variantId===id;});
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(Number(item.price))||Number(item.price)<1)
      return {ok:false,error:'Товар недоступен'};
    if((existing?existing.qty:0)>=Math.min(MAX_QTY,Number(available)||0))return {ok:false,error:'Больше нет в наличии на этой точке'};
    if(!existing&&b.items.length>=MAX_LINES)return {ok:false,error:'В корзине слишком много разных товаров'};
    var next={variantId:id,productId:item.productId,slug:String(item.slug||''),name:String(item.name||'Товар'),
      weight:String(item.weight||''),price:Number(item.price),qty:(existing?existing.qty:0)+1};
    if(existing)b.items[b.items.indexOf(existing)]=next;else b.items.push(next);
    return {ok:true,basket:save(point,b.items)};
  }
  function change(point,id,delta,available){
    var b=get(point),i=b.items.find(function(x){return x.variantId===Number(id);});
    if(!i)return {ok:false,error:'Товар уже удалён'};
    if(delta>0&&i.qty>=Math.min(MAX_QTY,Number(available)||0))return {ok:false,error:'Больше нет в наличии на этой точке'};
    i.qty+=delta;
    if(i.qty<=0)b.items=b.items.filter(function(x){return x!==i;});
    return {ok:true,basket:save(point,b.items)};
  }
  function total(items){return items.reduce(function(s,i){return s+i.price*i.qty;},0);}
  function count(items){return items.reduce(function(s,i){return s+i.qty;},0);}
  // A confirmed payment may clear only its own unchanged snapshot. A return
  // to an old receipt must never erase a basket collected afterwards.
  function clearPaid(point,revision){
    if(!revision||get(point).revision!==revision)return false;
    save(point,[]);return true;
  }
  function parseCode(value,origin){
    try{
      var u=new URL(String(value).trim());
      var hosts=['xn--80adktilqfjfx.xn--p1ai','www.xn--80adktilqfjfx.xn--p1ai','xn----7sbal3ajopsm.xn--p1ai','www.xn----7sbal3ajopsm.xn--p1ai','taiga-feed.ru','www.taiga-feed.ru'];
      if(u.protocol!=='https:'&&u.protocol!=='http:')return null;
      if(u.username||u.password||!(hosts.indexOf(u.hostname)>=0||u.origin===origin))return null;
      var m=u.pathname.match(/^\/p\/([^/]+)\/([^/]+)\/?$/);
      var point=m?decodeURIComponent(m[1]):u.pathname==='/'||u.pathname==='/p'?u.searchParams.get('ref'):'';
      var product=m?decodeURIComponent(m[2]):u.pathname==='/'||u.pathname==='/p'?u.searchParams.get('product'):'';
      if(!point||!product||point.length>200||product.length>200||/[/\\\u0000-\u001f]/.test(point+product))return null;
      return {point:point,product:product};
    }catch(_){return null;}
  }
  root.HvostQrCart={get:get,save:save,add:add,change:change,total:total,count:count,clearPaid:clearPaid,parseCode:parseCode,key:key};
})(typeof window!=='undefined'?window:globalThis);
