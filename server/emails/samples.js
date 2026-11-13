/**
 * Sample data for every email template — used by scripts/preview-emails.js
 * and by the template tests, so the previews and the tests can't drift.
 */
const templates = require("./templates");

const base = "https://straightedgemfg.com";
const items = [
  { fileName: "wear-strip-rev-C.step", materialName: "UHMW-PE", process: "cnc", finishName: "As Machined", quantity: 25, lineTotal: 612.5 },
  { fileName: "guide-block.step", materialName: "Delrin / Acetal (POM)", process: "cnc", finishName: "Deburred", quantity: 10, lineTotal: 284.0 },
];
const order = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  total: 908.75,
  paymentMethod: "card",
  customerName: "Dana Buyer",
  customerEmail: "dana@example.com",
  leadTimeName: "Expedited",
  shipBy: "2026-11-24",
  shippingName: "Dana Buyer",
  shippingAddress: "100 Main St",
  shippingCity: "Elgin",
  shippingState: "IL",
  shippingZip: "60120",
  customerNotes: "The 0.500 bore is the one that matters.",
  drawingFileName: "wear-strip-rev-C.pdf",
  // What the total is made of: 896.50 parts + 12.25 shipping = 908.75.
  subtotal: 896.5,
  shippingCost: 12.25,
};
// The same order with the inspection paperwork ordered: two part numbers at $45 + $15 per order = $105.
const orderWithPaperwork = { ...order, paperwork: true, paperworkFee: 105, total: 1013.75 };
const rfq = {
  id: "0b8a2f4e-3c1d-4e5f-9a6b-7c8d9e0f1a2b",
  contactName: "Pat Purchasing",
  email: "pat@example.com",
  company: "OEM Co",
  phone: "815-555-0142",
  quantities: "500 / 1,000",
  tolerance: "Ø0.500 +0.000/−0.002",
  finishNotes: "Deburr all edges, bag 10 per",
  dueDate: "2026-12-15",
  notes: "Replaces a part we buy from a supplier who keeps missing dates.",
  drawingFileName: "roller-12-441.pdf",
  budgetTotal: 3980,
  reasons: [{ message: "500 pieces is over our 100-piece instant-order limit" }],
  parts: [{ fileName: "roller-12-441.step", process: "cnc", materialSlug: "cnc-delrin", materialName: "Delrin / Acetal (POM)", quantity: 500, quotedQuantity: 1000, budgetUnit: 7.96, budgetLine: 3980 }],
  quotedTotal: 6850,
  quotedLeadDays: 15,
  quoteNote: "Price covers 1,000 pcs in natural Delrin, bagged 10 per.",
  paperwork: true,
  validUntil: "2026-12-09T18:00:00.000Z",
};
// A replacement part with no drawing: the buyer ships the worn part in.
const partRfq = {
  id: "5d21c7aa-9f04-4b7e-8a11-2e6f0c3b9d10",
  contactName: "Sam Maintenance",
  email: "sam@example.com",
  company: "Plant Co",
  phone: "262-555-0117",
  quantities: "2 now, 6 a year",
  notes: "NO DRAWING. The customer is sending the part.\nWhat it is and does: guides cartons into the sealer; rides on a stainless rail. Worn on the leading edge.\nMachine it is from: case sealer, line 3\nMaterial, if known: white, waxy\nHow soon: next shutdown",
  parts: [],
  requestType: "part",
  returnPart: true,
  paperwork: false,
  quotedTotal: 412,
  quotedLeadDays: 8,
  validUntil: "2026-12-09T18:00:00.000Z",
};
const shipFrom = require("../config/shipFrom.json");
const part = { reference: templates.shortId(partRfq.id), shipTo: { name: require("../../shared/brand.json").name, lines: [shipFrom.address, `${shipFrom.city}, ${shipFrom.state} ${shipFrom.zip}`] } };
const acceptUrl = `${base}/firm-quote/eyJhbGciOiJIUzI1NiJ9.sample.signature`;

module.exports = {
  "rfq-received-buyer": () => templates.rfqReceivedBuyer({ rfq }),
  "rfq-received-shop": () => templates.rfqReceivedShop({ rfq, adminUrl: `${base}/admin` }),
  "rfq-received-shop-unverified": () => templates.rfqReceivedShop({ rfq, adminUrl: `${base}/admin`, unverified: true, buyerEmailed: false }),
  "part-request-shop-unverified": () => templates.rfqReceivedShop({ rfq: partRfq, adminUrl: `${base}/admin`, unverified: true, buyerEmailed: false, partPending: true }),
  // Account emails. The links here are placeholders, not working tokens.
  "account-verify-email": () => templates.verifyEmail({ verifyUrl: `${base}/verify-email#token=SAMPLE-NOT-A-TOKEN` }),
  "account-password-reset": () => templates.passwordResetRequested({ resetUrl: `${base}/reset-password#token=SAMPLE-NOT-A-TOKEN` }),
  "account-password-changed": () => templates.passwordChanged({ when: "2026-11-11T15:04:00Z" }),
  // (The "sign-in paused" email is gone with the per-address lock it announced; this is the notice that is sent now,
  //  once a day at most, when many wrong passwords are tried on an account from browsers it has never used.)
  "account-sign-in-attempts": () => templates.signInAttempts({ resetUrl: `${base}/forgot-password` }),
  "account-two-factor-on": () => templates.twoFactorChanged({ change: "enabled" }),
  "account-recovery-code-used": () => templates.twoFactorChanged({ change: "recovery-used" }),
  "part-request-buyer": () => templates.rfqReceivedBuyer({ rfq: partRfq, part }),
  "part-request-shop": () => templates.rfqReceivedShop({ rfq: partRfq, adminUrl: `${base}/admin`, part }),
  "rfq-quoted": () => templates.rfqQuoted({ rfq, acceptUrl, shipBy: "2026-12-02" }),
  "rfq-quoted-no-paperwork": () => templates.rfqQuoted({ rfq: { ...rfq, paperwork: false }, acceptUrl, shipBy: "2026-12-02" }),
  "part-request-quoted": () => templates.rfqQuoted({ rfq: partRfq, acceptUrl, shipBy: "2026-11-23" }),
  "part-request-buyer-keep": () => templates.rfqReceivedBuyer({ rfq: { ...partRfq, returnPart: false }, part }),
  "rfq-accepted-shop-po": () => templates.rfqAcceptedShop({ rfq, order: { ...order, total: 6850, paymentMethod: "po", poNumber: "PO-77812" }, adminUrl: `${base}/admin` }),
  "rfq-accepted-shop-card": () => templates.rfqAcceptedShop({ rfq, order: { ...order, total: 6850 }, adminUrl: `${base}/admin` }),
  "order-confirmation": () => templates.orderConfirmation({ order, items, orderUrl: `${base}/orders/${order.id}` }),
  "order-confirmation-po": () => templates.orderConfirmation({ order: { ...order, paymentMethod: "po", poNumber: "PO-77812", drawingFileName: "", customerNotes: "" }, items, orderUrl: acceptUrl }),
  "new-order-shop": () => templates.newOrderShop({ order, items, adminUrl: `${base}/admin` }),
  "order-confirmation-paperwork": () => templates.orderConfirmation({ order: orderWithPaperwork, items, orderUrl: `${base}/orders/${order.id}` }),
  "new-order-shop-paperwork": () => templates.newOrderShop({ order: orderWithPaperwork, items, adminUrl: `${base}/admin` }),
  "order-shipped": () => templates.orderShipped({ order: { ...order, carrier: "UPS", trackingNumber: "1Z999AA10123456784", shippedAt: "2026-11-23T20:15:00.000Z" }, items, orderUrl: `${base}/orders/${order.id}` }),
  "order-shipped-no-tracking": () => templates.orderShipped({ order: { ...order, shippedAt: "2026-11-23T20:15:00.000Z" }, items, orderUrl: `${base}/orders/${order.id}` }),
  "order-closed-buyer": () => templates.orderClosedBuyer({ order: { ...order, status: "expired" }, quoteUrl: `${base}/quote` }),
};
