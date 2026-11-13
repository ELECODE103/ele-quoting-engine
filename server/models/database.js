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

(async function init() {
  try {
    SQL = await initSqlJs();
    ensureDataDir();

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      dbInstance = new SQL.Database(buffer);
    } else {
      dbInstance = new SQL.Database();
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
    readyResolve(); // resolve anyway so the app doesn't hang
  }
})();

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

module.exports = { getDatabase, saveToDisk, writeDurably, batch, deferred, flush, pending, compact, vacuum, fileSize, liveSize, usedSize, ready, DB_PATH, payloadMigration: () => payloadMigration };
