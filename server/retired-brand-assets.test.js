'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const retired = [
  { path:'public/logo-husky-header.png', name:'logo-husky-header' },
  { path:'public/images/taiga-logo.png', name:'taiga-logo' },
];

test('retired brand artwork is absent from deployed static files', () => {
  for (const asset of retired) {
    assert.equal(fs.existsSync(path.join(root, asset.path)), false, asset.path);
  }
});

test('public client and production server modules do not reference retired artwork', () => {
  const roots = ['public','server'];
  for (const dir of roots) {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes:true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(html|js|css|json|svg)$/i.test(entry.name) ||
          entry.name.endsWith('.test.js')) continue;
      const source = fs.readFileSync(path.join(root, dir, entry.name), 'utf8');
      for (const asset of retired) {
        assert.doesNotMatch(source, new RegExp(asset.name, 'i'),
          dir + '/' + entry.name + ' still links to ' + asset.path);
      }
    }
  }
});
