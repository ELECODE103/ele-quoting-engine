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
`;

// Singleton
let dbInstance = null;
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
    ];
    for (const sql of migrations) {
      try { dbInstance.run(sql); } catch (e) { /* column already exists */ }
    }

    saveToDisk();
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

function saveToDisk() {
  if (!dbInstance) return;
  if (batchDepth > 0) { dirty = true; return; }
  const buffer = Buffer.from(dbInstance.export());
  // Write beside the file and rename, so a crash mid-write cannot leave a
  // half-written database behind.
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, DB_PATH);
  dirty = false;
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

/** Give back the space of deleted rows (the file only shrinks after this). */
function compact() {
  if (!dbInstance) return;
  dbInstance.run("VACUUM");
  saveToDisk();
}

/** Size of the database file on disk, in bytes (0 if it has not been written). */
function fileSize() {
  try { return fs.statSync(DB_PATH).size; } catch (_) { return 0; }
}

function getDatabase() {
  return dbInstance;
}

module.exports = { getDatabase, saveToDisk, batch, compact, fileSize, ready, DB_PATH };
