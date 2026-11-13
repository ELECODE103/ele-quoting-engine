/**
 * The start-up check for orders that were only partly written (independent re-review 2026-11-12, F-02).
 *
 * Until 2026-11-13 an order was written as one save for its row, one per line and one for its quote.
 * A process killed between two of them (an out-of-memory kill, a host fault) left on the disk an
 * order with some of its lines and a quote still marked "draft". When the buyer came back and
 * pressed pay, that order was resumed and charged the full total: paid in full, fewer lines than
 * were paid for, nothing flagged.
 *
 * Orders are now written in one change (models/database.js transaction(); routes/orders.js,
 * routes/rfq.js), so no new one can be left like that. This looks, once per order, at the ones made
 * before:
 *
 *   an UNPAID card order made from an instant quote whose lines are not all there (fewer than its
 *   quote has, or its quote was never marked "ordered")
 *       → closed out as "not paid, closed". It can never be handed a payment page. Its quote is a
 *         draft again, so the buyer checks out again and gets a whole order. Its payment pages are
 *         closed at Stripe after start-up (closeLeftovers()); a payment that still arrives for it
 *         is flagged "late payment", as for any closed order.
 *
 *   an unpaid FIRM-QUOTE order whose request does not point at it (the acceptance stopped between
 *   the order and the request's "accepted" mark)
 *       → closed the same way; the quote link is still open, so the buyer accepts again.
 *
 *   a PAID (or in-work) order with fewer lines than its quote has
 *       → flagged for the owner ("order-incomplete") with what is missing; the shop is emailed
 *         once. Nothing is cancelled and nothing is guessed: the quote still holds every line.
 *
 * Every order looked at gets its line count written (orders.line_count), so it is looked at once.
 * An order made by the current code is written WITH its line count, and the same check then proves
 * that every order still has the lines it was written with.
 *
 * One query finds the candidates; no part and no quote line is read unless a count is missing.
 */
const { ordersDB, quotesDB } = require("../models");
const orderQueries = require("../models/orderQueries");
const orderState = require("./orderState");

const sqlRows = (db, sql, params = []) => (typeof db._query === "function" ? db._query(sql, params) : null);

/** How many lines a quote has, from the count kept beside the row or (older rows) from its lines. */
function quoteLineCount(row) {
  if (row.part_count !== null && row.part_count !== undefined && Number.isFinite(Number(row.part_count))) return Number(row.part_count);
  const quote = quotesDB.getById(row.quote_id);
  return quote && Array.isArray(quote.lineItems) ? quote.lineItems.length : null;
}

/**
 * Look at every order whose line count has not been recorded, or no longer matches its lines.
 * Synchronous; one change to the database.
 * @returns {{ checked: number, closed: Array<{id, lines, expected}>, flagged: Array<{id, lines, expected}> }}
 */
function checkOrders({ log = console } = {}) {
  const result = { checked: 0, closed: [], flagged: [] };
  const rows = sqlRows(ordersDB, `
    SELECT o.id, o.status, o.quote_id, o.rfq_id, o.payment_method, o.attention, o.line_count, o.total,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines,
           q.status AS quote_status, q.part_count, r.status AS rfq_status, r.order_id AS rfq_order_id
      FROM orders o LEFT JOIN quotes q ON q.id = o.quote_id LEFT JOIN rfqs r ON r.id = o.rfq_id
     WHERE o.line_count IS NULL
        OR o.line_count != (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)`);
  if (!rows || rows.length === 0) return result;
  const lifecycle = require("./orderLifecycle");
  require("../models/database").transaction(() => {
    for (const row of rows) {
      result.checked++;
      const lines = Number(row.lines) || 0;
      const recorded = row.line_count === null || row.line_count === undefined ? null : Number(row.line_count);
      const fromQuote = row.quote_id && !row.rfq_id; // an instant-quote order: its quote says how many lines it has
      // How many lines it should have: what it was written with, else what its quote has.
      const expected = recorded !== null ? recorded : (fromQuote && row.quote_status ? quoteLineCount(row) : null);
      const short = expected !== null && lines < expected;
      // (An unpaid order whose quote is still a draft never finished being written either: the quote
      // is marked "ordered" last. An order that LAPSED has its quote back as a draft by design.)
      const neverFinished = recorded === null && fromQuote && row.status === "pending_payment" && row.quote_status === "draft";
      // A firm-quote order whose request never came to point at it: the acceptance (order, lines, the
      // request marked accepted) stopped part way. The buyer was never told it was accepted.
      const orphanFirm = recorded === null && Boolean(row.rfq_id) && row.rfq_order_id !== row.id && ["pending_payment", "pending_po"].includes(row.status);
      if (orphanFirm) {
        if (row.status === "pending_payment") lifecycle.closePartialOrder(row.id, "closed at start-up: the acceptance of its firm quote was only partly written before the server stopped");
        else {
          ordersDB.update(row.id, { status: "cancelled", cancelledAt: new Date().toISOString() });
          lifecycle.recordEvent({ kind: "order-cancelled", order: { id: row.id }, detail: "closed at start-up: the acceptance of its firm quote was only partly written before the server stopped" });
        }
        result.closed.push({ id: row.id, lines, expected });
      } else if (row.status === "pending_payment" && (short || neverFinished) && (!row.payment_method || row.payment_method === "card")) {
        lifecycle.closePartialOrder(row.id, `closed at start-up: only ${lines} of ${expected ?? "its"} lines were written before the server stopped`);
        result.closed.push({ id: row.id, lines, expected });
      } else if (short && row.status !== "expired" && row.status !== "cancelled" && !row.attention) {
        const note = `This order lists ${lines} of the ${expected} lines of its quote: it was only partly written before the server stopped, and was ${orderState.wasPlaced({ status: row.status, paidAt: row.status === "pending_po" ? null : "x" }) ? "paid for" : "placed"} at the full total. The missing lines are on its quote (${String(row.quote_id || "").slice(0, 8)}). Check with the customer before building, then clear this flag with a note.`;
        ordersDB.update(row.id, { attention: "order-incomplete", attentionNote: note, attentionAt: new Date().toISOString() });
        lifecycle.recordEvent({ kind: "order-incomplete", order: { id: row.id }, detail: note, notified: false });
        result.flagged.push({ id: row.id, lines, expected, note });
      }
      // Looked at: not looked at again unless its lines change.
      ordersDB._run("UPDATE orders SET line_count = ? WHERE id = ?", [lines, row.id]);
    }
  });
  for (const c of result.closed) log.warn(`Order check: order ${String(c.id).slice(0, 8)} was only partly written (${c.lines} of ${c.expected ?? "?"} lines) and unpaid: closed as "not paid, closed". Its quote can be checked out again.`);
  for (const f of result.flagged) log.error(`Order check: order ${String(f.id).slice(0, 8)} holds ${f.lines} of the ${f.expected} lines of its quote and is not unpaid: FLAGGED for the owner (order-incomplete).`);
  return result;
}

/**
 * After start-up: close at Stripe any payment page of the orders checkOrders() closed, and email the
 * shop about each order it flagged. Never throws.
 */
async function closeLeftovers(result, { base } = {}) {
  if (!result) return;
  const lifecycle = require("./orderLifecycle");
  for (const c of result.closed) {
    try { await lifecycle.closeOpenSessions(c.id, { base }); } catch (err) { console.error(`Order check: could not close a payment page of order ${String(c.id).slice(0, 8)}: ${err.code || err.name || "Error"}`); }
  }
  for (const f of result.flagged) {
    const order = ordersDB.getById(f.id);
    if (!order) continue;
    await lifecycle.tellShop(require("../emails/paymentTemplates").paymentAttentionShop({ order, kind: "order-incomplete", note: f.note, adminUrl: `${base || require("./orderEvents").baseUrl()}/admin` }));
  }
}

module.exports = { checkOrders, closeLeftovers, itemsOf: orderQueries.itemsOf };
