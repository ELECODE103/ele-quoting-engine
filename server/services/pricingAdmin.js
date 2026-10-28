/**
 * Pricing admin service — the logic behind the admin pricing console.
 *
 *   - current rules = schema defaults ← legacy DEFAULT_PRICING_RULES ← stored blob
 *   - every save is validated against the schema (type, min/max, whitelist),
 *     merged into the single stored blob and written to the audit log with a
 *     diff and the owner's note
 *   - history / restore / reset all go through the same save path so the log is
 *     complete
 *
 * DB access is injected so the logic can be tested against an in-memory store.
 */
const { DEFAULT_PRICING_RULES } = require("../config/defaults");
const schema = require("../config/ruleSchema");

const NOTE_MAX = 200;

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function createPricingAdmin({ pricingDB, auditDB }) {
  /** The stored row (one JSON blob under `rules`), or null. */
  function storedRow() {
    const rows = pricingDB.getAll();
    return rows.length ? rows[0] : null;
  }

  /** Effective rules: schema defaults, then legacy defaults, then what is stored. */
  function currentRules() {
    const row = storedRow();
    const stored = row && row.rules && typeof row.rules === "object" ? row.rules : {};
    // Defaults with stored values laid over them, each validated and clamped
    // by the schema (an older database always yields a complete, sane set).
    return schema.mergeRules(stored);
  }

  /** Keys of the stored blob that are not rules (seedVersion etc.) — carried through saves. */
  function passthrough(stored) {
    const keep = {};
    const known = new Set(schema.schemaKeys());
    for (const [k, v] of Object.entries(stored || {})) if (!known.has(k) && !(k in DEFAULT_PRICING_RULES)) keep[k] = v;
    return keep;
  }

  function diffRules(before, after) {
    const diff = {};
    for (const key of schema.schemaKeys()) {
      const a = JSON.stringify(before[key]);
      const b = JSON.stringify(after[key]);
      if (a !== b) diff[key] = { from: before[key] === undefined ? null : clone(before[key]), to: after[key] === undefined ? null : clone(after[key]) };
    }
    return diff;
  }

  function writeStored(nextRules) {
    const row = storedRow();
    const stored = row && row.rules && typeof row.rules === "object" ? row.rules : {};
    const blob = { ...passthrough(stored), ...nextRules };
    if (row) pricingDB.update(row.id, { rules: blob });
    else pricingDB.insert({ rules: blob });
  }

  function cleanNote(note) {
    const s = String(note == null ? "" : note).replace(/\s+/g, " ").trim();
    return s.slice(0, NOTE_MAX);
  }

  /**
   * Validate and save a partial or full rules object.
   * @returns {{ ok:true, rules, audit } | { ok:false, status, error, errors }}
   */
  function save(candidate, { note, user, action = "save", requireNote = true } = {}) {
    const cleanedNote = cleanNote(note);
    if (requireNote && !cleanedNote) {
      return { ok: false, status: 400, error: "Add a one-line note saying what you changed and why — it goes in the pricing history.", errors: [{ key: "note", message: "Note is required" }] };
    }
    const result = schema.validateRules(candidate, { partial: true });
    if (!result.ok) {
      return { ok: false, status: 400, error: result.errors[0].message, errors: result.errors };
    }
    const before = currentRules();
    const after = { ...before, ...result.values };
    const diff = diffRules(before, after);
    if (Object.keys(diff).length === 0 && action === "save") {
      return { ok: true, rules: after, audit: null, unchanged: true };
    }
    writeStored(after);
    const audit = auditDB.insert({
      userId: user?.userId || null,
      userEmail: user?.email || null,
      action,
      note: cleanedNote,
      diff,
      rules: after,
    });
    return { ok: true, rules: currentRules(), audit };
  }

  /** Reset every rule to its schema default. */
  function reset({ note, user } = {}) {
    const defaults = { ...schema.schemaDefaults() };
    return save(defaults, { note: note || "Reset every rule to the shipped defaults", user, action: "reset", requireNote: false });
  }

  function history({ limit = 50 } = {}) {
    const rows = auditDB.getAll()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      userEmail: r.userEmail || null,
      action: r.action || "save",
      note: r.note || "",
      diff: r.diff && typeof r.diff === "object" ? r.diff : {},
      changedKeys: Object.keys(r.diff && typeof r.diff === "object" ? r.diff : {}),
    }));
  }

  /** Put the rules back to the full snapshot taken when audit entry `id` was written. */
  function restore(id, { note, user } = {}) {
    const entry = auditDB.getById(id);
    if (!entry || !entry.rules || typeof entry.rules !== "object") {
      return { ok: false, status: 404, error: "That history entry was not found" };
    }
    // Only schema keys from the snapshot; unknown keys from an older schema are dropped.
    const snapshot = {};
    for (const key of schema.schemaKeys()) if (entry.rules[key] !== undefined) snapshot[key] = entry.rules[key];
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString("en-US") : "earlier";
    return save(snapshot, { note: note || `Restored the rules saved ${when}${entry.note ? ` (“${entry.note}”)` : ""}`, user, action: "restore", requireNote: false });
  }

  return { currentRules, save, reset, history, restore, diffRules, NOTE_MAX };
}

module.exports = { createPricingAdmin };
