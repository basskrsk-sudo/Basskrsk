'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProfile, isLoginAvailable, logProfileCorrection,
  ProfileCorrectionError,
} = require('./profile-corrections');

const original = Object.freeze({
  id: 7,
  full_name: 'Анна Петрова',
  phone: '+7 (999) 123-45-67',
  login: 'anna',
  legal_form: 'npd',
  inn: '123456789012',
  bank_details: 'р/с тестовый-старый',
  point_id: 'salon-a',
  groomer_partner_id: null,
});

test('fixes name, login and payment details without losing omitted data', () => {
  const result = normalizeProfile(original, {
    full_name: 'Анна Иванова',
    login: 'anna_new',
    bank_details: 'р/с тестовый-новый',
  });
  assert.equal(result.values.full_name, 'Анна Иванова');
  assert.equal(result.values.phone, original.phone);
  assert.equal(result.values.login, 'anna_new');
  assert.equal(result.values.bank_details, 'р/с тестовый-новый');
  assert.equal(result.phoneChanged, false);
});

test('Russian phone formatting does not disconnect telegram, but a new number does', () => {
  assert.equal(normalizeProfile(original, { phone: '89991234567' }).phoneChanged, false);
  assert.equal(normalizeProfile(original, { phone: '9991234567' }).phoneChanged, false);
  assert.equal(normalizeProfile(original, { phone: '+7 999 123-00-00' }).phoneChanged, true);
});

test('rejects bad INN, phone, login, legal form and long bank details', () => {
  for (const patch of [
    { inn: '1234' }, { phone: '1' }, { login: 'a b' },
    { legal_form: 'unknown' }, { bank_details: 'x'.repeat(2001) },
  ]) {
    assert.throws(() => normalizeProfile(original, patch), ProfileCorrectionError);
  }
});

test('login uniqueness checks only the intended table and skips the current account', () => {
  const calls = [];
  const db = { prepare(sql) {
    calls.push(sql);
    return { get(login,id) {
      assert.equal(login,'anna');
      assert.equal(id,7);
      return undefined;
    }};
  }};
  assert.equal(isLoginAvailable(db, 'partners', 'anna', 7), true);
  assert.equal(isLoginAvailable(db, 'salon_owners', 'anna', 7), true);
  assert.equal(calls.length, 2);
  assert.throws(() => isLoginAvailable(db, 'admins', 'anna', 7));
});

test('audit records changed fields but never exposes bank details', () => {
  let recorded = null;
  const db = { prepare() { return { run(...args) { recorded = args; } }; } };
  const updated = {
    ...original, full_name:'Анна Иванова', phone:'89991230000',
    bank_details:'секретный-счёт', point_id:'salon-b',
  };
  const names = logProfileCorrection(db,{id:1,login:'superadmin'},'partner',original,updated);
  assert.deepEqual(names.sort(),['bank_details','full_name','phone','point_id']);
  assert.equal(recorded[0],1);
  assert.equal(recorded[1],'superadmin');
  assert.equal(recorded[2],'partner');
  assert.equal(recorded[3],7);
  const history = recorded[5];
  assert.equal(history.includes('секретный-счёт'),false);
  assert.equal(history.includes('тестовый-старый'),false);
  assert.equal(JSON.parse(history).point_id.new,'salon-b');
});

test('no-op edit does not create an audit entry', () => {
  let writes = 0;
  const db = { prepare() { return { run() { writes++; } }; } };
  assert.deepEqual(logProfileCorrection(db,{id:1,login:'admin'},'owner',original,original),[]);
  assert.equal(writes,0);
});
