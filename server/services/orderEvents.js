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
const { expectedCharge } = require("./expectedCharge");

// Sessions, settling, refunds, disputes and expiry live in services/orderLifecycle.js, which
// uses this module for the emails; it is loaded on first use so neither waits on the other.
const lifecycle = () => require("./orderLifecycle");

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
 * What the buyer sees on Stripe's page: the order, and the inspection paperwork
 * as its own line when it was ordered with a fee. The lines always sum to
 * order.total in cents, which is what settleFromSession checks the payment against.
 */
function stripeLineItems(order, { itemCount, description }) {
  const charge = expectedCharge(order); // the one "expected charge" (services/expectedCharge.js)
  const totalCents = typeof charge === "number" ? Math.round(charge * 100) : charge.cents;
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
 * The Stripe Checkout session to send the buyer to for an unpaid order. An order has at most
 * one open session: the one it already has is handed out again while it is still good, and
 * otherwise closed at Stripe before a new one is made (services/orderLifecycle.js). Two calls
 * at the same moment share one session. Throws if Stripe isn't configured, the call fails, or
 * the order is not waiting for a card payment.
 *
 * `returnKey` names the pair of return pages when their URLs carry something that changes
 * from call to call (a firm quote's return token), so the session can still be recognised.
 */
function createCheckoutSession(order, { itemCount, description, successUrl, cancelUrl, metadata = {}, returnKey, base }) {
  return lifecycle().checkoutSession(order, { itemCount, description, successUrl, cancelUrl, metadata, returnKey, base });
}

// ─── Paid ──────────────────────────────────────────────────────

/**
 * Move an order from "awaiting payment" to "paid" and fix its ship-by date from the payment
 * day. Synchronous, on the order as it is in the database now: read and written in one step,
 * so two callers cannot both make the move. Returns the paid order, or null when the order is
 * no longer waiting (someone else settled it, or it was cancelled).
 */
function transitionToPaid(order, updates = {}) {
  const fresh = ordersDB.getById(order.id);
  if (!fresh || fresh.status !== "pending_payment") return null;
  const next = { ...updates, status: "paid", paidAt: new Date().toISOString() };
  if (fresh.leadDays !== null && fresh.leadDays !== undefined) next.shipBy = shipBy.shipByDate(Number(fresh.leadDays));
  return ordersDB.update(fresh.id, next);
}

/** The confirmation to the customer and the new-order notice to the shop, for an order just paid. */
async function sendPaidEmails(paid, { base } = {}) {
  const items = itemsFor(paid);
  const url = base || baseUrl();
  const to = customerEmail(paid);
  await Promise.all([
    to ? mailer.send({ to, replyTo: mailer.shopNotifyAddress(), ...templates.orderConfirmation({ order: paid, items, orderUrl: orderUrl(paid, url) }) }) : null,
    mailer.send({ to: mailer.shopNotifyAddress(), replyTo: to || undefined, ...templates.newOrderShop({ order: paid, items, adminUrl: `${url}/admin` }) }),
  ]);
}

/**
 * Mark a pending order paid and send the confirmation + shop notification. Idempotent: an
 * order that isn't pending is returned untouched and nothing is re-sent. Payments from Stripe
 * do not come through here directly: they are checked first (settleFromSession).
 */
async function markPaid(order, { base, updates } = {}) {
  const paid = transitionToPaid(order, updates);
  if (!paid) return { order: ordersDB.getById(order.id) || order, changed: false };
  await sendPaidEmails(paid, { base });
  return { order: paid, changed: true };
}

/**
 * Settle an order from a Stripe Checkout session (webhook or return-page confirmation).
 * The session must be one we opened for this order, report payment_status "paid", and carry an
 * integer amount_total that equals the expected charge (services/expectedCharge.js) less the
 * discount Stripe reports, in the order's currency. Anything else is not marked paid: the
 * order is flagged and the shop emailed. A payment for an order that is already paid,
 * cancelled or expired is recorded and flagged, never dropped. See services/orderLifecycle.js.
 */
function settleFromSession(order, session, { base, eventId, source } = {}) {
  return lifecycle().settleFromSession(order, session, { base, eventId, source });
}

/** Ask Stripe whether a pending order's checkout session was paid, and settle it if so. */
function confirmPayment(order, { base } = {}) {
  return lifecycle().confirmPayment(order, { base });
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

module.exports = { baseUrl, itemsFor, customerEmail, orderUrl, stripeLineItems, createCheckoutSession, transitionToPaid, sendPaidEmails, markPaid, settleFromSession, confirmPayment, notifyStatusChange };
