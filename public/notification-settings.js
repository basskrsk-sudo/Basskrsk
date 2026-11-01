// Account-scoped settings for Telegram Mini App and existing website cabinets.
// No third-party widget, no cross-role privileges, no localStorage for settings.
(function() {
  'use strict';
  var ROLE_LABEL={customer:'Покупатель',partner:'Грумер',manager:'Менеджер',
    owner:'Владелец салона',admin:'Администратор',founder:'Собственник ХвостМаркета',
    warehouse:'Кладовщик'};
  var TOKENS={customer:'taiga_customer_token',partner:'taiga_partner_token',
    owner:'taiga_owner_token',manager:'taiga_manager_token',admin:'taiga_admin_token',
    founder:'hm_business_founder_token',warehouse:'taiga_warehouse_token'};
  var contexts=new WeakMap();

  function esc(v) {return String(v==null?'':v).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });}
  function getToken(role) {
    try {return localStorage.getItem(TOKENS[role])||'';}catch(_){return '';}
  }
  async function request(role,token,settings) {
    if(!ROLE_LABEL[role]||!token)throw new Error('Для настроек сначала войдите в свой кабинет.');
    var res=await fetch('/api/me/notifications',{
      method:settings?'PUT':'GET',cache:'no-store',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(settings?{body:JSON.stringify({settings:settings})}:{}),
    });
    var data=await res.json().catch(function(){return {};});
    if(!res.ok)throw new Error(data.error||'Не удалось получить настройки ('+res.status+')');
    return data.settings||[];
  }
  function render(ctx) {
    var html='<div class="hm-notify-head"><h2>🔔 Настройки уведомлений</h2>'+
      '<p>Выбирайте, какие сообщения получать лично от ХвостМаркета в Telegram. '+
      'Для владельца-грумера предпочтения по двум ролям независимы.</p></div>';
    if(ctx.loading) {
      html+='<p class="hm-notify-note">⏳ Загружаем ваши настройки…</p>';
    } else if(ctx.error && !ctx.data) {
      html+='<div class="hm-notify-error" role="alert">'+esc(ctx.error)+'</div>'+
        '<button type="button" class="hm-notify-button secondary" data-hm-notify-retry>Повторить</button>';
    } else {
      for(var role of ctx.roles) {
        var entries=ctx.data[role]||[];
        html+='<section class="hm-notify-section"><h3>'+esc(ROLE_LABEL[role])+'</h3>';
        if(!entries.length) {
          html+='<p class="hm-notify-note">Для этой роли пока нет настраиваемых личных рассылок.</p>';
        }
        for(var item of entries) {
          html+='<label class="hm-notify-row'+(item.locked?' is-locked':'')+'">'+
            '<span class="hm-notify-copy"><strong>'+esc(item.label)+'</strong>'+
            '<small>'+esc(item.help)+(item.locked?' · Обязательное сообщение':'')+'</small></span>'+
            '<input class="hm-notify-switch" type="checkbox" data-hm-notify-key="'+esc(item.key)+
            '" data-hm-notify-role="'+esc(role)+'"'+(item.enabled?' checked':'')+(item.locked?' disabled':'')+'>'+
            '</label>';
        }
        html+='</section>';
      }
      html+='<p class="hm-notify-note">Настройки личные и сохраняются на сервере. '+
        'Уведомления общих групп и служебного чата не меняются. '+
        'Подтверждение оплаченного заказа всегда приходит покупателю.</p>';
      if(ctx.error)html+='<div class="hm-notify-error" role="alert">'+esc(ctx.error)+'</div>';
      if(ctx.saved)html+='<p class="hm-notify-success" role="status">✓ Настройки сохранены</p>';
      if(ctx.roles.some(function(role){return (ctx.data[role]||[]).some(function(x){return !x.locked;});})) {
        html+='<button type="button" class="hm-notify-button" data-hm-notify-save'+
          (ctx.saving?' disabled':'')+'>'+(ctx.saving?'Сохраняем…':'Сохранить настройки')+'</button>';
      }
    }
    html+='<button type="button" class="hm-notify-button secondary" data-hm-notify-back>← Вернуться в кабинет</button>';
    ctx.root.innerHTML=html;
  }
  function capture(ctx) {
    if(!ctx.data)return;
    var controls=ctx.root.querySelectorAll('[data-hm-notify-key]');
    Array.prototype.forEach.call(controls,function(input){
      var entries=ctx.data[input.dataset.hmNotifyRole]||[];
      var item=entries.find(function(x){return x.key===input.dataset.hmNotifyKey;});
      if(item&&!item.locked)item.enabled=!!input.checked;
    });
  }
  async function refresh(ctx) {
    ctx.loading=true;ctx.error='';ctx.saved=false;render(ctx);
    try{
      var result=await Promise.all(ctx.roles.map(function(role){
        return request(role,ctx.tokens[role]);
      }));
      if(contexts.get(ctx.root)!==ctx)return;
      ctx.data={};
      ctx.roles.forEach(function(role,i){ctx.data[role]=result[i];});
    }catch(e){ctx.error=e.message;ctx.data=null;}
    ctx.loading=false;render(ctx);
  }
  async function save(ctx) {
    if(ctx.loading||ctx.saving||!ctx.data)return;
    capture(ctx);
    ctx.saving=true;ctx.error='';ctx.saved=false;render(ctx);
    try{
      // Each role is independently authenticated and saved under its own id;
      // a failure can be retried without touching the other role's settings.
      var results=await Promise.allSettled(ctx.roles.map(function(role){
        var editable=(ctx.data[role]||[]).filter(function(x){return !x.locked;});
        if(!editable.length)return Promise.resolve(ctx.data[role]);
        var changes={};
        editable.forEach(function(x){changes[x.key]=!!x.enabled;});
        return request(role,ctx.tokens[role],changes);
      }));
      if(contexts.get(ctx.root)!==ctx)return;
      var failed=[];
      results.forEach(function(result,i){
        if(result.status==='fulfilled')ctx.data[ctx.roles[i]]=result.value;
        else failed.push(ROLE_LABEL[ctx.roles[i]]+': '+result.reason.message);
      });
      ctx.error=failed.join(' · ');
      ctx.saved=!failed.length;
    }catch(e){ctx.error=e.message;}
    ctx.saving=false;render(ctx);
  }
  function bindRoot(root) {
    if(root.__hvostNotifyBound)return;
    root.__hvostNotifyBound=true;
    root.addEventListener('click',function(event){
      var btn=event.target.closest('[data-hm-notify-back],[data-hm-notify-retry],[data-hm-notify-save]');
      if(!btn)return;
      var ctx=contexts.get(root);if(!ctx)return;
      event.preventDefault();
      if(btn.hasAttribute('data-hm-notify-back')) {
        contexts.delete(root);
        if(typeof ctx.back==='function')ctx.back();
      } else if(btn.hasAttribute('data-hm-notify-retry'))refresh(ctx);
      else if(btn.hasAttribute('data-hm-notify-save'))save(ctx);
    });
  }
  function open(options) {
    var root=options&&options.root;
    if(!root)return;
    var roles=(options.roles||[]).filter(function(x){return !!ROLE_LABEL[x];});
    var unique=roles.filter(function(x,i){return roles.indexOf(x)===i;});
    var tokens=options.tokens||{};
    if(!unique.length)return;
    bindRoot(root);
    var ctx={root,roles:unique,tokens,back:options.back,loading:true,data:null,saving:false,saved:false,error:''};
    contexts.set(root,ctx);
    refresh(ctx);
  }

  function installFull(role,tokenGetter) {
    if(!ROLE_LABEL[role]||!document.body)return;
    var activeToken=typeof tokenGetter==='function'?tokenGetter:function(){return getToken(role);};
    var dock=document.createElement('div');
    dock.className='hm-notify-full-trigger';
    dock.innerHTML='<button type="button" class="hm-notify-floating">🔔 Настройки уведомлений</button>';
    document.body.appendChild(dock);
    var overlay=document.createElement('div');
    overlay.className='hm-notify-overlay';overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-label','Настройки уведомлений');overlay.hidden=true;
    var page=document.createElement('div');
    page.className='hm-notify-modal';
    overlay.appendChild(page);
    document.body.appendChild(overlay);
    function update() {
      var active=!!activeToken();
      var app=document.getElementById('app');
      if(app && app.style.display==='none')active=false;
      dock.hidden=!active;
    }
    function close(){overlay.hidden=true;page.innerHTML='';update();}
    dock.addEventListener('click',function(){
      if(!activeToken())return update();
      overlay.hidden=false;
      open({root:page,roles:[role],tokens:{[role]:activeToken()},back:close});
    });
    overlay.addEventListener('click',function(e){if(e.target===overlay)close();});
    document.addEventListener('click',function(){setTimeout(update,120);setTimeout(update,1100);});
    document.addEventListener('visibilitychange',update);
    update();
  }
  window.HvostNotificationSettings={open,installFull,request};
})();
