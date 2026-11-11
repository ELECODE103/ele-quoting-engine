/**
 * Stripe Webhook handler.
 * Processes checkout.session.completed events to confirm payment.
 *
 * IMPORTANT: This route receives raw body (not JSON-parsed) because
 * Stripe requires the raw body for signature verification.
 * The raw body middleware is applied in server/index.js BEFORE express.json().
 *
 * SECURITY:
 * - Signature verification is REQUIRED. An unsigned event is refused unless the
 *   explicit test switch is set (SE_TEST_HOOKS=1, security/testHooks.js) — and
 *   in production it is refused even then. NODE_ENV being unset is not a reason
 *   to accept one: a server started without `npm start` has no NODE_ENV.
 * - Payment amount (before promo discounts) is verified against stored order total
 * - Idempotent: only updates orders still in pending_payment status
 * - On payment: order confirmation to the customer, new-order notice to the shop
 */
const express = require("express");
const { ordersDB } = require("../models");
const stripeClient = require("../services/stripeClient");
const orderEvents = require("../services/orderEvents");

const router = express.Router();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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
    // No secret, no way to tell Stripe from anyone else: refuse. (Orders are still
    // settled when the buyer returns to the order page, which asks Stripe directly.)
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

  // ─── Handle checkout.session.completed ────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;

    if (!orderId) {
      console.error("Webhook: No orderId in session metadata");
      return res.status(400).json({ error: "Missing orderId" });
    }

    const order = ordersDB.getById(orderId);
    if (!order) {
      console.error("Webhook: Order " + orderId + " not found");
      return res.status(404).json({ error: "Order not found" });
    }

    // Amount check, paid status, ship-by date and the confirmation emails all
    // live in orderEvents so this path and the return-page confirmation agree.
    // Idempotent: an order that is no longer pending is left alone.
    const result = await orderEvents.settleFromSession(order, session, { base: orderEvents.baseUrl(req) });
    if (result.warning) {
      console.warn("Order " + orderId + " marked for review due to amount mismatch");
      return res.json({ received: true, warning: result.warning });
    }
    console.log(result.changed
      ? "Order " + orderId + " marked as paid via Stripe webhook"
      : "Webhook: Order " + orderId + " already in status " + order.status + " — skipping");
  }

  // Acknowledge receipt
  res.json({ received: true });
});

module.exports = router;
