/**
 * The admin change log: who changed what by hand, and when. ONE module writes it and ONE table
 * holds it (`admin_audit`, models/auditMigration.js). It replaces the two that the price-integrity
 * work (services/adminAudit.js: `record(user, { area, action, target, changes })`) and the
 * order-lifecycle work (services/audit.js: `record({ actor, action, entity, entityId, before, after,
 * note })`) each brought; every event either of them wrote is written here, in one shape.
 *
 *   audit.record({ actor, area, action, target, entityId, changes, note })
 *
 *   actor      the signed-in admin as the session carries it ({ userId, email }) — or null for a
 *              change the server made on its own
 *   area       what kind of thing changed: "material", "finish", "lead-time", "rate-card",
 *              "quotes", "order", "admin-account"            (`entity` is accepted as the same thing)
 *   action     a short stable name: "update", "create", "delete", "duplicate", "save", "restore",
 *              "reset", "void-open", "takeover", "recovery", "order.status", "order.mark-paid",
 *              "order.cancel", "order.tracking", "order.attention-resolved"
 *   target     a short label a person recognises (a slug; an order's 8-character reference)
 *   entityId   the full id of the row, when it has one
 *   changes    { field: [before, after] } — only the fields that changed. A caller holding the two
 *              states can pass `before` and `after` instead and the pairs are made here.
 *   note       the reason the ADMIN typed, when a reason was asked for
 *
 * Append-only: this module only inserts and reads; no route updates or deletes a row. What is
 * written is field names and catalog or state values (prices, flags, slugs, statuses) and the
 * admin's own typed reason — never a password, a token, a setup code, or anything a customer typed.
 * Recording must never break the action it describes: any failure is logged (action name only)
 * and swallowed.
 */
const TEXT_LIMIT = 80;
const MAX_NOTE = 500;

const store = () => require("../models").adminAuditDB;
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** A value as it may appear in the log: numbers, booleans and short catalog text; lists and long text as a size. */
function loggable(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > TEXT_LIMIT ? `${v.slice(0, TEXT_LIMIT)}…` : v;
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  return "[changed]";
}

/** { field: [before, after] } for every listed field whose value differs. */
function diff(before = {}, after = {}, fields) {
  const out = {};
  for (const key of fields || Object.keys(after || {})) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (b === undefined) continue;
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out[key] = [loggable(a), loggable(b)];
  }
  return out;
}

/** The pairs to store: the caller's own, or made from a before/after pair of states. */
function pairsOf(e) {
  if (e.changes && typeof e.changes === "object") return e.changes;
  if (e.before === undefined && e.after === undefined) return {};
  const before = e.before && typeof e.before === "object" ? e.before : {};
  const after = e.after && typeof e.after === "object" ? e.after : {};
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = loggable(before[key]);
    const b = loggable(after[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = [a, b];
  }
  return out;
}

/**
 * Write one line. Never throws: a failed write is reported and the change it describes stands.
 * An "update" that changed nothing writes nothing.
 * @returns the stored row, or null
 */
function record(event) {
  try {
    const e = event || {};
    if (!e.action) return null; // nothing to say
    const changes = pairsOf(e);
    if (e.action === "update" && Object.keys(changes).length === 0) return null; // nothing changed
    return store().insert({
      userId: (e.actor && (e.actor.userId || e.actor.id)) || null,
      userEmail: clip((e.actor && e.actor.email) || "", 254) || null,
      area: clip(String(e.area || e.entity || ""), 40),
      action: clip(String(e.action || ""), 80),
      target: clip(String(e.target || ""), 120),
      entityId: clip(String(e.entityId || ""), 128) || null,
      changes,
      note: clip(e.note || "", MAX_NOTE) || null,
    });
  } catch (err) {
    console.error(`[audit] could not record ${event && typeof event.action === "string" ? event.action.slice(0, 80) : "an event"}: ${err && err.name ? err.name : "Error"}`);
    return null;
  }
}

/** Newest first; optionally one area, or one row's history. */
function list({ area, entity, entityId, limit = 200 } = {}) {
  try {
    const kind = area || entity;
    return store().getAll()
      .filter((r) => (!kind || r.area === kind) && (!entityId || r.entityId === entityId))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)));
  } catch {
    return [];
  }
}

module.exports = { record, diff, list };
