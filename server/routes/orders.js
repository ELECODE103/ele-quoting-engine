/**
 * Order management routes.
 * Handles order creation from quotes, status updates, and order retrieval.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ordersDB, orderItemsDB, quotesDB, partsDB, usersDB, leadTimesDB, materialsDB, finishesDB } = require("../models");
const { authenticate, requireAdmin } = require("./auth");
const { sanitizeString, nonNegativeNumber } = require("../middleware/validate");
const stripeClient = require("../services/stripeClient");
const orderEvents = require("../services/orderEvents");
const shipBy = require("../services/shipBy");
const { trackingUrl } = require("../emails/templates");
const shopFacts = require("../shopFacts");
const mailer = require("../services/mailer");

const QUOTE_VALID_DAYS = 30; // same hold as routes/api.js

const router = express.Router();

/**
 * Checkout needs a confirmed email address: the order confirmation, the
 * shipping notice and any question about the job go there. Not enforced while
 * the mailer is unconfigured, because then no confirmation link can be sent.
 */
function requireConfirmedEmail(req, res, next) {
  if (req.user.emailVerified || !mailer.configured()) return next();
  res.status(403).json({
    error: `Confirm your email address before you check out. We sent a link to ${req.user.email}.`,
    code: "email-unverified",
  });
}

/** Shipping fields from a request body, sanitized. */
function shippingFields(body = {}) {
  return {
    shippingName: sanitizeString(body.shippingName || "", 200),
    shippingAddress: sanitizeString(body.shippingAddress || "", 500),
    shippingCity: sanitizeString(body.shippingCity || "", 100),
    shippingState: sanitizeString(body.shippingState || "", 100),
    shippingZip: sanitizeString(body.shippingZip || "", 20),
    shippingCountry: sanitizeString(body.shippingCountry || "US", 5),
  };
}

/** An order as its customer (or an admin) may see it. Internal notes and server paths stay out of customer responses. */
function orderView(order, { admin = false } = {}) {
  const { drawingPath, notes, ...safe } = order;
  return {
    ...safe,
    ...(admin ? { notes } : {}),
    hasDrawing: Boolean(drawingPath),
    trackingUrl: trackingUrl(order.carrier, order.trackingNumber),
  };
}

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/checkout-session — Create Stripe Checkout Session
// ═══════════════════════════════════════════════════════════════
router.post("/checkout-session", authenticate, requireConfirmedEmail, async (req, res) => {
  try {
    if (!stripeClient.get()) {
      return res.status(503).json({ error: "Payment processing is not configured" });
    }

    const { quoteId } = req.body;

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

    // Prices hold for 30 days from the last time the quote was priced. A quote
    // saved before the hold existed has no date: count from when it was last touched.
    const expiresAt = quote.expiresAt
      || new Date(new Date(quote.updatedAt || quote.createdAt || 0).getTime() + QUOTE_VALID_DAYS * 864e5).toISOString();
    if (new Date(expiresAt) < new Date()) {
      return res.status(410).json({
        error: "This price has expired. Reopen the quote to get today's price.",
        code: "quote-expired",
      });
    }

    // Quotes the gate routed to RFQ can't be bought online — a person prices them first.
    if (quote.gate?.requiresRfq && req.user.role !== "admin") {
      return res.status(409).json({
        error: "This quote needs a firm quote from us before it can be ordered",
        code: "rfq-required",
        reasons: quote.gate.reasons || [],
      });
    }

    // The promised ship date is counted from today now and re-counted from the
    // payment day when the payment clears.
    const leadTime = leadTimesDB.getAll().find((lt) => lt.slug === quote.leadTimeSlug) || null;
    // A lead time that is no longer offered (switched off, or not confirmed by
    // the owner) cannot be bought from an old quote either.
    if (quote.leadTimeSlug && (!leadTime || !leadTime.active || !shopFacts.leadTimeListed(leadTime)) && req.user.role !== "admin") {
      return res.status(409).json({
        error: "The lead time on this quote is no longer offered. Reopen the quote and pick a lead time to get today's price.",
        code: "lead-time-unavailable",
      });
    }
    const leadDays = leadTime ? shipBy.leadDays(leadTime) : null;
    const account = usersDB.getById(req.user.userId);
    const shipping = shippingFields(req.body);

    const baseUrl = orderEvents.baseUrl(req);
    const stripeUrls = (orderId) => ({
      successUrl: `${baseUrl}/orders/${orderId}?paid=true`,
      cancelUrl: `${baseUrl}/checkout/${quoteId}?cancelled=true`,
      metadata: { quoteId, userId: req.user.userId },
    });
    const describe = (items) => {
      const names = items.map((i) => i.fileName || "custom part").join(", ");
      return names.length > 200 ? names.substring(0, 197) + "..." : names;
    };

    // Back from a cancelled or abandoned Stripe page: pay for the same order
    // (with the address as now entered) instead of stacking a second one.
    const pending = ordersDB.query((o) => o.quoteId === quoteId && o.userId === req.user.userId && o.status === "pending_payment" && !o.rfqId)[0];
    if (pending && Math.abs((pending.total || 0) - orderTotal) < 0.005) {
      const reused = ordersDB.update(pending.id, { ...shipping, shipBy: leadDays !== null ? shipBy.shipByDate(leadDays) : pending.shipBy });
      const items = orderItemsDB.query((i) => i.orderId === reused.id);
      const session = await orderEvents.createCheckoutSession(reused, { itemCount: items.length, description: describe(items), ...stripeUrls(reused.id) });
      return res.json({ sessionUrl: session.url, orderId: reused.id });
    }

    // What the total is made of, so the order page, emails and documents can show it.
    // Each in whole cents, as the customer saw them on the quote.
    const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const partsSubtotal = cents(quote.subtotal);
    const leadTimeSurcharge = Math.max(0, cents(quote.leadTimeSurcharge));
    const shippingCost = Math.max(0, cents(quote.shippingEstimate));
    // Inspection paperwork (first-article report + certificate of conformance) rides on the
    // stored quote, which the server priced: the request body cannot switch it on or change
    // the fee. A quote saved before the option existed has neither column and reads as "no".
    const paperwork = Boolean(quote.paperwork);
    const paperworkFee = paperwork ? Math.max(0, Number(quote.paperworkFee) || 0) : 0;
    if (paperworkFee > orderTotal + 0.005) {
      return res.status(409).json({ error: "This quote's total does not add up. Reopen the quote to get today's price.", code: "quote-inconsistent" });
    }
    // (0.02: a quote priced before amounts were settled to the cent can sit a cent or so off its rounded parts.)
    const itemized = partsSubtotal > 0 && Math.abs(partsSubtotal + leadTimeSurcharge + shippingCost + paperworkFee - orderTotal) < 0.02;

    // Create the order with pending_payment status
    const order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      ...shipping,
      shippingMethod: "standard",
      // When the parts, the lead-time fee and shipping add up to the total they are
      // stored separately; otherwise (order minimum applied, older quote) one line.
      // The paperwork fee is its own line either way, so subtotal + lead-time fee +
      // paperwork + shipping always equals the total.
      shippingCost: itemized ? shippingCost : 0,
      leadTimeSurcharge: itemized ? leadTimeSurcharge : 0,
      subtotal: itemized ? partsSubtotal : Math.round((orderTotal - paperworkFee) * 100) / 100,
      paperwork,
      paperworkFee,
      tax: 0,
      total: orderTotal,
      notes: "",
      paymentMethod: "card",
      customerEmail: account?.email || req.user.email || "",
      customerName: account?.name || shipping.shippingName,
      leadTimeSlug: quote.leadTimeSlug || "",
      leadTimeName: leadTime?.name || "",
      leadDays,
      shipBy: leadDays !== null ? shipBy.shipByDate(leadDays) : null,
      // Notes and drawing the buyer attached on the instant path (price unaffected).
      customerNotes: quote.notes || "",
      drawingFileName: quote.drawingFileName || "",
      drawingPath: quote.drawingPath || "",
    });

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    const inputs = Object.fromEntries((quote.config?.parts || []).map((c) => [c.partId, c]));
    // The engine's line items carry slugs; orders and emails show names.
    const materialNames = Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, m.name]));
    const finishNames = Object.fromEntries(finishesDB.getAll().map((f) => [f.slug, f.name]));
    for (const item of lineItems) {
      // Map from the pricing-engine line-item shape: per-unit price lives at
      // perUnit.final and material/finish/process live under meta.
      orderItemsDB.insert({
        orderId: order.id,
        partId: item.partId,
        fileName: item.fileName,
        process: item.meta?.process || "",
        materialSlug: item.meta?.materialSlug || "",
        materialName: item.meta?.materialName || materialNames[item.meta?.materialSlug] || "",
        finishSlug: item.meta?.finishSlug || "",
        finishName: item.meta?.finishName || finishNames[item.meta?.finishSlug] || "",
        quantity: item.quantity || 1,
        unitPrice: item.perUnit?.final || 0,
        lineTotal: item.lineTotal || 0,
        // Normalized per-item process config (process-specific fields live in meta:
        // grade/thicknessMm for sheet metal, subProcess/layerHeightMm for printing,
        // machinability for CNC, etc.). Stored as one JSON blob — no per-process columns.
        // `input` is what the buyer configured, kept so the order can be re-quoted (reorder).
        config: { ...(item.meta || {}), input: inputs[item.partId] || null },
      });
    }

    let session;
    try {
      session = await orderEvents.createCheckoutSession(order, { itemCount: lineItems.length, description: describe(lineItems), ...stripeUrls(order.id) });
    } catch (err) {
      // No session, no order: don't leave an unpayable order behind for every failed try.
      for (const it of orderItemsDB.query((i) => i.orderId === order.id)) orderItemsDB.delete(it.id);
      ordersDB.delete(order.id);
      throw err;
    }

    // The quote is now an order: bind it to the buyer and stop the builder re-pricing it in place.
    quotesDB.update(quoteId, { status: "ordered", userId: quote.userId || req.user.userId });

    res.json({ sessionUrl: session.url, orderId: order.id });
  } catch (err) {
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders — Create an order from a quote without payment (admin only:
// phone orders). Buyers go through /checkout-session.
// ═══════════════════════════════════════════════════════════════
router.post("/", authenticate, requireAdmin, (req, res) => {
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

    if (quote.gate?.requiresRfq && req.user.role !== "admin") {
      return res.status(409).json({
        error: "This quote needs a firm quote from us before it can be ordered",
        code: "rfq-required",
        reasons: quote.gate.reasons || [],
      });
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
      // The quote's total with the paperwork fee taken out, so the fee stays its own line.
      subtotal: Math.round(((quote.orderTotal || quote.subtotal || 0) - (quote.paperwork ? Number(quote.paperworkFee) || 0 : 0)) * 100) / 100,
      paperwork: Boolean(quote.paperwork),
      paperworkFee: quote.paperwork ? Number(quote.paperworkFee) || 0 : 0,
      tax: 0,
      total: (quote.orderTotal || quote.subtotal || 0) + cleanShippingCost,      notes: sanitizeString(notes || "", 2000),
    });

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    // Same mapping as the Stripe checkout path: the pricing-engine line item
    // keeps per-unit price at perUnit.final and process/material under meta.
    // `config` (= meta) carries the engine's time estimate for calibration.
    for (const item of lineItems) {
      orderItemsDB.insert({
        orderId: order.id,
        partId: item.partId,
        fileName: item.fileName,
        process: item.meta?.process || "sheetmetal",
        materialSlug: item.meta?.materialSlug || item.materialSlug || "",
        materialName: item.meta?.materialName || item.materialName || "",
        finishSlug: item.meta?.finishSlug || item.finishSlug || "",
        finishName: item.meta?.finishName || item.finishName || "",
        quantity: item.quantity || 1,
        unitPrice: item.perUnit?.final ?? item.unitPrice ?? 0,
        lineTotal: item.lineTotal || 0,
        config: item.meta || {},
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
      return { ...orderView(order, { admin: req.user.role === "admin" }), items: enrichedItems, itemCount: items.length };
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
    res.json({ ...orderView(order, { admin: req.user.role === "admin" }), items: enrichedItems });
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
  "pending_po",
  "paid",
  "received",  "in_production",
  "quality_check",
  "packing",
  "shipped",
  "delivered",
  "cancelled",
];

router.put("/:id/status", authenticate, requireAdmin, async (req, res) => {
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

    const existing = ordersDB.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Order not found" });

    // Auto-stamp shippedAt when transitioning to shipped if not provided
    if (status === "shipped" && !updates.shippedAt && !existing.shippedAt) {
      updates.shippedAt = new Date().toISOString();
    }

    const updated = ordersDB.update(req.params.id, updates);

    // Shipped (or tracking added afterwards) → tell the customer.
    const emailed = await orderEvents.notifyStatusChange(existing, updated, { base: orderEvents.baseUrl(req) });

    res.json({ ...orderView(updated, { admin: true }), customerEmailed: emailed });
  } catch (err) {
    console.error("Status update error:", err);    res.status(500).json({ error: "Failed to update order status" });
  }
});

/** Load an order its owner or an admin may act on, or answer 404/403. */
function ownedOrder(req, res) {
  const order = ordersDB.getById(req.params.id);
  if (!order) { res.status(404).json({ error: "Order not found" }); return null; }
  if (req.user.role !== "admin" && order.userId !== req.user.userId) { res.status(403).json({ error: "Access denied" }); return null; }
  return order;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/:id/confirm-payment — settle on return from Stripe
// The webhook normally marks an order paid; this asks Stripe directly so the
// buyer's confirmation page doesn't depend on webhook timing.
// ═══════════════════════════════════════════════════════════════
router.post("/:id/confirm-payment", authenticate, async (req, res) => {
  try {
    const order = ownedOrder(req, res);
    if (!order) return;
    const { order: settled } = await orderEvents.confirmPayment(order, { base: orderEvents.baseUrl(req) });
    res.json({ status: settled.status, shipBy: settled.shipBy || null });
  } catch (err) {
    console.error("Confirm payment error:", err.message);
    res.status(502).json({ error: "Could not confirm the payment yet" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/:id/reorder — rebuild a quote from an order
// Re-prices the same parts and configuration at today's rates and returns a
// draft quote the builder can open. Nothing is ordered here.
// ═══════════════════════════════════════════════════════════════
router.post("/:id/reorder", authenticate, (req, res) => {
  try {
    const order = ownedOrder(req, res);
    if (!order) return;
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const configs = items
      .filter((it) => it.partId && partsDB.getById(it.partId))
      .map((it) => ({
        materialSlug: it.materialSlug,
        finishSlug: it.finishSlug,
        process: it.process,
        subProcess: it.config?.subProcess || "",
        grade: it.config?.grade || "",
        ...(it.config?.input || {}),
        partId: it.partId,
        quantity: it.quantity,
      }));
    if (configs.length === 0) {
      return res.status(409).json({
        error: "We no longer have the part files for this order on hand. Upload them again for a fresh quote.",
        code: "parts-unavailable",
      });
    }
    const { saveQuote } = require("./api");
    // The reorder keeps the paperwork choice (re-priced at today's fee, like everything else).
    const input = { parts: configs, process: configs[0].process, paperwork: Boolean(order.paperwork) };
    let result;
    try {
      result = saveQuote({ ...input, leadTimeSlug: order.leadTimeSlug || "standard" }, req.user);
    } catch (err) {
      if (!err.expose) throw err;
      // A retired lead time shouldn't block a reorder; anything else (a retired material) does.
      try { result = saveQuote({ ...input, leadTimeSlug: "standard" }, req.user); }
      catch (err2) {
        if (!err2.expose) throw err2;
        return res.status(409).json({ error: `This order can't be re-quoted as it was: ${err2.message}. Start a new quote instead.`, code: "reorder-failed" });
      }
    }
    // The buyer's notes and drawing describe the part, so they come along (not for
    // firm-quote orders, where the note on the order is the shop's, not the buyer's).
    if (!order.rfqId && (order.customerNotes || order.drawingPath)) {
      quotesDB.update(result.saved.id, { notes: order.customerNotes || "", drawingFileName: order.drawingFileName || "", drawingPath: order.drawingPath || "" });
    }
    res.status(201).json({ quoteId: result.saved.id, parts: configs.length, skipped: items.length - configs.length });
  } catch (err) {
    console.error("Reorder error:", err);
    res.status(500).json({ error: "Could not rebuild the quote" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id/drawing — the drawing the buyer attached (owner or admin)
// ═══════════════════════════════════════════════════════════════
router.get("/:id/drawing", authenticate, (req, res) => {
  const order = ownedOrder(req, res);
  if (!order) return;
  if (!order.drawingPath || !fs.existsSync(order.drawingPath)) return res.status(404).json({ error: "No drawing on this order" });
  require("../services/fileCrypto").sendDownload(res, order.drawingPath, order.drawingFileName); // decrypts when stored encrypted; always an attachment
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id/traveler — Generate job traveler data
// ═══════════════════════════════════════════════════════════════
router.get("/:id/traveler", authenticate, (req, res) => {
  try {
    // Admin only, checked before the lookup so the answer does not say whether an order id exists.
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const order = ordersDB.getById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

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
      ["pending_po", "paid", "received", "in_production", "quality_check", "packing"].includes(o.status)
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
