// Mobile, role-scoped staff dashboards for ХвостМаркет Telegram Mini App.
// All numbers are read via existing authorization-checked APIs; a signed
// Telegram customer identity alone NEVER grants employee access.
(function(){
  'use strict';

  var CONFIG = {
    salon: { title: 'Мой салон и продажи', icon: '✂️🏠', description: 'Личные продажи, выручка салона и общая сумма выплат', tokenKey: '', me: '', field: '', full: '' },
    partner: { title: 'Грумер', icon: '✂️', description: 'Продажи, начисления и остатки', tokenKey: 'taiga_partner_token', me: '/api/partners/me', field: 'partner', full: '/taiga-groomer.html' },
    manager: { title: 'Менеджер', icon: '🗂️', description: 'Мои точки, продажи и пополнения', tokenKey: 'taiga_manager_token', me: '/api/managers/me', field: 'manager', full: '/taiga-manager.html' },
    owner: { title: 'Владелец салона', icon: '🏠', description: 'Выручка салона и вознаграждения', tokenKey: 'taiga_owner_token', me: '/api/owner/me', field: 'owner', full: '/taiga-owner.html' },
    founder: { title: 'Собственник ХвостМаркета', icon: '👑', description: 'Стратегия, деньги, сеть и решения', tokenKey: 'hm_business_founder_token', me: '/api/business-founder/me', field: 'founder', full: '/miniapp.html?view=work' },
    admin: { title: 'Администратор', icon: '📊', description: 'Сеть, продажи и контроль работы', tokenKey: 'taiga_admin_token', me: '/api/admin/me', field: 'admin', full: '/taiga-admin.html' },
  };
  var order = ['salon', 'partner', 'manager', 'owner', 'founder', 'admin'];
  var activeRole = '';
  var currentUser = null;
  var serial = 0;
  var transientTokens = {};
  var restockItems = [];
  var taskPanel = window.HvostMiniAppTasks || null;
  var taskData = null;
  var dashboardMarkup = '';
  var taskView = 'overview';
  var chatView = '';
  var chatThreadId = null;
  var chatNotice = '';
  var root = document.getElementById('workPage');
  if (!root) return;
  var identity = window.HvostMiniAppIdentity || null;
  function phoneStatus() {
    return identity ? identity.getStatus() : { loaded: false, verified: false, accounts: [], ambiguousRoles: [], error: '', busy: false };
  }
  function phoneRoleAvailable(role) {
    var status = phoneStatus();
    if (role === 'salon') return !!(status.verified && status.combinedSalon &&
      status.accounts.some(function(a) { return a.role === 'partner'; }) &&
      status.accounts.some(function(a) { return a.role === 'owner'; }));
    return status.accounts.some(function(a) { return a.role === role; });
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
    var roleNames = { customer: 'покупатель', partner: 'грумер', manager: 'менеджер', owner: 'владелец салона', founder: 'собственник бизнеса', admin: 'администратор' };
    var namedRoles = s.combinedSalon ? ['грумер — владелец салона'].concat(
      s.accounts.filter(function(a) { return a.role !== 'partner' && a.role !== 'owner'; })
        .map(function(a) { return roleNames[a.role] || a.role; })
    ) : s.accounts.map(function(a) { return roleNames[a.role] || a.role; });
    return note('✅ Номер подтверждён: ' + s.phoneMasked + '. ' +
      (s.accounts.length
        ? 'Доступны кабинеты: ' + namedRoles.join(', ') + '.'
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
    // A home-screen shortcut can have separate localStorage from the chat.
    // Persist only this authorized role on the server, not any access token.
    if (identity && typeof identity.rememberRole === 'function') {
      identity.rememberRole(role).catch(function() {});
    }
  }
  function savedRole() {
    try { return localStorage.getItem('hm_miniapp_work_role') || ''; } catch (_) { return ''; }
  }
  function shortcutAction() {
    var shortcut = window.HvostMiniAppHomeScreen;
    return shortcut && typeof shortcut.actionMarkup === 'function'
      ? shortcut.actionMarkup() : '';
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
    taskData = null;
    dashboardMarkup = '';
    taskView = 'overview';
    chatView = '';
    chatThreadId = null;
    chatNotice = '';
    if (taskPanel) taskPanel.reset();
    serial++;
    renderAll();
  }
  function renderAll() {
    if (!phoneStatus().verified) {
      root.innerHTML = heading('Рабочие кабинеты 🐾', 'Сначала подтвердите свой номер в кабинете покупателя.') +
        '<div class="work-surface"><h2>🔐 Доступ после проверки номера</h2>' +
        '<p class="work-note">Грумер, менеджер, владелец салона, собственник бизнеса и администратор ' +
        'увидят только свои кабинеты после подтверждения номера через Telegram.</p>' +
        '<button class="work-primary" type="button" data-work-action="go-profile">Ввести телефон →</button></div>' +
        shortcutAction();
      return;
    }
    var available = order.filter(function(role) {
      // The verified active groomer-owner sees one entry, not two duplicate
      // cabinets. Behind it we continue using two independent role tokens.
      if (phoneRoleAvailable('salon') && (role === 'partner' || role === 'owner')) return false;
      return phoneRoleAvailable(role);
    });
    root.innerHTML = heading('Ваши кабинеты 🐾', 'Доступны только роли, связанные с подтверждённым номером Telegram.') +
      phoneBanner() + (available.length ? '<div class="work-roles">' + available.map(function(role) {
        var config = CONFIG[role];
        return '<button class="work-role" type="button" data-work-action="role" data-work-role="' + role + '">' +
          '<span class="work-role-icon">' + config.icon + '</span><strong>' + esc(config.title) + '</strong>' +
          '<span>' + esc(config.description) + '</span>' +
          (role === 'salon' ? '<small>✓ Две роли в одном кабинете</small>' :
            getToken(role) ? '<small>● Есть сохранённая сессия</small>' :
            phoneRoleAvailable(role) ? '<small>✓ Вход через Telegram доступен</small>' : '<small>Войти в кабинет →</small>') +
          '</button>';
      }).join('') + '</div>' : '<div class="work-surface"><h2>Других кабинетов пока нет</h2>' +
        '<p class="work-note">По вашему номеру не найдены дополнительные активные роли. ' +
        'Если вы сотрудник или собственник бизнеса, попросите администратора подключить доступ.</p></div>') +
      shortcutAction() +
      '<p class="work-quiet">Права к данным проверяются сервером. Номер Telegram сам по себе не назначает роль.</p>';
  }
  function renderLogin(error) {
    if (!phoneStatus().verified) return renderAll();
    if (!activeRole) return renderAll();
    var c = CONFIG[activeRole];
    root.innerHTML = back() + heading(c.icon + ' Кабинет: ' + c.title, 'Вход по подтверждённому Telegram или по логину и паролю сайта.') +
      (identity ? phoneBanner() : '') +
      (activeRole === 'founder' && phoneStatus().verified && !phoneRoleAvailable('founder') ? '<div class="work-surface"><h2>👑 Доступ собственника ещё не подключён</h2><p class="work-note">Номер Telegram подтверждён, но учётная запись собственника пока не активирована. Активировать её может только супер-администратор.</p><button type="button" class="work-secondary" data-work-action="owner-setup">Перейти к настройкам через администратора →</button></div>' : '') +
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
  function normalizedPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }
  function validCombinedAccounts(partner, owner) {
    if (!partner || !owner || partner.active === false || partner.active === 0 ||
        owner.active === false || owner.active === 0 ||
        !partner.point_id || !owner.point_id ||
        String(partner.point_id) !== String(owner.point_id)) return false;
    var partnerPhone = normalizedPhone(partner.phone);
    var ownerPhone = normalizedPhone(owner.phone);
    if (!partnerPhone || partnerPhone !== ownerPhone) return false;
    if (owner.groomer_partner_id != null &&
        Number(owner.groomer_partner_id) !== Number(partner.id)) return false;
    return true;
  }
  function combinedSalonDashboard(partner, owner, ordersData, payoutData, stockData, salonData) {
    var orders = ordersData.orders || [];
    var payout = payoutData || {};
    var stock = stockData.stock || [];
    var salon = salonData || {};
    var totals = salon.totals || {};
    var ownerEarnings = salon.owner_earnings || {};
    var personalRevenue = orders.reduce(function(sum, item) { return sum + Number(item.sum || 0); }, 0);
    var personalEarned = orders.reduce(function(sum, item) { return sum + Number(item.commission || 0); }, 0);
    var partnerUnpaid = Number(payout.unpaid_amount || 0);
    var ownerUnpaid = Number(ownerEarnings.unpaid || 0);
    var salonTitle = (salon.point && salon.point.name) || partner.point_name || 'Ваш салон';
    restockItems = stock.filter(function(s) { return Number(s.variant_id) > 0; });
    var lowStock = stock.filter(function(s) { return Number(s.qty) <= 2; });
    var html = note('📍 ' + salonTitle + (salon.point && salon.point.addr ? ' · ' + salon.point.addr : '')) +
      '<div class="work-surface combined-overview"><h2>💚 Всего к выплате вам</h2>' +
      '<div class="combined-total">' + esc(rub(partnerUnpaid + ownerUnpaid)) + '</div>' +
      '<p class="work-note">Грумер: ' + esc(rub(partnerUnpaid)) + ' · Владелец: ' +
        esc(rub(ownerUnpaid)) + '</p></div>' +
      '<div class="work-stats">' +
        stat('Выручка всего салона', rub(totals.this_month_revenue), 'Текущий календарный месяц') +
        stat('Мои продажи', rub(personalRevenue), number(orders.length) + ' покупок за 30 дней') +
        stat('Начислено мне как грумеру', rub(personalEarned), 'За личные продажи · 30 дней') +
        stat('Начислено владельцу', rub(ownerEarnings.this_month), 'За все продажи салона · месяц') +
      '</div>' +
      note('Личные продажи уже входят в выручку салона: не складывайте эти суммы. ' +
        'Начисления грумера и владельца считаются отдельно, без двойного учёта продаж.');
    html += surface('💰 Выплаты по двум ролям',
      line('✂️ За личные рекомендации', 'К выплате грумеру · текущий тариф ' +
        Math.round(Number(partner.commission_rate || 0) * 100) + '%', rub(partnerUnpaid)) +
      line('🏠 За размещение в салоне', 'К выплате владельцу · текущий тариф ' +
        Math.round(Number(owner.commission_rate || 0) * 100) + '%', rub(ownerUnpaid)) +
      '<p class="work-note">Погашенные выплаты уже исключены из сумм «к выплате».</p>');
    html += surface('🛍 Мои личные продажи · 30 дней',
      rows(orders.slice(0, 8).map(function(o) {
        return line(o.product || 'Покупка', date(o.date) + ' · ' + o.order_code, '+' + rub(o.commission));
      })));
    html += surface('🏪 Продажи салона',
      '<div class="work-stats">' +
        stat('Заказов за месяц', number(totals.this_month_orders), 'Все грумеры') +
        stat('Средний чек', rub(totals.avg_order), 'Все продажи салона') +
      '</div>' +
      '<h3 class="combined-subtitle">Грумеры салона</h3>' +
      rows((salon.groomers || []).slice(0, 10).map(function(g) {
        return line(g.full_name, number(g.orders_count) + ' покупок', rub(g.revenue));
      })) +
      '<h3 class="combined-subtitle">Последние покупки в салоне</h3>' +
      rows((salon.recent_orders || []).slice(0, 5).map(function(o) {
        return line('Продажа' + (o.is_self_order ? ' · самозаказ' : ''), date(o.created_at), rub(o.total));
      })));
    html += surface('📦 Остатки товаров' + (lowStock.length ? ' · ⚠️ ' + lowStock.length : ''),
      rows(stock.slice(0, 12).map(function(item) {
        return line(item.product_name + ' · ' + item.weight,
          Number(item.qty) <= 2 ? 'Мало на полке' : 'Есть в наличии', number(item.qty) + ' шт.');
      })));
    if (restockItems.length) html += surface('📦 Запросить пополнение',
      '<p class="work-note">Заявка уйдёт менеджеру вашей точки через действующий кабинет грумера.</p>' +
      '<form id="workRestockForm"><label class="work-label" for="workRestockItem">Товар</label>' +
      '<select class="work-input work-select" id="workRestockItem">' + restockItems.map(function(item) {
        return '<option value="' + esc(item.variant_id) + '">' +
          esc(item.product_name + ' · ' + item.weight + ' (остаток ' + item.qty + ')') + '</option>';
      }).join('') + '</select>' +
      '<label class="work-label" for="workRestockQty">Сколько привезти, шт.</label>' +
      '<input id="workRestockQty" class="work-input" type="number" min="1" max="500" step="1" value="5" inputmode="numeric" required>' +
      '<button class="work-secondary" type="submit" style="margin-top:12px" id="workRestockButton">Отправить заявку менеджеру</button>' +
      '<div id="workRestockMessage" aria-live="polite"></div></form>');
    return html;
  }
  async function chooseCombinedSalon() {
    if (!phoneRoleAvailable('salon') || !identity || typeof identity.session !== 'function') {
      return openAll();
    }
    activeRole = 'salon';
    taskData = null;
    dashboardMarkup = '';
    taskView = 'overview';
    if (taskPanel) taskPanel.reset();
    currentUser = null;
    restockItems = [];
    saveRole('salon');
    var mySerial = ++serial;
    renderLoading('Проверяем доступ грумера и владельца салона…');
    try {
      // Two separately authorized sessions; NEVER synthesize a new composite
      // JWT or call the salon owner API using a groomer's privileges.
      var sessions = await Promise.all([identity.session('partner'), identity.session('owner')]);
      if (mySerial !== serial || activeRole !== 'salon') return;
      if (!sessions[0].token || !sessions[1].token) throw new Error('Не удалось подтвердить оба кабинета.');
      var partnerToken = sessions[0].token;
      var ownerToken = sessions[1].token;
      var me = await Promise.all([
        fetchJSON('/api/partners/me', partnerToken),
        fetchJSON('/api/owner/me', ownerToken),
      ]);
      if (mySerial !== serial || activeRole !== 'salon') return;
      var partner = me[0].partner;
      var owner = me[1].owner;
      if (!validCombinedAccounts(partner, owner)) {
        throw new Error('Владелец и грумер должны быть активны и привязаны к одному салону. Проверьте связь в админке.');
      }
      setToken('partner', partnerToken);
      setToken('owner', ownerToken);
      currentUser = owner;
      renderLoading('Собираем общую сводку салона…');
      var data = await Promise.all([
        fetchJSON('/api/partners/me/orders?days=30', partnerToken),
        fetchJSON('/api/partners/me/payouts?limit=10', partnerToken),
        fetchJSON('/api/partners/me/stock', partnerToken),
        fetchJSON('/api/owner/dashboard', ownerToken),
      ]);
      if (mySerial !== serial || activeRole !== 'salon') return;
      if (!data[3] || data[3].noPoint ||
          !data[3].point || String(data[3].point.id) !== String(owner.point_id)) {
        throw new Error('Не удалось подтвердить показатели вашего салона.');
      }
      root.innerHTML = dashboardHeader('salon') +
        combinedSalonDashboard(partner, owner, data[0], data[1], data[2], data[3]) +
        dashboardFooter('salon');
    } catch (error) {
      if (mySerial !== serial || activeRole !== 'salon') return;
      // Failed or stale sessions must never leak partial financial data.
      currentUser = null;
      restockItems = [];
      root.innerHTML = back() + heading('✂️🏠 Мой салон и продажи',
        'Доступ к обеим ролям должен быть подтверждён') +
        problem(error.message || 'Не удалось загрузить общий кабинет.') +
        '<button class="work-secondary" data-work-action="reload" type="button">↻ Проверить ещё раз</button>';
    }
  }
  async function chooseRole(role) {
    if (!phoneStatus().verified) { renderAll(); return; }
    if (role === 'salon') return chooseCombinedSalon();
    if (!Object.prototype.hasOwnProperty.call(CONFIG, role)) return;
    taskView = 'overview';
    chatView = '';
    chatThreadId = null;
    chatNotice = '';
    dashboardMarkup = '';
    taskData = null;
    if (taskPanel) taskPanel.reset();
    // A stale token or remembered role from another login must not expose
    // an account which is absent from this verified phone's role list.
    if (!phoneRoleAvailable(role)) { openAll(); return; }
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
    if (role === 'salon') return '<div class="work-action-bar">' +
      '<button class="work-primary" type="button" data-work-action="chat">💬 Написать менеджеру</button>' +
      '<button class="work-secondary" type="button" data-work-action="full-partner">✂️ Полный кабинет грумера</button>' +
      '<button class="work-secondary" type="button" data-work-action="full-owner">🏠 Полный кабинет владельца</button>' +
      '<button class="work-secondary" type="button" data-work-action="notifications">🔔 Настройки уведомлений</button>' +
      shortcutAction() +
      '<button class="work-secondary" type="button" data-work-action="reload">↻ Обновить показатели</button>' +
      '</div><p class="work-quiet">Продажи салона включают личные продажи грумера. Комиссии рассчитываются и выплачиваются раздельно.</p>';
    return '<div class="work-action-bar">' +
      (['partner','owner','manager'].includes(role)
        ? '<button class="work-primary" type="button" data-work-action="chat">' +
          (role === 'manager' ? '💬 Сообщения от салонов' : '💬 Написать менеджеру') +
          '</button>' : '') +
      (role === 'founder' ? '' : '<button class="work-primary" type="button" data-work-action="full" data-work-role="' + esc(role) + '">Открыть полный кабинет →</button>') +
      '<button class="work-secondary" type="button" data-work-action="notifications">🔔 Настройки уведомлений</button>' +
      shortcutAction() +
      '<button class="work-secondary" type="button" data-work-action="reload">↻ Обновить показатели</button>' +
      '</div><p class="work-quiet">' + (role === 'founder' ? 'Кабинет собственника работает отдельно от административного доступа и не позволяет изменять заказы или выплаты.' : 'Полный кабинет открывается в том же окне Telegram и использует действующие права учётной записи.') + '</p>';
  }

  function canChat(role) {
    return ['partner','owner','salon','manager'].includes(role);
  }
  function chatAccountRole() {
    // Combined groomer-owner remains two actual independently authorized
    // accounts. Use the owner's token for exactly one salon conversation.
    return activeRole === 'salon' ? 'owner' : activeRole;
  }
  function chatMessageCard(item) {
    var mine = item.author_role === chatAccountRole();
    return '<div class="work-chat-line ' + (mine ? 'mine' : 'theirs') + '">' +
      '<div class="work-chat-bubble">' +
      '<span class="work-chat-author">' + esc(mine ? 'Вы' : item.author_name) + '</span>' +
      '<p>' + esc(item.text) + '</p>' +
      '<small>' + esc(date(item.created_at)) + '</small></div></div>';
  }
  function chatConversation(data) {
    var isManager=chatAccountRole()==='manager';
    var name=isManager ? data.sender && data.sender.name : data.manager && data.manager.name;
    var salon=data.point && data.point.name || 'Салон';
    var header='<section class="work-surface work-chat-intro">' +
      '<h2>💬 ' + esc(isManager ? 'Переписка с партнёром' : 'Написать менеджеру') + '</h2>' +
      '<p class="work-note"><b>' + esc(name || 'Менеджер') + '</b> · ' + esc(salon) + '</p>' +
      '<p class="work-note">Сообщения сохраняются в ХвостМаркете. ' +
      'Telegram-уведомление отправляется при подключённом боте и разрешённых уведомлениях.</p></section>';
    var entries=Array.isArray(data.messages)?data.messages:[];
    var history='<div class="work-chat-history" aria-label="История переписки">' +
      (entries.length?entries.map(chatMessageCard).join(''):
        '<div class="work-chat-empty">Пока нет сообщений. Напишите первым 🐾</div>')+
      '</div>';
    var form='<form id="workChatForm" class="work-surface work-chat-form">' +
      '<label class="work-label" for="workChatText">Ваше сообщение</label>' +
      '<textarea class="work-chat-input" id="workChatText" rows="3" ' +
      'maxlength="1200" placeholder="Например: нужно пополнить стойку, вопрос по товару или продаже…"' +
      ' required></textarea>' +
      '<small class="work-quiet">Максимум 1200 символов. Новое сообщение можно отправить через 12 секунд.</small>' +
      '<button class="work-primary" id="workChatSubmit" type="submit">Отправить сообщение →</button>' +
      '<div id="workChatStatus" role="status"></div></form>';
    return (isManager?'<button type="button" class="work-back" data-work-action="chat-inbox">← К сообщениям салонов</button>':'') +
      header + history + form;
  }
  function chatInbox(data) {
    var threads=Array.isArray(data.threads)?data.threads:[];
    return '<section class="work-surface"><h2>💬 Сообщения от салонов</h2>' +
      '<p class="work-note">Здесь сообщения грумеров и владельцев ваших действующих точек. ' +
      'Выберите диалог, чтобы ответить.</p>' +
      (threads.length?threads.map(function(t) {
        return '<button type="button" class="work-chat-thread" data-work-action="chat-thread" '+
          'data-chat-thread-id="'+esc(t.id)+'">' +
          '<span class="work-chat-thread-name">'+esc(t.sender_name)+'</span>' +
          '<small>'+esc(t.point_name)+' · '+esc(t.sender_role==='owner'?'Владелец':'Грумер')+'</small>' +
          '<span class="work-chat-snippet">'+esc(t.last_text)+'</span>' +
          (t.unread?'<b class="work-chat-unread">'+esc(t.unread)+' новых</b>':'') +
          '</button>';
      }).join(''):'<p class="work-chat-empty">От партнёров пока нет сообщений 🐾</p>')+
      '</section>';
  }
  async function openChat(threadId) {
    if (!canChat(activeRole) || !getToken(chatAccountRole())) return;
    var mySerial=serial,role=activeRole;
    chatView='loading';
    chatThreadId=(role==='manager'&&threadId!=null)?Number(threadId):null;
    root.innerHTML=dashboardHeader(role) +
      '<button type="button" class="work-back" data-work-action="chat-back">← В кабинет</button>' +
      '<div class="work-surface">Загружаем переписку…</div>';
    try {
      var url='/api/miniapp/manager-messages' +
        (chatThreadId!=null?'?thread_id='+encodeURIComponent(chatThreadId):'');
      var data=await fetchJSON(url,getToken(chatAccountRole()));
      if (mySerial!==serial||role!==activeRole||!chatView) return;
      chatView=data.kind==='manager'?'inbox':'thread';
      root.innerHTML=dashboardHeader(role) +
        '<button type="button" class="work-back" data-work-action="chat-back">← В кабинет</button>' +
        (chatNotice?note(chatNotice):'') +
        (data.kind==='manager'?chatInbox(data):chatConversation(data)) +
        '<button class="work-secondary work-chat-reload" type="button" data-work-action="chat-refresh">↻ Обновить переписку</button>';
    } catch(error) {
      if (mySerial!==serial||role!==activeRole||!chatView)return;
      chatView='error';
      root.innerHTML=dashboardHeader(role) +
        '<button type="button" class="work-back" data-work-action="chat-back">← В кабинет</button>' +
        problem(error.message) +
        '<button class="work-secondary" type="button" data-work-action="chat-refresh">Повторить загрузку</button>';
    }
  }
  async function sendChat() {
    if (!canChat(activeRole) || chatView!=='thread') return;
    var role=activeRole, mySerial=serial, threadId=chatThreadId;
    var field=document.getElementById('workChatText');
    var submit=document.getElementById('workChatSubmit');
    var status=document.getElementById('workChatStatus');
    if (!field||!submit||!status) return;
    var text=String(field.value||'').trim();
    if(!text||text.length>1200) {
      status.innerHTML=problem('Введите сообщение длиной от 1 до 1200 символов.');
      return;
    }
    submit.disabled=true;
    status.innerHTML='';
    try {
      var body={text:text};
      if(chatAccountRole()==='manager')body.thread_id=threadId;
      var result=await fetchJSON('/api/miniapp/manager-messages',getToken(chatAccountRole()),{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      });
      if (mySerial!==serial||role!==activeRole||chatView!=='thread') return;
      chatNotice=result.notified ?
        'Сообщение сохранено и уведомление в Telegram отправлено.' :
        'Сообщение сохранено. Адресат увидит его в кабинете; Telegram-уведомление не доставлено.';
      await openChat(threadId);
    } catch(error) {
      if (mySerial!==serial||role!==activeRole||chatView!=='thread')return;
      submit.disabled=false;
      status.innerHTML=problem(error.message);
    }
  }

  function dataOrWarning(settled, fallback) {
    if (settled.status === 'fulfilled') return settled.value;
    return fallback;
  }
  function renderMiniTaskView() {
    if (!taskPanel || !taskData || !['founder','manager'].includes(activeRole)) return;
    root.innerHTML = dashboardHeader(activeRole) +
      taskPanel.navigation('tasks',taskData) +
      taskPanel.render(taskData) +
      dashboardFooter(activeRole);
  }
  async function doMiniTaskAction(button) {
    if (!taskPanel || !taskData || !['founder','manager'].includes(activeRole) ||
        taskView !== 'tasks') return;
    var currentSerial = serial;
    var role = activeRole;
    var changed = await taskPanel.handle(button,taskData,async function(id,body){
      var token=getToken(role);
      if(!token)throw new Error('Сессия завершена. Зайдите в кабинет снова.');
      return fetchJSON('/api/miniapp/tasks/'+encodeURIComponent(id),token,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
      });
    },renderMiniTaskView);
    if (changed && currentSerial === serial && role === activeRole &&
        taskView === 'tasks') {
      try {
        taskData=await fetchJSON('/api/miniapp/tasks',getToken(role));
        if (currentSerial === serial && role === activeRole) renderMiniTaskView();
      } catch(error) {
        if (error.status===401) {clearToken(role);return renderLogin('Сессия истекла. Войдите ещё раз.');}
        taskPanel.setMessage('Изменение сохранено. Обновите страницу для просмотра последних данных.');
        if (currentSerial === serial) renderMiniTaskView();
      }
    }
  }
  async function loadDashboard(role, mySerial, token) {
    renderLoading('Получаем актуальную статистику…');
    var endpoints = {
      partner: ['/api/partners/me/orders?days=30', '/api/partners/me/payouts?limit=10', '/api/partners/me/stock'],
      manager: ['/api/managers/me/orders?days=30&limit=200', '/api/managers/me/stock'],
      owner: ['/api/owner/dashboard'],
      founder: ['/api/business-founder/dashboard?period=' + (window.HvostBusinessFounder ? window.HvostBusinessFounder.getPeriod() : '30d')],
      admin: ['/api/points', '/api/orders?limit=100', '/api/operations-center'].concat(currentUser && currentUser.role === 'super' ? ['/api/business-founders'] : []),
    };
    try {
      var normalCalls=endpoints[role].map(function(url) { return fetchJSON(url, token); });
      var wantsTasks=!!(taskPanel && (role==='founder'||role==='manager'));
      if (wantsTasks) normalCalls.push(fetchJSON('/api/miniapp/tasks',token));
      var results = await Promise.allSettled(normalCalls);
      if (mySerial !== serial || role !== activeRole) return;
      var taskResponse=wantsTasks ? results.pop() : null;
      taskData=taskResponse && taskResponse.status==='fulfilled' &&
        taskResponse.value && taskResponse.value.actor ? taskResponse.value : null;
      var authFailure = results.find(function(r) { return r.status === 'rejected' && (r.reason.status === 401 || r.reason.status === 403); });
      if (authFailure) { clearToken(role); currentUser = null; return renderLogin('Сессия истекла. Войдите ещё раз.'); }
      var anyFailed = results.some(function(r) { return r.status === 'rejected'; });
      var data = results.map(function(r) { return dataOrWarning(r, null); });
      var html = dashboardHeader(role);
      if (taskData && taskPanel) {
        html += taskPanel.navigation('overview',taskData) + taskPanel.overviewCard(taskData);
      }
      if (anyFailed) html += problem('Часть данных временно недоступна. Можно обновить страницу или открыть полный кабинет.');
      if (role === 'partner') html += partnerDashboard(data);
      if (role === 'manager') html += managerDashboard(data);
      if (role === 'owner') html += ownerDashboard(data);
      if (role === 'founder' && window.HvostBusinessFounder) html += window.HvostBusinessFounder.render(data[0]);
      if (role === 'admin') html += adminDashboard(data);
      dashboardMarkup = html + dashboardFooter(role);
      root.innerHTML = dashboardMarkup;
      if (role === 'admin' && currentUser && currentUser.role === 'super' && window.HvostBusinessFounderAdmin) window.HvostBusinessFounderAdmin.populate();
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
    if (currentUser && currentUser.role === 'super' && window.HvostBusinessFounderAdmin) {
      html += window.HvostBusinessFounderAdmin.render(data[3]);
    }
    return html;
  }
  async function sendRestock() {
    if ((activeRole !== 'partner' && activeRole !== 'salon') || !currentUser) return;
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
    if (!token) { status.innerHTML = problem('Сессия грумера завершена. Обновите кабинет.'); return; }
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
      if (e.status === 401 || e.status === 403) {
        clearToken('partner');
        if (activeRole === 'salon') return chooseCombinedSalon();
        return renderLogin('Сессия истекла.');
      }
      status.innerHTML = problem(e.message);
    } finally { button.disabled = false; }
  }
  function openFullCabinet(role) {
    if (!CONFIG[role] || !getToken(role)) return renderLogin('Для перехода сначала войдите в кабинет.');
    try { sessionStorage.setItem('hm_miniapp_return_to_work', '1'); } catch (_) {}
    window.location.assign(CONFIG[role].full + '?from=miniapp');
  }
  function openNotificationSettings() {
    if (!activeRole || !currentUser || !window.HvostNotificationSettings) return;
    var selectedRole = activeRole;
    var roles = selectedRole === 'salon' ? ['partner','owner'] : [selectedRole];
    var tokens = {};
    roles.forEach(function(role) { tokens[role] = getToken(role); });
    window.HvostNotificationSettings.open({
      root:root, roles:roles, tokens:tokens,
      back:function() { chooseRole(selectedRole); },
    });
  }
  root.addEventListener('click', function(e) {
    var taskButton = e.target.closest('[data-mini-task-action]');
    if (taskButton && taskButton.dataset.miniTaskAction) return doMiniTaskAction(taskButton);
    var choosePeriod = e.target.closest('[data-founder-period]');
    if (choosePeriod && activeRole === 'founder' && window.HvostBusinessFounder) {
      window.HvostBusinessFounder.setPeriod(choosePeriod.dataset.founderPeriod);
      return chooseRole(activeRole);
    }
    var button = e.target.closest('[data-work-action]');
    if (!button) return;
    var action = button.dataset.workAction;
    if (action === 'all') return openAll();
    if (action === 'role') return chooseRole(button.dataset.workRole);
    if (action === 'logout') { var role = activeRole;
      if (role === 'salon') { clearToken('partner'); clearToken('owner'); return openAll(); }
      clearToken(role); currentUser = null; serial++; return renderLogin(); }
    if (action === 'share-phone' && identity) return identity.requestContact().then(function() {
      if (activeRole) chooseRole(activeRole);
      else renderAll();
    });
    if (action === 'check-phone' && identity) return identity.refresh().then(function() {
      if (activeRole) chooseRole(activeRole);
      else renderAll();
    });
    if (action === 'phone-login' && activeRole) return chooseRole(activeRole);
    if (action === 'go-profile' && window.HvostMiniAppGoProfile) return window.HvostMiniAppGoProfile();
    if (action === 'owner-setup') return chooseRole('admin');
    if (action === 'work-tasks' && taskPanel && taskData) {
      taskView = 'tasks';
      return renderMiniTaskView();
    }
    if (action === 'work-overview' && dashboardMarkup) {
      taskView = 'overview';
      root.innerHTML = dashboardMarkup;
      return;
    }
    if (action === 'chat' && canChat(activeRole)) {
      chatNotice='';
      return openChat(null);
    }
    if (action === 'chat-thread' && activeRole === 'manager') {
      chatNotice='';
      return openChat(button.dataset.chatThreadId);
    }
    if (action === 'chat-inbox' && activeRole === 'manager') {
      chatNotice='';
      return openChat(null);
    }
    if (action === 'chat-back' && canChat(activeRole)) {
      chatView='';
      chatNotice='';
      return chooseRole(activeRole);
    }
    if (action === 'chat-refresh' && canChat(activeRole)) return openChat(chatThreadId);
    if (action === 'notifications') return openNotificationSettings();
    if (action === 'reload') return chooseRole(activeRole);
    if (action === 'full-partner' && activeRole === 'salon') return openFullCabinet('partner');
    if (action === 'full-owner' && activeRole === 'salon') return openFullCabinet('owner');
    if (action === 'full') return openFullCabinet(activeRole);
  });
  root.addEventListener('submit', function(e) {
    if (e.target.id === 'workLoginForm') { e.preventDefault(); login(); }
    if (e.target.id === 'workRestockForm') { e.preventDefault(); sendRestock(); }
    if (e.target.id === 'workChatForm') { e.preventDefault(); sendChat(); }
  });
  if (identity) identity.onChange(function(state) {
    if (!state.verified || (activeRole === 'salon' && !state.combinedSalon)) return openAll();
    if (!activeRole) return renderAll();
    if (root.innerHTML.includes('workLoginForm') && state.verified &&
        state.accounts.some(function(a) { return a.role === activeRole; })) {
      chooseRole(activeRole);
    }
  });

  window.HvostMiniAppWork = {
    render: function() {
      if (!phoneStatus().verified) return renderAll();
      var preferred = phoneStatus().preferredRole;
      // The signed server preference wins over stale localStorage, which
      // may belong to an older chat WebView or even an earlier login.
      if (preferred && preferred !== 'shop' && preferred !== 'customer' &&
          phoneRoleAvailable(preferred)) return chooseRole(preferred);
      // The caller may request the work area even if shop was the last
      // destination. Never automatically open an unrelated privileged role.
      if (preferred === 'shop' || preferred === 'customer') {
        activeRole = '';
        return renderAll();
      }
      if (phoneRoleAvailable('salon') &&
          (!activeRole || activeRole === 'partner' || activeRole === 'owner' || activeRole === 'salon')) {
        return chooseRole('salon');
      }
      if (!activeRole || !phoneRoleAvailable(activeRole)) return renderAll();
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
