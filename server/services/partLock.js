/**
 * When a part's measurements may no longer be changed, and whether an order's parts are still the
 * parts that were priced (independent re-review 2026-11-12, F-01).
 *
 * The only thing that replaces a stored part's measurements is a DXF being read again at another
 * scale (POST /api/parts/:partId/units). The route used to ask "is this part on an order?", then
 * wait for the file to be read in a worker, then write: a checkout that landed in that wait made
 * its order from the old measurements and the route replaced them underneath it.
 *
 * The rule now, in one place:
 *
 *   locked()   A part is settled once anything that is being, or has been, turned into work names
 *              it: an order line (any order, paid or not, lapsed or not), a firm-quote request, or
 *              a quote that is no longer a draft. Asked by the gate in front of the units route
 *              (security/index.js) and asked AGAIN by the route in the same uninterrupted step as
 *              its write, after the wait. Node runs one piece of JavaScript at a time and a
 *              checkout makes its order in one piece, so for any checkout and any units change one
 *              of the two is true: the order exists when the route asks (the change is refused), or
 *              the new measurements are stored when the checkout prices (it prices those).
 *
 *   changedSincePriced()   Belt and braces for the owner: every order line keeps the revision number
 *              of the part it was priced from (models/partsStore.js geometryRev, in the line's
 *              `priced` snapshot). If a line's part is ever at another revision, or gone, the order
 *              is flagged "part-changed" when it is paid and the shop is emailed
 *              (services/orderLifecycle.js); the traveler's own line says so as before.
 *
 * Everything here is answered from the rows (and the indexes on order_items): no part's
 * measurement file is read.
 */
const { orderItemsDB, rfqsDB, quotesDB, partsDB } = require("../models");
const { partIdsOf } = require("../models/quotesStore");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sql = (store) => typeof store._query === "function" || (store.table && typeof store.table._query === "function");
const q = (store, text, params) => (typeof store._query === "function" ? store._query(text, params) : store.table._query(text, params));

/**
 * Why this part may no longer be changed: "order", "request", "quote", or null when it still may.
 * @param {string} partId
 */
function lockedBy(partId) {
  if (typeof partId !== "string" || !UUID.test(partId)) return null;
  if (sql(orderItemsDB)) {
    if (q(orderItemsDB, "SELECT 1 AS x FROM order_items WHERE part_id = ? LIMIT 1", [partId]).length) return "order";
    // A request keeps its parts as JSON. The id is looked for as text first (a part id is a random
    // UUID), then confirmed in the parsed rows, so a file that happens to be NAMED like a part id locks nothing.
    const requests = q(rfqsDB, "SELECT id FROM rfqs WHERE parts_json IS NOT NULL AND instr(parts_json, ?) > 0", [partId]);
    if (requests.some((r) => ((rfqsDB.getById(r.id) || {}).parts || []).some((p) => p && p.partId === partId))) return "request";
    // A quote that has moved on (ordered, sent as a request). part_ids is kept beside the row; a row
    // from before it was kept is opened once to find out.
    const moved = q(quotesDB, "SELECT id, part_ids FROM quotes WHERE status IS NOT NULL AND status != 'draft' AND (part_ids IS NULL OR instr(part_ids, ?) > 0)", [partId]);
    for (const row of moved) {
      const ids = row.part_ids === null || row.part_ids === undefined ? partIdsOf(quotesDB.getById(row.id)) : String(row.part_ids).split(",");
      if (ids.includes(partId)) return "quote";
    }
    return null;
  }
  if (orderItemsDB.query((i) => i.partId === partId).length) return "order";
  if (rfqsDB.query((r) => (r.parts || []).some((p) => p && p.partId === partId)).length) return "request";
  if (quotesDB.query((x) => x.status && x.status !== "draft" && partIdsOf(x).includes(partId)).length) return "quote";
  return null;
}

const locked = (partId) => lockedBy(partId) !== null;

/**
 * The lines of an order whose part is not the part that was priced: its measurements were replaced
 * since (another revision), or it is gone. Lines priced before revisions were kept, and lines with
 * no snapshot (a firm quote), are not judged here.
 * @returns {Array<{ fileName: string, partId: string, why: "changed"|"missing" }>}
 */
function changedSincePriced(orderId) {
  const out = [];
  const revOf = new Map();
  for (const item of require("../models/orderQueries").itemsOf(orderId)) {
    const priced = item.config && item.config.priced;
    if (!item.partId || !priced || !Number.isInteger(priced.partRev)) continue;
    if (!revOf.has(item.partId)) {
      const row = typeof partsDB.getRow === "function" ? partsDB.getRow(item.partId) : partsDB.getById(item.partId);
      revOf.set(item.partId, row ? Number(row.geometryRev) || 0 : null);
    }
    const now = revOf.get(item.partId);
    if (now === null) out.push({ fileName: item.fileName || "", partId: item.partId, why: "missing" });
    else if (now !== priced.partRev) out.push({ fileName: item.fileName || "", partId: item.partId, why: "changed" });
  }
  return out;
}

/** The note and flag for an order whose parts changed, or null. */
function attentionFor(orderId) {
  let changed;
  try { changed = changedSincePriced(orderId); } catch (err) { console.error(`[part-lock] could not compare order ${String(orderId).slice(0, 8)} with its parts: ${err.name || "Error"}`); return null; }
  if (changed.length === 0) return null;
  const names = [...new Set(changed.map((c) => c.fileName || "a part"))];
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
  return {
    attention: "part-changed",
    attentionNote: `The file of ${changed.length === 1 ? "one line" : `${changed.length} lines`} on this order is not the file that was priced (${shown}). Do not cut from it: compare the traveler with the order and confirm with the customer.`,
    attentionAt: new Date().toISOString(),
  };
}

/**
 * Has a part of this quote been replaced since the quote was priced? True when the quote is marked
 * to be priced again, or when a line was priced from another revision of its part's measurements
 * than the one stored now (a DXF's units were changed and the quote has not been priced since:
 * routes/api.js prices saved quotes again AFTER a units change, in pieces, not inside it).
 * A quote with no record of what it was priced from (made before 2026-11) has nothing to compare.
 */
function quoteBehindParts(quote) {
  const integrity = quote && quote.config && quote.config.integrity;
  if (!integrity || integrity.v !== 1 || !Array.isArray(integrity.lines)) return false;
  if (integrity.stale) return true;
  const items = Array.isArray(quote.lineItems) ? quote.lineItems : [];
  const configs = quote.config && Array.isArray(quote.config.parts) ? quote.config.parts : [];
  for (let i = 0; i < integrity.lines.length; i++) {
    const snap = integrity.lines[i] && integrity.lines[i].snapshot;
    const partId = (items[i] && items[i].partId) || (configs[i] && configs[i].partId);
    if (!snap || snap.partRev === undefined || snap.partRev === null || !partId) continue;
    const row = partsDB.getRow(partId);
    if (row && (Number(row.geometryRev) || 0) !== Number(snap.partRev)) return true;
  }
  return false;
}

module.exports = {
  quoteBehindParts, lockedBy, locked, changedSincePriced, attentionFor };
