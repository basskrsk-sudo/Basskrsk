// winback.js — автоматический «возврат неактивного клиента»: если клиент не
// заказывал 30+ дней и мы знаем его Telegram (он хотя бы раз входил через
// Telegram на сайте), раз в сутки проверяем и начисляем ему косточки —
// разовый подарок за возвращение, приходит сообщением с призывом заказать
// снова. Раньше это была скидка через промокод — с переходом на единую
// систему лояльности (только косточки) заменено на прямое начисление.
//
// Ограничение по дизайну: достучаться можно только до тех, у кого есть
// customers.telegram_chat_id — то есть кто хотя бы раз логинился в личный
// кабинет через Telegram. Для клиентов без этого (заказывали как гость,
// без входа в кабинет) сейчас связаться не можем — это осознанный компромисс,
// не отправляем сюда SMS/звонки без отдельного решения о том, что это
// законно и уместно (реклама по SMS требует отдельного согласия).
'use strict';

const db = require('./db');
const { sendToChat } = require('./telegram');
const { awardBones } = require('./bones');

const WINBACK_INACTIVE_DAYS = 30;   // не заказывал столько дней — считаем "затих"
const WINBACK_BONES = 100;          // разовый подарок за возвращение, 🦴 (1 = 1 ₽)

function findWinbackCandidates() {
  return db.prepare(`
    SELECT id, phone, name, pet_name, telegram_chat_id
    FROM customers
    WHERE telegram_chat_id IS NOT NULL
      AND last_order_at IS NOT NULL
      AND last_order_at <= datetime('now', '-' || ? || ' days')
      AND winback_sent_at IS NULL
  `).all(WINBACK_INACTIVE_DAYS);
}

function buildWinbackMessage(customer) {
  const greeting = customer.pet_name
    ? `🐾 Соскучились по лакомствам для ${customer.pet_name}?`
    : '🐾 Соскучились по лакомствам «Тайга»?';
  return [
    greeting,
    '',
    `Дарим ${WINBACK_BONES} 🦴 косточек на баланс — уже начислены!`,
    '',
    'Спишите их при оформлении следующего заказа на сайте — 1 косточка = 1 ₽.',
  ].join('\n');
}

// Основная функция — вызывается по расписанию и вручную из админки.
// Возвращает сводку (сколько нашли, скольким реально отправили) для
// логирования/показа в интерфейсе.
async function runWinbackCheck() {
  const candidates = findWinbackCandidates();
  let sent = 0;
  const errors = [];

  for (const customer of candidates) {
    try {
      const result = await sendToChat(customer.telegram_chat_id, buildWinbackMessage(customer));
      if (result.ok) {
        // Косточки начисляем только при успешной отправке — если клиент не
        // узнает о подарке, начислять бессмысленно (и может запутать, если
        // баланс вырастет без объяснения).
        awardBones(customer.id, WINBACK_BONES, 'winback', 'Win-back — возврат неактивного клиента');
        db.prepare("UPDATE customers SET winback_sent_at = datetime('now') WHERE id = ?").run(customer.id);
        sent++;
      } else {
        // Не помечаем как отправленное — попробуем снова при следующей проверке.
        errors.push({ customer_id: customer.id, error: result.error || 'неизвестная ошибка отправки' });
      }
    } catch (e) {
      errors.push({ customer_id: customer.id, error: e.message });
    }
  }

  const summary = { checked: candidates.length, sent, errors };
  if (candidates.length > 0) {
    console.log(`Win-back: найдено ${candidates.length} неактивных клиентов, отправлено ${sent}` + (errors.length ? `, ошибок ${errors.length}` : ''));
  }
  return summary;
}

function scheduleWinback() {
  // Первая проверка — вскоре после старта сервера (не мгновенно, чтобы не
  // мешать запуску), дальше — раз в сутки, как и остальные плановые задачи.
  setTimeout(() => { runWinbackCheck().catch((e) => console.warn('Win-back: ошибка проверки:', e.message)); }, 5 * 60 * 1000);
  setInterval(() => { runWinbackCheck().catch((e) => console.warn('Win-back: ошибка проверки:', e.message)); }, 24 * 60 * 60 * 1000);
  console.log(`Win-back рассылка настроена: клиенты без заказов ${WINBACK_INACTIVE_DAYS}+ дней, проверка раз в сутки`);
}

function registerWinbackRoutes(router) {
  const { sendJson } = require('./http-utils');
  const { requireAuth } = require('./routes-auth');

  // GET /api/admin/winback/candidates — кому бы отправили при следующей проверке (без отправки)
  router.get('/api/admin/winback/candidates', (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    sendJson(res, 200, { candidates: findWinbackCandidates(), inactive_days: WINBACK_INACTIVE_DAYS, bones: WINBACK_BONES });
  });

  // POST /api/admin/winback/run — запустить проверку и рассылку прямо сейчас, не дожидаясь суток
  router.post('/api/admin/winback/run', async (req, res, ctx) => {
    const payload = requireAuth(['admin'])(req, res, ctx);
    if (!payload) return;
    try {
      const summary = await runWinbackCheck();
      sendJson(res, 200, { ok: true, ...summary });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

module.exports = { runWinbackCheck, scheduleWinback, registerWinbackRoutes, findWinbackCandidates, WINBACK_INACTIVE_DAYS, WINBACK_BONES };
