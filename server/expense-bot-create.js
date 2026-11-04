// expense-bot-create.js — пошаговое внесение бизнес-трат из Telegram.
'use strict';

const db = require('./db');
const { localDate } = require('./task-reminders');

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const ATTACH_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PENDING_ATTACHMENTS = 12;
const INVESTORS = Object.freeze({
  alexey: 'Лакомых Алексей',
  vitaly: 'Соколов Виталий',
  nikolay: 'Кучкин Николай',
});

function actorForChat(channel, chatId) {
  if (channel !== 'telegram' || !chatId) return null;
  const admin = db.prepare(`
    SELECT id, full_name, login FROM admins
    WHERE active = 1 AND telegram_chat_id = ?
    ORDER BY CASE role WHEN 'super' THEN 0 ELSE 1 END, id LIMIT 1
  `).get(String(chatId));
  if (admin) {
    return { role: 'admin', id: admin.id, name: admin.full_name || admin.login || 'Администратор' };
  }
  const assignee = db.prepare(`
    SELECT id, full_name FROM task_assignees
    WHERE active = 1 AND telegram_chat_id = ?
    ORDER BY id LIMIT 1
  `).get(String(chatId));
  return assignee ? { role: 'task_assignee', id: assignee.id, name: assignee.full_name } : null;
}

function expenseButton() {
  return { inline_keyboard: [[{ text: '💳 Добавить трату', callback_data: 'expense:start' }]] };
}

function dateButtons() {
  return {
    inline_keyboard: [
      [
        { text: 'Сегодня', callback_data: 'expense:date:today' },
        { text: 'Вчера', callback_data: 'expense:date:yesterday' },
      ],
      [
        { text: 'Позавчера', callback_data: 'expense:date:two-days-ago' },
        { text: '7 дней назад', callback_data: 'expense:date:week-ago' },
      ],
      [{ text: '📅 Другая дата', callback_data: 'expense:date:manual' }],
      [{ text: '✕ Отмена', callback_data: 'expense:cancel' }],
    ],
  };
}

function investorButtons() {
  return {
    inline_keyboard: [
      [
        { text: 'Алексей', callback_data: 'expense:investor:alexey' },
        { text: 'Виталий', callback_data: 'expense:investor:vitaly' },
      ],
      [{ text: 'Николай', callback_data: 'expense:investor:nikolay' }],
      [{ text: '✕ Отмена', callback_data: 'expense:cancel' }],
    ],
  };
}

function confirmButtons() {
  return {
    inline_keyboard: [
      [{ text: '✅ Записать трату', callback_data: 'expense:confirm' }],
      [{ text: '✕ Отмена', callback_data: 'expense:cancel' }],
    ],
  };
}

function attachmentButtons(expenseId) {
  return { inline_keyboard:[
    [{text:'📎 Прикрепить чек',callback_data:'expense:attach:help:'+expenseId}],
    [{text:'🔄 Повторить ожидающие файлы',callback_data:'expense:attach:retry:'+expenseId}],
    [{text:'✅ Готово, больше файлов нет',callback_data:'expense:attach:done:'+expenseId}],
  ]};
}

function attachmentInstructions(expenseId,number) {
  return [
    '📎 Прикрепление к трате №'+expenseId,
    number ? 'Добавлено подтверждающих файлов: '+number+' из 12.' : '',
    'Нажмите скрепку 📎 рядом с полем сообщения Telegram и пришлите фото чека или документ.',
    'Можно отправить несколько файлов по очереди: PDF, JPG, PNG, HEIC, Word, Excel и другие разрешённые форматы (до 10 МБ каждый).',
    'Закончив загрузку, нажмите «✅ Готово». Чек сохранится в закрытом архиве трат.',
  ].filter(Boolean).join('\n\n');
}

function parsePendingAttachments(draft) {
  try {
    const items = JSON.parse(draft?.pending_attachments || '[]');
    return Array.isArray(items) ? items.slice(0, MAX_PENDING_ATTACHMENTS) : [];
  } catch (_) { return []; }
}

function queueExpenseAttachment(channel,chatId,file) {
  const draft=draftForChat(channel,chatId);
  if(!draft || draft.step!=='confirm')return null;
  const actor=actorForChat(channel,chatId);
  if(!actor || actor.role!==draft.creator_role || Number(actor.id)!==Number(draft.creator_id))
    return {ok:false,message:'Нет доступа к файлам этой траты.'};
  const existing=parsePendingAttachments(draft);
  if(existing.some(item=>item.fileId===file.fileId)) {
    return {ok:true,queued:true,message:'ℹ️ Этот файл уже ожидает сохранения.\n\n' +
      'Нажмите «✅ Записать трату», чтобы прикрепить его.',replyMarkup:confirmButtons()};
  }
  if(existing.length>=MAX_PENDING_ATTACHMENTS)
    return {ok:false,message:'Можно добавить не более 12 подтверждающих файлов к одной трате.',
      replyMarkup:confirmButtons()};
  const items=[...existing,{fileId:file.fileId,filename:file.filename,size:file.size||0}];
  db.prepare("UPDATE expense_bot_drafts SET pending_attachments=?, updated_at=datetime('now') " +
    "WHERE channel=? AND chat_id=? AND step='confirm'")
    .run(JSON.stringify(items),channel,String(chatId));
  return {ok:true,queued:true,
    message:'✅ Файл принят ('+items.length+' из 12).\n\n' +
      'Трата пока не записана. Нажмите «✅ Записать трату» — файл автоматически прикрепится после сохранения.',
    replyMarkup:confirmButtons()};
}

function pendingSavedExpenseAttachments(channel,chatId) {
  const state=activeExpenseAttachment(channel,chatId);
  if(!state || state.denied)return null;
  const draft=draftForChat(channel,chatId);
  return {expenseId:state.expenseId,actor:state.actor,files:parsePendingAttachments(draft)};
}

function markPendingAttachmentStored(channel,chatId,expenseId,fileId) {
  const state=pendingSavedExpenseAttachments(channel,chatId);
  if(!state || state.expenseId!==expenseId)return false;
  const remaining=state.files.filter(file=>file.fileId!==fileId);
  if(remaining.length===state.files.length)return false;
  db.prepare("UPDATE expense_bot_drafts SET pending_attachments=?,updated_at=datetime('now') " +
    "WHERE channel=? AND chat_id=? AND step='attach' AND expense_id=?")
    .run(JSON.stringify(remaining),channel,String(chatId),expenseId);
  return true;
}

function activeExpenseAttachment(channel,chatId) {
  const draft=draftForChat(channel,chatId);
  if(!draft || draft.step!=='attach' || !draft.expense_id) return null;
  const active=actorForChat(channel,chatId);
  if(!active || active.role!==draft.creator_role ||
      Number(active.id)!==Number(draft.creator_id))return {denied:true};
  const expense=db.prepare('SELECT id FROM expenses WHERE id=?').get(draft.expense_id);
  if(!expense)return {denied:true};
  return {expenseId:expense.id,actor:active};
}

function attachmentCount(expenseId){
  return db.prepare('SELECT COUNT(*) AS total FROM expense_documents WHERE expense_id=?')
    .get(expenseId).total;
}

function parseDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year;
  let month;
  let day;
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else {
    match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!match) return null;
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseAmount(value) {
  const normalized = String(value || '')
    .replace(/[₽рrub]/gi, '')
    .replace(/\s+/g, '')
    .replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount);
}

function draftForChat(channel, chatId) {
  const draft = db.prepare(`
    SELECT * FROM expense_bot_drafts
    WHERE channel = ? AND chat_id = ? AND datetime(expires_at) > datetime('now')
  `).get(channel, String(chatId));
  if (draft) return draft;
  db.prepare('DELETE FROM expense_bot_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId));
  return null;
}

function cancelExpenseCreation(channel, chatId) {
  return db.prepare('DELETE FROM expense_bot_drafts WHERE channel = ? AND chat_id = ?')
    .run(channel, String(chatId)).changes > 0;
}

function defaultCityId() {
  const krasnoyarsk = db.prepare("SELECT id FROM cities WHERE id = 'krsk' AND active = 1").get();
  if (krasnoyarsk) return krasnoyarsk.id;
  const first = db.prepare('SELECT id FROM cities WHERE active = 1 ORDER BY id LIMIT 1').get();
  return first ? first.id : 'krsk';
}

function startExpenseCreation(channel, chatId) {
  const actor = actorForChat(channel, chatId);
  if (!actor) {
    return {
      ok: false,
      message: 'Добавлять траты могут только подключённые администраторы и ответственные. Сначала подключите Telegram в админке.',
    };
  }
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
  db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  db.prepare('DELETE FROM task_bot_create_drafts WHERE channel = ? AND chat_id = ?').run(channel, String(chatId));
  db.prepare(`
    INSERT OR REPLACE INTO expense_bot_drafts
      (channel, chat_id, creator_role, creator_id, creator_name, step, city_id, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'date', ?, ?, datetime('now'))
  `).run(channel, String(chatId), actor.role, actor.id, actor.name, defaultCityId(), expiresAt);
  return {
    ok: true,
    message: '💳 Новая трата\n\nВыберите дату кнопкой или укажите любую прошедшую дату сообщением в формате ДД.ММ.ГГГГ (например, 02.11.2026).',
    replyMarkup: dateButtons(),
  };
}

function setDraftDate(channel, chatId, expenseDate) {
  const draft = draftForChat(channel, chatId);
  if (!draft || draft.step !== 'date') {
    return { ok: false, message: 'Черновик траты устарел. Начните заново командой /expense.' };
  }
  if (!parseDate(expenseDate) || expenseDate > localDate()) {
    return { ok: false, message: 'Укажите реальную дату не позднее сегодняшней. Можно выбрать любую прошедшую дату.',
      replyMarkup: dateButtons() };
  }
  db.prepare(`
    UPDATE expense_bot_drafts
    SET expense_date = ?, step = 'investor', updated_at = datetime('now')
    WHERE channel = ? AND chat_id = ?
  `).run(expenseDate, channel, String(chatId));
  return {
    ok: true,
    message: 'Дата: ' + expenseDate + '.\n\nВыберите инвестора, который оплатил эту трату.',
    replyMarkup: investorButtons(),
  };
}

function setDraftInvestor(channel, chatId, investorKey) {
  const draft = draftForChat(channel, chatId);
  const investorName = INVESTORS[investorKey];
  if (!draft || draft.step !== 'investor') {
    return { ok: false, message: 'Черновик траты устарел. Начните заново командой /expense.' };
  }
  if (!investorName) {
    return { ok: false, message: 'Выберите инвестора одной из кнопок.', replyMarkup: investorButtons() };
  }
  db.prepare(`
    UPDATE expense_bot_drafts
    SET investor_name = ?, step = 'amount', updated_at = datetime('now')
    WHERE channel = ? AND chat_id = ?
  `).run(investorName, channel, String(chatId));
  return { ok: true, message: 'Инвестор: ' + investorName + '.\n\nВведите сумму в рублях, например 12500.' };
}

function confirmationMessage(draft) {
  return [
    'Проверьте трату перед сохранением:',
    '',
    'Дата: ' + draft.expense_date,
    'Инвестор: ' + draft.investor_name,
    'Сумма: ' + Number(draft.amount).toLocaleString('ru-RU') + ' ₽',
    'Назначение: ' + draft.purpose,
  ].join('\n');
}

function finishExpenseCreation(channel, chatId) {
  const draft = draftForChat(channel, chatId);
  if(draft && draft.step==='attach' && draft.expense_id){
    return {ok:true,created:false,expenseId:draft.expense_id,
      message:'Трата №'+draft.expense_id+' уже записана.\n\n'+
        attachmentInstructions(draft.expense_id,attachmentCount(draft.expense_id)),
      replyMarkup:attachmentButtons(draft.expense_id)};
  }
  if (!draft || draft.step !== 'confirm' || !draft.expense_date || !draft.investor_name || !draft.amount || !draft.purpose) {
    return { ok: false, message: 'Черновик траты неполный или устарел. Начните заново командой /expense.' };
  }
  const actor=actorForChat(channel,chatId);
  if(!actor || actor.role!==draft.creator_role || Number(actor.id)!==Number(draft.creator_id)){
    return {ok:false,message:'Нет доступа к сохранению этой траты. Начните заново.'};
  }
  const filesWaiting=parsePendingAttachments(draft).length;
  const city = db.prepare('SELECT id, name FROM cities WHERE id = ?').get(draft.city_id);
  const info = db.prepare(`
    INSERT INTO expenses
      (expense_date, category, amount, investor_name, note, created_by, source, city_id)
    VALUES (?, ?, ?, ?, NULL, ?, 'telegram', ?)
  `).run(
    draft.expense_date,
    draft.purpose,
    draft.amount,
    draft.investor_name,
    draft.creator_name + ' · Telegram',
    draft.city_id
  );
  // Keep only the post-save attachment state. A repeated Telegram callback
  // must NEVER create a second expense.
  db.prepare(`
    UPDATE expense_bot_drafts SET step='attach',expense_id=?,
      expires_at=?,updated_at=datetime('now')
    WHERE channel=? AND chat_id=? AND step='confirm'
  `).run(Number(info.lastInsertRowid),new Date(Date.now()+ATTACH_TTL_MS).toISOString(),
    channel,String(chatId));
  return {
    ok: true,
    created: true,
    expenseId: Number(info.lastInsertRowid),
    message: [
      '✅ Трата записана',
      '',
      draft.expense_date + ' · ' + Number(draft.amount).toLocaleString('ru-RU') + ' ₽',
      draft.investor_name,
      draft.purpose,
      city ? 'Город: ' + city.name : '',
      filesWaiting ? '📎 Ожидают автоматического прикрепления: '+filesWaiting : '',
      '',
      attachmentInstructions(Number(info.lastInsertRowid),0),
    ].filter(Boolean).join('\n'),
    replyMarkup: attachmentButtons(Number(info.lastInsertRowid)),
  };
}

function handleExpenseCallback(channel, chatId, rawPayload) {
  const payload = String(rawPayload || '');
  if (!payload.startsWith('expense:')) return null;
  if (payload === 'expense:start') return startExpenseCreation(channel, chatId);
  if (payload === 'expense:cancel') {
    cancelExpenseCreation(channel, chatId);
    return { ok: true, message: 'Внесение траты отменено.', replyMarkup: expenseButton() };
  }
  if (payload === 'expense:date:today') return setDraftDate(channel, chatId, localDate());
  if (payload === 'expense:date:yesterday') return setDraftDate(channel, chatId, addDays(localDate(), -1));
  if (payload === 'expense:date:two-days-ago') return setDraftDate(channel, chatId, addDays(localDate(), -2));
  if (payload === 'expense:date:week-ago') return setDraftDate(channel, chatId, addDays(localDate(), -7));
  if (payload === 'expense:date:manual') {
    const draft = draftForChat(channel, chatId);
    if (!draft || draft.step !== 'date') {
      return { ok: false, message: 'Черновик траты устарел. Начните заново командой /expense.' };
    }
    return {
      ok: true,
      message: '📅 Отправьте дату фактической оплаты сообщением в формате ДД.ММ.ГГГГ. ' +
        'Можно указать любое число в прошлом, не только вчера (например, 25.10.2026).',
      replyMarkup: dateButtons(),
    };
  }
  if (payload.startsWith('expense:investor:')) {
    return setDraftInvestor(channel, chatId, payload.slice('expense:investor:'.length));
  }
  if (payload === 'expense:confirm') return finishExpenseCreation(channel, chatId);
  const attach=payload.match(/^expense:attach:(help|done|retry):(\d+)$/);
  if(attach){
    const current=activeExpenseAttachment(channel,chatId);
    if(!current || current.denied || String(current.expenseId)!==attach[2]){
      return {ok:false,message:'Сессия загрузки чека завершена. Начните новую трату через /expense.'};
    }
    if(attach[1]==='retry'){
      return {ok:true,retryPending:true,expenseId:current.expenseId,
        message:'🔄 Повторная попытка прикрепить ожидающие файлы.',
        replyMarkup:attachmentButtons(current.expenseId)};
    }
    if(attach[1]==='done'){
      const remaining=parsePendingAttachments(draftForChat(channel,chatId)).length;
      if(remaining)return {ok:false,message:'Осталось '+remaining+' неподтверждённых файлов. ' +
        'Нажмите «🔄 Повторить ожидающие файлы» или отправьте файлы ещё раз.',
        replyMarkup:attachmentButtons(current.expenseId)};
      cancelExpenseCreation(channel,chatId);
      const total=attachmentCount(current.expenseId);
      return {ok:true,message:'✅ Трата №'+current.expenseId+' сохранена.\n'+
        (total?'Подтверждающих документов: '+total+'.':'Подтверждающие документы не прикреплены.')+
        '\nДокументы также доступны в журнале трат.',
        replyMarkup:expenseButton()};
    }
    return {ok:true,message:attachmentInstructions(current.expenseId,attachmentCount(current.expenseId)),
      replyMarkup:attachmentButtons(current.expenseId)};
  }
  return { ok: false, message: 'Неизвестное действие. Начните заново командой /expense.' };
}

function handleExpenseMessage(channel, chatId, text) {
  const draft = draftForChat(channel, chatId);
  if (!draft) return null;
  const value = String(text || '').trim();
  if (!value || value.startsWith('/')) return null;

  if (draft.step === 'date') {
    const expenseDate = parseDate(value);
    if (!expenseDate) {
      return { ok: false, message: 'Не понял дату. Отправьте её в формате ДД.ММ.ГГГГ, например 05.10.2026.', replyMarkup: dateButtons() };
    }
    return setDraftDate(channel, chatId, expenseDate);
  }
  if (draft.step === 'investor') {
    return { ok: false, message: 'Выберите инвестора одной из кнопок.', replyMarkup: investorButtons() };
  }
  if (draft.step === 'amount') {
    const amount = parseAmount(value);
    if (!amount) return { ok: false, message: 'Не понял сумму. Введите число больше нуля, например 12500.' };
    db.prepare(`
      UPDATE expense_bot_drafts
      SET amount = ?, step = 'purpose', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(amount, channel, String(chatId));
    return { ok: true, message: 'Сумма: ' + amount.toLocaleString('ru-RU') + ' ₽.\n\nУкажите назначение траты: что именно было оплачено?' };
  }
  if (draft.step === 'purpose') {
    const purpose = value.slice(0, 500);
    db.prepare(`
      UPDATE expense_bot_drafts
      SET purpose = ?, step = 'confirm', updated_at = datetime('now')
      WHERE channel = ? AND chat_id = ?
    `).run(purpose, channel, String(chatId));
    const updated = draftForChat(channel, chatId);
    return { ok: true, message: confirmationMessage(updated), replyMarkup: confirmButtons() };
  }
  if (draft.step === 'confirm') {
    return { ok: false, message: 'Подтвердите сохранение кнопкой под предыдущим сообщением.', replyMarkup: confirmButtons() };
  }
  if (draft.step === 'attach') {
    const current=activeExpenseAttachment(channel,chatId);
    if(!current || current.denied)return {ok:false,message:'Нет доступа к загрузке файлов этой траты.'};
    if(/^(?:готово|без файла|пропустить)$/i.test(value)) {
      return handleExpenseCallback(channel,chatId,'expense:attach:done:'+current.expenseId);
    }
    return {ok:true,message:attachmentInstructions(current.expenseId,attachmentCount(current.expenseId)),
      replyMarkup:attachmentButtons(current.expenseId)};
  }
  return null;
}

module.exports = {
  cancelExpenseCreation,
  expenseButton,
  investorButtons,
  handleExpenseCallback,
  handleExpenseMessage,
  parseAmount,
  parseDate,
  startExpenseCreation,
  activeExpenseAttachment,
  attachmentButtons,
  attachmentInstructions,
  attachmentCount,
  queueExpenseAttachment,
  pendingSavedExpenseAttachments,
  markPendingAttachmentStored,
};
