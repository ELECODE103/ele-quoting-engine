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
