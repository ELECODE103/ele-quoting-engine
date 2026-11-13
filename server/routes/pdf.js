/**
 * PDF Routes
 * Endpoints for generating and serving PDF documents (job travelers, packing lists)
 */
const express = require("express");
const orderQueries = require("../models/orderQueries"); // an order's lines, read by index
const { ordersDB, orderItemsDB, partsDB, quotesDB, rfqsDB, usersDB, materialsDB, finishesDB } = require("../models");
const { authenticate, requireAdmin } = require("./auth");
const { generateJobTraveler, generatePackingList } = require("../services/pdfGenerator");
const documents = require("../services/documents");

const router = express.Router();

// ============================================================================
// GET /api/pdf/traveler/:orderId - Generate Job Traveler PDF
// ============================================================================
router.get("/traveler/:orderId", authenticate, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch order
    const order = ordersDB.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Fetch order items
    const items = orderQueries.itemsOf(orderId);
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Order has no items" });
    }

    // Enrich items with part geometry/DFM data. Each part is read and compared once, however many lines name it.
    const partOf = new Map();
    const hashOf = new Map();
    const enrichedItems = items.map((item) => {
      let part = null;
      let geometry = null;
      let dfm = null;

      if (item.partId) {
        if (!partOf.has(item.partId)) partOf.set(item.partId, partsDB.getById(item.partId));
        part = partOf.get(item.partId);
        if (part) {
          geometry = part.geometry || null;
          dfm = part.dfm || null;
        }
      }

      // Is the part on file still the part that was priced? (It is locked once ordered; `false` is printed
      // on the traveler in capitals. null: an order from before the snapshot existed, or a firm quote.)
      const check = require("../services/checkoutGuard").checkAgainst(item, part, hashOf);
      return {
        ...item,
        geometry,
        dfm,
        matchesPriced: check ? check.matches : null,
      };
    });

    // Generate PDF
    const pdfBuffer = await generateJobTraveler(order, enrichedItems);

    // Send as PDF response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="traveler_${orderId.substring(0, 8)}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Job Traveler PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate job traveler PDF" });
  }
});

// ============================================================================
// GET /api/pdf/packing-list/:orderId - Generate Packing List PDF
// ============================================================================
router.get("/packing-list/:orderId", authenticate, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch order
    const order = ordersDB.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Fetch order items
    const items = orderQueries.itemsOf(orderId);
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Order has no items" });
    }

    // Generate PDF
    const pdfBuffer = await generatePackingList(order, items);

    // Send as PDF response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="packing-list_${orderId.substring(0, 8)}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Packing List PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate packing list PDF" });
  }
});

// ============================================================================
// Customer documents (server/services/documents.js) — admin only, by record ID
//   GET /api/pdf/quote/:quoteId
//   GET /api/pdf/rfq-response/:rfqId
//   GET /api/pdf/order-confirmation/:orderId
//   GET /api/pdf/packing-slip/:orderId
//   GET /api/pdf/coc/:orderId
//   GET /api/pdf/fai            (blank form; ?orderId=…&line=1 pre-fills the part block)
// Add ?download=1 to any of them to get an attachment instead of an inline PDF.
// ============================================================================
function sendPdf(req, res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${filename}"`);
  res.send(buffer);
}
// Display names for the slugs stored on line items (falls back to the slug inside the generator).
function withNames(item) {
  const meta = item.config || item.meta || {};
  const mSlug = item.materialSlug || meta.materialSlug;
  const fSlug = item.finishSlug || meta.finishSlug;
  const material = mSlug ? materialsDB.query((m) => m.slug === mSlug)[0] : null;
  const finish = fSlug ? finishesDB.query((f) => f.slug === fSlug)[0] : null;
  return { ...item, materialName: item.materialName || material?.name || "", finishName: item.finishName || (fSlug && fSlug !== "raw" ? finish?.name : "") || "" };
}
function customerOf(userId) {
  const u = userId ? usersDB.getById(userId) : null;
  return u ? { name: u.name, company: u.company, email: u.email, phone: u.phone } : null;
}
function loadOrder(req, res) {
  const order = ordersDB.getById(req.params.orderId);
  if (!order) { res.status(404).json({ error: "Order not found" }); return null; }
  const items = orderQueries.itemsOf(order.id).map(withNames);
  if (!items.length) { res.status(400).json({ error: "Order has no items" }); return null; }
  return { order, items, customer: customerOf(order.userId) };
}
const documentRoute = (name, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`${name} PDF generation error:`, err);
    if (!res.headersSent) res.status(500).json({ error: `Failed to generate ${name} PDF` });
  }
};

router.get("/quote/:quoteId", authenticate, requireAdmin, documentRoute("quote", async (req, res) => {
  const quote = quotesDB.getById(req.params.quoteId);
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  const shaped = { ...quote, lineItems: (quote.lineItems || []).map(withNames) };
  const pdf = await documents.buildQuotePdf({ quote: shaped, customer: customerOf(quote.userId) });
  sendPdf(req, res, pdf, `${documents.docNumber("Q", quote.id)}.pdf`);
}));

router.get("/rfq-response/:rfqId", authenticate, requireAdmin, documentRoute("RFQ response", async (req, res) => {
  const rfq = rfqsDB.getById(req.params.rfqId);
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (!(Number(rfq.quotedTotal) > 0)) return res.status(409).json({ error: "This RFQ has no quoted price yet. Enter the firm quote first." });
  const shaped = { ...rfq, parts: (rfq.parts || []).map(withNames) };
  const pdf = await documents.buildQuotePdf({ rfq: shaped });
  sendPdf(req, res, pdf, `${documents.docNumber("RFQ", rfq.id)}.pdf`);
}));

router.get("/order-confirmation/:orderId", authenticate, requireAdmin, documentRoute("order confirmation", async (req, res) => {
  const data = loadOrder(req, res);
  if (!data) return;
  sendPdf(req, res, await documents.buildOrderConfirmationPdf(data), `${documents.docNumber("SO", data.order.id)}.pdf`);
}));

router.get("/packing-slip/:orderId", authenticate, requireAdmin, documentRoute("packing slip", async (req, res) => {
  const data = loadOrder(req, res);
  if (!data) return;
  sendPdf(req, res, await documents.buildPackingSlipPdf(data), `${documents.docNumber("PS", data.order.id)}.pdf`);
}));

router.get("/coc/:orderId", authenticate, requireAdmin, documentRoute("certificate of conformance", async (req, res) => {
  const data = loadOrder(req, res);
  if (!data) return;
  sendPdf(req, res, await documents.buildCocPdf(data), `${documents.docNumber("COC", data.order.id)}.pdf`);
}));

router.get("/fai", authenticate, requireAdmin, documentRoute("FAI report", async (req, res) => {
  let part = {};
  if (req.query.orderId) {
    const order = ordersDB.getById(String(req.query.orderId));
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = orderQueries.itemsOf(order.id).map(withNames);
    const item = items[Math.max(0, (parseInt(req.query.line, 10) || 1) - 1)];
    if (!item) return res.status(404).json({ error: "Order line not found" });
    const customer = customerOf(order.userId);
    part = {
      id: order.id,
      partNumber: item.fileName,
      material: item.materialName || item.materialSlug,
      customer: customer?.company || customer?.name || order.shippingName,
      po: order.poNumber,
      order: documents.docNumber("SO", order.id),
      lotQty: item.quantity,
    };
  }
  const pdf = await documents.buildFaiPdf({ part });
  sendPdf(req, res, pdf, part.id ? `${documents.docNumber("FAI", part.id)}.pdf` : "FAI-blank.pdf");
}));

module.exports = router;
