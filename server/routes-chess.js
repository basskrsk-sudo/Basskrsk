// routes-chess.js — приз косточками за победу над компьютером в шахматах.
// Сумма зависит от выбранного уровня сложности (легче уровень — меньше
// приз). Партия целиком играется на клиенте (движок в public/index.html),
// сервер доверяет заявленному результату победы — так же, как и с
// викториной (см. routes-quiz.js), поэтому здесь та же защита от
// накрутки, а не проверка каждого хода партии.
'use strict';

const db = require('./db');
const { sendJson } = require('./http-utils');
const { normalizePhone } = require('./routes-customers');
const { getDiscountSettings } = require('./settings');
const { getBonesBalance, awardBones } = require('./bones');

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const DIFFICULTY_LABELS = { easy: 'простой', medium: 'средний', hard: 'сложный' };

// Лучший результат шахмат за последние 7 дней (0, если недели ещё нет) —
// сколько косточек уже начислено за самую сложную выигранную партию на
// этой неделе. Используется, чтобы решить, является ли новая победа
// УЛУЧШЕНИЕМ (тогда доплачиваем разницу) или нет.
function getBestChessBonesThisWeek(phone) {
  const row = db.prepare(`
    SELECT MAX(bones_awarded) AS best FROM chess_prizes
    WHERE phone = ? AND created_at > datetime('now', '-7 days')
  `).get(phone);
  return (row && row.best) || 0;
}

function registerChessRoutes(router) {
  // GET /api/chess/status?phone=... — лучший результат ЭТОЙ недели (0, если
  // недели ещё не было) — используется, чтобы показать "уже получено X,
  // выиграйте на более сложном уровне — получите больше" и понять, достигнут
  // ли максимум (играть можно всегда, но новых косточек до следующей недели
  // уже не будет).
  router.get('/api/chess/status', (req, res, ctx) => {
    const digits = normalizePhone(ctx.query.phone);
    if (!digits) return sendJson(res, 400, { error: 'Укажите phone' });
    const s = getDiscountSettings();
    const bestBones = getBestChessBonesThisWeek(digits);
    sendJson(res, 200, { bestBones, atMax: bestBones >= s.chess_win_bones_hard });
  });

  // POST /api/chess/win { phone, difficulty } — засчитать победу и начислить
  // косточки. В течение недели можно переигрывать на более сложном уровне и
  // УЛУЧШАТЬ результат — если новая победа даёт более высокую сумму, чем
  // лучшая на этой неделе, доплачивается РАЗНИЦА (не полная сумма заново).
  // Как только достигнут максимум (победа на сложном уровне) — дальнейшие
  // победы на этой неделе уже ничего не доплачивают.
  //
  // Плюс две защиты от «фарма» без реальных покупок — те же, что у
  // викторины:
  // 1. Только уже существующим клиентам (телефон уже есть в customers).
  // 2. Не сверх quiz_bones_balance_cap на балансе — общий потолок для всех
  //    игровых наград, не только викторины.
  router.post('/api/chess/win', (req, res, ctx) => {
    const { phone, difficulty } = ctx.body || {};
    const digits = normalizePhone(phone);
    if (!digits || !VALID_DIFFICULTIES.includes(difficulty)) {
      return sendJson(res, 400, { error: 'Укажите phone и difficulty (easy/medium/hard)' });
    }

    // Записываем КАЖДУЮ победу для рейтинга — не только те, что дали
    // доплату косточками (см. chess_prizes ниже).
    db.prepare('INSERT INTO chess_wins (phone, difficulty) VALUES (?, ?)').run(digits, difficulty);

    const s = getDiscountSettings();
    const bonesByDifficulty = { easy: s.chess_win_bones_easy, medium: s.chess_win_bones_medium, hard: s.chess_win_bones_hard };
    const bonesForResult = bonesByDifficulty[difficulty];

    const bestSoFar = getBestChessBonesThisWeek(digits);
    if (bonesForResult <= bestSoFar) {
      return sendJson(res, 200, {
        won: true,
        alreadyBest: true,
        bones_awarded: 0,
        bestBones: bestSoFar,
        message: 'Победа засчитана! Но на этой неделе вы уже выигрывали не хуже — новую доплату получите, только если выиграете на более сложном уровне.',
      });
    }

    // Защита: косточки — только для уже существующих клиентов.
    const customer = db.prepare('SELECT id FROM customers WHERE phone = ?').get(digits);
    if (!customer) {
      return sendJson(res, 200, {
        won: false,
        notYetCustomer: true,
        message: 'Отличная партия! Косточки начисляются постоянным клиентам — сделайте первый заказ, и со следующей игры начнёте получать 🦴 за победы в шахматах.',
      });
    }

    // Защита: не начисляем сверх потолка накопленных без заказа косточек.
    const balance = getBonesBalance(customer.id);
    const room = Math.max(0, s.quiz_bones_balance_cap - balance);
    if (room <= 0) {
      return sendJson(res, 200, {
        won: false,
        balanceCapped: true,
        message: 'Отличная партия! Но баланс косточек уже на максимуме (' + s.quiz_bones_balance_cap + ' 🦴) — потратьте что-то в заказе, и снова сможете получать призы.',
      });
    }

    // Доплачиваем только РАЗНИЦУ между новым и лучшим прошлым результатом
    // этой недели — а не полную сумму заново.
    const delta = bonesForResult - bestSoFar;
    const awarded = Math.min(delta, room);
    awardBones(customer.id, awarded, 'gift', 'Победа в шахматах (' + DIFFICULTY_LABELS[difficulty] + ' уровень)');
    // bones_awarded в этой таблице — ДОСТИГНУТАЯ сумма целиком (не разница),
    // чтобы следующая попытка сравнивалась с ней корректно.
    db.prepare('INSERT INTO chess_prizes (phone, difficulty, bones_awarded) VALUES (?, ?, ?)').run(digits, difficulty, bonesForResult);

    sendJson(res, 200, {
      won: true,
      bones_awarded: awarded,
      newBest: bonesForResult,
      atMax: bonesForResult >= s.chess_win_bones_hard,
      capped: awarded < delta,
    });
  });

  // GET /api/chess/leaderboard — топ игроков по самому высокому уровню
  // сложности, на котором они хоть раз обыграли компьютер (сложный лучше
  // среднего лучше простого), при равенстве — по числу побед на этом
  // уровне. Аналогично рейтингу викторины.
  router.get('/api/chess/leaderboard', (req, res) => {
    const rows = db.prepare(`
      SELECT phone,
             MAX(CASE difficulty WHEN 'hard' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS best_rank,
             COUNT(*) AS wins
      FROM chess_wins
      GROUP BY phone
      ORDER BY best_rank DESC, wins DESC
      LIMIT 10
    `).all();

    const rankLabel = { 3: '🔴 Сложный', 2: '🟡 Средний', 1: '🟢 Простой' };
    const leaderboard = rows.map((r, i) => {
      const customer = db.prepare('SELECT name FROM customers WHERE phone = ?').get(r.phone);
      const digits = r.phone;
      const masked = digits.length >= 10
        ? '+' + digits.slice(0, 1) + ' ' + digits.slice(1, 4) + ' ***-**-' + digits.slice(-2)
        : '+' + digits;
      return {
        rank: i + 1,
        display_name: (customer && customer.name) || masked,
        best_difficulty_label: rankLabel[r.best_rank] || '',
        wins: r.wins,
      };
    });

    sendJson(res, 200, { leaderboard });
  });
}

module.exports = { registerChessRoutes };
