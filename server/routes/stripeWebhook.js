/**
 * Stripe Webhook handler.
 * Processes checkout.session.completed events to confirm payment.
 *
 * IMPORTANT: This route receives raw body (not JSON-parsed) because
 * Stripe requires the raw body for signature verification.
 * The raw body middleware is applied in server/index.js BEFORE express.json().
 *
 * SECURITY:
 * - In production, webhook signature verification is REQUIRED
 * - Payment amount is verified against stored order total
 * - Idempotent: only updates orders still in pending_payment status
 */
const express = require("express");
const { ordersDB, quotesDB } = require("../models");

const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post("/", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Stripe not configured" });
  }

  let event;

  // âââ Signature Verification ââââââââââââââââââââââââââââââââââ
  if (webhookSecret) {
    const sig = req.headers["stripe-signature"];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }
  } else if (process.env.NODE_ENV === "production") {
    // CRITICAL: In production, NEVER accept unsigned webhooks
    console.error("SECURITY: Webhook received without STRIPE_WEBHOOK_SECRET configured in production");
    return res.status(500).json({ error: "Webhook secret not configured" });
  } else {
    // Development only: parse raw body (no signature check)
    console.warn("WARNING: Processing webhook without signature verification (dev mode only)");
    try {
      event = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: "Invalid payload" });
    }
  }

  // âââ Handle checkout.session.completed ââââââââââââââââââââââââ
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

    // âââ Payment Amount Verification âââââââââââââââââââââââââââââ
    // Verify the amount paid matches what we expect
    const paidAmountCents = session.amount_total;
    // The order persists its expected price in `total` (set at checkout-session
    // creation); `orderTotal` is a quote-level field NOT stored on the order row,
    // so we must read `total` here or this reconciliation guard never runs.
    const expectedAmountCents = Math.round((order.total || order.orderTotal || 0) * 100);

    if (paidAmountCents && expectedAmountCents > 0) {
      // Allow a small tolerance (1 cent) for rounding differences
      if (Math.abs(paidAmountCents - expectedAmountCents) > 1) {
        console.error(
          `Webhook: Payment amount mismatch for order ${orderId}. ` +
          `Paid: ${paidAmountCents} cents, Expected: ${expectedAmountCents} cents`
        );
        // Still mark as paid but flag for manual review
        ordersDB.update(orderId, {
          status: "paid_amount_mismatch",
          stripePaymentIntentId: session.payment_intent || "",
          paidAt: new Date().toISOString(),
          paidAmountCents,
          expectedAmountCents,
          needsReview: true,
        });
        console.warn("Order " + orderId + " marked for review due to amount mismatch");
        return res.json({ received: true, warning: "amount_mismatch" });
      }
    }

    // Only update if still pending (idempotent)
    if (order.status === "pending_payment") {
      ordersDB.update(orderId, {
        status: "paid",
        stripePaymentIntentId: session.payment_intent || "",
        paidAt: new Date().toISOString(),
        paidAmountCents: paidAmountCents || null,
      });
      console.log("Order " + orderId + " marked as paid via Stripe webhook");
    } else {
      console.log("Webhook: Order " + orderId + " already in status " + order.status + " â skipping");
    }
  }

  // Acknowledge receipt
  res.json({ received: true });
});

module.exports = router;
