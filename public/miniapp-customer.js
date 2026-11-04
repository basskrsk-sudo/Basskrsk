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
  var enteredPhone = '';
  var confirmingPhone = false;
  var notificationSettingsOpen = false;
  var customerDetailsOpen = false;
  var ROLE_LABELS = {
    customer: '🐾 Мои покупки и косточки',
    salon: '✂️🏠 Мой салон и продажи',
    partner: '✂️ Грумер', manager: '🗂️ Менеджер',
    owner: '🏠 Владелец салона', founder: '👑 Собственник ХвостМаркета',
    admin: '📊 Администратор',
  };

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
  function heading(details) {
    return '<h1 class="page-title">' +
      (details ? 'Кабинет покупателя' : 'Ваш ХвостМаркет') + ' 🐾</h1>';
  }
  function accessibleCabinets(status) {
    if (!status.verified) return '';
    var roles = (status.accounts || []).filter(function(a) {
      return Object.prototype.hasOwnProperty.call(ROLE_LABELS, a.role);
    });
    if (status.combinedSalon && roles.some(function(a) { return a.role === 'partner'; }) &&
        roles.some(function(a) { return a.role === 'owner'; })) {
      // One navigation tile for the same person doing both jobs. Existing
      // salary/owner payouts stay separate in their respective backend roles.
      roles = [{ role: 'salon', name: 'Грумер и владелец салона' }].concat(
        roles.filter(function(a) { return a.role !== 'partner' && a.role !== 'owner'; })
      );
    }
    if (!roles.length) return '<div class="block"><p class="muted">По этому номеру пока нет зарегистрированных кабинетов. Магазин доступен без регистрации.</p></div>';
    return '<div class="block"><h3 style="margin:0 0 8px">Ваши кабинеты</h3>' +
      '<p class="muted" style="font-size:12px">Найдены по подтверждённому номеру Telegram:</p>' +
      '<div class="customer-role-links">' + roles.map(function(a) {
        return '<button class="customer-role-link" type="button" data-customer-action="choose-role" ' +
          'data-customer-role="' + esc(a.role) + '">' + esc(ROLE_LABELS[a.role]) + ' <span>→</span></button>';
      }).join('') + '</div></div>';
  }
  function error(text) {
    return '<p class="error" role="alert">' + esc(text) + '</p>';
  }
  function shortcutAction() {
    var shortcut = window.HvostMiniAppHomeScreen;
    return shortcut && typeof shortcut.actionMarkup === 'function'
      ? shortcut.actionMarkup() : '';
  }
  function renderIdentityPrompt(status) {
    var userName = currentUser && currentUser.first_name || 'Покупатель';
    var content = '<div class="block profile-hero">' + avatar(userName) +
      '<p>' + (isTelegramSigned ? 'Ваш личный кабинет ХвостМаркета' : 'Откройте приложение через Telegram-бота') +
      '</p></div>';
    if (!isTelegramSigned && window.HvostTelegramContext) {
      // A broken or missing Telegram launch session cannot be repaired by
      // typing any phone number. Explain the real problem instead of showing
      // an unusable form that wrongly appears to reject the user's phone.
      var reason = status.error || window.HvostTelegramContext.unavailableMessage();
      content += '<div class="block customer-entry"><h3>⚠️ Не удалось проверить вход через Telegram</h3>' +
        error(reason) +
        '<p class="hint">Вернитесь в чат ХвостМаркет и нажмите кнопку «Открыть ХвостМаркет». ' +
        'Если повторяется, отправьте боту /app, откройте новую кнопку и ' +
        'передайте администратору код TG-01 или TG-02, указанный выше.</p>' +
        '<button type="button" class="btn btn-gold" data-customer-action="retry-telegram">' +
        '↻ Повторить проверку Telegram</button></div>';
    } else if (!status.verified) {
      content += '<div class="block customer-entry"><h3>📱 Введите номер телефона</h3>' +
        '<p class="muted" style="font-size:12px;line-height:1.6">Введите номер, который указывали при покупках или регистрации на сайте. ' +
        'Для защиты данных мы проверим, что этот номер действительно принадлежит вашему Telegram.</p>' +
        '<form id="customerPhoneGateForm">' +
          '<label for="customerPhoneEntry" class="form-label">Ваш номер телефона</label>' +
          '<input id="customerPhoneEntry" class="form-field" name="customerPhone" type="tel" inputmode="tel" ' +
          'autocomplete="tel" placeholder="+7 999 123-45-67" maxlength="25" required value="' + esc(enteredPhone) + '">' +
          '<button class="btn btn-gold" type="submit" style="margin-top:14px" ' +
          (confirmingPhone || status.busy || !isTelegramSigned ? 'disabled' : '') + '>' +
          (confirmingPhone || status.busy ? '⏳ Проверяем номер…' : 'Продолжить и подтвердить номер →') + '</button>' +
        '</form>' +
        '<p class="hint">' + (status.contactVerified
          ? 'Ваш контакт уже передан Telegram. Осталось проверить введённый номер.'
          : 'Telegram запросит разрешение на передачу вашего собственного номера. Мы не выдаём доступ по чужому контакту.') + '</p>' +
        (status.error ? error(status.error) : '') +
        '<p class="hint">Если запрос контакта недоступен, отправьте действующему боту команду /phone, ' +
        'поделитесь своим контактом, вернитесь и нажмите «Продолжить».</p></div>';
    } else {
      content += '<div class="block"><h3>✅ Номер проверен</h3>' +
        '<p class="ok">Подтверждён: ' + esc(status.phoneMasked) + '</p>' +
        '<p class="muted" style="font-size:12px">Выберите, что хотите открыть. Система показывает только подтверждённые регистрации.</p>' +
        ((status.ambiguousRoles || []).length
          ? error('Для некоторых ролей найдено несколько регистраций. Обратитесь к администратору, чтобы уточнить привязку.') : '') +
        '</div>' + accessibleCabinets(status);
    }
    content += '<div class="block"><button type="button" class="btn btn-light" data-customer-action="open-shop">' +
      '🛍 Открыть магазин</button></div>';
    return content + shortcutAction();
  }
  function secureFetch(path, token) {
    var reliable = window.HvostMiniAppReliability;
    return (reliable ? reliable.request : fetch)(path, {
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
    var html = heading(true) +
      '<button type="button" class="btn btn-light" style="margin-bottom:12px" data-customer-action="all-roles">← Все мои возможности</button>' +
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
      '</div>' +
      action('notifications', '🔔 Настройки уведомлений', true) +
      shortcutAction() +
      action('refresh', '↻ Обновить мой кабинет', true) +
      '<p style="font-size:12px;text-align:center;margin-top:16px"><a href="/privacy-policy.html" target="_blank" rel="noopener">Политика конфиденциальности</a></p>';
    return html;
  }
  function load() {
    var status = identity.getStatus();
    if (!status.verified || !status.accounts.some(function(a) { return a.role === 'customer'; })) return;
    if (pending) return;
    var myGeneration = ++generation;
    pending = true;
    root.innerHTML = heading(true) + '<div class="block profile-hero"><div class="avatar">🐾</div><h2>Подключаем ваш кабинет</h2><p>Загружаем покупки и баланс косточек…</p></div>';
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
        root.innerHTML = heading(true) + '<div class="block">' +
          error(err.message) + action('refresh', 'Повторить вход') + '</div>';
      }
    }).finally(function() {
      if (myGeneration === generation) pending = false;
    });
  }
  function render(user, signed) {
    if (currentUser && user && currentUser.id && user.id && currentUser.id !== user.id) customerDetailsOpen = false;
    currentUser = user || null;
    isTelegramSigned = !!signed;
    var status = identity.getStatus();
    if (!status.verified) customerDetailsOpen = false;
    if (!signed || !status.verified || !customerDetailsOpen ||
        !status.accounts.some(function(a) { return a.role === 'customer'; })) {
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
  root.addEventListener('input', function(e) {
    if (e.target && e.target.id === 'customerPhoneEntry') enteredPhone = e.target.value;
  });
  root.addEventListener('submit', function(e) {
    if (!e.target || e.target.id !== 'customerPhoneGateForm') return;
    e.preventDefault();
    if (confirmingPhone) return;
    var field = document.getElementById('customerPhoneEntry');
    enteredPhone = field ? field.value.trim() : enteredPhone;
    confirmingPhone = true;
    render(currentUser, isTelegramSigned);
    identity.verifyPhone(enteredPhone).then(function() {
      confirmingPhone = false;
      render(currentUser, isTelegramSigned);
    }).catch(function(err) {
      confirmingPhone = false;
      render(currentUser, isTelegramSigned);
    });
  });
  root.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-customer-action]');
    if (!btn) return;
    if (btn.dataset.customerAction === 'retry-telegram') {
      if (window.location && typeof window.location.reload==='function') window.location.reload();
      return;
    }
    if (btn.dataset.customerAction === 'open-shop') {
      customerDetailsOpen = false;
      if (window.HvostMiniAppGoShop) window.HvostMiniAppGoShop();
      return;
    }
    if (btn.dataset.customerAction === 'all-roles') {
      customerDetailsOpen = false;
      render(currentUser, isTelegramSigned);
      return;
    }
    if (btn.dataset.customerAction === 'choose-role') {
      var role = btn.dataset.customerRole;
      var status = identity.getStatus();
      var authorized = !!(status.verified &&
        (status.accounts.some(function(a) { return a.role === role; }) ||
          (role === 'salon' && status.combinedSalon &&
            status.accounts.some(function(a) { return a.role === 'partner'; }) &&
            status.accounts.some(function(a) { return a.role === 'owner'; }))));
      if (!authorized) return;
      if (role === 'customer') {
        customerDetailsOpen = true;
        render(currentUser, isTelegramSigned);
      } else if (window.HvostMiniAppOpenRole) {
        window.HvostMiniAppOpenRole(role);
      }
      return;
    }
    if (btn.dataset.customerAction === 'share') {
      identity.requestContact().then(function() { render(currentUser, isTelegramSigned); });
    }
    if (btn.dataset.customerAction === 'check') {
      identity.refresh().then(function() { render(currentUser, isTelegramSigned); });
    }
    if (btn.dataset.customerAction === 'notifications' && window.HvostNotificationSettings) {
      var status=identity.getStatus();
      if(!status.verified || !status.accounts.some(function(a){return a.role==='customer';}))return;
      notificationSettingsOpen=true;
      root.innerHTML=heading()+'<div class="block">⏳ Загружаем настройки…</div>';
      identity.session('customer').then(function(session){
        if(!notificationSettingsOpen)return;
        window.HvostNotificationSettings.open({
          root:root,roles:['customer'],tokens:{customer:session.token},
          back:function(){notificationSettingsOpen=false;render(currentUser,isTelegramSigned);}
        });
      }).catch(function(e){
        notificationSettingsOpen=false;
        root.innerHTML=heading()+'<div class="block">'+error(e.message)+action('refresh','Вернуться в профиль',true)+'</div>';
      });
      return;
    }
    if (btn.dataset.customerAction === 'refresh') {
      cached = null;
      load();
    }
  });
  identity.onChange(function() {
    if (!notificationSettingsOpen && !root.classList.contains('hide')) render(currentUser, isTelegramSigned);
  });
  window.HvostMiniAppCustomer = {
    render: render,
    showChoices: function() { customerDetailsOpen = false; render(currentUser, isTelegramSigned); },
  };
})();
