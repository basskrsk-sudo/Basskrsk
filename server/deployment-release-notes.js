// Bilingual release notes for startup notices. Avoid external translation APIs:
// Telegram delivery must not depend on third-party machine translation.
'use strict';

// Human-reviewed translations for older public GitHub commits that had no RU
// release-notes footer. New changes should carry "Release-notes-ru: ..." in
// the commit body so full meaning can be preserved without a translator key.
const LEGACY_RU = new Map(Object.entries({
  'fix(test): validate Russian missing-date prompt with literal text':
    'Исправлена проверка русскоязычного запроса недостающих дат создания точек.',
  'feat(business): include monthly sales and revenue for every point in complete registry CSV':
    'Добавлена помесячная выручка и число продаж каждой точки в полный CSV-реестр.',
  'test(business): assert missing date question in point registry summary':
    'Добавлена проверка запроса недостающих дат создания в сводке точек.',
  'feat(business): ask for missing creation dates and clarify all points are included in CSV':
    'Бот запрашивает неизвестные даты создания точек; CSV включает все точки.',
  'test(business): verify all five registry points including zero-sale and unknown-date entries':
    'Проверен полный список точек, включая точки без продаж и без даты создания.',
  'feat(telegram): attach CSV listing all points and missing creation dates to /business':
    'К команде /business прикреплён CSV со всеми точками и отсутствующими датами создания.',
  'fix(business): Excel-safe point registry CSV with correct BOM, line breaks, and sanitization':
    'Исправлена выгрузка реестра точек для Excel: кодировка, строки и безопасный текст.',
  'feat(business): include every active/inactive point with sale totals and identify missing registration dates':
    'В отчёт включены активные и отключённые точки; отмечены отсутствующие даты регистрации.',
  'polish(admin): show provenance for recovered historic point dates':
    'В админке показано, откуда получены восстановленные даты создания точек.',
  'chore(pwa): refresh admin panel cache to show point creation dates':
    'Обновлён кеш админки для отображения дат создания точек.',
  'fix(report): flag unknown historical creation dates in Telegram and CSV without guessing':
    'Неизвестные исторические даты создания помечаются в Telegram и CSV без подстановки догадок.',
  'test(points): migrate legacy creation dates, preserve unknowns and capture new records':
    'Проверены перенос старых дат создания, сохранение неизвестных дат и фиксация новых.',
  'fix(points): recover legacy dates even when stored creation timestamp is blank':
    'Восстановление старых дат создания работает также при пустом значении даты.',
  'feat(admin): display recovered point creation dates in audit filter':
    'В журнале админки отображаются восстановленные даты создания точек.',
  'feat(audit): include historical point creation date recoveries in super-admin log':
    'В журнал супер-администратора добавлены восстановления исторических дат точек.',
  'test(business): distinguish point creation from first sale and report legacy unknown dates':
    'Проверено отличие даты создания точки от первой продажи и учёт неизвестных дат.',
  'feat(admin): display point creation dates and allow documented legacy date recovery':
    'В админке показаны даты создания точек и добавлено подтверждённое восстановление старых дат.',
  'feat(points): permit audited super-admin backfill of undocumented historic creation dates':
    'Супер-администратор может указать подтверждённую историческую дату точки с записью в журнале.',
  'fix(business): count new points by actual record creation rather than first sale':
    'Новые точки считаются по дате создания карточки, а не по первой продаже.',
  'feat(db): capture point record creation dates and recover historic manager registrations without fabrication':
    'База сохраняет дату создания новых точек и восстанавливает старые даты из журнала менеджера.',
  'test(business): assert monthly sales growth and profit variance':
    'Добавлены проверки роста продаж и изменения прибыли по месяцам.',
  'fix(telegram): show usage hint for malformed multi-argument business commands':
    'При неверном формате команды /business бот показывает подсказку.',
  'feat(business): add month-over-month order growth and profit changes to annual summary':
    'В годовом отчёте показаны помесячный рост заказов и изменение прибыли.',
  'test(business): verify year/month boundaries, refunded sales, costs and active points':
    'Проверены границы месяцев, возвраты, расходы и точки с продажами.',
  'feat(telegram): add /business [year], yearly CSV and menu button for administrators':
    'Администраторам добавлены команда /business, CSV за год и кнопка в боте.',
  'feat(business): calculate monthly sales, costs and annual profit by Krasnoyarsk year':
    'Добавлен расчёт помесячных продаж, расходов и прибыли за год по времени Красноярска.',
  'chore(pwa): refresh static assets after groomer promo code rollout':
    'Обновлён кеш сайта после запуска промокодов грумеров.',
  'test(promo): cover automatic codes, legacy codes and single-use purchase claims':
    'Проверены новые и старые промокоды и однократное применение скидки.',
  'fix(checkout): label promo field for groomer and salon first-purchase codes':
    'Поле промокода при покупке подписано для кодов грумера и салона.',
  'feat(admin): list automatically generated groomer discount codes':
    'В админке отображаются автоматически созданные промокоды грумеров.',
  'feat(promo): show personal first-purchase code after groomer signs up':
    'После регистрации грумер видит личный промокод на первую покупку.',
  'feat(promo): return groomer personal code at registration and notify admin':
    'Личный промокод выдаётся при регистрации грумера и передаётся администратору.',
  'feat(promo): automatically issue unique first-purchase codes to new and unassigned groomers':
    'Уникальный промокод первой покупки выдаётся новым грумерам автоматически.',
  'chore(deploy): retry Amvera deployment for admin profile edits':
    'Повторно запущен деплой исправлений анкет в Amvera.',
  'feat(admin): correct groomer contact and legal profile with atomic audit':
    'Администратор может исправлять контакты и реквизиты грумеров с записью в журнале.',
  'feat(admin): correct salon owner contact and legal data with audit':
    'Администратор может исправлять контакты и реквизиты владельцев салонов с записью в журнале.',
  'feat(admin): add corrective edit modal for groomers and owners':
    'В админке добавлены формы исправления анкет грумеров и владельцев салонов.',
  'feat(admin): wire edit buttons and profile editing for groomers and owners':
    'Добавлены кнопки редактирования и сохранения анкет грумеров и владельцев.',
  'feat(checkout): auto-assign sole or owner groomer for missing selection':
    'При покупке без выбора грумера автоматически назначается единственный грумер или грумер-владелец.',
}));

const SCOPE_RU = Object.freeze({
  business: 'бизнес-аналитика', telegram: 'Telegram-бот', deploy: 'уведомления о деплое',
  admin: 'админка', points: 'точки продаж', checkout: 'оформление покупок',
  db: 'база данных', promo: 'промокоды', audit: 'журнал действий',
  test: 'тестирование', report: 'отчёты', pwa: 'кеш сайта',
  payment: 'оплата', partners: 'партнёры', owners: 'владельцы салонов',
  sales: 'продажи', tasks: 'поручения', products: 'товары',
});
const TYPE_RU = Object.freeze({
  feat: 'Добавлена возможность', fix: 'Исправлена работа',
  test: 'Добавлены проверки', chore: 'Техническое обновление',
  polish: 'Улучшено оформление', refactor: 'Улучшена реализация',
  docs: 'Обновлена документация', perf: 'Ускорена работа',
  build: 'Обновлена сборка', revert: 'Отменено изменение',
});
const THEMES = [
  [/created?|creation|registration|historic.*date|date.*point/i, 'дат создания точек'],
  [/groomer|owner.*profile|partner.*profile/i, 'данных грумеров и партнёров'],
  [/promocode|promo|discount/i, 'промокодов и скидок'],
  [/payout|commission/i, 'начислений и выплат'],
  [/monthly|annual|business|profit|revenue/i, 'управленческой аналитики'],
  [/telegram|bot|message/i, 'уведомлений Telegram'],
  [/point|salon/i, 'точек продаж'],
  [/checkout|payment|paid order/i, 'оформления и оплаты заказов'],
  [/audit|log/i, 'журнала изменений'],
  [/task/i, 'системы поручений'],
  [/test|verify/i, 'проверок системы'],
];

function firstLine(text) {
  return String(text || '').split(/\r?\n/, 1)[0].replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}
function footer(message, code) {
  const match = String(message || '').match(
    new RegExp('^\\s*(?:Release[- ]notes|Change[- ]description)[- ]' + code + '\\s*:\\s*(.+)$', 'im')
  );
  return match ? match[1].trim() : null;
}
function fallbackRussian(subject) {
  const match = String(subject).match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const type = match?.[1]?.toLowerCase() || '';
  const scope = match?.[2]?.toLowerCase() || '';
  const description = match?.[3] || subject;
  const action = TYPE_RU[type] || 'Изменения';
  const scopeLabel = SCOPE_RU[scope] || 'системы';
  const theme = THEMES.find(([pattern]) => pattern.test(description));
  // For unannotated future commits a conservative topical summary is safer
  // than a fabricated word-for-word translation. English retains the detail.
  return action + ' в разделе «' + scopeLabel + '»' +
    (theme ? ' — ' + theme[1] : '') + '.';
}
function releaseChange(message) {
  const subject = firstLine(message) || 'Change description unavailable';
  const en = firstLine(footer(message, 'en') || subject);
  const ru = firstLine(footer(message, 'ru') || LEGACY_RU.get(subject) || fallbackRussian(subject));
  return { en, ru };
}
function statusChange(en, ru) {
  return {en, ru};
}
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shorten(text, maxLength) {
  const normalized = String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 1).trimEnd() + '…';
}
// Telegram accepts at most 4096 UTF-16 units; the rest of the deployment
// metadata stays in the parent module. Keep both languages, not just the first.
function formatBilingualTelegramChanges(changes, limit = 10, maxChars = 2900) {
  const all = Array.isArray(changes) ? changes : [];
  const maximum = Math.max(0, Math.min(all.length, Number(limit) || 0));
  // Preserve both languages and valid HTML even if many commits contain
  // characters whose escaped form is longer than the original.
  for (let count = maximum; count > 0; count--) {
    const values = all.slice(-count);
    const hidden = all.length - count;
    const lines = ['🇬🇧 <b>Changes — English:</b>'];
    for (const [index, item] of values.entries()) {
      lines.push((index + 1) + '. ' + escapeHtml(shorten(item.en, 140)));
    }
    if (hidden) lines.push('… ' + hidden + ' earlier changes omitted');
    lines.push('', '🇷🇺 <b>Изменения — русский:</b>');
    for (const [index, item] of values.entries()) {
      lines.push((index + 1) + '. ' + escapeHtml(shorten(item.ru, 150)));
    }
    if (hidden) lines.push('… Ещё ' + hidden + ' более ранних изменений');
    if (lines.join('\n').length <= maxChars) return lines;
  }
  if (all.length) return [
    '🇬🇧 <b>Changes — English:</b>',
    'Detailed changes exceeded the Telegram length limit.',
    '',
    '🇷🇺 <b>Изменения — русский:</b>',
    'Подробное описание изменений превысило ограничение длины Telegram.',
  ];
  return [
    '🇬🇧 <b>Changes — English:</b>',
    'No changes were listed.',
    '',
    '🇷🇺 <b>Изменения — русский:</b>',
    'Изменения не указаны.',
  ];
}

module.exports = {
  releaseChange, statusChange, formatBilingualTelegramChanges, fallbackRussian,
};
