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
const checkoutGuard = require("../services/checkoutGuard"); // per-account checkout limit; what-was-priced snapshot
const partAccess = require("../security/partAccess");
const pricingGate = require("../security/pricingGate");   // who may price, and how much of the hour's pricing time they have had
const pricingMemo = require("../services/pricingMemo");   // the site's one pricing runner
const lifecycle = require("../services/orderLifecycle"); // what happens after a Stripe session exists
const orderState = require("../services/orderState");
const { singleLine, singleLines, SHIPPING_RULES } = require("../middleware/singleLine");
const checkout = require("../services/checkout");   // delivery choices, totals and tax settings for a quote
const shippingService = require("../services/shipping");

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

/**
 * An order as its customer (or an admin) may see it. Internal notes and server paths stay out of
 * customer responses, and so does why an order is flagged: the customer sees what was paid, any
 * discount, anything refunded, and whether a payment is being checked by hand; the reason, the
 * dispute state and the owner's own note on a manual payment are the shop's.
 * Delivery and tax fields: no sealed value and no server path leave here; the full carrier
 * account number is opened only for the admin's view of one order (`account`).
 */
function orderView(order, { admin = false, account = false } = {}) {
  const { drawingPath, notes, attention, attentionNote, attentionAt, manualPaidReason, manualPaidBy, disputeStatus, disputeAt, ...safe } = checkout.orderView(order, { admin: admin && account });
  if (admin && !account) safe.taxExemptionLine = require("../services/tax").exemptionLine(order);
  const payment = lifecycle.paymentView(order);
  return {
    ...safe,
    ...(admin ? { notes, attention, attentionNote, attentionAt, manualPaidReason, manualPaidBy, disputeStatus, disputeAt, payment } : {}),
    paymentUnderReview: order.status === "pending_payment" && payment.needsAttention,
    hasDrawing: Boolean(drawingPath),
    trackingUrl: trackingUrl(order.carrier, order.trackingNumber),
    // Whether the order page offers Reorder (an order that was never paid for has nothing to reorder).
    canReorder: orderState.wasPlaced(order),
  };
}

/**
 * The ship-to block is one printable line per field (it is printed on the traveler, the packing
 * slip and the confirmation). A value with a line break or hidden characters is refused here,
 * before the route runs, rather than stored and rewritten later. Fields that are absent pass:
 * which of them are required is the route's own business.
 */
function requireShipToLines(req, res, next) {
  const ship = singleLines(req.body || {}, SHIPPING_RULES);
  if (!ship.ok) return res.status(400).json({ error: ship.error, code: ship.code, field: ship.field });
  next();
}

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/checkout-session — Create Stripe Checkout Session
//
// Two requests at the same moment for one quote (a double click) make ONE order: the lookup for
// an unpaid order and the insert of a new one happen in one synchronous step, before anything
// waits on Stripe, so the second request finds the first one's order — and is then handed the
// same Checkout session, because opening a session is shared per order (services/orderLifecycle.js).
// ═══════════════════════════════════════════════════════════════
//
// Every call — a first checkout and the resume of an unpaid order alike — goes through BOTH:
//   1. the pricing choke point: verifyQuoteForOrder → repriceStoredQuote → priceQuote (whitelist,
//      engine, floor, gate, fingerprint) — routes/api.js, "PRICE INTEGRITY" below; and
//   2. the one place a Stripe session is made: orderEvents.createCheckoutSession →
//      orderLifecycle.checkoutSession → openSession, at expectedCharge(order).
// Order of the guards: who is asking, their per-account checkout limit, then the shape of what they sent.
router.post("/checkout-session", authenticate, requireConfirmedEmail, checkoutGuard.limiter, requireShipToLines, async (req, res) => {
  try {
    if (!stripeClient.get()) {
      // The code the session layer uses for the same state (services/orderLifecycle.js), so the page words it once.
      return res.status(503).json({ error: "Payment processing is not configured", code: "payments-unavailable" });
    }

    const { quoteId } = req.body;

    if (!quoteId) {
      return res.status(400).json({ error: "Quote ID is required" });
    }

    // Retrieve the quote
    let quote = typeof quoteId === "string" ? quotesDB.getById(quoteId) : null;
    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Security: verify quote belongs to requesting user
    if (quote.userId && quote.userId !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    // One quote, one order (payments review 2026-11-11, F-04): an order that is paid, or waiting to
    // be paid, has used this quote up. The buyer's own unpaid order is resumed further down; anything
    // else is refused. (To buy the same parts again there is Reorder, which prices them at today's rules.)
    // Which orders still hold their quote is the state machine's call (services/orderState.js holdsQuote):
    // every order except one that lapsed unpaid ("expired" — its quote was given back when it lapsed).
    // A cancelled order keeps its quote: the owner can still mark a cancelled order paid.
    const taken = ordersDB.query((o) => o.quoteId === quoteId && orderState.holdsQuote(o));
    // (Its total is not compared with the quote's here: the delivery choice may differ, or change on the
    // way back from the card page. Its amounts are brought up to date below, from this same check.)
    const resumable = taken.find((o) => o.userId === req.user.userId && o.status === "pending_payment" && !o.rfqId);
    if (taken.length > 0 && !resumable) {
      const mine = taken.find((o) => o.userId === req.user.userId);
      return res.status(409).json({
        error: "This quote has already been ordered. To order the same parts again, open that order and choose Reorder.",
        code: "quote-already-ordered",
        ...(mine ? { orderId: mine.id } : {}),
      });
    }

    // The quote's own total, and only that: a quote without one is not charged from another field.
    const orderTotal = Number(quote.orderTotal);
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
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
    // PRICE INTEGRITY (independent review 2026-11-11, F2). The stored total is not charged on
    // trust: the saved configuration is priced again here, through the same choke point as a new
    // quote, from each part's CURRENT geometry under the CURRENT rules, and the gate is run again.
    // The buyer is charged only when that agrees with the stored total to the cent, or when the
    // quote is inside its price hold and its parts, configuration and gate result are exactly what
    // was priced. Otherwise: 409 `quote-changed` with today's price for the buyer to confirm.
    // An order of the buyer's that is still waiting for payment gets the same check before it is
    // handed a payment page again (payments review F-04): its parts have been locked since it was
    // made, but the rate card, the catalog and the gate have not. If it no longer passes, the quote
    // has to be reopened (it is not a draft any more, so the builder makes a new one from it).
    // That re-pricing is real work on the one thread, and it has to be done in one step with the order
    // it guards (nothing may change between the check and the order), so it cannot be handed to the
    // pricing runner in pieces. What can be done is done: a sender who has used the hour's pricing
    // allowance is told when to come back before any of it starts, each part is loaded and measured
    // once however many lines name it (the memo inside verifyQuoteForOrder), and the time it takes is
    // charged to the address and the account like any other pricing (security/pricingGate.js).
    const spent = pricingGate.overBudget(req);
    if (spent) {
      res.set("Retry-After", String(spent.retryAfterSeconds));
      return res.status(spent.status).json(spent.body);
    }
    // How the order is delivered and what that comes to (services/checkout.js). The request says
    // which choice (and, for the buyer's own carrier, the account); no amount is read from it.
    // Shipping is worked out here, now, from the lines as they have just been priced again under the
    // settings in force: the shipping figure stored on the quote is never the charge. The parts are
    // charged at the quote's own subtotal (today's price, or the held one), so that is the subtotal a
    // "free over" threshold is judged on. A choice that is switched off is refused.
    let resolved = null;
    const resolveDelivery = (current, priced) => checkout.resolve(current, req.body, {
      certificate: current.taxCertPath ? { fileName: current.taxCertFileName || "certificate", path: current.taxCertPath } : null,
      // (`parts`: the records those lines were just priced from, so they are not read a second time.)
      priced: { lineItems: priced.quote.lineItems, subtotal: current.subtotal, parts: priced.parts },
    });
    const pricingStarted = Date.now();
    const checked = require("./api").verifyQuoteForOrder(quote, req.user, {
      confirmedTotal: req.body.confirmedTotal,
      // The total the buyer's page was showing is the total for the delivery choice they made.
      totalShown: (current, priced) => { resolved = resolveDelivery(current, priced); return resolved.ok ? resolved.total : null; },
    });
    pricingGate.charge(req, Date.now() - pricingStarted);
    if (!checked.ok) return res.status(checked.status).json(resumable ? { ...checked.body, reopen: true, orderId: resumable.id } : checked.body);
    quote = checked.quote;
    if (!resolved) resolved = resolveDelivery(quote, checked.priced);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });

    // An order is never taken (or paid for) for a part whose file the shop no longer has. Retention keeps
    // the files of a quote that can still be ordered, so this should not fire; it is the check that it did.
    const files = require("../services/fileRetention").partFilesPresent((quote.lineItems || []).map((li) => li.partId));
    if (!files.ok) return res.status(409).json({ error: files.message, code: files.code, reopen: true, ...(resumable ? { orderId: resumable.id } : {}) });

    const leadDays = leadTime ? shipBy.leadDays(leadTime) : null;
    const account = usersDB.getById(req.user.userId);
    const shipping = resolved.address;
    const delivery = checkout.orderFields(resolved);
    const sealed = (orderId) => (resolved.carrier ? { shipAccountEnc: shippingService.sealAccount(resolved.carrier.account, orderId) } : {});

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
    // The delivery choice may have changed on the way back too (ship → pickup, say): the same order
    // is brought up to date, amounts included, never left behind for a second one.
    // Only while it is still waiting: it is read again here, in the same step as the write.
    const pending = resumable ? ordersDB.getById(resumable.id) : null;
    if (resumable && (!pending || pending.status !== "pending_payment")) {
      return res.status(409).json({ error: "This order is not waiting for a card payment.", code: "order-not-payable", orderId: resumable.id });
    }
    if (pending) {
      const reused = ordersDB.update(pending.id, {
        ...delivery, ...sealed(pending.id),
        shippingCost: resolved.shippingCost, leadTimeSurcharge: resolved.leadTimeSurcharge, subtotal: resolved.subtotal,
        tax: 0, total: resolved.total,
        shipBy: leadDays !== null ? shipBy.shipByDate(leadDays) : pending.shipBy,
      });
      const items = orderItemsDB.query((i) => i.orderId === reused.id);
      // The session this order already has, while it is still open for the same amount; a new one only when it is not.
      const again = await checkoutGuard.sessionFor(reused, { itemCount: items.length, description: describe(items), ...stripeUrls(reused.id) });
      return res.json({ sessionUrl: again.paid ? stripeUrls(reused.id).successUrl : again.session.url, orderId: reused.id });
    }

    // What the total is made of, so the order page, emails and documents can show it: each in
    // whole cents, as the customer saw them on the quote, with the shipping of the delivery choice
    // (services/checkout.js: shipping as worked out above when we ship; none on the buyer's
    // carrier account or for a pickup).
    // Inspection paperwork (first-article report + certificate of conformance) rides on the
    // stored quote, which the server priced: the request body cannot switch it on or change
    // the fee. A quote saved before the option existed has neither column and reads as "no".
    const paperwork = resolved.paperwork;
    const paperworkFee = resolved.paperworkFee;
    if (paperworkFee > orderTotal + 0.005) {
      return res.status(409).json({ error: "This quote's total does not add up. Reopen the quote to get today's price.", code: "quote-inconsistent" });
    }

    // Create the order with pending_payment status
    let order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      // Ship-to, delivery choice ("standard" = we ship it), carrier account (masked), tax mode, exemption.
      ...delivery,
      // When the parts, the lead-time fee and shipping add up to the total they are
      // stored separately; otherwise (order minimum applied, older quote) one line.
      // The paperwork fee is its own line either way, so subtotal + lead-time fee +
      // paperwork + shipping always equals the total (sales tax, when Stripe adds it, joins
      // both sides once the payment reports it).
      shippingCost: resolved.shippingCost,
      leadTimeSurcharge: resolved.leadTimeSurcharge,
      subtotal: resolved.subtotal,
      paperwork,
      paperworkFee,
      tax: 0,
      total: resolved.total,
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
    // The carrier account number is sealed to this order's id, so it is stored once the id exists.
    if (resolved.carrier) order = ordersDB.update(order.id, sealed(order.id));

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    const inputs = Object.fromEntries((quote.config?.parts || []).map((c) => [c.partId, c]));
    // The engine's line items carry slugs; orders and emails show names.
    const materialNames = Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, m.name]));
    const finishNames = Object.fromEntries(finishesDB.getAll().map((f) => [f.slug, f.name]));
    for (const [index, item] of lineItems.entries()) {
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
        // `priced` is the snapshot of exactly what was charged for: the fingerprint of the stored
        // geometry and configuration, its units and its dimensions, for the traveler to be checked against.
        config: { ...(item.meta || {}), input: (quote.config?.parts || [])[index] || inputs[item.partId] || null, priced: checkoutGuard.pricedSnapshot(checked.priced, index, checked.basis) },
      });
    }
    // Parts uploaded before the buyer had an account belong to the buyer from here on.
    if (req.user.role !== "admin") for (const part of checked.priced.parts) partAccess.claim(part, req.user, partsDB);

    // The quote is now an order: bind it to the buyer and stop the builder re-pricing it in place.
    // Done here, in the same step as the order, and not after the call to Stripe: a re-price that
    // arrives while that call is in flight then makes a new quote instead of changing this one.
    quotesDB.update(quoteId, { status: "ordered", userId: quote.userId || req.user.userId });

    let session;
    try {
      session = await orderEvents.createCheckoutSession(order, { itemCount: lineItems.length, description: describe(lineItems), ...stripeUrls(order.id) });
    } catch (err) {
      // No session, no order: don't leave an unpayable order behind for every failed try, and
      // give the quote back. Only while the order is still unpaid and no session exists for it.
      const now = ordersDB.getById(order.id);
      if (now && now.status === "pending_payment" && lifecycle.sessionsFor(order.id).length === 0) {
        for (const it of orderItemsDB.query((i) => i.orderId === order.id)) orderItemsDB.delete(it.id);
        ordersDB.delete(order.id);
        const q = quotesDB.getById(quoteId);
        if (q && q.status === "ordered" && ordersDB.query((o) => o.quoteId === quoteId).length === 0) quotesDB.update(quoteId, { status: quote.status || "draft", userId: quote.userId || null });
      }
      throw err;
    }

    res.json({ sessionUrl: session.url, orderId: order.id });
  } catch (err) {
    // Refusals with a reason the page can act on (the order was paid or cancelled meanwhile; Stripe is slow).
    if (err && err.expose === true && err.code && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders — Create an order from a quote without payment (admin only:
// phone orders). Buyers go through /checkout-session.
// ═══════════════════════════════════════════════════════════════
router.post("/", authenticate, requireAdmin, requireShipToLines, (req, res) => {
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
    let quote = typeof quoteId === "string" ? quotesDB.getById(quoteId) : null;
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

    // A phone order is priced again like any other (same check as /checkout-session): the stored
    // total is used only when it is today's price or a held price for exactly what was priced.
    const checked = require("./api").verifyQuoteForOrder(quote, req.user, { confirmedTotal: req.body.confirmedTotal });
    if (!checked.ok) return res.status(checked.status).json(checked.body);
    quote = checked.quote;

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
      subtotal: Math.round(((Number(quote.orderTotal) || 0) - (quote.paperwork ? Number(quote.paperworkFee) || 0 : 0)) * 100) / 100,
      paperwork: Boolean(quote.paperwork),
      paperworkFee: quote.paperwork ? Number(quote.paperworkFee) || 0 : 0,
      tax: 0,
      total: Math.round(((Number(quote.orderTotal) || 0) + cleanShippingCost) * 100) / 100,
      notes: sanitizeString(notes || "", 2000),
    });

    // Create order items from quote line items
    const lineItems = quote.lineItems || [];
    // Same mapping as the Stripe checkout path: the pricing-engine line item
    // keeps per-unit price at perUnit.final and process/material under meta.
    // `config` (= meta) carries the engine's time estimate for calibration.
    for (const [index, item] of lineItems.entries()) {
      orderItemsDB.insert({
        orderId: order.id,
        partId: item.partId,
        fileName: item.fileName,
        process: item.meta?.process || "",
        materialSlug: item.meta?.materialSlug || item.materialSlug || "",
        materialName: item.meta?.materialName || item.materialName || "",
        finishSlug: item.meta?.finishSlug || item.finishSlug || "",
        finishName: item.meta?.finishName || item.finishName || "",
        quantity: item.quantity || 1,
        unitPrice: item.perUnit?.final ?? item.unitPrice ?? 0,
        lineTotal: item.lineTotal || 0,
        config: { ...(item.meta || {}), input: (quote.config?.parts || [])[index] || null, priced: checkoutGuard.pricedSnapshot(checked.priced, index, checked.basis) },
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
        // The part's measurements, never its preview mesh: an order list has no 3D view.
        const { meshData, ...geometry } = part?.geometry || {};
        return {
        ...it,
        storedName: part?.storedName || null,
        geometry: part?.geometry ? geometry : null,
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
    if (!order) return res.status(404).json({ error: "Order not found", code: "order-not-found" });

    // Customers can only see their own orders
    if (req.user.role !== "admin" && order.userId !== req.user.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const enrichedItems = items.map((it) => {
      const part = it.partId ? partsDB.getById(it.partId) : null;
      return { ...it, storedName: part?.storedName || null };
    });
    const admin = req.user.role === "admin";
    res.json({
      // The one place the admin sees a buyer's full carrier account number.
      ...orderView(order, { admin, account: true }),
      items: enrichedItems,
      // The money history of the order (payments, refunds, disputes, manual changes), for the shop.
      ...(admin ? { paymentEvents: lifecycle.eventsFor(order.id).filter((e) => e.kind !== "event").map((e) => ({ kind: e.kind, at: e.createdAt, amount: Number.isInteger(e.amountCents) ? e.amountCents / 100 : null, detail: e.detail || "" })) } : {}),
    });
  } catch (err) {
    console.error("Order detail error:", err);
    res.status(500).json({ error: "Failed to retrieve order" });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUT /api/orders/:id/status — the owner's manual moves (admin only)
//
// Only the moves in the state machine (services/orderState.js MANUAL). An order cannot be put
// back to "awaiting payment", made "expired" by hand, or jumped from unpaid into production.
// Marking an order paid when no payment is on record needs a typed reason and how it was paid
// (`reason`, `paidVia`); so does marking one refunded. Every move is written to the audit trail.
// Sending the order's current status changes nothing but the tracking fields and the note.
// ═══════════════════════════════════════════════════════════════
const VALID_STATUSES = orderState.STATES;

router.put("/:id/status", authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, trackingNumber, carrier, shippedAt, notes, reason, paidVia } = req.body;

    if (!status || typeof status !== "string" || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Valid statuses: ${VALID_STATUSES.join(", ")}`,
        code: "status-unknown",
      });
    }

    // Carrier, tracking number and ship date are printed and emailed: one printable line each.
    const lines = singleLines({ trackingNumber, carrier, shippedAt }, {
      trackingNumber: { label: "The tracking number", max: 100 },
      carrier: { label: "The carrier", max: 50 },
      shippedAt: { label: "The ship date", max: 40 },
    });
    if (!lines.ok) return res.status(400).json({ error: lines.error, code: lines.code, field: lines.field });
    const why = singleLine(reason, { field: "reason", label: "The reason", max: 300 });
    if (!why.ok) return res.status(400).json({ error: why.error, code: why.code, field: why.field });

    const updates = {};
    if (trackingNumber !== undefined) updates.trackingNumber = lines.values.trackingNumber;
    if (carrier !== undefined) updates.carrier = lines.values.carrier;
    if (shippedAt !== undefined) updates.shippedAt = lines.values.shippedAt;
    if (notes !== undefined) updates.notes = sanitizeString(notes, 2000);

    const existing = ordersDB.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Order not found", code: "order-not-found" });

    // Auto-stamp shippedAt when transitioning to shipped if not provided
    if (status === "shipped" && !updates.shippedAt && !existing.shippedAt) {
      updates.shippedAt = new Date().toISOString();
    }

    // The move itself, and its line in the admin change log (services/audit.js), are made in
    // orderLifecycle.manualMove: who, from what to what, the typed reason, and whether tracking or
    // the carrier changed (no customer text, no notes).
    const moved = lifecycle.manualMove(req.params.id, status, {
      actor: { userId: req.user.userId, email: req.user.email },
      reason: why.value,
      paidVia: typeof paidVia === "string" ? paidVia : undefined,
      extra: updates,
    });
    if (!moved.ok) return res.status(moved.status).json({ error: moved.error, code: moved.code });
    const updated = moved.order;

    // Paid another way, or called off: the card page for this order stops taking money.
    if (moved.closeSessions) await lifecycle.closeOpenSessions(updated.id, { base: orderEvents.baseUrl(req) });

    // Shipped (or tracking added afterwards) → tell the customer.
    const emailed = await orderEvents.notifyStatusChange(moved.before, updated, { base: orderEvents.baseUrl(req) });

    res.json({ ...orderView(ordersDB.getById(updated.id) || updated, { admin: true }), customerEmailed: emailed });
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/:id/resolve-attention — the owner has dealt with a flagged payment (admin only)
// Needs a note saying what was done; written to the audit trail.
// ═══════════════════════════════════════════════════════════════
router.post("/:id/resolve-attention", authenticate, requireAdmin, (req, res) => {
  try {
    const note = singleLine((req.body || {}).note, { field: "note", label: "The note", max: 300 });
    if (!note.ok) return res.status(400).json({ error: note.error, code: note.code, field: note.field });
    const r = lifecycle.resolveAttention(req.params.id, { actor: { userId: req.user.userId, email: req.user.email }, note: note.value });
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    res.json(orderView(r.order, { admin: true }));
  } catch (err) {
    console.error("Resolve attention error:", err);
    res.status(500).json({ error: "Failed to update the order" });
  }
});

/** Load an order its owner or an admin may act on, or answer 404/403. */
function ownedOrder(req, res) {
  const order = ordersDB.getById(req.params.id);
  if (!order) { res.status(404).json({ error: "Order not found", code: "order-not-found" }); return null; }
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
    // The same checks as the webhook (amount, currency, session, payment status), on the order as it is now.
    const { order: settled } = await orderEvents.confirmPayment(order.id, { base: orderEvents.baseUrl(req) });
    res.json({ status: settled.status, shipBy: settled.shipBy || null, paymentUnderReview: settled.status === "pending_payment" && Boolean(settled.attention) });
  } catch (err) {
    console.error("Confirm payment error:", err.message);
    res.status(502).json({ error: "Could not confirm the payment yet", code: "confirm-failed" });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/orders/:id/reorder — rebuild a quote from an order
// Re-prices the same parts and configuration at today's rates and returns a
// draft quote the builder can open. Nothing is ordered here.
// ═══════════════════════════════════════════════════════════════
// Pricing here goes through the same door as POST /api/quote (security/pricingGate.js admit(): one
// pricing request at a time per client, the hour's pricing allowance per address and per account) and
// the site's one pricing runner (services/pricingMemo.js: each part loaded once, the work done in
// pieces between which every other request is served).
router.post("/:id/reorder", authenticate, pricingGate.admit(), async (req, res) => {
  try {
    const order = ownedOrder(req, res);
    if (!order) return;
    // Reorder is for an order that was really placed: paid at some point, or accepted on a PO and taken
    // into work (services/orderState.js wasPlaced). An abandoned checkout is not a ticket to this route
    // (re-review 2026-11-12, RR-14); an admin may rebuild a quote from any order.
    if (!orderState.wasPlaced(order) && req.user.role !== "admin") {
      return res.status(409).json({
        error: order.status === "pending_payment"
          ? "This order hasn't been paid for yet, so there is nothing to reorder. Go back to checkout to pay for it."
          : "This order was never paid for, so there is nothing to reorder. Start a new quote for these parts.",
        code: "reorder-not-available",
        status: order.status,
      });
    }
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const configs = items
      // getRow: "is the part still there" is answered from its row. getById reads the part's whole
      // measurement file, once per line, before any pricing has started (0.7 s of held thread for 100
      // lines of a dense part: availability-fixes round 2, RR-05).
      .filter((it) => it.partId && partsDB.getRow(it.partId))
      .map((it) => ({
        materialSlug: it.materialSlug,
        finishSlug: it.finishSlug,
        process: it.process,
        subProcess: it.config?.subProcess || "",
        grade: it.config?.grade || "",
        ...(Number(it.config?.thicknessMm) > 0 ? { thicknessMm: Number(it.config.thicknessMm) } : {}),
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
    // The caller owns this order (checked above), which is what entitles them to its parts: a part
    // nobody owns yet needs no edit key here. A part that belongs to another account stays closed.
    const fromOrder = { allowAnonymous: true };
    // The reorder keeps the paperwork choice (re-priced at today's fee, like everything else).
    const input = { parts: configs, process: configs[0].process, paperwork: Boolean(order.paperwork) };
    // Who is charged for the work and whose allowances the new draft counts against (the address and the
    // account), and how the parts may be used (the caller's own order stands in for the part keys).
    const ctx = { ...pricingGate.context(req), access: fromOrder };
    const priced = (body) => pricingMemo.run(() => saveQuote(body, req.user, ctx), pricingGate.job(req, configs));
    // A refusal about load or allowances is answered as it is, with its Retry-After: the site is busy
    // (503), this sender has had its share of pricing time, of new quotes or of stored drafts (429), or
    // the quote took longer to price than the instant quote allows (quote-too-slow). None of those is
    // "this order can't be re-quoted", and trying again with another lead time would only do the work twice.
    const aboutLoad = (err) => err.status === 429 || err.status === 503 || (err.extra && err.extra.code === "quote-too-slow");
    const passOn = (err) => {
      if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    };
    let result;
    try {
      result = await priced({ ...input, leadTimeSlug: order.leadTimeSlug || "standard" });
    } catch (err) {
      if (!err.expose) throw err;
      if (aboutLoad(err)) return passOn(err);
      // A retired lead time shouldn't block a reorder; anything else (a retired material) does.
      try { result = await priced({ ...input, leadTimeSlug: "standard" }); }
      catch (err2) {
        if (!err2.expose) throw err2;
        if (aboutLoad(err2)) return passOn(err2);
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
// GET /api/orders/:id/tax-certificate — the exemption certificate the buyer attached (admin only)
// ═══════════════════════════════════════════════════════════════
router.get("/:id/tax-certificate", authenticate, requireAdmin, (req, res) => {
  const order = ordersDB.getById(req.params.id);
  if (!order || !order.taxCertPath || !fs.existsSync(order.taxCertPath)) return res.status(404).json({ error: "No certificate on this order", code: "no-certificate" });
  require("../services/fileCrypto").sendDownload(res, order.taxCertPath, order.taxCertFileName); // decrypts when stored encrypted; always an attachment
});

// ═══════════════════════════════════════════════════════════════
// GET /api/orders/:id/traveler — Generate job traveler data
// ═══════════════════════════════════════════════════════════════
// Admin only, checked before the lookup so the answer does not say whether an order id exists.
router.get("/:id/traveler", authenticate, requireAdmin, (req, res) => {
  try {
    const order = ordersDB.getById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const items = orderItemsDB.query((i) => i.orderId === order.id);

    // Enrich items with part geometry data
    const enrichedItems = items.map((item) => {
      const part = item.partId ? partsDB.getById(item.partId) : null;
      // What was charged for, and whether the stored part is still that part (it is locked once
      // ordered, so `false` means something is wrong and the job must not be cut from this file).
      const check = checkoutGuard.checkAgainst(item, part);
      return {
        ...item,
        geometry: part?.geometry || null,
        dfm: part?.dfm || null,
        priced: check ? check.priced : null,
        matchesPriced: check ? check.matches : null,
      };
    });

    res.json({
      order: {        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        shippingName: order.shippingName,
        total: order.total,
        // How it leaves the shop: pickup, or the buyer's carrier and account (last four only).
        shippingMethod: order.shippingMethod || "standard",
        deliveryLine: shippingService.methodLine(order),
        packedWeightLb: order.packedWeightLb || null,
        returnPart: Boolean(order.returnPart),
      },
      items: enrichedItems,
    });
  } catch (err) {
    console.error("Traveler error:", err);
    res.status(500).json({ error: "Failed to generate traveler data" });
  }
});

// ═══════════════════════════════════════════════════════════════
// Admin: GET /api/orders/admin/payment-settings — what is switched on for payments
// (promotion codes, how long a payment page stays open, whether shop emails go out),
// and how many orders are waiting for the owner. Read-only: the switches are host variables.
// ═══════════════════════════════════════════════════════════════
router.get("/admin/payment-settings", authenticate, requireAdmin, (req, res) => {
  const orders = ordersDB.getAll();
  res.json({
    ...lifecycle.paymentSettings(),
    needsAttention: orders.filter((o) => o.attention).length,
    manualPaidMethods: orderState.MANUAL_PAID_METHODS,
    manualMoves: orderState.MANUAL,
  });
});

// ═══════════════════════════════════════════════════════════════
// Admin: GET /api/orders/admin/queue — Production queue
// ═══════════════════════════════════════════════════════════════
router.get("/admin/queue", authenticate, requireAdmin, (req, res) => {
  try {
    const { status, process: processFilter } = req.query;

    // Work to build: refunded, expired and cancelled orders are not in it; a flagged or disputed
    // order stays (nothing is cancelled automatically) and carries its flag.
    let orders = ordersDB.getAll().filter((o) => orderState.isWork(o));

    if (status) {
      orders = orders.filter((o) => o.status === status);
    }

    // Sort by date, oldest first (FIFO production)    orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Enrich with items
    const result = orders.map((order) => {
      const items = orderItemsDB.query((i) => i.orderId === order.id);
      const { shipAccountEnc, taxCertPath, ...row } = order; // the sealed account number and the certificate's path stay on the server
      return {
        ...row,
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
