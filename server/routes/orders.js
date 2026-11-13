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
const orderQueries = require("../models/orderQueries"); // an order's lines, a page of orders: from an index, not a pass over every row

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
  // (`clientTag`, the keyed hash of the address an order was made from, is the server's own bookkeeping.)
  const { drawingPath, notes, attention, attentionNote, attentionAt, manualPaidReason, manualPaidBy, disputeStatus, disputeAt, clientTag, ...safe } = checkout.orderView(order, { admin: admin && account });
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
//
// HOW THE STEP IS MADE (independent re-review 2026-11-12, F-08, F-02, F-01, F-06)
//
//   orderStep() below is one synchronous function: it reads the quote and the buyer's unpaid order,
//   prices the quote again, compares, and writes the order. It is run by the site's one pricing
//   runner (services/pricingMemo.js), like a new quote:
//
//     warm-up passes   the pricing is done in pieces, with every other request served between
//                      them. A warm-up pass stops right after the pricing (verifyQuoteForOrder
//                      answers `warming`), before anything is judged or written.
//     the final pass   runs in one piece with everything priced already in the runner's memo, and
//                      only after the runner has checked, in the same step, that every part and
//                      catalog table the memo holds is still what the database holds. It reads the
//                      quote and the order afresh, judges, and writes. So the read, the re-pricing,
//                      the fingerprint check and the write are one indivisible step relative to
//                      any change to a part, exactly as when it was all done in one go; the long
//                      part of the work just no longer holds the thread.
//
//   The write is ONE change to the database (models/database.js transaction()): the order, all its
//   lines, the claims on its parts and its quote's new status reach the file in one atomic
//   replacement of the file, or none of them does. It used to be one whole-file save per row: a
//   100-line checkout held the site 0.6 s on a new database and 4.2 s at 12 MB, and a kill part
//   way through left an order with some of its lines, which the buyer then paid for in full.
//
//   The pricing time, the final pass and its one save are charged to the sender (the address and
//   the account) by the runner, like any other pricing.
// ═══════════════════════════════════════════════════════════════

const refuse = (status, body, headers = {}) => ({ refusal: { status, body, headers } });

/**
 * Do the lines of this order say what its quote, as just priced, says? An order made by this
 * route always does (they are written in one change). One that does not was left by a crash of an
 * earlier version part way through its lines, or was changed by hand: it must never be handed a
 * payment page (F-02).
 */
function linesMatchQuote(items, lineItems) {
  if (!Array.isArray(lineItems) || items.length !== lineItems.length) return false;
  return lineItems.every((li, i) => {
    const it = items[i];
    return it && it.partId === li.partId && Number(it.quantity) === Number(li.quantity || 1) && Math.abs((Number(it.lineTotal) || 0) - (Number(li.lineTotal) || 0)) < 0.011;
  });
}

/**
 * The checkout step (see the block above). Synchronous; run by the pricing runner, several times.
 * @returns {null | {refusal} | {closeFirst, orderId} | {order, resumed, itemCount, description, quoteWas}}
 *   null: a warm-up pass (nothing judged, nothing written).
 */
function orderStep(req, quoteId) {
  let quote = quotesDB.getById(quoteId);
  if (!quote) return refuse(404, { error: "Quote not found" });

  // Security: verify quote belongs to requesting user
  if (quote.userId && quote.userId !== req.user.userId && req.user.role !== "admin") {
    return refuse(403, { error: "Access denied" });
  }

  // One quote, one order (payments review 2026-11-11, F-04): an order that is paid, or waiting to
  // be paid, has used this quote up. The buyer's own unpaid order is resumed further down; anything
  // else is refused. (To buy the same parts again there is Reorder, which prices them at today's rules.)
  // Which orders still hold their quote is the state machine's call (services/orderState.js holdsQuote):
  // every order except one that lapsed unpaid ("expired" — its quote was given back when it lapsed).
  // A cancelled order keeps its quote: the owner can still mark a cancelled order paid.
  const taken = orderQueries.ordersOfQuote(quoteId).filter((o) => orderState.holdsQuote(o));
  // (Its total is not compared with the quote's here: the delivery choice may differ, or change on the
  // way back from the card page. Its amounts are brought up to date below, from this same check.)
  const resumable = taken.find((o) => o.userId === req.user.userId && o.status === "pending_payment" && !o.rfqId);
  if (taken.length > 0 && !resumable) {
    const mine = taken.find((o) => o.userId === req.user.userId);
    return refuse(409, {
      error: "This quote has already been ordered. To order the same parts again, open that order and choose Reorder.",
      code: "quote-already-ordered",
      ...(mine ? { orderId: mine.id } : {}),
    });
  }

  // The quote's own total, and only that: a quote without one is not charged from another field.
  const orderTotal = Number(quote.orderTotal);
  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    return refuse(400, { error: "Invalid order total" });
  }

  // Prices hold for 30 days from the last time the quote was priced. A quote
  // saved before the hold existed has no date: count from when it was last touched.
  const expiresAt = quote.expiresAt
    || new Date(new Date(quote.updatedAt || quote.createdAt || 0).getTime() + QUOTE_VALID_DAYS * 864e5).toISOString();
  if (new Date(expiresAt) < new Date()) {
    return refuse(410, {
      error: "This price has expired. Reopen the quote to get today's price.",
      code: "quote-expired",
    });
  }

  // Quotes the gate routed to RFQ can't be bought online — a person prices them first.
  if (quote.gate?.requiresRfq && req.user.role !== "admin") {
    return refuse(409, {
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
    return refuse(409, {
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
  const checked = require("./api").verifyQuoteForOrder(quote, req.user, {
    confirmedTotal: req.body.confirmedTotal,
    // The total the buyer's page was showing is the total for the delivery choice they made.
    totalShown: (current, priced) => { resolved = resolveDelivery(current, priced); return resolved.ok ? resolved.total : null; },
    // In a warm-up pass the shipment is measured too (a drawing is put at its stock thickness once
    // per line), so the final pass finds that worked out as well.
    warmUp: (current, priced) => { resolveDelivery(current, priced); },
  });
  if (checked.warming) return null;
  if (!checked.ok) return refuse(checked.status, resumable ? { ...checked.body, reopen: true, orderId: resumable.id } : checked.body);
  quote = checked.quote;
  if (!resolved) resolved = resolveDelivery(quote, checked.priced);
  if (!resolved.ok) return refuse(resolved.status, { error: resolved.error, code: resolved.code });

  // An order is never taken (or paid for) for a part whose file the shop no longer has. Retention keeps
  // the files of a quote that can still be ordered, so this should not fire; it is the check that it did.
  const files = require("../services/fileRetention").partFilesPresent((quote.lineItems || []).map((li) => li.partId));
  if (!files.ok) return refuse(409, { error: files.message, code: files.code, reopen: true, ...(resumable ? { orderId: resumable.id } : {}) });

  const leadDays = leadTime ? shipBy.leadDays(leadTime) : null;
  const account = usersDB.getById(req.user.userId);
  const shipping = resolved.address;
  const delivery = checkout.orderFields(resolved);
  const sealed = (orderId) => (resolved.carrier ? { shipAccountEnc: shippingService.sealAccount(resolved.carrier.account, orderId) } : {});
  const describe = (items) => {
    const names = items.map((i) => i.fileName || "custom part").join(", ");
    return names.length > 200 ? names.substring(0, 197) + "..." : names;
  };
  const lineItems = quote.lineItems || [];

  // Back from a cancelled or abandoned Stripe page: pay for the same order
  // (with the address as now entered) instead of stacking a second one.
  // The delivery choice may have changed on the way back too (ship → pickup, say): the same order
  // is brought up to date, amounts included, never left behind for a second one.
  // Only while it is still waiting: it is read again here, in the same step as the write.
  let pending = resumable ? ordersDB.getById(resumable.id) : null;
  if (resumable && (!pending || pending.status !== "pending_payment")) {
    return refuse(409, { error: "This order is not waiting for a card payment.", code: "order-not-payable", orderId: resumable.id });
  }
  if (pending) {
    const items = orderQueries.itemsOf(pending.id);
    if (!linesMatchQuote(items, lineItems)) {
      // Not the order this quote makes (F-02: an order an earlier version left part-written when the
      // process was killed). It is never handed a payment page: it is closed here, in this same
      // change, and a whole order is made below. If a payment page of its own is still open, that is
      // closed at Stripe first (the caller does it and comes back).
      if (lifecycle.sessionsOpenFor(pending.id)) return { closeFirst: true, orderId: pending.id };
      lifecycle.closePartialOrder(pending.id, `closed at checkout: it holds ${items.length} of the ${lineItems.length} lines of its quote`);
      pending = null;
    } else {
      const updates = {
        ...delivery, ...sealed(pending.id),
        shippingCost: resolved.shippingCost, leadTimeSurcharge: resolved.leadTimeSurcharge, subtotal: resolved.subtotal,
        tax: 0, total: resolved.total,
        shipBy: leadDays !== null ? shipBy.shipByDate(leadDays) : pending.shipBy,
      };
      const stripe = { itemCount: items.length, description: describe(items), ...stripeUrls(req, pending.id, quoteId) };
      // A payment page is open for this order and the change would make it a page for another
      // amount, another delivery choice or another tax address (F-06): nothing about the order is
      // changed while that page can still be paid. The caller asks Stripe first: paid → the order is
      // settled as it stands; not paid → the page is closed at Stripe, then this step runs again.
      if (lifecycle.changeNeedsClosedSessions(pending, updates, stripe)) return { closeFirst: true, orderId: pending.id };
      const reused = ordersDB.update(pending.id, updates);
      return { order: reused, resumed: true, itemCount: items.length, description: describe(items) };
    }
  }

  // A NEW order from here on. One sender may hold only so many unpaid orders, at once and in a day
  // (security/orderCaps.js): pressing "pay" is free, and each unpaid order holds database rows and files.
  const clientTag = require("../security/uploadGuards").clientTag(require("../security/clientKey").clientKey(req));
  if (req.user.role !== "admin") {
    const capped = require("../security/orderCaps").refusalFor({ userId: req.user.userId, clientTag, sessionMinutes: lifecycle.sessionMinutes() });
    if (capped) return refuse(capped.status, capped.body, { "Retry-After": String(capped.retryAfterSeconds) });
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
    return refuse(409, { error: "This quote's total does not add up. Reopen the quote to get today's price.", code: "quote-inconsistent" });
  }

  const inputs = Object.fromEntries((quote.config?.parts || []).map((c) => [c.partId, c]));
  // The engine's line items carry slugs; orders and emails show names.
  const materialNames = Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, m.name]));
  const finishNames = Object.fromEntries(finishesDB.getAll().map((f) => [f.slug, f.name]));

  // ONE CHANGE: the order, every line, the part claims and the quote's status (see the block above).
  const order = require("../models/database").transaction(() => {
    // Create the order with pending_payment status
    let row = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      clientTag, // which address it was made from (a keyed hash), for the ceiling on unpaid orders per address
      lineCount: lineItems.length, // how many lines it was written with: a start-up check compares (services/orderRepair.js)
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
    if (resolved.carrier) row = ordersDB.update(row.id, sealed(row.id));

    // Create order items from quote line items
    for (const [index, item] of lineItems.entries()) {
      // Map from the pricing-engine line-item shape: per-unit price lives at
      // perUnit.final and material/finish/process live under meta.
      orderItemsDB.insert({
        orderId: row.id,
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
    // Done here, in the same change as the order, and not after the call to Stripe: a re-price that
    // arrives while that call is in flight then makes a new quote instead of changing this one.
    quotesDB.update(quoteId, { status: "ordered", userId: quote.userId || req.user.userId });
    return row;
  }, { save: "soon" }); // committed here, in this step; the file is written on the next turn (the route waits for it)

  return { order, resumed: false, itemCount: lineItems.length, description: describe(lineItems), quoteWas: { status: quote.status || "draft", userId: quote.userId || null } };
}

/** The return pages and the metadata of an order's payment page. */
function stripeUrls(req, orderId, quoteId) {
  const baseUrl = orderEvents.baseUrl(req);
  return {
    successUrl: `${baseUrl}/orders/${orderId}?paid=true`,
    cancelUrl: `${baseUrl}/checkout/${quoteId}?cancelled=true`,
    metadata: { quoteId, userId: req.user.userId },
  };
}

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

    // Retrieve the quote (it is read again, afresh, inside the step: this is for who may ask and how heavy the pricing is)
    const first = typeof quoteId === "string" ? quotesDB.getById(quoteId) : null;
    if (!first) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Security: verify quote belongs to requesting user
    if (first.userId && first.userId !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Access denied" });
    }

    // A sender who has used the hour's pricing allowance is told when to come back before any of
    // the work starts; the work itself is charged to the address and the account by the runner.
    const spent = pricingGate.overBudget(req);
    if (spent) {
      res.set("Retry-After", String(spent.retryAfterSeconds));
      return res.status(spent.status).json(spent.body);
    }

    const job = pricingGate.job(req, (first.config && Array.isArray(first.config.parts) ? first.config.parts : first.lineItems) || []);
    const base = orderEvents.baseUrl(req);
    let outcome = null;
    // At most three rounds: a payment page that is open for another amount or delivery choice is
    // settled or closed at Stripe first, and then the step runs again on the order as it is then.
    for (let round = 0; round < 3; round++) {
      try {
        outcome = await pricingMemo.run(() => orderStep(req, quoteId), job);
      } catch (err) {
        // The runner's own refusals (the site is pricing a lot; this quote took too long to price) and
        // any refusal the pricing itself raises: answered as they are, with their Retry-After.
        if (err && err.expose === true && err.status) {
          if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
          return res.status(err.status).json({ error: err.message, ...(err.extra || {}), ...(err.code && !(err.extra && err.extra.code) ? { code: err.code } : {}) });
        }
        throw err;
      }
      if (!outcome || !outcome.closeFirst) break;
      const closed = await lifecycle.closeForChange(outcome.orderId, { base });
      if (closed.paid) return res.json({ sessionUrl: stripeUrls(req, outcome.orderId, quoteId).successUrl, orderId: outcome.orderId });
    }
    if (!outcome || outcome.closeFirst) {
      return res.status(502).json({ error: "We couldn't start the card payment just now. Try again in a minute.", code: "payment-session-busy" });
    }
    if (outcome.refusal) {
      for (const [name, value] of Object.entries(outcome.refusal.headers || {})) res.set(name, value);
      return res.status(outcome.refusal.status).json(outcome.refusal.body);
    }

    const { order } = outcome;
    const urls = stripeUrls(req, order.id, quoteId);
    // The order was committed in the step above; its one write of the file happens now, on its own
    // turn of the event loop, so pricing-and-judging and rewriting the file do not hold the thread
    // back to back. Nothing is acknowledged before it is on the disk: no payment page is opened at
    // Stripe and no answer goes to the buyer until this resolves. (A process killed before the write
    // leaves no order at all, and nobody was told there was one.)
    await require("../models/database").whenSaved();
    // And once more before the payment page is opened and recorded (a second write of the file):
    // whatever else is waiting is served in between, however quickly Stripe answers.
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome.resumed) {
      // The session this order already has, while it is still open for the same amount; a new one only when it is not.
      const again = await checkoutGuard.sessionFor(order, { itemCount: outcome.itemCount, description: outcome.description, ...urls });
      return res.json({ sessionUrl: again.paid ? urls.successUrl : again.session.url, orderId: order.id });
    }

    let session;
    try {
      session = await orderEvents.createCheckoutSession(order, { itemCount: outcome.itemCount, description: outcome.description, ...urls });
    } catch (err) {
      // No session, no order: don't leave an unpayable order behind for every failed try, and
      // give the quote back. Only while the order is still unpaid and no session exists for it.
      // One change, like the one that made it: the order, its lines and the quote go back together.
      const now = ordersDB.getById(order.id);
      if (now && now.status === "pending_payment" && lifecycle.sessionsFor(order.id).length === 0) {
        require("../models/database").transaction(() => {
          for (const it of orderQueries.itemsOf(order.id)) orderItemsDB.delete(it.id);
          ordersDB.delete(order.id);
          const q = quotesDB.getById(quoteId);
          if (q && q.status === "ordered" && orderQueries.ordersOfQuote(quoteId).length === 0) quotesDB.update(quoteId, { status: outcome.quoteWas.status, userId: outcome.quoteWas.userId });
        });
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

    // Create the order, its lines and the quote's new status as ONE change to the database
    // (models/database.js transaction(): all of it reaches the file, or none of it).
    const lineItems = quote.lineItems || [];
    const order = require("../models/database").transaction(() => {
    const order = ordersDB.insert({
      userId: req.user.userId,
      quoteId,
      status: "pending_payment",
      lineCount: lineItems.length, // how many lines it is written with (services/orderRepair.js)
      shippingName: sanitizeString(shippingName || "", 200),
      shippingAddress: sanitizeString(shippingAddress || "", 500),
      shippingCity: sanitizeString(shippingCity || "", 100),
      shippingState: sanitizeString(shippingState || "", 100),
      shippingZip: sanitizeString(shippingZip || "", 20),
      // (The owner's own phone order: a two-letter code, or the United States when it is not one.)
      shippingCountry: require("../services/shipping").countryCode(shippingCountry) || "US",
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
    return order;
    });

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
// GET /api/orders — the order list: one page of summaries, newest first
//
//   ?page=1&pageSize=50   (pageSize 1 to 100)
//   ?attention=1          admin: only orders that are flagged for the owner
//
// A summary is the order's own row as its reader may see it (routes orderView) and how many lines
// it has. It carries NO lines, no part measurements and no DFM results: those are on the
// single-order route, GET /api/orders/:id. The list used to load every line's part (reading its
// measurement file from disk, once per line) and put the measurements in the answer; one account
// with a detailed drawing on four unpaid orders made that answer larger than the site will send,
// for itself and for the owner, whose admin panel then showed nothing (re-review 2026-11-12, F-09).
//
// Now the cost of the list does not depend on what the orders hold: one indexed query for the
// page's rows, one for their line counts, one count. The body is still a JSON array (of the page);
// how many orders there are in all, and which page this is, are in the headers
// X-Total-Count, X-Page, X-Page-Size and X-Page-Count.
// ═══════════════════════════════════════════════════════════════
const LIST_PAGE_DEFAULT = 50;
const LIST_PAGE_MAX = 100;

router.get("/", authenticate, (req, res) => {
  try {
    const admin = req.user.role === "admin";
    const whole = (v, fallback) => { const n = Number.parseInt(String(v === undefined ? "" : v), 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
    const pageSize = Math.min(LIST_PAGE_MAX, whole(req.query.pageSize, LIST_PAGE_DEFAULT));
    const flagged = admin && ["1", "true", "yes"].includes(String(req.query.attention || "").toLowerCase());
    const found = orderQueries.page({ userId: admin ? null : req.user.userId, flagged, page: whole(req.query.page, 1), pageSize });
    const counts = orderQueries.itemCounts(found.rows.map((o) => o.id));
    res.set({
      "X-Total-Count": String(found.total),
      "X-Page": String(found.page),
      "X-Page-Size": String(pageSize),
      "X-Page-Count": String(found.pages),
      "Cache-Control": "no-store",
    });
    res.json(found.rows.map((order) => ({ ...orderView(order, { admin }), itemCount: counts[order.id] || 0 })));
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

    const items = orderQueries.itemsOf(order.id);
    // "Is the file still here" is answered from the part's row: its measurement file is not read
    // (getById would read and parse it, once per line).
    const storedNames = new Map();
    const enrichedItems = items.map((it) => {
      if (it.partId && !storedNames.has(it.partId)) storedNames.set(it.partId, (partsDB.getRow(it.partId) || {}).storedName || null);
      return { ...it, storedName: it.partId ? storedNames.get(it.partId) : null };
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
    const items = orderQueries.itemsOf(order.id);
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

    const items = orderQueries.itemsOf(order.id);

    // Enrich items with part geometry data. Each part is read once, and compared with what was priced
    // once, however many lines name it (reading a detailed part means reading its measurement file).
    const partOf = new Map();
    const hashOf = new Map();
    const enrichedItems = items.map((item) => {
      if (item.partId && !partOf.has(item.partId)) partOf.set(item.partId, partsDB.getById(item.partId));
      const part = item.partId ? partOf.get(item.partId) : null;
      // What was charged for, and whether the stored part is still that part (it is locked once
      // ordered, so `false` means something is wrong and the job must not be cut from this file).
      const check = checkoutGuard.checkAgainst(item, part, hashOf);
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
  res.json({
    ...lifecycle.paymentSettings(),
    needsAttention: orderQueries.flaggedCount(),
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
    let orders = orderState.WORK_QUEUE.flatMap((st) => orderQueries.ordersInStatus(st)).filter((o) => orderState.isWork(o));

    if (status) {
      orders = orders.filter((o) => o.status === status);
    }

    // Sort by date, oldest first (FIFO production).
    // (This line had been joined to the comment above it, so the queue was never sorted; it came out in
    // the order the rows happened to be read. Found while fixing the order lists, 2026-11-13.)
    orders.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

    // Enrich with items: the four columns the queue shows, for all the orders in one indexed query.
    const linesOf = orderQueries.lineSummaries(orders.map((o) => o.id));
    const result = orders.map((order) => {
      const items = linesOf[order.id] || [];
      const { shipAccountEnc, taxCertPath, clientTag, ...row } = order; // the sealed account number, the certificate's path and the address tag stay on the server
      return { ...row, items, itemCount: items.length };
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
