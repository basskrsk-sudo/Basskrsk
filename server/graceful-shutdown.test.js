'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installGracefulShutdown } = require('./graceful-shutdown');
const logger = { log() {}, warn() {} };

test('SIGTERM stops workers once and drains existing HTTP requests', () => {
  const signals = new EventEmitter();
  let stopCount = 0, closeCount = 0, idleCount = 0, exitCode, callback;
  const server = {
    close(done) { closeCount++; callback = done; },
    closeIdleConnections() { idleCount++; },
  };
  const monitor = installGracefulShutdown(server, { emitter: signals, log: logger,
    exit: code => { exitCode = code; }, onStop: () => { stopCount++; } });
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  assert.equal(monitor.isShuttingDown(), true);
  assert.equal(stopCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(idleCount, 1);
  assert.equal(exitCode, undefined, 'active HTTP requests must not be killed early');
  callback();
  assert.equal(exitCode, 0);
});
test('shutdown forces a bounded exit when HTTP requests are stuck', () => {
  const signals = new EventEmitter();
  let deadline, forceClosed = 0, exitCode;
  const server = {
    close() {}, closeIdleConnections() {}, closeAllConnections() { forceClosed++; },
  };
  installGracefulShutdown(server, { emitter: signals, log: logger, graceMs: 25,
    setDeadline(fn) { deadline = fn; return { unref() {} }; }, clearDeadline() {},
    exit: code => { exitCode = code; } });
  signals.emit('SIGTERM');
  assert.equal(exitCode, undefined);
  deadline();
  assert.equal(forceClosed, 1);
  assert.equal(exitCode, 1);
});
