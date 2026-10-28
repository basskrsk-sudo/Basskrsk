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
  '🎉 Ещё один повод порадоваться за нашу команду!',
  '🐕 Больше покупок — больше счастливых хвостиков!',
  '🙌 Хороший результат! Продолжаем радовать клиентов!',
  '🥇 Каждая новая продажа — маленькая победа большого дела!',
  '🌱 Шаг за шагом растём вместе с нашими партнёрами!',
  '⚡ Отличные новости: снова плюс одна продажа!',
  '🦴 Лакомства находят покупателей — продолжаем в том же духе!',
  '🤝 Вместе достигаем большего. Спасибо за вашу работу!',
  '🎈 Есть повод улыбнуться: покупка состоялась!',
  '💫 Уверенно идём вперёд — отличный вклад в общий результат!',
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
