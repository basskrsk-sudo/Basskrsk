'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Exercise the same profile resolver used in the standalone browser page,
// including Unicode and percent-encoded URL paths.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'tasks.html'), 'utf8');
const start = html.indexOf('const FRIENDLY_PROFILES = ');
const end = html.indexOf('function storageKey(profileKey) {', start);
assert.ok(start >= 0 && end > start, 'name resolver must exist in task page');
const resolvePath = new Function('location',
  html.slice(start, end) + '\nreturn CURRENT_PROFILE;'
);

test('five Cyrillic task addresses select only their corresponding profile', () => {
  const profiles = [
    ['/админ', 'admin'],
    ['/Алексей', 'alexey'],
    ['/Виталий', 'vitaly'],
    ['/Ангелина', 'angelina'],
    ['/Николай', 'nikolay'],
  ];
  for (const [pathname, expected] of profiles) {
    assert.equal(resolvePath({pathname}), expected);
    assert.equal(resolvePath({pathname: pathname.toUpperCase()}), expected);
    assert.equal(resolvePath({pathname: encodeURI(pathname)}), expected);
    assert.equal(resolvePath({pathname: pathname + '/'}), expected);
  }
});

test('non-profile paths never activate a personal role', () => {
  for (const pathname of ['/tasks.html', '/t', '/Алексей-подделка', '/admin', '/']) {
    assert.equal(resolvePath({pathname}), null);
  }
});

test('clean task paths do not authenticate on their own', () => {
  const api = fs.readFileSync(path.join(__dirname, 'routes-task-page.js'), 'utf8');
  assert.match(api, /Authorization|authorization/);
  assert.match(api, /findAccess/);
  assert.match(html, /connectWithToken\(candidate,\s*CURRENT_PROFILE\)/);
  assert.match(html, /cachedToken\(CURRENT_PROFILE\)/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /forgetThisDevice/);
});

test('server serves all five names from the same task page', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  for (const segment of ['/админ','/алексей','/виталий','/ангелина','/николай']) {
    assert.ok(server.includes("'" + segment + "'"), 'Missing server route for ' + segment);
  }
  assert.match(server, /serveStatic\(req,\s*res,\s*'\/tasks\.html'\)/);
});
