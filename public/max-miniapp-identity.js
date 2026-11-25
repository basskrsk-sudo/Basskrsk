// MAX Bridge identity adapter for the shared ХвостМаркет staff cabinet UI.
// Signed initData proves MAX identity; separately signed requestContact proves
// OWN phone. All role authorization is performed by the production server.
(function(){
  'use strict';
  var rawInitData='', maxUserId='', listeners=[], busy=false;
  var identity={
    loaded:false, verified:false, phoneMasked:'', accounts:[],
    ambiguousRoles:[], combinedSalon:false, preferredRole:null, error:'',
  };
  var tokenKeys={
    partner:'taiga_partner_token',owner:'taiga_owner_token',
    manager:'taiga_manager_token',admin:'taiga_admin_token',
  };
  function scopedKey(role) {
    return 'hm_max_' + tokenKeys[role];
  }
  function copy() {
    return {
      loaded:identity.loaded,verified:identity.verified,phoneMasked:identity.phoneMasked,
      accounts:identity.accounts.map(function(x){return {role:x.role,name:x.name};}),
      ambiguousRoles:identity.ambiguousRoles.slice(),
      combinedSalon:identity.combinedSalon,preferredRole:identity.preferredRole,
      error:identity.error,busy:busy,
    };
  }
  function notify() {
    var current=copy();
    listeners.slice().forEach(function(fn) {
      try { fn(current); } catch(e) { console.warn('MAX work identity event:',e); }
    });
  }
  function clearStaffTokens() {
    Object.keys(tokenKeys).forEach(function(role){
      try { localStorage.removeItem(scopedKey(role)); } catch (_) {}
    });
    try {
      localStorage.removeItem('hm_max_miniapp_work_role');
      localStorage.removeItem('hm_max_miniapp_preferred_role');
      localStorage.removeItem('hm_max_admin_role');
    } catch (_) {}
  }
  function post(path,body,token) {
    if(!rawInitData) return Promise.reject(new Error('Откройте мини-приложение из бота MAX.'));
    return fetch(path,{
      method:'POST',cache:'no-store',
      headers:Object.assign({'Content-Type':'application/json'},token?{Authorization:'Bearer '+token}:{}),
      body:JSON.stringify(Object.assign({init_data:rawInitData},body||{})),
    }).then(async function(response){
      var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.error||'Ошибка сервера '+response.status);
      return data;
    });
  }
  function setStatus(data) {
    identity.loaded=true;
    identity.verified=!!data.verified;
    identity.phoneMasked=identity.verified?data.phone_masked||'':'';
    identity.accounts=identity.verified&&Array.isArray(data.accounts)?
      data.accounts.filter(function(x){return !!tokenKeys[x.role];}):[];
    identity.ambiguousRoles=identity.verified&&Array.isArray(data.ambiguous_roles)?
      data.ambiguous_roles.slice():[];
    identity.combinedSalon=identity.verified&&!!data.combined_salon;
    var preferred=null;
    try { preferred=localStorage.getItem('hm_max_miniapp_preferred_role'); } catch (_) {}
    var roles=identity.accounts.map(function(x){return x.role;});
    if(identity.combinedSalon)roles.push('salon');
    identity.preferredRole=roles.includes(preferred)?preferred:
      roles.includes(data.preferred_role)?data.preferred_role:
      roles.length===1?roles[0]:null;
    identity.error='';
    notify();
    return copy();
  }
  async function refresh() {
    if(!rawInitData) {
      identity.loaded=true;identity.verified=false;identity.accounts=[];
      identity.error='Откройте мини-приложение из бота MAX.';
      notify();return copy();
    }
    try {
      return setStatus(await post('/api/max/miniapp/accounts'));
    } catch(err) {
      identity.loaded=true;identity.verified=false;
      identity.accounts=[];identity.ambiguousRoles=[];identity.combinedSalon=false;
      identity.error=err.message;notify();return copy();
    }
  }
  async function init(user, signedData) {
    rawInitData=typeof signedData==='string'?signedData:'';
    maxUserId=user&&user.id!=null?String(user.id):'';
    if(maxUserId) {
      try {
        var key='hm_max_miniapp_last_user';
        var previous=localStorage.getItem(key);
        if(previous && previous!==maxUserId)clearStaffTokens();
        localStorage.setItem(key,maxUserId);
      } catch (_) {}
    }
    return refresh();
  }
  async function requestContact() {
    if(busy)return copy();
    if(!window.WebApp||typeof window.WebApp.requestContact!=='function') {
      identity.error='В вашей версии MAX недоступно подтверждение номера. Обновите MAX и откройте приложение через бота.';
      notify();return copy();
    }
    busy=true;identity.error='';notify();
    try {
      // Only MAX provides these signed values after native phone consent.
      var signed=await window.WebApp.requestContact();
      var answer=await post('/api/max/miniapp/verify-phone',{contact:signed});
      return setStatus(answer);
    } catch(error) {
      identity.error=error&&error.error&&error.error.code?
        'Не удалось получить номер. Разрешите MAX поделиться вашим контактом.':
        error.message||'Номер не подтверждён в MAX.';
      notify();return copy();
    } finally {
      busy=false;notify();
    }
  }
  async function session(role) {
    if(!tokenKeys[role])throw new Error('Неизвестный кабинет MAX');
    if(!identity.verified||!identity.accounts.some(function(x){return x.role===role;}))
      throw new Error('Этот кабинет не связан с подтверждённым номером MAX.');
    var result=await post('/api/max/miniapp/session',{role:role});
    if(!result||!result.token||result.role!==role)throw new Error('Вход в кабинет MAX не удался');
    // MAX uses separate storage keys from Telegram, even on a shared origin.
    try {
      localStorage.setItem(scopedKey(role),result.token);
      if(role==='admin')
        localStorage.setItem('hm_max_admin_role',result.account&&result.account.adminRole||'admin');
    } catch (_) {}
    return result;
  }
  async function rememberRole(role) {
    if(!identity.verified)return false;
    var allowed=identity.accounts.some(function(a){return a.role===role;})||
      (role==='salon'&&identity.combinedSalon);
    if(!allowed)return false;
    try {localStorage.setItem('hm_max_miniapp_preferred_role',role);}catch(_){}
    identity.preferredRole=role;
    return true;
  }
  function onChange(fn) {
    if(typeof fn!=='function')return function(){};
    listeners.push(fn);
    return function(){listeners=listeners.filter(function(item){return item!==fn;});};
  }
  function rewardReport(path,body,token){
    if(!identity.verified||!identity.accounts.some(function(a){return a.role==='admin';})||!token)
      return Promise.reject(new Error('Подтвердите кабинет администратора MAX.'));
    return post('/api/max/miniapp/reward-reports/'+path,body,token);
  }
  window.HvostMiniAppIdentity={
    rewardReportOptions:function(body,token){return rewardReport('options',body,token);},
    sendRewardReport:function(body,token){return rewardReport('send',body,token);},
    init:init,refresh:refresh,requestContact:requestContact,session:session,
    rememberRole:rememberRole,onChange:onChange,getStatus:copy,
  };
})();
