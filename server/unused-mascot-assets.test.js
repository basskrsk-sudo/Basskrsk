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


test('superseded original mascot artwork is removed without breaking new art or the 404 page',()=>{
  const replacements = {
    'cart-full.png':'cart-full-v2-clean.webp',
    'catalog.png':'catalog-v2.webp',
    'checkout.png':'checkout-v2-clean.webp',
    'order-success.png':'purchase-success-v2.webp',
  };
  for(const [oldName,newName] of Object.entries(replacements)){
    assert.equal(fs.existsSync(path.join(root,'public/images/mascot',oldName)),false,oldName);
    assert.ok(fs.existsSync(path.join(root,'public/images/mascot',newName)),newName);
  }
  function scan(dir){
    for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
      const relative=path.join(dir,entry.name);
      if(entry.isDirectory()){
        if(entry.name!=='uploads'&&entry.name!=='node_modules')scan(relative);
        continue;
      }
      if(!entry.isFile()||!/\.(html|js|css|json|svg|xml|txt)$/i.test(entry.name)||
          entry.name.endsWith('.test.js'))continue;
      const source=fs.readFileSync(path.join(root,relative),'utf8').toLowerCase();
      for(const name of Object.keys(replacements)){
        assert.equal(source.includes('mascot/'+name),false,relative+' still requests '+name);
      }
    }
  }
  for(const dir of ['public','server','scripts'])scan(dir);
  const store=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  for(const name of Object.values(replacements))assert.ok(store.includes('mascot/'+name));
  assert.ok(fs.existsSync(path.join(root,'public/images/mascot/not-found.png')));
});
