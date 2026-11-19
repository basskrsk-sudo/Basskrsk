'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const supportLinks = {
  telegram: 'https://t.me/HvostMarketRusBot',
  max: 'https://max.ru/se14353857_bot',
};

function section(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a+start.length);
  assert.ok(a>=0, 'Section start missing: '+start);
  assert.ok(b>a, 'Section end missing: '+end);
  return html.slice(a,b);
}

test('partner landing has direct support links and clear /support instructions',()=>{
  const landing = section('id="page-partners"', 'id="page-salons"');
  assert.match(landing, /id="partner-support-title"/);
  assert.match(landing, /Поддержка партнёров/);
  assert.ok(landing.includes('href="'+supportLinks.telegram+'"'));
  assert.ok(landing.includes('href="'+supportLinks.max+'"'));
  assert.match(landing, /<strong>\/support<\/strong>/);
  assert.match(landing, /Ответ придёт в тот же мессенджер/);
  assert.match(landing, /телефон для обратной связи/);
  assert.match(landing, /до закрытия обращения/);
  assert.doesNotMatch(landing, /href="https:\/\/max\.ru\/se14353857_bot\?startapp"[^>]*>💬 Написать в MAX/);
});

test('contacts page provides Telegram and MAX support with original bot chat links',()=>{
  const contacts = section('id="page-contacts"', 'id="page-feedback"');
  assert.match(contacts, /Telegram — поддержка/);
  assert.match(contacts, /MAX — поддержка/);
  assert.ok(contacts.includes('href="'+supportLinks.telegram+'"'));
  assert.ok(contacts.includes('href="'+supportLinks.max+'"'));
  assert.match(contacts, /Отправьте \/support и опишите вопрос/);
  assert.match(contacts, /Бот выдаст номер обращения/);
  assert.match(contacts, /название точки/);
  assert.match(contacts, /контактный телефон/);
  assert.match(contacts, /support_history/);
  assert.match(contacts, /support_close/);
  assert.match(contacts, /id="cf-msg"/);
});

test('site-wide footer shows the same two support bot destinations',()=>{
  const footer = section('<footer>', '</footer>');
  assert.match(footer, /Поддержка в Telegram/);
  assert.match(footer, /Поддержка в MAX/);
  assert.ok(footer.includes('href="'+supportLinks.telegram+'"'));
  assert.ok(footer.includes('href="'+supportLinks.max+'"'));
  assert.doesNotMatch(footer, /\?start=support/);
});
