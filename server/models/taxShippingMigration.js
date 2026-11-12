/**
 * Shipping and tax columns (2026-11-11). Additive only: every statement adds a
 * column that is not there yet, so it applies to a database created by any
 * earlier version and is a no-op the second time. Nothing is backfilled: a row
 * written before these columns existed reads NULL in each of them, and every
 * reader treats NULL as "the behaviour before the switch existed" (shipping by
 * the weight formula, shipped by us, no tax, no exemption).
 *
 * The camelCase ↔ column names for these fields live here too (FIELD_MAP), so
 * SqliteDB.js picks them up with one line. A field that is not in that map and
 * has no column is dropped on write without a word, which is why the two lists
 * are kept side by side and checked against each other in the test.
 */
const QUOTE_COLUMNS = [
  // What the quote's shipping line is made of, as priced by the server when the quote was
  // last priced: { mode, method, amount, manual, reason, packedLb, longestIn, … } (services/shipping.js).
  ["shipping_json", "TEXT"],
  // A tax-exemption certificate the buyer attached before checkout (stored like a drawing).
  ["tax_cert_file_name", "TEXT"],
  ["tax_cert_path", "TEXT"],
];

const ORDER_COLUMNS = [
  // How the shipping line was arrived at: "formula" | "included" | "table" | "firm" (a firm quote's price covers it).
  ["shipping_mode", "TEXT"],
  // Packed weight the shipping line was priced on, for the traveler and the admin view.
  ["packed_weight_lb", "REAL"],
  // "Ship on my carrier account": carrier, the account number sealed (AES-256-GCM, security/secretBox.js)
  // and its last four characters for display. The full number is opened only for the admin order view.
  ["ship_carrier", "TEXT"],
  ["ship_account_enc", "TEXT"],
  ["ship_account_last4", "TEXT"],
  ["ship_service", "TEXT"],
  // Tax: the mode the order was checked out under ("off" | "stripe"), and what the buyer declared.
  ["tax_mode", "TEXT"],
  ["tax_exempt", "INTEGER DEFAULT 0"],
  ["tax_exempt_reason", "TEXT"],
  // "untaxed" (declaration trusted: charged with no tax) | "taxed" (charged tax; refund after the certificate is read)
  ["tax_exempt_status", "TEXT"],
  ["tax_cert_file_name", "TEXT"],
  ["tax_cert_path", "TEXT"],
  // Business tax IDs Stripe collected on its page, as "type value" pairs (admin view only).
  ["customer_tax_ids", "TEXT"],
];

const RFQ_COLUMNS = [
  // The same certificate, attached on the firm-quote page before the quote is accepted.
  ["tax_cert_file_name", "TEXT"],
  ["tax_cert_path", "TEXT"],
];

const FIELD_MAP = {
  shippingMode: "shipping_mode",
  packedWeightLb: "packed_weight_lb",
  shipCarrier: "ship_carrier",
  shipAccountEnc: "ship_account_enc",
  shipAccountLast4: "ship_account_last4",
  shipService: "ship_service",
  taxMode: "tax_mode",
  taxExempt: "tax_exempt",
  taxExemptReason: "tax_exempt_reason",
  taxExemptStatus: "tax_exempt_status",
  taxCertFileName: "tax_cert_file_name",
  taxCertPath: "tax_cert_path",
  customerTaxIds: "customer_tax_ids",
};
/** JS field → JSON column, per table (merged into SqliteDB's JSON_COLUMNS). */
const JSON_FIELDS = { quotes: { shipping: "shipping_json" } };
const BOOLEAN_COLUMNS = ["tax_exempt"];

// Table names, column names and types are the only interpolated parts of these statements and
// all of them are the constants above; they are still held to an identifier shape.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["TEXT", "INTEGER", "INTEGER DEFAULT 0", "REAL"]);

function vetted(table, name, type) {
  if (!IDENTIFIER.test(table) || (name !== undefined && !IDENTIFIER.test(name)) || (type !== undefined && !COLUMN_TYPES.has(type))) {
    throw new Error("taxShippingMigration: not a plain identifier");
  }
}

function columnsOf(db, table) {
  vetted(table);
  const cols = new Set();
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) cols.add(stmt.getAsObject().name);
  stmt.free();
  return cols;
}

function addMissing(db, table, columns) {
  const have = columnsOf(db, table);
  const added = [];
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    vetted(table, name, type);
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  return added;
}

/** @returns {{quotes: string[], orders: string[], rfqs: string[]}} the columns this run added */
function apply(db, lists = {}) {
  return {
    quotes: addMissing(db, "quotes", lists.quotes || QUOTE_COLUMNS),
    orders: addMissing(db, "orders", lists.orders || ORDER_COLUMNS),
    rfqs: addMissing(db, "rfqs", lists.rfqs || RFQ_COLUMNS),
  };
}

module.exports = { apply, QUOTE_COLUMNS, ORDER_COLUMNS, RFQ_COLUMNS, FIELD_MAP, JSON_FIELDS, BOOLEAN_COLUMNS };
