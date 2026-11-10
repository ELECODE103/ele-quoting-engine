/**
 * documents.js — every builder returns a real, non-empty PDF whose page text carries the
 * brand name and the document number, and nothing about a customer is baked in.
 * Run: node server/services/documents.test.js
 */
const assert = require("assert");
const zlib = require("zlib");
const docs = require("./documents");
const brand = require("../../shared/brand.json");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log(`  ok  ${name}`); }, (e) => { console.error(`FAIL  ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }));
}

/** Text drawn on the pages: inflate each content stream and decode the hex strings PDFKit writes for Helvetica. */
function pageText(buf) {
  const raw = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const end = raw.indexOf("endstream", m.index);
    const body = buf.subarray(m.index + m[0].length, end);
    let text;
    try { text = zlib.inflateSync(body).toString("latin1"); } catch (e) { continue; }
    for (const tj of text.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out += [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("") + "\n";
    }
  }
  return out;
}
const pages = (buf) => (buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
function assertPdf(buf, number) {
  assert.ok(Buffer.isBuffer(buf), "returns a Buffer");
  assert.ok(buf.length > 2000, `PDF is non-trivial (${buf.length} bytes)`);
  assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buf.subarray(-32).toString().includes("%%EOF"), "ends with %%EOF");
  const raw = buf.toString("latin1");
  assert.ok(raw.includes(`- ${brand.name})`) || raw.includes(brand.name), "Title metadata names the brand");
  const text = pageText(buf);
  assert.ok(text.includes(brand.legalName), "page text carries the legal name");
  assert.ok(text.includes(brand.domain), "page text carries the domain");
  assert.ok(text.includes(number), `page text carries the document number ${number}`);
  return text;
}

const customer = { name: "Test Buyer", company: "Test Customer Co", email: "buyer@example.com", phone: "555-0100" };
const lineItems = [
  { partId: "p1", fileName: "TEST-001.step", quantity: 25, perUnit: { final: 18.4 }, lineTotal: 460, meta: { process: "cnc", subProcess: "milling", materialSlug: "acetal-black", finishSlug: "raw" }, quantityBreaks: [{ qty: 1, perUnit: 96 }, { qty: 25, perUnit: 18.4 }] },
  { partId: "p2", fileName: "TEST-002.dxf", quantity: 40, perUnit: { final: 6.15 }, lineTotal: 246, meta: { process: "routing", materialSlug: "uhmw-natural", finishSlug: "raw" } },
];
const quote = { id: "5a3c9e10-aaaa-4bbb-8ccc-000000000001", createdAt: "2026-11-09T15:00:00Z", leadTimeSlug: "standard", lineItems, subtotal: 706, leadTimeSurcharge: 0, shippingEstimate: 20, orderTotal: 726 };
const order = { id: "7b1d4f22-aaaa-4bbb-8ccc-000000000002", quoteId: quote.id, createdAt: "2026-11-09T15:00:00Z", status: "paid", shippingName: "Receiving", shippingAddress: "1 Test Way", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US", shippingMethod: "ground", shippingCost: 20, subtotal: 706, tax: 0, total: 726 };
const items = lineItems.map((li, i) => ({ id: `i${i}`, orderId: order.id, fileName: li.fileName, process: li.meta.process, materialSlug: li.meta.materialSlug, finishSlug: "raw", quantity: li.quantity, unitPrice: li.perUnit.final, lineTotal: li.lineTotal, config: li.meta }));

test("docNumber is short, prefixed and stable", () => {
  assert.strictEqual(docs.docNumber("Q", quote.id), "Q-5A3C9E10");
  assert.strictEqual(docs.docNumber("SO", ""), "SO-DRAFT");
});

test("quote PDF", async () => {
  const text = assertPdf(await docs.buildQuotePdf({ quote, customer }), "Q-5A3C9E10");
  assert.ok(text.includes("QUOTE"));
  assert.ok(text.includes("TEST-001.step") && text.includes("TEST-002.dxf"), "lists the parts");
  assert.ok(text.includes("$726.00"), "shows the total");
  assert.ok(text.includes("Test Customer Co"), "names the customer passed in");
  assert.ok(text.includes("UHMW natural"), "prettifies material slugs");
});

test("quote PDF with no customer hard-codes nobody", async () => {
  const text = assertPdf(await docs.buildQuotePdf({ quote }), "Q-5A3C9E10");
  assert.ok(!text.includes("Test Customer Co") && !text.includes("Sample"), "no customer name appears unless supplied");
});

test("RFQ response PDF uses the RFQ's contact and quoted total", async () => {
  const rfq = { id: "9c2e6a33-aaaa-4bbb-8ccc-000000000003", contactName: "R. Requester", company: "RFQ Co", email: "r@example.com", quotedTotal: 3980, quotedAt: "2026-11-09T15:00:00Z", quantities: "250", parts: [{ fileName: "TEST-001.step", process: "cnc", materialSlug: "acetal-black", quantity: 250, budgetUnit: 15.92, budgetLine: 3980 }] };
  const text = assertPdf(await docs.buildQuotePdf({ rfq }), "RFQ-9C2E6A33");
  assert.ok(text.includes("RFQ RESPONSE") && text.includes("RFQ Co") && text.includes("$3,980.00"));
});

test("order confirmation PDF", async () => {
  const text = assertPdf(await docs.buildOrderConfirmationPdf({ order, items, customer }), "SO-7B1D4F22");
  assert.ok(text.includes("ORDER CONFIRMATION") && text.includes("$726.00") && text.includes("1 Test Way"));
});

test("packing slip PDF shows quantities and no prices", async () => {
  const text = assertPdf(await docs.buildPackingSlipPdf({ order, items, customer }), "PS-7B1D4F22");
  assert.ok(text.includes("PACKING SLIP") && text.includes("TEST-001.step"));
  assert.ok(!text.includes("$"), "no dollar amounts on a packing slip");
});

test("certificate of conformance PDF", async () => {
  const text = assertPdf(await docs.buildCocPdf({ order, items, customer, options: { lots: { i0: "LOT-42" } } }), "COC-7B1D4F22");
  assert.ok(text.includes("CERTIFICATE OF CONFORMANCE") && text.includes("certifies") && text.includes("LOT-42"));
  assert.ok(!text.includes("$"), "no prices on a certificate");
});

test("FAI form: blank by default, one page, with the dimension table", async () => {
  const buf = await docs.buildFaiPdf();
  const text = assertPdf(buf, "FAI-");
  assert.strictEqual(pages(buf), 1, "blank form fits one page");
  for (const col of ["NOMINAL", "TOLERANCE", "ACTUAL", "PASS", "PART NUMBER", "REVISION", "MATERIAL", "MATERIAL LOT / HEAT", "INSPECTOR (PRINT)", "DATE"]) assert.ok(text.includes(col), `has ${col}`);
  assert.ok(text.split("\n").includes("18"), "at least 18 numbered rows");
});

test("FAI form pre-fills and numbers itself when given a part", async () => {
  const buf = await docs.buildFaiPdf({ part: { id: order.id, partNumber: "TEST-001", revision: "B", material: "Acetal, black" }, dimensions: [{ char: "Bore dia.", nominal: "0.500", tol: "+0.002 / -0.000", actual: "0.501", method: "Pin gage", pass: true }] });
  const text = assertPdf(buf, "FAI-7B1D4F22");
  assert.ok(text.includes("TEST-001") && text.includes("Bore dia.") && text.includes("0.501"));
});

test("long orders paginate and number every page", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ ...items[0], id: `m${i}`, fileName: `TEST-${String(i).padStart(3, "0")}.step` }));
  const buf = await docs.buildPackingSlipPdf({ order, items: many });
  const text = assertPdf(buf, "PS-7B1D4F22");
  assert.ok(pages(buf) >= 2, "more than one page");
  assert.ok(text.includes("TEST-069.step") && text.includes(`Page ${pages(buf)} of ${pages(buf)}`));
});

test("text Helvetica cannot print is replaced, not dropped silently", () => {
  assert.strictEqual(docs._internal.clean("≤0.1 → ok ☐"), "<=0.1 -> ok ?");
});

Promise.all(pending).then(() => {
  console.log(`\ndocuments: ${passed}/${pending.length} passed`);
  if (passed !== pending.length) process.exit(1);
});
