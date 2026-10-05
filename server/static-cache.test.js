'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticCache } = require('./static-cache');

test('HTML validates with ETag and changes when an image is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  try {
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images/a.webp'), 'first image');
    const html = path.join(dir, 'index.html');
    fs.writeFileSync(html, '<img src="images/a.webp?v=old"><img src="/images/uploads/a.jpg">');
    const cache = createStaticCache(dir);
    const request = { method: 'GET', url: '/', headers: {} };
    const first = cache.response(html, request, 'text/html');
    assert.equal(first.headers['Cache-Control'], 'no-cache');
    assert.match(first.body.toString(), /a\.webp\?v=[a-f0-9]{20}/);
    assert.match(first.body.toString(), /src="\/images\/uploads\/a.jpg"/);
    const same = cache.response(html, { ...request, headers: { 'if-none-match': 'W/' + first.headers.ETag } }, 'text/html');
    assert.equal(same.status, 304);
    fs.writeFileSync(path.join(dir, 'images/a.webp'), 'replacement image');
    const changed = cache.response(html, { ...request, headers: { 'if-none-match': first.headers.ETag } }, 'text/html');
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.ETag, first.headers.ETag);
    assert.notEqual(changed.body.toString(), first.body.toString());
    const versionedUrl = changed.body.toString().match(/src="([^"]+)"/)[1];
    const image = cache.response(path.join(dir, 'images/a.webp'), { ...request, url: '/' + versionedUrl }, 'image/webp');
    assert.match(image.headers['Cache-Control'], /immutable/);
    const unversioned = cache.response(path.join(dir, 'images/a.webp'), { ...request, url: '/images/a.webp?v=old' }, 'image/webp');
    assert.equal(unversioned.headers['Cache-Control'], 'no-cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configuration and cabinet pages remain no-store even with a matching validator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-private-'));
  try {
    const cache = createStaticCache(dir);
    for (const name of ['config.js', 'sw.js', 'taiga-admin.html']) {
      fs.writeFileSync(path.join(dir, name), 'private settings');
      const response = cache.response(path.join(dir, name), { method: 'GET', url: '/' + name, headers: { 'if-none-match': '*' } }, 'text/plain');
      assert.equal(response.headers['Cache-Control'], 'no-store');
      assert.equal(response.status, 200);
      assert.equal(response.headers.ETag, undefined);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('font replacement updates stylesheet version and its parent HTML validator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-font-'));
  try {
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.writeFileSync(path.join(dir, 'fonts/font.woff2'), 'font one');
    fs.writeFileSync(path.join(dir, 'fonts/site.css'), "@font-face{src:url('/fonts/font.woff2')}");
    fs.writeFileSync(path.join(dir, 'index.html'), '<link href="/fonts/site.css" rel="stylesheet">');
    const cache = createStaticCache(dir);
    const req = { method: 'GET', url: '/', headers: {} };
    const first = cache.response(path.join(dir, 'index.html'), req, 'text/html');
    fs.writeFileSync(path.join(dir, 'fonts/font.woff2'), 'updated font two');
    const next = cache.response(path.join(dir, 'index.html'), req, 'text/html');
    assert.notEqual(first.headers.ETag, next.headers.ETag);
    const stylesheetUrl = next.body.toString().match(/href="([^"]+)"/)[1];
    const css = cache.response(path.join(dir, 'fonts/site.css'), { ...req, url: stylesheetUrl }, 'text/css');
    assert.match(css.headers['Cache-Control'], /immutable/);
    assert.match(css.body.toString(), /font\.woff2\?v=[a-f0-9]{20}/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
