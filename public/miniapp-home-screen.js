// One home-screen icon for the real Telegram Main Mini App, not a chat shortcut.
// Native Telegram 8.0+ installation must be initiated by a user tap. When
// Telegram cannot report its home-screen status, keep a useful manual path.
(function () {
  'use strict';

  var telegram = window.Telegram && window.Telegram.WebApp;
  var nativeSupported = !!(telegram &&
    typeof telegram.addToHomeScreen === 'function' &&
    typeof telegram.checkHomeScreenStatus === 'function');
  if (nativeSupported && typeof telegram.isVersionAtLeast === 'function') {
    try { nativeSupported = !!telegram.isVersionAtLeast('8.0'); }
    catch (_) { nativeSupported = false; }
  }

  var status = nativeSupported ? 'checking' : 'unsupported';
  var checking = false;
  var feedback = '';
  var STATUSES = { checking: 1, unsupported: 1, unknown: 1, missed: 1, added: 1 };

  function esc(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function isIos() {
    return !!(telegram && telegram.platform === 'ios');
  }
  function buttonLabel() {
    if (status === 'added') return '♻️ Обновить иконку ХвостМаркета';
    if (!nativeSupported || status === 'unsupported') return '📲 Как сделать иконку ХвостМаркета';
    return '📲 Сделать иконку ХвостМаркета';
  }
  function visibleFeedback() {
    if (feedback) return feedback;
    return status === 'added'
      ? 'Telegram сообщает, что иконка уже есть. Если она открывает чат бота, её нужно заменить.'
      : '';
  }
  function manualInstructions() {
    var first = status === 'added'
      ? 'Telegram считает, что ярлык уже создан. Если он открывает переписку с ботом, удалите старый значок с экрана телефона.\n'
      : 'Если старая иконка открывает чат бота, сначала удалите этот значок.\n';
    return first +
      '1. Откройте @HvostMarketRusBot и нажмите «Open App».\n' +
      '2. В открытом мини-приложении откройте меню ⋯ → «Добавить на экран Домой».\n' +
      '3. На iPhone, если откроется Safari, нажмите «Поделиться» → «На экран Домой» → «Добавить».\n' +
      'Если пункта добавления нет, обновите Telegram. Не создавайте ярлык из профиля или чата бота.';
  }
  function afterNativeRequest() {
    if (isIos()) {
      return 'Telegram открыл создание ярлыка. На iPhone может появиться Safari: нажмите «Поделиться» → «На экран Домой» → «Добавить». ' +
        'Если новая иконка открывает чат, удалите старый значок и создайте иконку заново из Mini App.';
    }
    return 'Подтвердите добавление в Telegram. Если значок не появился, откройте меню ⋯ мини-приложения → «Добавить на экран Домой». ' +
      'Старый ярлык чата бота при необходимости удалите.';
  }

  // The button is available while Telegram is checking, including when iOS
  // never calls checkHomeScreenStatus back. This was previously a dead end.
  function cardMarkup() {
    var notice = visibleFeedback();
    return '<div class="hm-home-card" data-hm-home-card>' +
      '<div class="hm-home-card-head">' +
        '<img src="/images/hvostmarket-mark-v4-transparent.webp" alt="" ' +
          'class="hm-home-icon" width="52" height="52" loading="lazy">' +
        '<div><strong>Иконка ХвостМаркета на телефоне 🐾</strong>' +
          '<p>Один ярлык открывает само мини-приложение: магазин и доступные кабинеты.</p></div>' +
      '</div>' +
      '<button type="button" class="hm-home-install" data-hm-home-add>' +
        esc(buttonLabel()) + '</button>' +
      '<p class="hm-home-feedback" data-hm-home-feedback role="status" aria-live="polite"' +
        (notice ? '' : ' hidden') + '>' + esc(notice) + '</p>' +
    '</div>';
  }
  function actionMarkup() {
    var notice = visibleFeedback();
    return '<div class="hm-home-action" data-hm-home-card>' +
      '<button type="button" class="work-secondary" data-hm-home-add>' +
        esc(buttonLabel()) + '</button>' +
      '<p class="hm-home-feedback" data-hm-home-feedback role="status" aria-live="polite"' +
        (notice ? '' : ' hidden') + '>' + esc(notice) + '</p>' +
    '</div>';
  }
  function updateControls() {
    if (typeof document.querySelectorAll !== 'function') return;
    // Keep the manual-instructions fallback visible even if Telegram does not
    // implement its native home-screen API or fails to answer the status check.
    document.querySelectorAll('[data-hm-home-card]').forEach(function (node) {
      node.hidden = false;
    });
    document.querySelectorAll('[data-hm-home-add]').forEach(function (node) {
      node.disabled = false;
      node.textContent = buttonLabel();
    });
    var notice = visibleFeedback();
    document.querySelectorAll('[data-hm-home-feedback]').forEach(function (node) {
      node.textContent = notice;
      node.hidden = !notice;
    });
  }
  function setStatus(value) {
    if (!Object.prototype.hasOwnProperty.call(STATUSES, value)) return;
    status = value;
    if (value === 'added') {
      feedback = 'Иконка мини-приложения добавлена. Если старый значок всё ещё открывает бот, удалите его и используйте новый.';
    }
    updateControls();
  }
  function checkStatus() {
    if (!nativeSupported || checking) return;
    checking = true;
    try {
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
    // For Telegram installations with an existing shortcut and clients
    // without native support, explain the correct Main Mini App flow.
    if (!nativeSupported || status === 'unsupported' || status === 'added') {
      feedback = manualInstructions();
      updateControls();
      return false;
    }
    try {
      // Must stay directly inside the user's tap; no awaits or timers here.
      telegram.addToHomeScreen();
      feedback = afterNativeRequest();
      updateControls();
      return true;
    } catch (_) {
      feedback = 'Не удалось открыть создание ярлыка.\n' + manualInstructions();
      updateControls();
      return false;
    }
  }

  if (nativeSupported) {
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
        feedback = 'Telegram не подтвердил создание иконки.\n' + manualInstructions();
        updateControls();
      });
      telegram.onEvent('activated', checkStatus);
    }
    checkStatus(); // A best-effort check, never a gate for showing the button.
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
  // Static shop card and dynamically rendered customer, combined-salon and
  // staff dashboard buttons all use the same install flow.
  window.HvostMiniAppHomeScreen = {
    cardMarkup: cardMarkup,
    actionMarkup: actionMarkup,
    checkStatus: checkStatus,
    requestInstall: requestInstall,
    getStatus: function () { return status; },
  };

  // Run even when checkHomeScreenStatus never reports its result.
  updateControls();
})();
