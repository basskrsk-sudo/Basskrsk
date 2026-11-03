'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../public/miniapp-promos.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/miniapp.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.css'),'utf8');
const work=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
const personalPartner={
  id:53,point_id:'bark-lay',active:1,partner_code:'GR-053',
  first_purchase_promo_code:'HV20-G-053',
  current_point:{id:'bark-lay',name:'БаркЛай',city_id:'krsk',
    first_purchase_promo_code:'HV20-002'},
};
function harness(opts={}){
  const events={};
  const elements={};
  const root={
    addEventListener(name,handler){events[name]=handler;},
    innerHTML:'',
  };
  const document={
    getElementById(id){
      if(id==='workPage')return root;
      if(!elements[id])elements[id]={textContent:'',value:''};
      return elements[id];
    },
  };
  const copied=[];
  const prompts=[];
  const navigator=opts.clipboard === false ? {} : {clipboard:{
    writeText(value){
      copied.push(value);
      if(opts.denied) return Promise.reject(new Error('Clipboard denied'));
      return Promise.resolve();
    },
  }};
  const window={navigator,prompt:(message,value)=>prompts.push({message,value})};
  vm.runInNewContext(source,{document,window,console},{filename:'miniapp-promos.js'});
  const api=window.HvostMiniAppPromos;
  const click=async(key)=>{
    let prevented=false;
    await events.click({
      target:{closest(selector){
        if(selector==='[data-hm-promo-key]')return {dataset:{hmPromoKey:key}};
        return null;
      }},
      preventDefault(){prevented=true;},
    });
    return prevented;
  };
  return {api,root,window,click,copied,prompts,elements};
}

test('groomer card shows personal and canonical active salon 20% codes and referral links',()=>{
  const h=harness();
  const markup=h.api.section(personalPartner,()=>true);
  assert.match(markup,/Мои промокоды/);
  assert.match(markup,/HV20-G-053/);
  assert.match(markup,/HV20-002/);
  assert.match(markup,/GR-053/);
  assert.match(markup,/БаркЛай/);
  assert.match(markup,/partner-invite\.html\?ref=GR-053/);
  assert.match(markup,/ref=bark-lay&amp;partner=53&amp;promo=HV20-G-053&amp;city=krsk/);
  assert.equal((markup.match(/data-hm-promo-key=/g)||[]).length,5);
  assert.match(markup,/один раз.*номер телефона/);
});

test('groomer can copy each code directly in Telegram after verifying role',async()=>{
  const h=harness();
  h.api.section(personalPartner,()=>true);
  for(const [key,value] of [
    ['groomer','HV20-G-053'],['salon','HV20-002'],['referral','GR-053'],
  ]){
    assert.equal(await h.click(key),true);
    assert.equal(h.copied.at(-1),value);
  }
  await h.click('buyer');
  assert.match(h.copied.at(-1),/partner=53&promo=HV20-G-053/);
  await h.click('registration');
  assert.equal(h.copied.at(-1),'https://хвостмаркет.рф/partner-invite.html?ref=GR-053');
  assert.match(h.elements.workPromoCopyStatus.textContent,/Скопировано/);
});

test('unverified or expired role and role-switch clear cannot copy previously loaded codes',async()=>{
  const h=harness();
  let allowed=true;
  h.api.section(personalPartner,()=>allowed);
  allowed=false;
  await h.click('groomer');
  assert.equal(h.copied.length,0);
  allowed=true;
  h.api.clear();
  await h.click('groomer');
  assert.equal(h.copied.length,0);
  // Guest without an authenticated, server-sourced partner never sees codes.
  assert.equal(h.api.section(null,()=>true),'');
  assert.equal(h.copied.length,0);
});

test('closed or replaced salon code and shopper link are not exposed to a groomer',async()=>{
  const h=harness();
  const old={
    ...personalPartner,
    point_id:'new-salon',
    current_point:{...personalPartner.current_point,name:'<script>Bad</script>',
      first_purchase_promo_code:'HV20-PRIVATE-OLD'},
  };
  const markup=h.api.section(old,()=>true);
  assert.doesNotMatch(markup,/HV20-PRIVATE-OLD/);
  assert.doesNotMatch(markup,/data-hm-promo-key="salon"/);
  assert.doesNotMatch(markup,/data-hm-promo-key="buyer"/);
  await h.click('salon');
  await h.click('buyer');
  assert.deepEqual(h.copied,[]);
});

test('all displayed dynamic values are escaped as HTML before rendering',()=>{
  const h=harness();
  const p={
    ...personalPartner,partner_code:'GR-053"><script>alert(1)</script>',
    current_point:{...personalPartner.current_point,name:'<script>bad</script>'},
  };
  const markup=h.api.section(p,()=>true);
  assert.doesNotMatch(markup,/<script>/);
  assert.match(markup,/&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(markup,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('denied WebView clipboard offers user-visible manual copying fallback',async()=>{
  const h=harness({denied:true});
  h.api.section(personalPartner,()=>true);
  await h.click('groomer');
  assert.equal(h.prompts.length,1);
  assert.equal(h.prompts[0].value,'HV20-G-053');
  assert.match(h.elements.workPromoCopyStatus.textContent,/Не удалось скопировать/);
});

test('promo script is loaded before role dashboards and resets on account switch',()=>{
  assert.ok(html.indexOf('/miniapp-promos.js')>0);
  assert.ok(html.indexOf('/miniapp-promos.js')<html.indexOf('/miniapp-work.js'));
  assert.match(css,/\.work-promo-value/);
  assert.match(work,/function groomerPromoSection/);
  assert.match(work,/groomerPromoSection\(partner\)/);
  assert.match(work,/groomerPromoSection\(currentUser\)/);
  assert.match(work,/clearGroomerPromos\(\)/);
  assert.match(work,/phoneRoleAvailable\('partner'\)/);
});

test('owner-only invitation is copyable, records 1000 RUB without claiming money transferred',async()=>{
  const h=harness();
  const owner={id:42,active:1,owner_code:'OWN-042',referrals:{
    awaiting:1000,payable:2000,paid:1000,rows:[
      {point_id:'a',point_name:'Дог Стиль',amount:1000,status:'awaiting'},
    ],
  }};
  const markup=h.api.ownerSection(owner,()=>true);
  assert.match(markup,/OWN-042/);
  assert.match(markup,/partner-invite\.html\?ref=OWN-042/);
  assert.match(markup,/2 000 ₽ прямой прибыли/);
  assert.match(markup,/Дог Стиль/);
  assert.match(markup,/Ожидают порога прибыли/);
  assert.match(markup,/Доступны к выплате/);
  assert.match(markup,/Выплачено/);
  assert.equal(await h.click('ownerInvite'),true);
  assert.equal(h.copied.at(-1),'https://хвостмаркет.рф/partner-invite.html?ref=OWN-042');
  h.api.clear();
  await h.click('ownerInvite');
  assert.equal(h.copied.length,1);
});
test('combined groomer and owner can copy both referral links without losing either role',async()=>{
  const h=harness();
  h.api.section(personalPartner,()=>true);
  h.api.ownerSection({id:3,active:1,owner_code:'OWN-003'},()=>true,true);
  await h.click('registration');
  assert.equal(h.copied.at(-1),'https://хвостмаркет.рф/partner-invite.html?ref=GR-053');
  await h.click('ownerInvite');
  assert.equal(h.copied.at(-1),'https://хвостмаркет.рф/partner-invite.html?ref=OWN-003');
});
test('owner referral invitation requires verified owner role and cannot be read from guest data',async()=>{
  const h=harness();
  assert.equal(h.api.ownerSection(null,()=>true),'');
  assert.equal(h.api.ownerSection({id:42,owner_code:'OWN-042',active:0},()=>true),'');
  let active=true;
  h.api.ownerSection({id:42,owner_code:'OWN-042',active:1},()=>active);
  active=false;
  await h.click('ownerInvite');
  assert.equal(h.copied.length,0);
});
