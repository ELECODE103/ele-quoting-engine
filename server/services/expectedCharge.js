/**
 * What an order is expected to charge — the ONE number every money path agrees on.
 *
 *   - the Stripe Checkout session is built to this amount (orderEvents.stripeLineItems)
 *   - a payment is accepted only when Stripe reports this amount, before any promotion
 *     code (orderEvents.settleFromSession: the webhook and the return-page confirmation)
 *   - an unpaid session is reused only when it was made for this amount
 *
 * Today the expected charge is the order total: `order.total` is written by the
 * server from a quote it has just priced again (routes/orders.js) or from the
 * owner's firm-quote amount (routes/rfq.js), and already contains every line the
 * order has (parts, lead-time fee, shipping, inspection paperwork).
 *
 * TAX AND SHIPPING: when an order gains amounts that are charged on top of
 * `order.total` (sales tax, a shipping line worked out at checkout), add them
 * HERE, in `components`, and nowhere else — the session, the webhook check and
 * session reuse all read this function.
 */

/** A dollar amount as whole cents; anything that is not a finite number is 0. */
function toCents(dollars) {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** The parts of the expected charge, in cents. Their sum is the charge. */
function components(order) {
  return {
    orderTotal: toCents(order && order.total),
    // tax: toCents(order.taxCharged), shipping: toCents(order.shippingCharged), …
  };
}

/**
 * @returns {{cents: number, dollars: number, components: object}}
 */
function expectedCharge(order) {
  const parts = components(order);
  const cents = Object.values(parts).reduce((sum, c) => sum + c, 0);
  return { cents, dollars: cents / 100, components: parts };
}

module.exports = { expectedCharge, toCents };
