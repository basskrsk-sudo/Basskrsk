// Run one-time historical task imports only when their seed markers are missing.
// On an existing database this makes just one lightweight read and avoids
// loading four retired meeting-import modules on every application restart.
// Fresh installs and partially upgraded databases still receive missing tasks.
'use strict';

const LEGACY_TASK_SEEDS = Object.freeze([
  {
    module: './task-seed',
    method: 'seedMeetingTasks',
    versions: [
      'meetings-2026-09-20-27-v1',
      'task-2026-09-28-price-list-angelina-v1',
      'task-2026-09-28-price-list-angelina-due-2026-10-02-v1',
    ],
  },
  {
    module: './task-seed-2026-10-25',
    method: 'seedMeeting20261025',
    versions: ['meeting-2026-10-25-tasks-v1'],
  },
  {
    module: './task-seed-2026-11-01',
    method: 'seedMeeting20261101',
    versions: ['meeting-2026-11-01-approved-v1'],
  },
  {
    module: './task-seed-2026-11-02',
    method: 'seedKrasnoyarskSupplyStrategy',
    versions: ['task-2026-11-02-krasnoyarsk-supply-strategy-v1'],
  },
]);

function runPendingTaskSeeds(database = require('./db'), loadModule = require) {
  const completed = new Set(
    database.prepare('SELECT version FROM task_seed_versions').all().map(row => row.version)
  );
  for (const seed of LEGACY_TASK_SEEDS) {
    if (seed.versions.every(version => completed.has(version))) continue;
    // The original seed modules provide idempotency and preserve manual edits.
    loadModule(seed.module)[seed.method]();
  }
}

module.exports = { LEGACY_TASK_SEEDS, runPendingTaskSeeds };
