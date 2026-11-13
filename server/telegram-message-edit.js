// Edit already published messages in the configured Partner Club Telegram group.
// No new poller or timers: drafts are stored in SQLite and expire on access.
'use strict';

const db = require('./db');
const { htmlFromTelegramEntities } = require('./telegram-formatting');

const EDIT_COMMAND = /^\/edit(?:@[a-zA-Z0-9_]+)?$/i;
let ownBotId = null;

db.exec(
  'CREATE TABLE IF NOT EXISTS telegram_message_edit_drafts (' +
    'editor_chat_id TEXT PRIMARY KEY,' +
    'target_chat_id TEXT NOT NULL,' +
    'target_message_id INTEGER NOT NULL,' +
    "target_kind TEXT NOT NULL CHECK(target_kind IN ('text','caption'))," +
    'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ');'
);

function isLinkedAdmin(chatId) {
  if (chatId == null) return false;
  return !!db.prepare(
    "SELECT 1 FROM admins WHERE active=1 AND role IN ('super','admin') " +
    'AND CAST(telegram_chat_id AS TEXT)=? LIMIT 1'
  ).get(String(chatId));
}

function configuredGroupId() {
  return String(require('./routes-partner-club').settings().chat_id || '');
}

function cancelEdit(chatId) {
  if (chatId == null) return false;
  return db.prepare('DELETE FROM telegram_message_edit_drafts WHERE editor_chat_id=?')
    .run(String(chatId)).changes > 0;
}

function getDraft(chatId) {
  const draft = db.prepare(
    "SELECT target_chat_id,target_message_id,target_kind " +
    "FROM telegram_message_edit_drafts WHERE editor_chat_id=? " +
    "AND created_at>=datetime('now','-20 minutes')"
  ).get(String(chatId));
  if (!draft) cancelEdit(chatId);
  return draft || null;
}

async function ownId(botApi) {
  if (ownBotId) return ownBotId;
  const me = await botApi('getMe', {});
  if (!me || !me.id) throw new Error('Не удалось проверить Telegram-бота');
  ownBotId = String(me.id);
  return ownBotId;
}

async function startGroupEdit(message, botApi) {
  if (!['group', 'supergroup'].includes(message?.chat?.type) ||
      !EDIT_COMMAND.test(String(message.text || '').trim())) return null;

  if (!configuredGroupId() || String(message.chat.id) !== configuredGroupId()) {
    return { message: 'Команда /edit доступна только в подключённой группе Клуба партнёров.' };
  }
  const senderId = message.from?.id;
  if (!isLinkedAdmin(senderId)) {
    return { message: '🔒 Редактировать публикации может только привязанный администратор ХвостМаркета.' };
  }
  const original = message.reply_to_message;
  if (!original || !Number.isSafeInteger(original.message_id) ||
      (typeof original.text !== 'string' && typeof original.caption !== 'string')) {
    return { message: 'Ответьте командой /edit на текстовую публикацию бота или сообщение бота с фотографией.' };
  }
  try {
    if (String(original.from?.id || '') !== await ownId(botApi)) {
      return { message: 'Можно редактировать только сообщения, отправленные этим ботом.' };
    }
  } catch (error) {
    console.warn('[telegram-message-edit] Bot identity lookup failed:', error.message);
    return { message: '⚠️ Не удалось проверить автора публикации. Повторите /edit позже.' };
  }

  const kind = typeof original.text === 'string' ? 'text' : 'caption';
  const current = kind === 'text' ? original.text : original.caption;
  const preview = current.length > 1500 ? current.slice(0, 1500) + '\n…' : current;
  try {
    await botApi('sendMessage', {
      chat_id: senderId,
      text: '✏️ Редактирование публикации Клуба партнёров.\n\n' +
        'Сейчас опубликовано:\n' + preview + '\n\n' +
        'Пришлите новым сообщением исправленный текст. ' +
        'Бот заменит исходное сообщение в группе. /cancel — отмена. ' +
        'Черновик действует 20 минут.'
    });
  } catch (error) {
    return { message: '⚠️ Не могу написать вам лично. Откройте чат с ботом, нажмите /start и повторите /edit ответом на публикацию.' };
  }

  db.prepare(
    'INSERT INTO telegram_message_edit_drafts ' +
    '(editor_chat_id,target_chat_id,target_message_id,target_kind,created_at) ' +
    'VALUES (?,?,?,?,CURRENT_TIMESTAMP) ' +
    'ON CONFLICT(editor_chat_id) DO UPDATE SET ' +
    'target_chat_id=excluded.target_chat_id,' +
    'target_message_id=excluded.target_message_id,' +
    'target_kind=excluded.target_kind,created_at=CURRENT_TIMESTAMP'
  ).run(String(senderId), String(message.chat.id), original.message_id, kind);

  return { message: '✏️ Открыл редактирование в вашем личном чате с ботом.' };
}

async function handlePrivateMessage(message, botApi) {
  if (message?.chat?.type !== 'private' || typeof message.text !== 'string') return null;
  const chatId = message.chat.id;
  const draft = getDraft(chatId);
  if (!draft) return null;
  if (String(message.from?.id || '') !== String(chatId)) {
    return { message: '🔒 Отправить исправленный текст может только владелец личного чата.' };
  }

  const raw = message.text;
  // Other bot commands should retain their normal behavior and not become post content.
  // The shared /cancel handler below handles cancellation alongside other workflows.
  if (raw.trim().startsWith('/')) {
    if (!/^\/cancel(?:@\w+)?$/i.test(raw.trim())) cancelEdit(chatId);
    return null;
  }
  if (!isLinkedAdmin(chatId) || configuredGroupId() !== draft.target_chat_id) {
    cancelEdit(chatId);
    return { message: '🔒 Доступ к редактированию отозван или группа изменилась. Начните заново с /edit.' };
  }
  const limit = draft.target_kind === 'caption' ? 1024 : 4096;
  if (!raw.trim() || raw.length > limit) {
    return { message: '⚠️ Пришлите непустой текст не длиннее ' + limit + ' символов.' };
  }

  const formatted = htmlFromTelegramEntities(raw, message.entities);
  const method = draft.target_kind === 'caption' ? 'editMessageCaption' : 'editMessageText';
  const payload = {
    chat_id: draft.target_chat_id,
    message_id: draft.target_message_id,
    parse_mode: 'HTML',
    ...(draft.target_kind === 'caption' ? { caption: formatted } : { text: formatted })
  };
  try {
    await botApi(method, payload);
  } catch (error) {
    if (!/message is not modified/i.test(error.message || '')) {
      console.warn('[telegram-message-edit] Cannot edit original message:', error.message);
      if (/message (?:can't be edited|to edit not found)/i.test(error.message || '')) {
        cancelEdit(chatId);
        return { message: '⚠️ Telegram больше не позволяет изменить эту публикацию. Начните с другой.' };
      }
      return { message: '⚠️ Telegram не подтвердил изменение. Черновик сохранён — отправьте исправленный текст ещё раз или /cancel.' };
    }
  }
  cancelEdit(chatId);
  return { message: '✅ Исходное сообщение в Клубе партнёров обновлено.' };
}

module.exports = { startGroupEdit, handlePrivateMessage, cancelEdit, isLinkedAdmin };
