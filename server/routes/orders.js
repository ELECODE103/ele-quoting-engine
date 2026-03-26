/**
 * Order management routes.
 * Handles order creation from quotes, status updates, and order retrieval.
 */
const express = require("express");
const { ordersDB, orderItemsDB, quotesDB, partsDB } = require("../models");
const { authenticate, requireAdmin } = require("./auth");

const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// POST /api/orders — Create order from a quote
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

    // Create the order
    const order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      shippingName: shippingName || "",
      shippingAddress: shippingAddress || "",
      shippingCity: shippingCity || "",
      shippingState: shippingState || "",
      shippingZip: shippingZip || "",
      shippingCountry: shippingCountry || "US",
      shippingMethod: shippingMethod || "standard",
      shippingCost: shippingCost || 0,
      subtotal: quote.orderTotal || quote.subtotal || 0,
      tax: 0,
      total: (quote.orderTotal || quote.subtotal || 0) + (shippingCost || 0),
      notes: notes || "",
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
  } catch (err) {
    console.error("Order creation error:", err);
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
      return { ...order, itemCount: items.length };
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
    res.json({ ...order, items });
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
  "received",
  "in_production",
  "quality_check",
  "packing",
  "shipped",
  "delivered",
  "cancelled",
];

router.put("/:id/status", authenticate, requireAdmin, (req, res) => {
  try {
    const { status, trackingNumber, notes } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Valid statuses: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const updates = { status };
    if (trackingNumber) updates.trackingNumber = trackingNumber;
    if (notes) updates.notes = notes;

    const updated = ordersDB.update(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: "Order not found" });

    // TODO: Send email notification to customer on status change

    res.json(updated);
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: "Failed to update order status" });
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
      order: {
        id: order.id,
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

    // Sort by date, oldest first (FIFO production)
    orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

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
