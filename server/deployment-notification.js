// Sends one email for each successfully started Docker build, not for every restart.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { sendEmail } = require('./email');
const { sendTelegram } = require('./telegram');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const INFO_FILE = path.join(__dirname, '..', 'build-info.json');
const LAST_FILE = path.join(DATA_DIR, 'last-notified-build.json');
const LAST_TG_FILE = path.join(DATA_DIR, 'last-telegram-deploy-build.json');

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


function githubJson(route) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/repos/basskrsk-sudo/Basskrsk/' + route,
      headers: { 'User-Agent': 'HvostMarket-deployment-notifier', 'Accept': 'application/vnd.github+json' },
      timeout: 7000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 250000) req.destroy(new Error('GitHub response too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('GitHub HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub timeout')));
    req.on('error', reject);
  });
}

async function listDeploymentChanges(sha, previous) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) return ['Коммит недоступен: список изменений не определён.'];
  try {
    let commits;
    if (previous && /^[0-9a-f]{40}$/i.test(previous.git_commit) && previous.git_commit !== sha) {
      const response = await githubJson('compare/' + previous.git_commit + '...' + sha);
      commits = response.commits || [];
      if (response.ahead_by > commits.length) {
        return ['Более ' + commits.length + ' коммитов — показаны последние из полученных.', ...commits.slice(-12).map(x => x.commit.message.split('\n')[0])];
      }
    } else if (previous && previous.sent_at) {
      // Older notification records do not contain a commit SHA.
      commits = await githubJson('commits?sha=' + sha + '&since=' + encodeURIComponent(previous.sent_at) + '&per_page=30');
    } else {
      return ['Первая сборка с журналом изменений: сравнение с предыдущей версией недоступно.'];
    }
    if (!commits.length) return ['Изменений кода между запусками не обнаружено.'];
    return commits.slice(-15).map(x => x.commit.message.split('\n')[0]);
  } catch (err) {
    console.warn('Deploy email: не удалось получить изменения GitHub:', err.message);
    return ['Не удалось загрузить историю изменений GitHub.'];
  }
}

function escapeHtml(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }

async function notifyDeployment(port) {
  const info = readJson(INFO_FILE);
  if (!info || !info.build_id) {
    console.warn('Deploy email: build-info.json отсутствует; уведомление пропущено');
    return;
  }
  const previous = readJson(LAST_FILE);
  const telegramPrevious = readJson(LAST_TG_FILE);
  if (previous?.build_id === info.build_id && telegramPrevious?.build_id === info.build_id) {
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
  if (!recipient) console.warn('Deploy email: почтовый получатель не настроен; Telegram проверяется отдельно');
  const now = new Date();
  const version = info.version || 'unknown';
  const sha = info.git_commit && info.git_commit !== 'unknown' ? info.git_commit : (process.env.GIT_COMMIT || process.env.COMMIT_SHA || 'не удалось определить');
  const allPagesOk = pages.every(p => p.ok);
  const changes = await listDeploymentChanges(sha, previous);
  const text = [
    'ХвостМаркет: новая сборка успешно запустилась.',
    '',
    'Статус: сервер работает, API /api/points ответил 200.',
    ...pages.map(p => (p.ok ? '✅ ' : '⚠️ ') + p.path + ': HTTP ' + p.status + (p.ok ? ', содержимое проверено' : ', проверка не пройдена')),
    'Версия приложения: ' + version,
    'Идентификатор сборки: ' + info.build_id,
    'Коммит GitHub: ' + sha,
    '',
    'ЧТО ИЗМЕНИЛОСЬ В ЭТОЙ ВЕРСИИ',
    ...changes.map((item, i) => (i + 1) + '. ' + item),
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
  // Telegram and email are independent. A failed SMTP must not suppress Telegram.
  if (telegramPrevious?.build_id !== info.build_id) {
    const telegramText = [
      (allPagesOk ? '✅' : '⚠️') + ' <b>ХвостМаркет — новая версия запущена на Amvera</b>',
      'Версия: ' + escapeHtml(version),
      'Коммит: <code>' + escapeHtml(sha) + '</code>',
      'Сборка: ' + escapeHtml(info.build_id),
      'Проверка API: ✅ /api/points',
      ...pages.map(p => (p.ok ? '✅ ' : '⚠️ ') + escapeHtml(p.path) + ' — HTTP ' + p.status),
      'Время запуска (UTC): ' + escapeHtml(now.toISOString()),
      '',
      '<b>Изменения:</b>',
      ...changes.slice(0,12).map((item,i) => (i+1)+'. '+escapeHtml(item).slice(0,260)),
      '',
      'Проверки выполнены локально в Amvera; оплата и внешняя доступность не тестировались.'
    ].join('\n').slice(0,3950);
    try {
      const sent = await sendTelegram(telegramText);
      if (sent.ok) {
        fs.mkdirSync(DATA_DIR,{recursive:true});
        const tmp = LAST_TG_FILE+'.tmp-'+process.pid;
        fs.writeFileSync(tmp,JSON.stringify({build_id:info.build_id,git_commit:sha,sent_at:now.toISOString()}));
        fs.renameSync(tmp,LAST_TG_FILE);
        console.log('Deploy Telegram: уведомление отправлено',info.build_id);
      } else console.warn('Deploy Telegram: отправка не подтверждена',sent.error||'');
    } catch(e) {console.error('Deploy Telegram: ошибка',e.message);}
  }
  if (!recipient || previous?.build_id === info.build_id) return;
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
    fs.writeFileSync(tmp, JSON.stringify({ build_id: info.build_id, git_commit: sha, sent_at: now.toISOString() }));
    fs.renameSync(tmp, LAST_FILE);
    console.log('Deploy email: уведомление отправлено', info.build_id);
  } catch (e) {
    console.error('Deploy email: не удалось сохранить отметку', e.message);
  }
}

module.exports = { notifyDeployment, healthCheck };
