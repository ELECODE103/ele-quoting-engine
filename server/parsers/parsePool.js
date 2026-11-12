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
 *                         time and may hold PARSE_QUEUE_PER_CLIENT of the
 *                         waiting places; when a worker frees up, the client
 *                         that has waited longest since its last turn goes
 *                         next (round-robin across clients, not first come
 *                         first served across requests)
 *   - a parsing allowance PARSE_SECONDS_PER_CLIENT_HOUR of worker time per
 *                         client address, charged for the time a parse really
 *                         used — including one that was stopped. A client that
 *                         has used it is told so before its file is read.
 *   - a reserved worker   a client whose parse was stopped (time or memory) in
 *                         the last PARSE_SUSPECT_MINUTES may not take the last
 *                         free worker: one stays open for everyone else
 *   - time by file kind   a DXF gets PARSE_TIMEOUT_DXF_MS (10 s); the other
 *                         formats a base plus time per megabyte, never more
 *                         than PARSE_TIMEOUT_MS
 *   - wall-clock timeout  PARSE_TIMEOUT_MS per file, then worker.terminate()
 *   - memory ceilings     V8 heap per worker (resourceLimits, PARSE_MAX_HEAP_MB)
 *                         and a watchdog on the memory parsing adds to the
 *                         process (PARSE_RSS_LIMIT_MB) for WASM and
 *                         typed-array memory, which V8's heap limit does not
 *                         count
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

const brand = require("../../shared/brand.json");
const HOUR_MS = 60 * 60 * 1000;

/** Worker time one client has used in the last hour. */
class ParseBudget {
  constructor() { this.used = new Map(); } // client → [{ at, ms }]
  _live(client, now) {
    const list = this.used.get(client);
    if (!list) return [];
    while (list.length && now - list[0].at >= HOUR_MS) list.shift();
    if (!list.length) this.used.delete(client);
    return list;
  }
  usedMs(client, now = Date.now()) {
    let total = 0;
    for (const e of this._live(client, now)) total += e.ms;
    return total;
  }
  charge(client, ms, now = Date.now()) {
    if (!client || !(ms > 0)) return;
    let list = this.used.get(client);
    if (!list) {
      if (this.used.size >= 50000) { let n = 5000; for (const k of this.used.keys()) { this.used.delete(k); if (--n <= 0) break; } }
      list = [];
      this.used.set(client, list);
    }
    list.push({ at: now, ms });
  }
  /** Seconds until enough of the hour has passed for `needMs` to be free again. */
  retryAfterSeconds(client, limitMs, now = Date.now()) {
    const list = this._live(client, now);
    let over = this.usedMs(client, now) - limitMs;
    for (const e of list) {
      if (over < 0) break;
      over -= e.ms;
      if (over < 0) return Math.max(60, Math.ceil((e.at + HOUR_MS - now) / 1000));
    }
    return 60;
  }
  reset() { this.used.clear(); }
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
    this.budget = new ParseBudget();
    this.suspects = new Map();  // client → time its last parse was stopped
    this.lastTurn = new Map();  // client → when it last got a worker (round-robin)
    this.counters = { completed: 0, failed: 0, timedOut: 0, outOfMemory: 0, busy: 0, cancelled: 0, workersStarted: 0, overBudget: 0, queueFullForClient: 0 };
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

    // This client's parsing allowance for the hour, counting what its running parse has used so far.
    const limitMs = this._opt("parseSecondsPerClientHour") * 1000;
    if (entry.client && this._clientUsedMs(entry.client) >= limitMs) {
      this.counters.overBudget++;
      this._settle(entry, poolError(
        "parse-budget", 429,
        `We've spent as long reading files from this network in the last hour as the instant quote allows. Try again later, or email your files to ${brand.email} and we'll quote them by hand.`,
        { offerRfq: true, retryAfter: this.budget.retryAfterSeconds(entry.client, limitMs) },
      ));
      return promise;
    }

    if (this._canStart(entry)) {
      this._start(entry);
    } else if (this.queue.length >= this._opt("parseQueueMax")) {
      this.counters.busy++;
      this._settle(entry, busy(this._retryAfter()));
    } else if (this._queuedFor(entry.client) >= this._opt("parseQueuePerClient")) {
      // The waiting line is shared: one client may not fill it.
      this.counters.busy++;
      this.counters.queueFullForClient++;
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
    return Math.max(5, Math.min(30, Math.ceil(this._opt("parseTimeoutMs") / 1000)));
  }

  /**
   * The wall-clock budget of one file: by kind and size, capped by PARSE_TIMEOUT_MS.
   * A caller that fixes parseTimeoutMs (the tests) gets exactly that.
   */
  _timeoutFor(job) {
    const cap = this._opt("parseTimeoutMs");
    if (this.opts.parseTimeoutMs !== undefined && this.opts.byKind !== true) return cap;
    const ext = String((job.options && job.options.ext) || path.extname(job.filePath || "")).toLowerCase();
    const sizeMb = (job.sizeBytes || (job.buffer ? job.buffer.length : 0)) / (1024 * 1024);
    let ms;
    if (ext === ".dxf") ms = this._opt("parseTimeoutDxfMs");
    else if (ext === ".step" || ext === ".stp" || ext === ".iges" || ext === ".igs") ms = this._opt("parseTimeoutCadBaseMs") + sizeMb * this._opt("parseTimeoutCadPerMbMs");
    else ms = this._opt("parseTimeoutMeshBaseMs") + sizeMb * this._opt("parseTimeoutMeshPerMbMs");
    return Math.max(100, Math.min(cap, Math.round(ms)));
  }

  _queuedFor(client) {
    let n = 0;
    for (const e of this.queue) if (e.client === client) n++;
    return n;
  }

  /** Worker time this client has used in the last hour, including its parse that is running now. */
  _clientUsedMs(client, now = Date.now()) {
    let ms = this.budget.usedMs(client, now);
    for (const e of this.running) if (e.client === client && e.startedAt) ms += now - e.startedAt;
    return ms;
  }

  _isSuspect(client, now = Date.now()) {
    const at = this.suspects.get(client);
    if (at === undefined) return false;
    if (now - at >= this._opt("parseSuspectMinutes") * 60 * 1000) { this.suspects.delete(client); return false; }
    return true;
  }

  _runningFor(client) {
    let n = 0;
    for (const e of this.running) if (e.client === client) n++;
    return n;
  }

  _canStart(entry) {
    const concurrency = this._opt("parseConcurrency");
    if (this.running.size >= concurrency) return false;
    // Each client address has its own lane; callers with no address share one.
    if (this._runningFor(entry.client) >= this._opt("parsePerClient")) return false;
    // A client whose parse was stopped recently does not get the last free worker.
    if (concurrency > 1 && this.running.size >= concurrency - 1 && entry.client && this._isSuspect(entry.client)) return false;
    return true;
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
        if (entry) this._markSuspect(entry.client);
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
    if (entry.client) { this.lastTurn.delete(entry.client); this.lastTurn.set(entry.client, entry.startedAt); if (this.lastTurn.size > 20000) this.lastTurn.clear(); }
    this._watch();

    const timeoutMs = this._timeoutFor(entry.job);
    entry.timer = setTimeout(() => {
      this.counters.timedOut++;
      this._markSuspect(entry.client);
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
    // The time this parse really used is charged to its client, however it ended.
    if (entry.startedAt) this.budget.charge(entry.client, Date.now() - entry.startedAt);
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

  /**
   * Start what can start. Among the waiting jobs, the one whose client has
   * gone longest without a worker goes first (a client that has never had one
   * counts as longest); within one client, first come first served.
   */
  _drain() {
    while (this.running.size < this._opt("parseConcurrency") && this.queue.length) {
      let best = -1;
      let bestTurn = Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i];
        if (!this._canStart(e)) continue;
        const turn = this.lastTurn.get(e.client) || 0;
        if (turn < bestTurn) { bestTurn = turn; best = i; }
      }
      if (best < 0) return;
      const [next] = this.queue.splice(best, 1);
      this._start(next);
    }
  }

  _markSuspect(client) {
    if (!client) return;
    if (this.suspects.size >= 20000) this.suspects.clear();
    this.suspects.set(client, Date.now());
  }

  _cancel(entry) {
    if (entry.settled) return;
    this.counters.cancelled++;
    const i = this.queue.indexOf(entry);
    if (i >= 0) this.queue.splice(i, 1);
    const err = poolError("cancelled", 499, "The upload was cancelled.");
    if (this.running.has(entry)) this._finish(entry, err, undefined, { kill: true }); else this._settle(entry, err);
  }

  /**
   * While anything is running, check the process's memory twice a second. What
   * is limited is the growth since the parsers started work — the memory they
   * added — so the size of the rest of the server (the in-memory database
   * above all) neither eats into the parsers' budget nor hides their use.
   */
  _watch() {
    if (this.watchdog) return;
    const limitMb = this._opt("parseRssLimitMb");
    if (!limitMb) return;
    const rss = () => (this.opts.rssProbe ? this.opts.rssProbe() : process.memoryUsage().rss) / (1024 * 1024);
    const baselineMb = rss();
    this.watchdog = setInterval(() => {
      if (this.running.size === 0) return this._unwatch();
      const rssMb = rss() - baselineMb;
      if (rssMb <= limitMb) return;
      // Warm workers hold memory too: let them go first. Then stop one parse. Memory is not known
      // per worker, so the choice is by who is most likely to be the cause and least likely to be
      // a customer: a client whose parse was already stopped this hour first, then the largest
      // file, then the longest-running.
      for (const slot of [...this.idle]) { slot.dead = true; this._forget(slot); slot.worker.terminate().catch(() => {}); }
      let oldest = null;
      const weight = (e) => [this._isSuspect(e.client) ? 1 : 0, e.job.sizeBytes || (e.job.buffer ? e.job.buffer.length : 0), -e.startedAt];
      for (const e of this.running) {
        if (!oldest) { oldest = e; continue; }
        const a = weight(e), b = weight(oldest);
        if (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]) oldest = e;
      }
      if (!oldest) return;
      this.counters.outOfMemory++;
      this._markSuspect(oldest.client);
      console.warn(`Parse pool: parsing has added ${Math.round(rssMb)} MB to the process, over the ${limitMb} MB ceiling (PARSE_RSS_LIMIT_MB); stopped a parse (${path.extname(oldest.job.filePath || "") || "file"})`);
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

module.exports = { ParsePool, ParseBudget, pool, poolError };
