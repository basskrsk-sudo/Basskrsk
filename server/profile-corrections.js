// Общая проверка исправлений анкет грумеров и владельцев салонов.
// Только маршруты с requireAuth(['admin']) могут вызывать эти функции.
'use strict';

const FIELDS = ['full_name', 'phone', 'login', 'legal_form', 'inn', 'bank_details'];
const TRACKED = [...FIELDS, 'point_id', 'groomer_partner_id'];

class ProfileCorrectionError extends Error {}

function phoneSignature(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeProfile(existing, patch = {}) {
  const values = {};
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) {
      values[field] = existing[field] ?? null;
      continue;
    }
    const raw = patch[field];
    if (raw !== null && typeof raw !== 'string') {
      throw new ProfileCorrectionError('Неверный формат поля ' + field);
    }
    const normalized = String(raw ?? '').trim();
    values[field] = ['legal_form', 'inn', 'bank_details'].includes(field)
      ? (normalized || null) : normalized;
  }

  if (!values.full_name || values.full_name.length > 180) {
    throw new ProfileCorrectionError('Укажите ФИО (до 180 символов)');
  }
  if (!values.phone) throw new ProfileCorrectionError('Укажите телефон');
  if (!values.login) throw new ProfileCorrectionError('Укажите логин');

  if (values.full_name !== existing.full_name && values.full_name.length < 2) {
    throw new ProfileCorrectionError('ФИО должно содержать хотя бы два символа');
  }
  if (values.phone !== existing.phone) {
    const digits = values.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      throw new ProfileCorrectionError('Проверьте телефон: требуется от 10 до 15 цифр');
    }
  }
  if (values.login !== existing.login && !/^[\p{L}\p{N}._@-]{3,64}$/u.test(values.login)) {
    throw new ProfileCorrectionError('Логин: 3–64 символа, без пробелов');
  }
  if (values.legal_form !== (existing.legal_form || null) &&
      values.legal_form && !['npd', 'ip', 'ooo'].includes(values.legal_form)) {
    throw new ProfileCorrectionError('Некорректный юридический статус');
  }
  if (values.inn !== (existing.inn || null) &&
      values.inn && !/^(?:\d{10}|\d{12})$/.test(values.inn)) {
    throw new ProfileCorrectionError('ИНН должен содержать 10 или 12 цифр');
  }
  if (values.bank_details && values.bank_details.length > 2000) {
    throw new ProfileCorrectionError('Реквизиты не должны превышать 2000 символов');
  }

  return {
    values,
    phoneChanged: phoneSignature(values.phone) !== phoneSignature(existing.phone),
  };
}

function isLoginAvailable(db, table, login, id) {
  if (table !== 'partners' && table !== 'salon_owners') {
    throw new Error('Недопустимая таблица для проверки логина');
  }
  return !db.prepare('SELECT id FROM ' + table + ' WHERE login = ? AND id != ? LIMIT 1').get(login, id);
}

function logProfileCorrection(db, admin, type, existing, updated) {
  if (type !== 'partner' && type !== 'owner') throw new Error('Недопустимый тип анкеты');
  const changes = {};
  for (const field of TRACKED) {
    const before = existing[field] ?? null;
    const after = updated[field] ?? null;
    if (String(before ?? '') === String(after ?? '')) continue;
    changes[field] = field === 'bank_details'
      ? { old: before ? 'заполнены' : 'пусто', new: after ? 'обновлены' : 'пусто' }
      : { old: before, new: after };
  }
  if (!Object.keys(changes).length) return [];
  db.prepare(`
    INSERT INTO account_profile_change_log
      (admin_id, admin_login, subject_type, subject_id, subject_name, changes_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(admin.id, admin.login, type, existing.id, updated.full_name || existing.full_name, JSON.stringify(changes));
  return Object.keys(changes);
}

module.exports = {
  ProfileCorrectionError,
  normalizeProfile,
  isLoginAvailable,
  logProfileCorrection,
};
