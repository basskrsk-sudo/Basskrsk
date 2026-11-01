'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','notification-settings.js'),'utf8');
const publicDir=path.join(__dirname,'..','public');

function harness(responses={}) {
  const records=[];
  const controls={};
  const root={
    innerHTML:'',handlers:{},
    addEventListener(name,fn){this.handlers[name]=fn;},
    querySelectorAll(){return Object.values(controls);},
  };
  const fetch=async(url,init)=>{
    records.push({url,init});
    const role=String(init.headers.Authorization||'').replace('Bearer ','');
    const result=responses[role]||[];
    return {ok:true,status:200,json:async()=>({
      role,settings:init.method==='PUT'
        ?result.map(x=>({...x,enabled:x.locked?true:init.body?JSON.parse(init.body).settings[x.key]:x.enabled}))
        :result,
    })};
  };
  const fakeWindow={},ctx=vm.createContext({
    window:fakeWindow,fetch,console,WeakMap,Promise,localStorage:{getItem(){return null;}},document:{},
  });
  vm.runInContext(source,ctx);
  return {
    root,controls,records,settings:fakeWindow.HvostNotificationSettings,
    click(attr){
      const btn={dataset:{},hasAttribute(name){return name===attr;}};
      root.handlers.click({preventDefault(){},target:{
        closest(){return btn;},
      }});
    },
  };
}
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

test('combined groomer-owner screen shows separate editable groups and saves both under their own bearer sessions',async()=>{
  const h=harness({
    groomerToken:[{key:'sales',label:'Мои продажи',help:'События',enabled:true,locked:false},
      {key:'payouts',label:'Мои выплаты',help:'Выплаты',enabled:true,locked:false}],
    ownerToken:[{key:'sales',label:'Продажи салона',help:'Заказы',enabled:false,locked:false},
      {key:'payouts',label:'Выплаты салону',help:'Выплаты',enabled:true,locked:false}],
  });
  let returned=0;
  h.settings.open({root:h.root,roles:['partner','owner'],tokens:{
    partner:'groomerToken',owner:'ownerToken'},back(){returned++;}});
  await flush();
  assert.match(h.root.innerHTML,/🔔 Настройки уведомлений/);
  assert.match(h.root.innerHTML,/Мои продажи/);
  assert.match(h.root.innerHTML,/Продажи салона/);
  assert.equal(h.records.length,2);
  assert.ok(h.records.every(x=>x.init.method==='GET'));
  h.controls.a={dataset:{hmNotifyRole:'partner',hmNotifyKey:'sales'},checked:false};
  h.controls.b={dataset:{hmNotifyRole:'partner',hmNotifyKey:'payouts'},checked:true};
  h.controls.c={dataset:{hmNotifyRole:'owner',hmNotifyKey:'sales'},checked:true};
  h.controls.d={dataset:{hmNotifyRole:'owner',hmNotifyKey:'payouts'},checked:false};
  h.click('data-hm-notify-save');
  await flush();
  const saves=h.records.filter(x=>x.init.method==='PUT');
  assert.equal(saves.length,2);
  assert.deepEqual(JSON.parse(saves[0].init.body).settings,{sales:false,payouts:true});
  assert.deepEqual(JSON.parse(saves[1].init.body).settings,{sales:true,payouts:false});
  assert.equal(saves[0].init.headers.Authorization,'Bearer groomerToken');
  assert.equal(saves[1].init.headers.Authorization,'Bearer ownerToken');
  assert.match(h.root.innerHTML,/Настройки сохранены/);
  h.click('data-hm-notify-back');
  assert.equal(returned,1);
});

test('customer receipt is shown as mandatory and is not sent to toggling API',async()=>{
  const h=harness({customerToken:[
    {key:'purchase',label:'Оплаченный заказ',help:'Подтверждение',enabled:true,locked:true},
    {key:'offers',label:'Предложения',help:'Скидки',enabled:false,locked:false},
  ]});
  h.settings.open({root:h.root,roles:['customer'],tokens:{customer:'customerToken'}});
  await flush();
  assert.match(h.root.innerHTML,/Обязательное сообщение/);
  assert.match(h.root.innerHTML,/disabled/);
  h.controls.x={dataset:{hmNotifyRole:'customer',hmNotifyKey:'purchase'},checked:false};
  h.controls.y={dataset:{hmNotifyRole:'customer',hmNotifyKey:'offers'},checked:true};
  h.click('data-hm-notify-save');
  await flush();
  const save=h.records.find(x=>x.init.method==='PUT');
  assert.deepEqual(JSON.parse(save.init.body).settings,{offers:true});
});

test('every existing full web cabinet installs settings with its own role and existing token source',()=>{
  const pages={
    'taiga-groomer.html':'partner',
    'taiga-owner.html':'owner',
    'taiga-manager.html':'manager',
    'taiga-admin.html':'admin',
    'taiga-warehouse.html':'warehouse',
  };
  for(const [file,role] of Object.entries(pages)){
    const html=fs.readFileSync(path.join(publicDir,file),'utf8');
    assert.match(html,/notification-settings.css/);
    assert.match(html,/notification-settings.js/);
    assert.ok(html.includes('installFull("'+role+'"'));
  }
  const mini=fs.readFileSync(path.join(publicDir,'miniapp.html'),'utf8');
  const work=fs.readFileSync(path.join(publicDir,'miniapp-work.js'),'utf8');
  const customer=fs.readFileSync(path.join(publicDir,'miniapp-customer.js'),'utf8');
  assert.match(mini,/notification-settings.js/);
  assert.match(work,/data-work-action="notifications"/);
  assert.match(work,/roles = selectedRole === 'salon' \? \['partner','owner'\]/);
  assert.match(customer,/data.customerAction === 'notifications'|customerAction === 'notifications'/);
  assert.match(customer,/action\('notifications', '🔔 Настройки уведомлений'/);
});
