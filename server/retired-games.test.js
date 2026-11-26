'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('unused games are gone from storefront pages, menu and all inline JavaScript', () => {
  const html = read('public/index.html');
  for (const pattern of [
    /page-quiz/, /page-chess/, /showPage\(['"](?:quiz|chess)['"]\)/,
    /\/api\/(?:quiz|chess)\//, /QUIZ_QUESTIONS/, /QUIZ_TIERS/,
    /chessNegamax/, /chessGetBestMove/, /startChessGame/, /startQuiz/,
    /Викторина о собаках/i, /Шахматы/i,
  ]) assert.doesNotMatch(html, pattern);
  assert.match(html, /page-bones/);
  assert.match(html, /Пять способов пополнить баланс/);
  assert.match(html, /Приведи друга/);
  assert.match(html, /Кэшбэк постоянного клиента/);
  // The page has an earlier inline metrics loader. Parse only the final
  // storefront script instead of concatenating unrelated <script> blocks.
  const lastScriptStart = html.lastIndexOf('<script>');
  const lastScriptEnd = html.lastIndexOf('</script>');
  assert.ok(lastScriptStart > 0 && lastScriptEnd > lastScriptStart,
    'storefront main inline script must remain');
  const js = html.slice(lastScriptStart + '<script>'.length, lastScriptEnd);
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'storefront-inline.js' }));
});

test('games API is no longer registered; existing customer rewards and ledger are preserved', () => {
  const server = read('server/server.js');
  assert.doesNotMatch(server, /register(?:Chess|Quiz)Routes|routes-(?:chess|quiz)/);
  assert.match(server, /registerPaymentRoutes\(router\)/);
  assert.match(server, /registerCustomerRoutes\(router\)/);
  const rewards = read('server/bones.js');
  assert.match(rewards, /function awardBones\(/);
  assert.match(rewards, /function spendBones\(/);
  assert.match(rewards, /bone_transactions/);
  const schema = read('server/db.js');
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS (?:quiz_prizes|quiz_attempts|chess_prizes|chess_wins|sms_login_codes)\b/);
  assert.doesNotMatch(schema, /renameColumnIfNeeded\('quiz_prizes'/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bone_transactions/);
  assert.match(schema, /bones_balance/);
  assert.equal(fs.existsSync(path.join(root,'server/sms.js')),false);
  // Existing historical records are preserved in upgraded databases.
  assert.doesNotMatch(schema, /DROP TABLE(?: IF EXISTS)? (?:quiz_|chess_|sms_login_codes)/i);
  assert.match(read('server/routes-customers.js'), /deletePhoneRows\('quiz_prizes', false\)/);
  assert.doesNotMatch(read('server/settings.js'), /quiz_tier\d|chess_win_bones|quiz_bones_balance_cap/);
  assert.equal(fs.existsSync(path.join(root,'server/routes-quiz.js')),false);
  assert.equal(fs.existsSync(path.join(root,'server/routes-chess.js')),false);
});


test('production checkout never simulates payment in the browser or server', () => {
  const payment = read('server/routes-payment.js');
  assert.doesNotMatch(payment, /DEMO_MODE|isDemoModeEnabled|demo:\s*true|finalizePaidOrder\([^\n]*,\s*true\)/);
  assert.match(payment, /if \(!yookassa\.isConfigured\(\)\) \{[\s\S]*?code: 'PAYMENT_NOT_CONFIGURED'/);
  const store = read('public/index.html');
  assert.doesNotMatch(store, /simulatePaymentSuccess|data\.demo/);
  assert.match(store, /function onPaymentSuccess\(/);
});
