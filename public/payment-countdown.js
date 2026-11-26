/* Server-based payment countdown. No network requests or storage here. */
(function(root){
  'use strict';
  function format(seconds){
    return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  }
  function create(options){
    options=options||{};
    var now=options.now||function(){return Date.now();};
    var mono=options.monotonic||function(){return typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():now();};
    var schedule=options.schedule||function(fn,ms){return setTimeout(fn,ms);};
    var cancel=options.cancel||function(id){clearTimeout(id);};
    var initial=null,wall=0,steady=0,timeout=null,last=null,onTick=null,onExpire=null;
    function remaining(){
      if(initial===null)return null;
      // Offset comes from the server, not the phone's time zone or clock.
      // Elapsed wall time accounts for sleep; monotonic time guards backward jumps.
      return Math.max(0,Math.ceil((initial-Math.max(0,now()-wall,mono()-steady))/1000));
    }
    function clear(){if(timeout!==null){cancel(timeout);timeout=null;}}
    function stop(){clear();initial=null;last=null;onTick=null;onExpire=null;}
    function refresh(){
      clear();
      var seconds=remaining();
      if(seconds===null)return;
      var previous=last;last=seconds;
      if(previous!==seconds&&onTick)onTick(seconds,format(seconds));
      if(seconds===0){
        if(previous!==null&&previous>0&&onExpire)onExpire();
        return;
      }
      if(initial!==null)timeout=schedule(refresh,Math.min(1000,Math.max(100,initial%1000||1000)));
    }
    function start(data,tick,expired){
      stop();
      if(!data||!Number.isFinite(data.server_now_ms)||!Number.isFinite(data.payment_deadline_ms)||data.payment_deadline_ms<=0)return false;
      initial=Math.max(0,data.payment_deadline_ms-data.server_now_ms);
      wall=now();steady=mono();onTick=tick;onExpire=expired;
      refresh();
      return true;
    }
    return {start:start,stop:stop,refresh:refresh,remaining:remaining};
  }
  root.HvostPaymentCountdown={create:create,format:format};
})(window);
