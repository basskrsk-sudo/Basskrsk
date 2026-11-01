'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Dependency-free UI regression tests. No Telegram account, DB or external
// payments are needed: every API response is explicitly mocked per scenario.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'miniapp-work.js'), 'utf8');

function createHarness(fixtures = {}, initialStorage = {}) {
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
  const window = { location: { assign(url) { navigation.push(url); } } };
  const context = vm.createContext({ document, window, localStorage, sessionStorage, fetch });
  vm.runInContext(source, context, { filename: 'miniapp-work.js', timeout: 3000 });
  return {
    root, elements, events, values, calls, navigation, window,
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

test('role picker lists all four employees; public Telegram profile cannot open cabinets', async () => {
  const h = createHarness();
  h.window.HvostMiniAppWork.render();
  assert.deepEqual(Array.from(h.window.HvostMiniAppWork.roles), ['partner', 'manager', 'owner', 'admin']);
  ['Грумер', 'Менеджер', 'Владелец салона', 'Администратор'].forEach(
    (role) => assert.ok(h.root.innerHTML.includes(role))
  );
  await h.window.HvostMiniAppWork.chooseRole('admin');
  assert.match(h.root.innerHTML, /workLoginForm/);
  assert.equal(h.calls.length, 0, 'no private network request before work login');
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
  h.elements.workLogin.value = 'groomer-login';
  h.elements.workPassword.value = 'secure-password';
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
  h.elements.workRestockItem.value = '42';
  h.elements.workRestockQty.value = '7';
  h.submit('workRestockForm');
  await flush();
  const sent = h.calls.find((c) => c.url === '/api/partners/me/restock-signal');
  assert.ok(sent);
  assert.equal(sent.opts.headers.Authorization, 'Bearer existing-partner-token');
  assert.deepEqual(JSON.parse(sent.opts.body), { items: [{ variant_id: 42, qty: 7 }] });
  assert.match(h.elements.workRestockMessage.innerHTML, /202/);
});

test('manager sees only manager-scoped points and 30-day orders', async () => {
  const h = createHarness({
    '/api/managers/me': { manager: { id: 5, full_name: 'Менеджер', active: 1, points: [{
      point_id: 3, point_name: 'БаркЛай', live_revenue: 2100,
    }], commission_unpaid: 142, launch_bonus_unpaid: 500 } },
    '/api/managers/me/orders?days=30&limit=200': { orders: [{
      status: 'paid', total: 500, point_name: 'БаркЛай', created_at: '2026-10-29 09:00:00',
    }] },
    '/api/managers/me/stock': { points: [{ point_id: 3, point_name: 'БаркЛай', items: [] }] },
  }, { taiga_manager_token: 'manager-token' });
  await h.window.HvostMiniAppWork.chooseRole('manager');
  assert.match(h.root.innerHTML, /БаркЛай/);
  assert.match(h.root.innerHTML, /142 ₽/);
  assert.equal(h.calls.some((c) => c.url === '/api/orders'), false);
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

test('invalid or inactive account does not reveal a dashboard', async () => {
  const h = createHarness({
    '/api/partners/me': { partner: { id: 9, full_name: 'Отключённый грумер', active: 0 } },
  }, { taiga_partner_token: 'deactivated' });
  await h.window.HvostMiniAppWork.chooseRole('partner');
  assert.match(h.root.innerHTML, /workLoginForm/);
  assert.equal(h.values.taiga_partner_token, undefined);
});
