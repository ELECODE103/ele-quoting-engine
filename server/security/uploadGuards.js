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
   * `opt.reserved: false` asks on behalf of a visitor without a confirmed
   * account: their share ends UPLOAD_DIR_RESERVED_PERCENT short of the ceiling,
   * so that a flood of anonymous uploads cannot close the door on customers.
   */
  hasRoom(incoming = 0, opt = {}) {
    const full = limits.storageMaxBytes;
    const max = opt.reserved === false ? full * (1 - limits.storageReservedFraction) : full;
    const used = this.usage();
    const now = Date.now();
    if (used + incoming > max) {
      if (now - this.lastRefuseLogAt > 60 * 1000) {
        this.lastRefuseLogAt = now;
        console.error(opt.reserved === false && used + incoming <= full
          ? `UPLOAD STORAGE NEARLY FULL: ${mb(used)} MB of ${mb(full)} MB used — new files from visitors without a confirmed account are being refused (the rest is kept for customers). Old uploads nothing refers to are being cleared automatically; raise UPLOAD_DIR_MAX_MB if this keeps happening.`
          : `UPLOAD STORAGE FULL: ${mb(used)} MB of ${mb(full)} MB used in data/uploads, data/quote-drawings, data/rfq-drawings and data/part-payloads — new files are being refused. Raise UPLOAD_DIR_MAX_MB, shorten UPLOAD_RETENTION_HOURS, or clear old files.`);
      }
      return false;
    }
    if (used + incoming > full * limits.storageWarnFraction && now - this.lastWarnAt > 10 * 60 * 1000) {
      this.lastWarnAt = now;
      console.warn(`WARNING: upload storage at ${Math.round((used / full) * 100)}% (${mb(used)} MB of ${mb(full)} MB). Old uploads nothing refers to are cleared automatically from here; new files from visitors without an account are refused at ${Math.round((1 - limits.storageReservedFraction) * 100)}%, everyone's at 100%.`);
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
  /**
   * Room for a new row? `opt.reserved: false` asks for a visitor without a
   * confirmed account, whose share ends DB_RESERVED_PERCENT short of the ceiling.
   */
  hasRoom(opt = {}) {
    const full = limits.databaseMaxBytes;
    const max = opt.reserved === false ? full * (1 - limits.dbReservedFraction) : full;
    const used = this.size();
    const now = Date.now();
    if (used > max) {
      if (now - this.lastRefuseLogAt > 60 * 1000) {
        this.lastRefuseLogAt = now;
        console.error(opt.reserved === false && used <= full
          ? `DATABASE NEARLY FULL: the database file is ${mb(used)} MB of ${mb(full)} MB (DB_MAX_MB) — new quotes and uploads from visitors without a confirmed account are being refused; customers are not affected. Old no-account drafts are being cleared automatically.`
          : `DATABASE FULL: the database file is ${mb(used)} MB, over the ${mb(full)} MB ceiling (DB_MAX_MB) — new quotes and uploads are being refused. Checkout, sign-in and orders are not affected. Clear old drafts in the admin panel or raise DB_MAX_MB.`);
      }
      return false;
    }
    if (used > full * limits.dbSweepFraction && now - this.lastWarnAt > 10 * 60 * 1000) {
      this.lastWarnAt = now;
      console.warn(`WARNING: database file at ${Math.round((used / full) * 100)}% of its ceiling (${mb(used)} MB of ${mb(full)} MB). Old no-account drafts are cleared automatically from here; new ones are refused at ${Math.round((1 - limits.dbReservedFraction) * 100)}%.`);
    }
    return true;
  },
  /**
   * The question a route asks before it adds a row for this user (or visitor).
   * @returns {{ ok: boolean, reserved: boolean }} reserved: the refusal is the anonymous share
   *          (a confirmed customer would still get through)
   */
  roomFor(user) {
    const confirmed = isConfirmedCustomer(user);
    if (this.hasRoom({ reserved: confirmed })) return { ok: true, reserved: false };
    return { ok: false, reserved: !confirmed && this.size() <= limits.databaseMaxBytes };
  },
};

/** A signed-in account whose email is confirmed (or an admin): the people the reserved share is kept for. */
function isConfirmedCustomer(user) {
  return Boolean(user && (user.emailVerified || user.role === "admin"));
}

/**
 * A stable tag for a client key: what a stored part or request carries so the
 * bytes one client has on the volume can be added up. A keyed hash — the
 * address itself is not written to the database.
 */
function clientTag(key) {
  if (!key) return "";
  return require("./keys").mac("client-tag-v1", String(key)).slice(0, 24);
}

/** Bytes this client has stored right now: CAD files and what was derived from them, and request attachments. */
function storedBytesFor(key) {
  const tag = clientTag(key);
  if (!tag) return 0;
  try {
    const models = require("../models");
    let total = models.partsDB.storedBytesFor(tag);
    for (const r of models.rfqsDB.query((x) => x.clientTag === tag && x.drawingPath)) total += Number(r.drawingBytes) || 0;
    return total;
  } catch { return 0; }
}

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
const FULL_ANONYMOUS_MESSAGE = `We can't take new files from visitors without an account right now. Sign in (or create an account and confirm your email) and upload again, or email the files to ${brand.email} and we'll quote them by hand.`;
const NOT_READ_MESSAGE = "We stopped reading this upload because another file in it could not be read in time. Upload this file by itself and it will be read.";
const storedLimitMessage = () => `You've reached what we keep for one network at a time (${mb(limits.uploadStoredBytesPerClient)} MB of files). Files that are not on an order or a saved quote are cleared after a few days. Email your files to ${brand.email} or call ${brand.phone} and we'll quote them by hand.`;
const dailyLimitMessage = () => `You've reached today's upload limit from this network (${mb(limits.uploadDailyBytesPerClient)} MB in 24 hours). Email your files to ${brand.email} or call ${brand.phone} and we'll quote them by hand.`;

/**
 * Refuse an upload before it is written, and count what it really sends.
 * @param {object} [opt]
 * @param {() => number} [opt.maxRequestBytes] the largest body this route can legitimately receive
 * @param {boolean} [opt.addsRows] the route stores parsed geometry: also hold the database ceiling
 * @param {boolean} [opt.chargeDeclared] kept for callers; the bytes actually received are what is charged now
 *
 * Counting (independent review 2026-11-11, L1): the client's daily budget is
 * charged with the bytes the server actually READ for this request, whatever
 * became of them — kept, refused by a content check, over the size limit, or
 * cut off. It used to be charged from the Content-Length header on one route,
 * so an upload sent without one (chunked) was free, and an over-size file was
 * never charged anywhere. A body with no Content-Length is also watched while
 * it arrives and cut off when it passes the route's maximum or what is left of
 * the client's budget.
 */
const DISCARD_MS = 5000;
const DISCARD_BYTES = 64 * 1024 * 1024;

/**
 * Close the connection of a refused upload without cutting the answer off.
 *
 * The answer says "Connection: close". Closing at once while the client is
 * still sending makes the network reset the connection, and a browser then
 * shows a network error instead of our message. So: our side is finished (the
 * client sees the answer and the end of our half), what is still arriving is
 * read and thrown away for at most DISCARD_MS and DISCARD_BYTES, and then the
 * connection is closed for good. Nothing is written to disk and nothing is
 * parsed. If this runtime closes the connection some other way, the old
 * behaviour (an immediate close) is what happens.
 */
function lingerThenClose(req) {
  const socket = req && req.socket;
  if (!socket || typeof req.on !== "function" || typeof req.resume !== "function" || typeof socket.destroySoon !== "function") return;
  let seen = 0;
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    try { if (!socket.destroyed) socket.destroy(); } catch { /* already gone */ }
  };
  // The server ends a "Connection: close" answer with socket.destroySoon(): finish our half only.
  socket.destroySoon = function finishOurHalf() { try { this.end(); } catch { close(); } };
  timer = setTimeout(close, DISCARD_MS);
  if (timer.unref) timer.unref();
  req.on("data", (chunk) => { seen += chunk.length; if (seen > DISCARD_BYTES) close(); });
  // The whole body has come: the answer is on its way out and our half is being finished. Give the
  // client a moment to finish its own, then close whatever is left.
  req.on("end", () => { clearTimeout(timer); timer = setTimeout(close, 1000); if (timer.unref) timer.unref(); });
  req.on("error", close);
  req.on("close", () => clearTimeout(timer));
  req.resume();
}

function admit(opt = {}) {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    const hasLength = Number.isFinite(declared) && declared >= 0 && req.headers["content-length"] !== undefined;
    const incoming = hasLength && declared > 0 ? declared : 0;

    const refuse = (status, body, headers = {}) => {
      // Answer and close: nothing of the body is kept (see lingerThenClose for how the close is done).
      res.set("Connection", "close");
      for (const [k, v] of Object.entries(headers)) res.set(k, v);
      lingerThenClose(req);
      return res.status(status).json(body);
    };

    const maxRequest = typeof opt.maxRequestBytes === "function" ? opt.maxRequestBytes() : 0;
    if (maxRequest && incoming > maxRequest) {
      return refuse(413, { error: `That upload is too large. Send up to ${mb(maxRequest)} MB at a time.`, code: "request-too-large" });
    }

    // Who is asking: the last share of both ceilings is kept for customers with a confirmed email.
    if (req.user === undefined) { try { require("./session").optionalAuth(req, res, () => {}); } catch { /* a guest */ } }
    const confirmed = isConfirmedCustomer(req.user);

    if (!storage.hasRoom(incoming, { reserved: confirmed }) || (opt.addsRows && !database.hasRoom({ reserved: confirmed }))) {
      // Over a line: let the sweeps run now rather than at their next turn.
      try { require("../services/storagePressure").nudge(require("../models")); } catch { /* best effort */ }
      const anonymousOnly = !confirmed && storage.hasRoom(incoming) && (!opt.addsRows || database.hasRoom());
      return refuse(503, { error: anonymousOnly ? FULL_ANONYMOUS_MESSAGE : FULL_MESSAGE, code: anonymousOnly ? "uploads-paused" : "storage-full" }, { "Retry-After": anonymousOnly ? "900" : "3600" });
    }

    const key = clientKey(req);
    const left = budget.remaining(key);
    if (left <= 0 || incoming > left) {
      return refuse(429, { error: dailyLimitMessage(), code: "daily-upload-limit" });
    }
    // What this client already has on the volume, plus this upload.
    if (storedBytesFor(key) + incoming > limits.uploadStoredBytesPerClient) {
      return refuse(429, { error: storedLimitMessage(), code: "stored-limit" });
    }
    req.uploadClientKey = key;

    // ── Count what really arrives ──
    // What the request declares is charged at the door (so a burst of parallel uploads cannot all be
    // admitted against the same remaining budget). What it actually sends is counted where the bytes
    // enter the request — each body chunk the HTTP parser hands over — so nothing depends on a header
    // or a timer: body bytes that arrived before this middleware ran are waiting in the request's own
    // buffer (nothing has read it yet), and every later chunk passes through push() below.
    const buffered = Number(req.readableLength) || 0;
    let arrived = 0;
    const received = () => buffered + arrived;
    let chargedBytes = 0;
    const chargeUpTo = (bytes) => { if (bytes > chargedBytes) { budget.add(key, bytes - chargedBytes); chargedBytes = bytes; } };
    chargeUpTo(incoming);
    let ended = false;
    let cut = false;
    const end = () => {
      if (ended) return;
      ended = true;
      chargeUpTo(received());
    };
    req.uploadMeter = { received, charged: () => chargedBytes };
    if (typeof res.on === "function") { res.on("finish", end); res.on("close", end); }

    // A body with no Content-Length (chunked) could not be judged up front, so it is judged, and
    // charged, as it arrives: past the route's maximum, the client's daily budget or its stored-bytes
    // cap, the request is answered and cut off. (With a Content-Length the body cannot exceed what was
    // declared, and that was checked above.)
    const storedLeft = hasLength ? Infinity : Math.max(0, limits.uploadStoredBytesPerClient - storedBytesFor(key));
    const stop = () => {
      cut = true;
      const got = received();
      const overRoute = Boolean(maxRequest) && got > maxRequest;
      if (!res.headersSent) {
        res.set("Connection", "close");
        res.status(overRoute ? 413 : 429).json(overRoute
          ? { error: `That upload is too large. Send up to ${mb(maxRequest)} MB at a time.`, code: "request-too-large" }
          : (got > storedLeft ? { error: storedLimitMessage(), code: "stored-limit" } : { error: dailyLimitMessage(), code: "daily-upload-limit" }));
      }
      // This request has its answer. The upload handler is still running and will try to answer too
      // when its stream ends: from here on, setting a header on this response does nothing instead of
      // throwing (an exception in that callback would stop the whole process).
      res.setHeader = function alreadyAnswered() { return this; };
      // Stop reading once the answer has had a moment to leave. Whatever the upload handler had
      // written so far is removed by its own handling of an aborted request.
      const t = setTimeout(() => { try { req.destroy(); } catch { /* already gone */ } }, 150);
      if (t.unref) t.unref();
    };
    if (typeof req.push === "function") {
      const push = req.push;
      req.push = function meteredPush(chunk, encoding) {
        if (chunk && chunk.length && !ended) {
          arrived += chunk.length;
          if (!hasLength) {
            if (cut) return false; // already refused: the rest is dropped, not handed on
            chargeUpTo(received());
            const got = received();
            if ((maxRequest && got > maxRequest) || budget.remaining(key) <= 0 || got > storedLeft) { stop(); return false; }
          }
        }
        return push.call(this, chunk, encoding);
      };
    }
    next();
  };
}

/**
 * Record what a request kept (against storage). What it RECEIVED is counted by
 * admit() from the connection itself; `received` here is only used for a
 * request that did not pass through admit().
 */
function account(req, { received = 0, stored = 0 } = {}) {
  if (!req.uploadMeter) budget.add(req.uploadClientKey || clientKey(req), received);
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

module.exports = { storage, database, budget, admit, account, lingerThenClose, safeFileName, clientTag, storedBytesFor, isConfirmedCustomer, STORAGE_DIRS, DRAWING_DIRS, PART_PAYLOAD_DIR, DATA_DIR, FULL_MESSAGE, FULL_ANONYMOUS_MESSAGE, NOT_READ_MESSAGE };
