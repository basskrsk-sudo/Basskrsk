// salon-page-storage.js — независимая страховочная копия страниц салонов.
//
// Основные данные по-прежнему хранятся в /data/taiga.db. Дополнительный JSON
// в той же постоянной папке защищает страницы партнёров от случайной замены
// базы старым файлом или миграции, очистившей поля. Код приложения и public/
// при деплое пересобираются, а /data остаётся между версиями.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'salon-pages-backup.json');
const SALON_FIELDS = [
  'salon_tagline',
  'salon_description',
  'salon_photo_url',
  'salon_photo_urls',
  'salon_instagram',
  'salon_vk',
  'salon_website',
];

function getSalonPages() {
  return db.prepare(`
    SELECT id, name, addr, salon_tagline, salon_description, salon_photo_url, salon_photo_urls,
           salon_instagram, salon_vk, salon_website, salon_page_published,
           salon_page_updated_at
    FROM points
    WHERE salon_tagline IS NOT NULL OR salon_description IS NOT NULL OR
          salon_photo_url IS NOT NULL OR (salon_photo_urls IS NOT NULL AND salon_photo_urls != '[]') OR salon_instagram IS NOT NULL OR
          salon_vk IS NOT NULL OR salon_website IS NOT NULL OR
          salon_page_published = 1
    ORDER BY id
  `).all();
}

function hasContent(row) {
  return SALON_FIELDS.some((field) => {
    if (field === 'salon_photo_urls') {
      try { return Array.isArray(JSON.parse(row[field] || '[]')) && JSON.parse(row[field] || '[]').length > 0; }
      catch (e) { return false; }
    }
    return row[field] !== null && row[field] !== undefined && String(row[field]).trim();
  })
    || !!row.salon_page_published;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeSalonPagesSnapshot() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const snapshot = {
    version: 1,
    saved_at: new Date().toISOString(),
    salons: getSalonPages(),
  };
  const temporaryPath = `${SNAPSHOT_PATH}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, SNAPSHOT_PATH);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return snapshot.salons.length;
}

function restoreSalonPagesSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return 0;
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.salons)) {
    throw new Error('неподдерживаемый формат salon-pages-backup.json');
  }

  const findPoint = db.prepare(`
    SELECT id, salon_tagline, salon_description, salon_photo_url, salon_photo_urls,
           salon_instagram, salon_vk, salon_website, salon_page_published,
           salon_page_updated_at
    FROM points WHERE id = ?
  `);
  const updatePoint = db.prepare(`
    UPDATE points SET
      salon_tagline = ?, salon_description = ?, salon_photo_url = ?, salon_photo_urls = ?,
      salon_instagram = ?, salon_vk = ?, salon_website = ?,
      salon_page_published = ?, salon_page_updated_at = ?
    WHERE id = ?
  `);

  let restored = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const saved of snapshot.salons) {
      if (!saved || typeof saved.id !== 'string' || !hasContent(saved)) continue;
      const current = findPoint.get(saved.id);
      if (!current) continue;

      // Снимки v60 создавались до появления галереи и содержат только одну
      // ссылку. Достраиваем новое поле на лету, не требуя ручной миграции JSON.
      if (saved.salon_photo_urls == null) {
        saved.salon_photo_urls = JSON.stringify(saved.salon_photo_url ? [saved.salon_photo_url] : []);
      }

      const savedTime = timestamp(saved.salon_page_updated_at);
      const currentTime = timestamp(current.salon_page_updated_at);
      // Более новая правка в БД всегда важнее снимка. При равном времени
      // снимок может безопасно восстановить случайно очищенные поля.
      if (currentTime > savedTime) continue;

      const changed = SALON_FIELDS.some((field) => (current[field] || null) !== (saved[field] || null))
        || !!current.salon_page_published !== !!saved.salon_page_published;
      if (!changed) continue;

      updatePoint.run(
        ...SALON_FIELDS.map((field) => saved[field] == null ? null : String(saved[field])),
        saved.salon_page_published ? 1 : 0,
        saved.salon_page_updated_at || '1970-01-01T00:00:00.000Z',
        saved.id
      );
      restored += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return restored;
}

function initializeSalonPagePersistence() {
  let restored = 0;
  try {
    restored = restoreSalonPagesSnapshot();
    if (restored) console.log(`Страницы салонов восстановлены из страховочной копии: ${restored}`);
  } catch (error) {
    console.error(`Не удалось восстановить страницы салонов: ${error.message}`);
  }

  try {
    const saved = writeSalonPagesSnapshot();
    console.log(`Страховочная копия страниц салонов: ${SNAPSHOT_PATH} (${saved})`);
  } catch (error) {
    console.error(`Не удалось сохранить страховочную копию страниц салонов: ${error.message}`);
  }
  return restored;
}

module.exports = {
  SNAPSHOT_PATH,
  writeSalonPagesSnapshot,
  restoreSalonPagesSnapshot,
  initializeSalonPagePersistence,
};
