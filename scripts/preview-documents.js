#!/usr/bin/env node
/**
 * Writes one sample of every customer document to a folder so the layouts can be checked on
 * paper without a database:   node scripts/preview-documents.js [outDir]
 * (default outDir: client/public/brand/documents). All names and numbers below are invented
 * sample data — nothing here is a real customer or order.
 */
const fs = require("fs");
const path = require("path");
const docs = require("../server/services/documents");
const { generateJobTraveler } = require("../server/services/pdfGenerator");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "client", "public", "brand", "documents"));
const DATE = "2026-11-09T15:00:00Z";

const customer = { name: "Sample Buyer", company: "Sample OEM, Inc.", email: "buyer@example.com", phone: "555-0100" };
const lineItems = [
  { partId: "p1", fileName: "SAMPLE-1001 guide block.step", quantity: 25, perUnit: { final: 18.4 }, lineTotal: 460, meta: { process: "cnc", subProcess: "milling", materialSlug: "acetal", grade: "Black", finishSlug: "raw", geometrySummary: { stockMm: { w: 101.6, h: 63.5, d: 25.4 } } },
    quantityBreaks: [{ qty: 1, perUnit: 96 }, { qty: 10, perUnit: 27.5 }, { qty: 25, perUnit: 18.4 }, { qty: 50, perUnit: 14.9 }, { qty: 100, perUnit: 12.6 }] },
  { partId: "p2", fileName: "SAMPLE-1002 wear strip.dxf", quantity: 40, perUnit: { final: 6.15 }, lineTotal: 246, meta: { process: "routing", materialSlug: "uhmw", grade: "Natural", thicknessMm: 12.7, finishSlug: "raw", geometrySummary: { blankMm: { w: 609.6, h: 50.8, t: 12.7 } } } },
  { partId: "p3", fileName: "SAMPLE-1003 sensor cover.stl", quantity: 10, perUnit: { final: 11.2 }, lineTotal: 112, meta: { process: "3d-printing", subProcess: "fdm", materialSlug: "petg", layerHeightMm: 0.2, finishSlug: "raw", input: { infill: 0.2 } } },
];
const quote = { id: "5a3c9e10-0000-4000-8000-000000000001", createdAt: DATE, leadTimeSlug: "standard", lineItems, subtotal: 818, leadTimeSurcharge: 0, paperwork: true, paperworkFee: 60, shippingEstimate: 24.5, orderTotal: 902.5 };
const order = { id: "7b1d4f22-0000-4000-8000-000000000002", quoteId: quote.id, createdAt: DATE, status: "paid", poNumber: "PO-SAMPLE-4471",
  shippingName: "Receiving Dept.", shippingCompany: "Sample OEM, Inc.", shippingAddress: "100 Example Parkway", shippingCity: "Anytown", shippingState: "IL", shippingZip: "60000", shippingCountry: "US",
  shippingMethod: "ground", shippingCost: 24.5, subtotal: 818, paperwork: true, paperworkFee: 60, tax: 0, total: 902.5, notes: "",
  leadTimeName: "Standard", shipBy: "2026-11-23", customerNotes: "Deburr all edges. Bag the wear strips in tens." };
const items = lineItems.map((li, i) => ({ id: `i${i + 1}`, orderId: order.id, partId: li.partId, fileName: li.fileName, process: li.meta.process, materialSlug: li.meta.materialSlug, finishSlug: li.meta.finishSlug, quantity: li.quantity, unitPrice: li.perUnit.final, lineTotal: li.lineTotal, config: li.meta }));
// The job traveler is the shop's sheet, not a customer document: it is here so the layout can be
// checked on paper. This sample is a send-us-the-part job with inspection paperwork, so both boxes show.
const travelerOrder = { ...order, returnPart: true, company: customer.company };
const travelerItems = items.map((it, i) => ({ ...it, geometry: [
  { boundingBox: { width: 101.6, height: 63.5, depth: 25.4 } },
  { is2D: true, flatWidth: 609.6, flatHeight: 50.8, profile2d: { units: { unit: "in", source: "file" } } },
  { boundingBox: { width: 64, height: 48, depth: 22 } },
][i] }));
const rfq = { id: "9c2e6a33-0000-4000-8000-000000000003", quoteId: quote.id, contactName: customer.name, company: customer.company, email: customer.email, phone: customer.phone, quotedAt: DATE, quotedTotal: 3980,
  quantities: "250 / 500", tolerance: "±0.005 in. on bores", finishNotes: "Deburr, no tool marks on face A", dueDate: "2026-12-15",
  parts: [{ fileName: "SAMPLE-1001 guide block.step", process: "cnc", subProcess: "milling", materialSlug: "acetal-black", quantity: 250, budgetUnit: 15.92, budgetLine: 3980 }] };

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    "sample-quote.pdf": await docs.buildQuotePdf({ quote, customer }),
    "sample-rfq-response.pdf": await docs.buildQuotePdf({ rfq, options: { leadTime: "15 working days" } }),
    "sample-order-confirmation.pdf": await docs.buildOrderConfirmationPdf({ order, items, customer }),
    "sample-packing-slip.pdf": await docs.buildPackingSlipPdf({ order, items, customer, options: { shipDate: DATE } }),
    "sample-certificate-of-conformance.pdf": await docs.buildCocPdf({ order, items, customer, options: { date: DATE, revs: { i1: "B", i2: "A", i3: "A" } } }),
    "sample-fai-report-blank.pdf": await docs.buildFaiPdf(),
    "sample-job-traveler.pdf": await generateJobTraveler(travelerOrder, travelerItems),
  };
  for (const [name, buf] of Object.entries(out)) { fs.writeFileSync(path.join(outDir, name), buf); console.log(`${name}  ${buf.length} bytes`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
