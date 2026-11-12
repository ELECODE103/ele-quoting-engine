/**
 * Latency assertions that measure the code and not the machine.
 *
 * Several suites prove that slow work happens off the event loop by timing something that must
 * stay quick while it runs (a health check during a 10-second parse; a timer on the main thread).
 * A fixed bound ("under 250 ms") is true on a quiet machine and flakes on a busy one, where any
 * process can be left off the CPU for a few hundred milliseconds — and on a freshly started server,
 * whose first answer pays for loading its routes.
 *
 * What these helpers assert instead, for one measurement window:
 *
 *   ceiling   never relaxed. The worst sample is under 1000 ms AND under half the time the slow
 *             work took. Work done ON the event loop holds an answer for as long as the work
 *             takes, so this alone fails the regression the test exists for, on any machine.
 *   tight     the worst sample is under the test's own bound (250 ms, say) PLUS the longest
 *             stall the machine itself showed during the same window — measured by an idle
 *             timer on its own thread in this process (it does nothing, so any delay it sees is
 *             the scheduler's) and, when given, by the same request made while the server was
 *             idle. On a quiet machine that allowance is a few milliseconds and the bound is
 *             the old one.
 *   typical   with 20 samples or more, nine in ten are under 100 ms: a loop that is free "most
 *             of the time" is not enough.
 */
const assert = require("assert");
const { Worker } = require("worker_threads");

const HARD_CEILING_MS = 1000;
const TYPICAL_MS = 100;

const PROBE = `
  const { parentPort, workerData } = require("worker_threads");
  let worst = 0, last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - workerData); last = now; }, workerData);
  parentPort.on("message", () => { clearInterval(timer); parentPort.postMessage(worst); });
`;

/**
 * Start measuring how long this machine leaves an idle thread waiting. `stop()` resolves to the
 * worst delay seen, in ms. `{ mainThread: true }` also watches this process's own event loop — for
 * tests whose code under test runs in ANOTHER process (a delay here inflates what they measure);
 * leave it off when the main thread is itself what is being measured.
 */
function machineProbe({ intervalMs = 20, mainThread = false } = {}) {
  const worker = new Worker(PROBE, { eval: true, workerData: intervalMs });
  worker.unref();
  let local = 0, last = Date.now();
  const timer = mainThread ? setInterval(() => { const now = Date.now(); local = Math.max(local, now - last - intervalMs); last = now; }, intervalMs) : null;
  if (timer) timer.unref();
  return {
    stop() {
      if (timer) clearInterval(timer);
      return new Promise((resolve) => {
        const done = (ms) => { worker.terminate().catch(() => {}); resolve(Math.max(0, Math.round(Math.max(Number(ms) || 0, local)))); };
        worker.once("message", done);
        worker.once("error", () => done(0));
        worker.postMessage("stop");
      });
    },
  };
}

/**
 * @param {number[]} samples        what was timed during the slow work, in ms
 * @param {object}   o
 * @param {number}   o.tightMs      the test's own bound for a quiet machine
 * @param {number}   [o.tookMs]     how long the slow work took (sets the ceiling at half of it)
 * @param {number}   [o.machineMs]  worst stall the machine showed in the same window (machineProbe)
 * @param {number[]} [o.idle]       the same thing timed while nothing slow was running (warm), in ms
 * @param {string}   o.what         what a sample is, for the message
 * @returns {string} a one-line summary for the test log
 */
function assertResponsive(samples, { tightMs, tookMs, machineMs = 0, idle = [], what }) {
  assert.ok(Array.isArray(samples) && samples.length > 0, `${what}: nothing was measured`);
  const sorted = [...samples].sort((a, b) => a - b);
  const worst = sorted[sorted.length - 1];
  const idleWorst = idle.length ? Math.max(...idle) : 0;
  const ceiling = Math.min(HARD_CEILING_MS, tookMs ? tookMs / 2 : HARD_CEILING_MS);
  const allowance = Math.max(machineMs, idleWorst);
  const bound = Math.min(ceiling, tightMs + allowance);
  assert.ok(worst < ceiling, `${what}: ${worst} ms — the work is holding the event loop (ceiling ${Math.round(ceiling)} ms${tookMs ? `, half of the ${tookMs} ms it took` : ""}; this bound is not relaxed for a busy machine)`);
  assert.ok(worst < bound, `${what}: ${worst} ms, over ${tightMs} ms plus the ${allowance} ms stall this machine showed in the same window`);
  let typical = "";
  if (sorted.length >= 20) {
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    assert.ok(p90 < TYPICAL_MS, `${what}: nine in ten should be under ${TYPICAL_MS} ms; the 90th percentile was ${p90} ms`);
    typical = `, median ${sorted[Math.floor(sorted.length / 2)]} ms, p90 ${p90} ms`;
  }
  return `${sorted.length} samples${typical}, worst ${worst} ms (bound ${Math.round(bound)} ms = ${tightMs} + machine stall ${allowance} ms; ceiling ${Math.round(ceiling)} ms)`;
}

module.exports = { machineProbe, assertResponsive, HARD_CEILING_MS, TYPICAL_MS };
