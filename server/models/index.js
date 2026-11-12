/**
 * Database factory that exports either SQLite or JSON-based databases.
 * Controlled by USE_SQLITE environment variable (defaults to true).
 */
const { SqliteDB } = require("./SqliteDB");
const { JsonDB } = require("./db");

// Check if we should use SQLite (default: true for new installs)
const USE_SQLITE = process.env.USE_SQLITE !== "false";

// Export the appropriate DB class
const DBClass = USE_SQLITE ? SqliteDB : JsonDB;

// Pre-configured database instances for each table
const materialsDB = new DBClass("materials");
const finishesDB = new DBClass("finishes");
const leadTimesDB = new DBClass("lead_times");
const pricingDB = new DBClass("pricing_rules");
// A quote's priced lines are stored once per distinct line (models/quotesStore.js); reads give back the same array.
const quotesDB = new (require("./quotesStore").QuotesStore)(new DBClass("quotes"));
// A part's preview mesh and large geometry detail live in files, not in the row (models/partsStore.js).
const partsDB = new (require("./partsStore").PartsStore)(new DBClass("parts"));
const ordersDB = new DBClass("orders");
const orderItemsDB = new DBClass("order_items");
const usersDB = new DBClass("users");
const processesDB = new DBClass("processes");
const rfqsDB = new DBClass("rfqs");
const pricingAuditDB = new DBClass("pricing_audit");
const revokedSessionsDB = new DBClass("revoked_sessions");
const adminAuditDB = new DBClass("admin_audit"); // append-only admin change log (services/audit.js; table: models/auditMigration.js)

module.exports = {
  // Export instances
  materialsDB,
  finishesDB,
  leadTimesDB,
  pricingDB,
  quotesDB,
  partsDB,
  ordersDB,
  orderItemsDB,
  usersDB,
  processesDB,
  rfqsDB,
  pricingAuditDB,
  revokedSessionsDB,
  adminAuditDB,

  // Also export classes for advanced use
  SqliteDB,
  JsonDB,
  USE_SQLITE,
};
