'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/max-miniapp.html'),'utf8');
const mini=fs.readFileSync(path.join(root,'public/max-miniapp.js'),'utf8');
const identity=fs.readFileSync(path.join(root,'public/max-miniapp-identity.js'),'utf8');
const work=fs.readFileSync(path.join(root,'public/miniapp-work.js'),'utf8');

test('MAX Mini App includes real shared staff panels, and catalog stays read-only',()=>{
  for(const anchor of ['id="max-tab-work"','id="max-tab-shop"','id="workPage"']){
    assert.ok(html.includes(anchor),anchor);
  }
  for(const file of ['max-miniapp-identity.js','miniapp-work.js','miniapp-tasks.js',
                     'miniapp-admin-warehouse.js','miniapp-admin-product-create.js',
                     'max-miniapp.js','manager-leads.js']){
    assert.ok(html.includes(file),file);
  }
  assert.match(html,/window\.HvostMiniAppPlatform='max'/);
  assert.match(html,/Покупки через MAX пока отключены|Покупки в MAX пока отключены/);
  assert.match(mini,/\/api\/max\/miniapp\/verify/);
  assert.match(mini,/HvostMiniAppIdentity\.init\(data\.user,initData\)/);
  assert.match(mini,/HvostMiniAppWork\.render\(\)/);
  assert.doesNotMatch(html,/telegram-web-app\.js/);
  assert.doesNotMatch(mini,/\/api\/create-payment|\/api\/miniapp\/session/);
});
function harness(initialStorage={},contactGranted=true){
  const storage={...initialStorage};
  const sent=[],on=[],listeners=[];
  const max={
    requestContact:async()=>{
      if(!contactGranted)throw {error:{code:'client.request_phone.user_refused_provide_phone_number'}};
      return {phone:'+79135550001',authDate:'1771000000',hash:'a'.repeat(64)};
    },
  };
  const global={
    WebApp:max,
  };
  const fetch=async(pathname,options={})=>{
    sent.push({pathname,options});
    if(pathname==='/api/max/miniapp/accounts'){
      return {ok:true,json:async()=>({verified:false,accounts:[],ambiguous_roles:[]})};
    }
    if(pathname==='/api/max/miniapp/verify-phone'){
      return {ok:true,json:async()=>({
        verified:true,phone_masked:'+7 (***) ***-**-01',
        accounts:[{role:'partner',name:'Грумер'}],ambiguous_roles:[],
      })};
    }
    if(pathname==='/api/max/miniapp/session'){
      return {ok:true,json:async()=>({
        role:'partner',token:'max-session-token',account:{name:'Грумер'},
      })};
    }
    throw new Error('Unexpected request '+pathname);
  };
  const context={
    window:global,fetch,console,Promise,
    localStorage:{
      getItem:k=>storage[k]||null,
      setItem:(k,v)=>{storage[k]=v;},
      removeItem:k=>{delete storage[k];},
    },
  };
  vm.runInNewContext(identity,context,{filename:'max-miniapp-identity.js'});
  return {api:global.HvostMiniAppIdentity,storage,sent,on,global};
}
test('MAX own native contact triggers server validation and role-specific token',async()=>{
  const h=harness();
  let r=await h.api.init({id:'812345'},'signed-max-initData');
  assert.equal(r.verified,false);
  assert.equal(h.sent[0].pathname,'/api/max/miniapp/accounts');
  const status=await h.api.requestContact();
  assert.equal(status.verified,true);
  assert.deepEqual(Array.from(status.accounts,x=>x.role),['partner']);
  const verify=h.sent.find(x=>x.pathname==='/api/max/miniapp/verify-phone');
  assert.ok(verify);
  const form=JSON.parse(verify.options.body);
  assert.equal(form.init_data,'signed-max-initData');
  assert.equal(form.contact.phone,'+79135550001');
  const result=await h.api.session('partner');
  assert.equal(result.token,'max-session-token');
  assert.equal(h.storage['hm_max_taiga_partner_token'],'max-session-token');
  assert.equal(h.storage.taiga_partner_token,undefined);
  assert.equal(h.storage.taiga_admin_token,undefined);
  await assert.rejects(()=>h.api.session('admin'),/не связан/);
});
test('refused phone grant never opens a privileged panel',async()=>{
  const h=harness({},false);
  await h.api.init({id:'812345'},'signed-max-initData');
  const status=await h.api.requestContact();
  assert.equal(status.verified,false);
  assert.match(status.error,/Не удалось получить номер/);
  assert.equal(h.sent.some(x=>x.pathname==='/api/max/miniapp/session'),false);
});
test('MAX user switch revokes ONLY MAX previous sessions, never Telegram role storage',async()=>{
  const h=harness({
    hm_max_miniapp_last_user:'123',
    hm_max_taiga_partner_token:'previous-max-token',
    hm_max_taiga_admin_token:'previous-max-admin',
    taiga_partner_token:'telegram-partner-remains',
    taiga_admin_token:'telegram-admin-remains',
    hm_max_miniapp_preferred_role:'admin',
  });
  await h.api.init({id:'456'},'signed-max-initData');
  assert.equal(h.storage.hm_max_taiga_partner_token,undefined);
  assert.equal(h.storage.hm_max_taiga_admin_token,undefined);
  assert.equal(h.storage.hm_max_miniapp_preferred_role,undefined);
  assert.equal(h.storage.taiga_partner_token,'telegram-partner-remains');
  assert.equal(h.storage.taiga_admin_token,'telegram-admin-remains');
  assert.equal(h.storage.hm_max_miniapp_last_user,'456');
});
test('shared work module scopes MAX role keys; Telegram keeps original storage keys',()=>{
  assert.match(work,/isMaxMiniApp = window\.HvostMiniAppPlatform === 'max'/);
  assert.match(work,/platformTokenKey\(role\)/);
  assert.match(work,/hm_max_miniapp_work_role/);
  assert.match(work,/role === 'founder'/);
  assert.match(work,/if \(isMaxMiniApp\) return;/);
});

test('MAX reward report UI is admin-only, explicit, and never exposes forwarding targets',async()=>{
 const panel=fs.readFileSync(path.join(root,'public/max-admin-reward-reports.js'),'utf8');
 assert.match(html,/max-admin-reward-reports\.js/);
 assert.match(work,/if\(isMaxMiniApp&&adminRegisterAuthorized\(\)\)html \+= surface\('💸 Отчёты вознаграждений'/);
 assert.match(work,/action==='max-reward-reports'&&isMaxMiniApp&&adminRegisterAuthorized\(\)/);
 assert.match(panel,/Текущая справка к выплате/);
 assert.match(panel,/Расчёт за выбранный период/);
 assert.match(panel,/Отправить PDF мне в MAX/);
 assert.match(panel,/sendRewardReport\(body,config.token\)/);
 assert.doesNotMatch(panel,/target_user_id|chat_id|confirm_transferred/);
 const h=harness();
 await h.api.init({id:123},'signed-max-initData');
 await h.api.requestContact();
 await assert.rejects(()=>h.api.rewardReportOptions({kind:'unpaid'},'max-session-token'),/администратора/);
 assert.equal(h.sent.some(x=>x.pathname.includes('reward-reports')),false);
});
