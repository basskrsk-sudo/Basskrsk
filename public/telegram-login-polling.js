// Five-minute, visibility-aware Telegram login polling shared by all web roles.
// At most one in-flight check; no network calls while the page is hidden.
(function(global){
  'use strict';
  var WAIT_MS = 5 * 60 * 1000;
  var INTERVAL_MS = 2000;
  var REQUEST_TIMEOUT_MS = 12000;
  function start(options) {
    if(!options || typeof options.check !== 'function') throw new TypeError('check callback required');
    var doc = options.document || document;
    var host = options.window || global;
    var clock = options.now || Date.now;
    var later = options.setTimer || setTimeout;
    var cancel = options.clearTimer || clearTimeout;
    var deadline = clock() + WAIT_MS;
    var active = true, pending = false, timer = null, abortTimer = null, controller = null;
    function stop(){
      if(!active)return;
      active=false;
      if(timer !== null){cancel(timer);timer=null;}
      if(abortTimer !== null){cancel(abortTimer);abortTimer=null;}
      if(controller){controller.abort();controller=null;}
      doc.removeEventListener('visibilitychange',onVisibility);
      host.removeEventListener('pageshow',onVisibility);
    }
    function expire(){
      if(!active)return;
      stop();
      if(typeof options.onExpired === 'function')options.onExpired();
    }
    function schedule(wait){
      if(!active || doc.hidden || timer !== null)return;
      var left = deadline - clock();
      if(left <= 0){expire();return;}
      timer = later(function(){timer=null;void tick();},Math.min(wait,left));
    }
    async function tick(){
      if(!active || doc.hidden)return;
      if(clock()>=deadline){expire();return;}
      if(pending)return;
      pending=true;
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      controller=ctrl;
      if(ctrl)abortTimer=later(function(){ctrl.abort();},Math.min(REQUEST_TIMEOUT_MS,Math.max(1000,deadline-clock())));
      try {
        var result=await options.check(ctrl?ctrl.signal:undefined);
        if(!active)return;
        if(result && result.done){
          stop();
          if(typeof options.onSuccess === 'function')await options.onSuccess(result.data);
        }else if(result && result.expired){
          expire();
        }
      } catch (_) {
        // Transient connection failures are retried until the five-minute cap.
      } finally {
        if(abortTimer !== null){cancel(abortTimer);abortTimer=null;}
        controller=null;
        pending=false;
        if(active)schedule(INTERVAL_MS);
      }
    }
    function onVisibility(){
      if(!active)return;
      if(doc.hidden){
        if(timer !== null){cancel(timer);timer=null;}
        if(controller)controller.abort();
      }else if(clock()>=deadline)expire();
      else if(!pending)schedule(0);
    }
    doc.addEventListener('visibilitychange',onVisibility);
    host.addEventListener('pageshow',onVisibility);
    schedule(0); // Confirm immediately if the user returned from the bot.
    return { stop:stop };
  }
  global.HvostTelegramLoginPolling={start:start,WAIT_MS:WAIT_MS};
})(window);
