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
    platform:options.platform||'ios',
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

test('Telegram iPhone has one visible icon button during status check and installs only on tap',()=>{
  const h=harness();
  assert.equal(h.clicks.checked,1,'initial status check is passive');
  assert.equal(h.clicks.added,undefined,'no automatic installation');
  assert.equal(h.api.getStatus(),'checking');
  assert.match(h.api.cardMarkup(),/Сделать иконку ХвостМаркета/);
  assert.ok(h.cards.every(x=>!x.hidden),'home icon action is never hidden while checking');
  assert.ok(h.buttons.every(x=>x.disabled===false));
  assert.equal(h.click(),true);
  assert.equal(h.clicks.added,1,'native install called synchronously from a tap');
  assert.match(h.notices[0].textContent,/Поделиться/,'iPhone-specific Safari instructions are visible');
  h.events.homeScreenAdded();
  assert.equal(h.api.getStatus(),'added');
  assert.ok(h.cards.every(x=>!x.hidden),'repair action stays visible after installation');
  assert.match(h.buttons[0].textContent,/Обновить иконку/);
  assert.equal(h.click(),true,'tapping a completed icon opens the repair guide');
  assert.equal(h.clicks.added,1,'existing installation is not silently replaced');
  assert.match(h.notices[0].textContent,/Open App/);
});

test('missed and unknown Telegram statuses keep the native button available',()=>{
  const h=harness({platform:'android'});
  h.events.homeScreenChecked({status:'unknown'});
  assert.equal(h.api.getStatus(),'unknown');
  assert.match(h.api.actionMarkup(),/Сделать иконку/);
  h.events.homeScreenChecked({status:'missed'});
  assert.equal(h.api.getStatus(),'missed');
  assert.ok(!h.cards[0].hidden);
  assert.equal(h.click(),true);
  assert.equal(h.clicks.added,1);
  assert.match(h.notices[0].textContent,/Подтвердите добавление/);
  h.events.activated();
  assert.equal(h.clicks.checked,2);
});

test('old Telegram and browsers always offer honest manual installation instructions',()=>{
  for(const options of [{versionOk:false},{telegram:false}]){
    const h=harness(options);
    assert.equal(h.api.getStatus(),'unsupported');
    assert.match(h.api.actionMarkup(),/Как сделать иконку/);
    assert.match(h.api.cardMarkup(),/Как сделать иконку/);
    assert.ok(!h.cards[0].hidden);
    assert.equal(h.clicks.checked,undefined);
    assert.equal(h.click(),true,'the visible button opens the manual guide');
    assert.equal(h.clicks.added,undefined,'no unsupported native install calls');
    assert.match(h.notices[0].textContent,/Open App/);
    assert.match(h.notices[0].textContent,/удалите этот значок/);
  }
});

test('failed iOS native call or installation callback still explains the manual route',()=>{
  const h=harness({throwOnInstall:true});
  h.checkCallbacks[0]('missed');
  assert.equal(h.api.requestInstall(),false);
  assert.match(h.notices[0].textContent,/меню/);
  assert.match(h.notices[0].textContent,/Open App/);
  assert.ok(!h.cards[0].hidden);
  h.events.homeScreenFailed();
  assert.match(h.notices[0].textContent,/Telegram не подтвердил/);
});

test('Telegram never invoking checkHomeScreenStatus callback does not block button',()=>{
  const h=harness();
  assert.equal(h.api.getStatus(),'checking');
  assert.ok(h.cards.every(x=>!x.hidden));
  assert.equal(h.click(),true);
  assert.equal(h.clicks.added,1);
});

test('same shortcut appears in storefront and account selection for all roles',()=>{
  assert.match(html,/class="hm-home-card" data-hm-home-card>/);
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
  assert.match(css,/white-space:pre-line/);
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
