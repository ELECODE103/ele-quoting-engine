/**
 * The admin change log (payments review 2026-11-11, F-15): who changed what
 * and when, for everything that can move a price or an order by hand —
 * materials, finishes, lead times, the rate card, quotes voided, and order
 * status changes.
 *
 * Append-only: this module only inserts and reads. No route updates or deletes
 * a row. What is written is field names and catalog values (prices, flags,
 * slugs, statuses) — never a password, a token, or anything a customer typed.
 */
const { adminAuditDB } = require("../models");

const TEXT_LIMIT = 80;

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
  for (const key of fields || Object.keys(after)) {
    const a = before ? before[key] : undefined;
    const b = after[key];
    if (b === undefined) continue;
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out[key] = [loggable(a), loggable(b)];
  }
  return out;
}

/**
 * Write one line. Never throws: a failed log write is reported and the change stands.
 * @param {object} user     req.user ({ userId, email })
 * @param {object} entry    { area, action, target, changes }
 */
function record(user, { area, action, target = "", changes = {} }) {
  try {
    if (changes && typeof changes === "object" && Object.keys(changes).length === 0 && action === "update") return null; // nothing changed
    return adminAuditDB.insert({
      userId: (user && user.userId) || null,
      userEmail: (user && user.email) || null,
      area: String(area).slice(0, 40),
      action: String(action).slice(0, 40),
      target: String(target || "").slice(0, 120),
      changes,
    });
  } catch (err) {
    console.error("Admin change log: could not write an entry:", err.message);
    return null;
  }
}

/** Newest first. */
function list({ limit = 200 } = {}) {
  return adminAuditDB.getAll()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)));
}

module.exports = { record, diff, list };
