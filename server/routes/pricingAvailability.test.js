/**
 * Pricing does not stall the site (independent review 2026-11-11, C2).
 *
 * Before: every line of a quote reloaded its part, re-read the catalog tables and
 * re-ran DFM, all in one uninterrupted run on the main thread; a 100-line quote
 * of one dense DXF held every other request for seconds, and one address could
 * keep it that way.
 * Now: a per-request memo, yielding between lines, a time budget, one pricing
 * request in flight per client, and fewer lines without an account — with the
 * price itself unchanged.
 * Run: node server/routes/pricingAvailability.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { monitorEventLoopDelay } = require("perf_hooks");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Pricing availability");
const partsDir = path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts");
const read = (name) => fs.readFileSync(path.join(partsDir, name));

/** A plate with n holes as a DXF: a real, priceable routed part whose geometry detail is large. */
function perforatedDxf(n, pitch = 6) {
  const side = Math.ceil(Math.sqrt(n));
  const w = side * pitch + 10;
  let e = `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n-5\n20\n-5\n10\n${w - 5}\n20\n-5\n10\n${w - 5}\n20\n${w - 5}\n10\n-5\n20\n${w - 5}\n`;
  for (let i = 0; i < n; i++) e += `0\nCIRCLE\n8\n0\n10\n${(i % side) * pitch}\n20\n${Math.floor(i / side) * pitch}\n40\n1.6\n`;
  return Buffer.from(`0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${e}0\nENDSEC\n0\nEOF\n`);
}

let h;
let buyer;
const uploadPart = async (name, data, fields = {}) => {
  const r = await h.form("/api/upload", fields, { files: { name, data } });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.strictEqual(r.body.parts.length, 1, r.text.slice(0, 300));
  return r.body.parts[0].partId;
};
/** Count calls to a model method for the length of `fn`. */
async function counting(obj, method, fn) {
  const real = obj[method];
  let n = 0;
  obj[method] = function counted(...args) { n++; return real.apply(this, args); };
  try { await fn(); } finally { obj[method] = real; }
  return n;
}

test("a 100-line quote loads each part once and each catalog table once, and prices exactly as line-by-line pricing does", async () => {
  h = await start();
  buyer = await h.register("buyer@example.test");
  const a = await uploadPart("bushing.stl", read("bushing.stl"));
  const b = await uploadPart("bracket_block.stl", read("bracket_block.stl"));
  const mats = h.models.materialsDB.getAll().filter((m) => m.process === "cnc" && m.active).slice(0, 3);
  // 100 lines over two parts, three materials and five quantities: plenty of repeats and plenty of distinct configurations.
  const lines = Array.from({ length: 100 }, (_, i) => {
    const m = mats[i % mats.length];
    return { partId: i % 2 ? a : b, materialSlug: m.slug, grade: m.grades?.[0]?.name || "", finishSlug: "", quantity: [1, 2, 5, 10, 25][i % 5], process: "cnc", subProcess: "milling" };
  });
  let memo;
  const partLoads = await counting(h.models.partsDB, "getById", async () => {
    const tableReads = await counting(h.models.materialsDB, "getAll", async () => {
      memo = await h.post("/api/quote", { parts: lines }, buyer);
    });
    assert.strictEqual(memo.status, 200, memo.text.slice(0, 300));
    assert.strictEqual(tableReads, 1, "the materials table is read once for the request (it was once per line)");
  });
  assert.strictEqual(partLoads, 2, "each distinct part is loaded once (it was once per line)");

  // The same input priced the old way: straight through, no memo.
  const { saveQuote } = require("./api");
  const plain = saveQuote({ parts: lines }, { userId: h.models.quotesDB.getById(memo.body.quoteId).userId });
  const strip = (q) => JSON.parse(JSON.stringify({ lineItems: q.lineItems, subtotal: q.subtotal, orderTotal: q.orderTotal, shippingEstimate: q.shippingEstimate, leadTimeSurcharge: q.leadTimeSurcharge, totalWeight: q.totalWeight }));
  assert.deepStrictEqual(strip(memo.body), strip(plain.quote), "every line, break and total is identical");
  assert.deepStrictEqual(memo.body.gate, JSON.parse(JSON.stringify(plain.gate)));
});

test("pricing yields: while a heavy quote is priced the event loop keeps turning, and other requests are answered", async () => {
  const partId = await uploadPart("perforated.dxf", perforatedDxf(1600), { process: "routing" });
  const mat = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active);
  // Distinct quantities and thicknesses: 100 lines, every one a different thing to price.
  const thicknesses = (mat.thicknesses || []).map((t) => t.mm);
  const lines = Array.from({ length: 100 }, (_, i) => ({ partId, materialSlug: mat.slug, quantity: i + 1, process: "routing", thicknessMm: thicknesses[i % thicknesses.length] }));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  let others = 0;
  let pricing = true;
  const poke = (async () => { while (pricing) { const r = await h.raw("GET", "/api/public/config"); if (r.status === 200) others++; } })();
  loop.enable();
  const t0 = Date.now();
  const q = await h.post("/api/quote", { parts: lines }, buyer);
  const took = Date.now() - t0;
  loop.disable();
  pricing = false;
  await poke;
  assert.strictEqual(q.status, 200, q.text.slice(0, 300));
  assert.strictEqual(q.body.lineItems.length, 100);
  const worstMs = loop.max / 1e6;
  // One uninterrupted run would stall the loop for the whole request. Slices are a few tens of ms.
  assert.ok(worstMs < Math.max(250, took / 3), `event loop stalled ${worstMs.toFixed(0)} ms during a ${took} ms pricing request`);
  assert.ok(others >= 3, `${others} other requests were answered while the quote was being priced`);
});

test("a quote that needs more main-thread time than the budget is stopped with a refusal that offers the firm quote; nothing is saved", async () => {
  const partId = await uploadPart("perforated2.dxf", perforatedDxf(1600), { process: "routing" });
  const mat = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active);
  const lines = Array.from({ length: 60 }, (_, i) => ({ partId, materialSlug: mat.slug, quantity: i + 1, process: "routing", thicknessMm: mat.thicknesses[0].mm }));
  const before = h.models.quotesDB.count();
  process.env.QUOTE_PRICE_BUDGET_MS = "3";
  process.env.QUOTE_PRICE_SLICE_MS = "1";
  try {
    const r = await h.post("/api/quote", { parts: lines }, buyer);
    assert.strictEqual(r.status, 422, r.text.slice(0, 200));
    assert.strictEqual(r.body.code, "quote-too-slow");
    assert.strictEqual(r.body.offerRfq, true);
    assert.ok(/firm quote/i.test(r.body.error) && !/thread|event loop|timeout|budget/i.test(r.body.error), r.body.error);
  } finally {
    delete process.env.QUOTE_PRICE_BUDGET_MS;
    delete process.env.QUOTE_PRICE_SLICE_MS;
  }
  assert.strictEqual(h.models.quotesDB.count(), before, "a refused quote is not stored");
  // and the same quote prices normally inside the default budget
  assert.strictEqual((await h.post("/api/quote", { parts: lines }, buyer)).status, 200);
});

test("one pricing request in flight per client: a second waits its turn or is told to retry; other clients are not held up", async () => {
  const partId = await uploadPart("perforated3.dxf", perforatedDxf(1600), { process: "routing" });
  const mat = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active);
  const heavy = { parts: Array.from({ length: 80 }, (_, i) => ({ partId, materialSlug: mat.slug, quantity: i + 1, process: "routing", thicknessMm: mat.thicknesses[0].mm })) };
  const light = { parts: [{ partId, materialSlug: mat.slug, quantity: 1, process: "routing", thicknessMm: mat.thicknesses[0].mm }] };
  const from = (ip, body) => h.raw("POST", "/api/quote", { json: body, token: buyer, ip, headers: { "X-Human-Token": h.humanToken } });

  process.env.QUOTE_PRICE_WAIT_MS = "0";
  try {
    const same = await Promise.all([from("203.0.113.61", heavy), from("203.0.113.61", heavy), from("203.0.113.61", heavy), from("203.0.113.61", heavy)]);
    const statuses = same.map((r) => r.status).sort();
    assert.ok(statuses.includes(200) && statuses.includes(429), `four at once from one address: ${statuses.join(" ")}`);
    const refused = same.find((r) => r.status === 429);
    assert.strictEqual(refused.body.code, "pricing-in-progress");
    assert.ok(refused.headers.get("retry-after"));
  } finally { delete process.env.QUOTE_PRICE_WAIT_MS; }

  // With the default short wait, a browser's back-to-back re-prices all go through, one after another.
  const queued = await Promise.all([from("203.0.113.62", light), from("203.0.113.62", light), from("203.0.113.62", light)]);
  assert.deepStrictEqual(queued.map((r) => r.status), [200, 200, 200]);
  // Different clients at the same moment are all served.
  const many = await Promise.all(["203.0.113.71", "203.0.113.72", "203.0.113.73"].map((ip) => from(ip, light)));
  assert.deepStrictEqual(many.map((r) => r.status), [200, 200, 200]);
  assert.strictEqual(require("../security/pricingGate").stats().inFlight, 0, "every place was given back");
});

test("a visitor without an account may price 25 lines in one quote; a signed-in customer keeps 100", async () => {
  const partId = await h.uploadCube();
  const line = h.cncConfig(partId, 1);
  const anon = await h.post("/api/quote", { parts: Array.from({ length: 26 }, () => line) });
  assert.strictEqual(anon.status, 400);
  assert.strictEqual(anon.body.code, "too-many-lines");
  assert.strictEqual(anon.body.offerRfq, true);
  assert.ok(/sign in/i.test(anon.body.error));
  assert.strictEqual((await h.post("/api/quote", { parts: Array.from({ length: 25 }, () => line) })).status, 200);
  assert.strictEqual((await h.post("/api/quote", { parts: Array.from({ length: 100 }, () => line) }, buyer)).status, 200);
  const over = await h.post("/api/quote", { parts: Array.from({ length: 101 }, () => line) }, buyer);
  assert.strictEqual(over.status, 400);
  assert.strictEqual(over.body.code, "too-many-lines");
});

run(async () => { if (h) await h.stop(); process.exit(process.exitCode || 0); });
