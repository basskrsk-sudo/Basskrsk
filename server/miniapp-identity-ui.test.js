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
      })};
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

test('Mini App requests native OWN contact and never receives the phone value from JS', async () => {
  const h = setupIdentity();
  await h.identity.init(h.telegram);
  assert.equal(h.identity.getStatus().verified, false);
  const after = await h.identity.requestContact();
  assert.equal(after.contactVerified, true);
  assert.equal(after.verified, false, 'sharing contact alone cannot expose roles');
  await assert.rejects(()=>h.identity.session('partner'), /подтверждённым номером/);
  const wrong = await h.identity.verifyPhone('79130000000');
  assert.equal(wrong.verified, false);
  assert.equal(wrong.accounts.length,0);
  const unlocked = await h.identity.verifyPhone('+7 (913) 123-45-77');
  assert.equal(unlocked.verified, true);
  assert.equal(unlocked.phoneMasked, '+7 (***) ***-**-77');
  const session = await h.identity.session('partner');
  assert.equal(session.token, 'server-signed-partner');
  assert.equal(h.saved.taiga_partner_token, 'server-signed-partner');
  assert.ok(h.sent.every(x => x.body.initData === h.telegram.initData));
  const claims=h.sent.filter(x=>Object.hasOwn(x.body,'phone'));
  assert.ok(claims.every(x=>x.url==='/api/miniapp/verify-phone'), 'typed phone is only a server-check claim');
  assert.ok(h.sent.filter(x=>x.url==='/api/miniapp/session').every(x=>!Object.hasOwn(x.body,'phone')));
  assert.equal(typeof h.events.activated, 'function');
});

test('confirmed Telegram contact still requires typed phone even for a returning user', async () => {
  const h=setupIdentity(true);
  const initial=await h.identity.init(h.telegram);
  assert.equal(initial.contactVerified,true);
  assert.equal(initial.verified,false);
  assert.deepEqual(Array.from(initial.accounts),[]);
  await assert.rejects(()=>h.identity.session('partner'), /подтверждённым номером/);
  const verified=await h.identity.verifyPhone('8(913)123-45-77');
  assert.equal(verified.verified,true);
  assert.deepEqual(Array.from(verified.accounts, a=>a.role),['customer','partner']);
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.match(elements.profilePage.innerHTML, /Ольга/);
  assert.match(elements.profilePage.innerHTML, /Жужа/);
  assert.match(elements.profilePage.innerHTML, /Сердце говяжье/);
  assert.match(elements.profilePage.innerHTML, /Мои косточки/);
  assert.ok(calls.every(x => x.options.headers.Authorization === 'Bearer customer-session'));
});

test('main Mini App loads account identity before both customer and role interfaces', () => {
  const a = html.indexOf('<script src="/miniapp-identity.js"></script>');
  const b = html.indexOf('<script src="/miniapp-work.js"></script>');
  const c = html.indexOf('<script src="/miniapp-customer.js"></script>');
  assert.ok(a > 0 && a < b && b < c);
  assert.match(html, /HvostMiniAppIdentity\.init\(tg\)/);
  assert.match(html, /HvostMiniAppCustomer\.render\(state\.user,state\.verified\)/);
});


test('combined salon indicator becomes visible only after Telegram phone proof and role matching', async () => {
  const h=setupIdentity(true,true,true,true);
  const before=await h.identity.init(h.telegram);
  assert.equal(before.verified,false);
  assert.equal(before.combinedSalon,false,'linked owner status is gated behind typed phone');
  assert.deepEqual(Array.from(before.accounts),[]);
  const status=await h.identity.verifyPhone('+7 913 123-45-77');
  assert.equal(status.verified,true);
  assert.equal(status.combinedSalon,true);
  assert.deepEqual(Array.from(status.accounts,a=>a.role),['customer','partner','owner']);
  await assert.rejects(()=>h.identity.session('salon'),/Неизвестный тип кабинета/,
    'salon is a UI representation, never an independent server-issued role');
  const partner=await h.identity.session('partner');
  const owner=await h.identity.session('owner');
  assert.equal(partner.role,'partner');
  assert.equal(owner.role,'owner');
  const ref=await h.identity.refresh();
  assert.equal(ref.combinedSalon,true);
});
