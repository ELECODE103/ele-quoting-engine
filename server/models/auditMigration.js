/**
 * The admin change log: ONE table, `admin_audit`, written through ONE module (services/audit.js).
 *
 * Two branches each created a table of this name with different columns (review-fixes: area,
 * action, target, changes_json; order-lifecycle-fixes: action, entity, entity_id, note,
 * before_json, after_json). This is the single definition both now use:
 *
 *   id, user_id, user_email   who (null: the server itself)
 *   area                      what kind of thing: material, finish, lead-time, rate-card, quotes,
 *                             order, admin-account
 *   action                    a short stable name: update, create, delete, duplicate, save, restore,
 *                             reset, void-open, takeover, recovery, order.status, order.mark-paid,
 *                             order.cancel, order.tracking, order.attention-resolved
 *   target                    a short label a person recognises (a slug, an order reference)
 *   entity_id                 the full id of the row that changed, when it has one (an order id)
 *   changes_json              { field: [before, after] } for the fields that changed, and only those
 *   note                      the reason the admin typed, when one was asked for
 *   created_at, updated_at
 *
 * Additive only, and safe on a database that already holds a table made by either branch on its
 * own: the table is created if absent, and any column of this list that an existing table lacks is
 * added. Nothing is dropped or rewritten (a row written by the lifecycle branch alone keeps its
 * before_json / after_json columns, which nothing reads any more; no such database is in production).
 * Rows are only ever inserted: there is no update or delete path (services/audit.js).
 */
const TABLE = "admin_audit";
const COLUMNS = [
  ["user_id", "TEXT"],
  ["user_email", "TEXT"],
  ["area", "TEXT"],
  ["action", "TEXT"],
  ["target", "TEXT"],
  ["entity_id", "TEXT"],
  ["changes_json", "TEXT"],
  ["note", "TEXT"],
  ["created_at", "TEXT"],
  ["updated_at", "TEXT"],
];

const CREATE = `
  CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_email TEXT,
    area TEXT,
    action TEXT,
    target TEXT,
    entity_id TEXT,
    changes_json TEXT,
    note TEXT,
    created_at TEXT,
    updated_at TEXT
  )`;

/** camelCase ↔ column names and JSON columns, in the shape SqliteDB.js spreads in. */
const FIELD_MAP = { entityId: "entity_id" };
const JSON_FIELDS = { admin_audit: { changes: "changes_json" } };

// Table name, column names and types are the only interpolated parts of these statements and all of
// them are the constants above; they are still held to an identifier shape before use.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["TEXT"]);
function vetted(table, name, type) {
  if (!IDENTIFIER.test(table) || (name !== undefined && !IDENTIFIER.test(name)) || (type !== undefined && !COLUMN_TYPES.has(type))) {
    throw new Error("auditMigration: not a plain identifier");
  }
}

function apply(db, columns = COLUMNS) {
  const table = TABLE;
  vetted(table);
  db.run(CREATE);
  const have = new Set();
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) have.add(stmt.getAsObject().name);
  stmt.free();
  const added = [];
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    vetted(table, name, type);
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(`${table}.${name}`);
  }
  return added;
}

module.exports = { apply, TABLE, COLUMNS, FIELD_MAP, JSON_FIELDS };
