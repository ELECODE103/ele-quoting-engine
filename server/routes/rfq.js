/**
 * RFQ routes — firm-quote requests.
 *
 * A quote lands here when the quote gate says a person has to price it
 * (over the instant-order quantity, a DFM failure, an oversize part, a big
 * ticket), or when the buyer simply prefers a firm quote. The budgetary price
 * from the engine is kept with the request so the admin sees what the customer
 * saw.
 *
 *   POST /api/rfq                          create (multipart: optional drawing PDF/DXF/DWG).
 *                                          Bot-checked (see "Create" below): the buyer's
 *                                          confirmation email and, for a part request, the
 *                                          ship-to address go out only to a sender who passed.
 *                                          requestType=part (a worn part, no drawing): the buyer
 *                                          ships the part in; the response and the confirmation
 *                                          email carry a reference and the ship-to address.
 *                                          paperwork=true: a first-article report and a certificate
 *                                          of conformance are wanted; returnPart=true (part requests):
 *                                          the original goes back with the order. Both are stored so
 *                                          the owner prices them in, and the firm quote says so.
 *   GET  /api/rfq/:id                      read: the signed-in owner or an admin gets the request;
 *                                          anyone else holding the id of a request sent without an
 *                                          account gets its status only (no contact details)
 *   GET  /api/rfq/admin/list               admin queue, newest first
 *   PUT  /api/rfq/admin/:id                admin: status / quoted price + lead time / notes /
 *                                          whether the price includes the inspection paperwork
 *                                          and the return of a shipped-in part.
 *                                          Marking it "quoted" emails the customer the firm
 *                                          quote with a signed accept link.
 *   GET  /api/rfq/quote/:token             customer: the firm quote behind an emailed link
 *   POST /api/rfq/quote/:token/accept      customer: accept → card checkout, or PO number.
 *                                          shippingOption ("ship" | "carrier-account" | "pickup") is honoured
 *                                          only when the admin has switched that choice on; the quoted
 *                                          total never changes with it. A purchase order's tax is per invoice.
 *   POST|DELETE /api/rfq/quote/:token/tax-certificate   customer: attach / remove an exemption certificate
 *                                          before accepting (same guards as a drawing)
 *   POST /api/rfq/quote/:token/confirm-payment   customer: settle on return from Stripe
 *   POST /api/rfq/return/confirm           the page Stripe sends a firm-quote buyer back to: "has this
 *                                          order been paid?" for one order, by a short-lived return token.
 *                                          The quote link itself is never given to Stripe.
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID: uuidv4 } = require("crypto"); // RFC 4122 v4, same format the uuid package produced
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
const shopFacts = require("../shopFacts");
const crypto = require("crypto");
const botGuard = require("../security/botGuard");
const turnstile = require("../security/turnstile");
const { singleLine, singleLines, poNumber: checkPoNumber, SHIPPING_RULES } = require("../middleware/singleLine");
const returnToken = require("../services/returnToken");
const lifecycle = require("../services/orderLifecycle");
const checkout = require("../services/checkout");           // delivery choices and tax settings
const shippingService = require("../services/shipping");
const taxCertificates = require("../services/taxCertificates");
// Where a buyer ships a worn part. Server-side only: it is given out after a
// request is sent by someone who passed the bot check (response + email),
// never on a public page and never to an unverified sender.
const shipFrom = require("../config/shipFrom.json");

const quoteIntegrity = require("../services/quoteIntegrity");

const router = express.Router();

/** Reference + address a buyer needs to ship a part in for measuring. */
function partShipTo(rfqId) {
  return {
    reference: templates.shortId(rfqId),
    shipTo: { name: shopFacts.businessName(brand), lines: [shipFrom.address, `${shipFrom.city}, ${shipFrom.state} ${shipFrom.zip}`] },
  };
}

const drawingDir = path.join(require("../security/uploadGuards").DATA_DIR, "rfq-drawings"); // data/rfq-drawings (QUOTING_DATA_DIR moves it for tests)
if (!fs.existsSync(drawingDir)) fs.mkdirSync(drawingDir, { recursive: true });

// Phone photos arrive as HEIC or WebP as often as JPEG; they are stored for the shop to open, never parsed.
// The list and the per-type content check live in middleware/fileValidator.js.
const { attachmentMatchesExtension, ATTACHMENT_EXTENSIONS: DRAWING_EXT } = require("../middleware/fileValidator");
const ATTACHMENT_TYPES = "Send a PDF, DXF, DWG, or a photo (JPG, PNG, HEIC).";
const upload = multer({
  defParamCharset: "utf8", // a file name is read as UTF-8; it is only ever a label
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drawingDir),
    // The stored name is ours: a random id plus an extension from the allow-list. Nothing the client sent is in the path.
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!DRAWING_EXT.includes(ext)) return cb(new Error("unsupported extension"));
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  // One file, and a form's worth of short text fields: the multipart parser itself is bounded.
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 40, fieldSize: 64 * 1024, fieldNameSize: 100, parts: 45, headerPairs: 50 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DRAWING_EXT.includes(ext)) cb(null, true);
    else cb(Object.assign(new Error(`That attachment type isn't accepted. ${ATTACHMENT_TYPES}`), { status: 400, expose: true }));
  },
});

/** Remove a file this request put on disk; resolves once it is gone (never throws). */
async function removeFile(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch (err) { if (err.code !== "ENOENT") console.error("RFQ: could not remove a refused attachment:", err.code || err.name); }
}

/**
 * The one attachment, with upload errors answered in words (not a 500), and
 * its contents checked against its extension before the route sees it: a file
 * that is not what its name says is deleted and the request refused.
 */
function attachment(req, res, next) {
  upload.single("drawing")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `That file is over 25 MB. Send a smaller one, or email it to ${brand.email}.` });
      return res.status(400).json({ error: err.expose ? err.message : "We couldn't read that attachment. Try again, or send the request without it and reply to the confirmation email." });
    }
    if (req.file) {
      // Every way out of this request that does not keep the file deletes it first (see the route).
      req.attachmentPaths = new Set([req.file.path]);
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!attachmentMatchesExtension(req.file.path, ext)) {
        await removeFile(req.file.path);
        return res.status(400).json({ error: `That file isn't what its name says it is (${ext.slice(1).toUpperCase()}). ${ATTACHMENT_TYPES} Or send the request without it and email the file to ${brand.email}.`, code: "content-mismatch" });
      }
    }
    next();
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
//
// Anyone can send a request, so three things are decided per request:
//
//   is the sender verified?   yes when the Turnstile check passed, or when the
//                             request comes from a signed-in account with a
//                             confirmed email and is for that account's address.
//                             With Turnstile configured, a missing or rejected
//                             token refuses the request. With no keys (or with
//                             Cloudflare unreachable) the request is taken as
//                             an UNVERIFIED sender, so no lead is lost.
//   does the buyer get mail?  only a verified sender, never a signed-in account
//                             that has not confirmed its email, and within the
//                             daily cap per recipient address and per IP.
//   is the ship-to address    only to a verified sender, on screen and by email.
//   given out?
//
// The shop is always told, and told when the sender is unverified.

/** Who is behind this request, as far as we can tell. */
async function assessSender(req, email) {
  const accountSender = Boolean(req.user && req.user.emailVerified && req.user.email === email);
  const hasToken = Boolean(req.headers["x-turnstile-token"] || (req.body && (req.body.turnstileToken || req.body["cf-turnstile-response"])));
  if (accountSender && !(turnstile.configured() && hasToken)) return { verified: true, method: "account" };
  const human = await botGuard.assess(req, { action: "rfq", allowAccount: false, allowHumanToken: false });
  if (!human.verified && accountSender) return { verified: true, method: "account" };
  return human;
}

router.post("/", optionalAuth, attachment, async (req, res) => {
  let check = null;
  // A request that is refused, replayed or fails must not leave its attachment behind: every
  // path below that does not store the request awaits this before it answers. It covers the
  // file as multer wrote it and, once encrypted, the file under its stored name.
  let kept = false;
  const dropFile = async () => {
    if (kept || !req.attachmentPaths) return;
    await Promise.all([...req.attachmentPaths].map(removeFile));
    req.attachmentPaths.clear();
  };
  try {
    const b = req.body || {};
    const quoteId = sanitizeString(b.quoteId || "", 64);
    // Spaces around a pasted address are dropped; any other stray character (a line break, a NUL) is left for validation to refuse.
    const email = (typeof b.email === "string" ? b.email : "").replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
    // Name, company and phone are one line each: they are printed on documents and shown in emails,
    // so a value with a line break or hidden characters is refused here, not quietly rewritten.
    const lines = singleLines(b, {
      contactName: { label: "Your name", max: 1000 },
      company: { label: "The company name", max: 1000 },
      phone: { label: "The phone number", max: 1000 },
    });
    if (!lines.ok) { await dropFile(); return res.status(400).json({ error: lines.error, code: lines.code, field: lines.field }); }
    const contactName = sanitizeString(lines.values.contactName, 120);

    if (!contactName) { await dropFile(); return res.status(400).json({ error: "Your name is required" }); }
    if (!isValidEmail(email) || !mailer.cleanAddress(email)) { await dropFile(); return res.status(400).json({ error: "A valid email is required" }); }

    const sendPart = !quoteId && String(b.requestType || "") === "part";

    // Honeypot, per-IP and per-address limits, minimum time to submit, duplicates.
    check = botGuard.checkForm(req, {
      form: "rfq",
      email,
      dedupe: [contactName, quoteId, sendPart, String(b.notes || ""), String(b.quantities || ""), req.file ? req.file.originalname : "", req.file ? req.file.size : 0],
    });
    if (!check.ok) {
      await dropFile();
      if (check.honeypot) {
        // A script filled the field no person sees. It gets an answer shaped like a success and nothing happens.
        return res.status(201).json({ rfqId: crypto.randomUUID(), status: "new", turnaroundHours: brand.quoteTurnaroundHours, paperwork: false, confirmationEmail: true });
      }
      return res.status(check.status).json({ error: check.error, code: check.code });
    }
    if (check.replay) {
      // The same request again inside half an hour (a double click, a retry): the first answer, no second request.
      await dropFile();
      return res.status(201).json({ ...check.replay, duplicate: true });
    }

    let quote = null;
    if (quoteId) {
      quote = quotesDB.getById(quoteId);
      const hidden = quote && quote.userId && (!req.user || (req.user.userId !== quote.userId && req.user.role !== "admin"));
      if (!quote || hidden) {
        await dropFile();
        botGuard.releaseForm(check);
        return res.status(404).json({ error: "Quote not found" });
      }
    }

    const sender = await assessSender(req, email);
    if (!sender.verified && sender.method === "failed") {
      await dropFile();
      botGuard.releaseForm(check);
      return res.status(403).json({ error: botGuard.MESSAGES.humanRequired, code: "human-check-required" });
    }
    const senderVerified = sender.verified;
    // Senders who could not be verified share one hourly allowance for the whole site (botGuard.js):
    // per-client limits alone do not stop a flood sent from many addresses.
    const senderKey = require("../security/clientKey").clientKey(req);
    if (!senderVerified && botGuard.unverifiedRequestsFull(Date.now(), senderKey)) {
      await dropFile();
      botGuard.releaseForm(check);
      botGuard.noteUnverifiedRefused();
      res.set("Retry-After", "1800");
      return res.status(429).json({ error: botGuard.MESSAGES.requestsPaused, code: "requests-paused" });
    }
    // The files behind the quote must still be here: a request for parts we no longer hold is a
    // request the shop cannot quote (services/fileRetention.js partFilesPresent).
    if (quote) {
      const files = require("../services/fileRetention").partFilesPresent((quote.lineItems || []).map((li) => li && li.partId));
      if (!files.ok) {
        await dropFile();
        botGuard.releaseForm(check);
        return res.status(409).json({ error: files.message, code: files.code, missing: files.missing });
      }
    }
    // An account that has not confirmed its email does not trigger mail to that address yet.
    const accountUnconfirmed = Boolean(req.user && !req.user.emailVerified && mailer.configured());
    const buyerEmail = senderVerified && !accountUnconfirmed && botGuard.allowConfirmationEmail(req, email);

    const parts = quote ? snapshotParts(quote) : [];
    const process = parts[0]?.process || sanitizeString(b.process || "", 40);
    // Checkboxes arrive as multipart text ("true" / "false"). The return box is on by default on
    // the form, but a request that does not send it at all (an older client, a hand-built post)
    // is not assumed to want anything back.
    const ticked = (v) => v === true || v === "true" || v === "1" || v === "on";
    // Inspection paperwork: asked for here, or already chosen on the online quote this request came from.
    const paperwork = ticked(b.paperwork) || (b.paperwork === undefined && Boolean(quote?.paperwork));
    const returnPart = sendPart && ticked(b.returnPart);

    // Encrypted at rest when NORD_FILE_ENC_KEY is set; the stored path (….enc) is tracked so a failure after this still cleans up.
    let drawingPath = "";
    if (req.file) {
      drawingPath = await require("../services/fileCrypto").encryptFile(req.file.path);
      req.attachmentPaths.add(drawingPath);
    }

    const rfq = rfqsDB.insert({
      quoteId: quote?.id || null,
      userId: req.user?.userId || quote?.userId || null,
      status: "new",
      contactName,
      email,
      company: sanitizeString(lines.values.company, 160),
      phone: sanitizeString(lines.values.phone, 40),
      process,
      quantities: sanitizeString(b.quantities || "", 200),
      tolerance: sanitizeString(b.tolerance || "", 200),
      finishNotes: sanitizeString(b.finishNotes || "", 500),
      dueDate: sanitizeString(b.dueDate || "", 40),
      notes: sanitizeString(b.notes || "", 2000),
      drawingFileName: req.file ? require("../security/uploadGuards").safeFileName(req.file.originalname, "attachment") : "",
      drawingPath,
      budgetTotal: quote?.orderTotal || 0,
      reasons: quote?.gate?.reasons || [],
      parts,
      requestType: sendPart ? "part" : "",
      // The owner prices both of these into the firm quote; the quote then says so.
      paperwork,
      returnPart,
      // "turnstile" / "account" when the sender was verified; "none" when not.
      senderCheck: senderVerified ? sender.method : "none",
      buyerEmailed: buyerEmail,
      // Whose stored bytes the attachment is (a keyed hash of the client key) and how many.
      clientTag: req.file ? require("../security/uploadGuards").clientTag(require("../security/clientKey").clientKey(req)) : "",
      drawingBytes: req.file ? req.file.size : 0,
    });
    if (!senderVerified) botGuard.countUnverifiedRequest(Date.now(), senderKey);

    kept = true; // the request row owns the attachment now
    if (req.file) require("../security/uploadGuards").storage.add(req.file.size);

    if (quote) quotesDB.update(quote.id, { status: "rfq" });

    // The ship-to address is for verified senders only.
    const part = sendPart ? partShipTo(rfq.id) : null;
    const partForBuyer = sendPart && senderVerified ? part : null;

    // Notify the shop; acknowledge the buyer when allowed. Both best-effort.
    mailer.send({
      to: mailer.shopNotifyAddress(),
      // Reply-To is the typed address only when its sender was verified.
      replyTo: senderVerified ? email : undefined,
      ...templates.rfqReceivedShop({ rfq, adminUrl: `${orderEvents.baseUrl(req)}/admin`, part, unverified: !senderVerified, buyerEmailed: buyerEmail, partPending: sendPart && !partForBuyer }),
    });
    // confirmedRecipient: a signed-in customer writing from their own confirmed address (not counted against the site-wide cap on mail to unconfirmed addresses).
    if (buyerEmail) mailer.send({ to: email, replyTo: mailer.shopNotifyAddress(), confirmedRecipient: sender.method === "account", clientKey: senderKey, ...templates.rfqReceivedBuyer({ rfq, part: partForBuyer }) });

    const response = {
      rfqId: rfq.id,
      status: rfq.status,
      turnaroundHours: brand.quoteTurnaroundHours,
      paperwork: Boolean(rfq.paperwork),
      // What the page should tell the buyer about email and, for a part, the address.
      senderVerified,
      confirmationEmail: buyerEmail,
      // Why no confirmation went out, so the page can say what happened and not guess:
      //   "sender-unverified"    the bot check is off or could not be reached (a person replies instead)
      //   "account-unconfirmed"  signed in, but the account's email is not confirmed yet
      //   "daily-limit"          the cap on confirmations to one address or connection was reached
      ...(buyerEmail ? {} : { noEmailReason: !senderVerified ? "sender-unverified" : accountUnconfirmed ? "account-unconfirmed" : "daily-limit" }),
      ...(accountUnconfirmed ? { needsEmailVerification: true } : {}),
      ...(sendPart ? { reference: part.reference, returnPart: Boolean(rfq.returnPart), ...(partForBuyer ? { shipTo: part.shipTo } : { shipToPending: true }) } : {}),
    };
    botGuard.recordForm(req, check, { email, response });
    res.status(201).json(response);
  } catch (err) {
    await dropFile();
    botGuard.releaseForm(check);
    console.error("RFQ create error:", err.message);
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

/**
 * Have the terms of a quote that is out changed since it was sent? Then the emailed link is
 * dead until the owner sends the quote again (review F-9). A quote sent before the terms were
 * recorded has nothing to compare with; it is stamped the first time it is looked at or edited.
 */
function termsChanged(rfq) {
  return rfq.status === "quoted" && Boolean(rfq.sentTerms) && rfqToken.termsFingerprint(rfq) !== rfq.sentTerms;
}
function stampSentTerms(rfq) {
  if (rfq.status === "quoted" && rfq.quoteSentAt && !rfq.sentTerms) return rfqsDB.update(rfq.id, { sentTerms: rfqToken.termsFingerprint(rfq) });
  return rfq;
}

/** What the admin queue shows: the RFQ, its live accept link while open, and its order once accepted. */
function adminView(rfq, base) {
  const { drawingPath, taxCertPath, ...safe } = rfq;
  const order = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
  return {
    ...safe,
    // The link as it was emailed. None while the quote's terms differ from what was sent.
    acceptUrl: rfq.status === "quoted" && rfq.quoteSentAt && !termsChanged(rfq) ? acceptUrl(rfq, base) : null,
    needsResend: termsChanged(rfq),
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
  let rfq = rfqsDB.getById(req.params.id);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  rfq = stampSentTerms(rfq); // before anything is changed: what is out is what the buyer was sent
  const b = req.body || {};
  // Once the customer has accepted there is an order at the quoted terms; they are not edited underneath it.
  if (rfq.status === "accepted" && ["quotedTotal", "quotedLeadDays", "partQuantities", "paperwork", "returnPart", "quoteNote"].some((k) => b[k] !== undefined)) {
    const same = (b.quotedTotal === undefined || Number(b.quotedTotal) === rfq.quotedTotal)
      && (b.quotedLeadDays === undefined || b.quotedLeadDays === null || b.quotedLeadDays === "" || Number(b.quotedLeadDays) === rfq.quotedLeadDays)
      && (b.quoteNote === undefined || sanitizeString(b.quoteNote, 2000) === (rfq.quoteNote || ""))
      && (typeof b.paperwork !== "boolean" || b.paperwork === Boolean(rfq.paperwork))
      && (typeof b.returnPart !== "boolean" || b.returnPart === Boolean(rfq.returnPart))
      && !b.partQuantities;
    if (!same) return res.status(409).json({ error: "The customer already accepted this quote, so its price and terms can no longer be changed here.", code: "quote-accepted" });
  }
  const updates = {};
  if (b.status !== undefined) {
    if (!ADMIN_STATUSES.includes(b.status)) return res.status(400).json({ error: "Invalid status" });
    updates.status = b.status;
  }
  if (b.quotedTotal !== undefined) {
    // The owner's amount is the owner's, honoured as typed — but it has to be an amount of money:
    // a finite number of dollars and cents within reason (services/quoteIntegrity.js).
    // A quote that is already out with the customer is live at whatever is saved here, so it cannot be
    // saved at nothing (payments review F-09b): the same rule as sending it.
    const amount = quoteIntegrity.firmQuoteAmount(b.quotedTotal, { sending: rfq.status === "quoted" });
    if (!amount.ok) return res.status(400).json({ error: rfq.status === "quoted" && amount.error !== "Invalid quoted total" ? "This quote is out with the customer: enter the amount it should be, or withdraw it." : amount.error, code: "quoted-total-invalid" });
    updates.quotedTotal = amount.total;
  }
  if (b.quotedLeadDays !== undefined && b.quotedLeadDays !== null && b.quotedLeadDays !== "") {
    const n = Number(b.quotedLeadDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return res.status(400).json({ error: "Lead time must be a whole number of business days" });
    updates.quotedLeadDays = n;
  }
  if (b.quoteNote !== undefined) updates.quoteNote = sanitizeString(b.quoteNote, 2000);
  // What the price covers besides the parts. They start as the customer ticked them; the owner can
  // change either before sending (a phone call added the paperwork, say), because the quote email,
  // page and PDF state both as fact.
  if (typeof b.paperwork === "boolean") updates.paperwork = b.paperwork;
  if (typeof b.returnPart === "boolean" && rfq.requestType === "part") updates.returnPart = b.returnPart;
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
  const revised = next.quotedTotal !== rfq.quotedTotal || next.quotedLeadDays !== rfq.quotedLeadDays || (next.quoteNote || "") !== (rfq.quoteNote || "")
    || Boolean(next.paperwork) !== Boolean(rfq.paperwork) || Boolean(next.returnPart) !== Boolean(rfq.returnPart);
  // Terms that were saved earlier without sending count too: pressing send then really sends them.
  const sendQuote = b.status === "quoted" && (rfq.status !== "quoted" || b.resend === true || revised || termsChanged(rfq));
  if (sendQuote) {
    if (rfq.status === "accepted") return res.status(409).json({ error: "The customer already accepted this quote" });
    const sendable = quoteIntegrity.firmQuoteAmount(next.quotedTotal, { sending: true });
    if (!sendable.ok) return res.status(400).json({ error: sendable.error, code: "quoted-total-invalid" });
    if (next.quotedLeadDays === null || next.quotedLeadDays === undefined) return res.status(400).json({ error: "Enter the lead time in business days before sending the quote" });
    const now = new Date();
    updates.quotedAt = rfq.quotedAt || now.toISOString();
    updates.quoteSentAt = now.toISOString();
    updates.validUntil = new Date(now.getTime() + QUOTE_VALID_DAYS * 864e5).toISOString();
    // The link that goes out is for exactly these terms.
    updates.sentTerms = rfqToken.termsFingerprint({ ...next, ...updates });
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
  // A firm price far under the budgetary price the buyer was shown is allowed (the owner decides) but
  // worth a second look before it goes out: a slipped digit is the usual cause.
  const budget = Number(updated.budgetTotal) || 0;
  const priceWarning = updates.quotedTotal !== undefined && updated.quotedTotal > 0 && budget > 0 && updated.quotedTotal < budget * 0.25
    ? `The quoted total is less than a quarter of the online estimate the buyer saw (${templates.money(budget)}). Check the amount.`
    : null;
  if (priceWarning) console.warn(`[quote-integrity] firm quote ${templates.shortId(updated.id)} set to ${updated.quotedTotal} against a budgetary ${budget}`);
  // Terms saved without sending: the link the customer holds no longer works until this is sent again.
  const linkInvalidated = !sendQuote && termsChanged(updated) && !termsChanged(rfq);
  res.json({ ...adminView(updated, base), quoteSent: sendQuote, emailSent, ...(priceWarning ? { priceWarning } : {}), ...(linkInvalidated ? { linkInvalidated: true } : {}) });
});

router.get("/admin/:id/drawing", authenticate, requireAdmin, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq || !rfq.drawingPath || !fs.existsSync(rfq.drawingPath)) return res.status(404).json({ error: "No drawing" });
  require("../services/fileCrypto").sendDownload(res, rfq.drawingPath, rfq.drawingFileName); // decrypts when stored encrypted; always an attachment
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
  rfq = stampSentTerms(expireIfDue(rfq));
  req.rfqClaim = claim;
  // The link was issued for one set of terms and one amount. If the quote has been edited since
  // and not sent again, the link does not open it: nobody accepts terms they were not sent.
  if (rfq.status === "quoted" && (termsChanged(rfq) || (claim.amt !== null && claim.amt !== rfqToken.amountCents(rfq)))) {
    res.status(409).json({ error: `This quote was changed after this link was sent, so the link no longer works. We'll email you the updated quote; use the link in that email, or call ${brand.phone}.`, code: "quote-changed", linkReplaced: true });
    return null;
  }
  // An expired link still opens for a buyer who accepted in time (it is their order page).
  if (claim.expired && rfq.status !== "accepted") {
    res.status(410).json({ error: `This quote expired on ${new Date(rfq.validUntil).toLocaleDateString("en-US", { timeZone: shipBy.SHOP_TZ, month: "long", day: "numeric", year: "numeric" })}. Reply to the quote email or call ${brand.phone} and we'll refresh it.`, code: "quote-expired" });
    return null;
  }
  return rfq;
}

function customerView(rfq, claim) {
  const order = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
  const pay = order ? lifecycle.paymentView(order) : null;
  return {
    // The amount this link was issued for (a link from before links carried one shows the quote's own).
    linkAmount: claim && claim.amt !== null && claim.amt !== undefined ? claim.amt / 100 : rfq.quotedTotal,
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
    // What the firm price covers besides the parts, in the same sentences as the email and the PDF.
    paperwork: Boolean(rfq.paperwork),
    partRequest: templates.isPartRequest(rfq),
    returnPart: Boolean(rfq.returnPart),
    covers: templates.quoteCovers(rfq),
    acceptedAt: rfq.acceptedAt || null,
    acceptedVia: rfq.acceptedVia || null,
    poNumber: rfq.poNumber || "",
    // While the quote is open: the delivery choices the shop offers and what it says about tax.
    checkout: rfq.status === "quoted" ? checkout.firmView() : null,
    taxCertFileName: rfq.taxCertFileName || "",
    order: order ? {
      reference: templates.shortId(order.id),
      status: order.status,
      total: order.total,
      // How it is delivered (carrier account masked), the tax line, and for a paid pickup order the address.
      ...(({ shippingMethod, deliveryLine, taxLine, pickupAddress, tax, taxExempt, taxExemptStatus }) => ({ shippingMethod: shippingMethod || "standard", deliveryLine, taxLine, pickupAddress: pickupAddress || null, tax: tax || 0, taxExempt: Boolean(taxExempt), taxExemptStatus: taxExemptStatus || "" }))(checkout.orderView(order)),
      shipBy: order.shipBy || null,
      carrier: order.carrier || "",
      trackingNumber: order.trackingNumber || "",
      trackingUrl: templates.trackingUrl(order.carrier, order.trackingNumber),
      shippedAt: order.shippedAt || null,
      // Payment facts in plain form: what was paid, any discount, anything refunded, and
      // whether a payment is being checked by hand. The reason for a check stays with the shop.
      amountPaid: pay.amountPaid,
      discountAmount: pay.discountAmount,
      refundedAmount: pay.refundedAmount,
      paymentUnderReview: order.status === "pending_payment" && pay.needsAttention,
    } : null,
  };
}

router.get("/quote/:token", (req, res) => {
  const rfq = rfqFromToken(req, res);
  if (rfq) res.json(customerView(rfq, req.rfqClaim));
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

/** Where Stripe sends a firm-quote buyer afterwards: the order id and a return token, never the quote link. */
function returnUrls(base, orderId) {
  const token = returnToken.sign(orderId, lifecycle.sessionMinutes() + 60);
  const page = `${base}/firm-quote/return?o=${encodeURIComponent(orderId)}`;
  return { successUrl: `${page}&r=${token}&paid=true`, cancelUrl: `${page}&cancelled=true`, returnKey: `firm-quote:${orderId}`, base };
}

/**
 * Accept the firm quote.
 *   method "card" → an order awaiting payment + a Stripe Checkout session
 *   method "po"   → an order awaiting PO confirmation; the PO number is stored.
 *                   Nothing is billed here: the shop confirms the PO by hand.
 *
 * ONE QUOTE, ONE ORDER. The quote is claimed (checked "quoted", order written, marked
 * "accepted") in one synchronous step before anything waits on Stripe, so two accepts at the
 * same moment cannot both pass the check (review F-11). If the card session cannot be made
 * the claim is released and the quote is open again. A repeated accept is answered from the
 * order that exists: the same order, and for a card the same payment page.
 */
router.post("/quote/:token/accept", async (req, res) => {
  try {
    const rfq = rfqFromToken(req, res);
    if (!rfq) return;
    const b = req.body || {};
    const method = b.method;
    if (method !== "card" && method !== "po") return res.status(400).json({ error: "Choose card or purchase order", code: "method-required" });
    const base = orderEvents.baseUrl(req);
    const describe = `Firm quote ${templates.shortId(rfq.id)}`;

    if (rfq.status === "accepted") {
      const existing = rfq.orderId ? ordersDB.getById(rfq.orderId) : null;
      const reference = existing ? templates.shortId(existing.id) : null;
      // The same choice again (a double click, a retry, back from an unfinished card page): the same order.
      if (existing && method === "card" && existing.paymentMethod === "card" && existing.status === "pending_payment") {
        try {
          const session = await orderEvents.createCheckoutSession(existing, { itemCount: (rfq.parts || []).length || 1, description: describe, ...returnUrls(base, existing.id), metadata: { rfqId: rfq.id } });
          return res.json({ status: "accepted", method, sessionUrl: session.url, order: reference, repeat: true });
        } catch (err) {
          if (err.code === "order-not-payable") return res.status(409).json({ error: "This quote has already been accepted", code: "already-accepted" });
          if (err.code === "tax-address") return res.status(400).json({ error: err.message, code: "tax-address" });
          console.error("RFQ accept: checkout session failed:", err.code || err.message);
          return res.status(502).json({ error: `We couldn't start the card payment. Try again, or call ${brand.phone}.`, code: err.code === "payment-session-busy" ? err.code : "card-unavailable" });
        }
      }
      // The same PO again is the same acceptance. A different PO number is a second acceptance, and is refused.
      if (existing && method === "po" && existing.paymentMethod === "po" && existing.status === "pending_po" && typeof b.poNumber === "string" && b.poNumber.trim() === existing.poNumber) {
        return res.json({ status: "accepted", method, sessionUrl: null, order: reference, repeat: true });
      }
      return res.status(409).json({ error: "This quote has already been accepted", code: "already-accepted" });
    }
    if (rfq.status !== "quoted") {
      return res.status(409).json({ error: `This quote is no longer open. Call ${brand.phone} and we'll sort it out.`, code: "not-open" });
    }

    // The amount is the owner's, read from the request row. It has to be an amount.
    const total = Number(rfq.quotedTotal);
    if (!Number.isFinite(total) || !(Math.round(total * 100) > 0)) {
      return res.status(409).json({ error: `This quote has no price to accept. Call ${brand.phone} and we'll sort it out.`, code: "quote-not-payable" });
    }
    // The page says what total the buyer was looking at; if that is not the quote's total, stop.
    if (b.seenTotal !== undefined && b.seenTotal !== null && Math.round(Number(b.seenTotal) * 100) !== Math.round(total * 100)) {
      return res.status(409).json({ error: "This quote's price has changed since you opened this page. Reload the page to see it.", code: "quote-changed" });
    }

    // Ship-to and PO number: one printable line each, refused (not rewritten) when they are not.
    const ship = singleLines({ ...b, shippingCountry: b.shippingCountry || "US" }, SHIPPING_RULES);
    if (!ship.ok) return res.status(400).json({ error: ship.error, code: ship.code, field: ship.field });
    // How the order is delivered, and whether an exemption is declared (services/checkout.js). A choice
    // is honoured only if the admin has switched it on; the quoted total is the total whatever is chosen.
    // The ship-to fields it reads are the ones checked just above.
    const firm = checkout.resolveFirm({ ...b, ...ship.values }, { certificate: rfq.taxCertPath ? { fileName: rfq.taxCertFileName || "certificate", path: rfq.taxCertPath } : null });
    if (!firm.ok) return res.status(firm.status).json({ error: firm.error, code: firm.code });
    const shipping = firm.address;
    if (firm.method !== "pickup" && (!shipping.shippingName || !shipping.shippingAddress || !shipping.shippingCity || !shipping.shippingState || !shipping.shippingZip)) {
      return res.status(400).json({ error: "Add the full ship-to address", code: "address-required" });
    }
    let poNumber = "";
    if (method === "po") {
      const po = checkPoNumber(b.poNumber);
      if (!po.ok) return res.status(400).json({ error: po.error, code: po.code, field: "poNumber" });
      poNumber = po.value;
    }
    if (method === "card" && !stripeClient.get()) return res.status(503).json({ error: `Card payment isn't available right now. Call ${brand.phone}.`, code: "card-unavailable" });

    // ── The claim. Everything from here to the end of this block is synchronous. ──
    const days = rfq.quotedLeadDays;
    let order = ordersDB.insert({
      userId: rfq.userId || null,
      quoteId: rfq.quoteId || null,
      rfqId: rfq.id,
      status: method === "po" ? "pending_po" : "pending_payment",
      // Ship-to, delivery choice ("standard" = we ship it), carrier account (masked), tax mode, exemption.
      ...checkout.orderFields(firm),
      shippingCost: 0,
      subtotal: total,
      // Asked for on the request and priced into the firm quote: flagged on the order so the
      // shop does it, with no separate amount (the quoted total already covers it).
      paperwork: Boolean(rfq.paperwork),
      paperworkFee: 0,
      returnPart: Boolean(rfq.returnPart),
      tax: 0,
      total,
      currency: "usd",
      notes: "",
      paymentMethod: method,
      poNumber,
      customerEmail: rfq.email,
      customerName: rfq.contactName,
      leadTimeName: `${days} business day${days === 1 ? "" : "s"}`,
      leadDays: days,
      shipBy: shipBy.shipByDate(days),
      customerNotes: rfq.quoteNote || "",
      drawingFileName: rfq.drawingFileName || "",
      drawingPath: rfq.drawingPath || "",
    });
    // The carrier account number is sealed to this order's id, so it is stored once the id exists.
    if (firm.carrier) order = ordersDB.update(order.id, { shipAccountEnc: shippingService.sealAccount(firm.carrier.account, order.id) });
    const items = orderItemsFor(rfq).map((it) => orderItemsDB.insert({ orderId: order.id, ...it }));
    const accepted = rfqsDB.update(rfq.id, {
      status: "accepted",
      acceptedAt: new Date().toISOString(),
      acceptedVia: method,
      poNumber,
      orderId: order.id,
    });
    // ── Claimed. ──

    let session = null;
    if (method === "card") {
      try {
        session = await orderEvents.createCheckoutSession(order, { itemCount: items.length, description: describe, ...returnUrls(base, order.id), metadata: { rfqId: rfq.id } });
      } catch (err) {
        // No session, no order: release the claim so the buyer can try again. Only if the quote
        // is still held by THIS order and nothing was paid in the meantime.
        const nowRfq = rfqsDB.getById(rfq.id);
        const nowOrder = ordersDB.getById(order.id);
        if (nowOrder && nowOrder.status === "pending_payment" && nowRfq && nowRfq.status === "accepted" && nowRfq.orderId === order.id) {
          for (const it of items) orderItemsDB.delete(it.id);
          ordersDB.delete(order.id);
          rfqsDB.update(rfq.id, { status: "quoted", acceptedAt: null, acceptedVia: null, poNumber: "", orderId: null });
        }
        // Stripe could not place the address for sales tax: the buyer corrects it and accepts again.
        if (err.code === "tax-address") return res.status(400).json({ error: err.message, code: "tax-address" });
        console.error("RFQ accept: checkout session failed:", err.code || err.message);
        return res.status(502).json({ error: `We couldn't start the card payment. Try again, or call ${brand.phone}.`, code: err.code === "payment-session-busy" ? err.code : "card-unavailable" });
      }
    }

    // The shop hears about every acceptance. A PO buyer gets their confirmation
    // now; a card buyer gets it when the payment clears.
    const sends = [mailer.send({ to: mailer.shopNotifyAddress(), replyTo: rfq.email, ...templates.rfqAcceptedShop({ rfq: accepted, order, adminUrl: `${base}/admin` }) })];
    if (method === "po") {
      lifecycle.recordEvent({ kind: "po-order", order, amountCents: Math.round(total * 100), currency: "usd", detail: "accepted on a purchase order", notified: true });
      sends.push(mailer.send({ to: rfq.email, replyTo: mailer.shopNotifyAddress(), ...templates.orderConfirmation({ order, items, orderUrl: orderEvents.orderUrl(order, base) }) }));
    }
    await Promise.all(sends);

    res.status(201).json({ status: "accepted", method, sessionUrl: session?.url || null, order: templates.shortId(order.id) });
  } catch (err) {
    console.error("RFQ accept error:", err.message);
    res.status(500).json({ error: `Something went wrong on our side. Call ${brand.phone} and we'll take the order by phone.` });
  }
});

// A tax-exemption certificate, attached on the quote page before the quote is accepted.
// The link is the credential (as for accepting); only an open quote can be changed.
function openQuoteFromToken(req, res, next) {
  const rfq = rfqFromToken(req, res);
  if (!rfq) return;
  if (rfq.status !== "quoted") return res.status(409).json({ error: "This quote can no longer be changed", code: "not-open" });
  req.rfq = rfq;
  next();
}
router.post("/quote/:token/tax-certificate", openQuoteFromToken, taxCertificates.admit(), async (req, res) => {
  const stored = await taxCertificates.receive(req, res);
  if (!stored) return;
  const previous = req.rfq.taxCertPath;
  const updated = rfqsDB.update(req.rfq.id, { taxCertFileName: stored.fileName, taxCertPath: stored.path });
  await taxCertificates.discardIfUnused(previous, require("../models"), { rfqId: req.rfq.id });
  res.json({ taxCertFileName: updated.taxCertFileName });
});
router.delete("/quote/:token/tax-certificate", openQuoteFromToken, async (req, res) => {
  const previous = req.rfq.taxCertPath;
  rfqsDB.update(req.rfq.id, { taxCertFileName: "", taxCertPath: "" });
  await taxCertificates.discardIfUnused(previous, require("../models"), { rfqId: req.rfq.id });
  res.json({ taxCertFileName: "" });
});

router.post("/quote/:token/confirm-payment", async (req, res) => {
  try {
    const rfq = rfqFromToken(req, res);
    if (!rfq) return;
    // The same checks as the webhook (amount, currency, session, payment status): services/orderLifecycle.js.
    if (rfq.orderId) await orderEvents.confirmPayment(rfq.orderId, { base: orderEvents.baseUrl(req) });
    res.json(customerView(rfqsDB.getById(rfq.id) || rfq, req.rfqClaim));
  } catch (err) {
    console.error("RFQ confirm payment error:", err.message);
    res.status(502).json({ error: "Could not confirm the payment yet", code: "confirm-failed" });
  }
});

/**
 * The page Stripe sends a firm-quote buyer back to. It holds the order id and a return token
 * (services/returnToken.js), which is good for this one question about this one order and
 * nothing else. The answer says where the order stands and no more: no name, no address,
 * no email, no quote.
 */
router.post("/return/confirm", async (req, res) => {
  try {
    const b = req.body || {};
    const orderId = typeof b.order === "string" ? b.order : "";
    if (!orderId || !returnToken.verify(b.token, orderId)) {
      return res.status(404).json({ error: "This page has expired. Open the link in your quote email to see your order.", code: "return-link-invalid" });
    }
    let order = ordersDB.getById(orderId);
    if (!order || !order.rfqId) return res.status(404).json({ error: "This page has expired. Open the link in your quote email to see your order.", code: "return-link-invalid" });
    try {
      await orderEvents.confirmPayment(order.id, { base: orderEvents.baseUrl(req) });
    } catch (err) {
      console.error("Return confirm error:", err.code || err.name || "Error"); // answered below from what we have
    }
    order = ordersDB.getById(orderId) || order;
    res.json({
      reference: templates.shortId(order.id),
      status: order.status,
      total: order.total,
      shipBy: order.shipBy || null,
      paymentUnderReview: order.status === "pending_payment" && Boolean(order.attention),
    });
  } catch (err) {
    console.error("Return confirm error:", err.message);
    res.status(502).json({ error: "Could not confirm the payment yet", code: "confirm-failed" });
  }
});

// ─── Read ─────────────────────────────────────────────────────
// A request holds a name, an email, a phone number and notes. The signed-in
// owner and the admin see it. A request sent without an account has no owner
// to check, so its id alone shows only where it stands.
router.get("/:id", optionalAuth, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  const admin = req.user && req.user.role === "admin";
  const owner = req.user && rfq.userId && req.user.userId === rfq.userId;
  if (admin || owner) {
    const { drawingPath, taxCertPath, senderCheck, buyerEmailed, ...safe } = rfq;
    return res.json(admin ? { ...safe, senderCheck, buyerEmailed } : safe);
  }
  if (rfq.userId) return res.status(404).json({ error: "RFQ not found" });
  res.json({ id: rfq.id, reference: templates.shortId(rfq.id), status: expireIfDue(rfq).status, requestType: rfq.requestType || "", createdAt: rfq.createdAt });
});

module.exports = router;
