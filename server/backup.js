// backup.js — резервное копирование базы данных на почту компании.
// Раз в сутки (и один раз при первом запуске сервера) создаёт консистентный
// снимок базы через SQL-команду VACUUM INTO (безопасно даже если в этот
// момент кто-то пишет в базу — в отличие от простого копирования файла)
// и отправляет вложением на BACKUP_EMAIL (или BUSINESS_COPY_EMAIL, если
// отдельный адрес для бэкапов не задан).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { sendEmail } = require('./email');
const { getRestorePaths, validateDatabaseFile } = require('./database-restore');

const BACKUP_EMAIL = process.env.BACKUP_EMAIL || process.env.BUSINESS_COPY_EMAIL || '';
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // раз в сутки

async function sendDatabaseBackup() {
  if (!BACKUP_EMAIL) {
    console.warn('Резервное копирование пропущено: не задан BACKUP_EMAIL или BUSINESS_COPY_EMAIL');
    return { ok: false, skipped: true };
  }

  const tempPath = path.join(path.dirname(db.DB_PATH), 'backup-tmp-' + Date.now() + '.db');
  try {
    // VACUUM INTO — создаёт полноценный, консистентный снимок базы отдельным
    // файлом прямо средствами SQLite, безопасно при параллельной работе сервера.
    db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    const fileBuffer = fs.readFileSync(tempPath);
    const sizeKb = Math.round(fileBuffer.length / 1024);

    const today = new Date().toLocaleDateString('ru-RU');
    const result = await sendEmail({
      to: BACKUP_EMAIL,
      subject: 'Резервная копия базы Тайга — ' + today,
      text: 'Во вложении — резервная копия базы данных сайта на ' + today + ' (размер ~' + sizeKb + ' КБ).\n\n' +
            'Это автоматическое письмо, отвечать на него не нужно. Файл можно открыть любой программой для просмотра SQLite (например, DB Browser for SQLite).',
      attachments: [{ filename: 'taiga-backup-' + today.replace(/\./g, '-') + '.db', content: fileBuffer, contentType: 'application/x-sqlite3' }],
    });

    if (result.ok) {
      console.log('Резервная копия базы отправлена на почту (' + sizeKb + ' КБ)');
    } else {
      console.error('Не удалось отправить резервную копию:', result.error || 'неизвестная ошибка');
    }
    return result;
  } catch (e) {
    console.error('Ошибка создания резервной копии:', e.message);
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) {}
  }
}

function scheduleBackups() {
  if (!BACKUP_EMAIL) {
    console.warn('Автоматическое резервное копирование выключено — не задан BACKUP_EMAIL/BUSINESS_COPY_EMAIL');
    return;
  }
  // Первый бэкап — вскоре после запуска сервера (не сразу, чтобы не мешать
  // старту), дальше — раз в сутки.
  setTimeout(sendDatabaseBackup, 2 * 60 * 1000); // через 2 минуты после старта
  setInterval(sendDatabaseBackup, BACKUP_INTERVAL_MS);
  console.log('Резервное копирование базы настроено: раз в сутки на ' + BACKUP_EMAIL);
}

function registerBackupRoutes(router) {
  const { sendJson } = require('./http-utils');
  const { requireAuth, requireSuperAdmin } = require('./routes-auth');
  // POST /api/backup/run — админ может запустить резервное копирование вручную, не дожидаясь суток
  router.post('/api/backup/run', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    const result = await sendDatabaseBackup();
    sendJson(res, result.ok ? 200 : 500, result);
  });

  // GET /api/backup/download — прямое скачивание файла базы в браузер, без
  // почты (не зависит от BACKUP_EMAIL/SMTP — работает всегда). Тот же
  // безопасный снимок через VACUUM INTO, что и у email-версии выше, просто
  // отдаётся сразу как файл. Удобно перед заливкой новой версии сайта —
  // один клик в админке, файл сразу на компьютере.
  router.get('/api/backup/download', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempPath = path.join(path.dirname(db.DB_PATH), 'backup-dl-' + Date.now() + '.db');
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
      const stat = fs.statSync(tempPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="taiga-backup-${stamp}.db"`,
      });
      const stream = fs.createReadStream(tempPath);
      stream.pipe(res);
      stream.on('close', () => fs.unlink(tempPath, () => {}));
      stream.on('error', () => fs.unlink(tempPath, () => {}));
    } catch (e) {
      console.error('[backup] Не удалось создать бэкап для скачивания:', e.message);
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Не удалось создать бэкап: ' + e.message }));
      }
    }
  });

  // POST /api/backup/restore — супер-админ загружает файл SQLite целиком.
  // Открытую базу здесь не заменяем: проверяем файл, создаём страховочную
  // копию текущего состояния и кладём загрузку в pending. После ответа
  // процесс завершается; на следующем запуске database-restore.js установит
  // pending-файл до открытия основного SQLite-соединения.
  router.post('/api/backup/restore', (req, res, ctx) => {
    const payload = ctx.authenticatedPayload || requireSuperAdmin(req, res, ctx);
    if (!payload) return;

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/octet-stream' && contentType !== 'application/x-sqlite3') {
      return sendJson(res, 415, { error: 'Загрузите файл базы данных в формате .db' });
    }
    if (!ctx.rawBody || ctx.rawBody.length < 100) {
      return sendJson(res, 400, { error: 'Файл базы данных пуст или повреждён' });
    }

    const paths = getRestorePaths();
    const uploadPath = path.join(paths.dataDir, 'restore-upload-' + Date.now() + '.db');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safetyBackupPath = path.join(paths.dataDir, 'taiga-before-restore-' + stamp + '-' + Date.now() + '.db');

    try {
      fs.mkdirSync(paths.dataDir, { recursive: true });
      fs.writeFileSync(uploadPath, ctx.rawBody, { mode: 0o600 });
      validateDatabaseFile(uploadPath);

      db.exec(`VACUUM INTO '${safetyBackupPath.replace(/'/g, "''")}'`);
      if (fs.existsSync(paths.pending)) fs.unlinkSync(paths.pending);
      fs.renameSync(uploadPath, paths.pending);

      sendJson(res, 202, {
        ok: true,
        message: 'Файл проверен. База будет восстановлена после перезапуска приложения.',
        safety_backup: path.basename(safetyBackupPath),
      });
      res.once('finish', () => {
        setTimeout(() => process.exit(0), 800);
      });
    } catch (e) {
      console.error('[backup] Не удалось подготовить восстановление:', e.message);
      try { if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch (_) {}
      try { if (fs.existsSync(paths.pending)) fs.unlinkSync(paths.pending); } catch (_) {}
      sendJson(res, 400, { error: 'Не удалось восстановить базу: ' + e.message });
    }
  });
}

module.exports = { sendDatabaseBackup, scheduleBackups, registerBackupRoutes };
