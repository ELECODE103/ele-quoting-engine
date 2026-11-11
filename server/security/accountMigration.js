/**
 * Account-hardening columns (2026-11-11). Additive only: every statement adds
 * a column that is not there yet, so it applies to a database created by any
 * earlier version and is a no-op the second time.
 *
 * One backfill rides with the first column: accounts that existed before email
 * verification was introduced (the owner's admin account among them) are marked
 * verified, once, at the moment `email_verified_at` is added. It is tied to the
 * column being new so a restart never verifies accounts created afterwards.
 */
const USER_COLUMNS = [
  ["email_verified_at", "TEXT"],
  ["email_verify_nonce", "TEXT"],
  ["token_version", "INTEGER DEFAULT 0"],
  ["password_changed_at", "TEXT"],
  ["locked_until", "TEXT"],
  ["lock_notified_at", "TEXT"],
  ["last_login_at", "TEXT"],
  // Two-factor sign-in (admin). The secret is AES-256-GCM ciphertext; recovery
  // codes are stored as hashes.
  ["totp_secret_enc", "TEXT"],
  ["totp_pending_enc", "TEXT"],
  ["totp_enabled_at", "TEXT"],
  ["totp_last_step", "INTEGER"],
  ["recovery_codes_json", "TEXT"],
];

const RFQ_COLUMNS = [
  // How the sender of a request was checked: "turnstile", "account", or "none"
  // (not checked: the shop sees "unverified sender" and no email went to the typed address).
  ["sender_check", "TEXT"],
  ["buyer_emailed", "INTEGER DEFAULT 0"],
];

function columnsOf(db, table) {
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
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  return added;
}

/** @returns {{users: string[], rfqs: string[], backfilled: number}} what this run changed */
function apply(db) {
  const users = addMissing(db, "users", USER_COLUMNS);
  let backfilled = 0;
  if (users.includes("email_verified_at")) {
    db.run("UPDATE users SET email_verified_at = COALESCE(created_at, ?) WHERE email_verified_at IS NULL", [new Date().toISOString()]);
    backfilled = db.getRowsModified();
  }
  const rfqs = addMissing(db, "rfqs", RFQ_COLUMNS);
  return { users, rfqs, backfilled };
}

module.exports = { apply, USER_COLUMNS, RFQ_COLUMNS };
