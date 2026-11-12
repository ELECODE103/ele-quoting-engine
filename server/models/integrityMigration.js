/**
 * Review fixes (2026-11-11). Additive columns only, each added once:
 *
 *   parts.user_id            the account that uploaded the part (null: uploaded without one)
 *   users.setup_code_mac     keyed hash of the ADMIN_SETUP_CODE that provisioned the admin
 *                            account, so the same code can never be used a second time
 *
 * (The admin change log table this file used to create is now models/auditMigration.js — one
 * definition shared with the order-lifecycle work.)
 *
 * Nothing is backfilled: a part uploaded before this has no owner and is
 * reached with its edit key, exactly as an anonymous upload is.
 */
const COLUMNS = [
  ["parts", "user_id", "TEXT"],
  ["users", "setup_code_mac", "TEXT"],
];

// Table names, column names and types are the only interpolated parts of these statements and all
// of them are the constants above; they are still held to an identifier shape before use.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["TEXT"]);
function vetted(table, name, type) {
  if (!IDENTIFIER.test(table) || (name !== undefined && !IDENTIFIER.test(name)) || (type !== undefined && !COLUMN_TYPES.has(type))) {
    throw new Error("integrityMigration: not a plain identifier");
  }
}

function apply(db, columns = COLUMNS) {
  const added = [];
  for (const [table, name, type] of columns) {
    vetted(table, name, type);
    const have = new Set();
    const stmt = db.prepare(`PRAGMA table_info(${table})`);
    while (stmt.step()) have.add(stmt.getAsObject().name);
    stmt.free();
    if (have.has(name)) continue;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(`${table}.${name}`);
  }
  return added;
}

module.exports = { apply, COLUMNS };
