/**
 * Admin audit trail: who changed what by hand.
 *
 *   audit.record({ actor, action, entity, entityId, before, after, note })
 *
 *   actor     the signed-in admin as the session carries it ({ userId, email }) — or null for
 *             a change the system made on its own
 *   action    a short stable name: "order.status", "order.mark-paid", "order.cancel",
 *             "order.attention-resolved", …
 *   entity    what was changed ("order", "rfq", …) and entityId its id
 *   before / after   the fields that changed, and only those
 *   note      what the admin typed as the reason, when a reason was asked for
 *
 * A row is appended to `admin_audit` and never updated. Recording must never break the
 * action it describes: any failure here is logged (action name only) and swallowed.
 */
const MAX_NOTE = 500;

function clip(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function record(event) {
  try {
    const e = event || {};
    const { adminAuditDB } = require("../models/lifecycleStore");
    return adminAuditDB.insert({
      userId: (e.actor && (e.actor.userId || e.actor.id)) || null,
      userEmail: clip((e.actor && e.actor.email) || "", 254),
      action: clip(e.action || "", 80),
      entity: clip(e.entity || "", 40),
      entityId: clip(String(e.entityId || ""), 128),
      note: clip(e.note || "", MAX_NOTE),
      before: e.before === undefined ? null : e.before,
      after: e.after === undefined ? null : e.after,
    });
  } catch (err) {
    console.error(`[audit] could not record ${event && typeof event.action === "string" ? event.action.slice(0, 80) : "an event"}: ${err && err.name ? err.name : "Error"}`);
    return null;
  }
}

/** Newest first, optionally for one entity. */
function list({ entity, entityId, limit = 200 } = {}) {
  try {
    const { adminAuditDB } = require("../models/lifecycleStore");
    return adminAuditDB.getAll()
      .filter((r) => (!entity || r.entity === entity) && (!entityId || r.entityId === entityId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { record, list };
