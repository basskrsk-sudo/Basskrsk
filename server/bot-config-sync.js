'use strict';
// Avoid re-publishing identical bot profiles on every Amvera release.
// Only public configuration digests and retry timestamps are persisted in /data.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

function configFingerprint(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
function retryAfterSeconds(error) {
  if (!error) return 0;
  const value = Number(error.retryAfterSeconds || error.retry_after || error.parameters?.retry_after);
  if (Number.isFinite(value) && value > 0) return Math.ceil(value);
  const match = String(error.message || '').match(/retry\s+after\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}
function planConfigSync(state, fingerprint, nowMs, refreshMs = REFRESH_MS) {
  const retryAt = Number(state?.retry_not_before) || 0;
  if (retryAt > nowMs) return { sync: false, reason: 'cooldown', waitMs: retryAt - nowMs };
  const successAt = Number(state?.success_at) || 0;
  if (state?.fingerprint === fingerprint && successAt > 0 && nowMs >= successAt &&
      nowMs - successAt < refreshMs) {
    return { sync: false, reason: 'unchanged', waitMs: refreshMs - (nowMs - successAt) };
  }
  return { sync: true, reason: 'changed_or_expired', waitMs: 0 };
}
function createBotConfigSync(name, configuration, options = {}) {
  if (!/^[a-z-]{1,40}$/.test(name)) throw new TypeError('Invalid bot sync name');
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const filePath = path.join(dataDir, 'bot-config-' + name + '.json');
  const now = options.now || Date.now;
  const refreshMs = options.refreshMs || REFRESH_MS;
  const fingerprint = configFingerprint(configuration);
  function readState() {
    try {
      const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return state && typeof state === 'object' ? state : {};
    } catch (_) { return {}; }
  }
  function writeState(state) {
    const tmp = filePath + '.tmp-' + process.pid;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      console.warn('[bot-config] Не удалось сохранить отметку настройки ' + name + ':', error.code || error.message);
      return false;
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  return {
    check() { return planConfigSync(readState(), fingerprint, now(), refreshMs); },
    succeeded() {
      return writeState({ fingerprint, success_at: now(), retry_not_before: 0 });
    },
    failed(errors = []) {
      const longest = Math.max(0, ...errors.map(retryAfterSeconds));
      // Honour Telegram's actual retry_after across releases; guard against a
      // pathological timestamp that exceeds Node's 32-bit timeout limit.
      const waitMs = Math.max(RETRY_MS, Math.min(longest * 1000, 20 * 24 * 60 * 60 * 1000));
      writeState({ ...readState(), retry_not_before: now() + waitMs });
      return waitMs;
    },
  };
}
module.exports = { REFRESH_MS, RETRY_MS, configFingerprint, retryAfterSeconds,
  planConfigSync, createBotConfigSync };
