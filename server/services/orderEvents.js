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

const ORDER_LINK_DAYS = 180; // how long an emailed order link for an account-less (RFQ) buyer keeps working

function baseUrl(req) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/$/, "");
  return req ? `${req.protocol}://${req.get("host")}` : brand.url;
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
 * What the buyer sees on Stripe's page: the order, and the inspection paperwork
 * as its own line when it was ordered with a fee. The lines always sum to
 * order.total in cents, which is what settleFromSession checks the payment against.
 */
function stripeLineItems(order, { itemCount, description }) {
  const totalCents = Math.round((order.total || 0) * 100);
  const feeCents = order.paperwork ? Math.min(totalCents, Math.max(0, Math.round((Number(order.paperworkFee) || 0) * 100))) : 0;
  const line = (name, text, cents) => ({
    price_data: { currency: "usd", product_data: { name, description: text }, unit_amount: cents }, // Stripe uses cents
    quantity: 1,
  });
  const lines = [line(`${brand.name} Order — ${itemCount} part${itemCount !== 1 ? "s" : ""}`, description || "Custom machined and printed parts", totalCents - feeCents)];
  if (feeCents > 0) lines.push(line(templates.PAPERWORK_LABEL, "Ships with the parts", feeCents));
  return lines;
}

/**
 * Create a Stripe Checkout session for an order's total and remember its id.
 * Throws if Stripe isn't configured or the API call fails.
 */
async function createCheckoutSession(order, { itemCount, description, successUrl, cancelUrl, metadata = {} }) {
  const stripe = stripeClient.get();
  if (!stripe) throw Object.assign(new Error("Payment processing is not configured"), { status: 503 });
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: customerEmail(order) || undefined,
    line_items: stripeLineItems(order, { itemCount, description }),
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
async function markPaid(order, { base, warning } = {}) {
  if (order.status !== "pending_payment") return { order, changed: false };
  const updates = { status: warning ? "paid_amount_mismatch" : "paid", paidAt: new Date().toISOString() };
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
 * confirmation). The pre-discount amount must match the order total; a promo
 * code lowers amount_total but not amount_subtotal.
 */
async function settleFromSession(order, session, { base } = {}) {
  if (session.payment_status && session.payment_status !== "paid") return { order, changed: false };
  const expected = Math.round((order.total || 0) * 100);
  const charged = session.amount_subtotal ?? session.amount_total;
  if (charged && expected > 0 && Math.abs(charged - expected) > 1) {
    console.error(`Payment amount mismatch for order ${order.id}: session ${charged} cents, expected ${expected} cents`);
    const r = await markPaid(order, { base, warning: `Needs review: Stripe charged ${templates.money(charged / 100)} before discounts but the order total is ${templates.money(order.total)}.` });
    return { ...r, warning: "amount_mismatch" };
  }
  return markPaid(order, { base });
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

module.exports = { baseUrl, itemsFor, customerEmail, orderUrl, stripeLineItems, createCheckoutSession, markPaid, settleFromSession, confirmPayment, notifyStatusChange };
