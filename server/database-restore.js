// database-restore.js — проверка загруженной SQLite-базы и её безопасная
// установка ДО открытия основного соединения в db.js.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function getRestorePaths() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    dataDir,
    database: path.join(dataDir, 'taiga.db'),
    pending: path.join(dataDir, 'taiga-restore-pending.db'),
  };
}

function validateDatabaseFile(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.toString('utf8') !== 'SQLite format 3\u0000') {
      throw new Error('Выбранный файл не является базой SQLite');
    }
  } finally {
    fs.closeSync(fd);
  }

  let candidate;
  try {
    candidate = new DatabaseSync(filePath, { readOnly: true });
    const integrityRows = candidate.prepare('PRAGMA integrity_check').all();
    const integrityOk = integrityRows.length === 1 && Object.values(integrityRows[0])[0] === 'ok';
    if (!integrityOk) throw new Error('Проверка целостности базы не пройдена');

    const requiredTables = ['admins', 'products', 'orders'];
    const placeholders = requiredTables.map(() => '?').join(',');
    const rows = candidate.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${placeholders})`
    ).all(...requiredTables);
    const found = new Set(rows.map((row) => row.name));
    const missing = requiredTables.filter((name) => !found.has(name));
    if (missing.length) throw new Error('В файле нет обязательных таблиц базы «Тайги»');
  } finally {
    if (candidate) candidate.close();
  }
}

function applyPendingDatabaseRestore() {
  const paths = getRestorePaths();
  if (!fs.existsSync(paths.pending)) return false;

  fs.mkdirSync(paths.dataDir, { recursive: true });
  validateDatabaseFile(paths.pending);

  // WAL/SHM относятся к прежней базе. После штатного закрытия процесса они
  // не нужны, а рядом с восстановленным файлом могут привести к смешиванию
  // данных двух разных версий.
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(paths.database + suffix); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  fs.renameSync(paths.pending, paths.database);
  console.log('Восстановление базы завершено: загруженная копия установлена.');
  return true;
}

module.exports = { getRestorePaths, validateDatabaseFile, applyPendingDatabaseRestore };
