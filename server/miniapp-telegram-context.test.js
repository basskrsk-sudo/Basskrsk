'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {verifyTelegramInitData}=require('./routes-miniapp');

const source=fs.readFileSync(path.join(__dirname,'../public/miniapp-telegram-context.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
const identity=fs.readFileSync(path.join(__dirname,'../public/miniapp-identity.js'),'utf8');
const customer=fs.readFileSync(path.join(__dirname,'../public/miniapp-customer.js'),'utf8');
const TOKEN='123456789:test-webapp-script-unavailable';
const NOW=Math.floor(Date.now()/1000);
function signed(userId=555666777){
  const params=new URLSearchParams({
    user:JSON.stringify({id:userId,first_name:'Ангелина'}),
    auth_date:String(NOW),
  });
  const dataCheck=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>k+'='+v).join('\n');
  const key=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
  params.set('hash',crypto.createHmac('sha256',key).update(dataCheck).digest('hex'));
  return params.toString();
}
function setup(options={}){
  const raw=Object.hasOwn(options,'raw')?options.raw:signed();
  const hash=Object.hasOwn(options,'hash')?options.hash:
    '#'+new URLSearchParams({tgWebAppData:raw,tgWebAppVersion:'8.0'}).toString();
  const location={
    hash,
    search:options.search||'',
    origin:'https://xn--80aael4bb1a.xn--p1ai',
  };
  const webapp=Object.hasOwn(options,'sdk')?options.sdk:null;
  const window={
    location,
    ...(webapp===null?{}:{Telegram:{WebApp:webapp}}),
    ...(options.navigation===undefined?{}:{
      performance:{getEntriesByType(type){
        assert.equal(type,'navigation');
        return [{name:options.navigation}];
      }},
    }),
  };
  vm.runInNewContext(source,{window,URL,URLSearchParams},{filename:'miniapp-telegram-context.js'});
  return {window,app:window.HvostTelegramContext};
}

test('Android Telegram can authenticate from signed hash even if the external WebApp script fails',()=>{
  const fixture=setup();
  const context=fixture.app.resolve();
  assert.ok(context);
  assert.equal(typeof context.initData,'string');
  assert.deepEqual(verifyTelegramInitData(context.initData,TOKEN,NOW),{
    id:555666777,first_name:'Ангелина',last_name:'',username:'',
  });
  assert.equal(fixture.app.diagnostic().source,'launch-parameters');
  assert.equal(fixture.app.diagnostic().sdkLoaded,false);
  assert.equal(fixture.app.diagnostic().code,'TG-OK');
  assert.equal(context.requestContact,undefined,'do not synthesize native contact sharing');
  assert.equal(JSON.stringify(fixture.app.diagnostic()).includes('555666777'),false);
});

test('official SDK takes precedence; when present but empty, signed launch data is used',()=>{
  const active={
    initData:signed(101),
    ready(){return 'sdk-ready';},
    requestContact(){return 'native';},
  };
  const a=setup({sdk:active});
  assert.equal(a.app.resolve(),active);
  assert.equal(a.app.diagnostic().source,'sdk');
  assert.equal(a.app.resolve().ready(),'sdk-ready');
  const b=setup({sdk:{initData:'',ready(){return 123;},requestContact(){return 321;}}});
  assert.equal(b.app.resolve().ready(),123);
  assert.equal(b.app.resolve().requestContact(),321);
  assert.deepEqual(verifyTelegramInitData(b.app.resolve().initData,TOKEN,NOW).id,555666777);
});

test('recovery never authorizes missing, unsigned, tampered or expired Telegram data',()=>{
  const missing=setup({hash:'',sdk:null});
  assert.equal(missing.app.resolve(),null);
  assert.equal(missing.app.diagnostic().code,'TG-01');
  assert.match(missing.app.unavailableMessage(),/TG-01/);
  const emptySdk=setup({hash:'',sdk:{initData:''}});
  assert.equal(emptySdk.app.resolve().initData,'');
  assert.equal(emptySdk.app.diagnostic().code,'TG-02');
  assert.match(emptySdk.app.unavailableMessage(),/TG-02/);
  const unsigned=setup({raw:'user=%7B%7D&auth_date='+NOW});
  assert.equal(unsigned.app.resolve(),null);
  const forged=signed().replace('555666777','555666778');
  const tampered=setup({raw:forged});
  assert.equal(tampered.app.resolve().initData,forged);
  assert.throws(()=>verifyTelegramInitData(forged,TOKEN,NOW),/signature/);
  const stale=signed().replace('auth_date='+NOW,'auth_date=1750000000');
  const old=setup({raw:stale});
  assert.throws(()=>verifyTelegramInitData(old.app.resolve().initData,TOKEN,NOW),/expired/);
  // No direct account ID, phone, role, or token gets accepted as auth.
  assert.equal(setup({hash:'#tgWebAppData=555666777'}).app.resolve(),null);
});

test('location search and same-origin current navigation entry support SDK stripping the hash',()=>{
  const raw=signed();
  const search='?view=work&tgWebAppData='+encodeURIComponent(raw);
  assert.equal(setup({hash:'',search}).app.resolve().initData,raw);
  const route='#/work?tgWebAppData='+encodeURIComponent(raw);
  assert.equal(setup({hash:route}).app.resolve().initData,raw);
  const navigation='https://xn--80aael4bb1a.xn--p1ai/miniapp.html'+
    '#tgWebAppData='+encodeURIComponent(raw);
  assert.equal(setup({hash:'',navigation}).app.resolve().initData,raw);
  assert.equal(setup({hash:'',navigation:'https://evil.example/miniapp.html'+
    '#tgWebAppData='+encodeURIComponent(raw)}).app.resolve(),null);
});

test('main Mini App uses fallback before initializing roles and shows retry instead of dead phone button',()=>{
  const bridge=html.indexOf('<script src="/miniapp-telegram-context.js"></script>');
  const roles=html.indexOf('<script src="/miniapp-identity.js"></script>');
  const official=html.indexOf('<script src="https://telegram.org/js/telegram-web-app.js"></script>');
  assert.ok(official>=0 && official<bridge && bridge<roles);
  assert.match(html,/var tg = window\.HvostTelegramContext \?/);
  assert.match(html,/window\.HvostTelegramContext\.resolve\(\)/);
  assert.match(identity,/function telegramUnavailable\(\)/);
  assert.match(identity,/identity\.error = telegramUnavailable\(\)/);
  assert.match(customer,/!isTelegramSigned && window\.HvostTelegramContext/);
  assert.match(customer,/Не удалось проверить вход через Telegram/);
  assert.match(customer,/data-customer-action="retry-telegram"/);
  assert.match(customer,/window\.location\.reload\(\)/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|eval\(|new Function\(/);
});
