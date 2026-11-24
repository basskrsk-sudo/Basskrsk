/* Standalone handoff page works even when the bank opens a different browser. */
(function(){
  'use strict';
  var el=function(id){return document.getElementById(id);};
  var code=new URLSearchParams(location.search).get('order');
  var valid=window.HvostAndroidPayment.codeValid(code);
  var busy=false,finished=false,lastCheck=0,left=false,missing=false;
  function show(id,on){el(id).hidden=!on;}
  function safePath(path){
    try{
      var u=new URL(path,location.origin);
      return u.origin===location.origin&&u.searchParams.get('payment_return')===code&&
        (u.pathname==='/'||u.pathname==='/miniapp.html'||/^\/p\/[^/]+\/[^/]+\/?$/.test(u.pathname))?u.pathname+u.search:null;
    }catch(_){return null;}
  }
  function providerLink(url){
    try{var u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch(_){return null;}
  }
  async function request(url,method){
    var ac=new AbortController(),timer=setTimeout(function(){ac.abort();},12000);
    try{var res=await fetch(url,{method:method||'GET',cache:'no-store',credentials:'same-origin',signal:ac.signal,referrerPolicy:'no-referrer'});
      return {status:res.status,data:await res.json()};}finally{clearTimeout(timer);}
  }
  function error(message){
    show('payLink',false);show('recover',false);show('result',false);
    el('title').textContent='Не удалось подтвердить статус';
    el('message').textContent=message;
    show('check',valid);show('browserHelp',valid);
  }
  function render(data){
    missing=false;el('recover').textContent='Восстановить этот платёж';
    var path=safePath(data.return_path),link=providerLink(data.confirmation_url);
    show('amount',Number.isSafeInteger(data.amount)&&data.amount>0);
    if(!el('amount').hidden)el('amount').textContent=data.amount.toLocaleString('ru-RU')+' ₽';
    el('orderNumber').textContent='Заказ '+(data.display_number||code);
    show('payLink',false);show('recover',false);show('result',false);
    show('check',true);show('browserHelp',true);
    if(data.paid===true||['failed','canceled','cancelled'].indexOf(data.status)>=0){
      finished=true;window.HvostAndroidPayment.clear(code);
      el('title').textContent=data.paid?'✅ Оплата подтверждена':'Платёж отменён';
      el('message').textContent=data.paid?'Оплата проверена на сервере. Откройте заказ, чтобы увидеть результат.':'Этот платёж не состоялся. Можно вернуться к покупке.';
      if(path){el('result').href=path;show('result',true);}
      show('check',false);show('browserHelp',false);show('foot',false);
      return;
    }
    el('title').textContent=link?'Заказ готов к оплате':'Проверяем платёж';
    el('message').textContent=link?'На защищённой странице ЮKassa выберите СБП и свой банк или оплату картой. После оплаты вернитесь сюда.':
      'Подтверждения пока нет. Если вы уже оплатили в банке, не платите повторно — проверьте этот заказ.';
    if(link){el('payLink').href=link;show('payLink',true);}
    show('recover',data.can_recover===true&&!link);
  }
  async function check(force){
    if(!valid||busy||finished||(!force&&Date.now()-lastCheck<2000))return;
    busy=true;lastCheck=Date.now();el('check').disabled=true;el('recover').disabled=true;
    show('payLink',false);show('recover',false);
    try{
      var result=await request('/api/order-payment-status/'+encodeURIComponent(code));
      if(result.status===404){missing=true;error('Заказ пока не найден. Возможно, создание ещё не завершилось. Если запрос не дошёл до сервера, его можно повторить с тем же номером заказа из исходной вкладки.');var original=window.HvostAndroidPayment.snapshot(code);if(original){el('recover').textContent='Повторить запрос этого заказа';show('recover',true);}return;}
      if(result.status!==200)throw Error('status');
      render(result.data||{});
    }catch(_){error('Проверьте интернет и повторите проверку этого заказа.');}
    finally{busy=false;el('check').disabled=false;el('recover').disabled=false;}
  }
  async function recover(){
    if(!valid||busy||finished)return;
    busy=true;el('recover').disabled=true;el('check').disabled=true;
    try{
      if(missing){
        var body=window.HvostAndroidPayment.snapshot(code);
        if(!body)return;
        var headers={'Content-Type':'application/json'};
        if(Number(body.bonesUsed)>0){var token='';try{token=localStorage.getItem('taiga_customer_token')||'';}catch(_){}if(!token){el('message').textContent='Для оплаты косточками откройте исходную вкладку, в которой вы вошли в аккаунт.';return;}headers.Authorization='Bearer '+token;}
        var ac=new AbortController(),timer=setTimeout(function(){ac.abort();},12000);
        try{var response=await fetch('/api/create-payment',{method:'POST',headers:headers,body:JSON.stringify(body),cache:'no-store',signal:ac.signal});
          var data=await response.json();
          if(data.demo===true){await check(true);return;}
          if(!response.ok&&response.status<500&&data.code&&['ORDER_TOTAL_CHANGED','FIRST_PURCHASE_PROMO_INVALID','STOCK_UNAVAILABLE','VARIANT_NOT_FOUND','VARIANT_INACTIVE','POINT_UNAVAILABLE','ADVISOR_SELECTION_ERROR','INVALID_QUANTITY','INVALID_CATALOG_PRICE'].includes(data.code)){
            // The request was rejected before payment. Do not silently change its total.
            var p=body.returnPath||'/';if(!/^\/(?:miniapp\.html|p\/[^/]+\/[^/]+\/?)?$/.test(p))p='/';
            var probe=await request('/api/order-payment-status/'+encodeURIComponent(code));
            if(probe.status===404){window.HvostAndroidPayment.clear(code);finished=true;el('title').textContent='Проверьте заказ';el('message').textContent=data.error||'Изменились условия заказа.';el('result').href=p;show('result',true);show('recover',false);show('check',false);return;}
          }
        }finally{clearTimeout(timer);}
      }else await request('/api/redirect-payment/'+encodeURIComponent(code)+'/resume','POST');
    }
    catch(_){}
    finally{busy=false;el('recover').disabled=false;el('check').disabled=false;await check(true);}
  }
  el('check').onclick=function(){check(true);};el('recover').onclick=recover;
  el('payLink').onclick=function(){left=true;};
  el('copy').onclick=async function(){
    var url=new URL(window.HvostAndroidPayment.url(code),location.origin).href;
    try{await navigator.clipboard.writeText(url);el('copy').textContent='Ссылка скопирована';}
    catch(_){el('copyValue').value=url;show('copyValue',true);el('copyValue').focus();el('copyValue').select();}
  };
  // iOS may restore the tab without a full page load, including a fast bank return.
  function afterBankReturn(){if(document.hidden||!left)return;left=false;check(true);}
  document.addEventListener('visibilitychange',function(){if(document.hidden){left=true;return;}afterBankReturn();});
  window.addEventListener('focus',afterBankReturn);
  window.addEventListener('pageshow',function(e){if(e.persisted){left=false;check(true);}});
  window.addEventListener('online',function(){if(!document.hidden)check(true);});
  if(valid)check(true);else error('Ссылка на оплату некорректна. Откройте заказ из ХвостМаркета.');
})();
