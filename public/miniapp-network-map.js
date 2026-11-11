/* Dedicated staff map tab in the universal Telegram Mini App.
 * Reuses the SAME read-only status/candidate map as the admin and manager site.
 * Does not change CRM or store a second lead database. */
(function () {
  'use strict';
  var root = document.getElementById('mapPage');
  if (!root) return;
  var identity = window.HvostMiniAppIdentity;
  var serial = 0;
  var role = '';
  var token = '';
  var widget = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function status() {
    return identity && typeof identity.getStatus === 'function' ? identity.getStatus() : null;
  }
  function staffRole(preferred) {
    var s = status();
    if (!s || !s.verified || !Array.isArray(s.accounts)) return '';
    var roles = s.accounts.map(function (account) { return account.role; })
      .filter(function (accountRole) {
        return accountRole === 'manager' || accountRole === 'admin';
      });
    if (!roles.length) return '';
    if (preferred && roles.includes(preferred)) return preferred;
    if (s.preferredRole && roles.includes(s.preferredRole)) return s.preferredRole;
    // Least-privileged default when the phone has both roles.
    return roles.includes('manager') ? 'manager' : 'admin';
  }
  function available() {
    return !!staffRole();
  }
  function close() {
    serial++;
    if (widget && typeof widget.destroy === 'function') {
      widget.destroy(); // cancel pending geocoding and destroy the Yandex canvas
    }
    widget = null;
    role = '';
    token = '';
    root.replaceChildren();
  }
  function loading(message) {
    root.innerHTML = '<div class="hmm-mini-map-head"><h1>🗺️ Карта партнёров</h1>' +
      '<p>Действующие минимаркеты и найденные салоны по Красноярску</p></div>' +
      '<p class="hm-map-muted" role="status">' + esc(message) + '</p>';
  }
  function failure(message) {
    root.innerHTML = '<div class="hmm-mini-map-head"><h1>🗺️ Карта партнёров</h1></div>' +
      '<p class="hm-map-muted" role="alert">' + esc(message) + '</p>' +
      '<button type="button" class="hm-map-reload" data-mini-map-retry>↻ Повторить</button>';
  }
  async function open(preferred) {
    close();
    role = staffRole(preferred);
    if (!role || !identity || typeof identity.session !== 'function') {
      failure('Подтвердите телефон Telegram и откройте кабинет менеджера или администратора.');
      return;
    }
    var requestedRole = role;
    var request = serial;
    loading('Проверяем доступ к карте…');
    try {
      var session = await identity.session(requestedRole);
      if (request !== serial || staffRole(requestedRole) !== requestedRole ||
          !session || session.role !== requestedRole || !session.token) return;
      token = session.token;
      var key = window.TAIGA_CONFIG && window.TAIGA_CONFIG.YANDEX_MAPS_API_KEY;
      if (!key) {
        failure('Не загрузилась конфигурация Яндекс Карт. Обновите мини-приложение.');
        return;
      }
      if (!window.HvostPartnerNetworkMap) {
        failure('Модуль карты не загрузился. Попробуйте закрыть и открыть мини-приложение.');
        return;
      }
      root.innerHTML = '<div class="hmm-mini-map-head">' +
        '<h1>🗺️ Карта партнёров</h1>' +
        '<p>🟢 Минимаркеты · 🔵 Прозвон · 🔴 Отказы · 🟣 Найденные салоны</p>' +
        '<p class="hmm-mini-map-note">Фиолетовые точки — кандидаты из 114 карточек, ' +
        'они ещё не добавлены в CRM.</p></div>' +
        '<div class="hmm-mini-map-mount" data-mini-map-mount></div>';
      widget = window.HvostPartnerNetworkMap.mount(
        root.querySelector('[data-mini-map-mount]'), {
          token: function () {
            return request === serial && staffRole(requestedRole) === requestedRole ? token : '';
          },
          maxInitialGeocode: 35,
          onOpenLead: function (leadId) {
            if (request === serial && typeof window.HvostMiniAppOpenLeadFromMap === 'function' &&
                staffRole(requestedRole) === requestedRole) {
              window.HvostMiniAppOpenLeadFromMap(leadId, requestedRole);
            }
          }
        });
      if (!widget) failure('Не удалось открыть карту. Нажмите «Повторить».');
    } catch (error) {
      if (request === serial) failure(error.message || 'Не удалось проверить кабинет.');
    }
  }
  root.addEventListener('click', function (event) {
    if (event.target.closest('[data-mini-map-retry]')) open(role || staffRole());
  });
  window.HvostMiniAppNetworkMap = {
    available: available, open: open, close: close,
    refresh: function () { return open(role || staffRole()); }
  };
})();
