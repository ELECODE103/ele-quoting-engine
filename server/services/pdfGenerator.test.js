/**
 * The job traveler and packing list.
 *
 *  - They must come back as complete PDFs (they used to be read before the stream had ended and
 *    arrived as 0 bytes).
 *  - The traveler is what the shop cuts from. It must print the full description of every line
 *    (process, material, grade, stock thickness, size and drawing units, finish, tolerance, layer
 *    height, quantity), say in so many words when inspection paperwork was bought and when the
 *    customer's original part goes back in the box, and print "NOT RECORDED" for anything the
 *    order line does not carry: a DXF has no thickness of its own, so a routed job with no
 *    thickness on the traveler cannot be cut (payments review 2026-11-11, finding F-16).
 *  - What a customer typed (PO number, notes) prints as one line of text: a typed line break
 *    cannot start a line that reads like one of the document's own.
 *
 * Run: node server/services/pdfGenerator.test.js
 */
const assert = require("assert");
const { generateJobTraveler, generatePackingList } = require("./pdfGenerator");
const { specOf, fullDescription, oneLine } = require("./documents");
const { pdfText } = require("../testSupport/pdfText");

let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => console.log(`  ok   ${name}`), (e) => { failed++; console.error(`  FAIL ${name}\n       ${e.stack || e.message}`); }));
}
/** Page text with line wraps taken out, so a phrase that wrapped is still one phrase. */
const flat = (buf) => pdfText(buf).replace(/\s+/g, " ");
/** The text runs of the PDF, one per drawn line. */
const runs = (buf) => pdfText(buf).split("\n").map((l) => l.trim()).filter(Boolean);

const order = { id: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab", status: "paid", createdAt: new Date().toISOString(), total: 123.45, customerName: "Sample Buyer", shippingAddress: "1 Example Way", shippingCity: "Anytown", shippingState: "IL", shippingZip: "60000" };
const items = [{ fileName: "guide-block.step", quantity: 10, process: "cnc", materialName: "Acetal", unitPrice: 12.34, lineTotal: 123.4, config: {} }];

// A routed DXF order as the checkout route stores it: the quote line's `meta` is the item's
// `config`, the buyer's own choices are under `config.input`, and the part's measured geometry is
// joined on by the PDF route.
const routedOrder = {
  id: "7b1d4f22-0000-4000-8000-000000000002", status: "paid", createdAt: "2026-11-09T15:00:00Z", paymentMethod: "card",
  shippingName: "Receiving Dept.", shippingAddress: "100 Example Parkway", shippingCity: "Anytown", shippingState: "IL", shippingZip: "60000",
  subtotal: 818, leadTimeSurcharge: 72.5, leadTimeName: "Expedited", shippingCost: 24.5, paperwork: true, paperworkFee: 60, returnPart: true, total: 975,
  shipBy: "2026-11-18", poNumber: "PO-4471\nPAID IN FULL", customerNotes: "Deburr both sides.\nOrder total: $1.00\nPAID",
};
const routedItem = {
  id: "i1", fileName: "guard-12x8in.dxf", process: "routing", materialSlug: "rt-hdpe", materialName: "HDPE", finishSlug: "rt-as-cut", finishName: "As cut",
  quantity: 12, unitPrice: 68.17, lineTotal: 818,
  config: { process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", grade: "HDPE — black", thicknessMm: 19.1, finishSlug: "rt-as-cut", geometrySummary: { blankMm: { w: 311.2, h: 209.6, t: 19.1 } }, input: { partId: "p1", thicknessMm: 19.1, grade: "HDPE — black", quantity: 12 } },
  geometry: { is2D: true, sourceUnit: "in", flatWidth: 304.8, flatHeight: 203.2, boundingBox: { width: 304.8, height: 203.2, depth: 0 }, profile2d: { units: { unit: "in", source: "customer", needsConfirmation: false } } },
};

test("both documents come back as complete PDFs", async () => {
  for (const [name, fn] of [["traveler", generateJobTraveler], ["packing list", generatePackingList]]) {
    const buf = await fn(order, items);
    assert.ok(Buffer.isBuffer(buf), `${name}: buffer`);
    assert.ok(buf.length > 1000, `${name}: not empty (${buf.length} bytes)`);
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-", `${name}: PDF header`);
    assert.ok(buf.subarray(-32).toString().includes("%%EOF"), `${name}: complete`);
  }
});

test("traveler for a routed DXF order with paperwork and the original part to return: every one of those is on the sheet", async () => {
  const text = flat(await generateJobTraveler(routedOrder, [routedItem]));
  // The full description of the line.
  for (const phrase of [
    "CNC routing", "HDPE", "black",                       // process, material, grade
    "stock thickness 19.1 mm (0.752 in)",                 // a DXF has no thickness of its own
    "size 304.8 x 203.2 mm (12.00 x 8.00 in)",            // overall size, both units
    "drawing units inches (chosen by the customer)",
    "finish As cut", "tolerance: no option ordered", "qty 12", "QTY 12",
    "guard-12x8in.dxf",
  ]) assert.ok(text.includes(phrase), `the traveler prints "${phrase}"\n${text}`);
  // The two flags, in capitals at the top and again where money and the checklist are.
  assert.ok(text.includes("INSPECTION PAPERWORK ORDERED: FIRST-ARTICLE REPORT + CERTIFICATE OF CONFORMANCE"), "paperwork box");
  assert.ok(text.includes("RETURN THE CUSTOMER'S ORIGINAL PART WITH THIS ORDER"), "return-the-original box");
  assert.ok(text.indexOf("INSPECTION PAPERWORK ORDERED") < text.indexOf("MANUFACTURED ITEMS") && text.indexOf("RETURN THE CUSTOMER'S ORIGINAL PART") < text.indexOf("MANUFACTURED ITEMS"), "both boxes are above the items");
  assert.ok(text.includes("$60.00"), "the paperwork fee is on the sheet");
  assert.ok(/Inspection paperwork:\s*\$60\.00\s+\(first-article report \+ certificate of conformance ORDERED\)/.test(text), "order details name the paperwork and its fee");
  assert.ok(/Original part to return:\s*YES/.test(text), "order details say the original goes back");
  assert.ok(text.includes("First-article report written") && text.includes("Certificate of conformance filled in and signed") && text.includes("Customer's original part in the box"), "both are on the checklist");
  assert.ok(text.includes("$975.00"), "the total charged");
  assert.ok(!text.includes("NOT RECORDED"), "nothing is missing on this order, so nothing says so");
});

test("typed PO number and notes print as one line each: a typed line break cannot start a new line", async () => {
  const buf = await generateJobTraveler(routedOrder, [routedItem]);
  const lines = runs(buf);
  assert.ok(flat(buf).includes("Customer PO (as typed): PO-4471 PAID IN FULL"), "the PO is one line");
  assert.ok(flat(buf).includes('Customer notes (as typed, on one line): "Deburr both sides. Order total: $1.00 PAID"'), "the note is one quoted line");
  for (const l of lines) {
    assert.ok(!/^PAID\b/.test(l), `no drawn line starts with typed text "PAID": ${l}`);
    assert.ok(!/^Order total: \$1\.00/.test(l), `no drawn line starts with the typed "Order total": ${l}`);
  }
  assert.strictEqual(oneLine("a\r\n\tb\u0000  c\u2028d"), "a b c d", "line breaks of every kind, tabs, NUL and runs of spaces become single spaces");
});

test("a routed line with no thickness, grade or units on it says NOT RECORDED in capitals, and the sheet counts them", async () => {
  const bare = { fileName: "plate.dxf", process: "routing", materialName: "UHMW", finishName: "As cut", quantity: 4, unitPrice: 10, lineTotal: 40, config: {} };
  const spec = specOf(bare);
  assert.deepStrictEqual(spec.missing, ["grade", "thickness", "size", "drawing units"]);
  const text = flat(await generateJobTraveler({ ...routedOrder, paperwork: false, returnPart: false, paperworkFee: 0 }, [bare]));
  assert.ok(/thickness: NOT RECORDED . confirm with customer/.test(text), `thickness is called out\n${text}`);
  assert.ok(/grade: NOT RECORDED . confirm with customer/.test(text), "grade is called out");
  assert.ok(/drawing units: NOT RECORDED . confirm with customer/.test(text), "drawing units are called out");
  assert.ok(/size: NOT RECORDED . measure from the file/.test(text), "size is called out");
  assert.ok(text.includes("CHECK BEFORE CUTTING: 4 VALUES NOT RECORDED ON THIS ORDER"), "and counted at the top");
  assert.ok(text.includes("Inspection paperwork (first-article report, certificate of conformance): not ordered.") && text.includes("Customer's original part: none to return."), "no flags: the sheet says so rather than saying nothing");
  assert.ok(/Inspection paperwork:\s*Not ordered/.test(text) && /Original part to return:\s*No/.test(text));
  assert.ok(!text.includes("INSPECTION PAPERWORK ORDERED") && !text.includes("RETURN THE CUSTOMER'S ORIGINAL PART"));
});

test("the description reads from what the order line stores, for each process", () => {
  const cnc = fullDescription({ fileName: "block.step", process: "cnc", materialName: "Delrin / Acetal (POM)", finishSlug: "raw", finishName: "As Machined", quantity: 25,
    config: { process: "cnc", subProcess: "milling", grade: "Acetal copolymer — natural", geometrySummary: { stockMm: { w: 152.4, h: 101.6, d: 6.35 } } } });
  for (const phrase of ["CNC milling", "Delrin / Acetal (POM)", "grade Acetal copolymer", "stock 152.4 x 101.6 x 6.3 mm", "finish As Machined", "qty 25"]) assert.ok(cnc.includes(phrase), `${phrase} in: ${cnc}`);
  assert.ok(!cnc.includes("NOT RECORDED") && !cnc.includes("thickness"), "a milled block has no stock thickness to record");
  const print = fullDescription({ fileName: "cover.stl", process: "3d-printing", materialName: "PETG", finishSlug: "raw", quantity: 10,
    config: { process: "3d-printing", subProcess: "fdm", layerHeightMm: 0.2, input: { infill: 0.2 } }, geometry: { boundingBox: { width: 40, height: 30, depth: 12 } } });
  for (const phrase of ["3D printing (FDM)", "PETG", "size 40 x 30 x 12 mm", "layer height 0.2 mm", "infill 20%", "qty 10"]) assert.ok(print.includes(phrase), `${phrase} in: ${print}`);
  const noLayer = specOf({ fileName: "cover.stl", process: "3d-printing", materialName: "PETG", finishSlug: "raw", quantity: 1, config: {}, geometry: { boundingBox: { width: 40, height: 30, depth: 12 } } });
  assert.deepStrictEqual(noLayer.missing, ["layer height"], "a print with no layer height on the line says so");
});

// What the checkout route stores with every order line since 2026-11-11 (`config.priced`: services/quoteIntegrity.js
// partSnapshot + the validated configuration; services/checkoutGuard.js pricedSnapshot). The traveler reads it first.
const PRICED = { fingerprint: "f".repeat(64), quoteFingerprint: "e".repeat(64), basis: "current", pricedAt: "2026-11-11T15:00:00.000Z", geometryHash: "a".repeat(64), units: "mm", sourceUnit: "in",
  dimsMm: { x: 254, y: 203.2, z: 12.7 }, volumeMm3: null, is2D: true, process: "routing", subProcess: "sheet", materialSlug: "rt-polycarbonate", materialName: "Polycarbonate", grade: "Clear",
  thicknessMm: 12.7, finishSlug: "rt-as-cut", finishName: "As cut", quantity: 4, layerHeight: null, infill: null };

test("the snapshot of what was priced (config.priced) is what the traveler prints: thickness, grade, units and size, even when the part row is gone", async () => {
  // No geometry joined on (the part was purged) and nothing else in the line's config.
  const item = { fileName: "bracket.dxf", quantity: 4, unitPrice: 50, lineTotal: 200, config: { priced: PRICED } };
  const spec = specOf(item);
  assert.deepStrictEqual(spec.missing, [], spec.parts.join(" | "));
  const text = flat(await generateJobTraveler({ ...routedOrder, paperwork: false, returnPart: false, paperworkFee: 0 }, [item]));
  for (const phrase of ["CNC routing", "Polycarbonate", "grade Clear", "stock thickness 12.7 mm (0.500 in)", "size 254 x 203.2 mm (10.00 x 8.00 in)", "drawing units inches", "finish As cut", "qty 4"]) assert.ok(text.includes(phrase), `the traveler prints "${phrase}"\n${text}`);
  assert.ok(!text.includes("NOT RECORDED") && !text.includes("CHECK BEFORE CUTTING"), "nothing is missing");
  // It wins over older fields that disagree: the sheet says what was charged for.
  const both = fullDescription({ ...routedItem, config: { ...routedItem.config, priced: PRICED } });
  assert.ok(both.includes("stock thickness 12.7 mm") && both.includes("grade Clear") && both.includes("size 254 x 203.2 mm") && !both.includes("19.1") && !both.includes("304.8"), both);
  assert.ok(both.includes("drawing units inches (chosen by the customer)"), "who chose the units still comes from the part when it is there");
  // A 3D print: three dimensions, the layer height and infill that were priced.
  const print = fullDescription({ fileName: "cover.stl", quantity: 3, config: { priced: { ...PRICED, is2D: false, sourceUnit: null, process: "3d-printing", subProcess: "fdm", materialName: "PETG", grade: "", thicknessMm: null, finishName: "As printed", dimsMm: { x: 40, y: 30, z: 12 }, volumeMm3: 9000, layerHeight: 0.2, infill: 0.35 } } });
  for (const phrase of ["3D printing (FDM)", "PETG", "size 40 x 30 x 12 mm", "layer height 0.2 mm", "infill 35%", "qty 3"]) assert.ok(print.includes(phrase), `${phrase} in: ${print}`);
});

test("an order from before the snapshot existed keeps the NOT RECORDED fallback; a part that no longer matches what was priced stops the job on paper", async () => {
  const old = { fileName: "plate.dxf", process: "routing", materialName: "UHMW", finishName: "As cut", quantity: 4, unitPrice: 10, lineTotal: 40, config: { priced: null } };
  assert.deepStrictEqual(specOf(old).missing, ["grade", "thickness", "size", "drawing units"]);
  const changed = { fileName: "bracket.dxf", quantity: 4, unitPrice: 50, lineTotal: 200, matchesPriced: false, config: { priced: PRICED } };
  assert.deepStrictEqual(specOf(changed).missing, ["part file"]);
  const text = flat(await generateJobTraveler({ ...routedOrder, paperwork: false, returnPart: false, paperworkFee: 0 }, [changed]));
  assert.ok(/PART FILE CHANGED SINCE IT WAS PRICED . do not cut from it; confirm with customer/.test(text), text);
  assert.ok(text.includes("CHECK BEFORE CUTTING: 1 VALUE NOT RECORDED ON THIS ORDER"), "and it is counted at the top");
  assert.deepStrictEqual(specOf({ ...changed, matchesPriced: true }).missing, []);
});

Promise.all(pending).then(() => {
  console.log(failed ? `\npdfGenerator: ${failed} failed` : "pdfGenerator: all passed");
  if (failed) process.exit(1);
});
