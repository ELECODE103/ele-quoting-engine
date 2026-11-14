/**
 * Stripe webhook.
 *
 * IMPORTANT: this route receives the raw body (not JSON-parsed) because Stripe's signature is
 * over the exact bytes. The raw-body middleware is applied in server/index.js BEFORE express.json().
 *
 * SECURITY
 * - The signature is REQUIRED. Production does not start without STRIPE_WEBHOOK_SECRET
 *   (server/index.js). Outside production an unsigned event is refused unless the explicit
 *   test switch is set (SE_TEST_HOOKS=1, security/testHooks.js).
 * - An event is acted on once: Stripe's event id is kept (payment_events) and a second
 *   delivery of the same event is acknowledged without running again.
 *
 * EVENTS HANDLED (enable exactly these on the endpoint in the Stripe dashboard)
 *   checkout.session.completed   a payment: checked and settled, or flagged (services/orderLifecycle.js)
 *   checkout.session.expired     a session lapsed: the unpaid order is closed out as expired
 *   charge.refunded              a refund, full or partial
 *   refund.updated               a refund changed afterwards (it can fail days later)
 *   charge.dispute.created       a cardholder disputed a payment: flag and tell the shop at once
 *   charge.dispute.closed        the dispute was decided
 * Also understood if they arrive: checkout.session.async_payment_succeeded, refund.failed,
 * charge.refund.updated. Anything else is acknowledged and ignored.
 *
 * ANSWERS
 *   200  handled, already handled, or not for us (an event with no order of ours is ignored:
 *        answering an error would make Stripe retry it for days and can get the endpoint disabled)
 *   400  bad signature or unreadable body
 *   500  we failed while handling it: Stripe sends it again
 */
const express = require("express");
const { ordersDB } = require("../models");
const stripeClient = require("../services/stripeClient");
const orderEvents = require("../services/orderEvents");
const lifecycle = require("../services/orderLifecycle");

const router = express.Router();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/** Event types this endpoint acts on. The first six are the ones to enable in the Stripe dashboard. */
const HANDLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "charge.refunded",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
];
const ALSO_UNDERSTOOD = ["checkout.session.async_payment_succeeded", "refund.failed", "charge.refund.updated"];

/** A Stripe id as it may appear in a log line: its shape only, never free text. */
function logId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : "?";
}

async function handle(event, base) {
  const object = (event.data && event.data.object) || {};
  const ctx = { eventId: typeof event.id === "string" ? event.id : null, base };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const orderId = object.metadata && object.metadata.orderId;
      // A payment on this Stripe account that is not one of our orders (a payment link, another product): not ours to judge.
      if (!orderId || !ordersDB.getById(orderId)) {
        lifecycle.recordEvent({ eventId: ctx.eventId, kind: "unmatched", sessionId: typeof object.id === "string" ? object.id : null, amountCents: object.amount_total, detail: orderId ? "completed checkout names an order we do not have" : "completed checkout with no order id" });
        return { ignored: orderId ? "order-not-found" : "no-order-id" };
      }
      const result = await orderEvents.settleFromSession(orderId, object, { ...ctx, source: "webhook" });
      return { outcome: result.outcome, ...(result.warning ? { warning: result.warning } : {}) };
    }
    case "checkout.session.expired":
      return { outcome: lifecycle.handleSessionExpired(object, ctx).outcome };
    case "charge.refunded":
      return { outcome: (await lifecycle.handleChargeRefunded(object, ctx)).outcome };
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated":
      return { outcome: (await lifecycle.handleRefundUpdated(object, ctx)).outcome };
    case "charge.dispute.created":
      return { outcome: (await lifecycle.handleDispute(object, { ...ctx, phase: "opened" })).outcome };
    case "charge.dispute.closed":
      return { outcome: (await lifecycle.handleDispute(object, { ...ctx, phase: "closed" })).outcome };
    default:
      return { ignored: "event-type" };
  }
}

router.post("/", async (req, res) => {
  const stripe = stripeClient.get();
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  let event;

  // ─── Signature Verification ──────────────────────────────────
  if (webhookSecret) {
    const sig = req.headers["stripe-signature"];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }
  } else if (!require("../security/testHooks").unsignedWebhooksAllowed()) {
    // No secret, no way to tell Stripe from anyone else: refuse.
    console.error("SECURITY: Stripe webhook refused — STRIPE_WEBHOOK_SECRET is not configured, so the event cannot be verified");
    return res.status(503).json({ error: "Webhook secret not configured" });
  } else {
    // Test switch only: parse the raw body with no signature check.
    console.warn("WARNING: Processing a Stripe webhook without signature verification (SE_TEST_HOOKS test switch)");
    try {
      event = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: "Invalid payload" });
    }
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Stripe delivers an event at least once. One that has been handled is acknowledged, not run again.
  if (typeof event.id === "string" && lifecycle.eventSeen(event.id)) {
    // "Handled before" is read from memory. While the database file cannot be written (a full disk)
    // memory may be ahead of the disk, so the event is NOT acknowledged: Stripe sends it again later
    // (review of 2026-11-13, N-08).
    if (require("../models").USE_SQLITE && require("../models/database").saveState().failing) {
      res.set("Retry-After", "120");
      return res.status(503).json({ error: "Could not process the event" });
    }
    // Handled before: nothing is run again. But if the first handling was cut short after the
    // payment was written and before its emails went (a kill, a provider fault), they are still on
    // record as owed, and this second delivery is when they are sent (services/owedEmails.js).
    try { await require("../services/owedEmails").deliver({ orderId: lifecycle.orderOfEvent(event.id) || undefined }); } catch (err) { console.error(`Stripe webhook ${logId(event.id)}: owed emails: ${err.name || "Error"}`); }
    return res.json({ received: true, duplicate: true });
  }

  try {
    const result = await handle(event, orderEvents.baseUrl(req));
    // Every event leaves a row under its id, so a second delivery is recognised even when the first changed nothing.
    if (typeof event.id === "string" && !lifecycle.eventSeen(event.id)) lifecycle.recordEvent({ eventId: event.id, kind: "event", detail: `${event.type.slice(0, 60)}: ${result.outcome || result.ignored || "handled"}` });
    if (result.warning) console.warn(`Stripe webhook ${logId(event.id)} (${event.type}): order flagged, ${result.warning}`);
    res.json({ received: true, ...result });
  } catch (err) {
    // Not acknowledged: Stripe sends it again. Nothing from the event body is logged.
    console.error(`Stripe webhook ${logId(event.id)} (${String(event.type).slice(0, 60)}) failed: ${err.code || err.name || "Error"}`);
    res.status(500).json({ error: "Could not process the event" });
  }
});

module.exports = router;
module.exports.HANDLED_EVENTS = HANDLED_EVENTS;
module.exports.ALSO_UNDERSTOOD = ALSO_UNDERSTOOD;
