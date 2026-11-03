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
  var managerRegistrationKind = '';
  var managerRegistrationOptions = null;
  var managerRegistrationBusy = false;
  var managerNewPointMode = '';
  var managerPointCities = null;
  var managerNewPointBusy = false;
  var managerCreatedPointId = '';
  var managerCreatedPointName = '';
  var adminRegistrationKind = '';
  var adminRegistrationOptions = null;
  var adminRegistrationMode = '';
  var adminRegistrationBusy = false;
  var adminCreatedPointId = '';
  var adminCreatedPointName = '';
  var adminCreatedManagerId = '';
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
    managerRegistrationKind = '';
    managerRegistrationOptions = null;
    managerRegistrationBusy = false;
    managerNewPointMode = '';
    managerPointCities = null;
    managerNewPointBusy = false;
    managerCreatedPointId = '';
    managerCreatedPointName = '';
    adminRegistrationKind = '';
    adminRegistrationOptions = null;
    adminRegistrationMode = '';
    adminRegistrationBusy = false;
    adminCreatedPointId = '';
    adminCreatedPointName = '';
    adminCreatedManagerId = '';
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
    managerRegistrationKind = '';
    managerRegistrationOptions = null;
    managerRegistrationBusy = false;
    managerNewPointMode = '';
    managerPointCities = null;
    managerNewPointBusy = false;
    managerCreatedPointId = '';
    managerCreatedPointName = '';
    adminRegistrationKind = '';
    adminRegistrationOptions = null;
    adminRegistrationMode = '';
    adminRegistrationBusy = false;
    adminCreatedPointId = '';
    adminCreatedPointName = '';
    adminCreatedManagerId = '';
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
      manager: ['/api/managers/me/orders?days=30&limit=200', '/api/managers/me/stock', '/api/managers/me/compensation?days=30'],
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
    var salon = currentUser.current_point;
    var pointNotice = salon ? note('📍 ' + salon.name + (salon.addr ? ' · ' + salon.addr : '')) :
      currentUser.point_unavailable ? problem('Назначенный салон закрыт или удалён. Показана только история личных продаж; пополнение недоступно.') : '';
    var html = pointNotice + '<div class="work-stats">' +
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
  // Paid sales are net of full or partial refunds. Undefined refund
  // metadata in older orders is treated as "no return", never as extra sale.
  function netPaidAmount(order) {
    if (!order || order.status !== 'paid') return 0;
    if (order.refund_status === 'refunded' && order.refunded_amount == null) return 0;
    return Math.max(0, Number(order.total || 0) - Number(order.refunded_amount || 0));
  }
  // Registration stays inside the Telegram Mini App; both actions are bound
  // to the already authenticated manager role and scoped by the server.
  function registrationPointChoices() {
    if (!managerRegistrationOptions) return [];
    return managerRegistrationKind === 'owner'
      ? managerRegistrationOptions.owner_points || []
      : managerRegistrationOptions.groomer_points || [];
  }
  function registrationOptionsHtml(points) {
    return '<option value="">— Выберите минимаркет —</option>' +
      points.map(function(p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) +
          (p.addr ? ' · ' + esc(p.addr) : '') + '</option>';
      }).join('');
  }
  function groomersOnPoint(pointId) {
    return managerRegistrationOptions && (managerRegistrationOptions.groomers || []).filter(function(g) {
      return String(g.point_id) === String(pointId);
    }) || [];
  }
  function updateOwnerGroomerChoices() {
    if (managerRegistrationKind !== 'owner') return;
    var point = document.getElementById('workRegPoint');
    var linked = document.getElementById('workRegLinkedGroomer');
    if (!point || !linked) return;
    linked.innerHTML = '<option value="">Не связывать с карточкой грумера</option>' +
      groomersOnPoint(point.value).map(function(g) {
        return '<option value="' + esc(g.id) + '">' + esc(g.full_name) + '</option>';
      }).join('');
  }
  // Create a real point through the same server endpoint as the full
  // manager cabinet; no local "fake" points or direct manager_id input.
  function managerNewPointAuthorized() {
    return activeRole === 'manager' && !!currentUser &&
      phoneRoleAvailable('manager') && !!getToken('manager');
  }
  function renderManagerNewPoint() {
    if (!managerNewPointAuthorized() || !managerNewPointMode) return;
    var title = dashboardHeader('manager') +
      '<button type="button" class="work-back" data-work-action="manager-point-back">← В кабинет менеджера</button>';
    if (managerNewPointMode === 'complete') {
      root.innerHTML = title + heading('✅ Минимаркет создан', 'Новая точка зарегистрирована в ХвостМаркет.') +
        note('📍 «' + managerCreatedPointName + '» закреплён за вами. Теперь вы можете добавить грумеров и владельца салона.') +
        '<div class="work-action-bar">' +
        '<button type="button" class="work-primary" data-work-action="manager-point-groomer">✂️ Добавить грумера</button>' +
        '<button type="button" class="work-secondary" data-work-action="manager-point-owner">🏠 Добавить владельца</button>' +
        '<button type="button" class="work-secondary" data-work-action="manager-point-back">↻ К моим точкам</button></div>';
      return;
    }
    if (!managerPointCities || !managerPointCities.length) {
      root.innerHTML = title + problem('Не удалось получить города сети. Обновите список.') +
        '<button type="button" class="work-secondary" data-work-action="manager-point-retry">↻ Загрузить города</button>';
      return;
    }
    var cityOptions = managerPointCities.map(function(city) {
      return '<option value="' + esc(city.id) + '">' + esc(city.name) + '</option>';
    }).join('');
    root.innerHTML = title + heading('📍 Новый минимаркет', 'Заполните данные салона. Проверим адрес на карте перед созданием.') +
      surface('Новая точка',
        '<form id="workManagerNewPointForm" class="work-register-form">' +
        '<label class="work-register-label" for="workPointName">Название салона *</label>' +
        '<input class="work-register-input" id="workPointName" type="text" maxlength="120" required placeholder="Например, Барсик">' +
        '<label class="work-register-label" for="workPointCity">Город *</label>' +
        '<select class="work-register-input" id="workPointCity" required>' +
        '<option value="">— Выберите город —</option>' + cityOptions + '</select>' +
        '<label class="work-register-label" for="workPointAddr">Улица и номер дома *</label>' +
        '<input class="work-register-input" id="workPointAddr" type="text" maxlength="240" required placeholder="ул. Молокова, 40">' +
        '<label class="work-register-label" for="workPointIcon">Значок точки (необязательно)</label>' +
        '<input class="work-register-input" id="workPointIcon" type="text" maxlength="8" placeholder="📍" autocomplete="off">' +
        '<p class="work-note">Адрес автоматически проверяется на карте. При ошибке точка не создаётся. Новая точка появится с нулевыми остатками.</p>' +
        '<div id="workPointStatus" role="status" aria-live="polite"></div>' +
        '<button type="submit" class="work-primary" id="workPointSubmit">➕ Создать минимаркет</button>' +
        '</form>');
    var preferredCity = String(currentUser.city_id || '');
    if (managerPointCities.some(function(city) { return String(city.id) === preferredCity; })) {
      document.getElementById('workPointCity').value = preferredCity;
    }
  }
  async function openManagerNewPoint() {
    if (!managerNewPointAuthorized()) return;
    managerNewPointMode = 'form';
    managerNewPointBusy = false;
    managerCreatedPointId = '';
    managerCreatedPointName = '';
    var mySerial = serial;
    root.innerHTML = dashboardHeader('manager') + note('Загружаем города сети…');
    try {
      var result = await fetchJSON('/api/cities', getToken('manager'));
      if (mySerial !== serial || !managerNewPointAuthorized() || managerNewPointMode !== 'form') return;
      managerPointCities = (result.cities || []).filter(function(city) {
        return city && city.id && city.name;
      });
      renderManagerNewPoint();
    } catch (e) {
      if (mySerial !== serial || !managerNewPointAuthorized() || managerNewPointMode !== 'form') return;
      if (e.status === 401) {
        clearToken('manager');
        managerNewPointMode = '';
        return renderLogin('Сессия менеджера завершена. Войдите снова.');
      }
      managerPointCities = null;
      renderManagerNewPoint();
    }
  }
  function managerPointError(message) {
    var el = document.getElementById('workPointStatus');
    if (el) el.innerHTML = problem(message);
  }
  async function submitManagerNewPoint() {
    if (!managerNewPointAuthorized() || managerNewPointMode !== 'form' ||
        managerNewPointBusy || !managerPointCities) return;
    var get = function(id) { return document.getElementById(id); };
    var name = String(get('workPointName').value || '').trim().replace(/\s+/g, ' ');
    var addr = String(get('workPointAddr').value || '').trim().replace(/\s+/g, ' ');
    var cityId = String(get('workPointCity').value || '');
    var icon = String(get('workPointIcon').value || '').trim();
    if (name.length < 2 || name.length > 120 || addr.length < 5 || addr.length > 240) {
      return managerPointError('Введите название (2–120 символов) и точный адрес с номером дома.');
    }
    if (!managerPointCities.some(function(city) { return String(city.id) === cityId; })) {
      return managerPointError('Выберите город из списка ХвостМаркета.');
    }
    if (icon.length > 8) return managerPointError('Значок должен быть коротким.');
    managerNewPointBusy = true;
    var button = get('workPointSubmit');
    var status = get('workPointStatus');
    button.disabled = true;
    status.innerHTML = note('Проверяем адрес и добавляем минимаркет на карту…');
    var mySerial = serial;
    try {
      var point = await fetchJSON('/api/points', getToken('manager'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, addr: addr, city_id: cityId, icon: icon || '📍' }),
      });
      if (mySerial !== serial || !managerNewPointAuthorized() || managerNewPointMode !== 'form') return;
      managerCreatedPointId = String(point.id || '');
      if (!managerCreatedPointId) throw new Error('Сервер не вернул идентификатор созданной точки.');
      managerCreatedPointName = name;
      managerNewPointMode = 'complete';
      renderManagerNewPoint();
    } catch (e) {
      if (mySerial !== serial || !managerNewPointAuthorized() || managerNewPointMode !== 'form') return;
      if (e.status === 401) {
        clearToken('manager');
        managerNewPointMode = '';
        return renderLogin('Сессия менеджера завершена. Войдите снова.');
      }
      managerPointError(e.message || 'Не удалось создать минимаркет.');
      button.disabled = false;
    } finally {
      managerNewPointBusy = false;
    }
  }
  function renderManagerRegistration() {
    if (activeRole !== 'manager' || !currentUser || !managerRegistrationKind ||
        !phoneRoleAvailable('manager') || !getToken('manager')) return;
    var isOwner = managerRegistrationKind === 'owner';
    var title = isOwner ? '🏠 Новый владелец салона' : '✂️ Новый грумер';
    var html = dashboardHeader('manager') +
      '<button type="button" class="work-back" data-work-action="manager-reg-back">← В кабинет менеджера</button>' +
      heading(title, 'Регистрация на одном из закреплённых за вами действующих минимаркетов.');
    if (!managerRegistrationOptions) {
      root.innerHTML = html + problem('Не удалось получить список доступных точек. Повторите загрузку.') +
        '<button type="button" class="work-secondary" data-work-action="manager-reg-retry">↻ Повторить</button>';
      return;
    }
    var points = registrationPointChoices();
    if (!points.length) {
      root.innerHTML = html + note(isOwner
        ? 'На ваших действующих точках уже есть владельцы или нет доступных минимаркетов.'
        : 'У вас пока нет действующих минимаркетов. Создайте новый прямо здесь.') +
        '<div class="work-action-bar">' +
        '<button type="button" class="work-primary" data-work-action="manager-point-new">➕ Добавить минимаркет</button>' +
        '<button type="button" class="work-secondary" data-work-action="manager-reg-back">Вернуться</button></div>';
      return;
    }
    var ownerLink = isOwner
      ? '<label class="work-register-label" for="workRegLinkedGroomer">Если владелец также грумер</label>' +
        '<select class="work-register-input" id="workRegLinkedGroomer">' +
        '<option value="">Не связывать с карточкой грумера</option></select>' +
        '<p class="work-note">Выбирайте только карточку этого же человека на выбранной точке. Тогда кабинет грумера и владельца объединится.</p>'
      : '<label class="work-register-label" for="workRegReferral">Код пригласившего (необязательно)</label>' +
        '<input class="work-register-input" id="workRegReferral" type="text" autocomplete="off" maxlength="60" placeholder="GR-001 / OWN-001">';
    root.innerHTML = html +
      surface('Данные нового партнёра',
        '<form id="workManagerRegisterForm" class="work-register-form">' +
        '<label class="work-register-label" for="workRegPoint">Минимаркет *</label>' +
        '<select class="work-register-input" id="workRegPoint" required>' +
        registrationOptionsHtml(points) + '</select>' +
        '<label class="work-register-label" for="workRegName">Фамилия, имя *</label>' +
        '<input class="work-register-input" id="workRegName" type="text" autocomplete="name" maxlength="120" required placeholder="Фамилия Имя">' +
        '<label class="work-register-label" for="workRegPhone">Телефон *</label>' +
        '<input class="work-register-input" id="workRegPhone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+7 999 123-45-67">' +
        '<label class="work-register-label" for="workRegLogin">Логин *</label>' +
        '<input class="work-register-input" id="workRegLogin" type="text" autocomplete="off" maxlength="80" required placeholder="Логин для полного кабинета">' +
        '<label class="work-register-label" for="workRegPassword">Пароль *</label>' +
        '<input class="work-register-input" id="workRegPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required placeholder="Не менее 6 символов">' +
        ownerLink +
        '<label class="work-register-consent"><input type="checkbox" id="workRegConsent" required>' +
        '<span>Подтверждаю, что человек дал согласие на обработку персональных данных для регистрации в ХвостМаркет.</span></label>' +
        '<div id="workRegStatus" role="status" aria-live="polite"></div>' +
        '<button type="submit" id="workRegSubmit" class="work-primary">' +
        (isOwner ? 'Зарегистрировать владельца' : 'Зарегистрировать грумера') +
        '</button></form>') +
      '<p class="work-quiet">После регистрации новый пользователь может войти в Telegram Mini App по подтверждённому номеру телефона.</p>';
    if (managerCreatedPointId && points.some(function(p) { return String(p.id) === managerCreatedPointId; })) {
      var selectedPoint = document.getElementById('workRegPoint');
      if (selectedPoint) selectedPoint.value = managerCreatedPointId;
      if (isOwner) updateOwnerGroomerChoices();
    }
  }
  async function openManagerRegistration(kind) {
    if (activeRole !== 'manager' || !currentUser || !phoneRoleAvailable('manager') ||
        !getToken('manager') || !['owner', 'groomer'].includes(kind)) return;
    managerRegistrationKind = kind;
    managerRegistrationOptions = null;
    managerRegistrationBusy = false;
    var mySerial = serial;
    root.innerHTML = dashboardHeader('manager') + note('Загружаем доступные минимаркеты…');
    try {
      var data = await fetchJSON('/api/managers/me/registration-options', getToken('manager'));
      if (mySerial !== serial || activeRole !== 'manager' || managerRegistrationKind !== kind) return;
      managerRegistrationOptions = data;
      renderManagerRegistration();
    } catch (e) {
      if (mySerial !== serial || activeRole !== 'manager' || managerRegistrationKind !== kind) return;
      if (e.status === 401 || e.status === 403) {
        clearToken('manager');
        managerRegistrationKind = '';
        return renderLogin('Сессия менеджера завершена. Войдите снова.');
      }
      renderManagerRegistration();
    }
  }
  function managerRegistrationError(message) {
    var status = document.getElementById('workRegStatus');
    if (status) status.innerHTML = problem(message);
  }
  async function submitManagerRegistration() {
    if (activeRole !== 'manager' || !currentUser || !phoneRoleAvailable('manager') ||
        !managerRegistrationOptions || managerRegistrationBusy || !getToken('manager')) return;
    var kind = managerRegistrationKind;
    if (!['owner', 'groomer'].includes(kind)) return;
    var get = function(id) { return document.getElementById(id); };
    var pointId = String(get('workRegPoint').value || '');
    var name = String(get('workRegName').value || '').trim();
    var phone = String(get('workRegPhone').value || '').trim();
    var loginName = String(get('workRegLogin').value || '').trim();
    var password = String(get('workRegPassword').value || '');
    var digits = phone.replace(/\D/g, '');
    if (!registrationPointChoices().some(function(p) { return String(p.id) === pointId; })) {
      return managerRegistrationError('Выберите действующий минимаркет из списка.');
    }
    if (name.length < 3 || name.length > 120 || loginName.length < 3 || !password || password.length < 6) {
      return managerRegistrationError('Укажите ФИО, логин от 3 символов и пароль не короче 6 символов.');
    }
    if (!(digits.length === 10 || (digits.length === 11 && /^[78]/.test(digits)))) {
      return managerRegistrationError('Проверьте телефон: нужен российский номер из 10 или 11 цифр.');
    }
    if (!get('workRegConsent').checked) {
      return managerRegistrationError('Нужно получить согласие человека на обработку персональных данных.');
    }
    var body = { point_id: pointId, full_name: name, phone: phone,
      login: loginName, password: password };
    if (kind === 'owner') {
      var groomerId = get('workRegLinkedGroomer').value;
      if (groomerId) {
        if (!groomersOnPoint(pointId).some(function(g) { return String(g.id) === String(groomerId); })) {
          return managerRegistrationError('Выбранный грумер не относится к этому минимаркету.');
        }
        body.groomer_partner_id = Number(groomerId);
      }
    } else {
      body.personal_data_consent = true;
      var referral = String(get('workRegReferral').value || '').trim();
      if (referral) body.referral_code = referral;
    }
    managerRegistrationBusy = true;
    var button = get('workRegSubmit');
    button.disabled = true;
    var mySerial = serial;
    var status = get('workRegStatus');
    status.innerHTML = note('Регистрируем пользователя…');
    try {
      var result = await fetchJSON(
        kind === 'owner' ? '/api/salon-owners' : '/api/managers/me/register-groomer',
        getToken('manager'), { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (mySerial !== serial || activeRole !== 'manager' || managerRegistrationKind !== kind) return;
      // Do not re-display passwords or personal phone data after registration.
      var code = result.owner_code || result.partner_code || '';
      root.innerHTML = dashboardHeader('manager') +
        note('✅ ' + (kind === 'owner' ? 'Владелец' : 'Грумер') + ' «' + name +
          '» зарегистрирован' + (code ? '. Код: ' + code : '') + '.') +
        '<div class="work-action-bar">' +
        '<button type="button" class="work-primary" data-work-action="manager-reg-retry">➕ Зарегистрировать ещё</button>' +
        '<button type="button" class="work-secondary" data-work-action="manager-reg-back">← В кабинет менеджера</button></div>';
    } catch (e) {
      if (mySerial !== serial || activeRole !== 'manager' || managerRegistrationKind !== kind) return;
      if (e.status === 401 || e.status === 403 && /авторизац|сессия/i.test(e.message)) {
        clearToken('manager');
        managerRegistrationKind = '';
        return renderLogin('Сессия менеджера завершена. Войдите снова.');
      }
      managerRegistrationError(e.message);
      button.disabled = false;
    } finally {
      managerRegistrationBusy = false;
    }
  }
  function managerDashboard(data) {
    // manager.points is a legacy payout/referral ledger, not the live network.
    // Only the server-verified canonical points directory may drive this panel.
    var points = currentUser.current_points || [];
    var orders = data[0] && data[0].orders || [];
    var stockPoints = data[1] && data[1].points || [];
    var compensation = data[2] || null;
    var paid = orders.filter(function(o) { return netPaidAmount(o) > 0; });
    var revenue = paid.reduce(function(s, o) { return s + netPaidAmount(o); }, 0);
    var low = stockPoints.reduce(function(s, p) {
      return s + (p.items || []).filter(function(i) { return Number(i.qty) <= 2; }).length;
    }, 0);
    var html = '<div class="work-stats">' +
      stat('Мои точки', number(points.length), 'Закреплены за менеджером') +
      stat('Продажи за 30 дней', rub(revenue), number(paid.length) + ' оплаченных заказов') +
      stat('Ожидает выплаты', compensation ? rub(compensation.commission_unpaid) : '—', 'Только невыплаченная комиссия') +
      stat('Бонусы к выплате', compensation ? rub(compensation.launch_bonus_unpaid) : '—', 'Начислены, но не перечислены') +
      stat('Начислено за 30 дней', compensation ? rub(compensation.period_residual) : '—',
        'За период, включая уже оплаченные начисления') + '</div>';
    html += surface('📍 Новые минимаркеты',
      '<button type="button" class="work-primary" data-work-action="manager-point-new">➕ Добавить минимаркет</button>' +
      '<p class="work-note">Точка автоматически закрепится за вами, появится на карте и будет доступна для регистрации сотрудников.</p>');
    html += surface('➕ Регистрация сотрудников',
      '<div class="work-register-actions">' +
      '<button class="work-primary" type="button" data-work-action="manager-reg-groomer">✂️ Добавить грумера</button>' +
      '<button class="work-secondary" type="button" data-work-action="manager-reg-owner">🏠 Добавить владельца салона</button>' +
      '</div><p class="work-note">Выберите свой действующий минимаркет. Регистрация откроет новый кабинет по номеру телефона.</p>');
    html += surface('Мои минимаркеты', rows(points.map(function(p) {
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
  // Admin registrations use only active administrator credentials. The
  // server independently validates every selected salon and role.
  function adminRegisterAuthorized() {
    return activeRole === 'admin' && !!currentUser &&
      phoneRoleAvailable('admin') && !!getToken('admin');
  }
  function adminRegistrationChoicesHtml(items, blank) {
    return '<option value="">' + esc(blank || '— Выберите —') + '</option>' +
      (items || []).map(function(item) {
        return '<option value="' + esc(item.id) + '">' + esc(item.name || item.full_name) +
          (item.addr ? ' · ' + esc(item.addr) : '') + '</option>';
      }).join('');
  }
  function adminGroomersForPoint(pointId) {
    return ((adminRegistrationOptions && adminRegistrationOptions.groomers) || []).filter(function(g) {
      return String(g.point_id) === String(pointId);
    });
  }
  function updateAdminOwnerGroomerChoices() {
    if (adminRegistrationKind !== 'owner' || !adminRegisterAuthorized()) return;
    var pointField = document.getElementById('workAdminPersonPoint');
    var select = document.getElementById('workAdminPersonGroomer');
    if (!pointField || !select) return;
    select.innerHTML = adminRegistrationChoicesHtml(
      adminGroomersForPoint(pointField.value), 'Не связывать с карточкой грумера');
  }
  function renderAdminRegistration() {
    if (!adminRegisterAuthorized() || !adminRegistrationKind) return;
    var kind = adminRegistrationKind;
    var captions = {
      point: '📍 Новый минимаркет',
      owner: '🏠 Новый владелец салона',
      manager: '👤 Новый менеджер',
      groomer: '✂️ Новый грумер',
    };
    var top = dashboardHeader('admin') +
      '<button class="work-back" type="button" data-work-action="admin-reg-back">← В кабинет администратора</button>';
    if (adminRegistrationMode === 'complete') {
      var message = kind === 'point'
        ? 'Минимаркет «' + esc(adminCreatedPointName) +
          '» создан. Можно сразу зарегистрировать владельца и грумеров.'
        : 'Новый пользователь зарегистрирован. Ему доступен вход по подтверждённому номеру телефона.';
      var actions = kind === 'point'
        ? '<button class="work-primary" type="button" data-work-action="admin-reg-groomer">✂️ Добавить грумера</button>' +
          '<button class="work-secondary" type="button" data-work-action="admin-reg-owner">🏠 Добавить владельца</button>'
        : '';
      root.innerHTML = top + heading('✅ Регистрация выполнена', message) +
        '<div class="work-action-bar">' + actions +
        '<button class="work-secondary" type="button" data-work-action="admin-reg-repeat">➕ Зарегистрировать ещё</button>' +
        '<button class="work-secondary" type="button" data-work-action="admin-reg-back">← В кабинет администратора</button></div>';
      return;
    }
    if (!adminRegistrationOptions) {
      root.innerHTML = top + problem('Не удалось получить актуальные точки и города. Повторите загрузку.') +
        '<button type="button" class="work-secondary" data-work-action="admin-reg-retry">↻ Повторить</button>';
      return;
    }
    var options = adminRegistrationOptions;
    var cities = options.cities || [];
    var points = kind === 'owner' ? options.owner_points || [] : options.points || [];
    if ((kind === 'point' || kind === 'manager') && !cities.length) {
      root.innerHTML = top + problem('Нет доступных городов. Добавьте город через полную админку.') +
        '<button type="button" class="work-secondary" data-work-action="admin-reg-back">Назад</button>';
      return;
    }
    if ((kind === 'owner' || kind === 'groomer') && !points.length) {
      root.innerHTML = top + note('Нет подходящих действующих минимаркетов. Сначала создайте точку.') +
        '<button class="work-primary" type="button" data-work-action="admin-reg-point">➕ Добавить минимаркет</button>';
      return;
    }
    var cityHtml = adminRegistrationChoicesHtml(cities, '— Выберите город —');
    var form = '';
    if (kind === 'point') {
      form = '<label class="work-register-label" for="workAdminPointName">Название салона *</label>' +
        '<input class="work-register-input" id="workAdminPointName" type="text" maxlength="120" required placeholder="Название">' +
        '<label class="work-register-label" for="workAdminPointCity">Город *</label>' +
        '<select class="work-register-input" id="workAdminPointCity" required>' + cityHtml + '</select>' +
        '<label class="work-register-label" for="workAdminPointAddr">Улица, номер дома *</label>' +
        '<input class="work-register-input" id="workAdminPointAddr" type="text" maxlength="240" required placeholder="ул. Молокова, 40">' +
        '<label class="work-register-label" for="workAdminPointManager">Ответственный менеджер</label>' +
        '<select class="work-register-input" id="workAdminPointManager">' +
        adminRegistrationChoicesHtml(options.managers || [], 'Пока не назначен') +
        '</select>' +
        '<label class="work-register-label" for="workAdminPointIcon">Значок (необязательно)</label>' +
        '<input class="work-register-input" id="workAdminPointIcon" type="text" maxlength="8" placeholder="📍">' +
        '<p class="work-note">Точка будет добавлена на карту после проверки адреса. Начальные остатки — 0. Менеджера можно выбрать сейчас.</p>';
    } else {
      if (kind === 'manager') {
        form = '<label class="work-register-label" for="workAdminPersonCity">Город работы *</label>' +
          '<select class="work-register-input" id="workAdminPersonCity" required>' + cityHtml + '</select>';
      } else {
        form = '<label class="work-register-label" for="workAdminPersonPoint">Минимаркет *</label>' +
          '<select class="work-register-input" id="workAdminPersonPoint" required>' +
          adminRegistrationChoicesHtml(points, '— Выберите минимаркет —') + '</select>';
      }
      form += '<label class="work-register-label" for="workAdminPersonName">Фамилия и имя *</label>' +
        '<input class="work-register-input" id="workAdminPersonName" type="text" maxlength="120" required placeholder="Фамилия Имя">' +
        '<label class="work-register-label" for="workAdminPersonPhone">Телефон *</label>' +
        '<input class="work-register-input" id="workAdminPersonPhone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+7 999 123-45-67">' +
        '<label class="work-register-label" for="workAdminPersonLogin">Логин *</label>' +
        '<input class="work-register-input" id="workAdminPersonLogin" type="text" maxlength="80" required placeholder="Логин для полного кабинета">' +
        '<label class="work-register-label" for="workAdminPersonPassword">Пароль *</label>' +
        '<input class="work-register-input" id="workAdminPersonPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required placeholder="От 6 символов">';
      if (kind === 'manager') {
        form += '<label class="work-register-label" for="workAdminPersonEmail">Электронная почта (необязательно)</label>' +
          '<input class="work-register-input" id="workAdminPersonEmail" type="email" maxlength="120" placeholder="name@example.ru">';
      } else if (kind === 'owner') {
        form += '<label class="work-register-label" for="workAdminPersonGroomer">Если владелец также грумер</label>' +
          '<select class="work-register-input" id="workAdminPersonGroomer">' +
          '<option value="">Не связывать с грумером</option></select>' +
          '<p class="work-note">Для объединения кабинетов выбирайте карточку этого же человека на той же точке с тем же номером телефона.</p>';
      } else {
        form += '<label class="work-register-label" for="workAdminPersonReferral">Код пригласившего (необязательно)</label>' +
          '<input class="work-register-input" id="workAdminPersonReferral" type="text" maxlength="60" placeholder="GR-001 / OWN-001">';
      }
      form += '<label class="work-register-consent"><input id="workAdminConsent" type="checkbox" required>' +
        '<span>Подтверждаю согласие человека на обработку персональных данных для регистрации в ХвостМаркет.</span></label>';
    }
    root.innerHTML = top + heading(captions[kind], 'Регистрация в действующей базе ХвостМаркета.') +
      surface('Данные регистрации',
        '<form id="workAdminRegistrationForm" class="work-register-form">' + form +
        '<div id="workAdminRegStatus" role="status" aria-live="polite"></div>' +
        '<button class="work-primary" type="submit" id="workAdminRegSubmit">' +
          (kind === 'point' ? '➕ Создать минимаркет' : 'Зарегистрировать') + '</button></form>');
    if (kind === 'owner') updateAdminOwnerGroomerChoices();
    if (adminCreatedPointId && (kind === 'groomer' || kind === 'owner') &&
        points.some(function(p) { return String(p.id) === adminCreatedPointId; })) {
      document.getElementById('workAdminPersonPoint').value = adminCreatedPointId;
      if (kind === 'owner') updateAdminOwnerGroomerChoices();
    }
    if (kind === 'point' && adminCreatedManagerId &&
        (options.managers || []).some(function(m) { return String(m.id) === adminCreatedManagerId; })) {
      document.getElementById('workAdminPointManager').value = adminCreatedManagerId;
    }
  }
  async function openAdminRegistration(kind) {
    if (!adminRegisterAuthorized() || !['point','owner','manager','groomer'].includes(kind)) return;
    adminRegistrationKind = kind;
    adminRegistrationMode = 'form';
    adminRegistrationBusy = false;
    adminRegistrationOptions = null;
    var mySerial = serial;
    root.innerHTML = dashboardHeader('admin') + note('Загружаем действующие точки, города и менеджеров…');
    try {
      var options = await fetchJSON('/api/miniapp/admin/registration-options', getToken('admin'));
      if (mySerial !== serial || !adminRegisterAuthorized() ||
          adminRegistrationKind !== kind || adminRegistrationMode !== 'form') return;
      adminRegistrationOptions = options;
      renderAdminRegistration();
    } catch (err) {
      if (mySerial !== serial || !adminRegisterAuthorized() || adminRegistrationKind !== kind) return;
      if (err.status === 401) {
        clearToken('admin');
        adminRegistrationKind = '';
        return renderLogin('Сессия администратора завершена. Войдите снова.');
      }
      adminRegistrationOptions = null;
      renderAdminRegistration();
    }
  }
  function closeAdminRegistration() {
    if (!adminRegisterAuthorized()) return;
    adminRegistrationKind = '';
    adminRegistrationMode = '';
    adminRegistrationOptions = null;
    adminRegistrationBusy = false;
    // Refresh the live dashboard without logging out or discarding the newly
    // created manager/point selection within this authenticated admin session.
    return loadDashboard('admin', serial, getToken('admin'));
  }
  function adminRegistrationError(message) {
    var status = document.getElementById('workAdminRegStatus');
    if (status) status.innerHTML = problem(message);
  }
  async function submitAdminRegistration() {
    if (!adminRegisterAuthorized() || !adminRegistrationOptions ||
        adminRegistrationMode !== 'form' || adminRegistrationBusy) return;
    var kind = adminRegistrationKind;
    var opts = adminRegistrationOptions;
    var get = function(id) { return document.getElementById(id); };
    var body = {};
    var url = '';
    var name = '';
    if (kind === 'point') {
      name = String(get('workAdminPointName').value || '').trim().replace(/\s+/g,' ');
      var addr = String(get('workAdminPointAddr').value || '').trim().replace(/\s+/g,' ');
      var city = String(get('workAdminPointCity').value || '');
      var managerId = String(get('workAdminPointManager').value || '');
      var icon = String(get('workAdminPointIcon').value || '').trim();
      if (name.length < 2 || name.length > 120 || addr.length < 5 || addr.length > 240)
        return adminRegistrationError('Введите название (2–120 символов) и адрес с номером дома.');
      if (!(opts.cities || []).some(function(c) { return String(c.id) === city; }))
        return adminRegistrationError('Выберите действующий город.');
      if (managerId && !(opts.managers || []).some(function(m) { return String(m.id) === managerId; }))
        return adminRegistrationError('Выберите действующего менеджера из списка.');
      if (icon.length > 8) return adminRegistrationError('Слишком длинный значок.');
      body = { name:name, addr:addr, city_id:city, icon:icon || '📍' };
      if (managerId) body.manager_id = Number(managerId);
      url = '/api/points';
    } else {
      name = String(get('workAdminPersonName').value || '').trim();
      var phone = String(get('workAdminPersonPhone').value || '').trim();
      var login = String(get('workAdminPersonLogin').value || '').trim();
      var password = String(get('workAdminPersonPassword').value || '');
      var digits = phone.replace(/\D/g, '');
      if (name.length < 3 || name.length > 120 || login.length < 3 ||
          password.length < 6 || password.length > 128)
        return adminRegistrationError('Укажите ФИО, логин от 3 символов и пароль от 6 символов.');
      if (!(digits.length === 10 || digits.length === 11 && /^[78]/.test(digits)))
        return adminRegistrationError('Проверьте номер телефона.');
      if (!get('workAdminConsent').checked)
        return adminRegistrationError('Необходимо получить согласие человека на обработку персональных данных.');
      body = {full_name:name, phone:phone, login:login, password:password};
      if (kind === 'manager') {
        var managerCity = String(get('workAdminPersonCity').value || '');
        if (!(opts.cities || []).some(function(c) { return String(c.id) === managerCity; }))
          return adminRegistrationError('Выберите город работы менеджера.');
        body.city_id = managerCity;
        var email = String(get('workAdminPersonEmail').value || '').trim();
        if (email) body.email = email;
        url = '/api/managers';
      } else {
        var pointId = String(get('workAdminPersonPoint').value || '');
        var allowedPoints = kind === 'owner' ? opts.owner_points || [] : opts.points || [];
        if (!allowedPoints.some(function(p) { return String(p.id) === pointId; }))
          return adminRegistrationError('Выберите действующий минимаркет.');
        body.point_id = pointId;
        if (kind === 'owner') {
          var linked = String(get('workAdminPersonGroomer').value || '');
          if (linked) {
            if (!adminGroomersForPoint(pointId).some(function(g) { return String(g.id) === linked; }))
              return adminRegistrationError('Грумер не относится к выбранному минимаркету.');
            body.groomer_partner_id = Number(linked);
          }
          url = '/api/salon-owners';
        } else {
          body.personal_data_consent = true;
          var referral = String(get('workAdminPersonReferral').value || '').trim();
          if (referral) body.referral_code = referral;
          url = '/api/miniapp/admin/register-groomer';
        }
      }
    }
    adminRegistrationBusy = true;
    var button = get('workAdminRegSubmit');
    button.disabled = true;
    get('workAdminRegStatus').innerHTML = note('Сохраняем в системе ХвостМаркет…');
    var mySerial = serial;
    try {
      var result = await fetchJSON(url,getToken('admin'),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),
      });
      if (mySerial !== serial || !adminRegisterAuthorized() ||
          adminRegistrationKind !== kind || adminRegistrationMode !== 'form') return;
      if (kind === 'point') {
        if (!result.id) throw new Error('Сервер не вернул идентификатор точки. Проверьте реестр.');
        adminCreatedPointId = String(result.id);
        adminCreatedPointName = name;
      }
      if (kind === 'manager' && result.id) adminCreatedManagerId = String(result.id);
      adminRegistrationMode = 'complete';
      renderAdminRegistration();
    } catch (err) {
      if (mySerial !== serial || !adminRegisterAuthorized() ||
          adminRegistrationKind !== kind || adminRegistrationMode !== 'form') return;
      if (err.status === 401) {
        clearToken('admin');
        adminRegistrationKind = '';
        return renderLogin('Сессия администратора завершена. Войдите снова.');
      }
      adminRegistrationError(err.message || 'Не удалось сохранить запись.');
      button.disabled = false;
    } finally {
      adminRegistrationBusy = false;
    }
  }
  function adminDashboard(data) {
    var allPoints = data[0] && data[0].points || [];
    // Match the founder network counter: only current, non-hub minimarkets.
    var points = allPoints.filter(function(p) {
      return Number(p.active) !== 0 && Number(p.is_hub) !== 1;
    });
    var allOrders = data[1] && data[1].orders || [];
    var paidOrders = allOrders.filter(function(o) {
      return netPaidAmount(o) > 0;
    });
    var ops = data[2] || {};
    var issues = ops.issues || [];
    var revenue = paidOrders.reduce(function(s, o) { return s + netPaidAmount(o); }, 0);
    var html = '<div class="work-stats">' +
      stat('Активных точек', data[0] ? number(points.length) : '—', 'По всей сети') +
      stat('Последние покупки', data[1] ? number(paidOrders.length) : '—', 'Оплаченных среди 100 последних заказов') +
      stat('Выручка последних заказов', data[1] ? rub(revenue) : '—', 'Оплаченные среди 100 последних') +
      stat('Сигналы контроля', data[2] ? number((ops.summary || {}).total || issues.length) : '—', 'Операционные вопросы') +
      '</div>';
    html += surface('➕ Управление сетью',
      '<div class="work-register-actions">' +
      '<button class="work-primary" type="button" data-work-action="admin-reg-point">📍 Добавить минимаркет</button>' +
      '<button class="work-secondary" type="button" data-work-action="admin-reg-owner">🏠 Зарегистрировать владельца</button>' +
      '<button class="work-secondary" type="button" data-work-action="admin-reg-manager">👤 Зарегистрировать менеджера</button>' +
      '<button class="work-secondary" type="button" data-work-action="admin-reg-groomer">✂️ Зарегистрировать грумера</button></div>' +
      '<p class="work-note">Создание в действующем реестре ХвостМаркета. Доступно только администраторам.</p>');
    html += surface('Последние заказы сети', rows(allOrders.slice(0, 8).map(function(o) {
      return line(o.pickup_point || 'Покупка', date(o.created_at) + ' · ' +
        (o.refund_status === 'refunded' ? 'Возврат' :
          o.status === 'paid' ? 'Оплачен' : 'Статус: ' + o.status),
        rub(netPaidAmount(o) || (o.status === 'paid' ? 0 : Number(o.total || 0))));
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
    if (action === 'admin-reg-point' && activeRole === 'admin') return openAdminRegistration('point');
    if (action === 'admin-reg-owner' && activeRole === 'admin') return openAdminRegistration('owner');
    if (action === 'admin-reg-manager' && activeRole === 'admin') return openAdminRegistration('manager');
    if (action === 'admin-reg-groomer' && activeRole === 'admin') return openAdminRegistration('groomer');
    if (action === 'admin-reg-repeat' && activeRole === 'admin' && adminRegistrationKind)
      return openAdminRegistration(adminRegistrationKind);
    if (action === 'admin-reg-retry' && activeRole === 'admin' && adminRegistrationKind)
      return openAdminRegistration(adminRegistrationKind);
    if (action === 'admin-reg-back' && activeRole === 'admin') return closeAdminRegistration();
    if (action === 'manager-point-new' && activeRole === 'manager') return openManagerNewPoint();
    if (action === 'manager-point-retry' && activeRole === 'manager' && managerNewPointMode === 'form')
      return openManagerNewPoint();
    if (action === 'manager-point-back' && activeRole === 'manager') return chooseRole('manager');
    if (action === 'manager-point-groomer' && activeRole === 'manager' && managerNewPointMode === 'complete')
      return openManagerRegistration('groomer');
    if (action === 'manager-point-owner' && activeRole === 'manager' && managerNewPointMode === 'complete')
      return openManagerRegistration('owner');
    if (action === 'manager-reg-groomer' && activeRole === 'manager') return openManagerRegistration('groomer');
    if (action === 'manager-reg-owner' && activeRole === 'manager') return openManagerRegistration('owner');
    if (action === 'manager-reg-retry' && activeRole === 'manager' && managerRegistrationKind)
      return openManagerRegistration(managerRegistrationKind);
    if (action === 'manager-reg-back' && activeRole === 'manager') return chooseRole('manager');
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
    if (e.target.id === 'workManagerRegisterForm') {
      e.preventDefault();
      return submitManagerRegistration();
    }
    if (e.target.id === 'workManagerNewPointForm') {
      e.preventDefault();
      return submitManagerNewPoint();
    }
    if (e.target.id === 'workAdminRegistrationForm') {
      e.preventDefault();
      return submitAdminRegistration();
    }
  });
  root.addEventListener('change', function(e) {
    if (activeRole === 'manager' && managerRegistrationKind === 'owner' &&
        e.target && e.target.id === 'workRegPoint') updateOwnerGroomerChoices();
    if (activeRole === 'admin' && adminRegistrationKind === 'owner' &&
        e.target && e.target.id === 'workAdminPersonPoint') updateAdminOwnerGroomerChoices();
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
