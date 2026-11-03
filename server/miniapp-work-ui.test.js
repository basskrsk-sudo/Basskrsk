'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Dependency-free UI regression tests. No Telegram account, DB or external
// payments are needed: every API response is explicitly mocked per scenario.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'miniapp-work.js'), 'utf8');

function createHarness(fixtures = {}, initialStorage = {}, phoneIdentity = null, extras = {}) {
  const values = { ...initialStorage };
  const elements = {};
  const events = {};
  const calls = [];
  const navigation = [];
  const root = {
    innerHTML: '',
    addEventListener(name, handler) { events[name] = handler; },
  };
  const document = {
    getElementById(id) {
      if (id === 'workPage') return root;
      if (!elements[id]) elements[id] = {
        id, value: '', innerHTML: '', textContent: '', disabled: false,
      };
      return elements[id];
    },
  };
  const localStorage = {
    getItem(key) { return values[key] || null; },
    setItem(key, val) { values[key] = String(val); },
    removeItem(key) { delete values[key]; },
  };
  const sessionStorage = { setItem() {} };
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const item = fixtures[url];
    if (!item) return { ok: false, status: 404, json: async () => ({ error: 'Not mocked: ' + url }) };
    const status = item.status || 200;
    return { ok: status < 400, status, json: async () => item.body || item };
  };
  // Most legacy staff dashboard tests start AFTER successful phone entry.
  // Explicit phoneIdentity fixtures exercise locked and role-filtered states.
  const postCheck = phoneIdentity || {
    getStatus() { return { loaded:true, verified:true, contactVerified:true,
      accounts:['partner','manager','owner','founder','admin'].map(role=>({role})),
      ambiguousRoles:[], phoneMasked:'', error:'', busy:false }; },
    onChange() {},
  };
  const window = { location: { assign(url) { navigation.push(url); } },
    HvostMiniAppIdentity: postCheck, ...extras };
  const context = vm.createContext({ document, window, localStorage, sessionStorage, fetch });
  vm.runInContext(source, context, { filename: 'miniapp-work.js', timeout: 3000 });
  return {
    root, document, elements, events, values, calls, navigation, window,
    submit(id) { events.submit({ target: { id }, preventDefault() {} }); },
    click(action, role) {
      events.click({
        target: {
          closest() { return { dataset: { workAction: action, workRole: role || '' } }; },
        },
      });
    },
  };
}
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('work role picker is locked until phone confirmation, then shows only linked roles', async () => {
  const locked = createHarness({}, {}, {
    getStatus(){return {loaded:true,verified:false,contactVerified:true,accounts:[],ambiguousRoles:[],error:''};},
    onChange(){},
  });
  locked.window.HvostMiniAppWork.render();
  assert.deepEqual(Array.from(locked.window.HvostMiniAppWork.roles), ['salon','partner','manager','owner','founder','admin']);
  assert.match(locked.root.innerHTML, /Сначала подтвердите свой номер/);
  assert.doesNotMatch(locked.root.innerHTML, /class="work-role"/);
  await locked.window.HvostMiniAppWork.chooseRole('admin');
  assert.doesNotMatch(locked.root.innerHTML, /workLoginForm/);
  assert.equal(locked.calls.length, 0);

  const verified = createHarness({}, {}, {
    getStatus(){return {loaded:true,verified:true,contactVerified:true,phoneMasked:'+7 (***) ***-**-06',
      accounts:[{role:'customer',name:'Покупатель'},{role:'admin',name:'Администратор'}],ambiguousRoles:[],error:''};},
    onChange(){},
    async session(){ return {}; },
  });
  verified.window.HvostMiniAppWork.render();
  assert.match(verified.root.innerHTML, /data-work-role="admin"/);
  for (const role of ['partner','manager','owner','founder']) {
    assert.doesNotMatch(verified.root.innerHTML, new RegExp('data-work-role="'+role+'"'));
  }
  await verified.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(verified.root.innerHTML, /workLoginForm/);
  assert.equal(verified.calls.length,0);
});

test('groomer signs in through existing auth and only reads own partner data', async () => {
  const h = createHarness({
    '/api/auth/login': { token: 'partner-token', user: { id: 20, full_name: 'Рабочий грумер', role: 'partner' } },
    '/api/partners/me': { partner: { id: 20, full_name: 'Рабочий грумер', commission_rate: 0.1, active: 1 } },
    '/api/partners/me/orders?days=30': { orders: [{
      product: 'Сердце говяжье', sum: 360, commission: 36, date: '2026-10-20 09:30:00', order_code: 'TG-1',
    }] },
    '/api/partners/me/payouts?limit=10': { unpaid_amount: 72 },
    '/api/partners/me/stock': { stock: [{ variant_id: 10, product_name: 'Сердце говяжье', weight: '50 г', qty: 1 }] },
  });
  await h.window.HvostMiniAppWork.chooseRole('partner');
  h.document.getElementById('workLogin').value = 'groomer-login';
  h.document.getElementById('workPassword').value = 'secure-password';
  h.submit('workLoginForm');
  await flush();
  const loginCall = h.calls.find((c) => c.url === '/api/auth/login');
  assert.equal(JSON.parse(loginCall.opts.body).role, 'partner');
  assert.equal(h.values.taiga_partner_token, 'partner-token');
  assert.match(h.root.innerHTML, /Сердце говяжье/);
  assert.match(h.root.innerHTML, /72 ₽/);
  assert.match(h.root.innerHTML, /Запросить пополнение/);
  assert.ok(h.calls.filter((c) => c.url !== '/api/auth/login').every(
    (c) => c.opts.headers.Authorization === 'Bearer partner-token'
  ));
  assert.equal(h.calls.some((c) => c.url.startsWith('/api/orders?')), false);
});

test('groomer can send precisely one restock item with authorized token', async () => {
  const h = createHarness({
    '/api/partners/me': { partner: { id: 10, full_name: 'Грумер', active: 1 } },
    '/api/partners/me/orders?days=30': { orders: [] },
    '/api/partners/me/payouts?limit=10': { unpaid_amount: 0 },
    '/api/partners/me/stock': { stock: [{ variant_id: 42, product_name: 'Лёгкое', weight: '50 г', qty: 0 }] },
    '/api/partners/me/restock-signal': { ok: true, request_id: 202 },
  }, { taiga_partner_token: 'existing-partner-token' });
  await h.window.HvostMiniAppWork.chooseRole('partner');
  h.document.getElementById('workRestockItem').value = '42';
  h.document.getElementById('workRestockQty').value = '7';
  h.submit('workRestockForm');
  await flush();
  const sent = h.calls.find((c) => c.url === '/api/partners/me/restock-signal');
  assert.ok(sent);
  assert.equal(sent.opts.headers.Authorization, 'Bearer existing-partner-token');
  assert.deepEqual(JSON.parse(sent.opts.body), { items: [{ variant_id: 42, qty: 7 }] });
  assert.match(h.document.getElementById('workRestockMessage').innerHTML, /202/);
});


test('groomer never shows a stale salon label as current and warns for a deleted point', async () => {
 const common={
  '/api/partners/me/orders?days=30':{orders:[]},
  '/api/partners/me/payouts?limit=10':{unpaid_amount:0,payouts:[]},
  '/api/partners/me/stock':{stock:[],point_unavailable:true},
 };
 const archived=createHarness({
   ...common,
   '/api/partners/me':{partner:{id:7,active:1,full_name:'Грумер',
     point_name:'Груминг Пушок',point_unavailable:true,current_point:null}},
 }, {taiga_partner_token:'partner-token'});
 await archived.window.HvostMiniAppWork.chooseRole('partner');
 assert.match(archived.root.innerHTML,/Назначенный салон закрыт или удалён/);
 assert.doesNotMatch(archived.root.innerHTML,/Груминг Пушок/);
 const live=createHarness({
   ...common,
   '/api/partners/me':{partner:{id:8,active:1,full_name:'Грумер',
     point_name:'Старое название',point_unavailable:false,
     current_point:{id:'bark',name:'БаркЛай',addr:'Молокова 40'}}},
 }, {taiga_partner_token:'partner-token'});
 await live.window.HvostMiniAppWork.chooseRole('partner');
 assert.match(live.root.innerHTML,/БаркЛай/);
 assert.doesNotMatch(live.root.innerHTML,/Старое название/);
});

test('manager sees only manager-scoped points and 30-day orders', async () => {
  const h = createHarness({
    '/api/managers/me': { manager: { id: 5, full_name: 'Менеджер', active: 1,
      points: [{ point_id: null, point_name: 'Груминг Пушок', live_revenue: 0 },
        { point_id: 3, point_name: 'Устаревшее название', live_revenue: 2100 }],
      current_points: [{ point_id: 3, point_name: 'БаркЛай', live_revenue: 2100 }],
      commission_unpaid: 142, launch_bonus_unpaid: 500 } },
    '/api/managers/me/orders?days=30&limit=200': { orders: [{
      status: 'paid', total: 500, point_name: 'БаркЛай', created_at: '2026-10-29 09:00:00',
    }] },
    '/api/managers/me/stock': { points: [{ point_id: 3, point_name: 'БаркЛай', items: [] }] },
  }, { taiga_manager_token: 'manager-token' });
  await h.window.HvostMiniAppWork.chooseRole('manager');
  assert.match(h.root.innerHTML, /БаркЛай/);
  assert.doesNotMatch(h.root.innerHTML, /Груминг Пушок|Устаревшее название/);
  assert.match(h.root.innerHTML, /Мои точки/);
  assert.match(h.root.innerHTML, /142 ₽/);
  assert.equal(h.calls.some((c) => c.url === '/api/orders'), false);
});


test('miniapp manager does not show ghost, inactive or duplicate historical rows and has no 14-item cap', async () => {
  const current = Array.from({length:15}, (_,i) => ({
    point_id: 'active-'+i, point_name: 'Точка '+String(i+1).padStart(2,'0'),
    point_addr: 'Красноярск', live_revenue: 0,
  }));
  const h = createHarness({
    '/api/managers/me': { manager: { id: 5, full_name: 'Перепадова Ангелина', active: 1,
      points: [{point_id:null, point_name:'Груминг Пушок'},
        {point_id:'inactive', point_name:'Закрытый салон'},
        {point_id:'active-0', point_name:'Старое название'}],
      current_points:current, commission_unpaid:0, launch_bonus_unpaid:0 }},
    '/api/managers/me/orders?days=30&limit=200':{orders:[]},
    '/api/managers/me/stock':{points:[]},
  }, {taiga_manager_token:'manager-token'});
  await h.window.HvostMiniAppWork.chooseRole('manager');
  assert.doesNotMatch(h.root.innerHTML, /Груминг Пушок|Закрытый салон|Старое название/);
  assert.match(h.root.innerHTML,/Точка 15/,'all 15 live salons should be visible');
  assert.match(h.root.innerHTML,/Мои точки/);
  assert.match(h.root.innerHTML,/15/);
});


test('owner sees only assigned salon and owner earnings', async () => {
  const h = createHarness({
    '/api/owner/me': { owner: { id: 3, full_name: 'Хозяин салона', active: 1 } },
    '/api/owner/dashboard': {
      point: { id: 2, name: 'Zveryuga', addr: 'Мира 10' },
      totals: { revenue: 6000, orders: 15, avg_order: 400, this_month_revenue: 1500, this_month_orders: 4 },
      owner_earnings: { unpaid: 75 },
      groomers: [{ full_name: 'Грумер салона', orders_count: 4, tier_percent: 10, revenue: 1500 }],
      recent_orders: [],
    },
  }, { taiga_owner_token: 'owner-token' });
  await h.window.HvostMiniAppWork.chooseRole('owner');
  assert.match(h.root.innerHTML, /Zveryuga/);
  assert.match(h.root.innerHTML, /75 ₽/);
  assert.match(h.root.innerHTML, /Грумер салона/);
});

test('admin requires valid admin session, never grants it from another role token', async () => {
  const h = createHarness({
    '/api/admin/me': { status: 401, body: { error: 'Wrong role' } },
  }, { taiga_admin_token: 'invalid-or-non-admin-token', taiga_manager_token: 'manager-token' });
  await h.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(h.root.innerHTML, /workLoginForm/);
  assert.equal(h.values.taiga_admin_token, undefined);
  assert.equal(h.calls.some((c) => c.url === '/api/orders?limit=100'), false);
});

test('admin metrics are sourced from live admin endpoints (not demo numbers)', async () => {
  const h = createHarness({
    '/api/admin/me': { admin: { id: 1, full_name: 'Главный администратор', active: 1, role: 'super' } },
    '/api/points': { points: [{ id: 3, name: 'БаркЛай' }] },
    '/api/orders?limit=100': { orders: [
      { status: 'paid', total: 250, pickup_point: 'БаркЛай', created_at: '2026-10-30 12:00:00' },
      { status: 'pending', total: 999, pickup_point: 'БаркЛай', created_at: '2026-10-30 13:00:00' },
    ] },
    '/api/operations-center': { summary: { total: 1 }, issues: [{ title: 'Нужно пополнение', count: 1 }] },
  }, { taiga_admin_token: 'admin-token' });
  await h.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(h.root.innerHTML, /250 ₽/);
  assert.match(h.root.innerHTML, /Нужно пополнение/);
  assert.match(h.root.innerHTML, /среди 100 последних/);
  assert.ok(h.calls.every((c) => c.opts.headers.Authorization === 'Bearer admin-token'));
  h.click('full', 'admin');
  assert.equal(h.navigation[0], '/taiga-admin.html?from=miniapp');
});


test('admin counts only active non-hub minimarkets and subtracts all refunds', async () => {
  const h=createHarness({
    '/api/admin/me': {admin:{id:10,full_name:'Администратор',active:1,role:'admin'}},
    '/api/points': {points:[
      {id:'live',name:'БаркЛай',active:1,is_hub:0},
      {id:'second',name:'Zveryuga',active:1,is_hub:0},
      {id:'hub',name:'Служебная точка',active:1,is_hub:1},
      {id:'disabled',name:'Груминг Пушок',active:0,is_hub:0},
    ]},
    '/api/orders?limit=100': {orders:[
      {status:'paid',total:300,refund_status:'none',point_id:'live'},
      {status:'paid',total:220,refund_status:'refunded',refunded_amount:220,point_id:'live'},
      {status:'paid',total:160,refund_status:'refunded',refunded_amount:100,point_id:'second'},
      {status:'pending',total:800,point_id:'live'},
    ]},
    '/api/operations-center': {summary:{total:0},issues:[]},
  }, {taiga_admin_token:'admin-token'});
  await h.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(h.root.innerHTML, /<small>Активных точек<\/small><strong>2<\/strong>/);
  assert.match(h.root.innerHTML, /<small>Последние покупки<\/small><strong>2<\/strong>/);
  assert.match(h.root.innerHTML, /<small>Выручка последних заказов<\/small><strong>360 ₽<\/strong>/);
  assert.doesNotMatch(h.root.innerHTML, /<strong>1 480 ₽<\/strong>/);
});

test('manager Mini App excludes fully refunded and pending sales from its paid KPIs', async () => {
 const h=createHarness({
   '/api/managers/me':{manager:{id:50,active:1,full_name:'Перепадова Ангелина',
     current_points:[{point_id:'real',point_name:'БаркЛай'}],
     points:[{point_id:null,point_name:'Груминг Пушок'}],
     commission_unpaid:0,launch_bonus_unpaid:0}},
   '/api/managers/me/orders?days=30&limit=200':{orders:[
     {status:'paid',total:300,refund_status:'none'},
     {status:'paid',total:200,refund_status:'refunded',refunded_amount:200},
     {status:'paid',total:160,refund_status:'refunded',refunded_amount:100},
     {status:'pending',total:800},
   ]},
   '/api/managers/me/stock':{points:[]},
 },{taiga_manager_token:'manager-token'});
 await h.window.HvostMiniAppWork.chooseRole('manager');
 assert.match(h.root.innerHTML, /<small>Мои точки<\/small><strong>1<\/strong>/);
 assert.match(h.root.innerHTML, /<small>Продажи за 30 дней<\/small><strong>360 ₽<\/strong>/);
 assert.doesNotMatch(h.root.innerHTML,/Груминг Пушок/);
});

test('invalid or inactive account does not reveal a dashboard', async () => {
  const h = createHarness({
    '/api/partners/me': { partner: { id: 9, full_name: 'Отключённый грумер', active: 0 } },
  }, { taiga_partner_token: 'deactivated' });
  await h.window.HvostMiniAppWork.chooseRole('partner');
  assert.match(h.root.innerHTML, /workLoginForm/);
  assert.equal(h.values.taiga_partner_token, undefined);
});


test('registered groomer with confirmed Telegram phone opens own cabinet without password', async () => {
  const identity = {
    getStatus() { return {
      loaded: true, verified: true, phoneMasked: '+7 (***) ***-**-01',
      accounts: [{ role: 'partner', name: 'Грумер' }],
      ambiguousRoles: [], error: '', busy: false,
    }; },
    onChange() {},
    async session(role) {
      assert.equal(role, 'partner');
      return { role, token: 'telegram-groomer-session' };
    },
  };
  const h = createHarness({
    '/api/partners/me': { partner: { id: 1, full_name: 'Грумер', active: 1 } },
    '/api/partners/me/orders?days=30': { orders: [] },
    '/api/partners/me/payouts?limit=10': { unpaid_amount: 0 },
    '/api/partners/me/stock': { stock: [] },
  }, {}, identity);
  h.window.HvostMiniAppWork.render();
  assert.match(h.root.innerHTML, /Вход через Telegram доступен/);
  await h.window.HvostMiniAppWork.chooseRole('partner');
  assert.equal(h.values.taiga_partner_token, 'telegram-groomer-session');
  assert.match(h.root.innerHTML, /Грумер/);
  assert.ok(h.calls.every(c => c.opts.headers.Authorization === 'Bearer telegram-groomer-session'));
  assert.equal(h.calls.some(c => c.url === '/api/auth/login'), false);
  await h.window.HvostMiniAppWork.chooseRole('manager');
  assert.doesNotMatch(h.root.innerHTML, /workLoginForm/, 'unmatched role never opens from verified phone');
  assert.doesNotMatch(h.root.innerHTML, /data-work-role="manager"/);
});


test('founder enters independent read-only business dashboard, without admin credentials', async () => {
  const mockFounderUI={
    getPeriod:()=> '30d',
    render:data => '<div class="founder-banner">Собственник: '+data.founder.full_name+
      ' · '+data.founder.share_percent+'% · '+data.sales.revenue+' ₽</div>',
  };
  const h=createHarness({
    '/api/business-founder/me':{founder:{id:3,full_name:'Кучкин Николай',active:true,share_percent:20}},
    '/api/business-founder/dashboard?period=30d':{
      founder:{id:3,full_name:'Кучкин Николай',share_percent:20},
      sales:{revenue:900},
    },
  },{hm_business_founder_token:'founder-token'},null,{HvostBusinessFounder:mockFounderUI});
  await h.window.HvostMiniAppWork.chooseRole('founder');
  assert.match(h.root.innerHTML,/Кучкин Николай/);
  assert.match(h.root.innerHTML,/20%/);
  assert.match(h.root.innerHTML,/900 ₽/);
  assert.doesNotMatch(h.root.innerHTML,/Открыть полный кабинет/);
  assert.equal(h.calls.some(c=>c.url.startsWith('/api/orders?')),false);
  assert.ok(h.calls.every(c=>c.opts.headers.Authorization==='Bearer founder-token'));
});

test('only superadmin sees founder setup form, not regular administrator', async () => {
  const fixture={
    '/api/points':{points:[]},
    '/api/orders?limit=100':{orders:[]},
    '/api/operations-center':{summary:{total:0},issues:[]},
    '/api/business-founders':{founders:[{id:1,full_name:'Лакомых Алексей',share_percent:45}]},
  };
  const adminUI={render:data=>'<form id="businessFounderSetupForm">'+
    data.founders.map(f=>f.full_name).join('')+'</form>',populate(){}};
  const superHarness=createHarness({
    ...fixture,'/api/admin/me':{admin:{id:1,role:'super',full_name:'Super',active:1}},
  },{taiga_admin_token:'super'},null,{HvostBusinessFounderAdmin:adminUI});
  await superHarness.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(superHarness.root.innerHTML,/businessFounderSetupForm/);
  assert.equal(superHarness.calls.some(c=>c.url==='/api/business-founders'),true);

  const regularHarness=createHarness({
    ...fixture,'/api/admin/me':{admin:{id:2,role:'admin',full_name:'Regular',active:1}},
  },{taiga_admin_token:'regular'},null,{HvostBusinessFounderAdmin:adminUI});
  await regularHarness.window.HvostMiniAppWork.chooseRole('admin');
  assert.doesNotMatch(regularHarness.root.innerHTML,/businessFounderSetupForm/);
  assert.equal(regularHarness.calls.some(c=>c.url==='/api/business-founders'),false);
});

test('verified founder sees a secure admin setup path without receiving founder rights', async () => {
  const identity = {
    getStatus() { return {
      loaded: true, verified: true, phoneMasked: '+7 (***) ***-**-06',
      accounts: [{ role: 'customer', name: 'Покупатель' },
                 { role: 'admin', name: 'Администратор' }],
      ambiguousRoles: [], error: '', busy: false,
    }; },
    onChange() {},
  };
  const h = createHarness({
    '/api/admin/me': {admin:{id:1,full_name:'Администратор',role:'super',active:1}},
    '/api/points':{points:[]},
    '/api/orders?limit=100':{orders:[]},
    '/api/operations-center':{summary:{total:0},issues:[]},
    '/api/business-founders':{founders:[]},
  }, { taiga_admin_token: 'valid-admin-token' }, identity);
  h.window.HvostMiniAppWork.render();
  assert.match(h.root.innerHTML, /data-work-role="admin"/);
  assert.doesNotMatch(h.root.innerHTML, /data-work-role="founder"/,
    "unconfigured founder must not appear in confirmed users role choices");
  await h.window.HvostMiniAppWork.chooseRole('founder');
  assert.doesNotMatch(h.root.innerHTML, /workLoginForm/);
  assert.doesNotMatch(h.root.innerHTML, /data-work-action="owner-setup"/);
  assert.equal(h.calls.some(x => x.url === '/api/miniapp/session'), false);
  await h.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(h.root.innerHTML, /Администратор/);
  assert.equal(h.values.hm_business_founder_token, undefined);
});

test('without verified contact founder login does not expose the admin setup shortcut', async () => {
  const identity = {
    getStatus() { return {loaded:true,verified:false,accounts:[],ambiguousRoles:[],error:'',busy:false}; },
    onChange() {},
  };
  const h = createHarness({}, {}, identity);
  await h.window.HvostMiniAppWork.chooseRole('founder');
  assert.doesNotMatch(h.root.innerHTML, /data-work-action="owner-setup"/);
  assert.doesNotMatch(h.root.innerHTML, /workLoginForm/);
  assert.match(h.root.innerHTML, /Ввести телефон/);
});


test('active groomer-owner sees ONE salon cabinet, separately calculated payouts and functional restock', async () => {
  const issued=[];
  const verified={
    getStatus(){return {loaded:true,verified:true,combinedSalon:true,contactVerified:true,
      phoneMasked:'+7 (***) ***-**-66',error:'',busy:false,ambiguousRoles:[],
      accounts:[{role:'partner',name:'Грумер-владелец'},{role:'owner',name:'Владелец салона'}]};},
    onChange(){},
    async session(role){
      issued.push(role);
      assert.ok(role==='partner'||role==='owner','no fabricated combined privilege');
      return {role,token:'real-'+role+'-session'};
    },
  };
  const h=createHarness({
    '/api/partners/me':{partner:{id:18,full_name:'Барсукова Юлия',phone:'+7 913 777-88-66',
      point_id:'salon-a',point_name:'Zveryuga',commission_rate:0.2,active:1}},
    '/api/owner/me':{owner:{id:9,full_name:'Барсукова Юлия',phone:'89137778866',
      point_id:'salon-a',groomer_partner_id:18,commission_rate:0.05,active:1}},
    '/api/partners/me/orders?days=30':{orders:[
      {product:'Сердце говяжье',sum:300,commission:60,date:'2026-10-30 13:00:00',order_code:'QR-01'},
    ]},
    '/api/partners/me/payouts?limit=10':{unpaid_amount:80,payouts:[]},
    '/api/partners/me/stock':{stock:[
      {variant_id:54,product_name:'Лёгкое',weight:'50 г',qty:1},
    ]},
    '/api/owner/dashboard':{
      point:{id:'salon-a',name:'Zveryuga',addr:'Тестовая, 10'},
      totals:{this_month_revenue:1000,this_month_orders:4,avg_order:250,revenue:2900,orders:8},
      owner_earnings:{unpaid:50,this_month:50},
      groomers:[{full_name:'Барсукова Юлия',orders_count:1,tier_percent:20,revenue:300}],
      recent_orders:[{total:300,created_at:'2026-10-30 13:00:00'}],
    },
    '/api/partners/me/restock-signal':{ok:true,request_id:302},
  },{},verified);
  await h.window.HvostMiniAppWork.render();
  assert.equal(issued.length,2);
  assert.deepEqual(issued,['partner','owner']);
  assert.equal(h.calls.some(c=>c.url==='/api/miniapp/session'&&c.opts.role==='salon'),false);
  assert.match(h.root.innerHTML,/Мой салон и продажи/);
  assert.match(h.root.innerHTML,/Барсукова Юлия/);
  assert.match(h.root.innerHTML,/Zveryuga/);
  assert.match(h.root.innerHTML,/130\s*₽/,'80 groomer unpaid + 50 owner unpaid');
  assert.match(h.root.innerHTML,/1[\s\u00a0]*000\s*₽/,'salon revenue excludes double-counting personal sales');
  assert.match(h.root.innerHTML,/300\s*₽/,'personal sales are shown as subset');
  assert.match(h.root.innerHTML,/Личные продажи уже входят в выручку салона/);
  assert.match(h.root.innerHTML,/Запросить пополнение/);

  for (const c of h.calls) {
    if(c.url.includes('/api/owner'))assert.equal(c.opts.headers.Authorization,'Bearer real-owner-session');
    if(c.url.includes('/api/partners'))assert.equal(c.opts.headers.Authorization,'Bearer real-partner-session');
  }
  assert.equal(h.values.taiga_owner_token,'real-owner-session');
  assert.equal(h.values.taiga_partner_token,'real-partner-session');

  h.document.getElementById('workRestockItem').value='54';
  h.document.getElementById('workRestockQty').value='5';
  h.submit('workRestockForm');
  await flush();
  const signal=h.calls.find(c=>c.url==='/api/partners/me/restock-signal');
  assert.ok(signal);
  assert.equal(signal.opts.headers.Authorization,'Bearer real-partner-session');
  assert.deepEqual(JSON.parse(signal.opts.body),{items:[{variant_id:54,qty:5}]});

  h.click('full-partner');
  h.click('full-owner');
  assert.deepEqual(h.navigation,[
    '/taiga-groomer.html?from=miniapp',
    '/taiga-owner.html?from=miniapp',
  ]);

  h.click('all');
  assert.match(h.root.innerHTML,/data-work-role="salon"/);
  assert.doesNotMatch(h.root.innerHTML,/data-work-role="partner"/);
  assert.doesNotMatch(h.root.innerHTML,/data-work-role="owner"/);
});

test('combined salon refuses cross-point or explicitly linked-to-other-groomer profiles', async () => {
  const verified={
    getStatus(){return {loaded:true,verified:true,combinedSalon:true,accounts:[
      {role:'partner'},{role:'owner'}],ambiguousRoles:[],phoneMasked:'',error:''};},
    onChange(){},
    async session(role){return {role,token:'session-'+role};},
  };
  const fixture={
    '/api/partners/me':{partner:{id:18,phone:'79135556677',point_id:'point-a',active:1}},
    '/api/owner/me':{owner:{id:19,phone:'79135556677',point_id:'point-b',active:1}},
  };
  const h=createHarness(fixture,{},verified);
  await h.window.HvostMiniAppWork.chooseRole('salon');
  assert.match(h.root.innerHTML,/одному салону/);
  assert.doesNotMatch(h.root.innerHTML,/Всего к выплате/);
  assert.equal(h.calls.some(c=>c.url==='/api/owner/dashboard'),false);
  assert.equal(h.values.taiga_owner_token,undefined);

  fixture['/api/owner/me'].owner.point_id='point-a';
  fixture['/api/owner/me'].owner.groomer_partner_id=100;
  await h.window.HvostMiniAppWork.chooseRole('salon');
  assert.match(h.root.innerHTML,/одному салону/);
  assert.equal(h.calls.some(c=>c.url==='/api/owner/dashboard'),false);
});

test('unlinked groomer and salon owner retain separate working roles', async () => {
  const status={
    loaded:true,verified:true,combinedSalon:false,phoneMasked:'+7 (***) ***-**-66',
    accounts:[{role:'partner'},{role:'owner'}],ambiguousRoles:[],error:'',
  };
  const h=createHarness({}, {},{getStatus(){return status;},onChange(){}});
  h.window.HvostMiniAppWork.render();
  assert.match(h.root.innerHTML,/data-work-role="partner"/);
  assert.match(h.root.innerHTML,/data-work-role="owner"/);
  assert.doesNotMatch(h.root.innerHTML,/data-work-role="salon"/);
  await h.window.HvostMiniAppWork.chooseRole('salon');
  assert.equal(h.calls.length,0);
  assert.equal(h.values.taiga_owner_token,undefined);
});


test('groomer can write assigned manager from miniapp using only their partner token',async()=>{
  const h=createHarness({
    '/api/partners/me':{partner:{id:10,full_name:'Грумер',active:1,point_id:'zveryuga'}},
    '/api/partners/me/orders?days=30':{orders:[]},
    '/api/partners/me/payouts?limit=10':{unpaid_amount:0},
    '/api/partners/me/stock':{stock:[]},
    '/api/miniapp/manager-messages':{
      kind:'sender',manager:{name:'Ангелина Функ'},point:{name:'Zveryuga'},
      thread_id:null,messages:[],
    },
  },{taiga_partner_token:'groomer-session'});
  await h.window.HvostMiniAppWork.chooseRole('partner');
  assert.match(h.root.innerHTML,/Написать менеджеру/);
  h.click('chat');
  await flush();
  assert.match(h.root.innerHTML,/Ангелина Функ/);
  assert.match(h.root.innerHTML,/workChatForm/);
  assert.ok(h.calls.some(c=>c.url==='/api/miniapp/manager-messages'&&
    c.opts.headers.Authorization==='Bearer groomer-session'));
  h.document.getElementById('workChatText').value='Можно пополнить стойку в четверг?';
  h.submit('workChatForm');
  await flush();
  const post=h.calls.find(c=>c.url==='/api/miniapp/manager-messages'&&c.opts.method==='POST');
  assert.ok(post);
  assert.equal(post.opts.headers.Authorization,'Bearer groomer-session');
  assert.deepEqual(JSON.parse(post.opts.body),{text:'Можно пополнить стойку в четверг?'});
  // Mock only the read endpoint: a failed send must remain visible and editable.
  assert.match(h.root.innerHTML,/Сообщение сохранено/);
});

test('owner writes via owner session and combined groomer-owner writes only once via owner role',async()=>{
  const ownerData={
    '/api/owner/me':{owner:{id:20,full_name:'Владелец',point_id:'salon-a',active:1}},
    '/api/owner/dashboard':{
      point:{id:'salon-a',name:'Zveryuga'},totals:{},owner_earnings:{},
      groomers:[],recent_orders:[],
    },
    '/api/miniapp/manager-messages':{
      kind:'sender',manager:{name:'Ангелина Функ'},point:{name:'Zveryuga'},
      thread_id:null,messages:[],
    },
    '/api/partners/me':{partner:{id:18,full_name:'Владелец',phone:'79135550022',
      point_id:'salon-a',active:1}},
    '/api/partners/me/orders?days=30':{orders:[]},
    '/api/partners/me/payouts?limit=10':{unpaid_amount:0},
    '/api/partners/me/stock':{stock:[]},
  };
  const owner=createHarness(ownerData,{taiga_owner_token:'owner-session'});
  await owner.window.HvostMiniAppWork.chooseRole('owner');
  assert.match(owner.root.innerHTML,/Написать менеджеру/);
  owner.click('chat');
  await flush();
  assert.match(owner.root.innerHTML,/Ангелина Функ/);
  assert.equal(owner.calls.at(-1).opts.headers.Authorization,'Bearer owner-session');

  const verified={
    getStatus(){return {loaded:true,verified:true,combinedSalon:true,contactVerified:true,
      accounts:[{role:'partner'},{role:'owner'}],ambiguousRoles:[],error:''};},
    onChange(){},async session(role){return {role,token:'verified-'+role};},
  };
  ownerData['/api/owner/me'].owner.phone='79135550022';
  const combined=createHarness(ownerData,{},verified);
  await combined.window.HvostMiniAppWork.chooseRole('salon');
  assert.match(combined.root.innerHTML,/Написать менеджеру/);
  combined.click('chat');
  await flush();
  const request=combined.calls.find(x=>x.url==='/api/miniapp/manager-messages');
  assert.equal(request.opts.headers.Authorization,'Bearer verified-owner');
  assert.equal(combined.calls.filter(x=>x.url==='/api/miniapp/manager-messages').length,1);
});

test('manager has inbox, can open partner thread and reply, with user text escaped in HTML',async()=>{
  const h=createHarness({
    '/api/managers/me':{manager:{id:1,full_name:'Ангелина Функ',active:1,points:[]}},
    '/api/managers/me/orders?days=30&limit=200':{orders:[]},
    '/api/managers/me/stock':{points:[]},
    '/api/miniapp/manager-messages':{
      kind:'manager',threads:[{id:55,sender_name:'Барсукова Юлия',point_name:'Zveryuga',
        sender_role:'partner',last_text:'Привет, нужна доставка!',unread:1}],
    },
    '/api/miniapp/manager-messages?thread_id=55':{
      kind:'manager_thread',thread_id:55,
      point:{name:'Zveryuga'},sender:{name:'Барсукова Юлия',role:'partner'},
      messages:[{id:1,author_role:'partner',author_name:'Барсукова Юлия',
        text:'<script>alert("bad")</script>',created_at:'2026-11-02 07:00:00'}],
    },
    '/api/miniapp/manager-messages/INVALID':{status:400,error:'invalid'},
  },{taiga_manager_token:'manager-session'});
  await h.window.HvostMiniAppWork.chooseRole('manager');
  assert.match(h.root.innerHTML,/Сообщения от салонов/);
  h.click('chat');
  await flush();
  assert.match(h.root.innerHTML,/Барсукова Юлия/);
  assert.match(h.root.innerHTML,/1 новых/);
  h.events.click({target:{closest(){return {dataset:{
    workAction:'chat-thread',chatThreadId:'55',
  }};}}});
  await flush();
  assert.match(h.root.innerHTML,/workChatForm/);
  assert.match(h.root.innerHTML,/&lt;script&gt;alert/);
  assert.doesNotMatch(h.root.innerHTML,/<script>alert/);
  h.document.getElementById('workChatText').value='Доставим в пятницу.';
  h.submit('workChatForm');
  await flush();
  const sent=h.calls.find(x=>x.url==='/api/miniapp/manager-messages'&&x.opts.method==='POST');
  assert.ok(sent);
  assert.equal(sent.opts.headers.Authorization,'Bearer manager-session');
  assert.deepEqual(JSON.parse(sent.opts.body),{text:'Доставим в пятницу.',thread_id:55});
});

test('founder and admin have no manager messaging action on their dashboards',async()=>{
  const f=createHarness({
    '/api/business-founder/me':{founder:{id:3,full_name:'Кучкин Николай',active:1}},
    '/api/business-founder/dashboard?period=30d':{
      founder:{full_name:'Кучкин Николай'},sales:{revenue:1},
    },
  },{hm_business_founder_token:'founder-token'},null,{
    HvostBusinessFounder:{getPeriod(){return '30d';},render(){return '<p>Показатели</p>';}},
  });
  await f.window.HvostMiniAppWork.chooseRole('founder');
  assert.doesNotMatch(f.root.innerHTML,/data-work-action="chat"/);
  f.events.click({target:{closest(selector){
    return selector==='[data-work-action]'?{dataset:{workAction:'chat'}}:null;
  }}});
  assert.equal(f.calls.some(c=>c.url.includes('manager-messages')),false);
});
