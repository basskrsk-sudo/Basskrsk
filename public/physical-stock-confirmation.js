/* Explicit confirmation of physically held goods. No writes or polling here. */
(function(root){
  'use strict';
  function proposal(data,body){
    if(!data||data.code!=='STOCK_CONFIRMATION_REQUIRED'||!body||
       body.fulfillmentType==='home_delivery'||!body.pointId||!Array.isArray(body.cartItems))return null;
    var details=data.details;
    if(!details||String(details.pointId)!==String(body.pointId)||!Array.isArray(details.items)||
      !details.items.length||details.items.length>50)return null;
    var requested=new Map(),items=[],seen=new Set();
    body.cartItems.forEach(function(i){
      var id=Number(i.variantId==null?i.variant_id:i.variantId);
      requested.set(id,(requested.get(id)||0)+Number(i.qty));
    });
    for(var i of details.items){
      if(!Number.isSafeInteger(i.variantId)||i.variantId<1||!Number.isSafeInteger(i.requestedQty)||
        i.requestedQty<1||i.requestedQty>99||requested.get(i.variantId)!==i.requestedQty||seen.has(i.variantId))return null;
      seen.add(i.variantId);
      items.push({variantId:i.variantId,qty:i.requestedQty,name:String(i.name||'Товар'),weight:String(i.weight||'')});
    }
    return {pointId:String(body.pointId),items:items};
  }
  function confirmedBody(body,p){
    var items=new Map(),old=body.physicalStockConfirmation;
    if(old&&old.pointId===p.pointId&&Array.isArray(old.items))old.items.forEach(function(i){items.set(i.variantId,{variantId:i.variantId,qty:i.qty});});
    p.items.forEach(function(i){items.set(i.variantId,{variantId:i.variantId,qty:i.qty});});
    return Object.assign({},body,{physicalStockConfirmation:{pointId:p.pointId,items:Array.from(items.values())}});
  }
  function ask(p,point){
    return new Promise(function(resolve){
      var d=root.document,overlay=d.createElement('div'),panel=d.createElement('div');
      overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(9,29,24,.65);display:flex;align-items:center;justify-content:center;padding:16px;';
      panel.style.cssText='box-sizing:border-box;width:100%;max-width:440px;max-height:85vh;overflow:auto;background:#fff;color:#163b2f;border-radius:18px;padding:20px;box-shadow:0 12px 40px #0003;font:16px/1.45 system-ui,sans-serif;';
      panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','Подтвердите наличие товара');
      function line(tag,value){var e=d.createElement(tag);e.textContent=value;panel.appendChild(e);return e;}
      var title=line('h2','Товар у вас в руках?');title.style.cssText='font-size:22px;margin:0 0 10px;line-height:1.2;';
      line('p','По нашим данным, этих товаров на стойке недостаточно. Возможно, остатки ещё не обновились.');
      if(point)line('p','Минимаркет: '+String(point).slice(0,200));
      var list=d.createElement('ul');list.style.cssText='padding-left:22px;margin:12px 0;';
      p.items.forEach(function(i){var li=d.createElement('li');li.textContent=i.name+(i.weight?' ('+i.weight+')':'')+' — '+i.qty+' шт.';list.appendChild(li);});
      panel.appendChild(list);
      line('p','Подтвердите, что все указанные упаковки действительно есть у вас. Забирайте их только после успешной оплаты.');
      var previous=d.activeElement,closed=false;
      function finish(value){if(closed)return;closed=true;d.removeEventListener('keydown',key);overlay.remove();if(previous&&previous.isConnected&&previous.focus)previous.focus();resolve(value);}
      function button(label,primary,action){var e=line('button',label);e.type='button';e.style.cssText='width:100%;margin:6px 0;padding:14px 8px;border:0;border-radius:10px;font:600 16px system-ui;cursor:pointer;background:'+(primary?'#0a4a38;color:white;':'#e9eee9;color:#163b2f;');e.onclick=function(){finish(action);};return e;}
      var yes=button('Да, все товары у меня',true,true),no=button('Нет, изменить заказ',false,false);
      function key(e){if(e.key==='Escape'){e.preventDefault();finish(false);}if(e.key==='Tab'){e.preventDefault();(d.activeElement===yes?no:yes).focus();}}
      d.addEventListener('keydown',key);overlay.appendChild(panel);d.body.appendChild(overlay);no.focus();
    });
  }
  async function resolve(data,body){
    var p=proposal(data,body);
    if(!p)return null;
    return await ask(p,body.pickupPoint)?confirmedBody(body,p):null;
  }
  root.HvostPhysicalStock={proposal:proposal,confirmedBody:confirmedBody,resolve:resolve};
})(window);
