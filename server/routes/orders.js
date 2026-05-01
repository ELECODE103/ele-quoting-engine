/**
 * Order management routes.
 * Handles order creation from quotes, status updates, and order retrieval.
 */
const express = require("express");
const { ordersDB, orderItemsDB, quotesDB, partsDB } = require("../models");
const { authenticate, requireAdmin } = require("./auth");
const { sanitizeString, nonNegativeNumber } = require("../middleware/validate");

const router = express.Router();

// Initialize Stripe (only if key is configured)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/checkout-session — Create Stripe Checkout Session
// ═══════════════════════════════════════════════════════════════
router.post("/checkout-session", authenticate, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment processing is not configured" });
    }

    const {
      quoteId,
      shippingName,
      shippingAddress,
      shippingCity,
      shippingState,
      shippingZip,
      shippingCountry,
    } = req.body;

    if (!quoteId) {
      return res.status(400).json({ error: "Quote ID is required" });
    }

    // Retrieve the quote
    const quote = quotesDB.getById(quoteId);
    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Security: verify quote belongs to requesting user
    if (quote.userId && quote.userId !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    const orderTotal = quote.orderTotal || quote.subtotal || 0;
    if (orderTotal <= 0) {
      return res.status(400).json({ error: "Invalid order total" });
    }

    // Create the order with pending_payment status
    const order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      shippingName: sanitizeString(shippingName || "", 200),
      shippingAddress: sanitizeString(shippingAddress || "", 500),
      shippingCity: sanitizeString(shippingCity || "", 100),
      shippingState: sanitizeString(shippingState || "", 100),
      shippingZip: sanitizeString(shippingZip || "", 20),
      shippingCountry: sanitizeString(shippingCountry || "US", 5),
      shippingMethod: "standard",
      shippingCost: 0,
      subtotal: orderTotal,
      tax: 0,
      total: orderTotal,
      notes: "",
    });

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    for (const item of lineItems) {
      orderItemsDB.insert({
        orderId: order.id,
        partId: item.partId,
        fileName: item.fileName,
        process: item.meta?.process || "fdm",
        materialSlug: item.materialSlug || "",
        materialName: item.materialName || "",
        finishSlug: item.finishSlug || "",
        finishName: item.finishName || "",
        quantity: item.quantity || 1,
        unitPrice: item.unitPrice || 0,
        lineTotal: item.lineTotal || 0,
      });
    }

    // Update quote status
    quotesDB.update(quoteId, { status: "ordered" });

    // Build Stripe line items description
    const partNames = lineItems.map(i => i.fileName || "3D printed part").join(", ");
    const description = partNames.length > 200 ? partNames.substring(0, 197) + "..." : partNames;

    // Determine base URL for redirects
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`;

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Nord MFG Order — ${lineItems.length} part${lineItems.length !== 1 ? "s" : ""}`,
              description: description || "Custom 3D printed parts",
            },
            unit_amount: Math.round(orderTotal * 100), // Stripe uses cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        orderId: order.id,
        quoteId: quoteId,
        userId: req.user.userId,
      },
      success_url: `${baseUrl}/orders/${order.id}?paid=true`,
      cancel_url: `${baseUrl}/checkout/${quoteId}?cancelled=true`,
            allow_promotion_codes: true,
    });

    // Store stripe session ID on the order for reference
    ordersDB.update(order.id, { stripeSessionId: session.id });

    res.json({ sessionUrl: session.url, orderId: order.id });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders — Create order from a quote (legacy / admin)
// ═══════════════════════════════════════════════════════════════
router.post("/", authenticate, (req, res) => {
  try {
    const {
      quoteId,
      shippingName,
      shippingAddress,
      shippingCity,
      shippingState,
      shippingZip,
      shippingCountry,
      shippingMethod,
      shippingCost,
      notes,
    } = req.body;
    if (!quoteId) {
      return res.status(400).json({ error: "Quote ID is required" });
    }

    // Retrieve the quote
    const quote = quotesDB.getById(quoteId);
    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Security: verify quote belongs to requesting user
    if (quote.userId && quote.userId !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    // Sanitize all user-provided shipping fields
    const cleanShippingCost = nonNegativeNumber(shippingCost, 0);

    // Create the order
    const order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      shippingName: sanitizeString(shippingName || "", 200),
      shippingAddress: sanitizeString(shippingAddress || "", 500),
      shippingCity: sanitizeString(shippingCity || "", 100),
      shippingState: sanitizeString(shippingState || "", 100),
      shippingZip: sanitizeString(shippingZip || "", 20),
      shippingCountry: sanitizeString(shippingCountry || "US", 5),
      shippingMethod: sanitizeString(shippingMethod || "standard", 50),
      shippingCost: cleanShippingCost,
      subtotal: quote.orderTotal || quote.subtotal || 0,
      tax: 0,
      total: (quote.orderTotal || quote.subtotal || 0) + cleanShippingCost,      notes: sanitizeString(notes || "", 2000),
    });

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    for (const item of lineItems) {
      orderItemsDB.insert({
        orderId: order.id,
        partId: item.partId,
        fileName: item.fileName,
        process: item.meta?.process || "sheetmetal",
        materialSlug: item.materialSlug || "",
        materialName: item.materialName || "",
        finishSlug: item.finishSlug || "",
        finishName: item.finishName || "",
        quantity: item.quantity || 1,
        unitPrice: item.unitPrice || 0,
        lineTotal: item.lineTotal || 0,
      });
    }

    // Update quote status
    quotesDB.update(quoteId, { status: "ordered" });

    res.status(201).json({
      orderId: order.id,
      status: order.status,
      total: order.total,
    });
  } catch (err) {    console.error("Order creation error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders — List orders for authenticated user
// ═══════════════════════════════════════════════════════════════
router.get("/", authenticate, (req, res) => {
  try {
    let orders;
    if (req.user.role === "admin") {
      orders = ordersDB.getAll();
    } else {
      orders = ordersDB.query((o) => o.userId === req.user.userId);
    }

    // Sort newest first
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Attach item count
    const result = orders.map((order) => {
      const items = orderItemsDB.query((i) => i.orderId === order.id);
      const enrichedItems = items.map((it) => {
        const part = it.partId ? partsDB.getById(it.partId) : null;
        return {
        ...it,
        storedName: part?.storedName || null,
        geometry: part?.geometry || null,
        dfm: part?.dfm || null,
      };
      });
      return { ...order, items: enrichedItems, itemCount: items.length };
    });

    res.json(result);
  } catch (err) {
    console.error("Orders list error:", err);
    res.status(500).json({ error: "Failed to retrieve orders" });
  }
});
// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id — Get order details
// ═══════════════════════════════════════════════════════════════
router.get("/:id", authenticate, (req, res) => {
  try {
    const order = ordersDB.getById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Customers can only see their own orders
    if (req.user.role !== "admin" && order.userId !== req.user.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const enrichedItems = items.map((it) => {
      const part = it.partId ? partsDB.getById(it.partId) : null;
      return { ...it, storedName: part?.storedName || null };
    });
    res.json({ ...order, items: enrichedItems });
  } catch (err) {
    console.error("Order detail error:", err);
    res.status(500).json({ error: "Failed to retrieve order" });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUT /api/orders/:id/status — Update order status (admin only)
// ═══════════════════════════════════════════════════════════════
const VALID_STATUSES = [
  "pending_payment",
  "paid",
  "received",  "in_production",
  "quality_check",
  "packing",
  "shipped",
  "delivered",
  "cancelled",
];

router.put("/:id/status", authenticate, requireAdmin, (req, res) => {
  try {
    const { status, trackingNumber, carrier, shippedAt, notes } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Valid statuses: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const updates = { status };
    if (trackingNumber !== undefined) updates.trackingNumber = sanitizeString(trackingNumber, 100);
    if (carrier !== undefined) updates.carrier = sanitizeString(carrier, 50);
    if (shippedAt !== undefined) updates.shippedAt = sanitizeString(shippedAt, 40);
    if (notes !== undefined) updates.notes = sanitizeString(notes, 2000);

    // Auto-stamp shippedAt when transitioning to shipped if not provided
    if (status === "shipped" && !updates.shippedAt) {
      const existing = ordersDB.getById(req.params.id);
      if (existing && !existing.shippedAt) {
        updates.shippedAt = new Date().toISOString();
      }
    }

    const updated = ordersDB.update(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: "Order not found" });

    // TODO: Send email notification to customer on status change

    res.json(updated);
  } catch (err) {
    console.error("Status update error:", err);    res.status(500).json({ error: "Failed to update order status" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id/traveler — Generate job traveler data
// ═══════════════════════════════════════════════════════════════
router.get("/:id/traveler", authenticate, (req, res) => {
  try {
    const order = ordersDB.getById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    const items = orderItemsDB.query((i) => i.orderId === order.id);

    // Enrich items with part geometry data
    const enrichedItems = items.map((item) => {
      const part = item.partId ? partsDB.getById(item.partId) : null;
      return {
        ...item,
        geometry: part?.geometry || null,
        dfm: part?.dfm || null,
      };
    });

    res.json({
      order: {        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        shippingName: order.shippingName,
        total: order.total,
      },
      items: enrichedItems,
    });
  } catch (err) {
    console.error("Traveler error:", err);
    res.status(500).json({ error: "Failed to generate traveler data" });
  }
});

// ═══════════════════════════════════════════════════════════════
// Admin: GET /api/orders/admin/queue — Production queue
// ═══════════════════════════════════════════════════════════════
router.get("/admin/queue", authenticate, requireAdmin, (req, res) => {
  try {
    const { status, process: processFilter } = req.query;

    let orders = ordersDB.getAll().filter((o) =>
      ["paid", "received", "in_production", "quality_check", "packing"].includes(o.status)
    );

    if (status) {
      orders = orders.filter((o) => o.status === status);
    }

    // Sort by date, oldest first (FIFO production)    orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Enrich with items
    const result = orders.map((order) => {
      const items = orderItemsDB.query((i) => i.orderId === order.id);
      return {
        ...order,
        items: items.map((item) => ({
          fileName: item.fileName,
          process: item.process,
          materialName: item.materialName,
          quantity: item.quantity,
        })),
        itemCount: items.length,
      };
    });

    // Optionally filter by manufacturing process
    if (processFilter) {
      return res.json(
        result.filter((o) => o.items.some((i) => i.process === processFilter))
      );
    }

    res.json(result);
  } catch (err) {
    console.error("Queue error:", err);
    res.status(500).json({ error: "Failed to retrieve production queue" });
  }
});

module.exports = router;
