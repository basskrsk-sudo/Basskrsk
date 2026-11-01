// Customer account within the same Mini App, without a separate database.
// Every private read goes through original /api/customer/me endpoints with a
// role-scoped server-issued session, never with a phone supplied by the client.
(function(){
  'use strict';

  var root = document.getElementById('profilePage');
  var identity = window.HvostMiniAppIdentity;
  if (!root || !identity) return;

  var currentUser = null;
  var isTelegramSigned = false;
  var cached = null;
  var cacheKey = '';
  var pending = false;
  var generation = 0;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rub(value) {
    return Math.round(Number(value) || 0).toLocaleString('ru-RU') + ' ₽';
  }
  function time(value) {
    if (!value) return '';
    var str = String(value);
    var date = new Date(str.replace(' ', 'T') + (/Z|[+]\d\d:\d\d$/.test(str) ? '' : 'Z'));
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
      : str.slice(0, 10);
  }
  function avatar(name) {
    return '<div class="avatar">🐾</div><h2>' + esc(name || 'Покупатель') + '</h2>';
  }
  function action(name, label, secondary) {
    return '<button type="button" class="btn ' + (secondary ? 'btn-light' : 'btn-gold') +
      '" data-customer-action="' + name + '">' + label + '</button>';
  }
  function heading() {
    return '<h1 class="page-title">Мой ХвостМаркет 🐾</h1>';
  }
  function error(text) {
    return '<p class="error" role="alert">' + esc(text) + '</p>';
  }
  function renderIdentityPrompt(status) {
    var userName = currentUser && currentUser.first_name || 'друг';
    var content = '<div class="block profile-hero">' +
      avatar(userName) +
      '<p>' + (isTelegramSigned ? '✅ Ваш Telegram подключён' : 'Войдите через Telegram-бота') +
      '</p></div><div class="block"><h3 style="margin:0 0 7px">🔐 Мой личный кабинет</h3>' +
      '<p class="muted" style="font-size:12px;line-height:1.65">Для просмотра своих покупок и косточек подтвердите номер, который указан при покупках на хвостмаркет.рф. Вводить номер вручную не нужно.</p>';
    if (status.verified) {
      content += '<p class="ok">Номер подтверждён: ' + esc(status.phoneMasked) + '</p>';
      content += '<p class="muted" style="font-size:12px">По этому номеру пока нет зарегистрированного кабинета покупателя. Если номер на сайте другой, обратитесь к администратору.</p>';
      if (status.ambiguousRoles.includes('customer')) {
        content += error('Найдены несколько клиентских записей на один номер. Вход по номеру временно недоступен до объединения записей.');
      }
    } else {
      content += action('share', status.busy ? 'Проверяем номер…' : '📱 Подтвердить номер Telegram') +
        '<div style="height:9px"></div>' + action('check', '↻ Проверить номер', true);
      if (status.error) content += error(status.error);
      content += '<p class="hint">Если Telegram не поддерживает запрос, отправьте действующему боту команду /phone и разрешите передать свой контакт.</p>';
    }
    content += '</div>';
    return content;
  }
  function secureFetch(path, token) {
    return fetch(path, {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token },
    }).then(async function(response) {
      var result = await response.json().catch(function() { return {}; });
      if (!response.ok) throw new Error(result.error || 'Не удалось получить данные');
      return result;
    });
  }
  function renderOrders(orders) {
    if (!orders.length) return '<p class="muted" style="font-size:12px">Заказов пока нет. Первая покупка уже ждёт вас!</p>';
    return orders.slice(0, 8).map(function(o) {
      var items = (o.items || []).map(function(item) {
        return item.name + (item.weight ? ' · ' + item.weight : '');
      }).filter(Boolean);
      var title = items.length ? items.slice(0, 2).join(', ') : 'Заказ';
      return '<div class="cart-line"><div class="cart-icon">🦴</div><div class="cart-info">' +
        '<div class="cart-name">' + esc(title) + '</div>' +
        '<div class="cart-weight">' + esc(time(o.created_at) +
          ' · ' + (o.status === 'paid' ? 'Оплачен' : o.status === 'pending' ? 'Ожидает оплату' : 'Статус: ' + (o.status || '—'))) + '</div>' +
        '</div><strong style="white-space:nowrap">' + rub(o.total) + '</strong></div>';
    }).join('');
  }
  function renderProfileCard(data) {
    var customer = data.profile && data.profile.customer || {};
    var orders = data.orders && data.orders.orders || [];
    var bones = data.bones || {};
    var name = [customer.name, customer.lname].filter(Boolean).join(' ') ||
      (currentUser && currentUser.first_name) || 'Покупатель';
    var html = heading() +
      '<div class="block profile-hero">' + avatar(name) +
      '<p>✅ Телефон подтверждён: ' + esc(identity.getStatus().phoneMasked) + '</p>' +
      (customer.pet_name ? '<p style="margin-top:10px">🐶 ' + esc(customer.pet_name) + '</p>' : '') +
      '</div><div class="work-stats">' +
        '<div class="work-stat"><small>Мои косточки</small><strong>' + esc(Number(bones.balance != null ? bones.balance : customer.bones_balance || 0).toLocaleString('ru-RU')) + '</strong><span>Баланс программы лояльности</span></div>' +
        '<div class="work-stat"><small>Покупок всего</small><strong>' + esc(Number(customer.orders_count || 0).toLocaleString('ru-RU')) + '</strong><span>Сумма покупок: ' + rub(customer.total_spent) + '</span></div>' +
      '</div><div class="block"><h3 style="margin:0 0 10px">🛍 Мои покупки</h3>' +
      (data.orders ? renderOrders(orders) : '<p class="muted">История покупок временно недоступна</p>') +
      '</div><div class="block"><h3 style="margin:0 0 10px">🦴 История косточек</h3>' +
      (data.bones ? (bones.transactions || []).slice(0, 5).map(function(t) {
        return '<div class="work-row"><div><b>' + esc(t.description || 'Операция') +
          '</b><small>' + esc(time(t.created_at)) + '</small></div><strong>' +
          esc(Number(t.amount) > 0 ? '+' + t.amount : String(t.amount)) + '</strong></div>';
      }).join('') || '<p class="muted" style="font-size:12px">Операций пока нет</p>' :
        '<p class="muted" style="font-size:12px">Не удалось загрузить операции</p>') +
      '</div>' + action('refresh', '↻ Обновить мой кабинет', true) +
      '<p style="font-size:12px;text-align:center;margin-top:16px"><a href="/privacy-policy.html" target="_blank" rel="noopener">Политика конфиденциальности</a></p>';
    return html;
  }
  function load() {
    var status = identity.getStatus();
    if (!status.verified || !status.accounts.some(function(a) { return a.role === 'customer'; })) return;
    if (pending) return;
    var myGeneration = ++generation;
    pending = true;
    root.innerHTML = heading() + '<div class="block profile-hero"><div class="avatar">🐾</div><h2>Подключаем ваш кабинет</h2><p>Загружаем покупки и баланс косточек…</p></div>';
    identity.session('customer').then(function(session) {
      return Promise.allSettled([
        secureFetch('/api/customer/me', session.token),
        secureFetch('/api/customer/me/orders', session.token),
        secureFetch('/api/customer/me/bones', session.token),
      ]);
    }).then(function(results) {
      if (myGeneration !== generation) return;
      if (results[0].status !== 'fulfilled') throw results[0].reason;
      cached = {
        profile: results[0].value,
        orders: results[1].status === 'fulfilled' ? results[1].value : null,
        bones: results[2].status === 'fulfilled' ? results[2].value : null,
      };
      cacheKey = status.phoneMasked;
      if (!root.classList.contains('hide')) root.innerHTML = renderProfileCard(cached);
    }).catch(function(err) {
      if (myGeneration !== generation) return;
      if (!root.classList.contains('hide')) {
        root.innerHTML = heading() + '<div class="block">' +
          error(err.message) + action('refresh', 'Повторить вход') + '</div>';
      }
    }).finally(function() {
      if (myGeneration === generation) pending = false;
    });
  }
  function render(user, signed) {
    currentUser = user || null;
    isTelegramSigned = !!signed;
    var status = identity.getStatus();
    if (!signed || !status.verified || !status.accounts.some(function(a) { return a.role === 'customer'; })) {
      cached = null;
      root.innerHTML = heading() + renderIdentityPrompt(status);
      return;
    }
    if (cached && cacheKey === status.phoneMasked) {
      root.innerHTML = renderProfileCard(cached);
      return;
    }
    load();
  }
  root.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-customer-action]');
    if (!btn) return;
    if (btn.dataset.customerAction === 'share') {
      identity.requestContact().then(function() { render(currentUser, isTelegramSigned); });
    }
    if (btn.dataset.customerAction === 'check') {
      identity.refresh().then(function() { render(currentUser, isTelegramSigned); });
    }
    if (btn.dataset.customerAction === 'refresh') {
      cached = null;
      load();
    }
  });
  identity.onChange(function() {
    if (!root.classList.contains('hide')) render(currentUser, isTelegramSigned);
  });
  window.HvostMiniAppCustomer = { render: render };
})();
