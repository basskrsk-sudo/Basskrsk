// Super-admin setup panel for owners of the ХвостМаркет business.
// It never grants normal admin permissions to a business founder.
(function(){
  'use strict';
  var founders=[];
  var root=document.getElementById('workPage');
  if(!root)return;
  function esc(v){
    return String(v==null?'':v).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function render(data){
    founders=data && data.founders || [];
    if(!data)return '<section class="work-surface">'+
      '<h2>👑 Доступ собственников бизнеса</h2>'+
      '<p class="work-note">Не удалось загрузить список собственников. Проверьте права супер-администратора.</p></section>';
    return '<section class="work-surface founder-setup"><h2>👑 Доступ собственников ХвостМаркета</h2>'+
      '<p class="work-note">Создайте персональные логины, телефоны и пароли для собственников бизнеса. '+
      'В отличие от владельцев салонов, они будут видеть стратегическую экономику всей сети. '+
      'Права администратора им автоматически не выдаются.</p>'+
      founders.map(function(f){
        return '<div class="work-row"><div><b>'+esc(f.full_name)+' · '+esc(f.share_percent)+'%</b>'+
          '<small>'+esc(f.login||'Логин не назначен')+(f.phone_masked?' · '+esc(f.phone_masked):'')+
          '</small></div><strong>'+ (f.active?'Активен':'Неактивен')+'</strong></div>';
      }).join('')+
      '<form id="businessFounderSetupForm">'+
        '<label for="founderSetupChoice">Собственник</label>'+
        '<select class="work-input" id="founderSetupChoice">'+
          founders.map(function(f){return '<option value="'+esc(f.id)+'">'+esc(f.full_name)+'</option>';}).join('')+
        '</select>'+
        '<label for="founderSetupLogin">Логин (латинские буквы/цифры)</label>'+
        '<input class="work-input" id="founderSetupLogin" type="text" maxlength="50" autocomplete="off" placeholder="founder_name" required>'+
        '<label for="founderSetupPhone">Номер телефона (при изменении заполнить)</label>'+
        '<input class="work-input" id="founderSetupPhone" type="tel" maxlength="24" autocomplete="off" placeholder="+7 9XX XXX-XX-XX">'+
        '<label for="founderSetupPassword">Пароль (для нового аккаунта обязательно)</label>'+
        '<input class="work-input" id="founderSetupPassword" type="password" maxlength="128" autocomplete="new-password" placeholder="От 10 символов">'+
        '<label class="founder-checkbox" for="founderSetupActive">'+
          '<input type="checkbox" id="founderSetupActive"><span>Разрешить доступ к кабинету собственника</span>'+
        '</label>'+
        '<button type="submit" class="work-primary" id="founderSetupSave">Сохранить настройки доступа</button>'+
        '<div id="founderSetupMessage" aria-live="polite"></div>'+
      '</form>'+
      '<p class="work-quiet">Переподключение Telegram требуется при смене номера. '+
      'Доступ отключённого собственника блокируется сервером, даже если ранее был выдан токен.</p></section>';
  }
  function populate(){
    var select=document.getElementById('founderSetupChoice');
    if(!select)return;
    var founder=founders.find(function(f){return String(f.id)===String(select.value);})||founders[0];
    if(!founder)return;
    var login=document.getElementById('founderSetupLogin');
    var phone=document.getElementById('founderSetupPhone');
    var password=document.getElementById('founderSetupPassword');
    var active=document.getElementById('founderSetupActive');
    if(login)login.value=founder.login||'';
    if(phone)phone.value='';
    if(password)password.value='';
    if(active)active.checked=!!founder.active;
    var message=document.getElementById('founderSetupMessage');
    if(message)message.textContent=founder.configured?'Номер сохранён (видны только последние 2 цифры).':'Заполните логин, телефон и пароль.';
  }
  async function save(){
    var list=document.getElementById('founderSetupChoice');
    var login=document.getElementById('founderSetupLogin');
    var phone=document.getElementById('founderSetupPhone');
    var pw=document.getElementById('founderSetupPassword');
    var active=document.getElementById('founderSetupActive');
    var button=document.getElementById('founderSetupSave');
    var message=document.getElementById('founderSetupMessage');
    if(!list||!login||!active||!message||!button)return;
    if(!founders.some(function(f){return String(f.id)===String(list.value);}))return;
    var body={login:login.value.trim(),active:active.checked};
    if(phone&&phone.value.trim())body.phone=phone.value.trim();
    if(pw&&pw.value)body.password=pw.value;
    var token;
    try{token=localStorage.getItem('taiga_admin_token');}catch(_){}
    if(!token){message.textContent='Сессия администратора завершена. Войдите заново.';return;}
    button.disabled=true;
    message.textContent='Сохраняем доступ…';
    try{
      var response=await fetch('/api/business-founders/'+encodeURIComponent(list.value),{
        method:'PUT',
        cache:'no-store',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(body),
      });
      var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.error||'Не удалось сохранить доступ');
      var index=founders.findIndex(function(f){return String(f.id)===String(list.value);});
      if(index>=0)founders[index]=data.founder;
      if(pw)pw.value='';
      if(phone)phone.value='';
      message.textContent='✅ Доступ сохранён. '+(data.telegram_reconnect_required?'После изменения номера потребуется перепривязка Telegram.':'');
      // Refresh the summary without leaving the page or repeating credentials.
      var summary=root.querySelectorAll('.founder-setup .work-row');
      if(summary && summary[index]) summary[index].querySelector('strong').textContent=data.founder.active?'Активен':'Неактивен';
    }catch(err){message.textContent='⚠️ '+err.message;}finally{button.disabled=false;}
  }
  root.addEventListener('change',function(event){
    if(event.target && event.target.id==='founderSetupChoice')populate();
  });
  root.addEventListener('submit',function(event){
    if(event.target && event.target.id==='businessFounderSetupForm'){
      event.preventDefault();
      save();
    }
  });
  window.HvostBusinessFounderAdmin={render:render,populate:populate};
})();
