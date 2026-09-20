// routes-quiz.js — викторина о собаках, приз косточками. Раньше жила в одном
// файле с системой промокодов (routes-promo-codes.js) — при удалении
// промокодов (система лояльности теперь только на косточках) викторину
// вынесли отдельно, она с промокодами никак не связана.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { normalizePhone } = require('./routes-customers');
const { getDiscountSettings } = require('./settings');
const { getBonesBalance, awardBones } = require('./bones');

// Лучший результат ЭТОЙ игры за последние 7 дней (0, если недели ещё нет)
// — сколько косточек уже начислено за самую высокую несгораемую сумму,
// достигнутую на этой неделе. Используется, чтобы решить, является ли
// новая попытка УЛУЧШЕНИЕМ (тогда доплачиваем разницу) или нет.
function getBestBonesThisWeek(table, phone) {
  const row = db.prepare(`
    SELECT MAX(bones_awarded) AS best FROM ${table}
    WHERE phone = ? AND created_at > datetime('now', '-7 days')
  `).get(phone);
  return (row && row.best) || 0;
}

function registerQuizRoutes(router) {
  // GET /api/quiz/status?phone=... — лучший результат ЭТОЙ недели (0, если
  // недели ещё не было) — используется, чтобы показать "уже накоплено X,
  // побейте — получите больше" и понять, достигнут ли максимум (дальше
  // играть можно, но новых косточек до следующей недели уже не будет).
  router.get('/api/quiz/status', (req, res, ctx) => {
    const digits = normalizePhone(ctx.query.phone);
    if (!digits) return sendJson(res, 400, { error: 'Укажите phone' });
    const s = getDiscountSettings();
    const bestBones = getBestBonesThisWeek('quiz_prizes', digits);
    sendJson(res, 200, { bestBones, atMax: bestBones >= s.quiz_tier3_bones });
  });

  // POST /api/quiz/submit { phone, correctCount, totalQuestions } — викторина
  // о собаках, приз косточками (1 косточка = 1 ₽). В течение недели можно
  // переигрывать и УЛУЧШАТЬ результат — если новая попытка набирает более
  // высокую несгораемую сумму, чем лучшая на этой неделе, доплачивается
  // РАЗНИЦА (не полная сумма заново). Как только достигнут максимум —
  // дальнейшие попытки на этой неделе уже ничего не доплачивают.
  //
  // Плюс две защиты от «фарма» косточек без реальных покупок:
  // 1. Косточки начисляются только уже существующим клиентам (телефон уже
  //    есть в customers — то есть хотя бы один заказ уже был оплачен).
  //    Незнакомец с улицы не может бесконечно копить косточки, просто вводя
  //    случайный номер — только тот, кто уже реально покупал.
  // 2. Даже постоянному клиенту викторина не начисляет косточки сверх
  //    quiz_bones_balance_cap — пока баланс не уменьшится (то есть клиент не
  //    потратит косточки на заказ), новых начислений не будет.
  router.post('/api/quiz/submit', (req, res, ctx) => {
    const { phone, correctCount, totalQuestions } = ctx.body || {};
    const digits = normalizePhone(phone);
    if (!digits || typeof correctCount !== 'number' || typeof totalQuestions !== 'number') {
      return sendJson(res, 400, { error: 'Укажите phone, correctCount и totalQuestions' });
    }
    const correct = Math.max(0, Math.min(totalQuestions, Math.round(correctCount)));

    // Записываем КАЖДУЮ попытку для рейтинга — не только выигрышные.
    db.prepare('INSERT INTO quiz_attempts (phone, correct_count, total_questions) VALUES (?, ?, ?)').run(digits, correct, totalQuestions);

    let bonesForResult = 0;
    const s = getDiscountSettings();
    if (correct >= s.quiz_tier3_min_correct) bonesForResult = s.quiz_tier3_bones;
    else if (correct >= s.quiz_tier2_min_correct) bonesForResult = s.quiz_tier2_bones;
    else if (correct >= s.quiz_tier1_min_correct) bonesForResult = s.quiz_tier1_bones;

    if (bonesForResult === 0) {
      return sendJson(res, 200, { won: false, message: 'В этот раз без приза — правильно ответьте хотя бы на ' + s.quiz_tier1_min_correct + ' из ' + totalQuestions + '!' });
    }

    const bestSoFar = getBestBonesThisWeek('quiz_prizes', digits);
    if (bonesForResult <= bestSoFar) {
      return sendJson(res, 200, {
        won: false,
        alreadyBest: true,
        bestBones: bestSoFar,
        message: 'Хороший результат! Но на этой неделе вы уже показывали не хуже — новую доплату получите, только если наберёте больше ' + bestSoFar + ' 🦴.',
      });
    }

    // Защита №1: косточки — только для уже существующих клиентов.
    const customer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(digits);
    if (!customer) {
      return sendJson(res, 200, {
        won: false,
        notYetCustomer: true,
        message: 'Отличный результат! Косточки начисляются постоянным клиентам — сделайте первый заказ, и со следующей игры начнёте получать 🦴 за победы в викторине.',
      });
    }

    // Защита №2: не начисляем сверх потолка накопленных без заказа косточек.
    const balance = getBonesBalance(customer.id);
    const room = Math.max(0, s.quiz_bones_balance_cap - balance);
    if (room <= 0) {
      return sendJson(res, 200, {
        won: false,
        balanceCapped: true,
        message: 'Отличный результат! Но баланс косточек уже на максимуме (' + s.quiz_bones_balance_cap + ' 🦴) — потратьте что-то в заказе, и снова сможете получать призы.',
      });
    }

    // Доплачиваем только РАЗНИЦУ между новым и лучшим прошлым результатом
    // этой недели — а не полную сумму заново.
    const delta = bonesForResult - bestSoFar;
    const awarded = Math.min(delta, room);
    awardBones(customer.id, awarded, 'quiz', 'Приз из викторины о собаках (' + correct + '/' + totalQuestions + ')');
    // bones_awarded в этой таблице — ДОСТИГНУТАЯ несгораемая сумма целиком
    // (не разница), чтобы следующая попытка сравнивалась с ней корректно.
    db.prepare('INSERT INTO quiz_prizes (phone, correct_count, bones_awarded) VALUES (?, ?, ?)').run(digits, correct, bonesForResult);

    sendJson(res, 200, {
      won: true,
      bones_awarded: awarded,
      newBest: bonesForResult,
      atMax: bonesForResult >= s.quiz_tier3_bones,
      capped: awarded < delta,
    });
  });

  // GET /api/quiz/leaderboard — топ игроков по лучшему результату.
  // Показываем имя, если оно известно (клиент уже оформлял заказ), иначе —
  // телефон с маскировкой середины номера (не выводим его целиком публично).
  router.get('/api/quiz/leaderboard', (req, res, ctx) => {
    const rows = db.prepare(`
      SELECT phone, MAX(correct_count) AS best_score
      FROM quiz_attempts
      GROUP BY phone
      ORDER BY best_score DESC
      LIMIT 10
    `).all();

    const leaderboard = rows.map((r, i) => {
      const customer = db.prepare('SELECT name FROM customers WHERE phone = ?').get(r.phone);
      const digits = r.phone;
      const masked = digits.length >= 10
        ? '+' + digits.slice(0, 1) + ' ' + digits.slice(1, 4) + ' ***-**-' + digits.slice(-2)
        : '+' + digits;
      return {
        rank: i + 1,
        display_name: (customer && customer.name) || masked,
        best_score: r.best_score,
      };
    });

    sendJson(res, 200, { leaderboard });
  });
}

module.exports = { registerQuizRoutes };
