/**
 * Stopping cleanly.
 *
 * Railway stops a deployment by sending SIGTERM, then SIGKILL after the
 * service's draining time. A service with a volume is stopped BEFORE its
 * replacement starts (two deployments may not mount one volume), so every
 * deploy and every restart goes through here.
 *
 * Why a handler is needed at all:
 *
 *   - The database is sql.js: the whole database is in memory and every write
 *     exports it and rewrites data/quoting.db (models/database.js: write to
 *     quoting.db.tmp, rename over the file). That write is synchronous. With no
 *     SIGTERM handler the default action ends the process wherever it is —
 *     including halfway through writing the temporary file. The rename makes
 *     that survivable (the old file is intact, the half-written .tmp is
 *     ignored), but the request that was being served is cut off mid-answer and
 *     its write is lost.
 *   - With a handler, Node runs it between two pieces of JavaScript, never
 *     inside one: a save that has started always finishes (write and rename)
 *     before the handler runs. Nothing is cut mid-flight.
 *   - In a container the server is process 1, and the kernel does not apply
 *     the default SIGTERM action to process 1 at all: without a handler the
 *     signal is ignored and the service is killed hard when the draining time
 *     runs out.
 *
 * What happens on SIGTERM (or SIGINT):
 *   1. stop accepting connections; idle keep-alive connections are closed
 *   2. requests already being served get up to SHUTDOWN_GRACE_MS (default
 *      10 000) to finish — a checkout, a webhook from Stripe, an upload
 *   3. the database is saved once more and flushed to the disk (fsync of the
 *      file and of its folder), so the bytes are on the volume, not in a cache
 *   4. the stop is recorded (ops/state.js) and the process exits 0
 *
 * Railway's draining time defaults to 0 seconds, which leaves no room for
 * step 2: set it to 15 in the service settings (docs/launch/go-live-runbook.md).
 * Even with 0 the database file is never left half-written, for the reason
 * above; what is lost is only the chance to finish in-flight requests.
 *
 * A second signal while this is running skips the wait and goes to step 3.
 */
const fs = require("fs");
const path = require("path");

function graceMs(env = process.env) {
  const n = Number(env.SHUTDOWN_GRACE_MS);
  return Number.isFinite(n) && n >= 0 && n <= 120000 ? Math.floor(n) : 10000;
}

/** Save the database and push it through to the disk. Returns what was done, for the log. */
function flushDatabase(database = require("../models/database")) {
  const out = { saved: false, synced: false, bytes: 0 };
  try {
    database.saveToDisk();
    out.saved = true;
  } catch (err) {
    out.error = err.code || err.name || "Error";
    return out;
  }
  const file = database.DB_PATH;
  try {
    const fd = fs.openSync(file, "r");
    try { fs.fsyncSync(fd); out.bytes = fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
    out.synced = true;
  } catch (err) {
    if (err.code !== "ENOENT") out.error = err.code || err.name || "Error";
    return out;
  }
  // The rename lives in the folder's own record: flush that too. Not every file system allows it.
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best effort */ }
  return out;
}

/**
 * @param {import("http").Server} server the listening server
 * @param {object} [opt] everything below is for tests
 * @param {(code: number) => void} [opt.exit]
 * @param {() => object} [opt.flush]
 * @param {(line: string) => void} [opt.log]
 * @param {NodeJS.Process | import("events")} [opt.proc] where the signals arrive
 * @param {number} [opt.graceMs]
 * @param {() => void} [opt.onStopped] called after the flush, before exit (records the clean stop)
 */
function install(server, opt = {}) {
  const exit = opt.exit || ((code) => process.exit(code));
  const flush = opt.flush || (() => flushDatabase());
  const log = opt.log || ((line) => console.log(line));
  const proc = opt.proc || process;
  const grace = typeof opt.graceMs === "number" ? opt.graceMs : graceMs();

  const state = { stopping: false, finished: false, signal: null, timer: null, poll: null };

  function finish(reason) {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    clearInterval(state.poll);
    let result = {};
    try { result = flush() || {}; } catch (err) { result = { error: err.code || err.name || "Error" }; }
    try { if (typeof opt.onStopped === "function") opt.onStopped(result); } catch { /* the stop still completes */ }
    if (result.error) log(`Shutdown: ${reason}; database save FAILED (${result.error}). The last completed write is still on disk.`);
    else log(`Shutdown: ${reason}; database saved${result.synced ? " and flushed to disk" : ""}${result.bytes ? ` (${(result.bytes / 1e6).toFixed(1)} MB)` : ""}. Exiting.`);
    exit(result.error ? 1 : 0);
  }

  function begin(signal) {
    if (state.stopping) {
      // Asked twice: do not wait any longer for open requests.
      return finish(`second ${signal}, not waiting for open requests`);
    }
    state.stopping = true;
    state.signal = signal;
    log(`${signal} received: no new connections; giving requests in progress up to ${Math.round(grace / 1000)} s to finish.`);
    try {
      server.close(() => finish("all requests finished"));
    } catch {
      return finish("server was not listening");
    }
    const closeIdle = () => { try { if (typeof server.closeIdleConnections === "function") server.closeIdleConnections(); } catch { /* older Node */ } };
    closeIdle();
    // A connection that finishes its request becomes idle and would otherwise hold the server open until the client hangs up.
    state.poll = setInterval(closeIdle, 200);
    state.timer = setTimeout(() => finish(`requests still open after ${Math.round(grace / 1000)} s`), grace);
  }

  const onTerm = () => begin("SIGTERM");
  const onInt = () => begin("SIGINT");
  proc.on("SIGTERM", onTerm);
  proc.on("SIGINT", onInt);

  return {
    state,
    begin,
    /** Tests: take the handlers off again. */
    uninstall() { proc.removeListener("SIGTERM", onTerm); proc.removeListener("SIGINT", onInt); clearTimeout(state.timer); clearInterval(state.poll); },
  };
}

module.exports = { install, flushDatabase, graceMs };
