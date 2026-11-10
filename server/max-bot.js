// max-bot.js — безопасное подтверждение номера телефона через MAX.
//
// Сайт создаёт короткоживущую сессию и передаёт её в deep link. Сам переход
// в бота НЕ подтверждает номер: бот отдельно просит пользователя поделиться
// контактом кнопкой request_contact и сверяет номер с введённым на сайте.
'use strict';

const db = require('./db');
const pointStock = require('./max-point-stock');
const {
  getTaskInbox,
  handleTaskCallback,
  handleTaskStatusMessage,
  taskBotCard,
  taskButtons,
} = require('./task-bot-actions');

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || '';
const MAX_API_BASE = 'https://platform-api2.max.ru';

// Official MAX slash menu and /help use the same working command definitions.
const MAX_BOT_COMMANDS = Object.freeze([
  { name: 'start', description: 'Начать работу с ХвостМаркетом' },
  { name: 'help', description: 'Все команды и быстрые действия' },
  { name: 'tasks', description: 'Мои поручения (для сотрудников)' },
  { name: 'stock', description: 'Остатки на точках (для сотрудников)' },
]);

function isConfigured() {
  return Boolean(
    MAX_BOT_TOKEN &&
    process.env.MAX_BOT_USERNAME &&
    process.env.MAX_WEBHOOK_SECRET
  );
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function phoneFromVcard(vcfInfo) {
  const unfolded = String(vcfInfo || '').replace(/\r?\n[ \t]/g, '');
  const match = unfolded.match(/^TEL(?:;[^:]*)?:(.+)$/im);
  return match ? normalizePhone(match[1]) : '';
}

async function maxApi(pathname, options = {}) {
  if (!MAX_BOT_TOKEN) throw new Error('MAX_BOT_TOKEN не задан');
  const response = await fetch(MAX_API_BASE + pathname, {
    ...options,
    headers: {
      Authorization: MAX_BOT_TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `MAX API: HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

// Update the native slash-command menu once when the MAX webhook bot starts.
// Do not block HTTP startup if MAX is temporarily unavailable.
async function configureMaxCommands() {
  if (!MAX_BOT_TOKEN) return { ok: false, skipped: true };
  try {
    await maxApi('/me/commands', {
      method: 'PATCH',
      body: JSON.stringify({ commands: MAX_BOT_COMMANDS }),
    });
    console.log('MAX: меню действующих команд обновлено');
    return { ok: true };
  } catch (error) {
    console.warn('MAX: не удалось обновить меню команд:', error.message);
    return { ok: false, error: error.message };
  }
}

async function sendMaxMessage(chatId, text, attachments) {
  if (!chatId) return { ok: false, skipped: true };
  try {
    const body = { text };
    if (attachments) body.attachments = attachments;
    return await maxApi(`/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.warn('Не удалось отправить сообщение в MAX:', error.message);
    return { ok: false, error: error.message };
  }
}

async function answerMaxCallback(callbackId) {
  if (!callbackId) return { ok: false, skipped: true };
  try {
    return await maxApi(`/answers?callback_id=${encodeURIComponent(String(callbackId))}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    console.warn('Не удалось подтвердить нажатие кнопки MAX:', error.message);
    return { ok: false, error: error.message };
  }
}

async function sendTaskInbox(chatId) {
  const inbox = getTaskInbox('max', chatId);
  if (!inbox) {
    await sendMaxMessage(chatId, 'Ваш MAX ещё не связан с ответственным. Подключите его в разделе «Поручения» админки.');
    return;
  }
  if (!inbox.tasks.length) {
    await sendMaxMessage(chatId, '✅ У вас нет активных поручений.');
    return;
  }
  await sendMaxMessage(chatId, `Активные поручения: ${inbox.tasks.length}. Выберите действие под нужной задачей.`);
  for (const task of inbox.tasks) {
    await sendMaxMessage(chatId, taskBotCard(task), taskButtons(task, 'max'));
  }
}

function buildMaxHelp(chatId) {
  const id = String(chatId == null ? '' : chatId);
  const hasTasks = !!db.prepare(
    'SELECT 1 FROM task_assignees WHERE active=1 AND max_chat_id=? LIMIT 1'
  ).get(id);
  const hasStock = !!pointStock.resolveMaxStockAccess(id);
  const lines = [
    '🐾 ХвостМаркет · команды MAX',
    '',
    ...MAX_BOT_COMMANDS.map(command => '/' + command.name + ' — ' + command.description),
    '',
    '/stock 2 — Следующая страница точек',
    '/stock код_точки — Остатки по товарам и фасовкам',
    '',
    'Для /tasks и /stock нужен привязанный MAX-аккаунт сотрудника.',
    'Подтверждение отчёта об остатках — кнопкой в боте.',
  ];
  const buttons = [];
  if (hasTasks) buttons.push([{ type: 'callback', text: '📋 Мои поручения', payload: 'menu:tasks' }]);
  if (hasStock) buttons.push([{ type: 'callback', text: '📦 Остатки по точкам', payload: 'menu:stock' }]);
  return {
    text: lines.join('\n'),
    attachments: buttons.length ? [{
      type: 'inline_keyboard', payload: { buttons },
    }] : undefined,
  };
}
async function sendMaxHelp(chatId) {
  if (!chatId) return;
  const help = buildMaxHelp(chatId);
  await sendMaxMessage(chatId, help.text, help.attachments);
}
async function requestMaxStock(chatId, selection) {
  if (!chatId) return;
  const approval = pointStock.requestStockApproval(chatId, selection);
  await sendMaxMessage(chatId, approval.message, approval.ok ? approval.attachments : undefined);
}

function contactKeyboard() {
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [[{
        type: 'request_contact',
        text: 'Поделиться номером',
      }]],
    },
  }];
}

async function handleLoginStart(chatId, token) {
  const record = db.prepare(`
    SELECT * FROM max_login_tokens
    WHERE token = ? AND verified = 0 AND datetime(expires_at) > datetime('now')
  `).get(String(token || ''));
  if (!record || !chatId) {
    if (chatId) {
      await sendMaxMessage(chatId, 'Ссылка для входа устарела. Вернитесь на сайт «ХвостМаркет» и запросите новую.');
    }
    return;
  }

  db.prepare('UPDATE max_login_tokens SET chat_id = ? WHERE id = ?')
    .run(String(chatId), record.id);
  await sendMaxMessage(
    chatId,
    'Для безопасного входа подтвердите номер телефона, привязанный к вашему аккаунту MAX.',
    contactKeyboard()
  );
}

function getContactAttachment(message) {
  const attachments = message && message.body && message.body.attachments;
  if (!Array.isArray(attachments)) return null;
  return attachments.find((item) => item && item.type === 'contact') || null;
}

async function handleContactMessage(message) {
  const chatId = message && message.recipient && message.recipient.chat_id;
  const senderId = message && message.sender && message.sender.user_id;
  const contact = getContactAttachment(message);
  if (!chatId || !senderId || !contact || !contact.payload) return false;

  const pending = db.prepare(`
    SELECT * FROM max_login_tokens
    WHERE chat_id = ? AND verified = 0 AND datetime(expires_at) > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(String(chatId));
  if (!pending) {
    await sendMaxMessage(chatId, 'Сначала запросите вход через MAX на сайте «ХвостМаркет».');
    return true;
  }

  // request_contact возвращает контакт текущего пользователя с max_info.
  // Не принимаем произвольную или пересланную карточку другого человека.
  const contactUserId = contact.payload.max_info && contact.payload.max_info.user_id;
  if (!contactUserId || String(contactUserId) !== String(senderId)) {
    await sendMaxMessage(chatId, 'Не удалось подтвердить владельца номера. Нажмите именно кнопку «Поделиться номером» в сообщении бота.');
    return true;
  }

  const confirmedPhone = phoneFromVcard(contact.payload.vcf_info);
  if (!confirmedPhone) {
    await sendMaxMessage(chatId, 'MAX не передал номер телефона. Повторите вход с сайта и разрешите отправку контакта.');
    return true;
  }
  if (confirmedPhone !== normalizePhone(pending.phone)) {
    await sendMaxMessage(chatId, 'Этот аккаунт MAX привязан к другому номеру. Введите на сайте номер, который используется в MAX.');
    return true;
  }

  // Administrators get stock access only after MAX confirms the actual
  // sender owns the number assigned by their super-administrator.
  if (pending.role === 'admin') {
    const admin = db.prepare('SELECT phone FROM admins WHERE id=? AND active=1').get(pending.account_id);
    if (!admin || normalizePhone(admin.phone) !== confirmedPhone) {
      await sendMaxMessage(chatId, 'Привязка устарела: номер или доступ администратора изменён. Запросите новую ссылку.');
      return true;
    }
  }

  db.prepare(`
    UPDATE max_login_tokens
    SET verified = 1, chat_id = ?
    WHERE id = ? AND verified = 0
  `).run(String(chatId), pending.id);
  if (pending.role === 'admin') {
    // /stock works immediately, without waiting for a browser polling request.
    db.prepare('UPDATE admins SET max_chat_id = ? WHERE id = ? AND active = 1')
      .run(String(chatId), pending.account_id);
  }
  await sendMaxMessage(chatId, '✅ Номер подтверждён. Вернитесь на сайт — личный кабинет откроется автоматически.');
  if (pending.role === 'task_assignee') {
    if (pending.account_id) {
      db.prepare("UPDATE task_assignees SET max_chat_id = ?, updated_at = datetime('now') WHERE id = ? AND active = 1")
        .run(String(chatId), pending.account_id);
    } else {
      const wantedPhone = normalizePhone(pending.phone);
      const assignee = db.prepare('SELECT id, phone FROM task_assignees WHERE active = 1').all()
        .find((row) => normalizePhone(row.phone) === wantedPhone);
      if (assignee) {
        db.prepare("UPDATE task_assignees SET max_chat_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(String(chatId), assignee.id);
      }
    }
    await sendTaskInbox(chatId);
  }
  return true;
}


async function deliverApprovedStock(chatId, selection) {
  const access=pointStock.resolveMaxStockAccess(chatId);
  if (!access) throw new Error('Нет доступа к остаткам');
  const pages=selection.kind==='summary'
    ?[pointStock.formatSummary(pointStock.stockSummary(access,selection.page))]
    :pointStock.formatDetail(pointStock.stockDetail(access,selection.pointId));
  for (const message of pages) {
    const sent=await sendMaxMessage(chatId,message);
    if (sent?.ok===false) throw new Error(sent.error||'MAX не принял сообщение');
  }
}

async function processUpdate(update) {
  if (!update || typeof update !== 'object') return;

  if (update.update_type === 'message_callback') {
    const callback = update.callback || {};
    const message = callback.message || update.message || {};
    const payload = callback.payload || callback.data || (callback.button && callback.button.payload);
    const chatId = update.chat_id || callback.chat_id || (message.recipient && message.recipient.chat_id);

    const stockMatch=String(payload || '').match(/^stk:(yes|no):([0-9]{1,15})$/);
    if (stockMatch) {
      await answerMaxCallback(callback.callback_id || update.callback_id);
      const decision=pointStock.decideStockApproval(chatId,stockMatch[1],stockMatch[2]);
      if (!decision.ok || decision.cancelled) {
        if (chatId) await sendMaxMessage(chatId,decision.message);
        return;
      }
      let success=false;
      try {
        await deliverApprovedStock(chatId,decision.selection);
        success=true;
      } catch(error) {
        console.warn('[MAX stock] report failed:',error.message);
        await sendMaxMessage(chatId,'⚠️ Остатки получить не удалось. Повторите /stock или обратитесь к администратору.');
      } finally {
        pointStock.finishStockApproval(decision.id,success);
      }
      return;
    }
    if (payload === 'menu:tasks' || payload === 'menu:stock') {
      await answerMaxCallback(callback.callback_id || update.callback_id);
      if (!chatId) return;
      if (payload === 'menu:tasks') await sendTaskInbox(chatId);
      else await requestMaxStock(chatId, { kind: 'summary', page: 1 });
      return;
    }
    const result = handleTaskCallback('max', chatId, payload);
    if (result) {
      await answerMaxCallback(callback.callback_id || update.callback_id);
      if (chatId) await sendMaxMessage(chatId, result.message);
    }
    return;
  }

  if (update.update_type === 'bot_started') {
    if (update.payload) await handleLoginStart(update.chat_id, update.payload);
    else if (update.chat_id) {
      await sendMaxHelp(update.chat_id);
    }
    return;
  }

  if (update.update_type !== 'message_created' || !update.message) return;
  if (await handleContactMessage(update.message)) return;

  const text = update.message.body && update.message.body.text;
  const chatId = update.message.recipient && update.message.recipient.chat_id;
  const cleaned = String(text || '').trim();
  if (/^\/(?:start|help|commands|menu)$/i.test(cleaned) || /^команды$/i.test(cleaned)) {
    await sendMaxHelp(chatId);
    return;
  }
  const stockCommand=pointStock.parseStockCommand(text);
  if (stockCommand) {
    if (!chatId) return;
    if (stockCommand.error) {
      await sendMaxMessage(chatId,stockCommand.error);
      return;
    }
    await requestMaxStock(chatId, stockCommand);
    return;
  }
  if (/^\/tasks$/i.test(String(text || '').trim()) || /^мои поручения$/i.test(String(text || '').trim())) {
    await sendTaskInbox(chatId);
    return;
  }
  const taskStatus = handleTaskStatusMessage('max', chatId, text);
  if (taskStatus) {
    await sendMaxMessage(chatId, taskStatus.message);
    return;
  }
  const match = String(text || '').match(/^\/start\s+([A-Za-z0-9_-]{1,128})$/);
  if (match) await handleLoginStart(chatId, match[1]);
}

module.exports = {
  MAX_BOT_COMMANDS, configureMaxCommands, buildMaxHelp,
  isConfigured,
  normalizePhone,
  phoneFromVcard,
  processUpdate,
  answerMaxCallback,
  sendMaxMessage,
};
