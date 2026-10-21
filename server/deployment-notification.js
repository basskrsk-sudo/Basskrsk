// Sends one email for each successfully started Docker build, not for every restart.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { sendEmail } = require('./email');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const INFO_FILE = path.join(__dirname, '..', 'build-info.json');
const LAST_FILE = path.join(DATA_DIR, 'last-notified-build.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/points', timeout: 6000 }, (res) => {
      let bytes = 0;
      let hasContent = false;
      res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 0) hasContent = true; });
      res.on('end', () => resolve(res.statusCode === 200 && hasContent));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}


// Checks actual HTML bodies, not just HTTP status; the app's custom 404 is HTML.
function checkPage(port, route, expected) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { if (body.length < 150000) body += chunk.toString('utf8'); });
      res.on('end', () => resolve({
        path: route,
        ok: res.statusCode === 200 && expected.test(body),
        status: res.statusCode,
      }));
      res.on('error', () => resolve({ path: route, ok: false, status: 0 }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ path: route, ok: false, status: 0 }));
  });
}

async function notifyDeployment(port) {
  const info = readJson(INFO_FILE);
  if (!info || !info.build_id) {
    console.warn('Deploy email: build-info.json отсутствует; уведомление пропущено');
    return;
  }
  if (readJson(LAST_FILE)?.build_id === info.build_id) {
    console.log('Deploy email: эта сборка уже подтверждена письмом');
    return;
  }
  if (!await healthCheck(port)) {
    console.warn('Deploy email: сервер не прошёл локальную проверку /api/points');
    return;
  }
  const pages = await Promise.all([
    checkPage(port, '/', /<html/i),
    checkPage(port, '/sample-qr.html', /QR-коды пробников/i),
  ]);
  const recipient = process.env.DEPLOY_NOTIFICATION_EMAIL ||
    process.env.BUSINESS_COPY_EMAIL || process.env.BACKUP_EMAIL;
  if (!recipient) {
    console.warn('Deploy email: нет DEPLOY_NOTIFICATION_EMAIL/BUSINESS_COPY_EMAIL/BACKUP_EMAIL');
    return;
  }
  const now = new Date();
  const version = info.version || 'unknown';
  const sha = info.git_commit && info.git_commit !== 'unknown' ? info.git_commit : (process.env.GIT_COMMIT || process.env.COMMIT_SHA || 'не удалось определить');
  const allPagesOk = pages.every(p => p.ok);
  const text = [
    'ХвостМаркет: новая сборка успешно запустилась.',
    '',
    'Статус: сервер работает, API /api/points ответил 200.',
    ...pages.map(p => (p.ok ? '✅ ' : '⚠️ ') + p.path + ': HTTP ' + p.status + (p.ok ? ', содержимое проверено' : ', проверка не пройдена')),
    'Версия приложения: ' + version,
    'Идентификатор сборки: ' + info.build_id,
    'Коммит GitHub: ' + sha,
    'Образ собран (UTC): ' + (info.built_at || 'неизвестно'),
    'Запущен и проверен (UTC): ' + now.toISOString(),
    'Среда: ' + (process.env.DEPLOY_ENV || 'Amvera'),
    'Node.js: ' + process.version,
    'Сайт: https://хвостмаркет.рф',
    '',
    'Внимание: страницы проверены локально внутри Amvera, а не из интернета.',
    'Это не проверка покупки или оплаты. Результаты ошибок показаны выше.',
    '',
    'Внешняя доступность сайта отдельно не подтверждена.',
  ].join('\n');
  const result = await sendEmail({
    to: recipient,
    subject: (allPagesOk ? '✅' : '⚠️') + ' ХвостМаркет — ' + (allPagesOk ? 'версия запущена' : 'версия запущена, есть ошибки страниц') + ' (' + version + ')',
    text,
  });
  if (!result.ok) {
    console.warn('Deploy email: письмо не принято SMTP', result.error || '');
    return;
  }
  // Persist only after SMTP confirms acceptance. Restarting same build won't spam.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = LAST_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ build_id: info.build_id, sent_at: now.toISOString() }));
    fs.renameSync(tmp, LAST_FILE);
    console.log('Deploy email: уведомление отправлено', info.build_id);
  } catch (e) {
    console.error('Deploy email: не удалось сохранить отметку', e.message);
  }
}

module.exports = { notifyDeployment, healthCheck };
