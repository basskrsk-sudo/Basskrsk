/* Shared Android/iOS hosted checkout; legacy export and key retained for existing orders. */
(function(root){
  'use strict';
  var key='hm_android_payment_v1';
  function android(){return /Android/i.test(root.navigator&&root.navigator.userAgent||'');}
  function ios(){
    var n=root.navigator||{};
    return /iPhone|iPad|iPod/i.test(n.userAgent||'')||
      (n.platform==='MacIntel'&&Number(n.maxTouchPoints)>1);
  }
  function hosted(){return android()||ios();}
  function codeValid(code){return /^(TG|TMA)-\d{13}-[a-f0-9]{16}$/.test(String(code||''));}
  function newCode(prefix){
    return (prefix==='TMA'?'TMA':'TG')+'-'+Date.now()+'-'+Array.from(root.crypto.getRandomValues(new Uint8Array(8))).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
  }
  function url(code){return codeValid(code)?'/pay.html?order='+encodeURIComponent(code):'';}
  function remember(code,flow,body){
    if(!codeValid(code))return;
    var pointer=JSON.stringify({code:code,flow:flow,at:Date.now()});
    try{
      root.localStorage.setItem(key,pointer);
      try{root.sessionStorage.removeItem(key);}catch(_){}
    }catch(_){try{root.sessionStorage.setItem(key,pointer);}catch(_){}}
    // Exact request stays in this tab only. Never store bank URLs or credentials here.
    try{if(body&&body.orderId===code)root.sessionStorage.setItem(key+':'+code,JSON.stringify(body));}catch(_){}
  }
  function pending(flow){
    var v=null;
    try{v=JSON.parse(root.localStorage.getItem(key)||'null');}catch(_){}
    if(!v){try{v=JSON.parse(root.sessionStorage.getItem(key)||'null');}catch(_){}}
    return v&&codeValid(v.code)&&(!flow||v.flow===flow)&&Date.now()-v.at<24*60*60*1000?v:null;
  }
  function snapshot(code){
    if(!codeValid(code))return null;
    try{var body=JSON.parse(root.sessionStorage.getItem(key+':'+code)||'null');return body&&body.orderId===code&&body.confirmationMode==='redirect'?body:null;}catch(_){return null;}
  }
  function clear(code){
    try{root.sessionStorage.removeItem(key+':'+code);}catch(_){}
    try{var s=JSON.parse(root.sessionStorage.getItem(key)||'null');if(s&&s.code===code)root.sessionStorage.removeItem(key);}catch(_){}
    try{var v=JSON.parse(root.localStorage.getItem(key)||'null');if(v&&v.code===code)root.localStorage.removeItem(key);}catch(_){}
  }
  function go(code){var path=url(code);if(path)root.location.assign(path);}
  function external(code,tg){
    var path=url(code);if(!path)return false;
    var absolute=new URL(path,root.location.origin).href;
    if(tg&&typeof tg.openLink==='function'){
      try{tg.openLink(absolute);return true;}catch(_){}
    }
    root.location.assign(path);return true;
  }
  root.HvostAndroidPayment={android:android,ios:ios,hosted:hosted,codeValid:codeValid,newCode:newCode,url:url,remember:remember,pending:pending,snapshot:snapshot,clear:clear,go:go,external:external};
})(window);
