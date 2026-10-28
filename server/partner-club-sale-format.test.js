'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  saleMessage, normalizedAutoSaleMessage, saleMessageHtml, withSaleEnding,
} = require('./partner-club-sale-format');

const notice = saleMessage(
  '🐾 Новая покупка!',
  '🏪 Партнёрская точка: «Мистер Лапсик»',
  '🦴 Сердце говяжье',
  '💚 360 ₽',
  '🔥 Продолжаем набирать обороты. Дальше — больше!'
);

test('sale notifications have the exact requested paragraph spacing', () => {
  assert.equal(notice, [
    '🐾 Новая покупка!',
    '',
    '🏪 Партнёрская точка: «Мистер Лапсик»',
    '',
    '🦴 Сердце говяжье',
    '💚 360 ₽',
    '',
    '🔥 Продолжаем набирать обороты. Дальше — больше!',
  ].join('\n'));
});

test('only the salon name is bold using real Telegram-compatible HTML', () => {
  const html = saleMessageHtml(notice);
  assert.equal(html, [
    '🐾 Новая покупка!',
    '',
    '🏪 Партнёрская точка: <b>«Мистер Лапсик»</b>',
    '',
    '🦴 Сердце говяжье',
    '💚 360 ₽',
    '',
    '🔥 Продолжаем набирать обороты. Дальше — больше!',
  ].join('\n'));
  assert.equal((html.match(/<b>/g) || []).length, 1);
  assert.equal((html.match(/<\/b>/g) || []).length, 1);
});

test('older unformatted sale drafts receive spacing and bold venue on delivery', () => {
  const old = [
    '🐾 Новая покупка!',
    '🏪 Партнёрская точка: «Мистер Лапсик»',
    '🦴 Сердце говяжье',
    '💚 360 ₽',
    'Спасибо за покупку!',
  ].join('\n');
  assert.equal(normalizedAutoSaleMessage(old).split('\n').length, 8);
  assert.match(saleMessageHtml(old),
    /Новая покупка!\n\n🏪 Партнёрская точка: <b>«Мистер Лапсик»<\/b>\n\n🦴 Сердце говяжье\n💚 360 ₽\n\nСпасибо за покупку!/);
});

test('first sales follow the same style and retain their special greeting', () => {
  const first = saleMessage(
    '🎉 Первая продажа!',
    '🏪 Грумерский салон: «Dog Style»',
    '🦴 Кроличьи лапки',
    '💚 450 ₽',
    '👏 Поздравляем команду с первым успехом!'
  );
  const rendered = saleMessageHtml(first);
  assert.match(rendered, /^🎉 Первая продажа!\n\n🏪 Грумерский салон: <b>«Dog Style»<\/b>/);
  assert.match(rendered, /💚 450 ₽\n\n👏 Поздравляем команду с первым успехом!/);
});

test('salon, product and footer are escaped before trusted HTML is inserted', () => {
  const message = saleMessage(
    '🐾 Новая покупка!',
    '🏪 Партнёрская точка: «Салон <тест> & собаки»',
    '🦴 Лакомство <script>alert(1)</script> &',
    '💚 360 ₽',
    'Спасибо за <покупку> & дружбу!'
  );
  const rendered = saleMessageHtml(message);
  assert.ok(rendered.includes('<b>«Салон &lt;тест&gt; &amp; собаки»</b>'));
  assert.ok(rendered.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(rendered.includes('Спасибо за &lt;покупку&gt; &amp; дружбу!'));
  assert.ok(!rendered.includes('<script>'));
  assert.equal((rendered.match(/<b>/g) || []).length, 1);
});

test('other posts remain unmodified and must not be auto-bolded', () => {
  const manual = 'Произвольный пост: «Мистер Лапсик»\n**Жирный заголовок**';
  assert.equal(normalizedAutoSaleMessage(manual), manual);
  assert.ok(!saleMessageHtml(manual).includes('<b>'));
});

test('moderator edits and existing rich formatting are not altered by this helper', () => {
  // The caller applies this formatter only to unedited automatic sale events.
  const old = '🐾 Новая покупка!\n🏪 Партнёрская точка: «Мистер Лапсик»\n🦴 Сердце говяжье\n💚 360 ₽\nФинал';
  assert.equal(normalizedAutoSaleMessage(normalizedAutoSaleMessage(old)),
    normalizedAutoSaleMessage(old));
});


test('changing the greeting keeps the original sale and money fields unchanged', () => {
  const chosen='🐶 Новое поздравление от команды!';
  const changed=withSaleEnding(notice,chosen);
  assert.equal(changed,notice.slice(0,notice.lastIndexOf('\n')+1)+chosen);
  assert.match(saleMessageHtml(changed),/<b>«Мистер Лапсик»<\/b>/);
  const legacy=[
    '🐾 Новая покупка!','🏪 Партнёрская точка: «Мистер Лапсик»',
    '🦴 Сердце говяжье','💚 360 ₽','Спасибо за покупку!'
  ].join('\n');
  assert.equal(withSaleEnding(legacy,chosen),changed);
  assert.equal(withSaleEnding('Ручной пост',chosen),null);
});
