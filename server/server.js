// server.js — точка входа. Отдаёт статические файлы сайта и обслуживает API.
// Запуск: node server/server.js  (или через npm start, см. package.json)
'use strict';

// Отложенную замену базы выполняем раньше любых импортов, которые открывают
// db.js. Загруженный файл проверяется на предыдущем запуске, после чего
// сервер перезапускается и устанавливает его до открытия SQLite-соединения.
require('./database-restore').applyPendingDatabaseRestore();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createStaticCache } = require('./static-cache');

const { Router, readBinaryBody, parseJsonBody, sendJson } = require('./http-utils');
const { registerAuthRoutes, requireSuperAdmin } = require('./routes-auth');
const { registerProductRoutes } = require('./routes-products');
const { registerQrAnalyticsRoutes } = require('./routes-qr-analytics');
const { registerQrWeeklyTelegramRoutes, scheduleWeeklyQrTelegramReport } = require('./qr-weekly-telegram');
const { registerSampleQrRoutes } = require('./routes-sample-qr');
const { registerReviewRoutes } = require('./routes-reviews');
const { registerPartnerRoutes } = require('./routes-partners');
const { registerManagerRoutes } = require('./routes-managers');
const { registerOrderRoutes } = require('./routes-orders');
const { registerPaymentRoutes } = require('./routes-payment');
const { registerWarehouseRoutes } = require('./routes-warehouse');
const { registerStockMovementRoutes } = require('./routes-stock-movements');
const { registerCustomerRestockRoutes } = require('./customer-restock-requests');
const { registerWarehouseKeeperRoutes } = require('./routes-warehouse-keepers');
const { registerOwnerRoutes } = require('./routes-owners');
const { registerCustomerRoutes } = require('./routes-customers');
const { registerChessRoutes } = require('./routes-chess');
const { registerQuizRoutes } = require('./routes-quiz');
const { registerSettingsRoutes } = require('./routes-settings');
const { registerNewsRoutes } = require('./routes-news');
const { registerBackupRoutes } = require('./backup');
const { registerLaunchTaskRoutes } = require('./routes-launch-tasks');
const { registerBacklogRoutes } = require('./routes-backlog');
const { registerPayoutReportRoutes } = require('./routes-payout-reports');
const { registerPartnerLeadRoutes } = require('./routes-partner-leads');
const { registerWinbackRoutes } = require('./winback');
const { registerEconomicsRoutes } = require('./routes-economics');
const { registerAuditRoutes } = require('./routes-audit');
const { registerPublicMessageRoutes } = require('./routes-public-messages');
const { registerMaxWebhookRoutes } = require('./routes-max-webhook');
const { registerWeeklyReportRoutes } = require('./routes-weekly-reports');
const { registerBscRoutes } = require('./routes-bsc');
const { registerTaskRoutes } = require('./routes-tasks');
const { registerTaskPageRoutes } = require('./routes-task-page');
const { registerOperationsRoutes } = require('./routes-operations');
const { registerPointLaunchRoutes } = require('./routes-point-launch');
const { registerPartnerClubRoutes } = require('./routes-partner-club');

require('./seed')(); // безопасно вызывать при каждом старте — использует INSERT OR IGNORE
require('./task-seed').seedMeetingTasks();
require('./task-seed-2026-10-25').seedMeeting20261025();
// Страницы партнёрских салонов дополнительно сохраняются отдельным снимком
// в /data и при необходимости восстанавливаются до запуска HTTP-сервера.
require('./salon-page-storage').initializeSalonPagePersistence();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Тот же путь, что и в routes-products.js — фото товаров живут в постоянном
// хранилище (DATA_DIR), не внутри public/, которая пересобирается заново
// при каждом деплое. См. подробный комментарий там же.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const router = new Router();
registerAuthRoutes(router);
registerProductRoutes(router);
registerQrAnalyticsRoutes(router);
registerQrWeeklyTelegramRoutes(router);
registerSampleQrRoutes(router);
registerReviewRoutes(router);
registerPartnerRoutes(router);
registerManagerRoutes(router);
registerOrderRoutes(router);
registerPaymentRoutes(router);
registerWarehouseRoutes(router);
registerStockMovementRoutes(router);
registerCustomerRestockRoutes(router);
registerWarehouseKeeperRoutes(router);
registerOwnerRoutes(router);
registerCustomerRoutes(router);
registerChessRoutes(router);
registerQuizRoutes(router);
registerSettingsRoutes(router);
registerNewsRoutes(router);
registerBackupRoutes(router);
registerLaunchTaskRoutes(router);
registerBacklogRoutes(router);
registerPayoutReportRoutes(router);
registerPartnerLeadRoutes(router);
registerWinbackRoutes(router);
registerEconomicsRoutes(router);
registerAuditRoutes(router);
registerPublicMessageRoutes(router);
registerMaxWebhookRoutes(router);
registerWeeklyReportRoutes(router);
registerBscRoutes(router);
registerTaskRoutes(router);
registerTaskPageRoutes(router);
registerOperationsRoutes(router);
registerPointLaunchRoutes(router);
registerPartnerClubRoutes(router);

const staticCache = createStaticCache(PUBLIC_DIR);

function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  // Фото товаров — особый случай: физически лежат в постоянном хранилище
  // (DATA_DIR/uploads), а не в public/images/uploads, но по URL для сайта
  // и админки должны выглядеть так же, как обычный статический файл — чтобы
  // не переписывать пути во всех местах, где они уже сохранены в базе.
  let filePath;
  if (decoded.startsWith('/images/uploads/')) {
    filePath = path.join(UPLOADS_DIR, decoded.slice('/images/uploads/'.length));
    if (!filePath.startsWith(UPLOADS_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
  } else {
    filePath = path.join(PUBLIC_DIR, decoded);
    // Защита от выхода за пределы public/ через '../'
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
  }
  if (pathname === '/' || pathname === '') filePath = path.join(PUBLIC_DIR, 'index.html');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const notFoundPath = path.join(PUBLIC_DIR, '404.html');
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(notFoundPath)
        .on('error', () => res.end('Страница не найдена'))
        .pipe(res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Uploaded originals can be large and must not fill the asset memory cache.
    if (decoded.startsWith('/images/uploads/')) {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    try {
      const result = staticCache.response(filePath, req, MIME[ext] || 'application/octet-stream');
      res.writeHead(result.status, result.headers);
      res.end(result.status === 304 || req.method === 'HEAD' ? undefined : result.body);
    } catch (error) {
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end('Не удалось загрузить страницу');
    }
  });
}

// Домены-псевдонимы (например, латинское написание для тех, кто не может
// переключить раскладку) — перенаправляются на основной домен. Так проще для
// SEO, чем показывать один и тот же сайт на двух доменах одновременно.
const CANONICAL_HOST = process.env.CANONICAL_HOST || 'xn--80adktilqfjfx.xn--p1ai'; // хвостмаркет.рф
const ALIAS_HOSTS = (process.env.ALIAS_HOSTS || 'xn----7sbal3ajopsm.xn--p1ai,www.xn----7sbal3ajopsm.xn--p1ai,taiga-feed.ru,www.taiga-feed.ru')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const server = http.createServer(async (req, res) => {
  const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
  // Перенаправляем браузерные переходы, сохраняя старые POST-адреса
  // вебхуков ЮKassa и ботов до обновления настроек интеграций.
  if (ALIAS_HOSTS.includes(hostHeader) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(301, { Location: `https://${CANONICAL_HOST}${req.url}` });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());

  // CORS — на случай если фронтенд когда-нибудь будет обращаться с другого домена
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname.startsWith('/api/')) {
    const match = router.match(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Маршрут не найден' });
    try {
      let body = {};
      let rawBody = null;
      let authenticatedPayload = null;
      if (req.method === 'POST' && pathname === '/api/backup/restore') {
        // Проверяем права ДО чтения крупного файла в память. Восстановление
        // доступно только супер-администратору.
        authenticatedPayload = requireSuperAdmin(req, res, { params: match.params, query, body: {} });
        if (!authenticatedPayload) return;
        rawBody = await readBinaryBody(req, 100 * 1024 * 1024);
      } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        body = await parseJsonBody(req);
      }
      await match.handler(req, res, { params: match.params, query, body, rawBody, authenticatedPayload });
    } catch (e) {
      const status = e.statusCode || 500;
      sendJson(res, status, { error: e.message || 'Внутренняя ошибка сервера' });
    }
    return;
  }

  // QR на товаре открывает лёгкую карточку покупки. Старые уже напечатанные
  // QR вида /?ref=X&product=Y продолжают работать через временный редирект.
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/' && query.product && query.ref) {
    res.writeHead(302, { Location: '/p/' + encodeURIComponent(query.ref) + '/' + encodeURIComponent(query.product) });
    res.end();
    return;
  }
  // Friendly name-based task URLs. A predictable path is NOT an access key:
  // all task data is still protected by the profile-specific capability token.
  // The token is supplied on first activation and kept on the user's device.
  let namedTaskPath = false;
  try {
    const cleanPath = decodeURIComponent(pathname).replace(/\/$/, '').toLowerCase();
    namedTaskPath = ['/админ','/алексей','/виталий','/ангелина','/николай'].includes(cleanPath);
  } catch (_) { /* malformed paths are rejected by the regular static handler */ }
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (namedTaskPath || pathname === '/t' || pathname === '/t/')) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    return serveStatic(req, res, '/tasks.html');
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/p' || pathname.startsWith('/p/'))) {
    return serveStatic(req, res, '/p.html');
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Тайга: сервер запущен на порту ${PORT} (Node.js ${process.version})`);
  require('./deployment-notification').notifyDeployment(PORT).catch((err) => console.error('Deployment notification:', err.message));
  require('./backup').scheduleBackups();
  require('./telegram-login-poller').startPolling();
  require('./routes-partner-club').startPartnerClubWorker();
  console.log(require('./max-bot').isConfigured()
    ? 'MAX: сайт готов принимать события через /api/max/webhook'
    : 'MAX: вход выключен — задайте MAX_BOT_TOKEN, MAX_BOT_USERNAME и MAX_WEBHOOK_SECRET');

  // Ежесуточная проверка уровней партнёров — ловит понижения даже у тех,
  // у кого давно не было заказов (иначе понижение сработало бы только при
  // следующей продаже, возможно, спустя много месяцев).
  const { checkAllPartnerTiers } = require('./partner-tiers');
  setInterval(() => { checkAllPartnerTiers().catch((e) => console.warn('Ошибка ежесуточной проверки уровней:', e.message)); }, 24 * 60 * 60 * 1000);

  require('./winback').scheduleWinback();
  require('./task-reminders').scheduleTaskReminders();
  scheduleWeeklyQrTelegramReport();
  require('./unpaid-order-alerts').scheduleUnpaidOrderAlerts();
});
