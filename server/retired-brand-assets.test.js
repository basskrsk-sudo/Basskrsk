'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const retired = [
  { path:'public/logo-husky-header.png', name:'logo-husky-header' },
  { path:'public/images/taiga-logo.png', name:'taiga-logo' },
  { path:'public/images/hvostmarket-logo-v3.png', name:'hvostmarket-logo-v3.png' },
  { path:'public/images/hvostmarket-mark-v3.png', name:'hvostmarket-mark-v3.png' },
  { path:'public/images/hvostmarket-primary-logo.png', name:'hvostmarket-primary-logo.png' },
  { path:'public/images/taiga-paw-icon.png', name:'taiga-paw-icon.png' },
  { path:'public/taiga_notion_template.xlsx', name:'taiga_notion_template.xlsx' },
];

test('retired brand artwork is absent from deployed static files', () => {
  for (const asset of retired) {
    assert.equal(fs.existsSync(path.join(root, asset.path)), false, asset.path);
  }
});

function scanRuntime(dir, visit) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes:true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'uploads') scanRuntime(relative, visit);
      continue;
    }
    if (!entry.isFile() || !/\.(html|js|css|json|svg|xml|txt)$/i.test(entry.name) ||
        entry.name.endsWith('.test.js')) continue;
    visit(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
  }
}

test('public client and production server modules do not reference retired assets', () => {
  for (const dir of ['public','server','scripts']) scanRuntime(dir,(relative,source)=>{
    for (const asset of retired) {
      assert.equal(source.toLowerCase().includes(asset.name.toLowerCase()), false,
        relative + ' still links to ' + asset.path);
    }
  });
});

test('active artwork, printable QR logos, error page and archived template are preserved',()=>{
  for(const asset of [
    'public/images/hvostmarket-logo-v3-transparent.png',
    'public/images/hvostmarket-mark-v3-transparent.png',
    'public/images/hvostmarket-mark-v4-transparent.png',
    'public/images/hvostmarket-mark-v4-transparent.webp',
    'public/images/mascot/not-found.png',
    'public/images/icons/icon-180-apple.png',
    'public/images/icons/icon-192.png',
    'public/images/icons/icon-512.png',
    'docs/archive/taiga_notion_template.xlsx',
  ]) assert.ok(fs.existsSync(path.join(root,asset)),asset+' must remain');
  const qr=fs.readFileSync(path.join(root,'public/admin-qr.js'),'utf8');
  const missing=fs.readFileSync(path.join(root,'public/404.html'),'utf8');
  assert.match(qr,/hvostmarket-logo-v3-transparent\.png/);
  assert.match(qr,/hvostmarket-mark-v3-transparent\.png/);
  assert.match(missing,/mascot\/not-found\.png/);
  const template=fs.readFileSync(path.join(root,'docs/archive/taiga_notion_template.xlsx'));
  assert.equal(template.subarray(0,2).toString(),'PK','archive must be the actual XLSX, not a placeholder');
});
