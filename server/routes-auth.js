// routes-auth.js — вход для админа, партнёра (грумера), менеджера и кладовщика.
'use strict';

const db = require('./db');
const crypto = require('node:crypto');
const { verifyPassword, signToken, hashPassword } = require('./auth');
const { sendJson } = require('./http-utils');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // час на использование ссылки

// Надёжная нормализация телефона — не полагается на то, что фронтенд уже
// добавил код страны (formatPhone), сама подставляет 7, если номер начинается
// с 9 (стандартный ввод мобильного без кода страны — самый частый способ).
function normalizePhoneDigits(phone) {
  let v = String(phone || '').replace(/\D/g, '');
  if (v.startsWith('8')) v = '7' + v.slice(1);
  else if (v.startsWith('9')) v = '7' + v;
  return v;
}

// Сравнение по последним 10 цифрам — устойчиво к тому, как именно телефон
// сохранён в базе (с кодом страны, без него, с 8 вместо 7 и т.п.) — важно,
// потому что телефон партнёров/менеджеров при регистрации сохраняется как
// есть, без единой нормализации, в отличие от телефона клиентов.
function phonesMatch(a, b) {
  const da = String(a || '').replace(/\D/g, '').slice(-10);
  const db_ = String(b || '').replace(/\D/g, '').slice(-10);
  return da.length === 10 && da === db_;
}

function registerAuthRoutes(router) {
  // POST /api/auth/login  { role: 'admin'|'partner'|'manager'|'warehouse', login, password }
  router.post('/api/auth/login', async (req, res, ctx) => {
    const { role, login, password } = ctx.body || {};
    if (!role || !login || !password) {
      return sendJson(res, 400, { error: 'Укажите role, login и password' });
    }

    let user = null;
    let table = null;

    if (role === 'admin') {
      user = db.prepare('SELECT * FROM admins WHERE login = ? AND active = 1').get(login);
      table = 'admins';
    } else if (role === 'partner') {
      user = db.prepare('SELECT * FROM partners WHERE login = ? AND active = 1').get(login);
      table = 'partners';
    } else if (role === 'manager') {
      user = db.prepare('SELECT * FROM managers WHERE login = ? AND active = 1').get(login);
      table = 'managers';
    } else if (role === 'warehouse') {
      user = db.prepare('SELECT * FROM warehouse_keepers WHERE login = ? AND active = 1').get(login);
      table = 'warehouse_keepers';
    } else if (role === 'owner') {
      user = db.prepare('SELECT * FROM salon_owners WHERE login = ? AND active = 1').get(login);
      table = 'salon_owners';
    } else if (role === 'customer') {
      const phone = login.replace(/\D/g, '');
      user = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
      table = 'customers';
    } else {
      return sendJson(res, 400, { error: 'Неизвестная роль' });
    }

    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: 'Неверный логин или пароль' });
    }

    // У партнёра и владельца салона своего city_id в таблице нет — город
    // определяется через точку, к которой они привязаны. Менеджер и
    // кладовщик хранят city_id у себя напрямую, для них ничего искать не
    // нужно. Без этого шага город появлялся бы только после перезагрузки
    // страницы (когда данные подгружаются через /me, а не сразу при входе).
    if ((role === 'partner' || role === 'owner') && user.point_id) {
      const point = db.prepare('SELECT city_id FROM points WHERE id = ?').get(user.point_id);
      if (point) user.city_id = point.city_id;
    }

    const token = signToken({ role, id: user.id, login: user.login, adminRole: role === 'admin' ? user.role : undefined });
    const { password_hash, telegram_chat_id, ...safeUser } = user;
    safeUser.telegram_connected = !!telegram_chat_id;
    sendJson(res, 200, { token, user: safeUser, table });
  });

  // GET /api/admin/me — данные именно того администратора, чей токен сейчас
  // используется. Нужен панели, чтобы после обновления страницы показывать
  // не только роль из localStorage, но и настоящее имя/логин текущего админа.
  router.get('/api/admin/me', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const admin = db.prepare(`
      SELECT id, login, full_name, role, telegram_chat_id
      FROM admins
      WHERE id = ? AND active = 1
    `).get(payload.id);
    if (!admin) return sendJson(res, 401, { error: 'Администратор не найден или отключён' });
    const { telegram_chat_id, ...safeAdmin } = admin;
    sendJson(res, 200, { admin: { ...safeAdmin, telegram_connected: !!telegram_chat_id } });
  });

  // Подключение Telegram из уже открытого кабинета. Пользователю не нужно
  // повторно вводить телефон: подписанный токен кабинета однозначно задаёт
  // роль и аккаунт. TG_CHAT_ID остаётся отдельным общим бизнес-чатом.
  const telegramAccountTables = {
    admin: 'admins',
    partner: 'partners',
    manager: 'managers',
    owner: 'salon_owners',
  };

  router.post('/api/telegram/connect/start', (req, res, ctx) => {
    const payload = requireAuth(Object.keys(telegramAccountTables))(req, res, ctx);
    if (!payload) return;
    if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Telegram-бот пока не настроен на сервере' });
    const tableName = telegramAccountTables[payload.role];
    const phoneColumn = payload.role === 'admin' ? '' : ', phone';
    const account = db.prepare(`SELECT id, telegram_chat_id${phoneColumn} FROM ${tableName} WHERE id = ? AND active = 1`).get(payload.id);
    if (!account) return sendJson(res, 404, { error: 'Аккаунт не найден или отключён' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const phoneOrAccount = account.phone || `account:${payload.role}:${payload.id}`;
    db.prepare(`
      INSERT INTO telegram_login_tokens (token, phone, role, account_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, phoneOrAccount, payload.role, payload.id, expiresAt);

    const botUsername = String(process.env.TG_BOT_USERNAME || 'taiga_dog_bot').replace(/^@/, '');
    sendJson(res, 200, {
      token,
      deep_link: `https://t.me/${botUsername}?start=${token}`,
      telegram_connected: !!account.telegram_chat_id,
    });
  });

  router.get('/api/telegram/connect/check', (req, res, ctx) => {
    const payload = requireAuth(Object.keys(telegramAccountTables))(req, res, ctx);
    if (!payload) return;
    const token = String(ctx.query.token || '');
    if (!token) return sendJson(res, 400, { error: 'Не указан токен подключения' });
    const record = db.prepare('SELECT * FROM telegram_login_tokens WHERE token = ?').get(token);
    if (!record || record.role !== payload.role || Number(record.account_id) !== Number(payload.id)) {
      return sendJson(res, 404, { error: 'Ссылка подключения не найдена' });
    }
    if (Date.parse(record.expires_at) <= Date.now() && !record.verified) {
      return sendJson(res, 410, { error: 'Ссылка подключения устарела' });
    }
    if (!record.verified || !record.chat_id) return sendJson(res, 200, { verified: false });

    const tableName = telegramAccountTables[payload.role];
    db.prepare(`UPDATE ${tableName} SET telegram_chat_id = ? WHERE id = ?`).run(String(record.chat_id), payload.id);
    sendJson(res, 200, { verified: true, telegram_connected: true });
  });

  // POST /api/auth/forgot-password { login } — только для admin. У этой роли нет
  // "начальника" в системе, который мог бы сбросить пароль вручную (в отличие
  // от партнёров/менеджеров/кладовщиков — тем пароль сбрасывает сам админ),
  // поэтому ссылка на восстановление уходит в бизнес-чат Telegram (тот же,
  // куда прилетают уведомления о заказах) и/или на почту — куда что настроено.
  router.post('/api/auth/forgot-password', async (req, res, ctx) => {
    const { login } = ctx.body || {};
    const genericResponse = { ok: true, message: 'Если такой логин существует, ссылка для восстановления отправлена в Telegram и/или на почту администратора.' };
    if (!login) return sendJson(res, 200, genericResponse); // не раскрываем, существует ли логин

    const admin = db.prepare('SELECT * FROM admins WHERE login = ?').get(login);
    if (!admin) return sendJson(res, 200, genericResponse); // тот же ответ — не палим наличие аккаунта

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (token, admin_id, expires_at) VALUES (?, ?, ?)').run(token, admin.id, expiresAt);

    const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');
    const resetLink = (siteUrl || '') + '/taiga-admin.html?reset_token=' + token;

    const { sendTelegram } = require('./telegram');
    const tgResult = await sendTelegram(
      '🔑 <b>Восстановление пароля администратора</b>\n\n' +
      'Запрошено для логина «' + login + '».\n\n' +
      'Ссылка действует 1 час:\n' + resetLink + '\n\n' +
      'Если это были не вы — просто проигнорируйте сообщение, пароль не изменится.'
    ).catch((e) => { console.error('Не удалось отправить ссылку восстановления в Telegram:', e.message); return { ok: false }; });

    const recoveryEmail = process.env.ADMIN_RECOVERY_EMAIL || process.env.BUSINESS_COPY_EMAIL || '';
    if (recoveryEmail) {
      const { sendEmail } = require('./email');
      await sendEmail({
        to: recoveryEmail,
        subject: 'Восстановление пароля администратора «Тайга»',
        text: 'Запрошено восстановление пароля для логина «' + login + '».\n\n' +
              'Перейдите по ссылке в течение часа, чтобы задать новый пароль:\n' + resetLink + '\n\n' +
              'Если это были не вы — просто проигнорируйте это письмо, пароль не изменится.',
      }).catch((e) => console.error('Не удалось отправить письмо восстановления:', e.message));
    }

    if (!tgResult.ok && !recoveryEmail) {
      console.warn('Восстановление пароля недоступно: не настроен ни Telegram (TG_TOKEN/TG_CHAT_ID), ни ADMIN_RECOVERY_EMAIL/BUSINESS_COPY_EMAIL');
    }

    sendJson(res, 200, genericResponse);
  });

  // POST /api/auth/reset-password { token, new_password }
  router.post('/api/auth/reset-password', async (req, res, ctx) => {
    const { token, new_password } = ctx.body || {};
    if (!token || !new_password || new_password.length < 6) {
      return sendJson(res, 400, { error: 'Укажите token и new_password (не короче 6 символов)' });
    }
    const record = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!record || record.used || new Date(record.expires_at) < new Date()) {
      return sendJson(res, 400, { error: 'Ссылка недействительна или уже использована. Запросите восстановление заново.' });
    }
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), record.admin_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/customer/claim-account { phone, order_code, password } — клиент
  // задаёт пароль для личного кабинета. Без SMS/email-подтверждения (их нет
  // в системе) единственный честный способ убедиться, что это владелец
  // номера — попросить номер ОДНОГО ИЗ ЕГО ЗАКАЗОВ. Он известен только тому,
  // кто реально покупал (виден на экране успеха сразу после оплаты).
  router.post('/api/customer/claim-account', (req, res, ctx) => {
    const { phone, order_code, password } = ctx.body || {};
    if (!phone || !order_code || !password || password.length < 6) {
      return sendJson(res, 400, { error: 'Укажите phone, order_code и password (не короче 6 символов)' });
    }
    const digits = phone.replace(/\D/g, '');
    const order = db.prepare('SELECT * FROM orders WHERE order_code = ? AND status = ?').get(order_code.trim(), 'paid');
    if (!order || order.customer_phone.replace(/\D/g, '') !== digits) {
      return sendJson(res, 400, { error: 'Не нашли оплаченный заказ с таким номером телефона и номером заказа' });
    }
    const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(digits);
    if (!customer) return sendJson(res, 404, { error: 'Клиент не найден' });
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(password), customer.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/customer/register { phone, password, name?, email? } — прямая
  // регистрация по паролю, без SMS. Разрешена только для НОВОГО номера —
  // если по этому телефону уже есть карточка клиента (например, был заказ
  // без пароля, или вход через Telegram), значит владение номером ещё не
  // подтверждено этой формой, и просто выдать пароль на существующий аккаунт
  // было бы небезопасно (кто угодно мог бы "угнать" чужой номер, набрав его
  // руками). В этом случае — на /api/customer/claim-account (по номеру
  // заказа) или через вход по Telegram.
  router.post('/api/customer/register', (req, res, ctx) => {
    const { phone, password, name, email } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 10 || !password || password.length < 6) {
      return sendJson(res, 400, { error: 'Укажите корректный телефон и пароль (не короче 6 символов)' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: 'Проверьте правильность email' });
    }
    const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(digits);
    if (existing) {
      return sendJson(res, 409, {
        error: 'Этот номер уже зарегистрирован в системе. Войдите через Telegram, или задайте пароль по номеру одного из ваших заказов.',
      });
    }
    const info = db.prepare(`
      INSERT INTO customers (phone, name, email, password_hash, orders_count, total_spent)
      VALUES (?, ?, ?, ?, 0, 0)
    `).run(digits, (name || '').trim() || null, (email || '').trim() || null, hashPassword(password));
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    const token = signToken({ role: 'customer', id: customer.id });
    const { password_hash, ...safeUser } = customer;
    sendJson(res, 201, { token, user: safeUser });
  });

  // POST /api/customer/forgot-password { email } — восстановление пароля по
  // почте (без SMS). Работает, только если у клиента вообще указан email в
  // профиле — если нет, вход всё ещё возможен через Telegram.
  router.post('/api/customer/forgot-password', async (req, res, ctx) => {
    const { email } = ctx.body || {};
    const genericResponse = { ok: true, message: 'Если такой email указан в профиле клиента, ссылка для восстановления отправлена на почту.' };
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return sendJson(res, 200, genericResponse);

    const customer = db.prepare('SELECT * FROM customers WHERE LOWER(email) = ?').get(cleanEmail);
    if (!customer) return sendJson(res, 200, genericResponse); // не палим, существует ли такой email

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    db.prepare('INSERT INTO customer_password_reset_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)').run(token, customer.id, expiresAt);

    const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');
    const resetLink = (siteUrl || '') + '/index.html?customer_reset_token=' + token;

    const { sendEmail, isConfigured } = require('./email');
    if (!isConfigured()) {
      console.warn('Восстановление пароля клиента недоступно: почта не настроена на сервере (SMTP_*)');
      return sendJson(res, 200, genericResponse);
    }
    await sendEmail({
      to: customer.email,
      subject: 'Восстановление пароля личного кабинета «Тайга»',
      text: 'Запрошено восстановление пароля для вашего личного кабинета на тайга-корм.рф.\n\n' +
            'Перейдите по ссылке в течение часа, чтобы задать новый пароль:\n' + resetLink + '\n\n' +
            'Если это были не вы — просто проигнорируйте письмо, пароль не изменится.',
    }).catch((e) => console.error('Не удалось отправить письмо восстановления клиенту:', e.message));

    sendJson(res, 200, genericResponse);
  });

  // POST /api/customer/reset-password { token, new_password }
  router.post('/api/customer/reset-password', (req, res, ctx) => {
    const { token, new_password } = ctx.body || {};
    if (!token || !new_password || new_password.length < 6) {
      return sendJson(res, 400, { error: 'Укажите token и new_password (не короче 6 символов)' });
    }
    const record = db.prepare('SELECT * FROM customer_password_reset_tokens WHERE token = ?').get(token);
    if (!record || record.used || new Date(record.expires_at) < new Date()) {
      return sendJson(res, 400, { error: 'Ссылка недействительна или уже использована. Запросите восстановление заново.' });
    }
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), record.customer_id);
    db.prepare('UPDATE customer_password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/customer/telegram/start { phone } — создаёт токен и ссылку-приглашение в бота
  router.post('/api/customer/telegram/start', (req, res, ctx) => {
    const { phone } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 10) return sendJson(res, 400, { error: 'Укажите корректный номер телефона' });
    if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Вход через Telegram пока не настроен на сервере' });

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 минут на переход в бота
    db.prepare('INSERT INTO telegram_login_tokens (token, phone, expires_at) VALUES (?, ?, ?)').run(token, digits, expiresAt);

    const botUsername = process.env.TG_BOT_USERNAME || 'taiga_dog_bot';
    sendJson(res, 200, { token, deep_link: 'https://t.me/' + botUsername + '?start=' + token });
  });

  // GET /api/customer/telegram/check?token=... — фронтенд опрашивает, подтвердил ли клиент вход в боте
  router.get('/api/customer/telegram/check', (req, res, ctx) => {
    const token = ctx.query.token;
    if (!token) return sendJson(res, 400, { error: 'Укажите token' });
    const record = db.prepare('SELECT * FROM telegram_login_tokens WHERE token = ?').get(token);
    if (!record) return sendJson(res, 404, { error: 'Токен не найден' });
    if (!record.verified) return sendJson(res, 200, { verified: false });

    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(record.phone);
    if (!customer) {
      const info = db.prepare('INSERT INTO customers (phone, orders_count, total_spent) VALUES (?, 0, 0)').run(record.phone);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    }
    // Запоминаем chat_id — пригодится, чтобы написать клиенту самим (win-back и т.п.),
    // без этого шага у нас нет способа связаться с клиентом через Telegram напрямую.
    if (record.chat_id && record.chat_id !== customer.telegram_chat_id) {
      db.prepare('UPDATE customers SET telegram_chat_id = ? WHERE id = ?').run(record.chat_id, customer.id);
      customer.telegram_chat_id = record.chat_id;
    }
    const authToken = signToken({ role: 'customer', id: customer.id });
    const { password_hash, ...safeUser } = customer;
    sendJson(res, 200, { verified: true, token: authToken, user: safeUser });
  });

  // POST /api/customer/telegram/verify-code { phone, code } — запасной способ входа, если
  // автоматический опрос /telegram/check не сработал (например, вкладка была перезагружена
  // и потеряла исходный длинный token). Бот присылает этот код тем же сообщением, где
  // подтверждает вход — здесь достаточно телефона и кода, исходный token не нужен.
  router.post('/api/customer/telegram/verify-code', (req, res, ctx) => {
    const { phone, code } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    const cleanCode = String(code || '').trim();
    if (digits.length < 10 || !cleanCode) return sendJson(res, 400, { error: 'Укажите телефон и код' });

    const record = db.prepare(`
      SELECT * FROM telegram_login_tokens
      WHERE phone = ? AND code = ? AND verified = 1 AND role = 'customer' AND expires_at > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).get(digits, cleanCode);
    if (!record) return sendJson(res, 404, { error: 'Код неверен или устарел. Запросите вход через Telegram заново.' });

    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(record.phone);
    if (!customer) {
      const info = db.prepare('INSERT INTO customers (phone, orders_count, total_spent) VALUES (?, 0, 0)').run(record.phone);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    }
    if (record.chat_id && record.chat_id !== customer.telegram_chat_id) {
      db.prepare('UPDATE customers SET telegram_chat_id = ? WHERE id = ?').run(record.chat_id, customer.id);
      customer.telegram_chat_id = record.chat_id;
    }
    const authToken = signToken({ role: 'customer', id: customer.id });
    const { password_hash, ...safeUser } = customer;
    sendJson(res, 200, { verified: true, token: authToken, user: safeUser });
  });

  // POST /api/partners/telegram/start { phone } — вход партнёра через Telegram.
  // В отличие от клиента, аккаунт партнёра должен уже существовать (его
  // создаёт админ) — если по номеру ничего не нашли, честно отказываем сразу.
  router.post('/api/partners/telegram/start', (req, res, ctx) => {
    const { phone } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 10) return sendJson(res, 400, { error: 'Укажите корректный номер телефона' });
    if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Вход через Telegram пока не настроен на сервере' });

    const partner = db.prepare('SELECT id, phone FROM partners WHERE active = 1').all()
      .find((p) => phonesMatch(p.phone, digits));
    if (!partner) return sendJson(res, 404, { error: 'Партнёр с таким номером телефона не найден или ещё не активирован' });

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO telegram_login_tokens (token, phone, role, expires_at) VALUES (?, ?, 'partner', ?)").run(token, digits, expiresAt);

    const botUsername = process.env.TG_BOT_USERNAME || 'taiga_dog_bot';
    sendJson(res, 200, { token, deep_link: 'https://t.me/' + botUsername + '?start=' + token });
  });

  // GET /api/partners/telegram/check?token=...
  router.get('/api/partners/telegram/check', (req, res, ctx) => {
    const token = ctx.query.token;
    if (!token) return sendJson(res, 400, { error: 'Укажите token' });
    const record = db.prepare("SELECT * FROM telegram_login_tokens WHERE token = ? AND role = 'partner'").get(token);
    if (!record) return sendJson(res, 404, { error: 'Токен не найден' });
    if (!record.verified) return sendJson(res, 200, { verified: false });

    const partner = db.prepare('SELECT * FROM partners WHERE active = 1').all()
      .find((p) => phonesMatch(p.phone, record.phone));
    if (!partner) return sendJson(res, 404, { error: 'Партнёр не найден или отключён' });
    if (record.chat_id && record.chat_id !== partner.telegram_chat_id) {
      db.prepare('UPDATE partners SET telegram_chat_id = ? WHERE id = ?').run(String(record.chat_id), partner.id);
      partner.telegram_chat_id = String(record.chat_id);
    }
    const authToken = signToken({ role: 'partner', id: partner.id, login: partner.login });
    const { password_hash: ph1, telegram_chat_id: tg1, ...safePartnerUser } = partner;
    safePartnerUser.telegram_connected = !!tg1;
    sendJson(res, 200, { verified: true, token: authToken, user: safePartnerUser });
  });

  // POST /api/partners/telegram/verify-code { phone, code } — запасной способ входа,
  // если автоматический опрос /telegram/check не сработал.
  router.post('/api/partners/telegram/verify-code', (req, res, ctx) => {
    const { phone, code } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    const cleanCode = String(code || '').trim();
    if (digits.length < 10 || !cleanCode) return sendJson(res, 400, { error: 'Укажите телефон и код' });

    const record = db.prepare(`
      SELECT * FROM telegram_login_tokens
      WHERE phone = ? AND code = ? AND verified = 1 AND role = 'partner' AND expires_at > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).get(digits, cleanCode);
    if (!record) return sendJson(res, 404, { error: 'Код неверен или устарел. Запросите вход через Telegram заново.' });

    const partner = db.prepare('SELECT * FROM partners WHERE active = 1').all()
      .find((p) => phonesMatch(p.phone, record.phone));
    if (!partner) return sendJson(res, 404, { error: 'Партнёр не найден или отключён' });
    if (record.chat_id && record.chat_id !== partner.telegram_chat_id) {
      db.prepare('UPDATE partners SET telegram_chat_id = ? WHERE id = ?').run(String(record.chat_id), partner.id);
      partner.telegram_chat_id = String(record.chat_id);
    }
    const authToken = signToken({ role: 'partner', id: partner.id, login: partner.login });
    const { password_hash: ph1, telegram_chat_id: tg1, ...safePartnerUser } = partner;
    safePartnerUser.telegram_connected = !!tg1;
    sendJson(res, 200, { verified: true, token: authToken, user: safePartnerUser });
  });

  // POST /api/managers/telegram/start { phone } — вход менеджера через Telegram
  router.post('/api/managers/telegram/start', (req, res, ctx) => {
    const { phone } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 10) return sendJson(res, 400, { error: 'Укажите корректный номер телефона' });
    if (!process.env.TG_TOKEN) return sendJson(res, 503, { error: 'Вход через Telegram пока не настроен на сервере' });

    const mgr = db.prepare('SELECT id, phone FROM managers WHERE active = 1').all()
      .find((a) => phonesMatch(a.phone, digits));
    if (!mgr) return sendJson(res, 404, { error: 'Менеджер с таким номером телефона не найден или отключён' });

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO telegram_login_tokens (token, phone, role, expires_at) VALUES (?, ?, 'manager', ?)").run(token, digits, expiresAt);

    const botUsername = process.env.TG_BOT_USERNAME || 'taiga_dog_bot';
    sendJson(res, 200, { token, deep_link: 'https://t.me/' + botUsername + '?start=' + token });
  });

  // GET /api/managers/telegram/check?token=...
  router.get('/api/managers/telegram/check', (req, res, ctx) => {
    const token = ctx.query.token;
    if (!token) return sendJson(res, 400, { error: 'Укажите token' });
    const record = db.prepare("SELECT * FROM telegram_login_tokens WHERE token = ? AND role = 'manager'").get(token);
    if (!record) return sendJson(res, 404, { error: 'Токен не найден' });
    if (!record.verified) return sendJson(res, 200, { verified: false });

    const mgr = db.prepare('SELECT * FROM managers WHERE active = 1').all()
      .find((a) => phonesMatch(a.phone, record.phone));
    if (!mgr) return sendJson(res, 404, { error: 'Менеджер не найден или отключён' });
    if (record.chat_id && record.chat_id !== mgr.telegram_chat_id) {
      db.prepare('UPDATE managers SET telegram_chat_id = ? WHERE id = ?').run(String(record.chat_id), mgr.id);
      mgr.telegram_chat_id = String(record.chat_id);
    }
    const authToken = signToken({ role: 'manager', id: mgr.id, login: mgr.login });
    const { password_hash: ph2, telegram_chat_id: tg2, ...safeMgrUser } = mgr;
    safeMgrUser.telegram_connected = !!tg2;
    sendJson(res, 200, { verified: true, token: authToken, user: safeMgrUser });
  });

  // POST /api/managers/telegram/verify-code { phone, code } — запасной способ входа,
  // если автоматический опрос /telegram/check не сработал.
  router.post('/api/managers/telegram/verify-code', (req, res, ctx) => {
    const { phone, code } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    const cleanCode = String(code || '').trim();
    if (digits.length < 10 || !cleanCode) return sendJson(res, 400, { error: 'Укажите телефон и код' });

    const record = db.prepare(`
      SELECT * FROM telegram_login_tokens
      WHERE phone = ? AND code = ? AND verified = 1 AND role = 'manager' AND expires_at > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).get(digits, cleanCode);
    if (!record) return sendJson(res, 404, { error: 'Код неверен или устарел. Запросите вход через Telegram заново.' });

    const mgr = db.prepare('SELECT * FROM managers WHERE active = 1').all()
      .find((a) => phonesMatch(a.phone, record.phone));
    if (!mgr) return sendJson(res, 404, { error: 'Менеджер не найден или отключён' });
    if (record.chat_id && record.chat_id !== mgr.telegram_chat_id) {
      db.prepare('UPDATE managers SET telegram_chat_id = ? WHERE id = ?').run(String(record.chat_id), mgr.id);
      mgr.telegram_chat_id = String(record.chat_id);
    }
    const authToken = signToken({ role: 'manager', id: mgr.id, login: mgr.login });
    const { password_hash: ph2, telegram_chat_id: tg2, ...safeMgrUser } = mgr;
    safeMgrUser.telegram_connected = !!tg2;
    sendJson(res, 200, { verified: true, token: authToken, user: safeMgrUser });
  });

  // POST /api/customer/max/start { phone } — создаёт токен и ссылку-приглашение в бота MAX
  router.post('/api/customer/max/start', (req, res, ctx) => {
    const { phone } = ctx.body || {};
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 10) return sendJson(res, 400, { error: 'Укажите корректный номер телефона' });
    const { isConfigured } = require('./max-bot');
    if (!isConfigured()) return sendJson(res, 503, { error: 'Вход через MAX пока не настроен на сервере' });

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO max_login_tokens (token, phone, expires_at) VALUES (?, ?, ?)').run(token, digits, expiresAt);

    const botUsername = String(process.env.MAX_BOT_USERNAME).replace(/^@/, '');
    sendJson(res, 200, { token, deep_link: 'https://max.ru/' + botUsername + '?start=' + token });
  });

  router.get('/api/customer/max/status', (req, res) => {
    const { isConfigured } = require('./max-bot');
    sendJson(res, 200, { enabled: isConfigured() });
  });

  // GET /api/customer/max/check?token=... — фронтенд опрашивает, подтвердил ли клиент вход в боте MAX
  router.get('/api/customer/max/check', (req, res, ctx) => {
    const token = ctx.query.token;
    if (!token) return sendJson(res, 400, { error: 'Укажите token' });
    const record = db.prepare('SELECT * FROM max_login_tokens WHERE token = ?').get(token);
    if (!record || new Date(record.expires_at).getTime() <= Date.now()) {
      return sendJson(res, 404, { error: 'Ссылка устарела. Запросите вход заново.' });
    }
    if (!record.verified) return sendJson(res, 200, { verified: false });

    let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(record.phone);
    if (!customer) {
      const info = db.prepare('INSERT INTO customers (phone, orders_count, total_spent) VALUES (?, 0, 0)').run(record.phone);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    }
    if (record.chat_id && record.chat_id !== customer.max_chat_id) {
      db.prepare('UPDATE customers SET max_chat_id = ? WHERE id = ?').run(String(record.chat_id), customer.id);
      customer.max_chat_id = String(record.chat_id);
    }
    const authToken = signToken({ role: 'customer', id: customer.id });
    const { password_hash, max_chat_id, ...safeUser } = customer;
    safeUser.max_connected = !!max_chat_id;
    sendJson(res, 200, { verified: true, token: authToken, user: safeUser });
  });

  // ── УПРАВЛЕНИЕ АДМИНАМИ (только супер-админ) ──────────────────────

  // GET /api/admins — список всех админов
  router.get('/api/admins', (req, res, ctx) => {
    if (!requireSuperAdmin(req, res, ctx)) return;
    const rows = db.prepare('SELECT id, login, full_name, role, active, created_at FROM admins ORDER BY id ASC').all();
    sendJson(res, 200, { admins: rows });
  });

  // POST /api/admins — создать нового админа (обычного или ещё одного супер-админа)
  router.post('/api/admins', async (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    const { login, password, full_name, role } = ctx.body || {};
    if (!login || !password || password.length < 6) {
      return sendJson(res, 400, { error: 'Укажите login и password (не короче 6 символов)' });
    }
    const existing = db.prepare('SELECT id FROM admins WHERE login = ?').get(login);
    if (existing) return sendJson(res, 409, { error: 'Такой логин уже существует' });
    const finalRole = role === 'super' ? 'super' : 'admin';
    const info = db.prepare('INSERT INTO admins (login, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, 1)')
      .run(login, hashPassword(password), full_name || null, finalRole);

    // Создание админа (особенно супер-админа) — чувствительное действие,
    // уведомление тут работает ещё и как сигнал безопасности: если аккаунт
    // появился неожиданно, об этом сразу узнают, а не через недели.
    const { sendTelegram } = require('./telegram');
    await sendTelegram([
      (finalRole === 'super' ? '🔐 <b>Новый СУПЕР-админ</b>' : '🔐 <b>Новый администратор</b>'),
      '',
      '👤 ' + (full_name || login),
      '🔑 Логин: ' + login,
      '🎖 Роль: ' + (finalRole === 'super' ? 'супер-админ' : 'админ'),
      '👤 Создал: ' + payload.login,
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Krasnoyarsk' }),
    ].join('\n'));

    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  });

  // PUT /api/admins/:id — включить/отключить, поменять ФИО или роль
  router.put('/api/admins/:id', (req, res, ctx) => {
    const payload = requireSuperAdmin(req, res, ctx);
    if (!payload) return;
    const existing = db.prepare('SELECT * FROM admins WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Админ не найден' });
    const { active, full_name, role } = ctx.body || {};

    // Защита от случайной блокировки самого себя или отключения последнего
    // супер-админа — иначе управлять админами вообще станет некому.
    if ((active === false || role === 'admin') && existing.role === 'super') {
      const otherSupers = db.prepare("SELECT COUNT(*) as c FROM admins WHERE role = 'super' AND active = 1 AND id != ?").get(ctx.params.id);
      if (otherSupers.c === 0) {
        return sendJson(res, 400, { error: 'Нельзя отключить или понизить единственного супер-админа' });
      }
    }

    db.prepare('UPDATE admins SET active = ?, full_name = ?, role = ? WHERE id = ?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      full_name !== undefined ? full_name : existing.full_name,
      role !== undefined ? (role === 'super' ? 'super' : 'admin') : existing.role,
      ctx.params.id
    );
    sendJson(res, 200, { ok: true });
  });

  // POST /api/admins/:id/reset-password — сбросить пароль другому админу
  router.post('/api/admins/:id/reset-password', (req, res, ctx) => {
    if (!requireSuperAdmin(req, res, ctx)) return;
    const existing = db.prepare('SELECT id FROM admins WHERE id = ?').get(ctx.params.id);
    if (!existing) return sendJson(res, 404, { error: 'Админ не найден' });
    const newPassword = crypto.randomBytes(6).toString('hex');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), ctx.params.id);
    sendJson(res, 200, { ok: true, new_password: newPassword });
  });
}

// Middleware-хелпер: достаёт и проверяет токен из заголовка Authorization: Bearer ...
function requireAuth(roles) {
  return (req, res, ctx) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const { verifyToken } = require('./auth');
    const payload = token ? verifyToken(token) : null;
    if (!payload || (roles && !roles.includes(payload.role))) {
      sendJson(res, 401, { error: 'Требуется авторизация' });
      return null;
    }
    return payload;
  };
}

// Как requireAuth(['admin']), но дополнительно проверяет, что это именно
// супер-админ — управление другими админами доступно только ему.
function requireSuperAdmin(req, res, ctx) {
  const payload = requireAuth(['admin'])(req, res, ctx);
  if (!payload) return null;
  if (payload.adminRole !== 'super') {
    sendJson(res, 403, { error: 'Эта функция доступна только супер-админу' });
    return null;
  }
  return payload;
}

// Как requireAuth, но НЕ отправляет ошибку и не блокирует запрос — просто
// возвращает payload при валидном токене нужной роли, иначе null. Нужно для
// публичных эндпоинтов, где часть данных (например, себестоимость) должна
// показываться только авторизованному админу, а остальным — нет.
function tryAuth(roles) {
  return (req) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const { verifyToken } = require('./auth');
    const payload = token ? verifyToken(token) : null;
    if (!payload || (roles && !roles.includes(payload.role))) return null;
    return payload;
  };
}

module.exports = { registerAuthRoutes, requireAuth, requireSuperAdmin, tryAuth };
