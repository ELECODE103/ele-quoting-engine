/**
 * SQLite database initialization and setup using sql.js (pure JS, no native deps).
 * Creates and initializes all tables on first run.
 * Persists to disk via manual save after writes.
 */
const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "..", "..", "data", "quoting.db");

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
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    process TEXT,
    sub_process TEXT,
    density REAL,
    cost_per_kg REAL,
    grades_json TEXT,
    thicknesses_json TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS finishes (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    process TEXT,
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
    saveToDisk();
    readyResolve();
  } catch (err) {
    console.error("Failed to initialize SQLite:", err);
    readyResolve(); // resolve anyway so the app doesn't hang
  }
})();

function saveToDisk() {
  if (!dbInstance) return;
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDatabase() {
  return dbInstance;
}

module.exports = { getDatabase, saveToDisk, ready, DB_PATH };
