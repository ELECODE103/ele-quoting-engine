/**
 * RFQ routes — firm-quote requests.
 *
 * A quote lands here when the quote gate says a person has to price it
 * (over the instant-order quantity, a DFM failure, an oversize part, a big
 * ticket), or when the buyer simply prefers a firm quote. The budgetary price
 * from the engine is kept with the request so the admin sees what the customer
 * saw.
 *
 *   POST /api/rfq                          create (multipart: optional drawing PDF/DXF/DWG)
 *   GET  /api/rfq/:id                      read (owner, admin, or anonymous-by-id)
 *   GET  /api/rfq/admin/list               admin queue, newest first
 *   PUT  /api/rfq/admin/:id                admin: status / quoted price + lead time / notes.
 *                                          Marking it "quoted" emails the customer the firm
 *                                          quote with a signed accept link.
 *   GET  /api/rfq/quote/:token             customer: the firm quote behind an emailed link
 *   POST /api/rfq/quote/:token/accept      customer: accept → card checkout, or PO number
 *   POST /api/rfq/quote/:token/confirm-payment   customer: settle on return from Stripe
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { rfqsDB, quotesDB, ordersDB, orderItemsDB, materialsDB } = require("../models");
const { authenticate, optionalAuth, requireAdmin } = require("./auth");
const { sanitizeString, isValidEmail } = require("../middleware/validate");
const mailer = require("../services/mailer");
const templates = require("../emails/templates");
const rfqToken = require("../services/rfqToken");
const shipBy = require("../services/shipBy");
const stripeClient = require("../services/stripeClient");
const orderEvents = require("../services/orderEvents");
const brand = require("../../shared/brand.json");

const router = express.Router();

const drawingDir = path.join(__dirname, "..", "..", "data", "rfq-drawings");
if (!fs.existsSync(drawingDir)) fs.mkdirSync(drawingDir, { recursive: true });

// Phone photos arrive as HEIC or WebP as often as JPEG; they are stored for the shop to open, never parsed.
const DRAWING_EXT = [".pdf", ".dxf", ".dwg", ".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp"];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drawingDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DRAWING_EXT.includes(ext)) cb(null, true);
    else cb(Object.assign(new Error("That attachment type isn't accepted. Send a PDF, DXF, DWG, or a photo (JPG, PNG, HEIC)."), { status: 400, expose: true }));
  },
});

/** The one attachment, with upload errors answered in words (not a 500). */
function attachment(req, res, next) {
  upload.single("drawing")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `That file is over 25 MB. Send a smaller one, or email it to ${brand.email}.` });
    res.status(400).json({ error: err.expose ? err.message : "We couldn't read that attachment. Try again, or send the request without it and reply to the confirmation email." });
  });
}

// "accepted" and "expired" are set by the customer's actions and the calendar, not by hand.
const ADMIN_STATUSES = ["new", "in-review", "quoted", "won", "lost", "declined"];
const QUOTE_VALID_DAYS = 30;

function snapshotParts(quote) {
  return (quote.lineItems || []).map((li) => ({
    partId: li.partId,
    fileName: li.fileName,
    process: li.meta?.process || "",
    subProcess: li.meta?.subProcess || "",
    materialSlug: li.meta?.materialSlug || "",
    materialName: materialsDB.getAll().find((m) => m.slug === li.meta?.materialSlug)?.name || "",
    grade: li.meta?.grade || "",
    thicknessMm: li.meta?.thicknessMm || null,
    finishSlug: li.meta?.finishSlug || "",
    quantity: li.quantity,
    budgetUnit: li.perUnit?.final || 0,
    budgetLine: li.lineTotal || 0,
    engine: li.meta?.geometrySummary || null,
  }));
}

// ─── Create ───────────────────────────────────────────────────
router.post("/", optionalAuth, attachment, async (req, res) => {
  try {
    const b = req.body || {};
    const quoteId = sanitizeString(b.quoteId || "", 64);
    const email = (b.email || "").trim().toLowerCase();
    const contactName = sanitizeString(b.contactName || "", 120);

    if (!contactName) return res.status(400).json({ error: "Your name is required" });
    if (!isValidEmail(email)) return res.status(400).json({ error: "A valid email is required" });

    let quote = null;
    if (quoteId) {
      quote = quotesDB.getById(quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found" });
      if (quote.userId && (!req.user || (req.user.userId !== quote.userId && req.user.role !== "admin"))) {
        return res.status(404).json({ error: "Quote not found" });
      }
    }

    const parts = quote ? snapshotParts(quote) : [];
    const process = parts[0]?.process || sanitizeString(b.process || "", 40);

    const rfq = rfqsDB.insert({
      quoteId: quote?.id || null,
      userId: req.user?.userId || quote?.userId || null,
      status: "new",
      contactName,
      email,
      company: sanitizeString(b.company || "", 160),
      phone: sanitizeString(b.phone || "", 40),
      process,
      quantities: sanitizeString(b.quantities || "", 200),
      tolerance: sanitizeString(b.tolerance || "", 200),
      finishNotes: sanitizeString(b.finishNotes || "", 500),
      dueDate: sanitizeString(b.dueDate || "", 40),
      notes: sanitizeString(b.notes || "", 2000),
      drawingFileName: req.file ? sanitizeString(req.file.originalname, 255) : "",
      drawingPath: req.file ? req.file.path : "",
      budgetTotal: quote?.orderTotal || 0,
      reasons: quote?.gate?.reasons || [],
      parts,
    });

    if (quote) quotesDB.update(quote.id, { status: "rfq" });

    // Notify the shop and acknowledge the buyer. Both best-effort.
    mailer.send({ to: mailer.shopNotifyAddress(), replyTo: email, ...templates.rfqReceivedShop({ rfq, adminUrl: `${orderEvents.baseUrl(req)}/admin` }) });
    mailer.send({ to: email, replyTo: mailer.shopNotifyAddress(), ...templates.rfqReceivedBuyer({ rfq }) });

    res.status(201).json({ rfqId: rfq.id, status: rfq.status, turnaroundHours: brand.quoteTurnaroundHours });
  } catch (err) {
    console.error("RFQ create error:", err);
    res.status(500).json({ error: "Could not submit the request. Please try again or call us." });
  }
});

// ─── Firm quote helpers ───────────────────────────────────────

/** A quoted RFQ past its validity date becomes "expired" the next time anyone looks at it. */
function expireIfDue(rfq) {
  if (rfq.status === "quoted" && rfq.validUntil && new Date(rfq.validUntil) < new Date()) {
    return rfqsDB.update(rfq.id, { status: "expired" });
  }
  return rfq;
}

function acceptUrl(rfq, base) {
  return `${base}/firm-quote/${rfqToken.sign(rfq)}`;
}

/** What the admin queue shows: the RFQ, its live accept link while open, and its order once accepted. */
function adminView(rfq, base) {
  const { drawingPath, ...safe } = rfq;
  const order = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
  return {
    ...safe,
    acceptUrl: rfq.status === "quoted" && rfq.quoteSentAt ? acceptUrl(rfq, base) : null,
    orderStatus: order?.status || null,
  };
}

// ─── Admin queue (declared before /:id so "admin" isn't read as an id) ───
router.get("/admin/list", authenticate, requireAdmin, (req, res) => {
  const base = orderEvents.baseUrl(req);
  const all = rfqsDB.getAll().map(expireIfDue).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json(all.map((r) => adminView(r, base)));
});

router.put("/admin/:id", authenticate, requireAdmin, async (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  const b = req.body || {};
  const updates = {};
  if (b.status !== undefined) {
    if (!ADMIN_STATUSES.includes(b.status)) return res.status(400).json({ error: "Invalid status" });
    updates.status = b.status;
  }
  if (b.quotedTotal !== undefined) {
    const n = Number(b.quotedTotal);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "Invalid quoted total" });
    updates.quotedTotal = n;
  }
  if (b.quotedLeadDays !== undefined && b.quotedLeadDays !== null && b.quotedLeadDays !== "") {
    const n = Number(b.quotedLeadDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return res.status(400).json({ error: "Lead time must be a whole number of business days" });
    updates.quotedLeadDays = n;
  }
  if (b.quoteNote !== undefined) updates.quoteNote = sanitizeString(b.quoteNote, 2000);
  if (b.notes !== undefined) updates.notes = sanitizeString(b.notes, 4000);
  // The quantity the firm price covers, per part (the buyer may have asked for several breaks).
  if (b.partQuantities && typeof b.partQuantities === "object") {
    updates.parts = (rfq.parts || []).map((p) => {
      const q = Number(b.partQuantities[p.partId]);
      return Number.isInteger(q) && q > 0 ? { ...p, quotedQuantity: q } : p;
    });
  }

  // Marking it quoted sends the firm quote. Re-sending (a revised price, or
  // `resend`) issues a new link and retires the old one.
  const next = { ...rfq, ...updates };
  const revised = next.quotedTotal !== rfq.quotedTotal || next.quotedLeadDays !== rfq.quotedLeadDays || (next.quoteNote || "") !== (rfq.quoteNote || "");
  const sendQuote = b.status === "quoted" && (rfq.status !== "quoted" || b.resend === true || revised);
  if (sendQuote) {
    if (rfq.status === "accepted") return res.status(409).json({ error: "The customer already accepted this quote" });
    if (!(next.quotedTotal > 0)) return res.status(400).json({ error: "Enter the quoted total before sending the quote" });
    if (next.quotedLeadDays === null || next.quotedLeadDays === undefined) return res.status(400).json({ error: "Enter the lead time in business days before sending the quote" });
    const now = new Date();
    updates.quotedAt = rfq.quotedAt || now.toISOString();
    updates.quoteSentAt = now.toISOString();
    updates.validUntil = new Date(now.getTime() + QUOTE_VALID_DAYS * 864e5).toISOString();
  }

  const updated = rfqsDB.update(rfq.id, updates);
  const base = orderEvents.baseUrl(req);
  let emailSent;
  if (sendQuote) {
    emailSent = await mailer.send({
      to: updated.email,
      replyTo: mailer.shopNotifyAddress(),
      ...templates.rfqQuoted({ rfq: updated, acceptUrl: acceptUrl(updated, base), shipBy: shipBy.shipByDate(updated.quotedLeadDays) }),
    });
  }
  res.json({ ...adminView(updated, base), quoteSent: sendQuote, emailSent });
});

router.get("/admin/:id/drawing", authenticate, requireAdmin, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq || !rfq.drawingPath || !fs.existsSync(rfq.drawingPath)) return res.status(404).json({ error: "No drawing" });
  res.download(rfq.drawingPath, rfq.drawingFileName || path.basename(rfq.drawingPath));
});

// ─── Customer: the firm quote behind an emailed link ──────────
// (declared before /:id so "quote" isn't read as an id)

/** Resolve a quote link to its RFQ, or answer why it can't be used. */
function rfqFromToken(req, res) {
  const claim = rfqToken.verify(req.params.token);
  let rfq = claim ? rfqsDB.getById(claim.rfqId) : null;
  if (!rfq) {
    res.status(404).json({ error: `This quote link isn't valid. Use the link in your latest email from us, or call ${brand.phone}.`, code: "link-invalid" });
    return null;
  }
  if (rfq.quoteSentAt !== claim.v) {
    res.status(410).json({ error: "This link was replaced by a newer quote. Use the link in the latest email from us.", code: "link-superseded" });
    return null;
  }
  rfq = expireIfDue(rfq);
  // An expired link still opens for a buyer who accepted in time (it is their order page).
  if (claim.expired && rfq.status !== "accepted") {
    res.status(410).json({ error: `This quote expired on ${new Date(rfq.validUntil).toLocaleDateString("en-US", { timeZone: shipBy.SHOP_TZ, month: "long", day: "numeric", year: "numeric" })}. Reply to the quote email or call ${brand.phone} and we'll refresh it.`, code: "quote-expired" });
    return null;
  }
  return rfq;
}

function customerView(rfq) {
  const order = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
  return {
    reference: templates.shortId(rfq.id),
    status: rfq.status,
    contactName: rfq.contactName,
    company: rfq.company || "",
    email: rfq.email,
    parts: (rfq.parts || []).map((p) => ({
      fileName: p.fileName, process: p.process, materialName: p.materialName || p.materialSlug, quantity: p.quotedQuantity || p.quantity,
    })),
    quantities: rfq.quantities || "",
    quotedTotal: rfq.quotedTotal,
    quotedLeadDays: rfq.quotedLeadDays,
    // If accepted today; the order carries the committed date once there is one.
    shipBy: rfq.quotedLeadDays !== null && rfq.quotedLeadDays !== undefined ? shipBy.shipByDate(rfq.quotedLeadDays) : null,
    validUntil: rfq.validUntil,
    quoteNote: rfq.quoteNote || "",
    acceptedAt: rfq.acceptedAt || null,
    acceptedVia: rfq.acceptedVia || null,
    poNumber: rfq.poNumber || "",
    order: order ? {
      reference: templates.shortId(order.id),
      status: order.status,
      total: order.total,
      shipBy: order.shipBy || null,
      carrier: order.carrier || "",
      trackingNumber: order.trackingNumber || "",
      trackingUrl: templates.trackingUrl(order.carrier, order.trackingNumber),
      shippedAt: order.shippedAt || null,
    } : null,
  };
}

router.get("/quote/:token", (req, res) => {
  const rfq = rfqFromToken(req, res);
  if (rfq) res.json(customerView(rfq));
});

/** Split the quoted total across the RFQ's parts in proportion to their budgetary lines. */
function orderItemsFor(rfq) {
  const parts = rfq.parts || [];
  const total = rfq.quotedTotal;
  if (parts.length === 0) {
    return [{ fileName: "Parts per firm quote", process: rfq.process || "", quantity: 1, unitPrice: total, lineTotal: total, config: { rfqId: rfq.id } }];
  }
  const weights = parts.map((p) => Number(p.budgetLine) || 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  let allocated = 0;
  return parts.map((p, i) => {
    const share = sum > 0 ? weights[i] / sum : 1 / parts.length;
    const lineTotal = i === parts.length - 1 ? Math.round((total - allocated) * 100) / 100 : Math.round(total * share * 100) / 100;
    allocated += lineTotal;
    const quantity = p.quotedQuantity || p.quantity || 1;
    return {
      partId: p.partId, fileName: p.fileName, process: p.process || "",
      materialSlug: p.materialSlug || "", materialName: p.materialName || "", finishSlug: p.finishSlug || "",
      quantity, unitPrice: lineTotal / quantity, lineTotal,
      config: { rfqId: rfq.id, subProcess: p.subProcess || "", grade: p.grade || "", thicknessMm: p.thicknessMm || null },
    };
  });
}

/**
 * Accept the firm quote.
 *   method "card" → an order awaiting payment + a Stripe Checkout session
 *   method "po"   → an order awaiting PO confirmation; the PO number is stored.
 *                   Nothing is billed here: the shop confirms the PO by hand.
 */
router.post("/quote/:token/accept", async (req, res) => {
  try {
    const rfq = rfqFromToken(req, res);
    if (!rfq) return;
    const b = req.body || {};
    const method = b.method;
    if (method !== "card" && method !== "po") return res.status(400).json({ error: "Choose card or purchase order" });
    const base = orderEvents.baseUrl(req);
    const stripeUrls = {
      successUrl: `${base}/firm-quote/${req.params.token}?paid=true`,
      cancelUrl: `${base}/firm-quote/${req.params.token}?cancelled=true`,
    };

    if (rfq.status === "accepted") {
      // Card checkout abandoned part-way: let them pay for the same order.
      const existing = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
      if (method === "card" && existing && existing.status === "pending_payment") {
        const session = await orderEvents.createCheckoutSession(existing, { itemCount: (rfq.parts || []).length || 1, description: `Firm quote ${templates.shortId(rfq.id)}`, ...stripeUrls, metadata: { rfqId: rfq.id } });
        return res.json({ status: "accepted", method, sessionUrl: session.url });
      }
      return res.status(409).json({ error: "This quote has already been accepted", code: "already-accepted" });
    }
    if (rfq.status !== "quoted") {
      return res.status(409).json({ error: `This quote is no longer open. Call ${brand.phone} and we'll sort it out.`, code: "not-open" });
    }

    const shipping = {
      shippingName: sanitizeString(b.shippingName || "", 200),
      shippingAddress: sanitizeString(b.shippingAddress || "", 500),
      shippingCity: sanitizeString(b.shippingCity || "", 100),
      shippingState: sanitizeString(b.shippingState || "", 100),
      shippingZip: sanitizeString(b.shippingZip || "", 20),
      shippingCountry: sanitizeString(b.shippingCountry || "US", 5),
    };
    if (!shipping.shippingName || !shipping.shippingAddress || !shipping.shippingCity || !shipping.shippingState || !shipping.shippingZip) {
      return res.status(400).json({ error: "Add the full ship-to address" });
    }
    const poNumber = sanitizeString(b.poNumber || "", 60);
    if (method === "po" && !poNumber) return res.status(400).json({ error: "Enter your purchase order number" });
    if (method === "card" && !stripeClient.get()) return res.status(503).json({ error: `Card payment isn't available right now. Call ${brand.phone}.` });

    const days = rfq.quotedLeadDays;
    const order = ordersDB.insert({
      userId: rfq.userId || null,
      quoteId: rfq.quoteId || null,
      rfqId: rfq.id,
      status: method === "po" ? "pending_po" : "pending_payment",
      ...shipping,
      shippingMethod: "standard",
      shippingCost: 0,
      subtotal: rfq.quotedTotal,
      tax: 0,
      total: rfq.quotedTotal,
      notes: "",
      paymentMethod: method,
      poNumber: method === "po" ? poNumber : "",
      customerEmail: rfq.email,
      customerName: rfq.contactName,
      leadTimeName: `${days} business day${days === 1 ? "" : "s"}`,
      leadDays: days,
      shipBy: shipBy.shipByDate(days),
      customerNotes: rfq.quoteNote || "",
      drawingFileName: rfq.drawingFileName || "",
      drawingPath: rfq.drawingPath || "",
    });
    const items = orderItemsFor(rfq).map((it) => orderItemsDB.insert({ orderId: order.id, ...it }));

    let session = null;
    if (method === "card") {
      try {
        session = await orderEvents.createCheckoutSession(order, { itemCount: items.length, description: `Firm quote ${templates.shortId(rfq.id)}`, ...stripeUrls, metadata: { rfqId: rfq.id } });
      } catch (err) {
        // No session, no order: leave the quote open so the buyer can try again.
        for (const it of items) orderItemsDB.delete(it.id);
        ordersDB.delete(order.id);
        console.error("RFQ accept: checkout session failed:", err.message);
        return res.status(502).json({ error: `We couldn't start the card payment. Try again, or call ${brand.phone}.` });
      }
    }

    const accepted = rfqsDB.update(rfq.id, {
      status: "accepted",
      acceptedAt: new Date().toISOString(),
      acceptedVia: method,
      poNumber: method === "po" ? poNumber : "",
      orderId: order.id,
    });

    // The shop hears about every acceptance. A PO buyer gets their confirmation
    // now; a card buyer gets it when the payment clears.
    const sends = [mailer.send({ to: mailer.shopNotifyAddress(), replyTo: rfq.email, ...templates.rfqAcceptedShop({ rfq: accepted, order, adminUrl: `${base}/admin` }) })];
    if (method === "po") {
      sends.push(mailer.send({ to: rfq.email, replyTo: mailer.shopNotifyAddress(), ...templates.orderConfirmation({ order, items, orderUrl: orderEvents.orderUrl(order, base) }) }));
    }
    await Promise.all(sends);

    res.status(201).json({ status: "accepted", method, sessionUrl: session?.url || null });
  } catch (err) {
    console.error("RFQ accept error:", err.message);
    res.status(500).json({ error: `Something went wrong on our side. Call ${brand.phone} and we'll take the order by phone.` });
  }
});

router.post("/quote/:token/confirm-payment", async (req, res) => {
  try {
    const rfq = rfqFromToken(req, res);
    if (!rfq) return;
    const order = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
    if (order) await orderEvents.confirmPayment(order, { base: orderEvents.baseUrl(req) });
    res.json(customerView(rfq));
  } catch (err) {
    console.error("RFQ confirm payment error:", err.message);
    res.status(502).json({ error: "Could not confirm the payment yet" });
  }
});

// ─── Read ─────────────────────────────────────────────────────
router.get("/:id", optionalAuth, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (rfq.userId && (!req.user || (req.user.userId !== rfq.userId && req.user.role !== "admin"))) {
    return res.status(404).json({ error: "RFQ not found" });
  }
  const { drawingPath, ...safe } = rfq;
  res.json(safe);
});

module.exports = router;
