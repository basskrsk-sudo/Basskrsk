'use strict';
// Stop accepting new HTTP requests, let active purchases and callbacks finish,
// and only force close after the platform's limited termination window.
function installGracefulShutdown(server, options = {}) {
  const emitter = options.emitter || process;
  const exit = options.exit || (code => process.exit(code));
  const log = options.log || console;
  const graceMs = options.graceMs || 12000;
  const onStop = options.onStop || (() => {});
  const setDeadline = options.setDeadline || setTimeout;
  const clearDeadline = options.clearDeadline || clearTimeout;
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return false;
    stopping = true;
    log.log('[server] Graceful shutdown:', signal);
    try { onStop(); }
    catch (error) { log.warn('[server] Worker stop error:', error.message); }
    let complete = false;
    let timer;
    const finish = code => {
      if (complete) return;
      complete = true;
      if (timer) clearDeadline(timer);
      exit(code);
    };
    timer = setDeadline(() => {
      log.warn('[server] Shutdown deadline reached; closing open HTTP connections');
      try { server.closeAllConnections?.(); } catch (_) {}
      finish(1);
    }, graceMs);
    timer?.unref?.();
    try {
      server.close(error => finish(error ? 1 : 0));
      server.closeIdleConnections?.();
    } catch (error) {
      log.warn('[server] HTTP close failed:', error.message);
      finish(1);
    }
    return true;
  }
  emitter.once('SIGTERM', () => shutdown('SIGTERM'));
  emitter.once('SIGINT', () => shutdown('SIGINT'));
  return { shutdown, isShuttingDown: () => stopping };
}
module.exports = { installGracefulShutdown };
