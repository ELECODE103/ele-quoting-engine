/**
 * Fixes for the independent re-review of the relaunch merge (2026-11-13). Additive only: every
 * statement adds a column or an index that is not there yet, so it applies to a database made by
 * any earlier version and does nothing the second time. Nothing is backfilled: a row written
 * before a column existed reads NULL in it, and every reader treats NULL as "nothing recorded".
 *
 *   parts.geometry_rev      how many times the part's stored measurements have been replaced
 *                           (a DXF read again at another scale). An order line keeps the number
 *                           it was priced at, so "is this still the part that was priced" is one
 *                           integer compared with another (services/partLock.js).
 *
 *   orders.client_tag       which address an order was made from (the same keyed hash of the client
 *                           key as on parts and quotes, never the address), for the ceiling on
 *                           unpaid orders per address (security/orderCaps.js).
 *
 *   orders.line_count       how many lines the order was written with, in the same change as the
 *                           lines themselves. NULL on an order from before this: the start-up check
 *                           (services/orderRepair.js) looks at those once and fills it in.
 *
 * Indexes: the questions the order routes ask on every request ("the lines of this order",
 * "is this part on an order", "this account's orders") are answered from an index, not by
 * reading every row of the table.
 */
const COLUMNS = [
  ["parts", "geometry_rev", "INTEGER DEFAULT 0"],
  ["orders", "client_tag", "TEXT"],
  ["orders", "line_count", "INTEGER"],
];

const INDEXES = [
  ["idx_order_items_order", "order_items", "order_id"],
  ["idx_order_items_part", "order_items", "part_id"],
  ["idx_orders_user", "orders", "user_id"],
  ["idx_orders_quote", "orders", "quote_id"],
  ["idx_orders_status", "orders", "status"],
  ["idx_orders_created", "orders", "created_at"],
  ["idx_orders_client", "orders", "client_tag"],
];

const FIELD_MAP = {
  geometryRev: "geometry_rev",
  // (orders.client_tag is written and read as `clientTag`, which the field map already has.)
  lineCount: "line_count",
};

// Table, column and index names and the column types are the only interpolated parts of these
// statements and all of them are the constants above; they are still held to an identifier shape.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["TEXT", "REAL", "INTEGER", "INTEGER DEFAULT 0"]);
function vetted(...names) {
  for (const name of names) if (!IDENTIFIER.test(name)) throw new Error("rereviewMigration: not a plain identifier");
}

function columnsOf(db, table) {
  const have = new Set();
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) have.add(stmt.getAsObject().name);
  stmt.free();
  return have;
}

function apply(db) {
  const added = [];
  for (const [table, name, type] of COLUMNS) {
    vetted(table, name);
    if (!COLUMN_TYPES.has(type)) throw new Error("rereviewMigration: not a known column type");
    if (columnsOf(db, table).has(name)) continue;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(`${table}.${name}`);
  }
  for (const [index, table, column] of INDEXES) {
    vetted(index, table, column);
    if (!columnsOf(db, table).has(column)) continue; // a table from a later migration that is not there yet
    db.run(`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (${column})`);
  }
  return added;
}

module.exports = { apply, COLUMNS, INDEXES, FIELD_MAP };
