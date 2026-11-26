/* Standalone handoff page works even when the bank opens a different browser. */
(function(){
  'use strict';
  var el=function(id){return document.getElementById(id);};
  var code=new URLSearchParams(location.search).get('order');
  var valid=window.HvostAndroidPayment.codeValid(code);
  var busy=false,finished=false,lastCheck=0,left=false,missing=false,queuedCheck=false;
  var countdown=window.HvostPaymentCountdown&&window.HvostPaymentCountdown.create();
  // Only explicit validation failures known to occur before creating a payment.
  var editCodes=['ORDER_TOTAL_CHANGED','FIRST_PURCHASE_PROMO_INVALID','STOCK_UNAVAILABLE','STOCK_CONFIRMATION_REQUIRED','VARIANT_NOT_FOUND','VARIANT_INACTIVE','POINT_UNAVAILABLE','ADVISOR_SELECTION_ERROR','ADVISOR_SELECTION_REQUIRED','PARTNER_POINT_MISMATCH','INVALID_QUANTITY','INVALID_CATALOG_PRICE','AMBIGUOUS_VARIANT','EMPTY_CART','TOO_MANY_LINES','CUSTOM_ITEM_NOT_ALLOWED','INVALID_ORDER_TOTAL','SELF_ORDER_BONES_FORBIDDEN'];
  function show(id,on){el(id).hidden=!on;}
  function safePath(path){
    try{
      var u=new URL(path,location.origin);
      return u.origin===location.origin&&u.searchParams.get('payment_return')===code&&
        (u.pathname==='/'||u.pathname==='/miniapp.html'||/^\/p\/[^/]+\/[^/]+\/?$/.test(u.pathname))?u.pathname+u.search:null;
    }catch(_){return null;}
  }
  function editPath(body){
    var p=body.returnPath||'/';
    return /^\/(?:miniapp\.html|p\/[^/?#]+\/[^/?#]+\/?)?$/.test(p)?p:'/';
  }
  function clearRejected(body,p){
    // Only remove storage belonging to this exact rejected order; never clear the basket.
    function clearMatch(store,key){
      try{var v=JSON.parse(store.getItem(key)||'null');if(v&&v.orderId===code)store.removeItem(key);}catch(_){}
    }
    if(/^\/p\//.test(p)&&body.pointId!=null){
      try{clearMatch(window.localStorage,'hm_qr_pending_v1:'+String(body.pointId));}catch(_){}
      try{clearMatch(window.sessionStorage,'hvost_qr_payment:'+p);}catch(_){}
    }
    try{window.sessionStorage.removeItem('hvostmarket_success_'+code);}catch(_){}
    window.HvostAndroidPayment.clear(code);
  }
  function providerLink(url){
    try{var u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch(_){return null;}
  }
  async function request(url,method){
    var ac=new AbortController(),timer=setTimeout(function(){ac.abort();},12000);
    try{var res=await fetch(url,{method:method||'GET',cache:'no-store',credentials:'same-origin',signal:ac.signal,referrerPolicy:'no-referrer'});
      return {status:res.status,data:await res.json()};}finally{clearTimeout(timer);}
  }
  function stopCountdown(){
    if(countdown)countdown.stop();
    show('paymentCountdown',false);
  }
  function showExpired(){
    show('payLink',false);show('recover',false);
    el('title').textContent='Время резерва истекло';
    el('message').textContent='Время оплаты истекло. Проверяем окончательный статус платежа. Если деньги уже списаны, не платите повторно. Нажмите «Проверить оплату». Новый заказ можно оформить после подтверждённой отмены.';
  }
  function startCountdown(data){
    if(!countdown)return;
    countdown.start(data,function(seconds,formatted){
      el('paymentCountdownValue').textContent=formatted;
      el('paymentCountdown').className='payment-countdown'+(seconds<=60?' urgent':'');
      show('paymentCountdown',true);
      if(seconds===0)showExpired();
    },function(){
      if(document.hidden){left=true;return;}
      // One extra reconciliation at expiry, never a cancellation or new POST.
      check(true,true);
    });
  }
  function error(message){
    stopCountdown();
    show('payLink',false);show('recover',false);show('result',false);
    el('title').textContent='Не удалось подтвердить статус';
    el('message').textContent=message;
    show('check',valid);show('browserHelp',valid);
  }
  function render(data){
    stopCountdown();
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
    show('recover',data.can_recover===true&&!link&&data.reservation_expired!==true);
    if(data.reservation_expired===true)showExpired();
    startCountdown(data);
  }
  async function check(force,queueIfBusy){
    if(!valid||finished)return;
    if(busy){if(queueIfBusy)queuedCheck=true;return;}
    if(!force&&Date.now()-lastCheck<2000)return;
    busy=true;lastCheck=Date.now();el('check').disabled=true;el('recover').disabled=true;
    show('payLink',false);show('recover',false);
    try{
      var result=await request('/api/order-payment-status/'+encodeURIComponent(code));
      if(result.status===404){
        missing=true;
        var original=window.HvostAndroidPayment.snapshot(code);
        error(original?'Заказ пока не найден. Возможно, создание ещё не завершилось. Можно повторить запрос с тем же номером заказа.':
          'Заказ пока не найден, а данные покупки остались в исходной вкладке. Вернитесь туда (в том числе в Telegram) и откройте оплату в ней. Если вы уже оплатили, не создавайте новый заказ — проверьте статус ещё раз.');
        if(original){el('recover').textContent='Повторить запрос этого заказа';show('recover',true);}
        return;
      }
      if(result.status!==200)throw Error('status');
      render(result.data||{});
    }catch(_){error('Проверьте интернет и повторите проверку этого заказа.');}
    finally{
      busy=false;el('check').disabled=false;el('recover').disabled=false;
      if(queuedCheck){queuedCheck=false;if(!finished)await check(true);}
    }
  }
  async function recover(){
    if(!valid||busy||finished)return;
    busy=true;el('recover').disabled=true;el('check').disabled=true;
    var skipFollowup=false;
    try{
      if(missing){
        var body=window.HvostAndroidPayment.snapshot(code);
        if(!body)return;
        var headers={'Content-Type':'application/json'};
        if(Number(body.bonesUsed)>0){var token='';try{token=localStorage.getItem('taiga_customer_token')||'';}catch(_){}if(!token){el('message').textContent='Для оплаты косточками откройте исходную вкладку, в которой вы вошли в аккаунт.';skipFollowup=true;return;}headers.Authorization='Bearer '+token;}
        var ac=new AbortController(),timer=setTimeout(function(){ac.abort();},12000);
        try{var response,data;
          for(var round=0;round<4;round++){
            clearTimeout(timer);ac=new AbortController();timer=setTimeout(function(){ac.abort();},12000);
            response=await fetch('/api/create-payment',{method:'POST',headers:headers,body:JSON.stringify(body),cache:'no-store',signal:ac.signal});
            data=await response.json();clearTimeout(timer);
            if(response.ok||data.code!=='STOCK_CONFIRMATION_REQUIRED'||round===3)break;
            var next=await window.HvostPhysicalStock.resolve(data,body);
            if(!next)break;
            body=next;var pointer=window.HvostAndroidPayment.pending();
            window.HvostAndroidPayment.remember(code,pointer?pointer.flow:'qr',body);
            if(/^\/p\//.test(editPath(body))){
              try{var key='hm_qr_pending_v1:'+String(body.pointId),saved=JSON.parse(window.localStorage.getItem(key)||'null');
                if(saved&&saved.orderId===code){saved.body=body;window.localStorage.setItem(key,JSON.stringify(saved));}}catch(_){}
            }
          }
          if(!response.ok&&response.status>=400&&response.status<500&&editCodes.includes(data.code)){
            // Never discard a payment on a timeout, unknown error or existing order.
            var p=editPath(body);
            var probe=await request('/api/order-payment-status/'+encodeURIComponent(code));
            if(probe.status===404){
              clearRejected(body,p);finished=true;
              el('title').textContent='Проверьте заказ';
              el('message').textContent=data.error||'Изменились условия заказа.';
              el('result').href=p;el('result').textContent='Вернуться к покупке →';
              show('result',true);show('recover',false);show('check',false);show('payLink',false);show('foot',false);show('browserHelp',false);return;
            }
            if(probe.status===200){render(probe.data||{});skipFollowup=true;}
          }
        }finally{clearTimeout(timer);}
      }else await request('/api/redirect-payment/'+encodeURIComponent(code)+'/resume','POST');
    }
    catch(_){}
    finally{
      busy=false;el('recover').disabled=false;el('check').disabled=false;
      var followup=queuedCheck||!skipFollowup;queuedCheck=false;
      if(followup&&!finished)await check(true);
    }
  }
  el('check').onclick=function(){check(true);};el('recover').onclick=recover;
  el('payLink').onclick=function(event){
    if(countdown)countdown.refresh();
    if(el('payLink').hidden){if(event)event.preventDefault();return;}
    left=true;
  };
  el('copy').onclick=async function(){
    var url=new URL(window.HvostAndroidPayment.url(code),location.origin).href;
    try{await navigator.clipboard.writeText(url);el('copy').textContent='Ссылка скопирована';}
    catch(_){el('copyValue').value=url;show('copyValue',true);el('copyValue').focus();el('copyValue').select();}
  };
  // iOS may restore the tab without a full page load, including a fast bank return.
  function afterBankReturn(){if(document.hidden)return;if(countdown)countdown.refresh();if(!left)return;left=false;check(true,true);}
  document.addEventListener('visibilitychange',function(){if(document.hidden){left=true;return;}afterBankReturn();});
  window.addEventListener('focus',afterBankReturn);
  window.addEventListener('pageshow',function(e){if(e.persisted){left=false;check(true,true);}});
  window.addEventListener('pagehide',stopCountdown);
  window.addEventListener('online',function(){if(!document.hidden)check(true,true);});
  if(valid)check(true);else error('Ссылка на оплату некорректна. Откройте заказ из ХвостМаркета.');
})();
