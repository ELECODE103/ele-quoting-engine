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
const quotesDB = new DBClass("quotes");
const partsDB = new DBClass("parts");
const ordersDB = new DBClass("orders");
const orderItemsDB = new DBClass("order_items");
const usersDB = new DBClass("users");
const processesDB = new DBClass("processes");

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

  // Also export classes for advanced use
  SqliteDB,
  JsonDB,
  USE_SQLITE,
};
