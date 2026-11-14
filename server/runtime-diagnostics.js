'use strict';
// Bounded, low-overhead diagnostics. Only fixed operation names are recorded;
// SQL text, arguments, paths, user identifiers and tokens are never stored.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const operations = new Map();
const MAX_OPERATIONS = 32;
const SLOW_LOG_MS = 1500;
let previousCpu = null;
const lastWarnings = new Map();

function parseCpuStat(content) {
  const fields = Object.create(null);
  for (const line of String(content || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) continue;
    fields[parts[0]] = Number(parts[1]);
  }
  if (!Number.isSafeInteger(fields.nr_periods) ||
      !Number.isSafeInteger(fields.nr_throttled)) return null;
  const throttledUs = Number.isSafeInteger(fields.throttled_usec)
    ? fields.throttled_usec :
    Number.isSafeInteger(fields.throttled_time) ? Math.floor(fields.throttled_time / 1000) : null;
  return { periods: fields.nr_periods, throttled: fields.nr_throttled,
    throttled_us: throttledUs };
}

function cpuThrottleDelta(previous, current) {
  if (!previous || !current ||
      current.periods < previous.periods ||
      current.throttled < previous.throttled) return null;
  const periods = current.periods - previous.periods;
  const throttledPeriods = current.throttled - previous.throttled;
  const us = current.throttled_us == null || previous.throttled_us == null
    ? null : current.throttled_us - previous.throttled_us;
  if (periods <= 0 || throttledPeriods < 0 || throttledPeriods > periods) return null;
  return {
    periods,
    throttled_periods: throttledPeriods,
    throttled_periods_pct: Math.round(throttledPeriods / periods * 1000) / 10,
    throttled_ms: us != null && us >= 0 ? Math.round(us / 1000) : null,
  };
}

async function sampleCpuThrottling(readFile = fs.promises.readFile.bind(fs.promises)) {
  let content;
  let source;
  for (const candidate of ['/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/cpu/cpu.stat']) {
    try {
      content = await readFile(candidate, 'utf8');
      source = candidate === '/sys/fs/cgroup/cpu.stat' ? 'cgroup_v2' : 'cgroup_v1';
      break;
    } catch (_) { /* Not always mounted by the container provider. */ }
  }
  const current = content == null ? null : parseCpuStat(content);
  if (!current) return { available: false, reason: 'cgroup CPU counters unavailable' };
  const delta = cpuThrottleDelta(previousCpu, current);
  previousCpu = current;
  return { available: true, source, ...(delta || {
    periods: null, throttled_periods: null,
    throttled_periods_pct: null, throttled_ms: null,
  }) };
}
function safeName(name) {
  const value = String(name);
  if (!/^[a-z][a-z0-9_]{0,55}$/.test(value)) throw new TypeError('Invalid operation name');
  return value;
}
function recordOperation(name, elapsedMs) {
  const key = safeName(name);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  let record = operations.get(key);
  if (!record) {
    if (operations.size >= MAX_OPERATIONS) return;
    record = { name: key, calls: 0, slow_calls: 0, total_ms: 0, max_ms: 0, last_ms: 0 };
    operations.set(key, record);
  }
  record.calls++;
  record.total_ms += elapsedMs;
  record.last_ms = Math.round(elapsedMs);
  record.max_ms = Math.max(record.max_ms, record.last_ms);
  if (elapsedMs >= SLOW_LOG_MS) {
    record.slow_calls++;
    const now = Date.now();
    // No more than one console warning per job type every 15 minutes.
    if (now - (lastWarnings.get(key) || 0) > 15 * 60 * 1000) {
      lastWarnings.set(key, now);
      console.warn('[runtime] Slow operation:', key, record.last_ms, 'ms');
    }
  }
}
function trackSync(name, fn) {
  safeName(name);
  const started = performance.now();
  try { return fn(); } finally { recordOperation(name, performance.now() - started); }
}
async function trackAsync(name, fn) {
  safeName(name);
  const started = performance.now();
  try { return await fn(); } finally { recordOperation(name, performance.now() - started); }
}
function snapshotOperations() {
  return [...operations.values()].map(item => ({
    name: item.name, calls: item.calls, slow_calls: item.slow_calls,
    max_ms: item.max_ms, last_ms: item.last_ms,
    avg_ms: Math.round(item.total_ms / item.calls),
  })).sort((a, b) => b.max_ms - a.max_ms).slice(0, 12);
}
module.exports = {
  parseCpuStat, cpuThrottleDelta, sampleCpuThrottling,
  recordOperation, trackSync, trackAsync, snapshotOperations,
};
