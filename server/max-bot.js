// max-bot.js — безопасное подтверждение номера телефона через MAX.
//
// Сайт создаёт короткоживущую сессию и передаёт её в deep link. Сам переход
// в бота НЕ подтверждает номер: бот отдельно просит пользователя поделиться
// контактом кнопкой request_contact и сверяет номер с введённым на сайте.
'use strict';

const db = require('./db');
const pointStock = require('./max-point-stock');
const import2gisLead = require('./2gis-lead-bot');
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
  { name: '2gis', description: 'Добавить организацию из 2ГИС в обзвон' },
  { name: 'app', description: 'Тестовое мини-приложение ХвостМаркета' },
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


// Keep the existing webhook URL and the existing event types, adding only
// callback events. Do not delete subscriptions: those deliver login events.
const REQUIRED_WEBHOOK_UPDATES = Object.freeze([
  'bot_started', 'message_created', 'message_callback',
]);
let webhookState = Object.freeze({
  status: 'unchecked', message: 'Подписка ещё не проверена.',
  checked_at: null, callback_enabled: null, updated: false,
});
let webhookSyncInFlight = null;

function webhookStatus() { return { ...webhookState }; }
function saveWebhookState(status, message, enabled, updated = false) {
  webhookState = Object.freeze({
    status, message, checked_at: new Date().toISOString(),
    callback_enabled: enabled, updated,
  });
  return { ok: status === 'ready', updated, message };
}
function ownWebhookSubscription(subscription) {
  try {
    const url = new URL(String(subscription && subscription.url || ''));
    return url.protocol === 'https:' &&
      url.pathname === '/api/max/webhook' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch (_) {
    return false;
  }
}

// One lightweight reconciliation at startup, with a super-admin retry button.
// No new URL is guessed; only a previously registered, unique MAX webhook is
// upgraded. Other subscriptions and event types stay untouched.
async function ensureMaxWebhookUpdates() {
  if (webhookSyncInFlight) return webhookSyncInFlight;
  webhookSyncInFlight = (async () => {
    if (!isConfigured()) return saveWebhookState(
      'unconfigured', 'Не заданы настройки бота MAX в Amvera.', false);
    try {
      const list = await maxApi('/subscriptions');
      if (!Array.isArray(list.subscriptions)) throw new Error('Invalid subscriptions response');
      const matches = list.subscriptions.filter(ownWebhookSubscription);
      if (matches.length !== 1) return saveWebhookState(
        'attention',
        matches.length === 0 ?
          'Webhook /api/max/webhook не найден среди подписок MAX. Проверьте его настройку.' :
          'Найдено несколько подписок /api/max/webhook. Требуется ручная проверка.',
        false);
      const current = matches[0];
      const existingTypes = current.update_types;
      // MAX allows no update_types filter (null / omitted / empty = all events).
      if (!Array.isArray(existingTypes) || existingTypes.length === 0 ||
          REQUIRED_WEBHOOK_UPDATES.every(type => existingTypes.includes(type))) {
        return saveWebhookState('ready',
          'Webhook MAX получает события нажатия кнопок.', true);
      }
      const allTypes = [...new Set([...existingTypes, ...REQUIRED_WEBHOOK_UPDATES])];
      const updated = await maxApi('/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          url: current.url, update_types: allTypes,
          secret: process.env.MAX_WEBHOOK_SECRET,
        }),
      });
      if (updated.success !== true) throw new Error('Subscription update rejected');
      // Do not declare success solely on POST: read the registered types back.
      const verified = await maxApi('/subscriptions');
      const registered = (verified.subscriptions || []).find(
        item => item.url === current.url);
      const newTypes = registered && registered.update_types;
      if (!registered || (Array.isArray(newTypes) && newTypes.length > 0 &&
          !REQUIRED_WEBHOOK_UPDATES.every(type => newTypes.includes(type)))) {
        return saveWebhookState('attention',
          'MAX не подтвердил обновление подписки. Повторите синхронизацию в админке.',
          false);
      }
      return saveWebhookState('ready',
        'Webhook MAX обновлён: нажатия кнопок теперь включены.', true, true);
    } catch (error) {
      console.warn('MAX webhook sync failed (HTTP):', error.statusCode || 'request failed');
      return saveWebhookState('error',
        'Не удалось проверить подписку MAX. Проверьте доступность API и повторите синхронизацию.',
        null);
    }
  })().finally(() => { webhookSyncInFlight = null; });
  return webhookSyncInFlight;
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

async function answerMaxCallback(callbackId, text = '✅ Действие принято', removeButtons = false) {
  if (!callbackId) return { ok: false, skipped: true };
  try {
    return await maxApi(`/answers?callback_id=${encodeURIComponent(String(callbackId))}`, {
      method: 'POST',
      // MAX requires an updated message when acknowledging a callback.
      // An empty {} no longer reliably closes the loading state in clients.
      body: JSON.stringify({ message: {
        text: String(text).slice(0, 2700),
        ...(removeButtons ? { attachments: [] } : {}),
      } }),
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


// The open_app button opens the Mini App registered for THIS bot in MAX
// Business (it does not take an arbitrary external URL).
function maxMiniAppKeyboard() {
  const username = String(process.env.MAX_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(username)) return undefined;
  return [{
    type: 'inline_keyboard',
    payload: { buttons: [[{
      type: 'open_app', text: '🐾 Открыть тестовое приложение',
      web_app: username,
      payload: 'pilot_catalog',
    }]] },
  }];
}
async function sendMaxMiniApp(chatId) {
  if (!chatId) return;
  const keyboard = maxMiniAppKeyboard();
  await sendMaxMessage(chatId,
    '🐾 ХвостМаркет в MAX — тестовое мини-приложение.\n\n' +
    'В нём можно выбрать минимаркет и проверить ассортимент и остатки. ' +
    'Покупки и рабочие кабинеты пока отключены.\n\n' +
    (keyboard
      ? 'Нажмите кнопку, чтобы открыть мини-приложение.'
      : 'Чтобы включить запуск, настройте бота MAX и зарегистрируйте URL мини-приложения.'),
    keyboard);
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
    '/2gis ссылка — добавить заведение из 2ГИС в общую CRM обзвона (менеджер/администратор).',
    '/app — тестовое мини-приложение для всех пользователей.',
    'Подтверждение отчёта об остатках — кнопкой в боте.',
  ];
  const buttons = [];
  if (hasTasks) buttons.push([{ type: 'callback', text: '📋 Мои поручения', payload: 'menu:tasks' }]);
  if (hasStock) buttons.push([{ type: 'callback', text: '📦 Остатки по точкам', payload: 'menu:stock' }]);
  const appButton = maxMiniAppKeyboard()?.[0]?.payload?.buttons?.[0]?.[0];
  if (appButton) buttons.push([appButton]);
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

    const callbackId = callback.callback_id || update.callback_id;
    const stockMatch=String(payload || '').match(/^stk:(yes|no):([0-9]{1,15})$/);
    if (stockMatch) {
      if (!chatId) {
        await answerMaxCallback(callbackId,'⚠️ Не удалось определить диалог. Отправьте /stock ещё раз.');
        return;
      }
      const decision=pointStock.decideStockApproval(chatId,stockMatch[1],stockMatch[2]);
      await answerMaxCallback(callbackId, !decision.ok
        ? '⚠️ '+decision.message
        : decision.cancelled
          ? '❌ Отчёт отменён.'
          : '✅ Подтверждено. Отправляю актуальные остатки отдельным сообщением…', true);
      if (!decision.ok || decision.cancelled) {
        await sendMaxMessage(chatId,decision.message);
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
      await answerMaxCallback(callbackId,'✅ Запрос принят. Отвечаю новым сообщением.');
      if (!chatId) return;
      if (payload === 'menu:tasks') await sendTaskInbox(chatId);
      else await requestMaxStock(chatId, { kind: 'summary', page: 1 });
      return;
    }
    const result = handleTaskCallback('max', chatId, payload);
    if (result) {
      await answerMaxCallback(callbackId,'✅ Действие обработано.');
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
  if (/^\/(?:app|shop|miniapp)$/i.test(cleaned)) {
    await sendMaxMiniApp(chatId);
    return;
  }
  // MAX may share the same 2GIS URLs as Telegram. Check bot-linked staff role.
  if (chatId) {
    const imported = await import2gisLead.handle2gisText('max', chatId, cleaned);
    if (imported) {
      await sendMaxMessage(chatId, imported.message);
      return;
    }
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
  maxMiniAppKeyboard, sendMaxMiniApp,
  webhookStatus, ensureMaxWebhookUpdates,
  isConfigured,
  normalizePhone,
  phoneFromVcard,
  processUpdate,
  answerMaxCallback,
  sendMaxMessage,
};
