/**
 * Order lifecycle: the Stripe checkout boundary, marking an order paid, and
 * the emails that go with each step. Used by the order routes, the RFQ accept
 * routes and the Stripe webhook so the three can't drift apart.
 *
 * Emails are best-effort: mailer.send never throws and is a logged no-op until
 * the email env vars are set.
 */
const { ordersDB, orderItemsDB, usersDB, rfqsDB } = require("../models");
const brand = require("../../shared/brand.json");
const mailer = require("./mailer");
const templates = require("../emails/templates");
const shipBy = require("./shipBy");
const rfqToken = require("./rfqToken");
const stripeClient = require("./stripeClient");
const { accountLinkBase } = require("../security/links");
const tax = require("./tax");
const shipping = require("./shipping");

const ORDER_LINK_DAYS = 180; // how long an emailed order link for an account-less (RFQ) buyer keeps working

/**
 * Base URL for links we email and for Stripe's return URLs. Firm-quote links
 * carry a credential, so the host is not taken on trust from the request:
 * FRONTEND_URL, else the request's host only if it is one of ours, else the
 * brand URL (security/links.js).
 */
function baseUrl(req) {
  return accountLinkBase(req);
}

function itemsFor(order) {
  return orderItemsDB.query((i) => i.orderId === order.id);
}

function customerEmail(order) {
  if (order.customerEmail) return order.customerEmail;
  const user = order.userId ? usersDB.getById(order.userId) : null;
  return user?.email || "";
}

/** Link the customer can open to see the order: their account page, or the signed quote link for RFQ buyers. */
function orderUrl(order, base) {
  if (order.rfqId) {
    const rfq = rfqsDB.getById(order.rfqId);
    if (rfq && rfq.quoteSentAt) {
      const until = new Date(Date.now() + ORDER_LINK_DAYS * 864e5).toISOString();
      return `${base}/firm-quote/${rfqToken.sign({ ...rfq, validUntil: until })}`;
    }
  }
  return `${base}/orders/${order.id}`;
}

// ─── Stripe boundary ───────────────────────────────────────────

/**
 * What the buyer sees on Stripe's page, as [{ kind, line }]: the order, the inspection paperwork
 * as its own line when it was ordered with a fee, and shipping as its own line when it is
 * charged by a method other than the original weight formula (or whenever Stripe Tax is on, so
 * the shipping line can carry its own tax treatment). With every switch at its default this is
 * the one or two lines it always was. The lines always sum, in cents, to the order's total
 * before tax, which is what settleFromSession checks the payment against.
 */
function orderLines(order, { itemCount, description }) {
  const totalCents = tax.preTaxCents(order);
  const feeCents = order.paperwork ? Math.min(totalCents, Math.max(0, Math.round((Number(order.paperworkFee) || 0) * 100))) : 0;
  const shipCents = shipping.stripeShippingCents(order, totalCents - feeCents);
  const line = (name, text, cents) => ({
    price_data: { currency: "usd", product_data: { name, description: text }, unit_amount: cents }, // Stripe uses cents
    quantity: 1,
  });
  const lines = [{ kind: "goods", line: line(`${brand.name} Order — ${itemCount} part${itemCount !== 1 ? "s" : ""}`, description || "Custom machined and printed parts", totalCents - feeCents - shipCents) }];
  if (feeCents > 0) lines.push({ kind: "paperwork", line: line(templates.PAPERWORK_LABEL, "Ships with the parts", feeCents) });
  if (shipCents > 0) { const words = shipping.stripeShippingLine(order); lines.push({ kind: "shipping", line: line(words.name, words.description, shipCents) }); }
  return lines;
}
function stripeLineItems(order, opts) {
  return orderLines(order, opts).map((l) => l.line);
}

/**
 * Create a Stripe Checkout session for an order's total and remember its id.
 * Throws if Stripe isn't configured or the API call fails.
 *
 * An order checked out with Stripe Tax on (order.taxMode "stripe") gets `automatic_tax`, a
 * Stripe Customer carrying the address it is taxed at, and tax-exclusive lines
 * (services/tax.js). Any other order is sent exactly as before.
 */
async function createCheckoutSession(order, { itemCount, description, successUrl, cancelUrl, metadata = {} }) {
  const stripe = stripeClient.get();
  if (!stripe) throw Object.assign(new Error("Payment processing is not configured"), { status: 503 });
  // null for an order with tax off. An address Stripe cannot place is thrown as { code: "tax-address", status: 400 }.
  const taxed = await tax.stripeParams(stripe, order, customerEmail(order), require("./checkout").currentRules());
  const lines = orderLines(order, { itemCount, description }).map(({ kind, line }) => (taxed ? taxed.decorate(line, kind) : line));
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    ...(taxed ? taxed.session : { customer_email: customerEmail(order) || undefined }),
    line_items: lines,
    metadata: { orderId: order.id, ...metadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });
  ordersDB.update(order.id, { stripeSessionId: session.id });
  return session;
}

// ─── Paid ──────────────────────────────────────────────────────

/**
 * Mark a pending order paid, fix its ship-by date from the payment day, and
 * send the confirmation + shop notification. Idempotent: an order that isn't
 * pending is returned untouched and nothing is re-sent.
 */
async function markPaid(order, { base, warning, taxCents = 0, taxIds = "" } = {}) {
  if (order.status !== "pending_payment") return { order, changed: false };
  const updates = { status: warning ? "paid_amount_mismatch" : "paid", paidAt: new Date().toISOString() };
  // Sales tax Stripe added on its page: stored on the order and added to its total (services/tax.js).
  Object.assign(updates, tax.paidUpdates(order, { taxCents, taxIds }));
  if (order.leadDays !== null && order.leadDays !== undefined) updates.shipBy = shipBy.shipByDate(Number(order.leadDays));
  const paid = ordersDB.update(order.id, updates);
  const items = itemsFor(paid);
  const url = base || baseUrl();
  const to = customerEmail(paid);
  await Promise.all([
    // A mismatched amount goes to the shop for review first; the customer hears from a person.
    !warning && to
      ? mailer.send({ to, replyTo: mailer.shopNotifyAddress(), ...templates.orderConfirmation({ order: paid, items, orderUrl: orderUrl(paid, url) }) })
      : null,
    mailer.send({ to: mailer.shopNotifyAddress(), replyTo: to || undefined, ...templates.newOrderShop({ order: paid, items, adminUrl: `${url}/admin`, warning }) }),
  ]);
  return { order: paid, changed: true };
}

/**
 * Settle an order from a Stripe Checkout session (webhook or return-page
 * confirmation). What the lines came to BEFORE discounts and BEFORE tax must
 * match the order's total before tax: a promo code lowers amount_total but not
 * amount_subtotal, and sales tax raises amount_total but not amount_subtotal
 * (our prices are tax-exclusive). So a taxed order is not a mismatch; the tax
 * Stripe reports is stored on the order.
 */
async function settleFromSession(order, session, { base } = {}) {
  if (session.payment_status && session.payment_status !== "paid") return { order, changed: false };
  const expected = tax.preTaxCents(order);
  const read = tax.taxFromSession(session);
  const charged = read.preTaxCents;
  const paid = { base, taxCents: read.taxCents, taxIds: read.taxIds };
  if (charged && expected > 0 && Math.abs(charged - expected) > 1) {
    console.error(`Payment amount mismatch for order ${order.id}: session ${charged} cents, expected ${expected} cents`);
    const r = await markPaid(order, { ...paid, warning: `Needs review: Stripe charged ${templates.money(charged / 100)} before discounts${read.taxCents ? " and tax" : ""} but the order total is ${templates.money(expected / 100)}.` });
    return { ...r, warning: "amount_mismatch" };
  }
  return markPaid(order, paid);
}

/** Ask Stripe whether a pending order's checkout session was paid, and settle it if so. */
async function confirmPayment(order, { base } = {}) {
  if (order.status !== "pending_payment" || !order.stripeSessionId) return { order, changed: false };
  const stripe = stripeClient.get();
  if (!stripe) return { order, changed: false };
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
  return settleFromSession(order, session, { base });
}

// ─── Shipped ───────────────────────────────────────────────────

/**
 * Email the customer when an order ships: on the move to "shipped", and once
 * more if a tracking number is added to an order that shipped without one.
 */
async function notifyStatusChange(before, after, { base } = {}) {
  if (after.status !== "shipped") return false;
  const justShipped = before.status !== "shipped";
  const trackingAdded = !before.trackingNumber && Boolean(after.trackingNumber);
  if (!justShipped && !trackingAdded) return false;
  const to = customerEmail(after);
  if (!to) return false;
  const url = base || baseUrl();
  await mailer.send({ to, replyTo: mailer.shopNotifyAddress(), ...templates.orderShipped({ order: after, items: itemsFor(after), orderUrl: orderUrl(after, url) }) });
  return true;
}

module.exports = { baseUrl, itemsFor, customerEmail, orderUrl, stripeLineItems, orderLines, createCheckoutSession, markPaid, settleFromSession, confirmPayment, notifyStatusChange };
