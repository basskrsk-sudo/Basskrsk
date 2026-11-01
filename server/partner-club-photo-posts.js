// Telegram-native attachments for moderated manual Partner Club publications.
// Only Telegram file_ids are stored; images are never uploaded to the website.
'use strict';

const db = require('./db');

const MAX_PHOTOS = 10;
const MAX_PHOTO_CAPTION_HTML = 850; // reserve headroom for preview header (<1024 Telegram limit)
const MAX_FILE_ID_LENGTH = 300;

db.exec(
  'CREATE TABLE IF NOT EXISTS partner_club_event_photos (' +
    'event_id INTEGER NOT NULL REFERENCES partner_club_events(id) ON DELETE CASCADE,' +
    'position INTEGER NOT NULL,' +
    'file_id TEXT NOT NULL,' +
    'PRIMARY KEY(event_id, position),' +
    'UNIQUE(event_id, file_id)' +
  ');' +
  'CREATE TABLE IF NOT EXISTS partner_club_photo_drafts (' +
    'chat_id TEXT PRIMARY KEY,' +
    'event_id INTEGER,' +
    "photos_json TEXT NOT NULL DEFAULT '[]'," +
    'post_text TEXT,' +
    'post_html TEXT,' +
    'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ');'
);

function validFileId(value) {
  return typeof value === 'string' &&
    value.length >= 12 && value.length <= MAX_FILE_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function photoIdsFromMessage(message) {
  if (!Array.isArray(message?.photo) || !message.photo.length) return [];
  // The final PhotoSize is normally the largest accessible Telegram photo.
  const photo = message.photo[message.photo.length - 1];
  return validFileId(photo?.file_id) ? [photo.file_id] : [];
}

function sanitizePhotoList(value) {
  let raw = value;
  if (typeof value === 'string') {
    try { raw = JSON.parse(value); } catch (_) { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(validFileId))].slice(0, MAX_PHOTOS);
}

function getEventPhotos(eventId) {
  return db.prepare(
    'SELECT file_id FROM partner_club_event_photos WHERE event_id=? ORDER BY position ASC'
  ).all(Number(eventId)).map(row => row.file_id);
}
function attachEventPhotos(eventId, fileIds) {
  const next = sanitizePhotoList(fileIds);
  const existing = getEventPhotos(eventId);
  const additions = next.filter(fileId => !existing.includes(fileId));
  if (existing.length + additions.length > MAX_PHOTOS) return { ok: false, error: 'Можно прикрепить не больше 10 фотографий.' };
  const insert = db.prepare(
    'INSERT OR IGNORE INTO partner_club_event_photos(event_id,position,file_id) VALUES(?,?,?)'
  );
  let index = existing.length;
  for (const fileId of additions) insert.run(Number(eventId), index++, fileId);
  return { ok: true, total: existing.length + additions.length };
}
function clearEventPhotos(eventId) {
  return db.prepare('DELETE FROM partner_club_event_photos WHERE event_id=?')
    .run(Number(eventId)).changes;
}

function currentPhotoDraft(chatId) {
  const chat = String(chatId || '');
  const row = db.prepare(
    "SELECT chat_id,event_id,photos_json,post_text,post_html FROM partner_club_photo_drafts " +
    "WHERE chat_id=? AND updated_at>=datetime('now','-2 hours')"
  ).get(chat);
  if (!row) {
    db.prepare('DELETE FROM partner_club_photo_drafts WHERE chat_id=?').run(chat);
    return null;
  }
  return {
    chat_id: row.chat_id,
    event_id: row.event_id,
    photos: sanitizePhotoList(row.photos_json),
    post_text: row.post_text,
    post_html: row.post_html,
  };
}

function beginPhotoDraft(chatId, eventId = null) {
  db.prepare(
    "INSERT INTO partner_club_photo_drafts(chat_id,event_id,photos_json,updated_at) " +
    "VALUES(?,?,'[]',CURRENT_TIMESTAMP) " +
    "ON CONFLICT(chat_id) DO UPDATE SET event_id=excluded.event_id," +
    "photos_json='[]',post_text=NULL,post_html=NULL,updated_at=CURRENT_TIMESTAMP"
  ).run(String(chatId), eventId == null ? null : Number(eventId));
  return currentPhotoDraft(chatId);
}
function stagePhoto(chatId, fileId, formatted = null) {
  if (!validFileId(fileId)) return { ok: false, error: 'Telegram не передал корректную фотографию.' };
  let draft = currentPhotoDraft(chatId);
  if (!draft) draft = beginPhotoDraft(chatId);
  if (!draft.photos.includes(fileId) && draft.photos.length >= MAX_PHOTOS) {
    return { ok: false, error: 'Максимум 10 фотографий. Нажмите «Готово» или отмените добавление.' };
  }
  if (formatted && formatted.plain &&
      (!formattedOk(formatted) || formatted.plain.length > MAX_PHOTO_CAPTION_HTML)) {
    return { ok: false, error: 'Для сообщения с фотографиями сократите подпись до 850 символов.' };
  }
  const files = draft.photos.includes(fileId) ? draft.photos : [...draft.photos, fileId];
  const text = draft.event_id == null && formatted?.plain ? formatted.plain : draft.post_text;
  const rich = draft.event_id == null && formatted?.plain ? formatted.html : draft.post_html;
  db.prepare(
    'UPDATE partner_club_photo_drafts SET photos_json=?,post_text=?,post_html=?,' +
    'updated_at=CURRENT_TIMESTAMP WHERE chat_id=?'
  ).run(JSON.stringify(files), text || null, rich || null, String(chatId));
  return { ok: true, total: files.length, first: draft.photos.length === 0, duplicate: draft.photos.includes(fileId) };
}
function formattedOk(formatted) {
  return !!formatted && typeof formatted.plain === 'string' &&
    typeof formatted.html === 'string' &&
    formatted.plain.length <= MAX_PHOTO_CAPTION_HTML &&
    formatted.html.length <= MAX_PHOTO_CAPTION_HTML;
}
function stageText(chatId, formatted) {
  const draft = currentPhotoDraft(chatId);
  if (!draft || draft.event_id != null) return { ok: false, error: 'Черновик для нового текста не найден.' };
  if (!formattedOk(formatted) || !formatted.plain.trim())
    return { ok: false, error: 'Для публикации с фото текст должен быть не длиннее 850 символов.' };
  db.prepare(
    'UPDATE partner_club_photo_drafts SET post_text=?,post_html=?,updated_at=CURRENT_TIMESTAMP WHERE chat_id=?'
  ).run(formatted.plain, formatted.html, String(chatId));
  return { ok: true, total: draft.photos.length };
}
function clearPhotoDraft(chatId) {
  return db.prepare('DELETE FROM partner_club_photo_drafts WHERE chat_id=?')
    .run(String(chatId)).changes > 0;
}

module.exports = {
  MAX_PHOTOS, MAX_PHOTO_CAPTION_HTML, validFileId, photoIdsFromMessage,
  getEventPhotos, attachEventPhotos, clearEventPhotos,
  currentPhotoDraft, beginPhotoDraft, stagePhoto, stageText,
  formattedOk, clearPhotoDraft,
};
