// Network timeouts, reconnect and privacy-safe diagnostics for Telegram Mini App.
// No automatic retry for POST/PUT/DELETE: payments, stock, and payouts may have
// already reached the server even when the WebView loses connectivity.
(function () {
  'use strict';
  var nativeFetch = typeof fetch === 'function' ? fetch.bind(window) : null;
  var errorVisible = false;
  var statusElement = null;
  var recovery = null;
  var recovering = false;
  var lastReport = Object.create(null);
  var reportCount = 0;
  var openedAt = Date.now();
  var script = document.currentScript;
  var build = 'unknown';
  try { build = new URL(script.src, location.href).searchParams.get('v') || 'unknown'; } catch (_) {}
  build = String(build).slice(0,40);
  var ALLOWED_STAGES = ['startup','authorization','catalog','cabinet','network','recovery','runtime','payment'];
  var ALLOWED_CODES = ['ok','timeout','offline','network','server','forbidden','runtime','invalid_response','unknown'];
  function stageFor(url) {
    var value = String(url || '');
    if (/miniapp\/(auth|accounts|session|verify-phone|preferred-role)/.test(value)) return 'authorization';
    if (/create-payment|payment-status|order-payment-status/.test(value)) return 'payment';
    if (/\/api\/(products|points)(?:\?|\/|$)/.test(value)) return 'catalog';
    if (/\/api\//.test(value)) return 'cabinet';
    return 'network';
  }
  function platform() {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg && ['ios','android','tdesktop','macos','weba','webk'].includes(tg.platform))
        return tg.platform === 'ios' ? 'ios' : tg.platform === 'android' ? 'android' : 'desktop';
      var ua = String(navigator.userAgent || '');
      if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
      if (/Android/i.test(ua)) return 'android';
    } catch (_) {}
    return 'unknown';
  }
  function sendDiagnostic(stage, result, code, duration) {
    if (reportCount >= 20 || !nativeFetch) return;
    if (!ALLOWED_STAGES.includes(stage) || !['success','failure'].includes(result) ||
        !ALLOWED_CODES.includes(code)) return;
    var key = stage + '|' + result + '|' + code;
    var now = Date.now();
    if (lastReport[key] && now - lastReport[key] < 60000) return;
    lastReport[key] = now;
    reportCount++;
    var tg = window.Telegram && window.Telegram.WebApp;
    var version = tg && typeof tg.version === 'string' ? tg.version.slice(0,20) : 'unknown';
    // Deliberately omit URL, query, phone, Telegram user/id, authorization,
    // order ID, error text, initData, and personal details.
    var payload = {
      stage:stage, result:result,code:code,platform:platform(),
      build:build,telegram_version:version,
      duration_ms:Math.min(120000,Math.max(0,Math.round(Number(duration)||0))),
    };
    try {
      // Telemetry must never hold up boot or re-enter the network wrapper.
      nativeFetch('/api/miniapp/diagnostics',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),keepalive:true,cache:'no-store',
      }).catch(function(){});
    } catch (_) {}
  }
  function banner() {
    if (statusElement && statusElement.parentNode) return statusElement;
    if (!document.body || typeof document.createElement !== 'function') return null;
    statusElement = document.createElement('aside');
    statusElement.id = 'hmMiniAppConnectivity';
    statusElement.setAttribute('role','status');
    statusElement.setAttribute('aria-live','polite');
    statusElement.hidden = true;
    statusElement.style.cssText = 'position:fixed;z-index:9999;left:12px;right:12px;bottom:calc(74px + env(safe-area-inset-bottom,0px));'+
      'padding:12px 14px;background:#fff5e6;color:#56391c;border:1px solid #e7cba4;border-radius:12px;'+
      'box-shadow:0 3px 16px #0002;font:14px/1.45 system-ui,-apple-system,sans-serif';
    var label = document.createElement('span');
    label.id = 'hmMiniAppConnectivityMessage';
    statusElement.appendChild(label);
    var button = document.createElement('button');
    button.id = 'hmMiniAppConnectivityRetry';
    button.type = 'button';
    button.textContent = 'Повторить';
    button.style.cssText = 'margin-left:10px;padding:7px 12px;background:#186b49;color:white;border:0;border-radius:8px';
    button.addEventListener('click',function(){ retry(); });
    statusElement.appendChild(button);
    document.body.appendChild(statusElement);
    return statusElement;
  }
  function show(message) {
    errorVisible = true;
    var node = banner();
    if (node) {
      node.hidden = false;
      var label = document.getElementById('hmMiniAppConnectivityMessage');
      if (label) label.textContent = message;
    }
  }
  function clear() {
    errorVisible = false;
    var node = banner();
    if (node) node.hidden = true;
  }
  function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }
  function error(code, message) {
    var value = new Error(message);
    value.code = code;
    return value;
  }
  function singleRequest(url, init, timeout) {
    return new Promise(function(resolve,reject) {
      if (!nativeFetch) return reject(error('network','Запросы недоступны в этой версии браузера.'));
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var finished = false;
      var timer = null;
      var opts = Object.assign({},init);
      var external = opts.signal;
      var abortExternally = function() { if (controller) controller.abort(); };
      if (controller) {
        opts.signal = controller.signal;
        if (external && typeof external.addEventListener === 'function') {
          if (external.aborted) return reject(error('network','Запрос был отменён.'));
          external.addEventListener('abort',abortExternally,{once:true});
        }
      }
      function settle(fn,value) {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimeout(timer);
        if (external && typeof external.removeEventListener === 'function')
          external.removeEventListener('abort',abortExternally);
        fn(value);
      }
      timer = setTimeout(function(){
        if (controller) controller.abort();
        settle(reject,error('timeout','Сервер отвечает слишком долго. Проверьте интернет и нажмите «Повторить».'));
      },timeout);
      try {
        nativeFetch(url,opts).then(function(response){
          settle(resolve,response);
        },function(cause){
          settle(reject,error(isOffline()?'offline':'network',
            isOffline()?'Нет подключения к интернету.':'Не удалось связаться с сервером. Попробуйте ещё раз.'));
        });
      } catch (_) {
        settle(reject,error('network','Не удалось отправить запрос.'));
      }
    });
  }
  async function request(url, options) {
    var init = Object.assign({},options||{});
    var method = String(init.method || 'GET').toUpperCase();
    // ONLY GET can repeat automatically. Never replay a financial mutation.
    var retries = method === 'GET' && init.noRetry !== true ? 1 : 0;
    delete init.noRetry;
    var stage = stageFor(url), started = Date.now();
    var initial = method === 'GET' ? 8000 : 10000;
    if (isOffline()) {
      show('Нет интернета. Подключитесь к сети и нажмите «Повторить».');
      sendDiagnostic(stage,'failure','offline',Date.now()-started);
      throw error('offline','Нет интернета. Подключитесь к сети и повторите действие.');
    }
    for (var attempt=0;attempt<=retries;attempt++) {
      try {
        var response = await singleRequest(url,init,attempt===0?initial:4000);
        if (retries && attempt===0 && [502,503,504].includes(response.status)) continue;
        if (response.ok && errorVisible) clear();
        return response;
      } catch (e) {
        if (attempt<retries && ['timeout','network'].includes(e.code)) continue;
        var code = ALLOWED_CODES.includes(e.code)?e.code:'network';
        sendDiagnostic(stage,'failure',code,Date.now()-started);
        show(code==='offline'?'Нет интернета. Данные пока недоступны.':
          code==='timeout'?'Сервер отвечает слишком долго. Нажмите «Повторить».':
          'Связь прервалась. Нажмите «Повторить» после восстановления интернета.');
        throw e;
      }
    }
  }
  function registerRecovery(fn) { recovery = typeof fn==='function'?fn:null; }
  async function retry() {
    if (recovering) return false;
    if (isOffline()) { show('Нет подключения к интернету. Повторите после восстановления связи.');return false; }
    recovering = true;
    try {
      if (recovery) await recovery();
      clear();
      sendDiagnostic('recovery','success','ok',Date.now()-openedAt);
      return true;
    } catch (_) {
      show('Не удалось восстановить соединение. Попробуйте ещё раз.');
      sendDiagnostic('recovery','failure','network',Date.now()-openedAt);
      return false;
    } finally { recovering = false; }
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('offline',function(){show('Нет интернета. Приложение восстановит соединение после подключения.');});
    window.addEventListener('online',function(){ if(errorVisible) retry(); });
    window.addEventListener('error',function(){sendDiagnostic('runtime','failure','runtime',Date.now()-openedAt);});
    window.addEventListener('unhandledrejection',function(){
      sendDiagnostic('runtime','failure','runtime',Date.now()-openedAt);
    });
  }
  function refreshPreviouslyInstalledServiceWorker(){
    // Some users open the Mini App in a browser profile with an older
    // site-wide SW. Update it without registering one for new Telegram users.
    try {
      var service=navigator && navigator.serviceWorker;
      if(service && typeof service.getRegistrations==='function'){
        service.getRegistrations().then(function(registrations){
          (registrations||[]).forEach(function(reg){
            if(reg && typeof reg.update==='function')reg.update().catch(function(){});
          });
        }).catch(function(){});
      }
    }catch(_){}
  }
  if(typeof document.addEventListener==='function')
    document.addEventListener('DOMContentLoaded',function(){
      refreshPreviouslyInstalledServiceWorker();
      if(isOffline())show('Нет интернета. Проверьте подключение.');
    });
  window.HvostMiniAppReliability={
    request:request,registerRecovery:registerRecovery,retry:retry,
    report:sendDiagnostic,markReady:function(){sendDiagnostic('startup','success','ok',Date.now()-openedAt);},
    show:show,clear:clear,isOffline:isOffline,
  };
})();
