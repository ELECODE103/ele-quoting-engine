/**
 * Stripe Webhook handler.
 * Processes checkout.session.completed events to confirm payment.
 *
 * IMPORTANT: This route receives raw body (not JSON-parsed) because
 * Stripe requires the raw body for signature verification.
 * The raw body middleware is applied in server/index.js BEFORE express.json().
 */
const express = require("express");
const { ordersDB } = require("../models");

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

  // Verify webhook signature if secret is configured
  if (webhookSecret) {
    const sig = req.headers["stripe-signature"];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }
  } else {
    // In development/test mode without webhook secret, parse body directly
    try {
      event = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: "Invalid payload" });
    }
  }

  // Handle the checkout.session.completed event
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

    // Only update if still pending
    if (order.status === "pending_payment") {
      ordersDB.update(orderId, {
        status: "paid",
        stripePaymentIntentId: session.payment_intent || "",
        paidAt: new Date().toISOString(),
      });
      console.log("Order " + orderId + " marked as paid via Stripe webhook");
    }
  }

  // Acknowledge receipt
  res.json({ received: true });
});

module.exports = router;
