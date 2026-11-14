'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const retired = [
  'bones', 'cart-empty', 'cart-full-v2-clean', 'catalog-v2',
  'checkout-v2-clean', 'locations', 'product', 'purchase-success-v2',
];

test('retired mascot PNGs are removed and their WebP replacements remain', () => {
  for (const name of retired) {
    assert.equal(fs.existsSync(path.join(root, 'public/images/mascot', name + '.png')),
      false, name + '.png should not be included in the production static assets');
    assert.ok(fs.existsSync(path.join(root, 'public/images/mascot', name + '.webp')),
      name + '.webp must remain');
  }
  // Keep this iOS / Apple touch icon in PNG format.
  assert.ok(fs.existsSync(path.join(root, 'public/images/hvostmarket-mark-v4-transparent.png')));
});

test('client source does not request the retired PNG paths', () => {
  const publicDir = path.join(root, 'public');
  for (const entry of fs.readdirSync(publicDir, { withFileTypes:true })) {
    if (!entry.isFile() || !/\.(html|js|css|json)$/i.test(entry.name)) continue;
    const code = fs.readFileSync(path.join(publicDir, entry.name), 'utf8');
    for (const name of retired) {
      assert.doesNotMatch(code, new RegExp('mascot/' + name + '\\.png', 'i'),
        entry.name + ' should serve WebP instead of retired PNG');
    }
  }
});
