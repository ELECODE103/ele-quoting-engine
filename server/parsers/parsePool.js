/**
 * Bounded pool of worker threads for geometry parsing.
 *
 * Why: parsing a CAD file is CPU-bound and can take seconds to minutes
 * (OpenCascade for STEP/IGES, feature recognition for meshes). Done on the
 * main thread it freezes every other request — the health check, checkout,
 * the admin panel — for as long as it runs, and one hostile file is enough.
 *
 * What this gives:
 *   - concurrency limit   PARSE_CONCURRENCY files are read at once
 *   - queue limit         PARSE_QUEUE_MAX more may wait; after that, and after
 *                         PARSE_QUEUE_WAIT_MS of waiting, the caller gets a
 *                         "busy" error (HTTP 503 with Retry-After)
 *   - fairness            one client address runs PARSE_PER_CLIENT files at a
 *                         time, so one sender cannot occupy every worker
 *   - wall-clock timeout  PARSE_TIMEOUT_MS per file, then worker.terminate()
 *   - memory ceilings     V8 heap per worker (resourceLimits, PARSE_MAX_HEAP_MB)
 *                         and a whole-process RSS watchdog (PARSE_RSS_LIMIT_MB)
 *                         for WASM and typed-array memory, which V8's heap
 *                         limit does not count
 *
 * Workers are kept warm between small files (loading OpenCascade costs about a
 * second) and retired — terminated, memory handed back — after a large or slow
 * file, after PARSE_WORKER_MAX_JOBS files, after any timeout or crash, and
 * when idle for a minute.
 *
 *   const { pool } = require("./parsePool");
 *   const parsed = await pool.run({ filePath, sizeBytes, client: "203.0.113.9" });
 */
const path = require("path");
const { Worker } = require("worker_threads");
const { limits, envInt } = require("../security/limits");

const WORKER = path.join(__dirname, "parseWorker.js");
const RETIRE_AFTER_BYTES = 5 * 1024 * 1024; // a file this big has grown the worker's heap; start clean
const RETIRE_AFTER_MS = 5000;               // so has a parse this slow
const IDLE_MS = 60 * 1000;

/** Error with a customer-safe message, an HTTP status and a machine-readable code. */
function poolError(code, status, message, extra = {}) {
  return Object.assign(new Error(message), { code, status, expose: true, ...extra });
}

const busy = (retryAfter) => poolError(
  "busy", 503,
  "We're reading a lot of files right now. Give it a minute and upload this one again.",
  { retryAfter },
);
const unreadable = () => poolError(
  "parse-failed", 422,
  "This file could not be read. Re-export it from your CAD program and upload again, or send it to us for a firm quote.",
  { offerRfq: true },
);

class ParsePool {
  /**
   * @param {object} [opts] fixed values for tests; anything left out is read
   *        from server/security/limits.js each time it is needed.
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.running = new Set();   // jobs with a worker
    this.queue = [];            // jobs waiting for a slot
    this.idle = [];             // warm workers: { worker, jobs, idleTimer }
    this.watchdog = null;
    this.nextId = 1;
    this.counters = { completed: 0, failed: 0, timedOut: 0, outOfMemory: 0, busy: 0, cancelled: 0, workersStarted: 0 };
  }

  _opt(name) {
    return this.opts[name] !== undefined ? this.opts[name] : limits[name];
  }

  stats() {
    return { running: this.running.size, queued: this.queue.length, idleWorkers: this.idle.length, ...this.counters };
  }

  /**
   * Parse one file.
   * @param {{filePath: string, options?: object, buffer?: Buffer, sizeBytes?: number, client?: string}} job
   *        `buffer` is for bytes already in memory (a decrypted upload); otherwise
   *        the worker reads `filePath` itself and the main thread never holds the file.
   * @returns {Promise<object> & {cancel: Function}} the parseFile() result
   */
  run(job) {
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = { id: this.nextId++, job, resolve, reject, client: job.client || "", settled: false, slot: null, timer: null, waitTimer: null, startedAt: 0 };
    });
    promise.cancel = () => this._cancel(entry);

    if (this._canStart(entry)) {
      this._start(entry);
    } else if (this.queue.length >= this._opt("parseQueueMax")) {
      this.counters.busy++;
      this._settle(entry, busy(this._retryAfter()));
    } else {
      this.queue.push(entry);
      entry.waitTimer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        this.counters.busy++;
        this._settle(entry, busy(this._retryAfter()));
      }, this._opt("parseQueueWaitMs"));
    }
    return promise;
  }

  _retryAfter() {
    return Math.max(5, Math.ceil(this._opt("parseTimeoutMs") / 1000));
  }

  _runningFor(client) {
    let n = 0;
    for (const e of this.running) if (e.client === client) n++;
    return n;
  }

  _canStart(entry) {
    if (this.running.size >= this._opt("parseConcurrency")) return false;
    // Each client address has its own lane; callers with no address share one.
    return this._runningFor(entry.client) < this._opt("parsePerClient");
  }

  /** A warm worker if there is one, else a new one. */
  _takeWorker() {
    const warm = this.idle.pop();
    if (warm) {
      clearTimeout(warm.idleTimer);
      warm.worker.ref();
      return warm;
    }
    const heap = this._opt("parseMaxHeapMb");
    const worker = new Worker(WORKER, {
      resourceLimits: { maxOldGenerationSizeMb: heap, maxYoungGenerationSizeMb: Math.min(64, Math.max(16, Math.floor(heap / 8))), stackSizeMb: 4 },
    });
    this.counters.workersStarted++;
    const slot = { worker, jobs: 0, idleTimer: null, entry: null, dead: false };
    worker.on("message", (msg) => {
      const entry = slot.entry;
      if (!entry || !msg || msg.id !== entry.id) return; // an answer for a job that already timed out
      if (msg.ok) { this.counters.completed++; return this._finish(entry, null, msg.result); }
      this.counters.failed++;
      const e = msg.error || {};
      // The parser's messages are written for the customer; keep name/code so the route can map them.
      this._finish(entry, Object.assign(new Error(e.message || "The file could not be read."), { name: e.name || "Error", code: e.code, offerRfq: e.offerRfq, fromParser: true }));
    });
    worker.on("error", (err) => {
      slot.dead = true;
      const entry = slot.entry;
      if (err && err.code === "ERR_WORKER_OUT_OF_MEMORY") {
        this.counters.outOfMemory++;
        console.warn(`Parse pool: a parse ran out of memory (${entry ? path.extname(entry.job.filePath || "") : "idle"}, heap limit ${heap} MB)`);
        if (entry) this._finish(entry, this._memoryError(), undefined, { kill: true });
      } else {
        console.error("Parse pool: worker error:", err && err.message);
        if (entry) { this.counters.failed++; this._finish(entry, unreadable(), undefined, { kill: true }); }
      }
      this._forget(slot);
    });
    worker.on("exit", () => {
      slot.dead = true;
      const entry = slot.entry;
      if (entry && !entry.settled) { this.counters.failed++; this._finish(entry, unreadable(), undefined, { kill: true }); }
      this._forget(slot);
    });
    return slot;
  }

  _forget(slot) {
    clearTimeout(slot.idleTimer);
    const i = this.idle.indexOf(slot);
    if (i >= 0) this.idle.splice(i, 1);
  }

  _start(entry) {
    clearTimeout(entry.waitTimer);
    const { filePath, options, buffer } = entry.job;
    let slot;
    try {
      slot = this._takeWorker();
    } catch (err) {
      console.error("Parse pool: could not start a worker:", err.message);
      this.counters.failed++;
      return this._settle(entry, poolError("parse-failed", 500, "We couldn't read this file just now. Try again in a minute."));
    }
    slot.entry = entry;
    slot.jobs++;
    entry.slot = slot;
    entry.startedAt = Date.now();
    this.running.add(entry);
    this._watch();

    const timeoutMs = this._opt("parseTimeoutMs");
    entry.timer = setTimeout(() => {
      this.counters.timedOut++;
      console.warn(`Parse pool: stopped a parse after ${Math.round(timeoutMs / 1000)}s (${path.extname(filePath || "") || "file"})`);
      this._finish(entry, poolError(
        "parse-timeout", 422,
        `This model took more than ${Math.round(timeoutMs / 1000)} seconds to read, which is longer than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote.`,
        { offerRfq: true },
      ), undefined, { kill: true });
    }, timeoutMs);

    slot.worker.postMessage({ id: entry.id, filePath, options: options || {}, buffer: buffer || null, testDelayMs: this.opts.testDelayMs || 0 });
  }

  _memoryError() {
    return poolError(
      "parse-memory", 422,
      "This model needs more memory to read than the instant quote allows. Simplify it or export it at a coarser resolution, or send it to us for a firm quote.",
      { offerRfq: true },
    );
  }

  /**
   * A running job is over (result, error, timeout, cancel): free the slot, keep
   * or retire its worker, start what is waiting.
   */
  _finish(entry, err, result, { kill = false } = {}) {
    if (entry.settled) return;
    clearTimeout(entry.timer);
    this.running.delete(entry);
    const slot = entry.slot;
    if (slot) {
      slot.entry = null;
      const took = Date.now() - entry.startedAt;
      const maxJobs = this.opts.workerMaxJobs !== undefined ? this.opts.workerMaxJobs : envInt("PARSE_WORKER_MAX_JOBS", 25, 1, 10000);
      const retire = kill || slot.dead || slot.jobs >= maxJobs || took > RETIRE_AFTER_MS
        || (entry.job.sizeBytes || (entry.job.buffer ? entry.job.buffer.length : 0)) > RETIRE_AFTER_BYTES;
      if (retire) {
        slot.dead = true;
        this._forget(slot);
        slot.worker.terminate().catch(() => {});
      } else {
        // Warm and idle: do not hold the process open, and let go after a minute.
        slot.worker.unref();
        slot.idleTimer = setTimeout(() => { slot.dead = true; this._forget(slot); slot.worker.terminate().catch(() => {}); }, this.opts.idleMs || IDLE_MS);
        if (slot.idleTimer.unref) slot.idleTimer.unref();
        this.idle.push(slot);
      }
    }
    this._settle(entry, err, result);
    this._drain();
    if (this.running.size === 0) this._unwatch();
  }

  _settle(entry, err, result) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.waitTimer);
    if (err) entry.reject(err); else entry.resolve(result);
  }

  _drain() {
    for (let i = 0; i < this.queue.length && this.running.size < this._opt("parseConcurrency");) {
      const next = this.queue[i];
      if (this._canStart(next)) { this.queue.splice(i, 1); this._start(next); } else i++;
    }
  }

  _cancel(entry) {
    if (entry.settled) return;
    this.counters.cancelled++;
    const i = this.queue.indexOf(entry);
    if (i >= 0) this.queue.splice(i, 1);
    const err = poolError("cancelled", 499, "The upload was cancelled.");
    if (this.running.has(entry)) this._finish(entry, err, undefined, { kill: true }); else this._settle(entry, err);
  }

  /** While anything is running, check the whole process's memory twice a second. */
  _watch() {
    if (this.watchdog) return;
    const limitMb = this._opt("parseRssLimitMb");
    if (!limitMb) return;
    this.watchdog = setInterval(() => {
      if (this.running.size === 0) return this._unwatch();
      const rssMb = (this.opts.rssProbe ? this.opts.rssProbe() : process.memoryUsage().rss) / (1024 * 1024);
      if (rssMb <= limitMb) return;
      // Warm workers hold memory too: let them go first, then stop the parse
      // that has been running longest (it has had the most time to grow).
      for (const slot of [...this.idle]) { slot.dead = true; this._forget(slot); slot.worker.terminate().catch(() => {}); }
      let oldest = null;
      for (const e of this.running) if (!oldest || e.startedAt < oldest.startedAt) oldest = e;
      if (!oldest) return;
      this.counters.outOfMemory++;
      console.warn(`Parse pool: process memory ${Math.round(rssMb)} MB is over the ${limitMb} MB ceiling; stopped a parse (${path.extname(oldest.job.filePath || "") || "file"})`);
      this._finish(oldest, this._memoryError(), undefined, { kill: true });
    }, this.opts.watchIntervalMs || 500);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  _unwatch() {
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Stop everything (tests, shutdown). */
  async close() {
    for (const e of [...this.queue]) this._cancel(e);
    for (const e of [...this.running]) this._cancel(e);
    for (const slot of [...this.idle]) { slot.dead = true; this._forget(slot); await slot.worker.terminate().catch(() => {}); }
    this._unwatch();
  }
}

/** The pool the routes use. */
const pool = new ParsePool();

module.exports = { ParsePool, pool, poolError };
