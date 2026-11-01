// ХвостМаркет Mini App: log in to EXISTING accounts using the owner's
// Telegram contact, delivered directly to the existing bot (not user input).
(function(){
  'use strict';

  var telegram = null;
  var identity = {
    loaded: false, verified: false, phoneMasked: '',
    accounts: [], ambiguousRoles: [], combinedSalon: false, error: '',
  };
  var busy = false;
  var listeners = [];
  var stamp = 0;
  // Privacy gate: even a previously linked Telegram number does not reveal
  // account roles until the user enters and verifies that phone this launch.
  var gateUnlocked = false;
  var confirmedPhone = '';
  function normalizeEnteredPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10 && digits[0] === '9') digits = '7' + digits;
    if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
    return /^79\d{9}$/.test(digits) ? digits : '';
  }
  var TOKENS = {
    customer: 'taiga_customer_token',
    partner: 'taiga_partner_token',
    manager: 'taiga_manager_token',
    owner: 'taiga_owner_token',
    founder: 'hm_business_founder_token',
    admin: 'taiga_admin_token',
  };

  function copy() {
    return {
      loaded: identity.loaded,
      verified: identity.verified && gateUnlocked,
      contactVerified: identity.verified,
      unlocked: identity.verified && gateUnlocked,
      phoneMasked: identity.verified && gateUnlocked ? identity.phoneMasked : '',
      accounts: gateUnlocked ? identity.accounts.map(function(x) { return { role: x.role, name: x.name }; }) : [],
      ambiguousRoles: gateUnlocked ? identity.ambiguousRoles.slice() : [],
      combinedSalon: identity.verified && gateUnlocked && !!identity.combinedSalon,
      error: identity.error,
      busy: busy,
    };
  }
  function notify() {
    var snapshot = copy();
    listeners.slice().forEach(function(fn) {
      try { fn(snapshot); } catch (err) { console.warn('Mini App phone UI listener:', err); }
    });
  }
  async function post(path, body) {
    if (!telegram || !telegram.initData) throw new Error('Откройте Mini App через Telegram-бота.');
    var response = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: telegram.initData }, body || {})),
    });
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) throw new Error(data.error || ('Ошибка сервера (' + response.status + ')'));
    return data;
  }
  async function refresh() {
    if (!telegram || !telegram.initData) {
      identity.loaded = true;
      identity.error = 'Откройте через Telegram-бота.';
      notify();
      return copy();
    }
    var data;
    try {
      data = await post('/api/miniapp/accounts');
      identity.loaded = true;
      identity.verified = !!data.verified;
      identity.phoneMasked = data.phone_masked || '';
      identity.accounts = Array.isArray(data.accounts) ? data.accounts.filter(function(a) { return !!TOKENS[a.role]; }) : [];
      identity.ambiguousRoles = Array.isArray(data.ambiguous_roles) ? data.ambiguous_roles : [];
      identity.combinedSalon = !!data.combined_salon;
      identity.error = '';
      if (gateUnlocked && confirmedPhone && identity.verified) {
        // Recheck whenever Telegram comes back into focus; a changed or
        // removed contact must invalidate the UI unlock on this device.
        try {
          var checked = await post('/api/miniapp/verify-phone', { phone: confirmedPhone });
          identity.accounts = Array.isArray(checked.accounts) ? checked.accounts.filter(function(a) { return !!TOKENS[a.role]; }) : [];
          identity.ambiguousRoles = Array.isArray(checked.ambiguous_roles) ? checked.ambiguous_roles : [];
          identity.combinedSalon = !!checked.combined_salon;
          identity.phoneMasked = checked.phone_masked || '';
        } catch (err) {
          gateUnlocked = false;
          confirmedPhone = '';
          identity.combinedSalon = false;
          identity.error = 'Подтверждение номера устарело. Введите номер и проверьте его повторно.';
        }
      } else if (!identity.verified) {
        gateUnlocked = false;
        confirmedPhone = '';
        identity.combinedSalon = false;
      }
    } catch (err) {
      identity.loaded = true;
      gateUnlocked = false;
      confirmedPhone = '';
      identity.error = err.message;
    }
    notify();
    return copy();
  }
  async function waitForConsent() {
    for (var i = 0; i < 16; i++) {
      await new Promise(function(resolve) { setTimeout(resolve, 1200); });
      await refresh();
      if (identity.verified) return copy();
    }
    return copy();
  }
  function requestContact() {
    if (busy) return Promise.resolve(copy());
    if (!telegram || !telegram.initData) {
      identity.error = 'Откройте магазин через кнопку действующего бота в Telegram.';
      notify();
      return Promise.resolve(copy());
    }
    if (typeof telegram.requestContact !== 'function') {
      identity.error = 'В этой версии Telegram подтвердить номер можно в чате бота: отправьте /phone, нажмите кнопку передачи своего контакта и вернитесь в Mini App.';
      notify();
      return Promise.resolve(copy());
    }
    busy = true;
    identity.error = '';
    notify();
    // Telegram displays a native consent dialog; callback only reports whether
    // the user allowed sharing. The phone itself arrives in the bot's updates.
    return new Promise(function(resolve) {
      try {
        telegram.requestContact(function(sent) { resolve(!!sent); });
      } catch (_) { resolve(false); }
    }).then(async function(sent) {
      if (!sent) {
        identity.error = 'Доступ без пароля не подключён. Вы можете войти с логином и паролем.';
        return copy();
      }
      var state = await waitForConsent();
      if (!state.verified) {
        identity.error = 'Telegram принял разрешение, но контакт пока не получен сервером. Вернитесь из чата бота и нажмите «Проверить номер».';
      }
      return copy();
    }).finally(function() {
      busy = false;
      notify();
    });
  }
  async function verifyPhone(value) {
    var phone = normalizeEnteredPhone(value);
    if (!phone) {
      identity.error = 'Введите корректный российский мобильный номер, например +7 913 123-45-67.';
      notify();
      return copy();
    }
    if (!telegram || !telegram.initData) {
      identity.error = 'Для проверки номера откройте приложение из действующего Telegram-бота.';
      notify();
      return copy();
    }
    if (!identity.verified) {
      // Called immediately from the user's submit handler: Telegram owns
      // the native consent dialog and supplies the actual phone to the bot.
      await requestContact();
      if (!identity.verified) return copy();
    }
    busy = true;
    identity.error = '';
    notify();
    try {
      var result = await post('/api/miniapp/verify-phone', { phone: phone });
      gateUnlocked = !!result.verified;
      confirmedPhone = gateUnlocked ? phone : '';
      identity.phoneMasked = result.phone_masked || '';
      identity.accounts = Array.isArray(result.accounts) ? result.accounts.filter(function(a) { return !!TOKENS[a.role]; }) : [];
      identity.ambiguousRoles = Array.isArray(result.ambiguous_roles) ? result.ambiguous_roles : [];
      identity.combinedSalon = !!result.combined_salon;
    } catch (err) {
      gateUnlocked = false;
      confirmedPhone = '';
      identity.error = err.message;
    } finally {
      busy = false;
      notify();
    }
    return copy();
  }
  async function session(role) {
    if (!Object.prototype.hasOwnProperty.call(TOKENS, role)) {
      throw new Error('Неизвестный тип кабинета');
    }
    if (!gateUnlocked || !identity.verified || !identity.accounts.some(function(a) { return a.role === role; })) {
      throw new Error('Кабинет не связан с подтверждённым номером Telegram.');
    }
    var result = await post('/api/miniapp/session', { role: role });
    if (!result.token || result.role !== role) {
      throw new Error('Не удалось открыть кабинет');
    }
    try {
      localStorage.setItem(TOKENS[role], result.token);
      if (role === 'admin') {
        localStorage.setItem('taiga_admin_role', result.account && result.account.adminRole === 'super' ? 'super' : 'admin');
      }
    } catch (_) {}
    return result;
  }
  function onChange(fn) {
    if (typeof fn !== 'function') return function() {};
    listeners.push(fn);
    return function() { listeners = listeners.filter(function(x) { return x !== fn; }); };
  }
  function bindVerifiedTelegramUser(user) {
    // The Telegram ID comes from the SERVER-VERIFIED initData response, not
    // untrusted initDataUnsafe. Avoid reusing sessions from another Telegram
    // account when multiple accounts are switched on one iPhone.
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return;
    try {
      var id = String(user.id);
      var key = 'hm_miniapp_last_telegram_user';
      var last = localStorage.getItem(key);
      if (last && last !== id) {
        gateUnlocked = false;
        confirmedPhone = '';
        identity.combinedSalon = false;
        Object.keys(TOKENS).forEach(function(role) {
          localStorage.removeItem(TOKENS[role]);
        });
        localStorage.removeItem('taiga_admin_role');
      }
      localStorage.setItem(key, id);
    } catch (_) {}
  }
  function init(webApp, serverVerifiedUser) {
    telegram = webApp || null;
    bindVerifiedTelegramUser(serverVerifiedUser);
    if (telegram && typeof telegram.onEvent === 'function') {
      try { telegram.onEvent('activated', function() { refresh(); }); } catch (_) {}
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden) refresh();
      });
    }
    return refresh();
  }
  window.HvostMiniAppIdentity = {
    init: init,
    getStatus: copy,
    refresh: refresh,
    requestContact: requestContact,
    verifyPhone: verifyPhone,
    session: session,
    onChange: onChange,
  };
})();
