// telegram-login-poller.js — фоновый опрос Telegram (long polling) для входа
// в личный кабинет клиента через бота. Бот не может написать клиенту первым,
// поэтому клиент сам открывает диалог по ссылке-приглашению с токеном
// (t.me/BOT?start=ТОКЕН) — это и есть подтверждение входа.
'use strict';
// Redeploy trigger: refresh Telegram /chatid group command handler (2026-10-22).


const db = require('./db');
const crypto = require('node:crypto');
const {
  getTaskInbox,
  handleTaskCallback,
  handleTaskStatusMessage,
  taskBotCard,
  taskButtons,
} = require('./task-bot-actions');
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

const TG_TOKEN = process.env.TG_TOKEN || '';
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
let lastUpdateId = 0;
let polling = false;

const BOT_NAME = 'ХвостМаркет';
const BOT_DESCRIPTION = 'Помогаю входить в кабинет, работать с поручениями и получать уведомления ХвостМаркета.';
const BOT_SHORT_DESCRIPTION = 'Кабинет, поручения и уведомления ХвостМаркета.';

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

// Отображаемое имя, описание и меню команд поддерживаем из кода, чтобы после
// очередного деплоя бот не оставался оформлен под старый бренд. Ошибка любой
// из этих косметических операций не должна останавливать вход и уведомления.
async function configureBotProfile() {
  if (!TG_TOKEN) return { ok: false, skipped: true };
  const operations = [
    ['setMyName', { name: BOT_NAME }],
    ['setMyDescription', { description: BOT_DESCRIPTION }],
    ['setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION }],
    ['setMyCommands', { commands: [
      { command: 'start', description: 'Открыть помощника ХвостМаркета' },
      { command: 'tasks', description: 'Мои активные поручения' },
      { command: 'newtask', description: 'Создать новую задачу' },
      { command: 'expense', description: 'Добавить трату бизнеса' },
      { command: 'salesweek', description: 'Отчёт по продажам за 7 дней' },
      { command: 'business', description: 'Бизнес по месяцам и за год' },
      { command: 'businesspoints', description: 'Все точки: CSV со статистикой' },
      { command: 'stock', description: 'Актуальные остатки центрального склада' },
      { command: 'nogroomer', description: 'Оплаченные заказы без грумера' },
      { command: 'payouts', description: 'Справка для выплат партнёрам' },
      { command: 'clubpost', description: 'Сообщение в Клуб партнёров' },
      { command: 'cancel', description: 'Отменить текущее действие' },
      { command: 'help', description: 'Как пользоваться ботом' },
      { command: 'chatid', description: 'Показать ID текущей группы' },
    ] }],
  ];
  const results = await Promise.allSettled(operations.map(([method, body]) => callBotApi(method, body)));
  const failed = results
    .map((result, index) => ({ result, method: operations[index][0] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, method } of failed) {
    console.warn(`Telegram: не удалось обновить ${method}:`, result.reason.message);
  }
  return { ok: failed.length === 0, failed: failed.map(({ method }) => method) };
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
    'Я помогу войти в личный кабинет и буду присылать важные уведомления о заказах, продажах и вознаграждениях.',
    '',
    'Сотрудникам: /tasks покажет активные поручения, /newtask создаст задачу, а /expense запишет трату бизнеса.',
    'Администраторам: /salesweek — продажи за 7 дней; /business — помесячные показатели и итоги года; /businesspoints — реестр всех точек; /stock — остатки центрального склада; /nogroomer — заказы без грумера; /payouts — справки для выплат.',
    '',
    'Чтобы подключить кабинет, откройте на сайте вход через Telegram и перейдите по созданной ссылке.',
  ].join('\n');
}

function botActionButtons(chatId) {
  const keyboard = [[
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
  }
  if (chatId && require('./routes-partner-club').isClubModerator(chatId)) {
    keyboard.push([{ text: '🐾 Сообщение партнёрам', callback_data: 'club:new' }]);
  }
  return { inline_keyboard: keyboard };
}

async function sendTaskInbox(chatId) {
  const inbox = getTaskInbox('telegram', chatId);
  if (!inbox) {
    await replyToChat(chatId, 'Ваш Telegram ещё не связан с ответственным. Подключите его в разделе «Поручения» админки.');
    return;
  }
  if (!inbox.tasks.length) {
    await replyToChat(chatId, '✅ У вас нет активных поручений.', botActionButtons(chatId));
    return;
  }
  await replyToChat(
    chatId,
    `Активные поручения: ${inbox.tasks.length}. Выберите действие под нужной задачей.`,
    botActionButtons(chatId)
  );
  for (const task of inbox.tasks) {
    await replyToChat(chatId, taskBotCard(task), taskButtons(task, 'telegram'));
  }
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
        report.generated_at.slice(0,10) + '.csv',
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
    admin: 'admins',
    task_assignee: 'task_assignees',
  };
  const table = tableByRole[record.role || 'customer'];
  if (!table) return;
  if (record.account_id) {
    db.prepare(`UPDATE ${table} SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), record.account_id);
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
    db.prepare(`UPDATE ${table} SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), account.id);
  }
}

async function processUpdate(update) {
  const callback = update.callback_query;
  if (callback) {
    if (callback.data === 'warehouse:stock') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: allowed ? 'Собираем актуальные остатки' : 'Нет доступа',
        show_alert: !allowed,
      });
      if (allowed) await sendWarehouseStockReport(chat.id);
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
      if (allowed) await sendNoGroomerReport(chat.id);
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
      if (allowed) await sendPayoutBriefs(chat.id);
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
      if (allowed) await sendBusinessPointsOnly(chat.id);
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
      if (allowed) await sendBusinessYearReport(chat.id);
      return;
    }
    if (callback.data === 'sales:week') {
      const chat = callback.message?.chat;
      const allowed = chat?.type === 'private' && adminCanReadSales(chat.id);
      await callBotApi('answerCallbackQuery', {
        callback_query_id: callback.id, text: allowed ? 'Формируем отчёт' : 'Нет доступа', show_alert: !allowed,
      });
      if (allowed) await sendSalesWeekReport(chat.id);
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
    if (/^club:(send|edit|reject):\d+$/.test(callback.data||'')) {
      const club=require('./routes-partner-club');
      const result=await club.handleClubCallback(callback.message?.chat?.id,callback.data);
      await callBotApi('answerCallbackQuery',{callback_query_id:callback.id,text:String(result?.message||'Готово').slice(0,180),show_alert:!result?.ok});
      if(result)await replyToChat(callback.message.chat.id,result.message);
      return;
    }
    const chatId = callback.message && callback.message.chat
      ? callback.message.chat.id
      : callback.from && callback.from.id;
    const result = handleExpenseCallback('telegram', chatId, callback.data)
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
      await replyToChat(chatId, result.message, result.replyMarkup);
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
  if (!msg || !msg.text) return;
  const text = msg.text.trim();
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
      await sendWarehouseStockReport(msg.chat.id, citySelector);
    }
    return;
  }
  const noGroomerCommand = text.match(/^\/nogroomer(?:@\w+)?(?:\s+(\S+))?$/i);
  if (noGroomerCommand) {
    if (noGroomerCommand[1] && !['7', '30'].includes(noGroomerCommand[1])) {
      await replyToChat(msg.chat.id,
        'Используйте /nogroomer — за всё время, /nogroomer 7 или /nogroomer 30.');
    } else {
      await sendNoGroomerReport(msg.chat.id,
        noGroomerCommand[1] ? Number(noGroomerCommand[1]) : undefined);
    }
    return;
  }
  if (/^\/(?:payouts|payoutbrief)(?:@\w+)?$/i.test(text) || /^справк[аи] (?:для |к )?выплат[аым]?$/i.test(text)) {
    await sendPayoutBriefs(msg.chat.id);
    return;
  }
  const businessPointsCommand = text.match(/^\/businesspoints(?:@\w+)?(?:\s+(.+))?$/i);
  if (businessPointsCommand) {
    const arg = businessPointsCommand[1];
    if (arg && !/^\d{4}$/.test(arg)) {
      await replyToChat(msg.chat.id,
        'Формат: /businesspoints — текущий год, /businesspoints 2025 — выбранный год.');
    } else {
      await sendBusinessPointsOnly(msg.chat.id, arg ? Number(arg) : undefined);
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
      await sendBusinessYearReport(msg.chat.id, arg ? Number(arg) : undefined);
    }
    return;
  }
  if (/^\/(?:salesweek|sales_week)(?:@\w+)?$/i.test(text) || /^отч[её]т(?: по продажам)? за неделю$/i.test(text)) {
    await sendSalesWeekReport(msg.chat.id);
    return;
  }
  if (/^\/newtask(?:@\w+)?$/i.test(text) || /^новая задача$/i.test(text)) {
    cancelExpenseCreation('telegram', msg.chat.id);
    const result = startTaskCreation('telegram', msg.chat.id);
    await replyToChat(msg.chat.id, result.message, result.replyMarkup);
    return;
  }
  if (/^\/expense(?:@\w+)?$/i.test(text) || /^добавить трату$/i.test(text)) {
    const result = startExpenseCreation('telegram', msg.chat.id);
    await replyToChat(msg.chat.id, result.message, result.replyMarkup);
    return;
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    const createCancelled = cancelTaskCreation('telegram', msg.chat.id);
    const expenseCancelled = cancelExpenseCreation('telegram', msg.chat.id);
    const statusCancelled = db.prepare('DELETE FROM task_bot_pending_inputs WHERE channel = ? AND chat_id = ?')
      .run('telegram', String(msg.chat.id)).changes > 0;
    await replyToChat(
      msg.chat.id,
      createCancelled || expenseCancelled || statusCancelled ? 'Текущее действие отменено.' : 'Нет незавершённых действий.',
      botActionButtons(msg.chat.id)
    );
    return;
  }
  if (/^\/tasks(?:@\w+)?$/i.test(text) || /^мои поручения$/i.test(text)) {
    await sendTaskInbox(msg.chat.id);
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
  if (!TG_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`,
      { signal: AbortSignal.timeout(30000) }
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;
    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      await processUpdate(update);
    }
  } catch (e) {
    // Тихо игнорируем отдельные сбои опроса (сеть моргнула и т.п.) — просто
    // попробуем снова на следующей итерации, ничего не роняем.
    // e.cause содержит настоящую причину сетевого сбоя (код вроде ENOTFOUND/
    // ECONNREFUSED/ETIMEDOUT) — без неё "fetch failed" ничего не говорит о
    // реальной причине.
    console.warn('Опрос Telegram: сбой (пробуем снова):', e.message, e.cause ? '| причина: ' + JSON.stringify({ code: e.cause.code, errno: e.cause.errno, syscall: e.cause.syscall, address: e.cause.address }) : '(без деталей)');
  }
}

async function startPolling() {
  if (!TG_TOKEN) {
    console.warn('Вход через Telegram выключен — не задан TG_TOKEN');
    return;
  }
  if (polling) return;
  polling = true;
  await configureBotProfile();
  console.log('Опрос Telegram для входа в личный кабинет запущен');
  while (polling) {
    await pollOnce();
  }
}

function stopPolling() {
  polling = false;
}

module.exports = { startPolling, stopPolling, processUpdate, configureBotProfile, buildWelcomeMessage };
