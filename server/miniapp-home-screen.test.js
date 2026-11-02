'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..','public');
const source=fs.readFileSync(path.join(root,'miniapp-home-screen.js'),'utf8');
const html=fs.readFileSync(path.join(root,'miniapp.html'),'utf8');
const buyer=fs.readFileSync(path.join(root,'miniapp-customer.js'),'utf8');
const staff=fs.readFileSync(path.join(root,'miniapp-work.js'),'utf8');
const css=fs.readFileSync(path.join(root,'miniapp-home-screen.css'),'utf8');

function harness(options={}){
  const events={},clicks={};
  const checkCallbacks=[];
  const cards=[{hidden:true},{hidden:true}];
  const buttons=[{disabled:true},{disabled:true}];
  const notices=[{textContent:'',hidden:true},{textContent:'',hidden:true}];
  const telegram=options.telegram===false?null:{
    initData:'signed-telegram-data',
    addToHomeScreen(){clicks.added=(clicks.added||0)+1; if(options.throwOnInstall)throw Error('unsupported now');},
    checkHomeScreenStatus(callback){checkCallbacks.push(callback);clicks.checked=(clicks.checked||0)+1;},
    onEvent(name,fn){events[name]=fn;},
    isVersionAtLeast(){return options.versionOk!==false;},
  };
  const document={
    querySelectorAll(selector){
      if(selector==='[data-hm-home-card]')return cards;
      if(selector==='[data-hm-home-add]')return buttons;
      if(selector==='[data-hm-home-feedback]')return notices;
      return [];
    },
    addEventListener(type,fn){events['document:'+type]=fn;},
  };
  const window=telegram?{Telegram:{WebApp:telegram}}:{};
  const context=vm.createContext({window,document});
  vm.runInContext(source,context,{filename:'miniapp-home-screen.js'});
  const api=window.HvostMiniAppHomeScreen;
  const click=()=>{
    let prevented=false;
    const target={closest(selector){
      return selector==='[data-hm-home-add]'?{dataset:{hmHomeAdd:''}}:null;
    }};
    events['document:click']({target,preventDefault(){prevented=true;}});
    return prevented;
  };
  return {api,events,cards,buttons,notices,clicks,checkCallbacks,click};
}

test('Telegram Bot API 8.0+ offers one shared home-screen shortcut only on user tap',()=>{
  const h=harness();
  assert.equal(h.clicks.checked,1,'initial check queries status without installing');
  assert.equal(h.clicks.added,undefined,'no automatic install request');
  assert.equal(h.api.getStatus(),'checking');
  assert.equal(h.api.cardMarkup().includes(' hidden'),true);
  h.checkCallbacks[0]('missed');
  assert.equal(h.api.getStatus(),'missed');
  assert.ok(h.cards.every(x=>x.hidden===false));
  assert.ok(h.buttons.every(x=>x.disabled===false));
  assert.match(h.api.cardMarkup(),/Добавить на экран телефона/);
  assert.match(h.api.actionMarkup(),/data-hm-home-add/);
  assert.equal(h.click(),true);
  assert.equal(h.clicks.added,1);
  assert.match(h.notices[0].textContent,/Подтвердите добавление/);
  h.events.homeScreenAdded();
  assert.equal(h.api.getStatus(),'added');
  assert.ok(h.cards.every(x=>x.hidden===true));
  assert.ok(h.buttons.every(x=>x.disabled===true));
  assert.equal(h.click(),true);
  assert.equal(h.clicks.added,1,'already-installed icon never requests another shortcut');
});

test('Telegram status unknown still permits install, added/unsupported status hides prompt',()=>{
  const h=harness();
  h.events.homeScreenChecked({status:'unknown'});
  assert.equal(h.api.getStatus(),'unknown');
  assert.match(h.api.actionMarkup(),/data-hm-home-add/);
  assert.ok(!h.cards[0].hidden);
  h.events.homeScreenChecked({status:'added'});
  assert.equal(h.api.getStatus(),'added');
  assert.ok(h.cards[0].hidden);
  h.events.homeScreenChecked({status:'missed'});
  assert.ok(!h.cards[0].hidden);
  h.events.activated();
  assert.equal(h.clicks.checked,2);
  h.checkCallbacks[1]('unsupported');
  assert.equal(h.api.getStatus(),'unsupported');
  assert.equal(h.api.actionMarkup().includes('hidden'),true);
});

test('older Telegram and ordinary browsers never invoke unsupported native API',()=>{
  for(const options of [{versionOk:false},{telegram:false}]){
    const h=harness(options);
    assert.equal(h.api.getStatus(),'unsupported');
    assert.equal(h.api.actionMarkup(),'');
    assert.equal(h.api.cardMarkup(),'');
    assert.equal(h.clicks.checked,undefined);
    assert.equal(h.click(),false);
    assert.equal(h.clicks.added,undefined);
  }
});

test('native installation errors do not interrupt page and explain the manual route',()=>{
  const h=harness({throwOnInstall:true});
  h.checkCallbacks[0]('missed');
  assert.equal(h.api.requestInstall(),false);
  assert.match(h.notices[0].textContent,/меню/);
  assert.ok(!h.cards[0].hidden);
});

test('same shortcut appears in storefront and account selection for all roles',()=>{
  assert.match(html,/data-hm-home-card hidden/);
  assert.match(html,/data-hm-home-add/);
  assert.match(html,/src="\/miniapp-home-screen\.js"/);
  assert.match(html,/href="\/miniapp-home-screen\.css"/);
  assert.match(html,/rel="manifest" href="\/manifest-miniapp\.json"/);
  assert.match(buyer,/function shortcutAction\(/);
  assert.match(buyer,/return content \+ shortcutAction\(\)/);
  assert.match(buyer,/action\('notifications',[^\n]+\+\s*\n\s*shortcutAction\(\)/);
  assert.match(staff,/function shortcutAction\(/);
  assert.match(staff,/function dashboardFooter\(role\)[\s\S]*shortcutAction\(\)/);
  assert.match(staff,/if \(role === 'salon'\)/);
  for(const role of ['partner','owner','manager','founder','admin','salon']){
    assert.match(staff,new RegExp("role.*"+role));
  }
  assert.match(staff,/renderAll\(\)[\s\S]*?shortcutAction\(\)/);
  assert.match(css,/\[data-hm-home-card\]\[hidden\]/);
});

test('manifest uses the same existing Mini App entry and installed public icons',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest-miniapp.json'),'utf8'));
  assert.equal(manifest.short_name,'ХвостМаркет');
  assert.equal(manifest.start_url,'/miniapp.html');
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.scope,'/');
  for(const icon of manifest.icons){
    assert.ok(fs.existsSync(path.join(root,icon.src.replace(/^\//,''))),icon.src);
  }
  assert.ok(fs.existsSync(path.join(root,'images/hvostmarket-mark-v4-transparent.png')));
  // A home-screen launch should not bypass Telegram phone or role verification.
  assert.match(html,/if\(view==='work'&&!isPhoneAccessUnlocked\(\)\)view='profile'/);
  assert.match(staff,/!phoneRoleAvailable\(role\)/);
});
