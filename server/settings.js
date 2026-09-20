// settings.js — все настраиваемые из админки параметры скидок в одном месте.
// Хранится одной JSON-строкой в site_settings (key='discounts'), чтобы не
// городить отдельную таблицу под каждый параметр.
'use strict';

const db = require('./db');

const DEFAULTS = {
  // Программа лояльности — скидка по количеству уже оплаченных заказов ДО текущего.
  // Пороги здесь СОЗНАТЕЛЬНО совпадают с фактическим расчётом скидки (1/3/6
  // заказов) — раньше в системе стояли другие числа (2/4/7), из-за чего бейдж
  // уровня в личном кабинете не совпадал с реальной скидкой в чекауте. Исправлено.
  // С 2026 — это больше не скидка на заказ, а КЭШБЭК: заказ оплачивается по
  // полной цене, процент от суммы начисляется косточками на баланс сразу
  // после подтверждения оплаты (см. rewardLoyaltyCashback в routes-customers.js).
  loyalty_bronze_percent: 5,
  loyalty_bronze_min_orders: 1,
  loyalty_silver_percent: 8,
  loyalty_silver_min_orders: 3,
  loyalty_gold_percent: 10,
  loyalty_gold_min_orders: 6,

  // ДР питомца — тоже кэшбэк косточками (не скидка), тем же механизмом,
  // что и лояльность выше; если оба применимы одновременно — берём максимум,
  // не суммируем.
  pet_birthday_percent: 15,

  // Скидка за оплату через СБП — убрана по решению (СБП остаётся способом
  // оплаты по умолчанию, но больше не даёт скидку клиенту).
  sbp_discount_percent: 0,

  // Викторина о собаках — приз косточками (1 косточка = 1 ₽), по количеству
  // правильных ответов ПОДРЯД из 10 вопросов, до первой ошибки (несгораемые
  // суммы — см. routes-promo-codes.js).
  quiz_tier1_bones: 10,
  quiz_tier1_min_correct: 6,
  quiz_tier2_bones: 30,
  quiz_tier2_min_correct: 8,
  quiz_tier3_bones: 50,
  quiz_tier3_min_correct: 10,
  // Потолок косточек, которые можно накопить ЧЕРЕЗ ВИКТОРИНУ без реального
  // заказа. Пока текущий баланс клиента ≥ этого значения, викторина новых
  // косточек не начисляет (даже при выигрышном результате) — заказ,
  // потративший часть баланса, освобождает место для новых.
  quiz_bones_balance_cap: 300,

  // Шахматы — приз косточками за победу над компьютером, зависит от
  // выбранного уровня сложности (см. routes-chess.js). Тот же потолок
  // quiz_bones_balance_cap используется и здесь — общая защита от накрутки
  // игровых наград без реальных заказов, не только через викторину.
  chess_win_bones_easy: 50,
  chess_win_bones_medium: 100,
  chess_win_bones_hard: 150,

  // Программа "Приведи друга" — раньше другу давали % скидку на первый заказ,
  // теперь вместо этого начисляем косточки ОБЕИМ сторонам после того, как
  // друг оплатит свой первый заказ (полную сумму, без скидки).
  referral_friend_bones: 100,    // косточек другу за первый заказ по чужому коду
  referral_reward_bones: 100,    // косточек рефереру после первого заказа приведённого друга (1 косточка = 1 ₽)

  // Бонус за регистрацию + заполнение анкеты питомца (кличка и порода
  // обязательны, дата рождения — по желанию). Начисляется один раз на
  // клиента и сразу доступен к трате, даже на первом заказе.
  registration_bones: 150,

  // Товар дня
  product_of_day_percent: 10,
};

function getDiscountSettings() {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'discounts'").get();
  if (!row) return { ...DEFAULTS };
  try {
    const stored = JSON.parse(row.value);
    return { ...DEFAULTS, ...stored }; // на случай, если появятся новые поля после обновления
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveDiscountSettings(partialUpdate) {
  const current = getDiscountSettings();
  const merged = { ...current, ...partialUpdate };
  const json = JSON.stringify(merged);
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at) VALUES ('discounts', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(json);
  return merged;
}

module.exports = { getDiscountSettings, saveDiscountSettings, DEFAULTS };
