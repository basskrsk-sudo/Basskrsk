// Mobile, role-scoped staff dashboards for ХвостМаркет Telegram Mini App.
// All numbers are read via existing authorization-checked APIs; a signed
// Telegram customer identity alone NEVER grants employee access.
(function(){
  'use strict';

  var CONFIG = {
    partner: { title: 'Грумер', icon: '✂️', description: 'Продажи, начисления и остатки', tokenKey: 'taiga_partner_token', me: '/api/partners/me', field: 'partner', full: '/taiga-groomer.html' },
    manager: { title: 'Менеджер', icon: '🗂️', description: 'Мои точки, продажи и пополнения', tokenKey: 'taiga_manager_token', me: '/api/managers/me', field: 'manager', full: '/taiga-manager.html' },
    owner: { title: 'Владелец салона', icon: '🏠', description: 'Выручка салона и вознаграждения', tokenKey: 'taiga_owner_token', me: '/api/owner/me', field: 'owner', full: '/taiga-owner.html' },
    admin: { title: 'Администратор', icon: '📊', description: 'Сеть, продажи и контроль работы', tokenKey: 'taiga_admin_token', me: '/api/admin/me', field: 'admin', full: '/taiga-admin.html' },
  };
  var order = ['partner', 'manager', 'owner', 'admin'];
  var activeRole = '';
  var currentUser = null;
  var serial = 0;
  var transientTokens = {};
  var restockItems = [];
  var root = document.getElementById('workPage');
  if (!root) return;
  var identity = window.HvostMiniAppIdentity || null;
  function phoneStatus() {
    return identity ? identity.getStatus() : { loaded: false, verified: false, accounts: [], ambiguousRoles: [], error: '', busy: false };
  }
  function phoneRoleAvailable(role) {
    return phoneStatus().accounts.some(function(a) { return a.role === role; });
  }
  function phoneBanner() {
    if (!identity) return '';
    var s = phoneStatus();
    if (!s.loaded) return note('Проверяем аккаунты, подключённые к Telegram…');
    if (!s.verified) {
      return '<div class="work-surface"><h2>🔐 Вход без пароля</h2>' +
        '<p class="work-note">Подтвердите номер телефона вашего Telegram. Мы найдём ваши зарегистрированные кабинеты ХвостМаркета. Вводить телефон вручную не нужно.</p>' +
        '<button type="button" class="work-primary" data-work-action="share-phone" ' + (s.busy ? 'disabled' : '') + '>' +
        (s.busy ? 'Проверяем номер…' : '📱 Подтвердить мой номер Telegram') + '</button>' +
        '<button type="button" class="work-secondary" data-work-action="check-phone" style="margin-top:9px">↻ Проверить номер</button>' +
        (s.error ? problem(s.error) : '') +
        '<p class="work-quiet">Если Telegram не поддерживает запрос номера, отправьте боту /phone.</p></div>';
    }
    var roleNames = { customer: 'покупатель', partner: 'грумер', manager: 'менеджер', owner: 'владелец', admin: 'администратор' };
    return note('✅ Номер подтверждён: ' + s.phoneMasked + '. ' +
      (s.accounts.length
        ? 'Доступны кабинеты: ' + s.accounts.map(function(a) { return roleNames[a.role] || a.role; }).join(', ') + '.'
        : 'Зарегистрированные кабинеты на этот номер пока не найдены.')) +
      (s.ambiguousRoles.length
        ? problem('На один номер записаны несколько кабинетов одной роли. Для безопасного выбора войдите по логину и паролю.')
        : '');
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rub(value) {
    return Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
  }
  function number(value) {
    return Number(value || 0).toLocaleString('ru-RU');
  }
  function date(value) {
    var s = String(value || '');
    if (!s) return '';
    var parsed = new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z'));
    return Number.isFinite(parsed.getTime()) ?
      parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : s.slice(0, 10);
  }
  function getToken(role) {
    if (transientTokens[role]) return transientTokens[role];
    try { return localStorage.getItem(CONFIG[role].tokenKey) || ''; } catch (_) { return ''; }
  }
  function setToken(role, value) {
    transientTokens[role] = value;
    try { localStorage.setItem(CONFIG[role].tokenKey, value); } catch (_) {}
  }
  function clearToken(role) {
    delete transientTokens[role];
    try {
      localStorage.removeItem(CONFIG[role].tokenKey);
      if (role === 'admin') localStorage.removeItem('taiga_admin_role');
    } catch (_) {}
  }
  function saveRole(role) {
    try { localStorage.setItem('hm_miniapp_work_role', role); } catch (_) {}
  }
  function savedRole() {
    try { return localStorage.getItem('hm_miniapp_work_role') || ''; } catch (_) { return ''; }
  }
  function heading(title, subtitle) {
    return '<div class="work-head"><h1>' + esc(title) + '</h1><p>' + esc(subtitle || '') + '</p></div>';
  }
  function back() {
    return '<button class="work-back" type="button" data-work-action="all">← Все кабинеты</button>';
  }
  function problem(message) {
    return '<div class="work-message" role="alert">' + esc(message) + '</div>';
  }
  function note(message) {
    return '<div class="work-info">' + esc(message) + '</div>';
  }
  function stat(label, value, caption) {
    return '<div class="work-stat"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong>' +
      (caption ? '<span>' + esc(caption) + '</span>' : '') + '</div>';
  }
  function surface(title, content) {
    return '<section class="work-surface"><h2>' + esc(title) + '</h2>' + content + '</section>';
  }
  function rows(items) {
    return items.length ? items.join('') : '<p class="work-note">Пока нет записей за выбранный период.</p>';
  }
  function line(title, sub, value) {
    return '<div class="work-row"><div><b>' + esc(title) + '</b>' +
      (sub ? '<small>' + esc(sub) + '</small>' : '') +
      '</div>' + (value == null ? '' : '<strong>' + esc(value) + '</strong>') + '</div>';
  }
  function openAll() {
    activeRole = '';
    currentUser = null;
    restockItems = [];
    serial++;
    renderAll();
  }
  function renderAll() {
    root.innerHTML = heading('Рабочие кабинеты 🐾', 'Выберите роль. Доступ по подтверждённому номеру Telegram или по действующему логину и паролю.') +
      phoneBanner() + '<div class="work-roles">' + order.map(function(role) {
        var config = CONFIG[role];
        return '<button class="work-role" type="button" data-work-action="role" data-work-role="' + role + '">' +
          '<span class="work-role-icon">' + config.icon + '</span><strong>' + esc(config.title) + '</strong>' +
          '<span>' + esc(config.description) + '</span>' +
          (getToken(role) ? '<small>● Есть сохранённая сессия</small>' : phoneRoleAvailable(role) ? '<small>✓ Вход через Telegram доступен</small>' : '<small>Войти в кабинет →</small>') +
          '</button>';
      }).join('') + '</div>' +
      '<p class="work-quiet">Доступ к рабочим данным проверяется сервером. Имя и ID пользователя Telegram не назначают ему роль автоматически.</p>';
  }
  function renderLogin(error) {
    if (!activeRole) return renderAll();
    var c = CONFIG[activeRole];
    root.innerHTML = back() + heading(c.icon + ' Кабинет: ' + c.title, 'Вход по подтверждённому Telegram или по логину и паролю сайта.') +
      (identity ? phoneBanner() : '') +
      (phoneRoleAvailable(activeRole) ? '<button type="button" class="work-primary" data-work-action="phone-login" style="margin-bottom:12px">Войти через Telegram без пароля →</button>' : '') +
      '<form id="workLoginForm" class="work-auth-card" autocomplete="on">' +
        '<h2>Вход для сотрудника</h2><p class="work-sub">Только для зарегистрированных пользователей этой роли.</p>' +
        '<label class="work-label" for="workLogin">Логин</label><input class="work-input" id="workLogin" name="username" type="text" autocomplete="username" maxlength="150" required>' +
        '<label class="work-label" for="workPassword">Пароль</label><input class="work-input" id="workPassword" name="password" type="password" autocomplete="current-password" maxlength="300" required>' +
        (error ? problem(error) : '') +
        '<button class="work-primary" type="submit" id="workLoginButton" style="margin-top:18px">Войти в кабинет →</button>' +
      '</form>' + note('Номер подтверждается непосредственно Telegram. Администратору также требуется предварительная привязка Telegram в действующем кабинете сайта.');
  }
  function renderLoading(text) {
    root.innerHTML = back() + heading(CONFIG[activeRole].icon + ' ' + CONFIG[activeRole].title, text || 'Загружаем данные…') +
      '<div class="work-surface" style="text-align:center;padding:35px">⏳ Подключаем рабочий кабинет</div>';
  }
  async function fetchJSON(url, token, options) {
    var init = Object.assign({ cache: 'no-store' }, options || {});
    init.headers = Object.assign({}, init.headers || {}, {
      Authorization: 'Bearer ' + token,
    });
    var response = await fetch(url, init);
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || 'Ошибка сервера (' + response.status + ')');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function chooseRole(role) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG, role)) return;
    activeRole = role;
    currentUser = null;
    restockItems = [];
    saveRole(role);
    var mySerial = ++serial;
    var token = getToken(role);
    if (!token) {
      if (identity && phoneRoleAvailable(role)) {
        renderLoading('Подтверждаем кабинет по номеру Telegram…');
        try {
          var loginResult = await identity.session(role);
          if (mySerial !== serial || activeRole !== role) return;
          if (loginResult && loginResult.token) {
            setToken(role, loginResult.token);
            return chooseRole(role);
          }
        } catch (err) {
          if (mySerial !== serial || activeRole !== role) return;
          renderLogin('Вход по Telegram не удался: ' + err.message);
          return;
        }
      }
      return renderLogin();
    }
    renderLoading('Проверяем сохранённый вход…');
    try {
      var data = await fetchJSON(CONFIG[role].me, token);
      if (mySerial !== serial) return;
      var user = data[CONFIG[role].field];
      if (!user || user.active === false || user.active === 0) {
        clearToken(role);
        renderLogin('Учётная запись недоступна. Повторите вход или обратитесь к администратору.');
        return;
      }
      currentUser = user;
      await loadDashboard(role, mySerial, token);
    } catch (e) {
      if (mySerial !== serial) return;
      if (e.status === 401 || e.status === 403) {
        clearToken(role);
        renderLogin('Сессия истекла. Войдите ещё раз.');
      } else {
        renderLogin('Не удалось проверить сессию: ' + e.message);
      }
    }
  }
  async function login() {
    var role = activeRole;
    if (!role || !CONFIG[role]) return;
    var username = document.getElementById('workLogin').value.trim();
    var password = document.getElementById('workPassword').value;
    if (!username || !password) { renderLogin('Введите логин и пароль.'); return; }
    var button = document.getElementById('workLoginButton');
    button.disabled = true;
    button.textContent = 'Проверяем данные…';
    try {
      var response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ role: role, login: username, password: password }),
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.token || !data.user) throw new Error(data.error || 'Не удалось войти в кабинет.');
      // Reuse exact keys of legacy role cabinets; same origin, same security checks.
      setToken(role, data.token);
      if (role === 'admin') {
        try { localStorage.setItem('taiga_admin_role', data.user.role === 'super' ? 'super' : 'admin'); } catch (_) {}
      }
      await chooseRole(role);
    } catch (e) {
      renderLogin(e.message);
    }
  }
  function dashboardHeader(role) {
    var config = CONFIG[role];
    var displayName = currentUser && (currentUser.full_name || currentUser.name || currentUser.login) || 'Сотрудник';
    var subtitle = config.title + (currentUser && currentUser.login ? ' · ' + currentUser.login : '');
    return back() + heading(config.icon + ' ' + config.title, 'Данные из действующей системы ХвостМаркет') +
      '<div class="work-profile-line"><div class="work-avatar">' + config.icon + '</div><div class="work-profile-text"><b>' +
        esc(displayName) + '</b><small>' + esc(subtitle) + '</small></div>' +
        '<button type="button" class="work-logout" data-work-action="logout">Выйти</button></div>';
  }
  function dashboardFooter(role) {
    return '<div class="work-action-bar">' +
      '<button class="work-primary" type="button" data-work-action="full" data-work-role="' + esc(role) + '">Открыть полный кабинет →</button>' +
      '<button class="work-secondary" type="button" data-work-action="reload">↻ Обновить показатели</button>' +
      '</div><p class="work-quiet">Полный кабинет открывается в том же окне Telegram и использует действующие права учётной записи. В нём доступны остальные функции сайта.</p>';
  }
  function dataOrWarning(settled, fallback) {
    if (settled.status === 'fulfilled') return settled.value;
    return fallback;
  }
  async function loadDashboard(role, mySerial, token) {
    renderLoading('Получаем актуальную статистику…');
    var endpoints = {
      partner: ['/api/partners/me/orders?days=30', '/api/partners/me/payouts?limit=10', '/api/partners/me/stock'],
      manager: ['/api/managers/me/orders?days=30&limit=200', '/api/managers/me/stock'],
      owner: ['/api/owner/dashboard'],
      admin: ['/api/points', '/api/orders?limit=100', '/api/operations-center'],
    };
    try {
      var results = await Promise.allSettled(endpoints[role].map(function(url) { return fetchJSON(url, token); }));
      if (mySerial !== serial || role !== activeRole) return;
      var authFailure = results.find(function(r) { return r.status === 'rejected' && (r.reason.status === 401 || r.reason.status === 403); });
      if (authFailure) { clearToken(role); currentUser = null; return renderLogin('Сессия истекла. Войдите ещё раз.'); }
      var anyFailed = results.some(function(r) { return r.status === 'rejected'; });
      var data = results.map(function(r) { return dataOrWarning(r, null); });
      var html = dashboardHeader(role);
      if (anyFailed) html += problem('Часть данных временно недоступна. Можно обновить страницу или открыть полный кабинет.');
      if (role === 'partner') html += partnerDashboard(data);
      if (role === 'manager') html += managerDashboard(data);
      if (role === 'owner') html += ownerDashboard(data);
      if (role === 'admin') html += adminDashboard(data);
      root.innerHTML = html + dashboardFooter(role);
    } catch (e) {
      if (mySerial !== serial) return;
      root.innerHTML = dashboardHeader(role) + problem(e.message) + dashboardFooter(role);
    }
  }
  function partnerDashboard(data) {
    var orders = data[0] && data[0].orders || [];
    var pay = data[1] || {};
    var stock = data[2] && data[2].stock || [];
    restockItems = stock.filter(function(x) { return Number(x.variant_id) > 0; });
    var amount = orders.reduce(function(sum, row) { return sum + Number(row.sum || 0); }, 0);
    var earn = orders.reduce(function(sum, row) { return sum + Number(row.commission || 0); }, 0);
    var low = stock.filter(function(x) { return Number(x.qty) <= 2; });
    var rate = Number(currentUser.commission_rate || 0) * 100;
    var html = '<div class="work-stats">' +
      stat('Продажи за 30 дней', rub(amount), number(orders.length) + ' покупок') +
      stat('Начислено за 30 дней', rub(earn), 'По фактическим продажам') +
      stat('Ожидает выплаты', data[1] ? rub(pay.unpaid_amount) : '—', 'По всем невыплаченным заказам') +
      stat('Комиссия', Math.round(rate) + '%', 'Ваш текущий тариф') + '</div>';
    html += surface('Последние продажи', rows(orders.slice(0, 6).map(function(o) {
      return line(o.product || 'Покупка', date(o.date) + ' · ' + o.order_code, '+' + rub(o.commission));
    })));
    html += surface('Остатки в салоне' + (low.length ? ' · ⚠️ ' + low.length : ''), rows(stock.slice(0, 12).map(function(s) {
      return line(s.product_name + ' · ' + s.weight, Number(s.qty) <= 2 ? 'Мало на полке' : 'Есть в наличии', number(s.qty) + ' шт.');
    })));
    if (restockItems.length) html += surface('📦 Запросить пополнение',
      '<p class="work-note">Заявка попадёт ответственному менеджеру и в рабочие уведомления.</p>' +
      '<form id="workRestockForm"><label class="work-label" for="workRestockItem">Товар</label>' +
      '<select class="work-input work-select" id="workRestockItem">' + restockItems.map(function(s) {
        return '<option value="' + esc(s.variant_id) + '">' + esc(s.product_name + ' · ' + s.weight + ' (остаток ' + s.qty + ')') + '</option>';
      }).join('') + '</select>' +
      '<label class="work-label" for="workRestockQty">Сколько привезти, шт.</label><input id="workRestockQty" class="work-input" type="number" min="1" max="500" step="1" value="5" inputmode="numeric" required>' +
      '<button class="work-secondary" type="submit" style="margin-top:12px" id="workRestockButton">Отправить заявку</button><div id="workRestockMessage" aria-live="polite"></div></form>');
    return html;
  }
  function managerDashboard(data) {
    var points = currentUser.points || [];
    var orders = data[0] && data[0].orders || [];
    var stockPoints = data[1] && data[1].points || [];
    var paid = orders.filter(function(o) { return o.status === 'paid' && o.refund_status !== 'refunded'; });
    var revenue = paid.reduce(function(s, o) { return s + Number(o.total || 0); }, 0);
    var low = stockPoints.reduce(function(s, p) {
      return s + (p.items || []).filter(function(i) { return Number(i.qty) <= 2; }).length;
    }, 0);
    var html = '<div class="work-stats">' +
      stat('Мои точки', number(points.length), 'Закреплены за менеджером') +
      stat('Продажи за 30 дней', rub(revenue), number(paid.length) + ' оплаченных заказов') +
      stat('Ожидает выплаты', rub(currentUser.commission_unpaid), 'Комиссия по продажам') +
      stat('Бонусы к выплате', rub(currentUser.launch_bonus_unpaid), 'За открытие точек') + '</div>';
    html += surface('Мои минимаркеты', rows(points.slice(0, 14).map(function(p) {
      return line(p.point_name || p.name || ('Точка #' + p.point_id), p.address || p.point_addr || 'Выручка за всё время', rub(p.live_revenue != null ? p.live_revenue : p.revenue));
    })));
    html += surface('Последние продажи', rows(orders.slice(0, 6).map(function(o) {
      return line(o.point_name || o.pickup_point || 'Минимаркет', date(o.created_at) + ' · ' + (o.partner_name || 'Без выбора грумера'), rub(o.total));
    })));
    if (data[1]) {
      html += surface('📦 Контроль остатков', '<p class="work-note">' + (low ? 'Позиций с остатком 2 шт. и меньше: ' + low + '. Проверьте пополнение.' : 'Критически низких остатков среди учтённых позиций нет.') + '</p>' +
        rows(stockPoints.slice(0, 12).map(function(p) {
          var items = p.items || [];
          return line(p.point_name, 'Низкие остатки: ' + items.filter(function(i) { return Number(i.qty) <= 2; }).length, number(items.length) + ' поз.');
        })));
    }
    return html;
  }
  function ownerDashboard(data) {
    var d = data[0];
    if (!d) return problem('Не удалось получить показатели салона.');
    if (d.noPoint) return note(d.message || 'Вам ещё не назначена точка.');
    var totals = d.totals || {}, earn = d.owner_earnings || {};
    var html = note('📍 ' + (d.point && d.point.name || 'Ваш салон') + (d.point && d.point.addr ? ' · ' + d.point.addr : '')) +
      '<div class="work-stats">' +
      stat('Выручка за месяц', rub(totals.this_month_revenue), number(totals.this_month_orders) + ' продаж') +
      stat('Продажи за всё время', rub(totals.revenue), number(totals.orders) + ' покупок') +
      stat('К выплате владельцу', rub(earn.unpaid), 'Невыплаченное вознаграждение') +
      stat('Средний чек', rub(totals.avg_order), 'За всё время') + '</div>';
    html += surface('Грумеры салона', rows((d.groomers || []).slice(0, 10).map(function(g) {
      return line(g.full_name, number(g.orders_count) + ' продаж · ' + g.tier_percent + '% комиссия', rub(g.revenue));
    })));
    html += surface('Последние продажи', rows((d.recent_orders || []).slice(0, 7).map(function(o) {
      return line('Продажа' + (o.is_self_order ? ' · самозаказ' : ''), date(o.created_at), rub(o.total));
    })));
    return html;
  }
  function adminDashboard(data) {
    var points = data[0] && data[0].points || [];
    var allOrders = data[1] && data[1].orders || [];
    var paidOrders = allOrders.filter(function(o) {
      return o.status === 'paid' && o.refund_status !== 'refunded';
    });
    var ops = data[2] || {};
    var issues = ops.issues || [];
    var revenue = paidOrders.reduce(function(s, o) { return s + Number(o.total || 0); }, 0);
    var html = '<div class="work-stats">' +
      stat('Активных точек', data[0] ? number(points.length) : '—', 'По всей сети') +
      stat('Последние покупки', data[1] ? number(paidOrders.length) : '—', 'Оплаченных среди 100 последних заказов') +
      stat('Выручка последних заказов', data[1] ? rub(revenue) : '—', 'Оплаченные среди 100 последних') +
      stat('Сигналы контроля', data[2] ? number((ops.summary || {}).total || issues.length) : '—', 'Операционные вопросы') +
      '</div>';
    html += surface('Последние заказы сети', rows(allOrders.slice(0, 8).map(function(o) {
      return line(o.pickup_point || 'Покупка', date(o.created_at) + ' · ' + (o.status === 'paid' ? 'Оплачен' : 'Статус: ' + o.status), rub(o.total));
    })));
    html += surface('Операционный контроль', rows(issues.slice(0, 7).map(function(issue) {
      return line((issue.icon || '⚠️') + ' ' + (issue.title || 'Задача'), issue.summary || '', number(issue.count || 0));
    })));
    return html;
  }
  async function sendRestock() {
    if (activeRole !== 'partner' || !currentUser) return;
    var select = document.getElementById('workRestockItem');
    var quantity = document.getElementById('workRestockQty');
    var button = document.getElementById('workRestockButton');
    var status = document.getElementById('workRestockMessage');
    if (!select || !quantity || !button || !status) return;
    var variantId = Number(select.value);
    var qty = Number(quantity.value);
    if (!restockItems.some(function(item) { return Number(item.variant_id) === variantId; }) ||
        !Number.isSafeInteger(qty) || qty < 1 || qty > 500) {
      status.innerHTML = problem('Укажите товар из списка и количество от 1 до 500 шт.');
      return;
    }
    var token = getToken('partner');
    if (!token) return renderLogin('Сессия завершена. Повторите вход.');
    button.disabled = true;
    status.innerHTML = '';
    try {
      var result = await fetchJSON('/api/partners/me/restock-signal', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ variant_id: variantId, qty: qty }] }),
      });
      status.innerHTML = note('✅ Заявка №' + result.request_id + ' на пополнение передана менеджеру.');
    } catch (e) {
      if (e.status === 401 || e.status === 403) { clearToken('partner'); return renderLogin('Сессия истекла.'); }
      status.innerHTML = problem(e.message);
    } finally { button.disabled = false; }
  }
  function openFullCabinet(role) {
    if (!CONFIG[role] || !getToken(role)) return renderLogin('Для перехода сначала войдите в кабинет.');
    try { sessionStorage.setItem('hm_miniapp_return_to_work', '1'); } catch (_) {}
    window.location.assign(CONFIG[role].full + '?from=miniapp');
  }
  root.addEventListener('click', function(e) {
    var button = e.target.closest('[data-work-action]');
    if (!button) return;
    var action = button.dataset.workAction;
    if (action === 'all') return openAll();
    if (action === 'role') return chooseRole(button.dataset.workRole);
    if (action === 'logout') { var role = activeRole; clearToken(role); currentUser = null; serial++; return renderLogin(); }
    if (action === 'share-phone' && identity) return identity.requestContact().then(function() {
      if (activeRole) chooseRole(activeRole);
      else renderAll();
    });
    if (action === 'check-phone' && identity) return identity.refresh().then(function() {
      if (activeRole) chooseRole(activeRole);
      else renderAll();
    });
    if (action === 'phone-login' && activeRole) return chooseRole(activeRole);
    if (action === 'reload') return chooseRole(activeRole);
    if (action === 'full') return openFullCabinet(activeRole);
  });
  root.addEventListener('submit', function(e) {
    if (e.target.id === 'workLoginForm') { e.preventDefault(); login(); }
    if (e.target.id === 'workRestockForm') { e.preventDefault(); sendRestock(); }
  });
  if (identity) identity.onChange(function(state) {
    if (!activeRole) return renderAll();
    if (root.innerHTML.includes('workLoginForm') && state.verified &&
        state.accounts.some(function(a) { return a.role === activeRole; })) {
      chooseRole(activeRole);
    }
  });

  window.HvostMiniAppWork = {
    render: function() {
      if (!activeRole) return renderAll();
      // Return from the full cabinet: refresh server data, never trust old markup.
      return chooseRole(activeRole);
    },
    chooseRole: chooseRole,
    roles: order.slice(),
  };

  // Make the last-used role discoverable without exposing its data before login.
  var previous = savedRole();
  if (CONFIG[previous] && getToken(previous)) {
    activeRole = previous;
  }
})();
