'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'miniapp.html'), 'utf8');
const customerSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'miniapp-customer.js'), 'utf8');

function customerHarness() {
  let status = {
    loaded: true, verified: false, contactVerified: false,
    phoneMasked: '', accounts: [], ambiguousRoles: [], error: '', busy: false,
  };
  const requests = [], navigations = [], identityListeners = [];
  const fields = { customerPhoneEntry: { value: '' } };
  const root = {
    innerHTML: '', events: {},
    classList: { contains() { return false; } },
    addEventListener(type, fn) { this.events[type] = fn; },
  };
  const document = {
    getElementById(id) { return id === 'profilePage' ? root : fields[id] || null; },
  };
  const identity = {
    getStatus() { return status; },
    onChange(fn) { identityListeners.push(fn); },
    async verifyPhone(value) {
      requests.push(value);
      status = {
        ...status, verified: true, contactVerified: true,
        phoneMasked: '+7 (***) ***-**-06',
        accounts: [{ role: 'admin', name: 'Администратор' }],
      };
      identityListeners.forEach(fn => fn(status));
      return status;
    },
  };
  const window = {
    HvostMiniAppIdentity: identity,
    HvostMiniAppGoShop() { navigations.push('shop'); },
    HvostMiniAppOpenRole(role) { navigations.push(role); },
  };
  const context = vm.createContext({ window, document, console });
  vm.runInContext(customerSource, context, { filename: 'miniapp-customer.js', timeout: 3000 });
  return { root, window, fields, requests, navigations, setStatus(value) { status = value; } };
}

test('opening Mini App starts in customer profile with an entered-phone form', async () => {
  assert.match(html, /async function init\(\)\{\s*\/\/ Keep the profile/);
  assert.match(html, /setView\('profile'\);\s*if\(window\.HvostMiniAppIdentity\)/);
  assert.match(html, /data-view="work"/);
  assert.match(html, /class="tab hide" type="button" data-view="work"/);
  assert.match(html, /if\(view==='work'&&!isPhoneAccessUnlocked\(\)\)view='profile'/);
  assert.match(html, /if\(validPayment\)await checkPaymentReturn\(resultCode\)/, 'payment returns still take priority');
  assert.match(html, /query\.get\('view'\)/);
  assert.doesNotMatch(html, /identityState\.preferredRole/, 'remembered role never skips phone and role picker');
  assert.match(html, /view==='shop'/);
  const h = customerHarness();
  h.window.HvostMiniAppCustomer.render({ first_name: 'Тестовый покупатель' }, true);
  assert.match(h.root.innerHTML, /Ваш ХвостМаркет/);
  assert.match(h.root.innerHTML, /customerPhoneGateForm/);
  assert.match(h.root.innerHTML, /type="tel"/);
  assert.match(h.root.innerHTML, /Введите номер телефона/);
  assert.match(h.root.innerHTML, /Открыть магазин/);
  assert.doesNotMatch(h.root.innerHTML, /data-customer-role="admin"/);
  assert.equal(h.requests.length, 0, 'no phone verification or staff reads without user action');
});

test('only after explicit number submission do matched cabinet buttons appear', async () => {
  const h = customerHarness();
  h.window.HvostMiniAppCustomer.render({ first_name: 'Покупатель' }, true);
  h.fields.customerPhoneEntry.value = '8 (913) 555-44-06';
  h.root.events.submit({
    target: { id: 'customerPhoneGateForm' },
    preventDefault() {},
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(h.requests, ['8 (913) 555-44-06']);
  assert.match(h.root.innerHTML, /Номер проверен/);
  assert.match(h.root.innerHTML, /data-customer-role="admin"/);
  assert.doesNotMatch(h.root.innerHTML, /data-customer-role="founder"/);
  const button = { dataset: { customerAction: 'choose-role', customerRole: 'admin' } };
  h.root.events.click({ target: { closest() { return button; } } });
  assert.deepEqual(h.navigations, ['admin']);
});

test('customer can shop before verification without opening protected staff cabinets', async () => {
  const h = customerHarness();
  h.window.HvostMiniAppCustomer.render(null, true);
  const shop = { dataset: { customerAction: 'open-shop' } };
  h.root.events.click({ target: { closest() { return shop; } } });
  assert.deepEqual(h.navigations, ['shop']);
  const malicious = { dataset: { customerAction: 'choose-role', customerRole: 'admin' } };
  h.root.events.click({ target: { closest() { return malicious; } } });
  assert.deepEqual(h.navigations, ['shop'], 'unverified user cannot open admin via forged DOM action');
});


test('verified active groomer-owner sees a single salon role in customer profile', () => {
  const h=customerHarness();
  h.setStatus({
    loaded:true,verified:true,combinedSalon:true,contactVerified:true,
    accounts:[{role:'partner',name:'Грумер'},{role:'owner',name:'Владелец салона'},
      {role:'admin',name:'Администратор'}],
    ambiguousRoles:[],phoneMasked:'+7 (***) ***-**-06',error:'',
  });
  h.window.HvostMiniAppCustomer.render({first_name:'Юлия'},true);
  assert.match(h.root.innerHTML,/data-customer-role="salon"/);
  assert.match(h.root.innerHTML,/Мой салон и продажи/);
  assert.match(h.root.innerHTML,/data-customer-role="admin"/);
  assert.doesNotMatch(h.root.innerHTML,/data-customer-role="partner"/);
  assert.doesNotMatch(h.root.innerHTML,/data-customer-role="owner"/);
  const button={dataset:{customerAction:'choose-role',customerRole:'salon'}};
  h.root.events.click({target:{closest(){return button;}}});
  assert.deepEqual(h.navigations,['salon']);
});

test('different salon owner and groomer records are never merged only by phone', () => {
  const h=customerHarness();
  h.setStatus({
    loaded:true,verified:true,combinedSalon:false,contactVerified:true,
    accounts:[{role:'partner',name:'Грумер'},{role:'owner',name:'Владелец салона'}],
    ambiguousRoles:[],phoneMasked:'+7 (***) ***-**-06',error:'',
  });
  h.window.HvostMiniAppCustomer.render({first_name:'Юлия'},true);
  assert.doesNotMatch(h.root.innerHTML,/data-customer-role="salon"/);
  assert.match(h.root.innerHTML,/data-customer-role="partner"/);
  assert.match(h.root.innerHTML,/data-customer-role="owner"/);
  const spoof={dataset:{customerAction:'choose-role',customerRole:'salon'}};
  h.root.events.click({target:{closest(){return spoof;}}});
  assert.deepEqual(h.navigations,[],'a forged salon button cannot open an unlinked account');
});

test('verified user sees all and only their registered capabilities plus universal store', () => {
  const h = customerHarness();
  h.setStatus({
    loaded: true, verified: true, contactVerified: true, combinedSalon: false,
    accounts: [{ role: 'customer', name: 'Покупатель' }, { role: 'manager', name: 'Менеджер' }],
    ambiguousRoles: [], phoneMasked: '+7 (***) ***-**-06', error: '',
  });
  h.window.HvostMiniAppCustomer.render({ id: 77, first_name: 'Тест' }, true);
  assert.match(h.root.innerHTML, /Ваши кабинеты/);
  assert.match(h.root.innerHTML, /data-customer-role="customer"/);
  assert.match(h.root.innerHTML, /data-customer-role="manager"/);
  assert.match(h.root.innerHTML, /Открыть магазин/);
  assert.doesNotMatch(h.root.innerHTML, /data-customer-role="admin"/);
  assert.doesNotMatch(h.root.innerHTML, /Подключаем ваш кабинет/);
  const chooseManager = { dataset: { customerAction: 'choose-role', customerRole: 'manager' } };
  h.root.events.click({ target: { closest() { return chooseManager; } } });
  assert.deepEqual(h.navigations, ['manager']);
});

test('verified user without registrations still sees public store but no private roles', () => {
  const h = customerHarness();
  h.setStatus({
    loaded: true, verified: true, contactVerified: true, combinedSalon: false,
    accounts: [], ambiguousRoles: [], phoneMasked: '+7 (***) ***-**-06', error: '',
  });
  h.window.HvostMiniAppCustomer.render({ first_name: 'Гость' }, true);
  assert.match(h.root.innerHTML, /нет зарегистрированных кабинетов/);
  assert.match(h.root.innerHTML, /Открыть магазин/);
  assert.doesNotMatch(h.root.innerHTML, /data-customer-role=/);
});

test('even for registered customers the universal landing waits for explicit role selection', () => {
  const h = customerHarness();
  h.setStatus({
    loaded: true, verified: true, contactVerified: true, combinedSalon: false,
    accounts: [{ role: 'customer', name: 'Покупатель' }],
    ambiguousRoles: [], phoneMasked: '+7 (***) ***-**-06', error: '',
  });
  h.window.HvostMiniAppCustomer.render({ first_name: 'Покупатель' }, true);
  assert.match(h.root.innerHTML, /Ваш ХвостМаркет/);
  assert.match(h.root.innerHTML, /data-customer-role="customer"/);
  assert.doesNotMatch(h.root.innerHTML, /Мои покупки<\/h3>/);
});
