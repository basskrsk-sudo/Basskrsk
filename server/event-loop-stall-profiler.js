'use strict';

// Records the precise time and process CPU time around rare event-loop stalls.
// No stack traces, request URLs, user data or SQL payloads are collected.
const { performance } = require('node:perf_hooks');

function createEventLoopStallProfiler({
  // Catch stalls above one second without waking the CPU four times a second.
  intervalMs = 1000,
  thresholdMs = 1000,
  maxEvents = 8,
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
  cpuUsage = () => process.cpuUsage(),
  residentBytes = () => process.memoryUsage().rss,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null, lastTime = null, lastCpu = null;
  const recent = [];
  function sample() {
    const now = monotonicNow();
    const cpu = cpuUsage();
    if (lastTime === null) {
      lastTime = now; lastCpu = cpu;
      return null;
    }
    const elapsed = now - lastTime;
    const cpuMs = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000;
    lastTime = now;
    lastCpu = cpu;
    if (!Number.isFinite(elapsed) || elapsed <= 0 ||
        !Number.isFinite(cpuMs) || cpuMs < 0 ||
        elapsed - intervalMs < thresholdMs) return null;
    const stall = {
      at: new Date(wallNow()).toISOString(),
      late_by_ms: Math.round(elapsed - intervalMs),
      sample_window_ms: Math.round(elapsed),
      process_cpu_ms: Math.round(cpuMs),
      process_cpu_pct: Math.round(cpuMs / elapsed * 1000) / 10,
      rss_mb: Math.round(residentBytes() / 1048576),
    };
    recent.push(stall);
    if (recent.length > maxEvents) recent.shift();
    return stall;
  }
  return {
    start() {
      if (timer !== null) return;
      lastTime = monotonicNow();
      lastCpu = cpuUsage();
      timer = setIntervalFn(sample, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearIntervalFn(timer);
      timer = null;
      lastTime = null;
      lastCpu = null;
    },
    snapshot() { return [...recent].reverse(); },
  };
}

const eventLoopStallProfiler = createEventLoopStallProfiler();
module.exports = { createEventLoopStallProfiler, eventLoopStallProfiler };
