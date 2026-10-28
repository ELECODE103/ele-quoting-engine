/**
 * RFQ routes — firm-quote requests.
 *
 * A quote lands here when the quote gate says a person has to price it
 * (over the instant-order quantity, a DFM failure, an oversize part, a big
 * ticket), or when the buyer simply prefers a firm quote. The budgetary price
 * from the engine is kept with the request so the admin sees what the customer
 * saw.
 *
 *   POST /api/rfq                 create (multipart: optional drawing PDF/DXF/DWG)
 *   GET  /api/rfq/:id             read (owner, admin, or anonymous-by-id)
 *   GET  /api/rfq/admin/list      admin queue, newest first
 *   PUT  /api/rfq/admin/:id       admin: status / quotedTotal / notes
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { rfqsDB, quotesDB } = require("../models");
const { authenticate, optionalAuth, requireAdmin } = require("./auth");
const { sanitizeString, isValidEmail } = require("../middleware/validate");
const mailer = require("../services/mailer");
const brand = require("../../shared/brand.json");

const router = express.Router();

const drawingDir = path.join(__dirname, "..", "..", "data", "rfq-drawings");
if (!fs.existsSync(drawingDir)) fs.mkdirSync(drawingDir, { recursive: true });

const DRAWING_EXT = [".pdf", ".dxf", ".dwg", ".png", ".jpg", ".jpeg"];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, drawingDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DRAWING_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`Drawing must be ${DRAWING_EXT.join(", ")}`));
  },
});

const STATUSES = ["new", "in-review", "quoted", "won", "lost", "declined"];

function snapshotParts(quote) {
  return (quote.lineItems || []).map((li) => ({
    partId: li.partId,
    fileName: li.fileName,
    process: li.meta?.process || "",
    subProcess: li.meta?.subProcess || "",
    materialSlug: li.meta?.materialSlug || "",
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
router.post("/", optionalAuth, upload.single("drawing"), async (req, res) => {
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
    const partLines = parts.map((p) => `  • ${p.fileName} — ${p.process}${p.materialSlug ? " / " + p.materialSlug : ""} × ${p.quantity} (budgetary $${(p.budgetUnit || 0).toFixed(2)}/ea)`).join("\n");
    const reasonLines = (rfq.reasons || []).map((r) => `  • ${r.message}`).join("\n");
    const adminText = [
      `New RFQ ${rfq.id}`,
      `From: ${contactName} <${email}>${rfq.company ? " — " + rfq.company : ""}${rfq.phone ? " — " + rfq.phone : ""}`,
      `Quantities: ${rfq.quantities || "(see parts)"}`,
      `Tolerance: ${rfq.tolerance || "-"}`,
      `Finish notes: ${rfq.finishNotes || "-"}`,
      `Need by: ${rfq.dueDate || "-"}`,
      `Drawing: ${rfq.drawingFileName || "none"}`,
      `Budgetary total shown: $${(rfq.budgetTotal || 0).toFixed(2)}`,
      parts.length ? `Parts:\n${partLines}` : "",
      reasonLines ? `Why it's an RFQ:\n${reasonLines}` : "",
      rfq.notes ? `Notes:\n${rfq.notes}` : "",
      "",
      `Admin: ${brand.url}/admin`,
    ].filter(Boolean).join("\n");

    const buyerText = [
      `Hi ${contactName.split(" ")[0]},`,
      "",
      `Thanks — we have your request${parts.length ? ` for ${parts.length} part${parts.length === 1 ? "" : "s"}` : ""}. A firm quote comes back within ${brand.quoteTurnaroundHours} hours, from the person who will run the job.`,
      "",
      `If anything on the print needs a conversation first, you'll hear from us before then.`,
      "",
      `${brand.name} — ${brand.phone} — ${brand.email}`,
      `${brand.legalName}, ${brand.city}, ${brand.state}`,
    ].join("\n");

    mailer.send({ to: mailer.rfqNotifyAddress(), subject: `RFQ: ${contactName}${rfq.company ? " / " + rfq.company : ""} — ${parts.length || "?"} part(s)`, text: adminText, replyTo: email });
    mailer.send({ to: email, subject: `${brand.name}: we have your quote request`, text: buyerText, replyTo: mailer.rfqNotifyAddress() });

    res.status(201).json({ rfqId: rfq.id, status: rfq.status, turnaroundHours: brand.quoteTurnaroundHours });
  } catch (err) {
    console.error("RFQ create error:", err);
    res.status(500).json({ error: "Could not submit the request. Please try again or call us." });
  }
});

// ─── Admin queue (declared before /:id so "admin" isn't read as an id) ───
router.get("/admin/list", authenticate, requireAdmin, (req, res) => {
  const all = rfqsDB.getAll().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json(all);
});

router.put("/admin/:id", authenticate, requireAdmin, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  const updates = {};
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
    updates.status = req.body.status;
    if (req.body.status === "quoted" && !rfq.quotedAt) updates.quotedAt = new Date().toISOString();
  }
  if (req.body.quotedTotal !== undefined) {
    const n = Number(req.body.quotedTotal);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "Invalid quoted total" });
    updates.quotedTotal = n;
  }
  if (req.body.notes !== undefined) updates.notes = sanitizeString(req.body.notes, 4000);
  const updated = rfqsDB.update(rfq.id, updates);
  res.json(updated);
});

router.get("/admin/:id/drawing", authenticate, requireAdmin, (req, res) => {
  const rfq = rfqsDB.getById(req.params.id);
  if (!rfq || !rfq.drawingPath || !fs.existsSync(rfq.drawingPath)) return res.status(404).json({ error: "No drawing" });
  res.download(rfq.drawingPath, rfq.drawingFileName || path.basename(rfq.drawingPath));
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
