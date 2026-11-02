// Native Telegram home screen shortcut for every ХвостМаркет Mini App role.
// One shortcut opens the existing shared Mini App; role authorization is
// unchanged and always validated by the server after phone confirmation.
(function () {
  'use strict';
  var telegram = window.Telegram && window.Telegram.WebApp;
  var supported = !!(telegram &&
    typeof telegram.addToHomeScreen === 'function' &&
    typeof telegram.checkHomeScreenStatus === 'function');
  if (supported && typeof telegram.isVersionAtLeast === 'function') {
    try { supported = !!telegram.isVersionAtLeast('8.0'); }
    catch (_) { supported = false; }
  }

  var status = supported ? 'checking' : 'unsupported';
  var feedback = '';
  var checking = false;
  var STATUSES = { unsupported: 1, unknown: 1, missed: 1, added: 1 };

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function showButton() {
    return supported && (status === 'missed' || status === 'unknown');
  }
  function hiddenAttr() {
    return showButton() ? '' : ' hidden';
  }
  function cardMarkup() {
    if (!supported) return '';
    return '<div class="hm-home-card" data-hm-home-card' + hiddenAttr() + '>' +
      '<div class="hm-home-card-head">' +
        '<img src="/images/hvostmarket-mark-v4-transparent.webp" alt="" ' +
          'class="hm-home-icon" width="52" height="52" loading="lazy">' +
        '<div><strong>ХвостМаркет всегда под рукой 🐾</strong>' +
          '<p>Один значок для магазина и всех доступных вам кабинетов.</p></div>' +
      '</div>' +
      '<button type="button" class="hm-home-install" data-hm-home-add>' +
        '📲 Добавить на экран телефона</button>' +
      '<p class="hm-home-feedback" data-hm-home-feedback role="status"' +
        (feedback ? '' : ' hidden') + '>' + esc(feedback) + '</p>' +
    '</div>';
  }
  function actionMarkup() {
    if (!supported) return '';
    return '<div class="hm-home-action" data-hm-home-card' + hiddenAttr() + '>' +
      '<button type="button" class="work-secondary" data-hm-home-add>' +
        '📲 Добавить ХвостМаркет на экран телефона</button>' +
      '<p class="hm-home-feedback" data-hm-home-feedback role="status"' +
        (feedback ? '' : ' hidden') + '>' + esc(feedback) + '</p>' +
    '</div>';
  }
  function updateControls() {
    // Cards rendered after a phone check or a role switch use the same status.
    // Native dialogs may update the status while a dashboard is open.
    if (typeof document.querySelectorAll !== 'function') return;
    var visible = showButton();
    document.querySelectorAll('[data-hm-home-card]').forEach(function (node) {
      node.hidden = !visible;
    });
    document.querySelectorAll('[data-hm-home-add]').forEach(function (node) {
      node.disabled = !visible;
    });
    document.querySelectorAll('[data-hm-home-feedback]').forEach(function (node) {
      node.textContent = feedback;
      node.hidden = !visible || !feedback;
    });
  }
  function setStatus(value) {
    if (!Object.prototype.hasOwnProperty.call(STATUSES, value)) return;
    status = value;
    if (value === 'added') feedback = '';
    if (value === 'unsupported') feedback = '';
    updateControls();
  }
  function checkStatus() {
    if (!supported || checking) return;
    checking = true;
    try {
      // Official Telegram callback: status is one of
      // unsupported/unknown/added/missed. Unknown is NOT "not installed".
      telegram.checkHomeScreenStatus(function (value) {
        checking = false;
        setStatus(value);
      });
    } catch (_) {
      checking = false;
      setStatus('unsupported');
    }
  }
  function requestInstall() {
    if (!showButton()) return false;
    try {
      // Must run synchronously inside the user click gesture: never call on
      // startup, page render, or when switching between staff roles.
      telegram.addToHomeScreen();
      feedback = 'Подтвердите добавление в Telegram или в системном меню телефона. ' +
        'Если значок не появился, проверьте меню ⋯ мини-приложения.';
      updateControls();
      return true;
    } catch (_) {
      feedback = 'Telegram не смог открыть добавление. Обновите приложение ' +
        'или попробуйте пункт «Добавить на экран» в меню ⋯.';
      updateControls();
      return false;
    }
  }

  if (supported) {
    if (typeof telegram.onEvent === 'function') {
      telegram.onEvent('homeScreenChecked', function (event) {
        if (event && event.status) {
          checking = false;
          setStatus(event.status);
        }
      });
      telegram.onEvent('homeScreenAdded', function () {
        setStatus('added');
      });
      telegram.onEvent('homeScreenFailed', function () {
        feedback = 'Добавление не подтвердилось. Вы можете попробовать ещё раз.';
        updateControls();
      });
      telegram.onEvent('activated', checkStatus);
    }
    // A silent check only; never request installation without a real tap.
    checkStatus();
  }

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (event) {
      var target = event.target;
      var button = target && typeof target.closest === 'function' ?
        target.closest('[data-hm-home-add]') : null;
      if (!button) return;
      event.preventDefault();
      requestInstall();
    });
  }
  // Supported by buyer profile, the guest storefront, the verified role
  // picker and the individual/combined staff work dashboards.
  window.HvostMiniAppHomeScreen = {
    cardMarkup: cardMarkup,
    actionMarkup: actionMarkup,
    checkStatus: checkStatus,
    requestInstall: requestInstall,
    getStatus: function () { return status; },
  };
})();
