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
  require("../services/pricingMemo").resetForTests();
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

// ─── Independent re-review 2026-11-12, RR-13: the worst case, not the best ───
// Round 1 measured one part repeated on every line (which the memo makes free). The attack that
// still froze the site was 25 DIFFERENT dense parts per quote, from eight addresses, no account.

const median = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
let denseParts = [];
let routingMat;
const denseLine = (id, quantity = 1) => ({ partId: id, materialSlug: routingMat.slug, quantity, process: "routing", thicknessMm: routingMat.thicknesses[0].mm });
const anonFrom = (ip, body) => h.raw("POST", "/api/quote", { json: body, ip, headers: { "X-Human-Token": h.humanToken } });

test("RR-13: eight addresses pricing quotes of different dense parts get a share of the thread, not the thread; a visitor's one-line re-price is not behind them", async () => {
  require("../services/pricingMemo").resetForTests();
  routingMat = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active);
  // Ten different dense drawings (different hole counts, so nothing is shared between them).
  for (let i = 0; i < 10; i++) denseParts.push(await uploadPart(`sheet-${i}.dxf`, perforatedDxf(1500 + i * 37), { process: "routing" }));
  const detail = denseParts.reduce((sum, id) => sum + (Number(h.models.partsDB.getRow(id).detailBytes) || 0), 0);
  assert.ok(detail > 2 * 1024 * 1024, `the ten parts carry ${(detail / 1048576).toFixed(1)} MB of measured detail between them`);
  const heavyBody = (n) => ({ parts: denseParts.map((id, i) => denseLine(id, 1 + ((n + i) % 7))) });
  const cube = await h.uploadCube();
  const V = "203.0.113.200";
  const first = await anonFrom(V, { parts: [h.cncConfig(cube, 1)] });
  assert.strictEqual(first.status, 200, first.text.slice(0, 200));

  const memo = require("../services/pricingMemo");
  const loop = monitorEventLoopDelay({ resolution: 2 });
  let stop = false;
  const outcomes = {};
  const attacker = async (n) => {
    const ip = `198.51.100.${10 + n}`;
    let quoteId; let i = 0;
    while (!stop) {
      const r = await anonFrom(ip, { ...heavyBody(n + i++), ...(quoteId ? { quoteId } : {}) }); // creating, then re-pricing
      const k = r.status === 200 ? "priced" : (r.body && r.body.code) || String(r.status);
      outcomes[k] = (outcomes[k] || 0) + 1;
      if (r.status === 200) quoteId = r.body.quoteId;
      if (r.status === 429) await new Promise((res) => setTimeout(res, 200));
    }
  };
  const visitor = [];
  const health = [];
  const innocent = async () => { let n = 0; while (!stop) { const t = Date.now(); const r = await anonFrom(V, { parts: [h.cncConfig(cube, 1 + (n++ % 9))], quoteId: first.body.quoteId }); visitor.push({ status: r.status, ms: Date.now() - t }); await new Promise((res) => setTimeout(res, 150)); } };
  const pinger = async () => { while (!stop) { const t = Date.now(); const r = await h.raw("GET", "/api/public/config"); if (r.status === 200) health.push(Date.now() - t); await new Promise((res) => setTimeout(res, 25)); } };
  loop.enable();
  const seconds = 6;
  const all = [...Array.from({ length: 8 }, (_, n) => attacker(n)), innocent(), pinger()];
  await new Promise((res) => setTimeout(res, seconds * 1000));
  stop = true;
  await Promise.all(all);
  loop.disable();

  const load = require("os").loadavg()[0].toFixed(1);
  const what = `another page: median ${median(health)} ms over ${health.length} requests, worst ${Math.max(...health)} ms; loop delay median ${(loop.percentile(50) / 1e6).toFixed(0)} ms; visitor median ${median(visitor.map((v) => v.ms))} ms over ${visitor.length} re-prices; attackers ${JSON.stringify(outcomes)}; load average ${load}`;
  assert.ok((outcomes.priced || 0) >= 2, `the heavy quotes are still priced, in turn: ${what}`);
  assert.ok(visitor.length >= 5 && visitor.every((v) => v.status === 200), `the visitor is never refused: ${what}`);
  // The acceptance line is 250 ms for the health check and 1 s for the visitor at whatever load the
  // machine has. Here the server and the eight attackers share one process, which is harder.
  assert.ok(health.length > 40 && median(health) < 250, what);
  assert.ok(median(visitor.map((v) => v.ms)) < 1000, what);
  assert.ok(loop.percentile(50) / 1e6 < 100, what);
  // Together the eight had a burst and then a third of the thread, not all of it.
  const used = Array.from({ length: 8 }, (_, n) => memo.usedMs(`198.51.100.${10 + n}`)).reduce((a, b) => a + b, 0);
  assert.ok(used < 1000 + seconds * 1000 * 0.6, `eight addresses used ${used} ms of pricing work in ${seconds} s (${what})`);
  assert.ok(memo.stats().pieces > 20, "the work was done in pieces");
  console.log(`       (${what})`);
});

test("RR-13: pricing time is charged to the address and to the account, and a sender past the hour's allowance is told when to come back; nobody else is", async () => {
  const memo = require("../services/pricingMemo");
  memo.resetForTests();
  const cube = await h.uploadCube();
  const one = { parts: denseParts.slice(0, 3).map((id) => denseLine(id, 2)) };
  process.env.QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR = "1";
  process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR = "1";
  try {
    const ip = "198.51.100.90";
    // An address is charged for what it prices, by the millisecond…
    assert.strictEqual((await anonFrom(ip, one)).status, 200);
    const afterOne = memo.usedMs(ip);
    assert.ok(afterOne > 0, `one quote of three dense parts cost ${afterOne} ms`);
    // …and so is the account it priced with, whatever address that account comes from.
    const acct = await h.register(`pricer-${Date.now()}@example.test`);
    const userId = h.models.usersDB.getAll().slice(-1)[0].id;
    const signedIn = (from, body) => h.raw("POST", "/api/quote", { json: body, ip: from, token: acct, headers: { "X-Human-Token": h.humanToken } });
    assert.strictEqual((await signedIn("198.51.100.91", one)).status, 200);
    assert.ok(memo.usedMs(`user:${userId}`) > 0 && memo.usedMs("198.51.100.91") > 0, "account and address are both charged");
    // Past the allowance (a second is used up here by hand):
    memo.usage.add(ip, 1000);
    memo.usage.add(`user:${userId}`, 1000);
    const refused = await anonFrom(ip, one);
    assert.deepStrictEqual([refused.status, refused.body.code, refused.body.offerRfq], [429, "pricing-budget", true], refused.text.slice(0, 200));
    assert.ok(Number(refused.headers.get("retry-after")) >= 60);
    assert.ok(/firm quote/i.test(refused.body.error) && /minute/.test(refused.body.error) && !/budget|thread|millisecond/i.test(refused.body.error), refused.body.error);
    const fromElsewhere = await signedIn("198.51.100.92", one);
    assert.deepStrictEqual([fromElsewhere.status, fromElsewhere.body.code], [429, "pricing-budget"], "a new address does not give the account a new allowance");
    // A different visitor, at that moment:
    assert.strictEqual((await anonFrom("203.0.113.201", { parts: [h.cncConfig(cube, 1)] })).status, 200);
  } finally {
    delete process.env.QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR;
    delete process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR;
    memo.resetForTests();
  }
});

test("RR-05: the gate and the runner are exported so another pricing route (reorder) takes two lines", async () => {
  const gate = require("../security/pricingGate");
  const memo = require("../services/pricingMemo");
  const req = { ip: "203.0.113.210", headers: {}, user: { userId: "u-1" }, body: {} };
  const job = gate.job(req, [{ partId: denseParts[0] }, { partId: denseParts[1] }]);
  assert.deepStrictEqual(job.keys, ["203.0.113.210", "user:u-1"]);
  assert.strictEqual(job.heavy, true, "two dense parts: the heavy lane");
  assert.strictEqual(gate.job(req, [{ partId: await h.uploadCube() }]).heavy, false);
  assert.strictEqual(gate.context(req).clientKey, "203.0.113.210");
  const { saveQuote } = require("./api");
  const result = await memo.run(() => saveQuote({ parts: [denseLine(denseParts[0], 1)] }, null, gate.context(req)), gate.job(req, [{ partId: denseParts[0] }]));
  assert.ok(result.saved && result.saved.id, "priced and saved through the runner, as the quote route does");
  assert.ok(memo.usedMs("user:u-1") > 0);
});

run(async () => { if (h) await h.stop(); process.exit(process.exitCode || 0); });
