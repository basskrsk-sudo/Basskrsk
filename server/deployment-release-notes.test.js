'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  releaseChange, statusChange, formatBilingualTelegramChanges, fallbackRussian,
} = require('./deployment-release-notes');

test('release notes can specify exact English and Russian commit descriptions', () => {
  const message = [
    'feat(deploy): publish bilingual alerts', '',
    'Release-notes-en: Deployment notes are shown first in English.',
    'Release-notes-ru: Сначала описание изменений выводится на английском.',
  ].join('\n');
  const result = releaseChange(message);
  assert.equal(result.en, 'Deployment notes are shown first in English.');
  assert.equal(result.ru, 'Сначала описание изменений выводится на английском.');
});

test('old commits use meaningful Russian descriptions', () => {
  const result = releaseChange(
    'feat(business): include monthly sales and revenue for every point in complete registry CSV'
  );
  assert.match(result.ru, /помесячная выручка/);
  assert.match(result.ru, /точки/);
});

test('unknown commit types are summarized in Russian without inventing details', () => {
  const result = releaseChange('feat(unknown): improve special <component> & handling');
  assert.equal(result.en, 'feat(unknown): improve special <component> & handling');
  assert.match(result.ru, /Добавлена возможность/);
  assert.ok(!result.ru.includes('<component>'));
  assert.match(fallbackRussian('fix(checkout): broken discount'), /Исправлена работа/);
});

test('Cyrillic source commit titles retain Russian detail but get an English category', () => {
  const result = releaseChange('fix(admin): Исправлена карточка точки');
  assert.match(result.en, /^Bug fix/);
  assert.match(result.ru, /Исправлена карточка точки/);
  const explicit = releaseChange([
    'fix(admin): Исправлена карточка точки',
    'Release-notes-en: Fixed salon profile data.',
    'Release-notes-ru: Исправлена карточка точки.',
  ].join('\n'));
  assert.equal(explicit.en, 'Fixed salon profile data.');
});

test('changes always appear English first, followed by matching Russian entries', () => {
  const changes = [
    releaseChange('fix(test): validate Russian missing-date prompt with literal text'),
    statusChange('Feature enabled', 'Функция включена'),
  ];
  const output = formatBilingualTelegramChanges(changes).join('\n');
  assert.ok(output.indexOf('Changes — English') < output.indexOf('Изменения — русский'));
  assert.match(output, /Feature enabled/);
  assert.match(output, /Функция включена/);
  assert.equal((output.match(/^1\. /gm) || []).length, 2);
  assert.equal((output.match(/^2\. /gm) || []).length, 2);
});

test('untrusted HTML is escaped and long messages preserve both languages', () => {
  const changes = Array.from({ length: 30 }, (_, i) => ({
    en: '<tag> &'.repeat(60) + i,
    ru: 'Изменения <script> &'.repeat(40) + i,
  }));
  const output = formatBilingualTelegramChanges(changes).join('\n');
  assert.ok(output.length <= 2900, 'release notes must leave room for deployment metadata');
  assert.ok(output.includes('Changes — English'));
  assert.ok(output.includes('Изменения — русский'));
  assert.ok(output.includes('&lt;'));
  assert.ok(output.includes('&amp;'));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('<tag>'));
  assert.match(output, /earlier changes omitted/);
  assert.match(output, /более ранних изменений/);
});

test('no commit details are also presented bilingually', () => {
  const output = formatBilingualTelegramChanges([]).join('\n');
  assert.match(output, /No changes were listed/);
  assert.match(output, /Изменения не указаны/);
});
