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
 * SHIPPING is inside `order.total`: it is worked out at checkout, on the server, for the
 * delivery choice the buyer made (services/checkout.js) and written into the total with
 * the order. It is its own line on Stripe's page; it is not added here a second time.
 *
 * SALES TAX is the one amount that is not ours to compute: with Stripe Tax on, Stripe adds
 * it on its page, on top of the lines we send. So the expected charge is the order's total
 * BEFORE tax (services/tax.js preTaxCents). Before payment an order carries no tax and this
 * is `order.total`; after payment the tax Stripe reported is stored on the order and added
 * to its total, and this is still what the lines came to. The settle check takes Stripe's
 * tax back out of what was charged before comparing (orderLifecycle.checkSession).
 *
 * Anything else that is ever charged on top goes HERE, in `components`, and nowhere else:
 * the session, the webhook check and session reuse all read this function.
 */
const tax = require("./tax");

/** A dollar amount as whole cents; anything that is not a finite number is 0. */
function toCents(dollars) {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** The parts of the expected charge, in cents. Their sum is the charge. */
function components(order) {
  return {
    // The order's total before tax, in whole cents; anything that is not an amount of money is 0.
    orderTotal: order ? toCents(tax.preTaxCents(order) / 100) : 0,
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
