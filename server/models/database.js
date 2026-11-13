/**
 * SQLite database initialization and setup using sql.js (pure JS, no native deps).
 * Creates and initializes all tables on first run.
 * Persists to disk via manual save after writes.
 */
const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

// QUOTING_DB_PATH lets the test suites run against a throwaway database.
const DB_PATH = process.env.QUOTING_DB_PATH || path.join(__dirname, "..", "..", "data", "quoting.db");

function ensureDataDir() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    name TEXT,
    company TEXT,
    phone TEXT,
    role TEXT DEFAULT 'customer',
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    quote_id TEXT,
    status TEXT DEFAULT 'received',
    shipping_name TEXT,
    shipping_address TEXT,
    shipping_city TEXT,
    shipping_state TEXT,
    shipping_zip TEXT,
    shipping_country TEXT DEFAULT 'US',
    shipping_method TEXT,
    shipping_cost REAL DEFAULT 0,
    subtotal REAL,
    tax REAL DEFAULT 0,
    total REAL,
    stripe_payment_id TEXT,
    stripe_session_id TEXT,
    tracking_number TEXT,
    carrier TEXT,
    shipped_at TEXT,
    notes TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    part_id TEXT,
    file_name TEXT,
    process TEXT,
    material_slug TEXT,
    material_name TEXT,
    finish_slug TEXT,
    finish_name TEXT,
    quantity INTEGER DEFAULT 1,
    unit_price REAL,
    line_total REAL,
    thickness_mm REAL,
    sub_process TEXT,
    layer_height REAL,
    infill REAL,
    geometry_json TEXT,
    dfm_json TEXT,
    config_json TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    category TEXT,
    process TEXT,
    sub_process TEXT,
    density REAL,
    cost_per_kg REAL,
    price_per_kg REAL,
    price_per_cm3 REAL,
    machinability REAL,
    default_layer_height REAL,
    color TEXT,
    grades_json TEXT,
    thicknesses_json TEXT,
    layer_heights_json TEXT,
    feed_class TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS finishes (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    process TEXT,
    price_per_part REAL,
    price_per_sq_in REAL,
    cost_per_dm2 REAL,
    min_cost REAL,
    lead_days INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS lead_times (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    days TEXT,
    days_min INTEGER,
    days_max INTEGER,
    multiplier REAL,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pricing_rules (
    id TEXT PRIMARY KEY,
    rules_json TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    line_items_json TEXT,
    subtotal REAL,
    lead_time_slug TEXT,
    lead_time_multiplier REAL,
    order_total REAL,
    status TEXT DEFAULT 'draft',
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    file_name TEXT,
    stored_name TEXT,
    file_path TEXT,
    file_size INTEGER,
    geometry_json TEXT,
    dfm_json TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS processes (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    sub_processes_json TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pricing_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_email TEXT,
    action TEXT DEFAULT 'save',
    note TEXT,
    diff_json TEXT,
    rules_json TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS rfqs (
    id TEXT PRIMARY KEY,
    quote_id TEXT,
    user_id TEXT,
    status TEXT DEFAULT 'new',
    contact_name TEXT,
    email TEXT,
    company TEXT,
    phone TEXT,
    process TEXT,
    quantities TEXT,
    tolerance TEXT,
    finish_notes TEXT,
    due_date TEXT,
    notes TEXT,
    drawing_file_name TEXT,
    drawing_path TEXT,
    budget_total REAL,
    reasons_json TEXT,
    parts_json TEXT,
    quoted_at TEXT,
    quoted_total REAL,
    created_at TEXT,
    updated_at TEXT
  );

  -- Sessions ended before their token expired (sign-out). A row lives until
  -- the token it names would have expired anyway.
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    expires_at TEXT,
    created_at TEXT
  );
`;

// Singleton
let dbInstance = null;
let payloadMigration = null; // what the part-payload migration did at this start (for the log and the tests)
let SQL = null;

/**
 * Initialize sql.js and open/create the database synchronously-ish.
 * We use a ready promise so consumers can await it.
 */
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });

// Why the database could not be opened, when it could not (independent re-review 2026-11-12, F-04).
// A file that EXISTS and cannot be used is never replaced: until 2026-11-13 a zero-length file (a
// volume that came up empty) was opened as a new, empty database and written over, and a file that
// was not a database left the server "healthy" with every request failing. Now nothing is opened,
// nothing is written, and server/index.js stops the start with this reason in one line.
let openFailure = null;   // { reason, bytes }
let createdNew = false;   // no file was there: a new, empty database was made (a first start)

/** Why these bytes cannot be used as the database, or "" when they can. Opens them; never writes. */
function unusableReason(SQLlib, buffer) {
  if (!buffer || buffer.length === 0) return "the file is empty (0 bytes)";
  if (buffer.length < 100 || buffer.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") return "the file is not a SQLite database";
  let probe = null;
  try {
    probe = new SQLlib.Database(buffer);
    const res = probe.exec("PRAGMA integrity_check");
    const verdict = res && res[0] && res[0].values ? res[0].values.map((v) => String(v[0])) : [];
    if (verdict.length !== 1 || verdict[0] !== "ok") return `SQLite's integrity check failed (${(verdict[0] || "no answer").slice(0, 120)})`;
    return "";
  } catch (err) {
    return `SQLite cannot read it (${String((err && err.message) || err).slice(0, 120)})`;
  } finally {
    if (probe) { try { probe.close(); } catch (_) { /* nothing to close */ } }
  }
}

(async function init() {
  try {
    SQL = await initSqlJs();
    ensureDataDir();

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      const reason = unusableReason(SQL, buffer);
      if (reason) {
        openFailure = { reason, bytes: buffer.length };
        readyResolve();
        return; // dbInstance stays null: every save is a no-op, so the file is left exactly as it is
      }
      dbInstance = new SQL.Database(buffer);
    } else {
      dbInstance = new SQL.Database();
      createdNew = true;
    }

    // Run schema
    dbInstance.run(SCHEMA);

    // Migrate: add columns that may be missing on existing databases
    const migrations = [
      'ALTER TABLE materials ADD COLUMN category TEXT',
      'ALTER TABLE materials ADD COLUMN price_per_kg REAL',
      'ALTER TABLE materials ADD COLUMN price_per_cm3 REAL',
      'ALTER TABLE materials ADD COLUMN machinability REAL',
      'ALTER TABLE materials ADD COLUMN default_layer_height REAL',
      'ALTER TABLE materials ADD COLUMN color TEXT',
      'ALTER TABLE materials ADD COLUMN layer_heights_json TEXT',
      'ALTER TABLE finishes ADD COLUMN price_per_part REAL',
      'ALTER TABLE finishes ADD COLUMN price_per_sq_in REAL',
      'ALTER TABLE lead_times ADD COLUMN days TEXT',
      'ALTER TABLE orders ADD COLUMN carrier TEXT',
      'ALTER TABLE orders ADD COLUMN shipped_at TEXT',
      // Normalized per-item process config (thickness, sub-process, layer height,
      // infill, grade, …) as one JSON blob, so new processes don't need new columns.
      'ALTER TABLE order_items ADD COLUMN config_json TEXT',
      // Checkout-vs-RFQ decision stored with the quote so checkout can enforce it.
      'ALTER TABLE quotes ADD COLUMN gate_json TEXT',
      // Routing: cut-feed class per sheet material (soft / medium / brittle / abrasive / aluminum)
      'ALTER TABLE materials ADD COLUMN feed_class TEXT',
      // Admin materials editor: free-text note shown with the material.
      'ALTER TABLE materials ADD COLUMN description TEXT',
      // Calibration: what the job actually took, entered by the owner per order line
      // (machine minutes per piece, excluding setup) so the engine's time model can
      // be compared with the shop floor.
      'ALTER TABLE order_items ADD COLUMN actual_minutes REAL',
      'ALTER TABLE order_items ADD COLUMN actual_notes TEXT',
      'ALTER TABLE order_items ADD COLUMN actual_recorded_at TEXT',
      // Checkout funnel: one quote row per session (the builder's input config is
      // kept so the quote can be reopened or reordered), a 30-day price hold, and
      // the totals the checkout page shows.
      'ALTER TABLE quotes ADD COLUMN config_json TEXT',
      'ALTER TABLE quotes ADD COLUMN expires_at TEXT',
      'ALTER TABLE quotes ADD COLUMN lead_time_surcharge REAL',
      'ALTER TABLE quotes ADD COLUMN shipping_estimate REAL',
      'ALTER TABLE quotes ADD COLUMN notes TEXT',
      'ALTER TABLE quotes ADD COLUMN drawing_file_name TEXT',
      'ALTER TABLE quotes ADD COLUMN drawing_path TEXT',
      // Orders: who to email, promised ship date, how it is being paid.
      'ALTER TABLE orders ADD COLUMN customer_email TEXT',
      'ALTER TABLE orders ADD COLUMN customer_name TEXT',
      'ALTER TABLE orders ADD COLUMN lead_time_slug TEXT',
      'ALTER TABLE orders ADD COLUMN lead_time_name TEXT',
      'ALTER TABLE orders ADD COLUMN lead_days INTEGER',
      'ALTER TABLE orders ADD COLUMN ship_by TEXT',
      'ALTER TABLE orders ADD COLUMN paid_at TEXT',
      'ALTER TABLE orders ADD COLUMN payment_method TEXT',
      'ALTER TABLE orders ADD COLUMN po_number TEXT',
      'ALTER TABLE orders ADD COLUMN rfq_id TEXT',
      'ALTER TABLE orders ADD COLUMN customer_notes TEXT',
      'ALTER TABLE orders ADD COLUMN drawing_file_name TEXT',
      'ALTER TABLE orders ADD COLUMN drawing_path TEXT',
      // What the total is made of besides the parts (shipping is in shipping_cost).
      'ALTER TABLE orders ADD COLUMN lead_time_surcharge REAL',
      // RFQs: the firm quote sent to the customer and what they did with it.
      'ALTER TABLE rfqs ADD COLUMN quoted_lead_days INTEGER',
      'ALTER TABLE rfqs ADD COLUMN quote_note TEXT',
      'ALTER TABLE rfqs ADD COLUMN valid_until TEXT',
      'ALTER TABLE rfqs ADD COLUMN quote_sent_at TEXT',
      'ALTER TABLE rfqs ADD COLUMN accepted_at TEXT',
      'ALTER TABLE rfqs ADD COLUMN accepted_via TEXT',
      'ALTER TABLE rfqs ADD COLUMN po_number TEXT',
      'ALTER TABLE rfqs ADD COLUMN order_id TEXT',
      // Inspection paperwork as an option the customer asks for (owner, 2026-11-11):
      // a first-article report per part number and a certificate of conformance
      // per order, with the fee as its own line on the quote and on the order.
      'ALTER TABLE quotes ADD COLUMN paperwork INTEGER DEFAULT 0',
      'ALTER TABLE quotes ADD COLUMN paperwork_fee REAL DEFAULT 0',
      'ALTER TABLE orders ADD COLUMN paperwork INTEGER DEFAULT 0',
      'ALTER TABLE orders ADD COLUMN paperwork_fee REAL DEFAULT 0',
      // Firm-quote requests: the same paperwork checkbox (the owner prices it in),
      // whether the request is a worn part being shipped in, and whether the
      // customer wants that part back with the order (return shipping is priced in).
      'ALTER TABLE rfqs ADD COLUMN paperwork INTEGER DEFAULT 0',
      'ALTER TABLE rfqs ADD COLUMN request_type TEXT',
      'ALTER TABLE rfqs ADD COLUMN return_part INTEGER DEFAULT 0',
      // Orders taken from a firm quote for a shipped-in part: the original goes back in the box.
      'ALTER TABLE orders ADD COLUMN return_part INTEGER DEFAULT 0',
      // Availability fixes (2026-11-11). All additive.
      // Quotes: when a draft was last reopened (a no-account draft nobody reopens lapses in 48 hours),
      // and the line and piece counts, so the admin list does not have to load every quote's lines.
      'ALTER TABLE quotes ADD COLUMN last_opened_at TEXT',
      'ALTER TABLE quotes ADD COLUMN part_count INTEGER',
      'ALTER TABLE quotes ADD COLUMN total_units INTEGER',
      // Parts and requests: which client the stored bytes belong to (a keyed hash of the client key,
      // never the address itself), for the cap on bytes stored per client.
      'ALTER TABLE parts ADD COLUMN client_tag TEXT',
      'ALTER TABLE rfqs ADD COLUMN client_tag TEXT',
      'ALTER TABLE rfqs ADD COLUMN drawing_bytes INTEGER',
      // Requests: when the attachment of a closed request was deleted.
      'ALTER TABLE rfqs ADD COLUMN attachment_removed_at TEXT',
      // Availability fixes, round 2 (2026-11-12). All additive.
      // Quotes: which client made the draft (the same keyed hash as on parts) and which parts it names,
      // so "how many bytes of drafts does this sender hold" and "what refers to this part" are one
      // SQL query each instead of reading and parsing every quote.
      'ALTER TABLE quotes ADD COLUMN client_tag TEXT',
      'ALTER TABLE quotes ADD COLUMN part_ids TEXT',
      // Parts: the account that uploaded it, when signed in (bytes are capped per account too).
      'ALTER TABLE parts ADD COLUMN owner_id TEXT',
    ];
    for (const sql of migrations) {
      try { dbInstance.run(sql); } catch (e) { /* column already exists */ }
    }

    // Account hardening (2026-11-11). Additive columns; see ./accountMigration.js.
    require("./accountMigration").apply(dbInstance);
    // Review fixes (2026-11-11): who uploaded a part; the used admin setup code. See ./integrityMigration.js.
    require("./integrityMigration").apply(dbInstance);
    // Order lifecycle (2026-11-11): payment sessions and events, refunds, disputes, expiry. Additive; see ./orderLifecycleMigration.js.
    require("./orderLifecycleMigration").apply(dbInstance);
    // The admin change log: one table for both of the above (2026-11-12 merge). See ./auditMigration.js.
    require("./auditMigration").apply(dbInstance);
    // Shipping method, carrier account, tax and exemption fields (2026-11-11). Additive; see ./taxShippingMigration.js.
    require("./taxShippingMigration").apply(dbInstance);
    // Re-review fixes (2026-11-13): a part's revision number, and indexes for the order routes. Additive; see ./rereviewMigration.js.
    require("./rereviewMigration").apply(dbInstance);

    // Part payloads (2026-11-11): preview meshes and large geometry detail move out of the rows into
    // files under data/part-payloads. One batch in memory, VACUUM, then the single save below.
    const bytesBefore = fileSize();
    const moved = require("./partPayloadMigration").apply(dbInstance);

    saveToDisk();
    if (moved.vacuumed) console.log(`  Database file: ${(bytesBefore / 1e6).toFixed(1)} MB → ${(fileSize() / 1e6).toFixed(1)} MB after moving part payloads out.`);
    payloadMigration = moved;
    readyResolve();
  } catch (err) {
    console.error("Failed to initialize SQLite:", err);
    // Not usable: the start stops on it (server/index.js), and nothing more is written through a
    // database whose schema or migrations did not finish.
    openFailure = { reason: `it could not be opened or brought up to date (${String((err && err.message) || err).slice(0, 160)})`, bytes: null };
    dbInstance = null;
    readyResolve(); // resolve so whoever waits can see the failure
  }
})();

/** null when the database is open; otherwise why it is not: { reason, path }. */
function openError() {
  if (dbInstance && !openFailure) return null;
  return { reason: openFailure ? openFailure.reason : "it has not been opened", path: DB_PATH, bytes: openFailure ? openFailure.bytes : null };
}
/** Is the database open and answering? (the health check asks) */
function isUsable() {
  if (!dbInstance || openFailure) return false;
  try { dbInstance.exec("SELECT 1"); return true; } catch (_) { return false; }
}
/** True when this start found no database file and made a new, empty one. */
function wasCreated() { return createdNew; }

// Every write exports the whole database and rewrites the file, so a burst of
// writes (seeding, a sweep) is grouped: inside batch() saves are held back and
// one save happens when the outermost batch ends.
let batchDepth = 0;
let dirty = false;

// Writes that may wait a moment (see deferred() below).
let deferDepth = 0;
let deferTimer = null;
const DEFER_MS = Math.max(50, Math.min(10000, Number(process.env.DB_DRAFT_FLUSH_MS) || 1500));

function saveToDisk() {
  if (!dbInstance) return;
  if (batchDepth > 0) { dirty = true; return; }
  if (deferDepth > 0 && !stopping) {
    // Marked "may wait": one save for everything that arrives in the next moment.
    dirty = true;
    if (!deferTimer) {
      deferTimer = setTimeout(() => { deferTimer = null; if (dirty) saveToDisk(); }, DEFER_MS);
      if (deferTimer.unref) deferTimer.unref();
    }
    return;
  }
  if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
  const buffer = Buffer.from(dbInstance.export());
  writeDurably(DB_PATH, buffer);
  dirty = false;
}

/**
 * A promise that settles when everything that is in the database NOW is in the file. If nothing is
 * waiting to be written it resolves at once; otherwise the file is written on the next turn of the
 * event loop (unless another write has taken it there first), and the promise resolves after that,
 * or rejects if the write fails.
 *
 * For a change made with transaction(fn, { save: "soon" }): the change is committed in memory in one
 * step and written in the next, so the two halves (working the change out, and rewriting the whole
 * file) do not hold the thread back to back. NOTHING may be acknowledged, to a customer or to
 * Stripe, before this promise has resolved.
 */
let saveWaiters = [];
let soonTimer = null;
function whenSaved() {
  if (!dbInstance || !dirty) return Promise.resolve();
  return new Promise((resolve, reject) => {
    saveWaiters.push({ resolve, reject });
    if (soonTimer) return;
    soonTimer = setImmediate(() => {
      soonTimer = null;
      const waiting = saveWaiters;
      saveWaiters = [];
      // Still waiting for the file: write it now, whatever is marked "may wait". (If another write has
      // saved since, `dirty` is false and everything these callers wrote went to the file with it.)
      if (dirty) {
        const depth = deferDepth;
        deferDepth = 0;
        try { saveToDisk(); } catch (err) { for (const w of waiting) w.reject(err); return; } finally { deferDepth = depth; }
      }
      for (const w of waiting) w.resolve();
    });
  });
}

/**
 * Replace `file` with `buffer` so that neither a crash of this process nor a loss of power can
 * leave a short, empty or half-written database:
 *
 *   1. write the bytes to a temporary file beside it        (a crash here leaves the old file whole)
 *   2. fsync the temporary file                             (its bytes are on the disk, not in a cache)
 *   3. rename it over the database                          (atomic: readers see the old file or the new)
 *   4. fsync the folder                                     (the rename itself is on the disk)
 *
 * Steps 2 and 4 were missing until 2026-11-12: the rename was atomic but nothing was flushed, so a
 * host crash at the wrong moment could leave the NEW name pointing at bytes that were never written.
 * Measured cost of the two flushes per save on the build machine (ext4, under load): about 16 ms at
 * 5 MB and 94 ms at 50 MB on top of the write itself (docs/security/relaunch-integration-2026-11-12.md).
 *
 * A file system that cannot flush a folder (Windows, some network mounts) is not an error: the
 * file's own flush still happened. A flush of the FILE that fails is an error and is thrown — the
 * old database is left in place rather than replaced by one that may not be on the disk.
 */
const FOLDER_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "ENOSYS", "EBADF"]);
function writeDurably(file, buffer) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    let written = 0;
    while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written, written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  let dir = null;
  try {
    dir = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(dir);
  } catch (err) {
    if (!FOLDER_FSYNC_UNSUPPORTED.has(err && err.code)) throw err;
  } finally {
    if (dir !== null) { try { fs.closeSync(dir); } catch (_) { /* nothing to do */ } }
  }
}

/** Run `fn` with saves held back; write once at the end (even if `fn` throws). */
function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && dirty) saveToDisk();
  }
}

/**
 * Run `fn` as ONE change to the database: all of its writes reach the file together, in one
 * atomic replacement of the file, or none of them does (independent re-review 2026-11-12, F-02 and
 * F-08).
 *
 * Before this an order was written as one save for the order row, one per line, one per part
 * claimed and one for its quote, and each save rewrote the whole file. A process killed between two
 * of them left an order with some of its lines on the disk, which the buyer then paid for in full;
 * and a 100-line checkout was more than a hundred whole-file saves in one uninterrupted step
 * (4.2 s at 12 MB).
 *
 *   - Inside `fn` nothing is written to the file (the same holding-back as batch()).
 *   - `fn` runs inside a SQLite transaction. If it throws, the transaction is rolled back, so the
 *     database in memory is exactly what it was before, the error is passed on, and nothing of the
 *     half-done change is ever saved.
 *   - A write that fails inside `fn` THROWS (models/SqliteDB.js normally logs a failed statement
 *     and carries on, which inside a transaction would commit a change with a hole in it).
 *   - When `fn` returns, the transaction is committed and the file is written once
 *     (writeDurably: temporary file, flush, rename, flush). A kill before the rename leaves the old
 *     file whole; a kill after it leaves the new one whole.
 *
 * `fn` must be synchronous. A transaction inside a transaction is part of the outer one.
 *
 * `{ save: "soon" }`: commit in memory now and write the file on the next turn of the event loop
 * (see whenSaved()). All or nothing still holds: the file is replaced whole, with the whole change in
 * it or without any of it. The caller must await whenSaved() before it acknowledges anything.
 */
let transactionDepth = 0;
function transaction(fn, { save = "now" } = {}) {
  if (!dbInstance) throw new Error("database: not open");
  if (transactionDepth > 0) return fn();
  dbInstance.run("BEGIN");
  transactionDepth++;
  batchDepth++;
  let committed = false;
  try {
    const out = fn();
    if (out && typeof out.then === "function") throw new Error("database.transaction: the function must be synchronous");
    dbInstance.run("COMMIT");
    committed = true;
    dirty = true;
    return out;
  } catch (err) {
    if (!committed) { try { dbInstance.run("ROLLBACK"); } catch (_) { /* nothing was open to roll back */ } }
    throw err;
  } finally {
    transactionDepth--;
    batchDepth--;
    // Written at once, whatever is waiting (a transaction is never a "may wait" write) — or, with
    // { save: "soon" }, on the next turn of the event loop: the caller then awaits whenSaved() and
    // acknowledges nothing before it resolves.
    if (batchDepth === 0 && committed && save !== "soon") {
      const depth = deferDepth;
      deferDepth = 0;
      try { saveToDisk(); } finally { deferDepth = depth; }
    }
  }
}

/** Is a transaction() in progress? (models/SqliteDB.js: a failed write then throws.) */
function inTransaction() {
  return transactionDepth > 0;
}

/**
 * Run `fn` with its saves allowed to wait up to DB_DRAFT_FLUSH_MS (1.5 s): the change is in the
 * database at once (every read sees it), and reaches the file with the next save or when the
 * timer fires, whichever is first. For writes that are cheap to lose and frequent — re-pricing a
 * draft quote, which the quote tool does on every change. A crash in that moment loses at most the
 * last re-price, which the browser sends again. Anything else (an order, an account, a payment)
 * saves at once as before, and takes the waiting changes to disk with it.
 */
function deferred(fn) {
  deferDepth++;
  try {
    return fn();
  } finally {
    deferDepth--;
  }
}

/** Write now whatever is waiting (shutdown, tests). */
function flush() {
  if (dirty && batchDepth === 0) {
    const depth = deferDepth;
    deferDepth = 0;
    try { saveToDisk(); } finally { deferDepth = depth; }
  }
}

/** Is a deferred write still waiting for the file? */
function pending() {
  return dirty;
}

/** Give back the space of deleted rows (the file only shrinks after this). */
/** The first half of a compaction by itself: rebuild the database in memory. The file is written by the next save (flush()). */
function vacuum() {
  if (!dbInstance) return;
  dbInstance.run("VACUUM");
  dirty = true;
}

function compact() {
  if (!dbInstance) return;
  dbInstance.run("VACUUM");
  const depth = deferDepth;
  deferDepth = 0; // a compaction is written at once
  try { saveToDisk(); } finally { deferDepth = depth; }
}

/** Size of the database file on disk, in bytes (0 if it has not been written). */
function fileSize() {
  try { return fs.statSync(DB_PATH).size; } catch (_) { return 0; }
}

/**
 * Size of the database as it is in memory NOW, in bytes: what the next save will write. The file on
 * disk can be up to DB_DRAFT_FLUSH_MS behind (re-priced drafts wait for the file), so a ceiling that
 * is asked about the file can be walked past by re-pricing; a ceiling is asked about this.
 */
function liveSize() {
  if (!dbInstance) return fileSize();
  try {
    const pages = dbInstance.exec("PRAGMA page_count")[0].values[0][0];
    const size = dbInstance.exec("PRAGMA page_size")[0].values[0][0];
    return Number(pages) * Number(size);
  } catch (_) { return fileSize(); }
}

/** Bytes of the database that hold rows (pages in use): what is left once deleted rows' pages are counted out. */
function usedSize() {
  if (!dbInstance) return fileSize();
  try {
    const pages = dbInstance.exec("PRAGMA page_count")[0].values[0][0];
    const free = dbInstance.exec("PRAGMA freelist_count")[0].values[0][0];
    const size = dbInstance.exec("PRAGMA page_size")[0].values[0][0];
    return (Number(pages) - Number(free)) * Number(size);
  } catch (_) { return fileSize(); }
}

function getDatabase() {
  return dbInstance;
}

// A stop must not lose what is waiting: Railway sends SIGTERM on every deploy. On the signal the
// waiting changes are written at once and deferral is switched off for the rest of the process's
// life, so nothing written during a graceful shutdown can be left behind either. If this is the only
// SIGTERM/SIGINT listener the process then exits, as it would have without it; when the process has
// its own shutdown handling (server/ops on the deploy branch) that decides when to exit.
let stopping = false;
function onStop(signal) {
  stopping = true;
  try { flush(); } catch (err) { console.error("Database: could not write waiting changes at shutdown:", err.message); }
  if (process.listenerCount(signal) <= 1) process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("SIGTERM", () => onStop("SIGTERM"));
process.on("SIGINT", () => onStop("SIGINT"));
process.once("beforeExit", () => { try { flush(); } catch { /* nothing more to do */ } });

module.exports = { getDatabase, openError, isUsable, wasCreated, unusableReason, saveToDisk, writeDurably, batch, transaction, inTransaction, whenSaved, deferred, flush, pending, compact, vacuum, fileSize, liveSize, usedSize, ready, DB_PATH, payloadMigration: () => payloadMigration };
