// ХвостМаркет Mini App: safe recovery when telegram.org's WebApp SDK script
// is unavailable in an Android/iOS WebView. Only data actually supplied in
// THIS Telegram launch is used. Server verifies Telegram's HMAC signature,
// auth_date and bot token before granting ANY account or staff privileges.
(function () {
  'use strict';

  function officialWebApp() {
    return window.Telegram && window.Telegram.WebApp || null;
  }

  function queryValue(value) {
    if (typeof value !== 'string' || !value) return '';
    // Telegram normally puts tgWebAppData in location.hash. Some clients
    // prefix hash routing with a slash and a question mark.
    var source = value.replace(/^[#?]/, '');
    if (source.indexOf('tgWebAppData=') < 0) return '';
    var queryIndex = source.indexOf('?');
    if (queryIndex !== -1 && !source.startsWith('tgWebAppData=')) {
      source = source.slice(queryIndex + 1);
    }
    try {
      var raw = new URLSearchParams(source).get('tgWebAppData') || '';
      // Client-side checks are only bounds/format checks, NOT authentication.
      // The server remains the sole authority on who is logged in.
      if (raw.length < 20 || raw.length > 8192 ||
          !/(?:^|&)auth_date=/.test(raw) || !/(?:^|&)hash=/.test(raw)) return '';
      return raw;
    } catch (_) {
      return '';
    }
  }

  function launchData() {
    var location = window.location || {};
    var raw = queryValue(location.hash) || queryValue(location.search);
    if (raw) return raw;
    // Telegram can omit launch parameters from the current URL after internal
    // navigation. A Navigation Timing entry for THIS load can still have them.
    try {
      var perf = window.performance;
      if (!perf || typeof perf.getEntriesByType !== 'function') return '';
      var entries = perf.getEntriesByType('navigation') || [];
      if (!entries.length || !entries[0] || !entries[0].name) return '';
      var navigationUrl = new URL(entries[0].name);
      var currentOrigin = String(location.origin || '');
      if (currentOrigin && navigationUrl.origin !== currentOrigin) return '';
      return queryValue(navigationUrl.hash) || queryValue(navigationUrl.search);
    } catch (_) {
      return '';
    }
  }

  function resolve() {
    var sdk = officialWebApp();
    if (sdk && typeof sdk.initData === 'string' && sdk.initData) return sdk;
    var raw = launchData();
    if (!raw) return sdk;
    // Expose only a narrowly scoped bridge. No fake Telegram users, login
    // tokens, or unverified account identifiers are synthesized.
    var fallback = { initData: raw };
    var methods = [
      'ready', 'expand', 'setHeaderColor', 'onEvent', 'offEvent',
      'requestContact', 'close',
    ];
    for (var i = 0; i < methods.length; i++) {
      (function (method) {
        if (sdk && typeof sdk[method] === 'function') {
          fallback[method] = function () {
            return sdk[method].apply(sdk, arguments);
          };
        }
      })(methods[i]);
    }
    // Leave contact-sharing unavailable if the SDK is absent. To enroll,
    // user must share their own contact in the real bot via /phone.
    return fallback;
  }

  function diagnostic() {
    var sdk = officialWebApp();
    var fromSdk = !!(sdk && sdk.initData);
    var fromLaunch = !!launchData();
    return {
      sdkLoaded: !!sdk,
      initDataAvailable: fromSdk || fromLaunch,
      source: fromSdk ? 'sdk' : fromLaunch ? 'launch-parameters' : 'none',
      // No raw initData, auth hash, phone or Telegram user ID in diagnostics.
      code: fromSdk || fromLaunch ? 'TG-OK' : sdk ? 'TG-02' : 'TG-01',
    };
  }

  function unavailableMessage() {
    var state = diagnostic();
    if (state.sdkLoaded) {
      return 'Telegram открыл приложение без данных авторизации (' +
        state.code + '). Закройте окно, вернитесь в бот и нажмите ' +
        '«Открыть ХвостМаркет». Если не помогает, отправьте /app ' +
        'в чат бота и откройте НОВУЮ кнопку. При повторении обновите Telegram.';
    }
    return 'Не удалось загрузить модуль авторизации Telegram (' +
      state.code + '). Закройте приложение и откройте его кнопкой ' +
      '«Открыть ХвостМаркет» в боте. Если проблема повторится, передайте этот код администратору.';
  }

  window.HvostTelegramContext = {
    resolve: resolve,
    diagnostic: diagnostic,
    unavailableMessage: unavailableMessage,
  };
})();
