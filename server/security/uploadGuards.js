/**
 * Guards in front of every route that writes an uploaded file to disk.
 *
 *   storage   a hard ceiling on what the upload folders (and the part-payload
 *             folder derived from uploads) may hold together
 *             (UPLOAD_DIR_MAX_MB). At UPLOAD_DIR_WARN_PERCENT a warning is
 *             logged; at the ceiling new files are refused politely and the
 *             refusal is logged. The retention sweeps bring usage back down.
 *   budget    bytes one client address may send in a rolling 24 hours
 *             (UPLOAD_DAILY_MB_PER_IP), CAD files and drawings together.
 *
 * `admit()` is the middleware: it runs BEFORE multer, judging the request by
 * its Content-Length so a refused upload is never written at all. `account()`
 * records what was really received afterwards.
 *
 * The counters live in memory: they reset when the service restarts, which is
 * acceptable for a single instance (a restart also clears the rate limiters).
 * With more than one instance they would have to move to a shared store.
 */
const fs = require("fs");
const path = require("path");
const { limits } = require("./limits");
const { clientKey } = require("./clientKey");
const brand = require("../../shared/brand.json");

const DAY_MS = 24 * 60 * 60 * 1000;
// QUOTING_DATA_DIR lets the test suites write to a throwaway folder (like QUOTING_DB_PATH for the database).
const DATA_DIR = process.env.QUOTING_DATA_DIR ? path.resolve(process.env.QUOTING_DATA_DIR) : path.join(__dirname, "..", "..", "data");
/** The folders drawings land in (swept for files no quote, order or request refers to). */
const DRAWING_DIRS = ["quote-drawings", "rfq-drawings"].map((d) => path.join(DATA_DIR, d));
/** Where each part's preview mesh and large geometry detail are kept (models/partPayloads.js). */
const PART_PAYLOAD_DIR = path.join(DATA_DIR, "part-payloads");
/** Every folder that holds what the public sends or what is derived from it: together they are held to one ceiling. */
const STORAGE_DIRS = [path.join(DATA_DIR, "uploads"), ...DRAWING_DIRS, PART_PAYLOAD_DIR];

// ─── Storage ceiling ─────────────────────────────────────────

const storage = {
  dirs: STORAGE_DIRS,
  scannedAt: 0,
  bytes: 0,
  lastWarnAt: 0,
  lastRefuseLogAt: 0,
  SCAN_TTL_MS: 30 * 1000,

  /** Bytes on disk under the upload folders (not recursive: they are flat). */
  scan() {
    let total = 0;
    for (const dir of this.dirs) {
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) total += st.size;
        } catch { /* removed while we looked */ }
      }
    }
    this.bytes = total;
    this.scannedAt = Date.now();
    return total;
  },

  /** Current usage: a fresh scan when the last one is stale, otherwise the running count. */
  usage() {
    if (Date.now() - this.scannedAt > this.SCAN_TTL_MS) this.scan();
    return this.bytes;
  },

  /** Count bytes just written without waiting for the next scan. */
  add(bytes) {
    this.bytes += Math.max(0, Number(bytes) || 0);
  },

  /** Forget the cached figure (after a sweep, or in tests). */
  invalidate() {
    this.scannedAt = 0;
  },

  /**
   * Is there room for `incoming` more bytes? Logs once a minute when the
   * answer is no, and once every ten minutes past the warning line.
   */
  hasRoom(incoming = 0) {
    const max = limits.storageMaxBytes;
    const used = this.usage();
    const now = Date.now();
    if (used + incoming > max) {
      if (now - this.lastRefuseLogAt > 60 * 1000) {
        this.lastRefuseLogAt = now;
        console.error(`UPLOAD STORAGE FULL: ${mb(used)} MB of ${mb(max)} MB used in data/uploads, data/quote-drawings, data/rfq-drawings and data/part-payloads — new files are being refused. Raise UPLOAD_DIR_MAX_MB, shorten UPLOAD_RETENTION_HOURS, or clear old files.`);
      }
      return false;
    }
    if (used + incoming > max * limits.storageWarnFraction && now - this.lastWarnAt > 10 * 60 * 1000) {
      this.lastWarnAt = now;
      console.warn(`WARNING: upload storage at ${Math.round((used / max) * 100)}% (${mb(used)} MB of ${mb(max)} MB). New files are refused at 100%.`);
    }
    return true;
  },
};

const mb = (bytes) => Math.round(bytes / (1024 * 1024));

// ─── Database ceiling ────────────────────────────────────────
// sql.js rewrites the whole database file on every write, so the file has a
// ceiling: past DB_MAX_MB new uploads are refused. A part row is small now (its
// preview mesh and large detail are files under data/part-payloads, counted
// against the storage ceiling above), so this is a backstop against rows
// growing some other way; row retention shrinks the file again.
const database = {
  lastWarnAt: 0,
  lastRefuseLogAt: 0,
  size() {
    try { return require("../models/database").fileSize(); } catch { return 0; }
  },
  hasRoom() {
    const max = limits.databaseMaxBytes;
    const used = this.size();
    const now = Date.now();
    if (used > max) {
      if (now - this.lastRefuseLogAt > 60 * 1000) {
        this.lastRefuseLogAt = now;
        console.error(`DATABASE FULL: the database file is ${mb(used)} MB, over the ${mb(max)} MB ceiling (DB_MAX_MB) — new uploads are being refused until row retention brings it down.`);
      }
      return false;
    }
    if (used > max * limits.storageWarnFraction && now - this.lastWarnAt > 10 * 60 * 1000) {
      this.lastWarnAt = now;
      console.warn(`WARNING: database file at ${Math.round((used / max) * 100)}% of its ceiling (${mb(used)} MB of ${mb(max)} MB). New uploads are refused at 100%.`);
    }
    return true;
  },
};

// ─── Per-client daily byte budget ────────────────────────────

const budget = {
  windows: new Map(), // key → { start, bytes }
  MAX_KEYS: 50000,

  _window(key, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || now - w.start >= DAY_MS) {
      w = { start: now, bytes: 0 };
      if (this.windows.size >= this.MAX_KEYS) this.prune(now, true);
      this.windows.set(key, w);
    }
    return w;
  },

  used(key, now = Date.now()) {
    const w = this.windows.get(key);
    return w && now - w.start < DAY_MS ? w.bytes : 0;
  },

  remaining(key, now = Date.now()) {
    return Math.max(0, limits.uploadDailyBytesPerClient - this.used(key, now));
  },

  add(key, bytes, now = Date.now()) {
    this._window(key, now).bytes += Math.max(0, Number(bytes) || 0);
  },

  /** Drop finished windows; when `force`, also drop the oldest tenth so the map cannot grow without bound. */
  prune(now = Date.now(), force = false) {
    for (const [k, w] of this.windows) if (now - w.start >= DAY_MS) this.windows.delete(k);
    if (force && this.windows.size >= this.MAX_KEYS) {
      const oldest = [...this.windows.entries()].sort((a, b) => a[1].start - b[1].start).slice(0, Math.ceil(this.MAX_KEYS / 10));
      for (const [k] of oldest) this.windows.delete(k);
    }
  },

  reset() {
    this.windows.clear();
  },
};

const pruneTimer = setInterval(() => budget.prune(), 60 * 60 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

// ─── Middleware ──────────────────────────────────────────────

const FULL_MESSAGE = `We can't take new files right now. Email them to ${brand.email} or call ${brand.phone} and we'll quote them by hand.`;

/**
 * Refuse an upload before it is written.
 * @param {object} [opt]
 * @param {() => number} [opt.maxRequestBytes] the largest body this route can legitimately receive
 * @param {boolean} [opt.addsRows] the route stores parsed geometry: also hold the database ceiling
 * @param {boolean} [opt.chargeDeclared] count the declared Content-Length against the client's budget now
 */
function admit(opt = {}) {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    const incoming = Number.isFinite(declared) && declared > 0 ? declared : 0;

    const maxRequest = typeof opt.maxRequestBytes === "function" ? opt.maxRequestBytes() : 0;
    if (maxRequest && incoming > maxRequest) {
      // Answer and close: the body is not read.
      res.set("Connection", "close");
      return res.status(413).json({ error: `That upload is too large. Send up to ${mb(maxRequest)} MB at a time.`, code: "request-too-large" });
    }

    if (!storage.hasRoom(incoming) || (opt.addsRows && !database.hasRoom())) {
      res.set("Connection", "close");
      res.set("Retry-After", "3600");
      return res.status(503).json({ error: FULL_MESSAGE, code: "storage-full" });
    }

    const key = clientKey(req);
    const left = budget.remaining(key);
    if (left <= 0 || incoming > left) {
      res.set("Connection", "close");
      return res.status(429).json({
        error: `You've reached today's upload limit from this network (${mb(limits.uploadDailyBytesPerClient)} MB in 24 hours). Email your files to ${brand.email} or call ${brand.phone} and we'll quote them by hand.`,
        code: "daily-upload-limit",
      });
    }
    req.uploadClientKey = key;
    // A route that cannot report back after multer (the RFQ form) is charged what it declared.
    if (opt.chargeDeclared) budget.add(key, incoming);
    next();
  };
}

/** Record what a request really delivered: against the client's budget, and (when kept) against storage. */
function account(req, { received = 0, stored = 0 } = {}) {
  budget.add(req.uploadClientKey || clientKey(req), received);
  storage.add(stored);
}

// ─── File names ──────────────────────────────────────────────

/**
 * The customer's file name as we keep and show it: the last path segment only,
 * no control characters, quotes, angle brackets or path separators, at most
 * 255 characters. It is a label — it is never used as a path on disk.
 */
function safeFileName(name, fallback = "file") {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "") // control and bidi-override characters
    .replace(/["<>|:*?`]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(-255);
  return clean || fallback;
}

module.exports = { storage, database, budget, admit, account, safeFileName, STORAGE_DIRS, DRAWING_DIRS, PART_PAYLOAD_DIR, DATA_DIR, FULL_MESSAGE };
