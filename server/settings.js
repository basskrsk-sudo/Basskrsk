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
