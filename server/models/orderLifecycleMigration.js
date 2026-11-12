/**
 * Order lifecycle (2026-11-11): what happens to an order after a Stripe session exists.
 * Additive only. Every statement adds a column or a table that is not there yet, so it
 * applies to a database created by any earlier version and is a no-op the second time.
 * Nothing is backfilled in SQL: a row written before these columns existed reads NULL in
 * each of them, and every reader treats NULL as "nothing recorded" (no discount, nothing
 * refunded, no flag, US dollars, session expiry unknown).
 *
 * The camelCase ↔ column names live here too (FIELD_MAP, JSON_FIELDS, BOOLEAN_COLUMNS) so
 * SqliteDB.js picks them up with one line each; a field that has no column is dropped on
 * write without a word, which is why the lists sit side by side and the test checks them
 * against each other.
 *
 * New tables
 *   payment_sessions   one row per Stripe Checkout session made for an order (id = Stripe's id)
 *   payment_events     one row per money event: paid, PO order, payment needing attention,
 *                      refund, dispute, expiry, manual change. `event_id` is Stripe's event id
 *                      (a retried webhook is answered from this table and not run twice);
 *                      `notified` is 1 when the shop was emailed about it.
 *   admin_audit        who changed what by hand, written through services/audit.js
 */
const ORDER_COLUMNS = [
  ["currency", "TEXT"],              // ISO code, lower case; NULL reads as "usd"
  ["session_expires_at", "TEXT"],    // when the order's open Checkout session stops being payable
  ["paid_via", "TEXT"],              // "card" (Stripe) | "manual" (marked paid by the owner, with a reason)
  ["manual_paid_reason", "TEXT"],
  ["manual_paid_by", "TEXT"],
  ["amount_paid", "REAL"],           // what Stripe reported collected, in dollars (after any promotion code)
  ["discount_amount", "REAL"],       // promotion-code discount Stripe reported, in dollars
  ["refunded_amount", "REAL"],       // total refunded so far, in dollars
  ["refunded_at", "TEXT"],
  ["attention", "TEXT"],             // short code while the order needs the owner: see services/orderState.js
  ["attention_note", "TEXT"],        // the same in plain words, for the admin screen
  ["attention_at", "TEXT"],
  ["dispute_status", "TEXT"],        // "open" | "won" | "lost" | "closed"
  ["dispute_at", "TEXT"],
  ["expired_at", "TEXT"],
  ["cancelled_at", "TEXT"],
];

const RFQ_COLUMNS = [
  // Fingerprint of the terms the emailed link was issued for (total, lines, lead time, validity,
  // what the price covers). A quote whose terms no longer match it has no usable link until it is re-sent.
  ["sent_terms", "TEXT"],
];

const TABLES = {
  payment_sessions: `CREATE TABLE IF NOT EXISTS payment_sessions (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    status TEXT,
    outcome TEXT,
    amount_cents INTEGER,
    currency TEXT,
    promo_allowed INTEGER DEFAULT 0,
    url TEXT,
    return_key TEXT,
    expires_at TEXT,
    payment_intent TEXT,
    paid_cents INTEGER,
    closed_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  payment_events: `CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    kind TEXT,
    order_id TEXT,
    session_id TEXT,
    payment_intent TEXT,
    amount_cents INTEGER,
    currency TEXT,
    detail TEXT,
    notified INTEGER DEFAULT 0,
    created_at TEXT
  )`,
  admin_audit: `CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    user_email TEXT,
    action TEXT,
    entity TEXT,
    entity_id TEXT,
    note TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT
  )`,
};

const FIELD_MAP = {
  sessionExpiresAt: "session_expires_at",
  paidVia: "paid_via",
  manualPaidReason: "manual_paid_reason",
  manualPaidBy: "manual_paid_by",
  amountPaid: "amount_paid",
  discountAmount: "discount_amount",
  refundedAmount: "refunded_amount",
  refundedAt: "refunded_at",
  attentionNote: "attention_note",
  attentionAt: "attention_at",
  disputeStatus: "dispute_status",
  disputeAt: "dispute_at",
  expiredAt: "expired_at",
  cancelledAt: "cancelled_at",
  sentTerms: "sent_terms",
  // payment_sessions / payment_events / admin_audit
  amountCents: "amount_cents",
  promoAllowed: "promo_allowed",
  returnKey: "return_key",
  paymentIntent: "payment_intent",
  paidCents: "paid_cents",
  closedAt: "closed_at",
  eventId: "event_id",
  sessionId: "session_id",
  entityId: "entity_id",
};

/** JSON columns per new table, in the shape SqliteDB's JSON_COLUMNS uses. */
const JSON_FIELDS = {
  payment_sessions: {},
  payment_events: {},
  admin_audit: { before: "before_json", after: "after_json" },
};

const BOOLEAN_COLUMNS = ["promo_allowed", "notified"];

// Table names, column names and types are the only interpolated parts of these statements and
// all of them are the constants above; they are still held to an identifier shape before use.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["TEXT", "REAL", "INTEGER", "INTEGER DEFAULT 0"]);
function vetted(table, name, type) {
  if (!IDENTIFIER.test(table) || (name !== undefined && !IDENTIFIER.test(name)) || (type !== undefined && !COLUMN_TYPES.has(type))) {
    throw new Error("orderLifecycleMigration: not a plain identifier");
  }
}

function addMissing(db, table, columns) {
  vetted(table);
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

function apply(db) {
  for (const sql of Object.values(TABLES)) db.run(sql);
  return [...addMissing(db, "orders", ORDER_COLUMNS), ...addMissing(db, "rfqs", RFQ_COLUMNS)];
}

module.exports = { apply, ORDER_COLUMNS, RFQ_COLUMNS, TABLES, FIELD_MAP, JSON_FIELDS, BOOLEAN_COLUMNS };
