'use strict';

// Cheerful, short closing lines for announcements in the partners' club.
// Keep wording universal: not every purchase is personally recommended by a groomer.
const SALE_ENDINGS = Object.freeze([
  '👏 Отличная работа, команда! Так держать!',
  '🚀 Каждая покупка приближает нас к новым рекордам!',
  '🐾 Ещё одно угощение нашло своего хвостика — здорово!',
  '💪 Большие результаты складываются из маленьких побед!',
  '🌟 Спасибо за вклад в развитие ХвостМаркета!',
  '🔥 Продолжаем набирать обороты. Дальше — больше!',
  '🏆 Каждый заказ — вклад в общий успех нашей команды!',
  '🎯 Отличное попадание! Товар нашёл своего покупателя!',
  '💚 Вместе делаем покупки для питомцев удобнее!',
  '✨ Пусть следующая продажа не заставит себя ждать!',
]);

/** Cycle through every ending before repeating the first one. */
function saleEndingAt(index) {
  const position = Number(index);
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new RangeError('Sale ending index must be a non-negative integer');
  }
  return SALE_ENDINGS[position % SALE_ENDINGS.length];
}

module.exports = { SALE_ENDINGS, saleEndingAt };
