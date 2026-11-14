// backup.js — резервное копирование базы данных на почту компании.
// Создаёт консистентный снимок базы через SQL-команду VACUUM INTO
// не чаще раза в сутки после последней успешной отправки. Перезапуск
// Node.js не вызывает повторный бэкап, если предыдущий уже свежий.
// и отправляет вложением на BACKUP_EMAIL (или BUSINESS_COPY_EMAIL, если
// отдельный адрес для бэкапов не задан).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDatabaseSnapshot } = require('./database-snapshot');
const { trackAsync } = require('./runtime-diagnostics');
const db = require('./db');
const { sendEmail } = require('./email');
const { getRestorePaths, validateDatabaseFile } = require('./database-restore');

const BACKUP_EMAIL = process.env.BACKUP_EMAIL || process.env.BUSINESS_COPY_EMAIL || '';
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // раз в сутки
const BACKUP_START_DELAY_MS = 2 * 60 * 1000;
const BACKUP_RETRY_MS = 60 * 60 * 1000;

// The single successful-send timestamp lives in persistent SQLite /data.
// A deploy or crash must not reset the daily SMTP/snapshot budget.
db.exec(`CREATE TABLE IF NOT EXISTS backup_email_schedule (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_attempt_at TEXT,
  last_success_at TEXT
)`);

function backupScheduleState() {
  return db.prepare('SELECT last_attempt_at,last_success_at FROM backup_email_schedule WHERE id=1').get() || {};
}
function markBackupAttempt() {
  db.prepare(`INSERT INTO backup_email_schedule(id,last_attempt_at)
    VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`)
    .run(new Date().toISOString());
}
function markBackupSuccess() {
  db.prepare(`INSERT INTO backup_email_schedule(id,last_attempt_at,last_success_at)
    VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at`)
    .run(new Date().toISOString(), new Date().toISOString());
}
function nextBackupDelay(state = {}, nowMs = Date.now()) {
  const sentAt = Date.parse(state.last_success_at || '');
  const attemptedAt = Date.parse(state.last_attempt_at || '');
  const successWait = Number.isFinite(sentAt) ? sentAt + BACKUP_INTERVAL_MS - nowMs : 0;
  const retryWait = Number.isFinite(attemptedAt) ? attemptedAt + BACKUP_RETRY_MS - nowMs : 0;
  return Math.max(BACKUP_START_DELAY_MS, successWait, retryWait);
}

let backupInFlight = null;
async function performDatabaseBackup() {
  if (!BACKUP_EMAIL) {
    console.warn('Резервное копирование пропущено: не задан BACKUP_EMAIL или BUSINESS_COPY_EMAIL');
    return { ok: false, skipped: true };
  }

  const tempPath = path.join(path.dirname(db.DB_PATH), 'backup-tmp-' + randomUUID() + '.db');
  try {
    try { markBackupAttempt(); }
    catch (error) { console.warn('[backup] Не удалось сохранить время попытки:', error.code || 'unknown'); }
    // VACUUM INTO — создаёт полноценный, консистентный снимок базы отдельным
    // файлом прямо средствами SQLite, безопасно при параллельной работе сервера.
    await createDatabaseSnapshot(db.DB_PATH, tempPath);
    // Keep the SQLite file on disk and stream Base64 chunks to SMTP. The
    // snapshot is not copied into the Node.js heap on a small Amvera plan.
    const stat = await fs.promises.stat(tempPath);
    const sizeKb = Math.round(stat.size / 1024);

    const today = new Date().toLocaleDateString('ru-RU');
    const result = await sendEmail({
      to: BACKUP_EMAIL,
      subject: 'Резервная копия базы Тайга — ' + today,
      text: 'Во вложении — резервная копия базы данных сайта на ' + today + ' (размер ~' + sizeKb + ' КБ).\n\n' +
            'Это автоматическое письмо, отвечать на него не нужно. Файл можно открыть любой программой для просмотра SQLite (например, DB Browser for SQLite).',
      attachments: [{ filename: 'taiga-backup-' + today.replace(/\./g, '-') + '.db', filePath: tempPath, contentType: 'application/x-sqlite3' }],
    });

    if (result.ok) {
      try { markBackupSuccess(); }
      catch (error) { console.warn('[backup] Не удалось сохранить время успешной отправки:', error.code || 'unknown'); }
      console.log('Резервная копия базы отправлена на почту (' + sizeKb + ' КБ)');
    } else {
      console.error('Не удалось отправить резервную копию:', result.error || 'неизвестная ошибка');
    }
    return result;
  } catch (e) {
    console.error('Ошибка создания резервной копии:', e.message);
    return { ok: false, error: e.message };
  } finally {
    try { await fs.promises.unlink(tempPath); } catch (_) {}
  }
}

// Manual and scheduled copies share a single snapshot + SMTP send. This
// prevents duplicate mail and overlapping memory use after a restart.
function sendDatabaseBackup() {
  if (backupInFlight) return backupInFlight;
  backupInFlight = trackAsync('database_backup', performDatabaseBackup)
    .finally(() => { backupInFlight = null; });
  return backupInFlight;
}

function createBackupScheduler({
  readState = backupScheduleState,
  send = sendDatabaseBackup,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  enabled = Boolean(BACKUP_EMAIL),
} = {}) {
  let started = false, timer = null, running = false;
  function scheduleNext() {
    if (!started) return;
    let delay = BACKUP_START_DELAY_MS;
    try { delay = nextBackupDelay(readState(), now()); }
    catch (error) { console.warn('[backup] Не удалось прочитать расписание:', error.code || 'unknown'); }
    timer = setTimer(() => {
      timer = null;
      return runTick();
    }, delay);
    timer?.unref?.();
  }
  async function runTick() {
    if (!started || running) return;
    running = true;
    try {
      // A manual backup might have succeeded while the timer was waiting.
      // Recheck the database before any expensive snapshot or SMTP upload.
      if (nextBackupDelay(readState(), now()) <= BACKUP_START_DELAY_MS) {
        await send();
      }
    } catch (error) {
      console.warn('[backup] Фоновая отправка не удалась:', error.code || error.message);
    } finally {
      running = false;
      if (started) scheduleNext();
    }
  }
  return {
    start() {
      if (!enabled || started) return;
      started = true;
      scheduleNext();
    },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
const scheduledBackup = createBackupScheduler();
function scheduleBackups() {
  if (!BACKUP_EMAIL) {
    console.warn('Автоматическое резервное копирование выключено — не задан BACKUP_EMAIL/BUSINESS_COPY_EMAIL');
    return;
  }
  scheduledBackup.start();
  console.log('Резервное копирование базы настроено: по факту последней успешной отправки, раз в сутки на ' + BACKUP_EMAIL);
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
  router.get('/api/backup/download', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tempPath = path.join(path.dirname(db.DB_PATH), 'backup-dl-' + randomUUID() + '.db');
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      await createDatabaseSnapshot(db.DB_PATH, tempPath);
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
  router.post('/api/backup/restore', async (req, res, ctx) => {
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
    const safetyBackupPath = path.join(paths.dataDir, 'taiga-before-restore-' + stamp + '-' + randomUUID() + '.db');

    try {
      fs.mkdirSync(paths.dataDir, { recursive: true });
      fs.writeFileSync(uploadPath, ctx.rawBody, { mode: 0o600 });
      validateDatabaseFile(uploadPath);

      await createDatabaseSnapshot(db.DB_PATH, safetyBackupPath);
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

module.exports = {
  sendDatabaseBackup, scheduleBackups, registerBackupRoutes,
  createBackupScheduler, nextBackupDelay, BACKUP_INTERVAL_MS,
  BACKUP_START_DELAY_MS, BACKUP_RETRY_MS,
};
