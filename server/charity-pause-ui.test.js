'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const serverDir = __dirname;

function filesIn(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Bundled third-party libraries and images are outside this brand-content audit.
      if (!['vendor', 'images', 'fonts', 'docs'].includes(entry.name)) result.push(...filesIn(fullPath));
    } else if (/\.(html|js|css|xml|txt)$/i.test(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

test('paused charity program has no public landing page, logo or public references', () => {
  assert.equal(fs.existsSync(path.join(publicDir, 'hvost-pomoshchi.html')), false);
  assert.equal(fs.existsSync(path.join(publicDir, 'hvost-pomoshch-logo-v5-selected.png')), false);
  for (const file of filesIn(publicDir)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /хвост[ -]?помо|hvost-pomosh|charity-strip|charity-card|charity-amount|charity-note|10\s*₽\s*с\s*кажд/i, file);
  }
});

test('checkout and business model no longer include a per-sale charity expense', () => {
  for (const name of ['index.html', 'miniapp.html']) {
    const source = fs.readFileSync(path.join(publicDir, name), 'utf8');
    assert.doesNotMatch(source, /благотвор|пожертвов|с\s*каждой\s*покупки\s*[-—]\s*в\s*фонд/i, name);
  }
  for (const name of ['unit-economics.js','routes-economics.js','growth-plan.js']) {
    const source = fs.readFileSync(path.join(serverDir, name), 'utf8');
    assert.doesNotMatch(source, /charity|donation|пожертвов|благотвор|хвост[ -]?помо/i, name);
  }
});
