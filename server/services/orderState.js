/**
 * The order payment state machine, in one place. Nothing here touches the database or Stripe:
 * it only says which states exist, what may move an order from one to another, and what is
 * refused. services/orderLifecycle.js carries the moves out.
 *
 * STATES (order.status)
 *
 *   pending_payment   an order with a Stripe Checkout session; nothing collected yet
 *   pending_po        accepted on a purchase order; nothing charged; the shop confirms the PO
 *   paid              money in (card), or marked paid by the owner with a typed reason
 *   received … delivered   the shop's own steps once the order is being worked on
 *   expired           never paid; its session lapsed. The quote can be used again.
 *   cancelled         called off by the shop
 *   refunded          the whole payment was refunded in Stripe
 *   paid_amount_mismatch   written by earlier versions only; nothing produces it now. It can
 *                     be shown and it can be resolved by hand (to paid, cancelled or refunded).
 *
 * FLAGS (not states; an order keeps its state while flagged)
 *
 *   attention         a short code while the order needs the owner (ATTENTION below)
 *   refundedAmount    > 0 and less than the amount paid: partially refunded, still active
 *   disputeStatus     "open" | "won" | "lost" | "closed"
 *
 * WHO MOVES AN ORDER
 *
 *   automatic (AUTOMATIC)  a verified Stripe payment, a Stripe refund, a lapsed session.
 *                          Never reachable through the admin status route.
 *   manual (MANUAL)        the owner, through PUT /api/orders/:id/status. A move that is not
 *                          in the table is refused (`transition-not-allowed`); a move to
 *                          "paid" of an order with no payment on record, and any move to
 *                          "refunded", needs a typed reason (`reason-required`).
 */

/** The shop's steps for an order it is working on, in order. */
const FULFILMENT = ["paid", "received", "in_production", "quality_check", "packing", "shipped", "delivered"];

const STATES = ["pending_payment", "pending_po", ...FULFILMENT, "expired", "cancelled", "refunded", "paid_amount_mismatch"];

/** Orders the shop still has to build or ship (the production queue). */
const WORK_QUEUE = ["pending_po", "paid", "received", "in_production", "quality_check", "packing"];

/** Money was taken (or the PO accepted) and the order has not been called off. */
const ACTIVE = [...FULFILMENT];

/** What the system does on its own, and what causes it. */
const AUTOMATIC = [
  { from: "(none)", to: "pending_payment", cause: "POST /api/orders/checkout-session; POST /api/rfq/quote/:token/accept (card)" },
  { from: "(none)", to: "pending_po", cause: "POST /api/rfq/quote/:token/accept (purchase order)" },
  { from: "pending_payment", to: "paid", cause: "checkout.session.completed, or a confirm-payment route, when every payment check passes" },
  { from: "pending_payment", to: "expired", cause: "checkout.session.expired for the order's only session, or the sweep once the session's expiry has passed" },
  { from: "paid … delivered", to: "refunded", cause: "charge.refunded / refund.updated when the whole payment has been refunded" },
];

const afterPaid = FULFILMENT.filter((s) => s !== "paid");

/** What the owner may do by hand: from → [to]. */
const MANUAL = {
  pending_payment: ["paid", "cancelled"],
  pending_po: ["received", "in_production", "paid", "cancelled"],
  paid: [...afterPaid, "cancelled", "refunded"],
  received: [...FULFILMENT.filter((s) => s !== "received"), "cancelled", "refunded"],
  in_production: [...FULFILMENT.filter((s) => s !== "in_production"), "cancelled", "refunded"],
  quality_check: [...FULFILMENT.filter((s) => s !== "quality_check"), "cancelled", "refunded"],
  packing: [...FULFILMENT.filter((s) => s !== "packing"), "cancelled", "refunded"],
  shipped: [...FULFILMENT.filter((s) => s !== "shipped"), "refunded"],
  delivered: [...FULFILMENT.filter((s) => s !== "delivered"), "refunded"],
  expired: ["paid", "cancelled"],
  cancelled: ["paid"],
  refunded: [],
  paid_amount_mismatch: ["paid", "cancelled", "refunded"],
};

/** Why an order needs the owner. The value is what the admin list shows. */
const ATTENTION = {
  "duplicate-payment": "Duplicate payment",
  "late-payment": "Late payment",
  "payment-mismatch": "Payment does not match the order",
  "zero-payment": "Nothing was collected",
  dispute: "Payment disputed",
  "refund-problem": "Refund problem",
  // A line's part file is not the file that was priced (services/partLock.js). The order keeps its state.
  "part-changed": "Part file changed after it was priced",
  // Fewer lines than its quote: written only in part before a crash of an earlier version (services/orderRepair.js).
  "order-incomplete": "Order is missing lines",
};

/** How an order marked paid by hand was paid. */
const MANUAL_PAID_METHODS = ["po", "cheque", "wire", "ach", "cash", "card-by-phone", "other"];

/** Was a payment ever recorded for this order? (An order moved on a PO has none.) */
function hasPaymentOnRecord(order) {
  return Boolean(order && order.paidAt);
}

/**
 * Did this order ever become a real order? Paid at some point (still paid, in work, shipped,
 * refunded afterwards, or cancelled after payment), or accepted on a purchase order and taken into
 * work by the shop. An order still awaiting payment or a PO confirmation, one that lapsed unpaid,
 * and one cancelled before any payment never did. Reorder is offered only for the first kind
 * (re-review RR-14: an abandoned checkout was a free ticket to the re-pricing route).
 */
function wasPlaced(order) {
  if (!order) return false;
  if (hasPaymentOnRecord(order)) return true;
  return FULFILMENT.includes(order.status) || order.status === "refunded";
}

/**
 * May the owner move this order to `to` by hand?
 * @returns {{ok: true, needsReason: boolean} | {ok: false, code: string, error: string}}
 */
function manualTransition(order, to) {
  const from = order && order.status;
  if (!STATES.includes(to)) return { ok: false, code: "status-unknown", error: "That is not an order status." };
  if (from === to) return { ok: true, needsReason: false, same: true };
  const allowed = MANUAL[from] || [];
  if (!allowed.includes(to)) {
    return { ok: false, code: "transition-not-allowed", error: `An order that is "${label(from)}" cannot be moved to "${label(to)}" by hand.` };
  }
  // "paid" with nothing on record is the owner vouching for money that arrived another way.
  const needsReason = (to === "paid" && !hasPaymentOnRecord(order)) || to === "refunded";
  return { ok: true, needsReason, same: false };
}

const LABELS = {
  pending_payment: "awaiting payment",
  pending_po: "PO to confirm",
  paid: "paid",
  received: "received",
  in_production: "in production",
  quality_check: "quality check",
  packing: "packing",
  shipped: "shipped",
  delivered: "delivered",
  expired: "expired",
  cancelled: "cancelled",
  refunded: "refunded",
  paid_amount_mismatch: "paid, under review",
};
function label(status) {
  return LABELS[status] || String(status || "").replace(/_/g, " ");
}

/**
 * One quote, one order (instant path). Does this order still hold the quote it was made from?
 * Every order does, except one that lapsed unpaid: its quote was given back when it lapsed
 * (orderLifecycle.releaseSource) and can be checked out again. A cancelled order keeps its quote —
 * the owner can still mark it paid — unless it had already lapsed before it was cancelled.
 * A refunded order keeps its quote too: buying the same parts again is Reorder, at today's price.
 */
function holdsQuote(order) {
  if (!order) return false;
  if (order.status === "expired") return false;
  if (order.status === "cancelled" && order.expiredAt) return false;
  return true;
}

/** Is this order something the shop should be building? Refunded, expired and cancelled orders are not. */
function isWork(order) {
  return Boolean(order) && WORK_QUEUE.includes(order.status);
}

module.exports = { STATES, FULFILMENT, WORK_QUEUE, ACTIVE, AUTOMATIC, MANUAL, ATTENTION, MANUAL_PAID_METHODS, manualTransition, hasPaymentOnRecord, wasPlaced, holdsQuote, label, isWork };
