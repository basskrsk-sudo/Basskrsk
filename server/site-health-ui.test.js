'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ui=fs.readFileSync(path.join(__dirname,'../public/miniapp-work.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/taiga-admin.html'),'utf8');
test('admin Mini App retrieves health from authenticated route without adding it to non-admin dashboards',()=>{
  assert.match(ui,/var wantSystemHealth=role==='admin'/);
  assert.match(ui,/fetchJSON\('\/api\/admin\/system-health',token\)/);
  assert.match(ui,/if \(role === 'admin'\) html \+= adminDashboard\(data,diagnosticData,systemData\)/);
  assert.match(ui,/surface\('💓 Состояние системы',healthContent\)/);
  assert.match(ui,/event_loop_delay_ms/);
  assert.match(ui,/cpu_percent/);
});
test('full administration System navigation includes a reachable monitoring page',()=>{
  assert.match(html,/id="sec-system-health"/);
  assert.match(html,/system: \[\['launch','План запуска'\], \['system-health','Мониторинг'\]/);
  assert.match(html,/if \(id === 'system-health'\) await renderSystemHealth\(\)/);
  assert.match(html,/authFetch\('\/api\/admin\/system-health'\)/);
  assert.match(html,/id="system-health-content"/);
  assert.match(html,/function opsEscapeHtml/);
  assert.match(html,/safe\(event.detail\)/);
});
