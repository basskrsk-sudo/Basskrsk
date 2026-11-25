'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const identityCode = fs.readFileSync(path.join(__dirname, '..', 'public/miniapp-identity.js'), 'utf8');
const customerCode = fs.readFileSync(path.join(__dirname, '..', 'public/miniapp-customer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public/miniapp.html'), 'utf8');

function setupIdentity(initialVerified = false, share = true, supported = true, combined = false) {
  let verified = initialVerified;
  let preferred = 'partner';
  const sent = [];
  const saved = {};
  const events = {};
  const telegram = {
    initData: 'signed-initdata-for-test-only',
    onEvent(event, fn) { events[event] = fn; },
    ...(supported ? { requestContact(callback) { verified = share; callback(share); } } : {}),
  };
  const fakeWindow = {};
  const fakeDoc = { addEventListener() {} };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ url, body });
    if (url === '/api/miniapp/accounts') return {
      ok: true, json: async () => ({
        verified,
        phone_masked: verified ? '+7 (***) ***-**-77' : '',
        accounts: verified ? [{ role: 'customer', name: 'Покупатель' },
                              { role: 'partner', name: 'Грумер' }].concat(combined ? [{ role: 'owner', name: 'Владелец' }] : []) : [],
        ambiguous_roles: [],
        combined_salon: combined,
        preferred_role: verified ? preferred : null,
      }),
    };
    if (url === '/api/miniapp/verify-phone') {
      if (!verified || body.phone !== '79131234577') {
        return {ok:false,status:403,json:async()=>({error:'Номер не подтверждён в Telegram'})};
      }
      return {ok:true,json:async()=>({
        verified:true, phone_masked:'+7 (***) ***-**-77',
        accounts:[{role:'customer',name:'Покупатель'},{role:'partner',name:'Грумер'}].concat(combined ? [{role:'owner',name:'Владелец'}] : []),
        ambiguous_roles:[],
        combined_salon: combined,
        preferred_role: preferred,
      })};
    }
    if (url === '/api/miniapp/preferred-role') {
      if (!verified || !['shop','customer','partner','owner','salon'].includes(body.role)) {
        return {ok:false,status:403,json:async()=>({error:'Нет доступа'})};
      }
      preferred=body.role;
      return {ok:true,json:async()=>({ok:true,preferred_role:preferred})};
    }
    if (url === '/api/miniapp/session') return {
      ok: true,
      json: async () => ({ token: 'server-signed-' + body.role, role: body.role, account: { name: 'Тест' } }),
    };
    return { ok: false, status: 404, json: async () => ({ error: 'No mock' }) };
  };
  const context = {
    window: fakeWindow, document: fakeDoc, fetch,
    localStorage: {
      setItem(key, val) { saved[key] = val; },
      getItem(key) { return saved[key] || null; },
      removeItem(key) { delete saved[key]; },
    },
    setTimeout(fn) { fn(); },
    clearTimeout() {},
    console,
    Promise,
  };
  vm.runInNewContext(identityCode, context);
  return { identity: fakeWindow.HvostMiniAppIdentity, telegram, sent, saved, events };
}

test('sharing the OWN Telegram contact enables passwordless account access without typing', async () => {
  const h = setupIdentity();
  await h.identity.init(h.telegram);
  assert.equal(h.identity.getStatus().verified, false);
  await assert.rejects(()=>h.identity.session('partner'), /подтверждённым номером/);
  const after = await h.identity.requestContact();
  assert.equal(after.contactVerified, true);
  assert.equal(after.verified, true, 'signed Telegram + own shared contact is sufficient proof');
  assert.equal(after.phoneMasked,'+7 (***) ***-**-77');
  assert.deepEqual(Array.from(after.accounts,a=>a.role),['customer','partner']);
  const session = await h.identity.session('partner');
  assert.equal(session.token,'server-signed-partner');
  assert.equal(h.saved.taiga_partner_token,'server-signed-partner');
  assert.ok(h.sent.every(x=>x.body.initData===h.telegram.initData));
  assert.equal(h.sent.filter(x=>x.url==='/api/miniapp/verify-phone').length,0,
    'no redundant manual phone check');
  assert.equal(typeof h.events.activated,'function');
});

test('returning user with a server-verified own contact enters immediately', async () => {
  const h=setupIdentity(true);
  const initial=await h.identity.init(h.telegram);
  assert.equal(initial.contactVerified,true);
  assert.equal(initial.verified,true);
  assert.equal(initial.preferredRole,'partner');
  assert.deepEqual(Array.from(initial.accounts,a=>a.role),['customer','partner']);
  const token=await h.identity.session('partner');
  assert.equal(token.role,'partner');
  assert.equal(h.sent.filter(x=>x.url==='/api/miniapp/verify-phone').length,0);
  assert.equal(await h.identity.rememberRole('customer'),true);
  assert.equal(h.identity.getStatus().preferredRole,'customer');
  assert.equal(await h.identity.rememberRole('admin'),false);
  const revived=await h.identity.refresh();
  assert.equal(revived.preferredRole,'customer');
});

test('cancelled Telegram phone consent does not give access', async () => {
  const h = setupIdentity(false, false);
  await h.identity.init(h.telegram);
  const s = await h.identity.requestContact();
  assert.equal(s.verified, false);
  await assert.rejects(() => h.identity.session('partner'), /подтверждённым номером/);
  assert.equal(h.sent.some(x => x.url === '/api/miniapp/session'), false);
});

test('old Telegram without native contact popup shows /phone fallback', async () => {
  const h = setupIdentity(false, false, false);
  await h.identity.init(h.telegram);
  await h.identity.requestContact();
  assert.match(h.identity.getStatus().error, /\/phone/);
});


test('switching signed Telegram users invalidates prior local staff and customer sessions', async () => {
  const h = setupIdentity(true);
  h.saved.hm_miniapp_last_telegram_user = '100';
  h.saved.taiga_partner_token = 'partner-of-previous-telegram-user';
  h.saved.taiga_customer_token = 'customer-of-previous-telegram-user';
  h.saved.taiga_admin_token = 'admin-of-previous-telegram-user';
  await h.identity.init(h.telegram, { id: 200, first_name: 'Другой аккаунт' });
  assert.equal(h.saved.taiga_partner_token, undefined);
  assert.equal(h.saved.taiga_customer_token, undefined);
  assert.equal(h.saved.taiga_admin_token, undefined);
  assert.equal(h.saved.hm_miniapp_last_telegram_user, '200');
});

test('customer tab is connected to phone-gated existing orders and bones APIs', async () => {
  const elements = {
    profilePage: {
      innerHTML: '', listeners: {},
      classList: { contains() { return false; } },
      addEventListener(name, fn) { this.listeners[name] = fn; },
    },
  };
  const fakeDocument = { getElementById(id) { return elements[id]; } };
  const mock = {
    getStatus() { return { verified: true, phoneMasked: '+7 (***) ***-**-77',
      accounts: [{ role: 'customer', name: 'Покупатель' }], ambiguousRoles: [], error: '' }; },
    session: async (role) => ({ role, token: 'customer-session' }),
    onChange() {},
  };
  const calls = [];
  const response = {
    '/api/customer/me': { customer: { name: 'Ольга', orders_count: 2, total_spent: 750,
      pet_name: 'Жужа', bones_balance: 40 } },
    '/api/customer/me/orders': { orders: [{ total: 400, status: 'paid',
      created_at: '2026-10-31 09:00:00', items: [{ name: 'Сердце говяжье', weight: '50 г' }] }] },
    '/api/customer/me/bones': { balance: 40, transactions: [
      { amount: 20, description: 'За покупку', created_at: '2026-10-31 09:00:00' },
    ] },
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => response[url] };
  };
  const window = { HvostMiniAppIdentity: mock };
  vm.runInNewContext(customerCode, { window, document: fakeDocument, fetch, console, Promise });
  window.HvostMiniAppCustomer.render({ first_name: 'Ольга' }, true);
  assert.match(elements.profilePage.innerHTML, /data-customer-role="customer"/);
  assert.equal(calls.length, 0, 'no customer API calls until customer chooses their cabinet');
  elements.profilePage.listeners.click({
    target: { closest() { return { dataset: { customerAction: 'choose-role', customerRole: 'customer' } }; } },
  });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.match(elements.profilePage.innerHTML, /Ольга/);
  assert.match(elements.profilePage.innerHTML, /Жужа/);
  assert.match(elements.profilePage.innerHTML, /Сердце говяжье/);
  assert.match(elements.profilePage.innerHTML, /Мои косточки/);
  assert.ok(calls.every(x => x.options.headers.Authorization === 'Bearer customer-session'));
});

test('main Mini App loads account identity before both customer and role interfaces', () => {
  const a = html.indexOf('<script src="/miniapp-identity.js"></script>');
  const b = html.search(/<script src="\/miniapp-work\.js(?:\?v=[^"]+)?"><\/script>/);
  const c = html.indexOf('<script src="/miniapp-customer.js"></script>');
  assert.ok(a > 0 && a < b && b < c);
  assert.match(html, /HvostMiniAppIdentity\.init\(tg\)/);
  assert.match(html, /HvostMiniAppCustomer\.render\(state\.user,state\.verified\)/);
});


test('combined salon remains an authorized presentation role on a returning launch', async () => {
  const h=setupIdentity(true,true,true,true);
  const status=await h.identity.init(h.telegram);
  assert.equal(status.verified,true);
  assert.equal(status.combinedSalon,true);
  assert.deepEqual(Array.from(status.accounts,a=>a.role),['customer','partner','owner']);
  assert.equal(await h.identity.rememberRole('salon'),true);
  assert.equal(h.identity.getStatus().preferredRole,'salon');
  await assert.rejects(()=>h.identity.session('salon'),/Неизвестный тип кабинета/,
    'salon is a UI representation, never an independent server-issued role');
  const partner=await h.identity.session('partner');
  const owner=await h.identity.session('owner');
  assert.equal(partner.role,'partner');
  assert.equal(owner.role,'owner');
  const ref=await h.identity.refresh();
  assert.equal(ref.combinedSalon,true);
});

test('two Mini App resume signals share one signed refresh; next resume rechecks access',async()=>{
  let timestamp=10000,requests=0;
  const responseResolvers=[],eventHandlers={},documentHandlers={};
  const storage={};
  const FakeDate=class extends Date { static now(){return timestamp;} };
  const tg={initData:'signed-telegram-A',onEvent(name,callback){eventHandlers[name]=callback;}};
  const doc={hidden:false,addEventListener(name,callback){documentHandlers[name]=callback;}};
  const browser={};
  const fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.initData,tg.initData,'signed data is always supplied');
    if(url==='/api/miniapp/accounts'){
      requests++;
      return new Promise(resolve=>responseResolvers.push(data=>resolve({
        ok:true,json:async()=>data,
      })));
    }
    if(url==='/api/miniapp/preferred-role')return {
      ok:true,json:async()=>({ok:true,preferred_role:body.role}),
    };
    throw new Error('Unexpected route '+url);
  };
  vm.runInNewContext(identityCode,{
    window:browser,document:doc,fetch,Date:FakeDate,Promise,console,
    localStorage:{
      getItem(k){return storage[k]||null;},
      setItem(k,v){storage[k]=String(v);},
      removeItem(k){delete storage[k];},
    },
  });
  const identity=browser.HvostMiniAppIdentity;
  const state=(verified,preferredRole='partner')=>({
    verified,phone_masked:verified?'+7 (***) ***-**-11':'',
    accounts:verified?[{role:'partner',name:'Тестовый грумер'}]:[],
    ambiguous_roles:[],combined_salon:false,
    preferred_role:verified?preferredRole:null,
  });
  const first=identity.init(tg,{id:101,first_name:'Тест'});
  const parallelA=eventHandlers.activated();
  doc.hidden=false;
  const parallelB=documentHandlers.visibilitychange();
  assert.equal(requests,1,'init + activate + visible share a single in-flight request');
  responseResolvers.shift()(state(true));
  await Promise.all([first,parallelA,parallelB]);
  assert.equal(identity.getStatus().verified,true);

  // Selecting a role already persisted on the server must not produce a
  // redundant write each time users tap the same cabinet.
  await identity.rememberRole('partner');
  assert.equal(requests,1);
  timestamp+=2000;
  const reopened=eventHandlers.activated();
  documentHandlers.visibilitychange();
  assert.equal(requests,2,'a later activation must revalidate against the server');
  responseResolvers.shift()(state(false));
  await reopened;
  assert.equal(identity.getStatus().verified,false,'revoked role takes effect on reopen');

  // Late success from an older Telegram account must not restore its roles.
  timestamp+=2000;
  const oldRequest=identity.refresh();
  assert.equal(requests,3);
  tg.initData='signed-telegram-B';
  const newRequest=identity.init(tg,{id:102,first_name:'Другой'});
  assert.equal(requests,4);
  responseResolvers.pop()(state(false));
  await newRequest;
  responseResolvers.shift()(state(true));
  await oldRequest;
  assert.equal(identity.getStatus().verified,false);
  assert.equal(storage.hm_miniapp_last_telegram_user,'102');
});

test('initial profile and payment-return launches skip catalog; shopping loads once',async()=>{
  const start=html.indexOf('async function init(){');
  const end=html.indexOf("\nel('pointButton').addEventListener",start);
  assert.ok(start>0&&end>start);
  const code=html.slice(start,end);
  async function launch(search){
    const requests=[],calls=[];
    const context={
      window:{
        HvostMiniAppReliability:{registerRecovery(){},markReady(){calls.push('ready');}},
      },
      state:{view:'shop'},location:{search},URLSearchParams,
      setView(view){this.state.view=view;},
      syncPhoneAccess(){},renderProfile(){},renderCartIndicators(){},
      async auth(){},
      async refreshCatalogIfStale(){requests.push('catalog');},
      async checkPaymentReturn(code){calls.push('payment:'+code);},
      refreshReadOnlyAfterReconnect(){},
    };
    // vm functions called directly reference context globals, not this.
    context.setView=function(view){context.state.view=view;};
    vm.runInNewContext(code,context);
    await vm.runInNewContext('init()',context);
    return {requests,calls,view:context.state.view};
  }
  let result=await launch('');
  assert.equal(result.view,'profile');
  assert.deepEqual(result.requests,[],'partner and profile launches need no catalog SQL');
  assert.ok(result.calls.includes('ready'));
  result=await launch('?view=shop');
  assert.deepEqual(result.requests,['catalog']);
  result=await launch('?point=point-qr');
  assert.deepEqual(result.requests,['catalog'],'direct QR shopping still loads stock immediately');
  result=await launch('?payment_return=ORDER_XYZ123');
  assert.deepEqual(result.requests,[],'payment return never waits for catalog');
  assert.ok(result.calls.includes('payment:ORDER_XYZ123'));
});

test('catalog retries are single-flight and do not re-download until stale',async()=>{
  const start=html.indexOf('async function refreshCatalogIfStale(){');
  const end=html.indexOf('\nfunction setView(view',start);
  assert.ok(start>0&&end>start);
  const code=html.slice(start,end);
  const pending=[],calls=[],rendered=[];
  const state={pointId:'',points:[],products:[],cart:[],view:'shop'};
  const dom={'pointName':{textContent:''}};
  const context={
    state,catalogStale:true,catalogRefreshPromise:null,
    location:{search:'?point=salon-qr'},URLSearchParams,
    readPoint:()=>'',currentPoint:()=>state.points.find(p=>p.id===state.pointId),
    selectPoint(id){state.pointId=String(id);},
    el(id){return dom[id]||(dom[id]={textContent:''});},
    renderProducts(){rendered.push('products');},
    renderCart(){rendered.push('cart');},
    renderCheckout(){rendered.push('checkout');},
    renderCartIndicators(){},
    toast(){},
    api(url){
      calls.push(url);
      return new Promise(resolve=>pending.push({url,resolve}));
    },
  };
  vm.runInNewContext(code,context);
  const one=vm.runInNewContext('refreshCatalogIfStale()',context);
  const two=vm.runInNewContext('refreshCatalogIfStale()',context);
  assert.equal(calls.length,2,'overlapping requests share one products + points batch');
  pending.find(x=>x.url==='/api/products').resolve({products:[{name:'Лакомство'}]});
  pending.find(x=>x.url==='/api/points').resolve({points:[{id:'salon-qr',name:'Салон QR'}]});
  await Promise.all([one,two]);
  assert.equal(state.pointId,'salon-qr','deep link still selects the matching salon');
  assert.equal(state.products.length,1);
  assert.deepEqual(rendered,['products']);
  await vm.runInNewContext('refreshCatalogIfStale()',context);
  assert.equal(calls.length,2,'fresh catalog is reused until marked stale');
  state.view='profile'; // reconnect while checking a staff or customer profile
  vm.runInNewContext('catalogStale=true',context);
  const three=vm.runInNewContext('refreshCatalogIfStale()',context);
  assert.equal(calls.length,4);
  pending.slice(2).find(x=>x.url==='/api/products').resolve({products:[{name:'Новинка'}]});
  pending.slice(2).find(x=>x.url==='/api/points').resolve({points:[{id:'salon-qr',name:'Салон QR'}]});
  await three;
  assert.deepEqual(rendered,['products'],'background catalog completion never replaces the profile');
});
