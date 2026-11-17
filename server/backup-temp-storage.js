'use strict';
// Temporary copies for SMTP/download do not need to occupy /data.
// Only fully sent/downloaded snapshots leave this ephemeral workspace;
// the production DB and pre-restore safety backups remain persistent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function createTemporaryBackupWorkspace({ tempRoot = os.tmpdir() } = {}) {
  const root = path.resolve(tempRoot);
  const persistent = path.resolve(process.env.DATA_DIR ||
    path.join(__dirname, '..', 'data'));
  if (root === persistent || root.startsWith(persistent + path.sep)) {
    throw new Error('Backup temporary directory must be outside persistent storage');
  }
  // mkdtemp creates a private directory (0700), so a temporary customer
  // database is not readable by other users on a shared /tmp filesystem.
  const directory = await fs.promises.mkdtemp(path.join(root, 'hm-backup-'));
  return {
    path: path.join(directory, 'snapshot.db'),
    directory,
    cleanup: () => fs.promises.rm(directory, {recursive:true, force:true}),
  };
}

module.exports = { createTemporaryBackupWorkspace };
