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
  const { requireAuth } = require('./routes-auth');
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
}

module.exports = { sendDatabaseBackup, scheduleBackups, registerBackupRoutes };
