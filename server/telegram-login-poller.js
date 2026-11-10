// telegram-login-poller.js — фоновый опрос Telegram (long polling) для входа
// в личный кабинет клиента через бота. Бот не может написать клиенту первым,
// поэтому клиент сам открывает диалог по ссылке-приглашению с токеном
// (t.me/BOT?start=ТОКЕН) — это и есть подтверждение входа.
'use strict';
// Redeploy trigger: refresh Telegram /chatid group command handler (2026-10-22).


const db = require('./db');
const import2gisLead = require('./2gis-lead-bot');
const crypto = require('node:crypto');
const {
  getTaskInbox,
  getTaskPage, taskPageMessage, taskListMarkup, handleTaskListNavigation,
  handleTaskCallback,
  handleTaskStatusMessage,
  taskBotCard,
  taskButtons,
} = require('./task-bot-actions');
const {
  handleTaskDueCallback, handleTaskDueMessage, cancelTaskDueInput,
} = require('./task-bot-due');
const {
  cancelTaskCreation,
  handleTaskCreateCallback,
  handleTaskCreateMessage,
  startTaskCreation,
} = require('./task-bot-create');
const {
  cancelExpenseCreation,
  handleExpenseCallback,
  handleExpenseMessage,
  startExpenseCreation,
} = require('./expense-bot-create');
const { handleExpenseAttachmentMessage,processPendingExpenseAttachments } = require('./expense-bot-files');

const TG_TOKEN = process.env.TG_TOKEN || '';
const { recordVerifiedTelegramContact } = require('./miniapp-phone-identity');
const { bindTelegramAccount } = require('./telegram-connection-alerts');
const { commandsMenuButton, miniAppInlineKeyboard, miniAppDirectLinkMarkup } = require('./miniapp-bot-links');
const { collectSalesWeekReport, formatSalesWeekReport, buildSalesWeekCsv, adminCanReadSales } = require('./sales-week-report');
const {
  currentKrasnoyarskYear, collectBusinessYearReport,
  formatBusinessYearReport, buildBusinessYearCsv, buildBusinessPointsCsv,
} = require('./business-year-report');
const { sendTelegramCsvDocument } = require('./telegram-csv-upload');
const {
  collectWarehouseStockReport, formatWarehouseStockMessages,
  formatWarehouseStockSummary, buildWarehouseStockCsv,
} = require('./warehouse-telegram-report');
const { collectNoGroomerReport, formatNoGroomerReport, buildNoGroomerCsv } = require('./no-groomer-report');
const { collectPayoutBrief, formatPayoutBriefMessage, formatRecipientPayoutMessage, buildPayoutBriefCsv } = require('./payout-brief');
const newProductBroadcast = require('./new-product-broadcast');
const tierApprovals = require('./partner-tier-approvals');
const reportApprovals = require('./report-approvals');
let lastUpdateId = 0;
let polling = false;

const BOT_NAME = 'ХвостМаркет';
const BOT_DESCRIPTION = 'Покупайте товары для питомцев, открывайте свои кабинеты, получайте уведомления и управляйте поручениями ХвостМаркета.';
const BOT_SHORT_DESCRIPTION = 'Магазин, кабинеты и уведомления ХвостМаркета.';

async function callBotApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error((data && data.description) || `Telegram API: HTTP ${res.status}`);
  }
  return data.result;
}

// Telegram has separate default/private/language-scoped command lists.
// Keep a single source of truth for all scopes and for verification.
const TELEGRAM_BOT_COMMANDS = Object.freeze([
      { command: 'start', description: 'Открыть помощника ХвостМаркета' },
      { command: 'app', description: '🐾 Открыть ХвостМаркет — все возможности' },
      { command: 'phone', description: '🔐 Подтвердить свой номер для кабинета' },
      { command: 'tasks', description: 'Мои активные поручения' },
      { command: 'taskpdf', description: 'Свежий PDF моих поручений' },
      { command: 'reports', description: '📊 Отчёты: сформировать после подтверждения' },
      { command: 'newtask', description: 'Создать новую задачу' },
      { command: 'expense', description: 'Добавить трату бизнеса' },
      { command: 'salesweek', description: 'Отчёт по продажам за 7 дней' },
      { command: 'business', description: 'Бизнес по месяцам и за год' },
      { command: 'businesspoints', description: 'Все точки: CSV со статистикой' },
      { command: 'stock', description: 'Актуальные остатки центрального склада' },
      { command: '2gis', description: '📍 Добавить заведение из 2ГИС в обзвон' },
      { command: 'contact', description: 'Контакт из Яндекс Карт или 2ГИС' },
      { command: 'nogroomer', description: 'Оплаченные заказы без грумера' },
      { command: 'payouts', description: 'Справка для выплат партнёрам' },
      { command: 'tierapprovals', description: 'Согласовать изменение процента грумера' },
      { command: 'clubpost', description: 'Сообщение в Клуб партнёров' },
      { command: 'newproduct', description: '📷 Рассылка о новом товаре' },
      { command: 'cancel', description: 'Отменить текущее действие' },
      { command: 'help', description: 'Как пользоваться ботом' },
      { command: 'chatid', description: 'Показать ID текущей группы' },
]);
const TELEGRAM_COMMAND_SCOPES = Object.freeze([
  { name: 'default', options: { scope: { type: 'default' } } },
  { name: 'private', options: { scope: { type: 'all_private_chats' } } },
  { name: 'private_ru', options: { scope: { type: 'all_private_chats' }, language_code: 'ru' } },
]);
let commandSyncInFlight = null;
let commandMenuRetryTimer = null;
let commandMenuRetryCount = 0;

async function syncTelegramBotCommands() {
  if (!TG_TOKEN) return { ok: false, skipped: true, failed: ['TG_TOKEN'] };
  if (commandSyncInFlight) return commandSyncInFlight;
  commandSyncInFlight = (async () => {
    const failed = [];
    for (const item of TELEGRAM_COMMAND_SCOPES) {
      try {
        await callBotApi('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS, ...item.options });
        const actual = await callBotApi('getMyCommands', item.options);
        const expected = TELEGRAM_BOT_COMMANDS.map(command => command.command);
        const found = Array.isArray(actual) ? actual.map(command => command.command) : [];
        if (JSON.stringify(found) !== JSON.stringify(expected)) {
          throw new Error('список Telegram после публикации не совпал с кодом');
        }
      } catch (error) {
        failed.push(item.name);
        console.warn('Telegram: меню команд не синхронизировано ('+item.name+'):',
          error.message);
      }
    }
    if (failed.length === 0) {
      console.log('Telegram: меню команд проверено (default, private, private_ru), /contact доступна');
    }
    return { ok: failed.length === 0, failed };
  })();
  try { return await commandSyncInFlight; }
  finally { commandSyncInFlight = null; }
}

function scheduleBotMenuRetry() {
  if (!polling || commandMenuRetryTimer || commandMenuRetryCount >= 4) return;
  const delays = [60000, 300000, 900000, 1800000];
  const delay = delays[commandMenuRetryCount++];
  commandMenuRetryTimer = setTimeout(async () => {
    commandMenuRetryTimer = null;
    if (!polling) return;
    const result = await syncTelegramBotCommands();
    if (result.ok) commandMenuRetryCount = 0;
    else scheduleBotMenuRetry();
  }, delay);
  // A bot-menu retry must never keep an otherwise stopped Node process alive.
  commandMenuRetryTimer.unref?.();
}

// Отображаемое имя, описание и меню команд поддерживаем из кода, чтобы после
// очередного деплоя бот не оставался оформлен под старый бренд. Ошибка любой
// из этих косметических операций не должна останавливать вход и уведомления.
async function configureBotProfile() {
  if (!TG_TOKEN) return { ok: false, skipped: true };
  const operations = [
    ['setMyName', { name: BOT_NAME }],
    ['setMyDescription', { description: BOT_DESCRIPTION }],
    ['setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }],
    ['setChatMenuButton', { menu_button: commandsMenuButton() }],

  ];
  const [results, commands] = await Promise.all([
    Promise.allSettled(operations.map(([method, body]) => callBotApi(method, body))),
    syncTelegramBotCommands(),
  ]);
  const failed = results
    .map((result, index) => ({ result, method: operations[index][0] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, method } of failed) {
    console.warn(`Telegram: не удалось обновить ${method}:`, result.reason.message);
  }
  if (!commands.ok) {
    // Previously a single transient failure left command menus stale forever.
    scheduleBotMenuRetry();
  }
  const failures = failed.map(({ method }) => method);
  if (!commands.ok) failures.push(...commands.failed.map(name => 'commands:' + name));
  return { ok: failures.length === 0, failed: failures, commands };
}

// Короткий 4-значный код — запасной способ подтвердить вход, если сайт не
// подхватил это автоматически (например, вкладка была перезагружена и
// потеряла исходный длинный token, или опрос на фронтенде просто не дошёл
// до сервера). Код привязан к тому же токену и живёт до его истечения.
function generateLoginCode() {
  return String(crypto.randomInt(1000, 10000));
}

async function replyToChat(chatId, text, replyMarkup, parseMode) {
  try {
    await callBotApi('sendMessage', {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (e) {
    console.warn('Не удалось ответить в Telegram-чат:', e.message);
  }
}

function buildWelcomeMessage() {
  return [
    '🐾 ХвостМаркет',
    '',
    'Одна кнопка открывает магазин и все ваши кабинеты прямо в Telegram. Я также помогу войти на сайт и буду присылать уведомления о продажах, заказах и вознаграждениях.',
    '',
    'Нажмите «🐾 Открыть ХвостМаркет» или отправьте /app. После подтверждения телефона увидите только доступные вам разделы.',
    '',
    'Сотрудникам: /tasks откроет список задач, /taskpdf пришлёт PDF-сводку, /newtask создаст задачу, а /expense запишет трату бизнеса.',
    'Менеджерам и администраторам: /contact ссылка — контакт из Яндекс Карт или 2ГИС с согласованием. /2gis также работает.',
    'Администраторам: /salesweek — продажи за 7 дней; /business — помесячные показатели и итоги года; /businesspoints — реестр всех точек; /stock — остатки центрального склада; /nogroomer — заказы без грумера; /payouts — справки для выплат.',
    'Супер-администратору: /newproduct — рассылка новинки с фотографией и предпросмотром; /tierapprovals — заявки на снижение процента грумеров.',
    '',
    'Для быстрого входа в Mini App подтвердите свой номер Telegram — увидите зарегистрированные кабинеты без ввода пароля. Для админки нужна предварительная привязка Telegram из аккаунта сайта.',
  ].join('\n');
}

function botActionButtons(chatId) {
  const keyboard = [...miniAppInlineKeyboard({ fresh: true }), [
    { text: '➕ Новая задача', callback_data: 'newtsk:start' },
    { text: '💳 Добавить трату', callback_data: 'expense:start' },
  ]];
  if (chatId && adminCanReadSales(chatId)) {
    keyboard.push([{ text: '📊 Продажи за 7 дней', callback_data: 'sales:week' }]);
    keyboard.push([{ text: '📈 Бизнес по месяцам и за год', callback_data: 'sales:business' }]);
    keyboard.push([{ text: '🏪 Все точки · CSV', callback_data: 'sales:businesspoints' }]);
    keyboard.push([{ text: '📦 Остатки центрального склада', callback_data: 'warehouse:stock' }]);
    keyboard.push([{ text: '🔎 Заказы без грумера', callback_data: 'sales:nogroomer' }]);
    keyboard.push([{ text: '💸 Справки к выплатам', callback_data: 'payouts:prepare' }]);
    if (newProductBroadcast.isBroadcaster(chatId)) {
      keyboard.push([{ text: '📷 Рассылка о новинке', callback_data: 'newprod:new' }]);
    }
  }
  if (chatId && (adminCanReadSales(chatId) || require('./task-daily-digest').assigneeByTelegram(chatId))) {
    keyboard.push([{ text: '📊 Отчёты по запросу', callback_data: 'report:menu' }]);
  }
  if (chatId && tierApprovals.activeSuperAdmin(chatId)) {
    keyboard.push([{ text: '📉 Согласования комиссий', callback_data: 'tier:list' }]);
  }
  if (chatId && require('./routes-partner-club').isClubModerator(chatId)) {
    keyboard.push([{ text: '🐾 Сообщение партнёрам', callback_data: 'club:new' }]);
  }
  return { inline_keyboard: keyboard };
}

async function replyNewProduct(chatId, result) {
  if (!result) return;
  if (result.preview) {
    const photo = await newProductBroadcast.sendProductPhoto(
      chatId, result.preview.ref, result.preview.caption,
      result.preview.reply_markup
    );
    if (!photo.ok) {
      await replyToChat(chatId,
        '⚠️ Не удалось показать фото: ' + (photo.error || 'Ошибка Telegram') +
        '\nПришлите другое фото через кнопку «📷 Заменить фото».',
        { inline_keyboard: [
          [{ text: '📷 Заменить фото', callback_data: 'newprod:photo' }],
          [{ text: '❌ Отмена', callback_data: 'newprod:cancel' }],
        ] }
      );
      return;
    }
  }
  if (result.message) await replyToChat(chatId, result.message, result.reply_markup);
}

async function sendTaskInbox(chatId) {
  const result = taskPageMessage(getTaskPage('telegram', chatId));
  await replyToChat(chatId, result.message, result.replyMarkup || undefined);
}

async function requestBotReport(chatId,type,params={}) {
  const result=await reportApprovals.requestReport(chatId,type,params);
  if(!result.ok)await replyToChat(chatId,'🔒 '+result.error);
  return result;
}

async function sendFreshTaskPdf(chatId) {
  const result = await require('./task-daily-digest').sendManualTaskPdf(chatId);
  if (!result.ok) await replyToChat(chatId, result.message);
}

// В списках поручений обновляем одно сообщение, не засоряя переписку.
// Для PDF-документа editMessageText неприменим — открываем одну отдельную
// страницу списка; дальше переключения страниц идут в этом же сообщении.
async function editOrReplyTaskCard(callback, result) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (chatId && messageId && typeof callback.message.text === 'string') {
    try {
      await callBotApi('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: result.message,
        ...(result.replyMarkup ? { reply_markup: result.replyMarkup } :
          { reply_markup: { inline_keyboard: [] } }),
      });
      return;
    } catch (e) {
      console.warn('[tasks] Не удалось обновить карточку, отправляем новую:', e.message);
    }
  }
  if (chatId) await replyToChat(chatId, result.message, result.replyMarkup);
}

async function sendSalesWeekCsv(chatId, csvText, period) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    const filename = 'sales-week-' + period.start_utc.slice(0,10) + '_' + period.end_utc.slice(0,10) + '.csv';
    form.append('caption', 'Подробные продажи по датам и точкам · ХвостМаркет');
    form.append('document', new Blob([csvText], { type: 'text/csv;charset=utf-8' }), filename);
    const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, {
      method: 'POST', body: form, signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || ('Telegram HTTP ' + response.status));
    return true;
  } finally {
    clearTimeout(timeout);
  }
}


async function sendNoGroomerReport(chatId, days) {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId,
      '🔒 Список заказов без грумера доступен только администраторам ХвостМаркета в личном чате.');
    return;
  }
  try {
    const report = collectNoGroomerReport(days);
    await replyToChat(chatId, formatNoGroomerReport(report));
    if (!report.orders.length) return;
    const csv = buildNoGroomerCsv(report);
    const periodSuffix = days ? '-' + days + 'days' : '-all';
    const date = report.generated_at.slice(0,10);
    try {
      await sendPayoutBriefDocument(
        chatId, csv, 'HvostMarket_no_groomer' + periodSuffix + '_' + date + '.csv',
        'Заказы без грумера: номер, дата, точка, товары, сумма и причина. ' +
          report.period.description + '.',
        'text/csv;charset=utf-8'
      );
    } catch (error) {
      console.warn('Не удалось отправить CSV заказов без грумера:', error.message);
      await replyToChat(chatId,
        '⚠️ Сводка готова, но CSV не удалось отправить. Повторите /nogroomer позднее.');
    }
  } catch (error) {
    console.error('Ошибка отчёта по заказам без грумера:', error.message);
    await replyToChat(chatId,
      '⚠️ Не удалось собрать список заказов без грумера. Проверьте журналы сервера.');
  }
}

async function sendSalesWeekReport(chatId) {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId, '🔒 Отчёт по продажам доступен только администраторам ХвостМаркета с подключённым Telegram.');
    return;
  }
  try {
    const report = collectSalesWeekReport();
    await replyToChat(chatId, formatSalesWeekReport(report));
    const csv = buildSalesWeekCsv(report);
    try {
      await sendSalesWeekCsv(chatId, csv, report.period);
    } catch (error) {
      console.warn('Не удалось прикрепить CSV отчёта по продажам:', error.message);
      await replyToChat(chatId, '⚠️ Сводка сформирована, но CSV не удалось отправить. Повторите /salesweek позднее.');
    }
  } catch (error) {
    console.error('Ошибка формирования отчёта по продажам:', error.message);
    await replyToChat(chatId, '⚠️ Не удалось собрать отчёт. Проверьте журналы сервера.');
  }
}


// /stock [city_id|city_name] — только для администраторов в ЛИЧНОМ чате.
// На каждом запросе перечитывается реальная складская таблица SQLite.
async function sendWarehouseStockReport(chatId, citySelector = '') {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId,
      '🔒 Остатки центрального склада доступны только администраторам ХвостМаркета в личном чате.');
    return;
  }

  let report;
  try {
    report = collectWarehouseStockReport(citySelector);
  } catch (error) {
    if (error.code === 'UNKNOWN_WAREHOUSE_CITY') {
      const available = (error.cities || []).map(city =>
        city.name + ' — /stock ' + city.id).join('\n');
      await replyToChat(chatId,
        'Город не найден. Доступные городские склады:\n' +
        (available || 'Складские города ещё не заведены.') +
        '\n\nИспользуйте /stock для общего отчёта.');
    } else {
      console.error('[stock-report] Ошибка формирования складского отчёта:', error);
      await replyToChat(chatId,
        '⚠️ Не удалось получить актуальные остатки склада. Подробности в журнале Amvera.');
    }
    return;
  }

  try {
    const detailed = formatWarehouseStockMessages(report);
    // Не отправляем десятки отдельных сообщений, если ассортимент вырос.
    // CSV всегда содержит все позиции без ограничений на число строк.
    const messages = detailed.length <= 7
      ? (report.cities.length > 1
        ? [formatWarehouseStockSummary(report), ...detailed] : detailed)
      : [formatWarehouseStockSummary(report) +
        '\nПолный перечень слишком длинный для сообщений; все позиции — в CSV.'];
    const csv = buildWarehouseStockCsv(report);
    let failedTextPages = 0;
    for (const text of messages) {
      try {
        await callBotApi('sendMessage', { chat_id: chatId, text });
      } catch (error) {
        // Не теряем полный CSV из-за ошибки отправки одной текстовой страницы.
        console.warn('[stock-report] Текстовая страница не доставлена:', error.message);
        failedTextPages++;
      }
      // Не отправляем несколько сообщений подряд в обход лимитов Telegram.
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const selectedCity = citySelector && report.cities.length === 1
      ? '-' + report.cities[0].id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
      : '-all';
    await sendTelegramCsvDocument({
      token: TG_TOKEN, chatId, csvText: csv,
      filename: 'warehouse-stock' + selectedCity + '-' +
        report.local_date + '.csv',
      caption: 'Актуальные остатки центральных складов ХвостМаркета · ' +
        report.local_time + ' (Красноярск)',
    });
    if (failedTextPages) {
      await replyToChat(chatId,
        '⚠️ Часть текстового отчёта не доставлена, но полный список остатков отправлен в CSV.');
    }
  } catch (error) {
    console.error('[stock-report] Ошибка отправки складского отчёта:', {
      message: error.message, telegramCode: error.telegramCode || null,
      status: error.status || null, retryAfter: error.retryAfter || null,
    });
    const reason = error.telegramCode
      ? 'Telegram вернул ошибку ' + error.telegramCode + '.'
      : 'Возникла ошибка доставки.';
    await replyToChat(chatId, '⚠️ Не удалось полностью доставить отчёт об остатках. ' +
      reason + ' Повторите /stock. Подробности в журнале Amvera.');
  }
}

// /business [ГГГГ] — финансовая динамика с начала календарного года
// по Красноярску или полный выбранный прошлый год.
async function sendBusinessYearReport(chatId, requestedYear) {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId,
      '🔒 Финансовая статистика доступна только администраторам ХвостМаркета в личном чате.');
    return;
  }
  let report;
  try {
    report = collectBusinessYearReport(requestedYear);
    await replyToChat(chatId, formatBusinessYearReport(report));
  } catch (error) {
    if (error.code === 'INVALID_BUSINESS_YEAR') {
      await replyToChat(chatId,
        'Укажите год от 2020 до ' + currentKrasnoyarskYear() +
        '. Например: /business или /business 2025.');
    } else {
      console.error('[business-report] Не удалось сформировать отчёт:', error);
      await replyToChat(chatId, '⚠️ Не удалось собрать бизнес-статистику. Проверьте журналы сервера.');
    }
    return;
  }
  // Подготавливаем каждый документ отдельно. Раньше исключение из
  // buildBusinessPointsCsv называлось "не удалось прикрепить файл", хотя
  // обращения к Telegram могло не быть вовсе.
  const files = [
    {
      filename: 'business-' + report.year + '.csv',
      caption: 'Помесячные показатели, затраты и расчётная прибыль · ХвостМаркет ' + report.year,
      create: () => buildBusinessYearCsv(report),
    },
    {
      filename: 'business-points-' + report.year + '.csv',
      caption: 'ВСЕ точки ХвостМаркета: даты регистрации, статусы, продажи, недостающие даты · ' + report.year,
      create: () => buildBusinessPointsCsv(report),
    },
  ];
  for (const file of files) {
    let csv;
    try {
      csv = file.create();
      if (typeof csv !== 'string' || !csv.length) {
        throw new Error('CSV returned an empty or invalid value');
      }
    } catch (error) {
      console.error('[business-report] Ошибка формирования CSV ' + file.filename + ':', error);
      await replyToChat(chatId, '⚠️ Не удалось сформировать файл «' + file.filename + '». Ошибка записана в журнал Amvera.');
      continue;
    }
    // Telegram ограничивает отправку нескольких сообщений подряд в один чат.
    // Интервал плюс корректный retry_after (429) находятся под контролем.
    await new Promise(resolve => setTimeout(resolve, 1200));
    try {
      await sendTelegramCsvDocument({
        token: TG_TOKEN, chatId, csvText: csv,
        filename: file.filename, caption: file.caption,
      });
      console.log('[business-report] CSV отправлен:', file.filename, 'размер', Buffer.byteLength(csv, 'utf8'));
    } catch (error) {
      console.error('[business-report] Ошибка отправки CSV ' + file.filename + ':', {
        message: error.message, status: error.status || null,
        telegramCode: error.telegramCode || null,
        retryAfter: error.retryAfter || null,
      });
      const reason = error.telegramCode === 429
        ? 'Telegram временно ограничил частоту отправки (429).'
        : (error.telegramCode ? 'Telegram вернул ошибку ' + error.telegramCode + '.' :
          'Возникла сетевая ошибка при отправке документа.');
      await replyToChat(chatId, '⚠️ Файл «' + file.filename + '» сформирован, но не доставлен. ' + reason + ' Подробности записаны в журнал Amvera.');
    }
  }
}

// /businesspoints [ГГГГ] — отдельная выгрузка полного реестра всех точек.
// Не заставляем повторно получать годовые файлы при сбое второго вложения.
async function sendBusinessPointsOnly(chatId, requestedYear) {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId,
      '🔒 Финансовая статистика доступна только администраторам ХвостМаркета в личном чате.');
    return;
  }
  let report;
  let csv;
  try {
    report = collectBusinessYearReport(requestedYear);
    csv = buildBusinessPointsCsv(report);
  } catch (error) {
    if (error.code === 'INVALID_BUSINESS_YEAR') {
      await replyToChat(chatId, 'Укажите год от 2020 до ' + currentKrasnoyarskYear() +
        '. Например: /businesspoints или /businesspoints 2025.');
    } else {
      console.error('[business-points] Ошибка формирования реестра точек:', error);
      await replyToChat(chatId, '⚠️ Не удалось сформировать реестр точек. Ошибка записана в журнал Amvera.');
    }
    return;
  }
  const filename = 'business-points-' + report.year + '.csv';
  try {
    await sendTelegramCsvDocument({
      token: TG_TOKEN, chatId, csvText: csv, filename,
      caption: 'ВСЕ точки ХвостМаркета: помесячные продажи, даты регистрации и статусы · ' + report.year,
    });
    console.log('[business-points] CSV отправлен:', filename);
  } catch (error) {
    console.error('[business-points] CSV не доставлен:', {
      filename, message: error.message,
      status: error.status || null, telegramCode: error.telegramCode || null,
      retryAfter: error.retryAfter || null,
    });
    const reason = error.telegramCode === 429
      ? 'Telegram ограничил частоту отправки (429).'
      : (error.telegramCode ? 'Telegram ответил ошибкой ' + error.telegramCode + '.' :
        'Возникла сетевая ошибка.');
    await replyToChat(chatId, '⚠️ Реестр сформирован, но не доставлен. ' + reason +
      ' Подробности в журнале Amvera.');
  }
}

async function sendPayoutBriefDocument(chatId, content, filename, caption, mime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', String(caption).slice(0, 900));
    form.append('document', new Blob([content], { type: mime }), filename);
    const response = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendDocument', {
      method: 'POST', body: form, signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram HTTP ' + response.status);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}
async function sendPayoutBriefs(chatId) {
  if (!adminCanReadSales(chatId)) {
    await replyToChat(chatId, '🔒 Справки для выплат доступны только администраторам ХвостМаркета в личном Telegram.');
    return;
  }
  let report;
  try {
    report = collectPayoutBrief();
    await replyToChat(chatId, formatPayoutBriefMessage(report));
  } catch (error) {
    console.error('Ошибка расчёта справок для выплат:', error.message);
    await replyToChat(chatId, '⚠️ Не удалось рассчитать справки для выплат. Проверьте журнал сервера.');
    return;
  }
  const date = report.generated_at.slice(0, 10);
  if (!report.people.length) return;
  const renderPdf = require('./payout-brief-pdf').renderPayoutBriefPdf;
  let failedDocuments = 0;
  // Each payee gets a separate Telegram message and an individual printable PDF.
  // Combined profiles (e.g. a groomer and manager) are one payee, not two.
  for (const person of report.people) {
    await replyToChat(chatId, formatRecipientPayoutMessage(person, report.generated_at));
    try {
      const pdf = await renderPdf(report, { recipient: person });
      const fileName = 'HvostMarket_payout_' + String(person.index).padStart(3,'0') + '_' + date + '.pdf';
      await sendPayoutBriefDocument(
        chatId, pdf, fileName,
        'Справка: ' + person.name + ' · ' + person.roles_label + ' · ' +
          'период ' + (person.period?.label || 'не определён') +
          ' · к выплате ' + person.total + ' ₽',
        'application/pdf'
      );
    } catch (error) {
      failedDocuments++;
      console.error('Не удалось отправить PDF-справку получателю №'+person.index+':', error.message);
      await replyToChat(chatId, '⚠️ PDF для «'+person.name+'» не сформирован или не доставлен. Повторите /payouts позже.');
    }
  }
  try {
    await sendPayoutBriefDocument(
      chatId, buildPayoutBriefCsv(report), 'HvostMarket_payouts_' + date + '.csv',
      'Общая CSV-детализация: период, даты, товары, суммы продаж, ставки и вознаграждения.',
      'text/csv;charset=utf-8'
    );
  } catch (error) {
    console.error('Не удалось отправить CSV справок для выплат:', error.message);
    await replyToChat(chatId, '⚠️ Не удалось отправить CSV с детализацией. Повторите /payouts позднее.');
  }
  if (failedDocuments) {
    await replyToChat(chatId, '⚠️ Не удалось отправить '+failedDocuments+' персональных PDF из '+report.people.length+'.');
  }
}

function accountRoleText(role) {
  if (role === 'partner') return 'грумера';
  if (role === 'manager') return 'менеджера';
  if (role === 'owner') return 'владельца салона';
  if (role === 'founder') return 'собственника ХвостМаркета';
  if (role === 'admin') return 'администратора';
  if (role === 'task_assignee') return 'ответственного за поручения';
  return 'покупателя';
}

function rememberChatForAccount(record, chatId) {
  const tableByRole = {
    customer: 'customers',
    partner: 'partners',
    manager: 'managers',
    owner: 'salon_owners',
    founder: 'business_founders',
    admin: 'admins',
    task_assignee: 'task_assignees',
  };
  const table = tableByRole[record.role || 'customer'];
  if (!table) return;
  if (record.account_id) {
    bindTelegramAccount(record.role || 'customer',record.account_id,chatId);
    return;
  }
  const wantedPhone = String(record.phone || '').replace(/\D/g, '').slice(-10);
  if (!wantedPhone) return;
  let account = db.prepare(`SELECT id, phone FROM ${table}`).all()
    .find((row) => String(row.phone || '').replace(/\D/g, '').slice(-10) === wantedPhone);
  // Для покупателя бот подтверждает владение номером. Создаём минимальную
  // карточку сразу, чтобы связь с Telegram успела сохраниться даже если
  // вкладка сайта ещё не возобновила опрос после возврата из приложения.
  if (!account && table === 'customers') {
    const info = db.prepare('INSERT INTO customers (phone, orders_count, total_spent) VALUES (?, 0, 0)')
      .run(String(record.phone || '').replace(/\D/g, ''));
    account = { id: info.lastInsertRowid, phone: record.phone };
  }
  if (account) {
    bindTelegramAccount(record.role || 'customer',account.id,chatId);
  }
}


async function executeApprovedReport({chatId,type,params}) {
  if(type==='salesweek')return sendSalesWeekReport(chatId);
  if(type==='business')return sendBusinessYearReport(chatId,params.year);
  if(type==='businesspoints')return sendBusinessPointsOnly(chatId,params.year);
  if(type==='stock')return sendWarehouseStockReport(chatId,params.citySelector||'');
  if(type==='nogroomer')return sendNoGroomerReport(chatId,params.days);
  if(type==='payouts')return sendPayoutBriefs(chatId);
  if(type==='taskpdf')return sendFreshTaskPdf(chatId);
  if(type==='qrweek'){
    const result=await require('./qr-weekly-telegram').sendWeeklyQrReport({manual:true,approved:true});
    if(!result.ok)throw Error(result.error||result.reason||'QR-отчёт не сформирован');
    await replyToChat(chatId,result.skipped?'QR-отчёт за неделю уже отправлен.':
      '✅ QR-отчёт подтверждён и отправлен в служебный Telegram.');
    return;
  }
  if(type==='gdweek'){
    const admin=db.prepare("SELECT id,login FROM admins WHERE active=1 AND telegram_chat_id=? LIMIT 1").get(String(chatId));
    if(!admin)throw Error('Аккаунт администратора отключён');
    const reports=require('./weekly-report');
    const period=params.start&&params.end?reports.customPeriod(params.start,params.end):null;
    const created=await reports.createWeeklyReport(admin,{period,skipTelegram:!!params.skipTelegram});
    await replyToChat(chatId,'✅ Отчёт ГД за '+created.report.period.start_local+' — '+
      created.report.period.end_local+' сформирован. PDF и Excel находятся в архиве админки.'+
      (created.telegram.status==='sent'?' Файлы отправлены в служебный чат.':''));
    return;
  }
  if(['clubdaily','clubweekly','clubtopweek','clubtopall'].includes(type)){
    const result=require('./routes-partner-club').generateApprovedClubReport(type,{approved:true});
    if(!result.ok)throw Error(result.error||'Не удалось сформировать отчёт для Клуба партнёров');
    await replyToChat(chatId,result.created?
      '✅ Сводка сформирована и добавлена в очередь Клуба партнёров. Публикация по отдельному согласованию.':
      'Такая сводка уже есть в очереди Клуба партнёров.');
    return;
  }
  throw Error('Неизвестный тип отчёта');
}

async function processUpdate(update) {
  const callback = update.callback_query;
  if (callback) {

    // Only the original owner of a private chat can approve the 2GIS draft.
    if (/^dgis:(?:yes|edit|no):[0-9a-f]{18}$/.test(callback.data||'')) {
      const chat=callback.message?.chat;
      const allowed=chat?.type==='private' && String(chat.id)===String(callback.from?.id);
      const result=allowed
        ? import2gisLead.handle2gisCallback('telegram',chat.id,callback.data)
        : {ok:false,message:'Подтвердите контакт только в своём личном чате с ботом.'};
      try {
        await callBotApi('answerCallbackQuery',{
          callback_query_id:callback.id,
          text:String(result?.message||'Готово').slice(0,180),
          show_alert:!result?.ok,
        });
      } catch(error) {
        console.warn('[2GIS] Telegram callback acknowledgement:',error.message);
      }
      if(allowed){
        // Used approval buttons must not remain live after accept/edit/cancel.
        if(result?.ok && callback.message?.message_id){
          try{
            await callBotApi('editMessageReplyMarkup',{
              chat_id:chat.id,message_id:callback.message.message_id,
              reply_markup:{inline_keyboard:[]},
            });
          }catch(_){}
        }
        if(result?.message)await replyToChat(chat.id,result.message);
      }
      return;
    }

    if (/^report:(?:menu|new:[a-z]+|(?:yes|no):[0-9]+)$/.test(callback.data||'')) {
      const data=callback.data||'',chat=callback.message?.chat;
      const allowed=chat?.type==='private' && String(chat.id)===String(callback.from?.id);
      try {
        await callBotApi('answerCallbackQuery',{
          callback_query_id:callback.id,
          text:allowed?'Проверяем запрос':'Откройте личный чат с ботом',
          show_alert:!allowed,
        });
      } catch(error) {
        console.warn('[reports] Не удалось подтвердить нажатие:',error.message);
      }
      if(!allowed)return;
      if(data==='report:menu'){
        const menu=reportApprovals.menu(chat.id);
        await replyToChat(chat.id,menu.message,menu.reply_markup);
        return;
      }
      if(data.startsWith('report:new:')){
        await requestBotReport(chat.id,data.slice('report:new:'.length));
        return;
      }
      const match=data.match(/^report:(yes|no):([0-9]+)$/);
      const decision=reportApprovals.decideReport(chat.id,match[1],match[2]);
      if(!decision.ok || decision.cancelled){
        await replyToChat(chat.id,decision.message);
        return;
      }
      const approved=decision.request;
      await replyToChat(chat.id,'⏳ Подтверждено. Формирую отчёт по актуальным данным.');
      let success=false;
      try {
        await executeApprovedReport(approved);
        success=true;
      } catch(error) {
        console.error('[reports] Ошибка формирования:',approved.type,error);
        await replyToChat(chat.id,'⚠️ Не удалось сформировать отчёт. Проверьте журнал сервера и запросите новый.');
      } finally {
        reportApprovals.finishReport(approved.id,success);
      }
      return;
    }
    if (/^tier:(?:list|(?:approve|reject):\d+)$/.test(callback.data || '')) {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' &&
        String(chat.id) === String(callback.from?.id);
      let result;
      try {
        if (!allowed) result = { ok:false, message:'Подтвердить изменение ставки можно только в личном чате.' };
        else if (callback.data === 'tier:list') result = tierApprovals.requestCardList(chat.id);
        else {
          const match = callback.data.match(/^tier:(approve|reject):(\d+)$/);
          result = await tierApprovals.decideTierDowngrade(chat.id, match[1], match[2]);
        }
      } catch (error) {
        console.warn('[tier-approval] Callback failed:',error.message);
        result = {ok:false,message:'Не удалось обработать решение. Ставка не изменена. Повторите позднее.'};
      }
      try {
        await callBotApi('answerCallbackQuery', {
          callback_query_id:callback.id,
          text:String(result.message || 'Готово').slice(0,180),
          show_alert:!result.ok,
        });
      } catch (error) { console.warn('[tier-approval] callback acknowledgement:',error.message); }
      if (allowed) {
        if (result.message) await replyToChat(chat.id,result.message);
        for (const card of result.cards || []) {
          await replyToChat(chat.id,card.message,card.reply_markup,'HTML');
        }
      }
      return;
    }
    if (/^newprod:/.test(callback.data || '')) {
      const chat = callback.message?.chat;
      const permitted = chat?.type === 'private' &&
        String(chat.id) === String(callback.from?.id);
      const result = permitted
        ? newProductBroadcast.handleCallback(chat.id, callback.data)
        : { ok: false, message: '🔒 Доступно только в личном чате администратора.' };
      try {
        await callBotApi('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: result.ok ? 'Готово' : String(result.message).slice(0, 180),
          show_alert: !result.ok,
        });
      } catch (error) {
        console.warn('[new-product] Не удалось подтвердить нажатие:', error.message);
      }
      if (permitted) await replyNewProduct(chat.id, result);
      return;
    }
    if (/^tsk:due:/.test(callback.data || '')) {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' &&
        String(callback.from?.id) === String(chat.id);
      const result = allowed
        ? handleTaskDueCallback('telegram', chat.id, callback.data)
        : {ok:false,message:'Изменять сроки можно только в своём личном чате.'};
      try {
        await callBotApi('answerCallbackQuery', {
          callback_query_id:callback.id,
          text:result?.ok ? 'Готово' : String(result?.message || 'Ошибка действия').slice(0,180),
          show_alert:!result?.ok,
        });
      } catch (error) {
        console.warn('[tasks] Не удалось подтвердить изменение срока:',error.message);
      }
      if (allowed && result) await editOrReplyTaskCard(callback,result);
      return;
    }
    if (/^tsk:(?:page|open|confirm):/.test(callback.data || '')) {
      if (callback.message?.chat?.type === 'private')
        cancelTaskDueInput('telegram',callback.message.chat.id);
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' &&
        String(callback.from?.id) === String(chat.id);
      const result = allowed
        ? handleTaskListNavigation('telegram', chat.id, callback.data)
        : { ok: false, message:'Поручения доступны только в личном чате.' };
      try {
        await callBotApi('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: result?.ok ? 'Готово' : String(result?.message || 'Нет доступа').slice(0,180),
          show_alert: !result?.ok,
        });
      } catch (error) {
        console.warn('[tasks] Ошибка подтверждения нажатия:', error.message);
      }
      if (allowed && result?.ok) await editOrReplyTaskCard(callback, result);
      return;
    }
    if (callback.data === 'warehouse:stock') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Собираем актуальные остатки' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'stock');
      return;
    }
    if (callback.data === 'sales:nogroomer') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Собираем заказы без грумера' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'nogroomer');
      return;
    }
    if (callback.data === 'payouts:prepare') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Готовим справки к выплатам' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'payouts');
      return;
    }
    if (callback.data === 'sales:businesspoints') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Собираем реестр всех точек' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'businesspoints');
      return;
    }
    if (callback.data === 'sales:business') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Собираем годовой отчёт' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'business');
      return;
    }
    if (callback.data === 'sales:week') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id, text: allowed ? 'Формируем отчёт' : 'Нет доступа', show_alert: !allowed,
      });
      if (allowed) await requestBotReport(chat.id,'salesweek');
      return;
    }
    if (callback.data === 'club:new') {
      const chatId = callback.message?.chat?.id;
      const result = require('./routes-partner-club').startClubPost(chatId);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: result.ok ? 'Введите текст публикации' : 'Нет доступа',
        show_alert: !result.ok,
      });
      if (chatId) await replyToChat(chatId, result.message);
      return;
    }
    if (/^club:(?:done|photosdone|cancelphotos|addphoto:\d+|clearphotos:\d+)$/.test(callback.data||'')) {
      const chat=callback.message?.chat;
      const allowed=chat?.type==='private' &&
        String(chat.id)===String(callback.from?.id);
      const club=require('./routes-partner-club');
      const result=allowed
        ? await club.handleClubPhotoCallback(chat.id,callback.data)
        : {ok:false,message:'Эти действия доступны только модератору в личном чате.'};
      try{
        await callBotApi('answerCallbackQuery',{
          callback_query_id:callback.id,
          text:String(result.message||'Готово').slice(0,180),
          show_alert:!result.ok,
        });
      }catch(error){
        console.warn('[partner-club] Не удалось подтвердить фото:',error.message);
      }
      if(allowed&&result.message)
        await replyToChat(chat.id,result.message,result.reply_markup,result.parse_mode);
      return;
    }
    if (/^club:(send|edit|reject|reroll):\d+$/.test(callback.data||'')) {
      const club=require('./routes-partner-club');
      const result=await club.handleClubCallback(callback.message?.chat?.id,callback.data);
      if(result?.rerolled){
        // Replace the original draft in-place, preserving its approval buttons.
        // The selected ending is already persisted before this Telegram call.
        let updated=false;
        try{
          await callBotApi('editMessageText',{
            chat_id:callback.message.chat.id,
            message_id:callback.message.message_id,
            text:result.preview_html,
            parse_mode:'HTML',
            reply_markup:result.reply_markup,
          });
          updated=true;
        }catch(error){
          console.warn('[partner-club] Не удалось обновить черновик, отправляем новый:',error.message);
        }
        try{
          await callBotApi('answerCallbackQuery',{
            callback_query_id:callback.id,
            text:String(result.message).slice(0,180),
            show_alert:false,
          });
        }catch(error){
          console.warn('[partner-club] Не удалось подтвердить смену поздравления:',error.message);
        }
        if(!updated){
          // Some older drafts can no longer be edited by Telegram.
          // Send a fresh, correctly formatted copy rather than losing the preview.
          await replyToChat(callback.message.chat.id,result.preview_html,result.reply_markup,'HTML');
        }
        return;
      }
      await callBotApi('answerCallbackQuery',{callback_query_id:callback.id,text:String(result?.message||'Готово').slice(0,180),show_alert:!result?.ok});
      if(result && !/^club:reroll:/.test(callback.data||''))
        await replyToChat(callback.message.chat.id,result.message);
      return;
    }
    const chatId = callback.message && callback.message.chat
      ? callback.message.chat.id
      : callback.from && callback.from.id;
    // Switching actions ends an unfinished custom-date entry.
    if (/^(?:newtsk:|expense:|tsk:\d+:(?:work|status|done):)/.test(callback.data || ''))
      cancelTaskDueInput('telegram',chatId);
    const expenseCallbackInGroup=String(callback.data||'').startsWith('expense:') &&
      callback.message?.chat?.type && callback.message.chat.type!=='private';
    const result = (expenseCallbackInGroup
      ? {ok:false,message:'Траты и чеки можно оформлять только в личном чате с ботом.'}
      : handleExpenseCallback('telegram', chatId, callback.data))
      || handleTaskCreateCallback('telegram', chatId, callback.data)
      || handleTaskCallback('telegram', chatId, callback.data);
    if (result) {
      try {
        await callBotApi('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: result.ok ? 'Готово' : String(result.message).slice(0, 180),
          show_alert: !result.ok,
        });
      } catch (error) {
        console.warn('Не удалось подтвердить нажатие кнопки Telegram:', error.message);
      }
      if (/^tsk:\d+:(?:work|status|done):/.test(callback.data || '')) {
        await editOrReplyTaskCard(callback, {
          message: result.message,
          replyMarkup: taskListMarkup(),
        });
      } else {
        await replyToChat(chatId, result.message, result.replyMarkup);
      }
      if (result.ok && result.expenseId &&
          (callback.data === 'expense:confirm' || result.retryPending)) {
        const pending=await processPendingExpenseAttachments('telegram',chatId);
        if(pending)await replyToChat(chatId,pending.message,pending.replyMarkup);
      }
      if (result.created && result.task && result.assignee && result.assignee.telegram_chat_id) {
        await replyToChat(
          result.assignee.telegram_chat_id,
          '🆕 Вам назначена новая задача\n\n' + taskBotCard(result.task),
          taskButtons(result.task, 'telegram')
        );
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  if (msg.contact) {
    // Bot API delivers a self-contact message even when the consent was
    // requested by Mini App WebApp.requestContact(), not a bot command.
    const result = recordVerifiedTelegramContact(msg);
    if (msg.chat && msg.chat.type === 'private') {
      if (result.verified) {
        await replyToChat(msg.chat.id,
          '✅ Номер Telegram подтверждён: ' + result.phoneMasked +
          '\nВернитесь в Mini App — ваши кабинеты появятся автоматически.',
          { remove_keyboard: true }
        );
      } else {
        await replyToChat(msg.chat.id,
          'Не удалось подтвердить номер. Нужен именно ваш контакт Telegram, отправленный кнопкой «Поделиться своим номером». ' +
          'Перешлите свой контакт через /phone, а не выбирайте номер из адресной книги.'
        );
      }
    }
    return;
  }
  // An expense upload window has priority over club photo drafts. Only its
  // original verified private chat may attach receipts to the saved expense.
  if (msg.chat?.type === 'private' &&
      (msg.document || (Array.isArray(msg.photo) && msg.photo.length))) {
    const attached=await handleExpenseAttachmentMessage('telegram',msg.chat.id,msg);
    if(attached){
      await replyToChat(msg.chat.id,attached.message,attached.replyMarkup);
      return;
    }
  }
  if (msg.chat?.type === 'private') {
    const pendingNewProduct = newProductBroadcast.messageInput(msg);
    if (pendingNewProduct) {
      await replyNewProduct(msg.chat.id, pendingNewProduct);
      return;
    }
  }
  if(msg.chat?.type==='private'&&Array.isArray(msg.photo)&&msg.photo.length){
    const received=await require('./routes-partner-club').handleClubPhotoMessage(msg);
    if(received){
      if(!received.silent&&received.message)
        await replyToChat(msg.chat.id,received.message,received.reply_markup,received.parse_mode);
      return;
    }
  }
  if (!msg.text) return;
  const text = msg.text.trim();
  // Hidden diagnostics for an actively linked administrator: resync the
  // Telegram command menu without changing permissions or touching CRM data.
  if (msg.chat.type === 'private' && /^\/syncmenu(?:@\w+)?$/i.test(text)) {
    const ownChat = String(msg.from?.id) === String(msg.chat.id);
    const admin = ownChat && db.prepare(
      "SELECT id FROM admins WHERE active=1 AND role IN ('super','admin') AND CAST(telegram_chat_id AS TEXT)=?"
    ).get(String(msg.chat.id));
    if (!admin) {
      await replyToChat(msg.chat.id, '🔒 Обновлять меню бота может только привязанный администратор.');
      return;
    }
    const result = await syncTelegramBotCommands();
    if (result.ok) {
      if (commandMenuRetryTimer) clearTimeout(commandMenuRetryTimer);
      commandMenuRetryTimer = null;
      commandMenuRetryCount = 0;
      await replyToChat(msg.chat.id,
        '✅ Меню команд Telegram обновлено и проверено. Команда /contact опубликована для личных чатов и русского языка. Закройте и откройте меню бота повторно.');
    } else {
      scheduleBotMenuRetry();
      await replyToChat(msg.chat.id,
        '⚠️ Telegram пока не подтвердил обновление меню ('+result.failed.join(', ')+'). Запланирована повторная попытка. Команду /contact можно отправлять вручную.');
    }
    return;
  }
  if (msg.chat.type==='private' && /^\/reports(?:@\w+)?$/i.test(text)) {
    const menu=reportApprovals.menu(msg.chat.id);
    await replyToChat(msg.chat.id,menu.message,menu.reply_markup);
    return;
  }
  if (msg.chat.type === 'private' && /^\/newproduct(?:@\w+)?$/i.test(text)) {
    await replyNewProduct(msg.chat.id, newProductBroadcast.startBroadcast(msg.chat.id));
    return;
  }
  if (msg.chat.type === 'private') {
    const create = text.match(/^\/clubpost(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    if (create) {
      const club = require('./routes-partner-club');
      const started = club.startClubPost(msg.chat.id);
      if (!started.ok || !create[1]) await replyToChat(msg.chat.id, started.message);
      else {
        const startOffset=msg.text.indexOf(create[1]);
        const adjusted=(msg.entities||[]).map(e=>({...e,offset:e.offset-startOffset}));
        const result = await club.handleClubPostInput(msg.chat.id, create[1],adjusted);
        if (result) await replyToChat(msg.chat.id, result.message, result.reply_markup, result.parse_mode);
      }
      return;
    }
  }
  if(msg.chat.type==='private'&&/^\/clubtext(?:@\w+)?\s+/i.test(text)){
    const result=await require('./routes-partner-club').handleClubEdit(msg.chat.id,msg.text,msg.entities);
    if(result)await replyToChat(msg.chat.id,result.message,result.reply_markup,result.parse_mode);
    return;
  }

  // Respond to group ID requests; never run private task/account commands in groups.
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    if (/^\/chatid(?:@\w+)?$/i.test(text)) {
      await replyToChat(msg.chat.id, '🐾 ID этой группы: ' + String(msg.chat.id) + '\nСкопируйте число для подключения Клуба партнёров.');
    }
    return;
  }

  // Import 2GIS companies into the SAME CRM shared by manager mini-app and admin.
  // A private Telegram account must be linked to an active manager/admin.
  if (msg.chat.type === 'private') {
    const imported = await import2gisLead.handle2gisText('telegram', msg.chat.id, text);
    if (imported) {
      await replyToChat(msg.chat.id, imported.message, imported.reply_markup);
      return;
    }
  }

  if (msg.chat.type === 'private' && /^\/tierapprovals(?:@\w+)?$/i.test(text)) {
    const result = tierApprovals.requestCardList(msg.chat.id);
    await replyToChat(msg.chat.id,result.message);
    for (const card of result.cards || []) {
      await replyToChat(msg.chat.id,card.message,card.reply_markup,'HTML');
    }
    return;
  }

  // Alternative for Telegram clients without the native Mini App phone popup.
  if (msg.chat.type === 'private' && /^\/phone(?:@\w+)?$/i.test(text)) {
    await replyToChat(msg.chat.id,
      '🔐 Для входа без пароля нужно подтвердить номер телефона, который указан в ХвостМаркете. ' +
      'Нажмите кнопку ниже и разрешите Telegram отправить именно ваш номер.',
      { keyboard: [[{ text: '📱 Поделиться своим номером', request_contact: true }]],
        one_time_keyboard: true, resize_keyboard: true }
    );
    return;
  }

  // One universal launch. Keep old /shop and /cabinet commands as aliases
  // so earlier Telegram messages remain useful after this update.
  if (msg.chat.type === 'private' && /^\/(?:app|shop|cabinet)(?:@\w+)?$/i.test(text)) {
    await replyToChat(
      msg.chat.id,
      '🐾 Откройте ХвостМаркет. Подтвердите свой номер и выберите магазин или один из доступных вам кабинетов.',
      miniAppDirectLinkMarkup('app', { fresh: true })
    );
    return;
  }

  if (msg.chat.type === 'private') {
    const pending = await require('./routes-partner-club').handleClubPostInput(msg.chat.id, msg.text, msg.entities);
    if (pending) {
      await replyToChat(msg.chat.id, pending.message, pending.reply_markup, pending.parse_mode);
      return;
    }
  }

  const stockCommand = text.match(/^\/stock(?:@\w+)?(?:\s+(.+))?$/i);
  if (stockCommand) {
    const citySelector = (stockCommand[1] || '').trim();
    if (citySelector.length > 80 || /[\x00-\x1f\x7f]/.test(citySelector)) {
      await replyToChat(msg.chat.id,
        'Формат: /stock — все города, /stock krsk — склад Красноярска.');
    } else {
      await requestBotReport(msg.chat.id,'stock',{citySelector});
    }
    return;
  }
  const noGroomerCommand = text.match(/^\/nogroomer(?:@\w+)?(?:\s+(\S+))?$/i);
  if (noGroomerCommand) {
    if (noGroomerCommand[1] && !['7', '30'].includes(noGroomerCommand[1])) {
      await replyToChat(msg.chat.id,
        'Используйте /nogroomer — за всё время, /nogroomer 7 или /nogroomer 30.');
    } else {
      await requestBotReport(msg.chat.id,'nogroomer',
        noGroomerCommand[1] ? {days:Number(noGroomerCommand[1])} : {});
    }
    return;
  }
  if (/^\/(?:payouts|payoutbrief)(?:@\w+)?$/i.test(text) || /^справк[аи] (?:для |к )?выплат[аым]?$/i.test(text)) {
    await requestBotReport(msg.chat.id,'payouts');
    return;
  }
  const businessPointsCommand = text.match(/^\/businesspoints(?:@\w+)?(?:\s+(.+))?$/i);
  if (businessPointsCommand) {
    const arg = businessPointsCommand[1];
    if (arg && !/^\d{4}$/.test(arg)) {
      await replyToChat(msg.chat.id,
        'Формат: /businesspoints — текущий год, /businesspoints 2025 — выбранный год.');
    } else {
      await requestBotReport(msg.chat.id,'businesspoints',arg?{year:Number(arg)}:{});
    }
    return;
  }
  const businessCommand = text.match(/^\/business(?:@\w+)?(?:\s+(.+))?$/i);
  if (businessCommand) {
    const arg = businessCommand[1];
    if (arg && !/^\d{4}$/.test(arg)) {
      await replyToChat(msg.chat.id,
        'Формат: /business — текущий год, /business 2025 — полный выбранный год.');
    } else {
      await requestBotReport(msg.chat.id,'business',arg?{year:Number(arg)}:{});
    }
    return;
  }
  if (/^\/(?:salesweek|sales_week)(?:@\w+)?$/i.test(text) || /^отч[её]т(?: по продажам)? за неделю$/i.test(text)) {
    await requestBotReport(msg.chat.id,'salesweek');
    return;
  }
  if (/^\/newtask(?:@\w+)?$/i.test(text) || /^новая задача$/i.test(text)) {
    cancelTaskDueInput('telegram', msg.chat.id);
    cancelExpenseCreation('telegram', msg.chat.id);
    const result = startTaskCreation('telegram', msg.chat.id);
    await replyToChat(msg.chat.id, result.message, result.replyMarkup);
    return;
  }
  if (/^\/expense(?:@\w+)?$/i.test(text) || /^добавить трату$/i.test(text)) {
    cancelTaskDueInput('telegram', msg.chat.id);
    const result = startExpenseCreation('telegram', msg.chat.id);
    await replyToChat(msg.chat.id, result.message, result.replyMarkup);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    const createCancelled = cancelTaskCreation('telegram', msg.chat.id);
    const expenseCancelled = cancelExpenseCreation('telegram', msg.chat.id);
    const statusCancelled = db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?')
      .run('telegram', String(msg.chat.id)).changes > 0;
    const dateCancelled = cancelTaskDueInput('telegram', msg.chat.id);
    const newProductCancelled = newProductBroadcast.cancelDraft(msg.chat.id);
    const clubPhotoCancelled = require('./routes-partner-club').cancelClubInput(msg.chat.id);
    const reportCancelled = reportApprovals.cancelPendingReports(msg.chat.id);
    await replyToChat(
      msg.chat.id,
      createCancelled || expenseCancelled || statusCancelled || dateCancelled || newProductCancelled || clubPhotoCancelled || reportCancelled ? 'Текущее действие отменено.' : 'Нет незавершённых действий.',
      botActionButtons(msg.chat.id)
    );
    return;
  }
  if (/^\/taskpdf(?:@\w+)?$/i.test(text)) {
    await requestBotReport(msg.chat.id,'taskpdf');
    return;
  }
  if (/^\/tasks(?:@\w+)?$/i.test(text) || /^мои поручения$/i.test(text)) {
    cancelTaskDueInput('telegram', msg.chat.id);
    await sendTaskInbox(msg.chat.id);
    return;
  }
  const dueChange = handleTaskDueMessage('telegram', msg.chat.id, text);
  if (dueChange) {
    await replyToChat(msg.chat.id, dueChange.message, dueChange.replyMarkup);
    return;
  }
  const expenseCreation = handleExpenseMessage('telegram', msg.chat.id, text);
  if (expenseCreation) {
    await replyToChat(msg.chat.id, expenseCreation.message, expenseCreation.replyMarkup);
    return;
  }
  const taskCreation = handleTaskCreateMessage('telegram', msg.chat.id, text);
  if (taskCreation) {
    await replyToChat(msg.chat.id, taskCreation.message, taskCreation.replyMarkup);
    if (taskCreation.created && taskCreation.task && taskCreation.assignee && taskCreation.assignee.telegram_chat_id) {
      await replyToChat(
        taskCreation.assignee.telegram_chat_id,
        '🆕 Вам назначена новая задача\n\n' + taskBotCard(taskCreation.task),
        taskButtons(taskCreation.task, 'telegram')
      );
    }
    return;
  }
  const taskStatus = handleTaskStatusMessage('telegram', msg.chat.id, text);
  if (taskStatus) {
    await replyToChat(msg.chat.id, taskStatus.message);
    return;
  }
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!match || !match[1]) {
    await replyToChat(msg.chat.id, buildWelcomeMessage(), botActionButtons(msg.chat.id));
    return;
  }

  const token = match[1];
  const record = db.prepare(
    "SELECT * FROM telegram_login_tokens WHERE token = ? AND verified = 0 AND expires_at > datetime('now')"
  ).get(token);

  if (!record) {
    await replyToChat(msg.chat.id, 'Ссылка для входа устарела или уже использована. Вернитесь на сайт «ХвостМаркета» и запросите новую.');
    return;
  }

  const code = generateLoginCode();
  db.prepare('UPDATE telegram_login_tokens SET verified = 1, chat_id = ?, code = ? WHERE id = ?')
    .run(String(msg.chat.id), code, record.id);
  rememberChatForAccount(record, msg.chat.id);
  await replyToChat(
    msg.chat.id,
    '✅ Telegram для кабинета ' + accountRoleText(record.role) + ' подключён!\n\n' +
    'Вернитесь на вкладку с сайтом «ХвостМаркета» — подключение завершится автоматически.\n\n' +
    'Если через несколько секунд ничего не произошло, введите на сайте код вручную: ' + code
  );
  if (record.role === 'task_assignee') {
    await sendTaskInbox(msg.chat.id);
  }
}

async function pollOnce() {
  if (!TG_TOKEN) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
      { signal: AbortSignal.timeout(30000) }
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !Array.isArray(data.result)) {
      // A revoked token, webhook conflict or Telegram rate limit can respond
      // immediately. Without backoff the loop floods the API and burns CPU.
      console.warn('Опрос Telegram: API ответил ошибкой', res.status, data.error_code || '');
      return false;
    }
    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      await processUpdate(update);
    }
    return true;
  } catch (e) {
    // Тихо игнорируем отдельные сбои опроса (сеть моргнула и т.п.) — просто
    // попробуем снова на следующей итерации, ничего не роняем.
    // e.cause содержит настоящую причину сетевого сбоя (код вроде ENOTFOUND/
    // ECONNREFUSED/ETIMEDOUT) — без неё "fetch failed" ничего не говорит о
    // реальной причине.
    console.warn('Опрос Telegram: сбой (пробуем снова):', e.message, e.cause ? '| причина: ' + JSON.stringify({ code: e.cause.code, errno: e.cause.errno, syscall: e.cause.syscall, address: e.cause.address }) : '(без деталей)');
    return false;
  }
}

async function startPolling() {
  if (!TG_TOKEN) {
    console.warn('Вход через Telegram выключен — не задан TG_TOKEN');
    return;
  }
  if (polling) return;
  polling = true;
  newProductBroadcast.startBroadcastWorker();
  tierApprovals.startTierApprovalNotifications();
  require('./telegram-connection-alerts').startBotConnectionAlertWorker();
  await configureBotProfile();
  console.log('Опрос Telegram для входа в личный кабинет запущен');
  let failures = 0;
  while (polling) {
    const ok = await pollOnce();
    if (ok) { failures = 0; continue; }
    failures = Math.min(failures + 1, 5);
    // Retry after 2, 4, 8, 16, then 30 seconds on repeated failures.
    if (polling) await new Promise(resolve =>
      setTimeout(resolve, Math.min(30000, 1000 * 2 ** failures)));
  }
}

function stopPolling() {
  polling = false;
  if (commandMenuRetryTimer) clearTimeout(commandMenuRetryTimer);
  commandMenuRetryTimer = null;
  commandMenuRetryCount = 0;
}

module.exports = { startPolling, stopPolling, processUpdate, configureBotProfile, syncTelegramBotCommands, TELEGRAM_BOT_COMMANDS, buildWelcomeMessage };
