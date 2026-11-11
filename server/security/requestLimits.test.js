/**
 * Request-size limits and rate limiters on the real server, in production
 * mode (one trusted proxy hop, as behind Railway).
 * Run: node server/security/requestLimits.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Request limits and rate limits (live server)");
const cube = fs.readFileSync(path.join(live.ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
const servers = [];
async function server(opts) { const s = await live.start(opts); servers.push(s); return s; }

let D; // default limits
const startD = async () => (D = D || await server({}));
let T; // tiny limits so each limiter can be reached in a few calls
const startT = async () => (T = T || await server({ env: {
  RATE_API_PER_15MIN: "20", RATE_QUOTE_PER_15MIN: "30", RATE_QUOTE_BURST_PER_10SEC: "10", RATE_UPLOAD_PER_15MIN: "3",
  RATE_QUOTE_SESSION_PER_15MIN: "5", RATE_PDF_PER_15MIN: "5", RATE_DRAWING_PER_HOUR: "2", RATE_RFQ_PER_HOUR: "3",
} }));

/** Upload the cube and return a priceable configuration for it. */
async function quotable(s, ip) {
  const up = await s.upload([{ name: "cube.stl", data: cube }], { ip });
  assert.strictEqual(up.status, 200, up.text);
  const mats = (await s.get("/api/materials?process=cnc", { ip })).body;
  return { parts: [{ partId: up.body.parts[0].partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] };
}

// ─── Body size ───────────────────────────────────────────────

test("JSON bodies over 1 MB are refused on every route (was 50 MB); ordinary ones are not", async () => {
  const s = await startD();
  const big = { parts: [], pad: "x".repeat(1024 * 1024 + 1000) };
  for (const url of ["/api/quote", "/api/auth/login", "/api/auth/register", "/api/orders/checkout-session", "/api/rfq/quote/abc/accept", "/api/admin/pricing/preview", "/api/does-not-exist"]) {
    const r = await s.post(url, big, { ip: "203.0.113.1" });
    assert.strictEqual(r.status, 413, `${url} → ${r.status} ${r.text.slice(0, 100)}`);
    assert.deepStrictEqual(r.body, { error: "The request is too large." });
  }
  const put = await s.req({ url: "/api/admin/pricing", method: "PUT", json: big, ip: "203.0.113.1" });
  assert.strictEqual(put.status, 413);
  // 900 kB is under the limit: the route itself answers (no parts → 400), not the size guard.
  const ok = await s.post("/api/quote", { parts: [], pad: "x".repeat(900 * 1024) }, { ip: "203.0.113.1" });
  assert.strictEqual(ok.status, 400, ok.text);
  // Form-encoded bodies are not used by the app and are no longer parsed at all (the global urlencoded
  // parser is gone): the account routes refuse the content type, and elsewhere the body is simply not read.
  const form = await s.req({ url: "/api/auth/login", method: "POST", ip: "203.0.113.1", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`email=a%40b.co&password=x&a=${"x".repeat(200 * 1024)}`) });
  assert.strictEqual(form.status, 415, form.text);
  const formQuote = await s.req({ url: "/api/quote", method: "POST", ip: "203.0.113.1", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: Buffer.from(`parts[0][partId]=x&pad=${"x".repeat(3 * 1024 * 1024)}`) });
  assert.deepStrictEqual([formQuote.status, formQuote.body], [400, { error: "No parts configured" }], "3 MB of form fields: not parsed, not an error about size, just no parts");
});

test("a body that is not JSON, nests absurdly deep, or carries __proto__ is answered plainly and changes nothing", async () => {
  const s = await startD();
  const raw = (body) => s.req({ url: "/api/quote", method: "POST", ip: "203.0.113.2", headers: { "Content-Type": "application/json" }, body: Buffer.from(body) });
  const bad = await raw('{"parts": [');
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(bad.body, { error: "The request body isn't valid JSON." });
  const deep = await raw("[".repeat(400000) + "]".repeat(400000));
  assert.ok([400, 413].includes(deep.status), `deep nesting → ${deep.status}`);
  assert.ok(!/stack|at \w+ \(|node_modules/.test(deep.text), deep.text.slice(0, 200));
  const proto = await raw('{"__proto__": {"polluted": true, "role": "admin"}, "constructor": {"prototype": {"polluted": true}}, "parts": [{"__proto__": {"x": 1}, "partId": "nope"}]}');
  assert.ok(proto.status === 400, `${proto.status} ${proto.text}`);
  assert.strictEqual((await s.get("/api/health")).status, 200, "the server is still up");
  // and an admin-only route did not become reachable through it
  assert.strictEqual((await s.get("/api/admin/materials", { ip: "203.0.113.2" })).status, 401);
});

// ─── Rate limits ─────────────────────────────────────────────

test("general API limit: keyed by the address the edge reports; a forged X-Forwarded-For prefix does not reset it", async () => {
  const s = await startT();
  const me = "203.0.113.10";
  const statuses = [];
  for (let i = 0; i < 20; i++) statuses.push((await s.get("/api/materials", { ip: i % 2 ? me : `10.0.0.${i}, ${me}` })).status);
  assert.ok(statuses.every((c) => c === 200), statuses.join(","));
  const over = await s.get("/api/materials", { ip: `1.2.3.4, 5.6.7.8, ${me}` });
  assert.strictEqual(over.status, 429, "the 21st call is refused whatever the client claims to be");
  assert.deepStrictEqual(over.body, { error: "Too many requests, please try again later." });
  assert.ok(over.headers["ratelimit-limit"] && over.headers["ratelimit-reset"], "standard RateLimit headers tell the client when to come back");
  assert.strictEqual((await s.get("/api/materials", { ip: "::ffff:203.0.113.10" })).status, 429, "the IPv4-mapped form is the same client");
  assert.strictEqual((await s.get("/api/materials", { ip: "203.0.113.11" })).status, 200, "another address is unaffected");
});

test("an IPv6 client is limited as its /64, not as one of its 2^64 addresses", async () => {
  const s = await startT();
  for (let i = 0; i < 20; i++) assert.strictEqual((await s.get("/api/finishes", { ip: `2001:db8:77:1::${(i + 1).toString(16)}` })).status, 200);
  assert.strictEqual((await s.get("/api/finishes", { ip: "2001:db8:77:1:ffff:ffff:ffff:ffff" })).status, 429);
  assert.strictEqual((await s.get("/api/finishes", { ip: "2001:db8:77:2::1" })).status, 200, "the next /64 is another client");
});

test("the health check is never rate limited and never counts", async () => {
  const s = await startT();
  const me = "203.0.113.12";
  for (let i = 0; i < 60; i++) assert.strictEqual((await s.get("/api/health", { ip: me })).status, 200);
  assert.strictEqual((await s.get("/api/materials", { ip: me })).status, 200, "sixty health checks used none of the budget");
});

test("quote pricing has its own budget: it does not eat the general one, and it is capped per 10 s and per 15 min", async () => {
  const s = await startT();
  const me = "203.0.113.13";
  const body = await quotable(s, me); // 1 upload + 1 catalog read
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await s.post("/api/quote", body, { ip: me })).status);
  assert.ok(codes.every((c) => c === 200), `ten quick re-prices: ${codes.join(",")}`);
  const burst = await s.post("/api/quote", body, { ip: me });
  assert.strictEqual(burst.status, 429, "the 11th inside ten seconds is slowed down");
  assert.strictEqual(burst.body.code, "rate-limited");
  assert.ok(/faster than we can price/.test(burst.body.error), burst.body.error);
  // the general budget (20) is nearly untouched: 18 more catalog reads still pass
  for (let i = 0; i < 18; i++) assert.strictEqual((await s.get("/api/lead-times", { ip: me })).status, 200, `catalog read ${i + 1}`);
  assert.strictEqual((await s.get("/api/lead-times", { ip: me })).status, 429, "and then the general limit applies as before");
  // a hand-built pricing request with no parts counts as well
  const other = "203.0.113.14";
  for (let i = 0; i < 10; i++) assert.strictEqual((await s.post("/api/quote", { parts: [] }, { ip: other })).status, 400);
  assert.strictEqual((await s.post("/api/quote", { parts: [] }, { ip: other })).status, 429);
});

test("every other expensive route has a limiter: uploads, DXF units, quote session reads, drawings, PDFs, RFQs", async () => {
  const s = await startT();
  // uploads: 3 per 15 min
  const up = "203.0.113.20";
  for (let i = 0; i < 3; i++) assert.strictEqual((await s.upload([{ name: "c.stl", data: cube }], { ip: up })).status, 200);
  const fourth = await s.upload([{ name: "c.stl", data: cube }], { ip: up });
  assert.strictEqual(fourth.status, 429);
  assert.strictEqual(s.files("uploads").length >= 3, true);

  // DXF units: same size of budget, counted on its own
  const un = "203.0.113.21";
  for (let i = 0; i < 3; i++) assert.strictEqual((await s.post("/api/parts/00000000-0000-4000-8000-000000000000/units", { units: "mm" }, { ip: un })).status, 404);
  assert.strictEqual((await s.post("/api/parts/00000000-0000-4000-8000-000000000000/units", { units: "mm" }, { ip: un })).status, 429);

  // quote session reads (the heavy read: every part's mesh): 5 per 15 min
  const se = "203.0.113.22";
  const body = await quotable(s, se);
  const q = await s.post("/api/quote", body, { ip: se });
  for (let i = 0; i < 5; i++) assert.strictEqual((await s.get(`/api/quote/${q.body.quoteId}/session`, { ip: se })).status, 200);
  assert.strictEqual((await s.get(`/api/quote/${q.body.quoteId}/session`, { ip: se })).status, 429);
  assert.strictEqual((await s.get(`/api/quote/${q.body.quoteId}`, { ip: se })).status, 200, "the light read is still under the general limit");

  // drawings: 2 per hour
  const send = () => s.upload([{ field: "drawing", name: "d.pdf", data: pdf }], { url: `/api/quote/${q.body.quoteId}/drawing`, ip: se });
  assert.strictEqual((await send()).status, 200);
  assert.strictEqual((await send()).status, 200);
  assert.strictEqual((await send()).status, 429);
  assert.strictEqual(s.files("quote-drawings").length, 1, "the limiter refused before the third file was written");

  // PDFs: 5 per 15 min, counted before authentication so a flood of anonymous requests is bounded too
  const pd = "203.0.113.23";
  for (let i = 0; i < 5; i++) assert.strictEqual((await s.get(`/api/pdf/quote/${q.body.quoteId}`, { ip: pd })).status, 401);
  assert.strictEqual((await s.get(`/api/pdf/quote/${q.body.quoteId}`, { ip: pd })).status, 429);
  assert.strictEqual((await s.get("/api/pdf/fai", { ip: pd })).status, 429, "one budget for every document");

  // RFQs: 3 per hour
  const rf = "203.0.113.24";
  // (each a different request: the same one again inside half an hour is answered from the first, not stored twice)
  for (let i = 0; i < 3; i++) assert.strictEqual((await s.rfq({ contactName: "A Buyer", email: "buyer@example.com", notes: `request ${i + 1}` }, [], { ip: rf })).status, 201);
  const fourthRfq = await s.rfq({ contactName: "A Buyer", email: "buyer@example.com", notes: "request 4" }, [], { ip: rf });
  assert.strictEqual(fourthRfq.status, 429);
  assert.ok(/Too many requests from this address/.test(fourthRfq.body.error), "refused by the route limiter, before the form is read");
  // The limiter counts what is sent, kept or not: a request without its form token is refused (400) and still uses the budget.
  const rf2 = "203.0.113.25";
  for (let i = 0; i < 3; i++) assert.strictEqual((await s.upload([], { url: "/api/rfq", ip: rf2, fields: { contactName: "A Buyer", email: "buyer@example.com" } })).status, 400);
  assert.strictEqual((await s.upload([], { url: "/api/rfq", ip: rf2, fields: { contactName: "A Buyer", email: "buyer@example.com" } })).status, 429);
});

test("default limits leave room for a real quoting session: ten uploads, the catalog, and re-pricing as fast as the tool can ask", async () => {
  const s = await startD();
  const me = "203.0.113.30";
  // Ten parts dropped one at a time, the catalog for three processes, the quote reopened twice.
  const partIds = [];
  for (let i = 0; i < 10; i++) {
    const up = await s.upload([{ name: `part-${i}.stl`, data: cube }], { ip: me });
    assert.strictEqual(up.status, 200, `upload ${i + 1}: ${up.text.slice(0, 120)}`);
    partIds.push(up.body.parts[0].partId);
  }
  for (const p of ["cnc", "routing", "3d-printing"]) for (const u of [`/api/materials?process=${p}`, `/api/finishes?process=${p}`]) assert.strictEqual((await s.get(u, { ip: me })).status, 200);
  for (const u of ["/api/processes", "/api/lead-times"]) assert.strictEqual((await s.get(u, { ip: me })).status, 200);
  const mats = (await s.get("/api/materials?process=cnc", { ip: me })).body;
  const body = (qty) => ({ parts: partIds.map((partId) => ({ partId, materialSlug: mats[0].slug, quantity: qty, process: "cnc", subProcess: "milling" })) });
  // The tool debounces to one pricing call per 400 ms: 25 in ten seconds at the very most.
  // Send 35 back to back (faster than any browser will), then keep going at tool speed.
  const times = [];
  let quoteId;
  for (let i = 0; i < 35; i++) {
    const r = await s.post("/api/quote", { ...body(i + 1), quoteId }, { ip: me });
    assert.strictEqual(r.status, 200, `re-price ${i + 1}: ${r.status} ${r.text.slice(0, 120)}`);
    quoteId = r.body.quoteId;
    times.push(r.ms);
  }
  for (let i = 0; i < 2; i++) assert.strictEqual((await s.get(`/api/quote/${quoteId}/session`, { ip: me })).status, 200);
  const r = await s.get("/api/materials", { ip: me });
  assert.strictEqual(r.status, 200);
  assert.ok(Number(r.headers["ratelimit-remaining"]) > 150, `after the whole session ${r.headers["ratelimit-remaining"]} of 200 general calls remain`);
  times.sort((a, b) => a - b);
  console.log(`       (pricing a ten-part quote: median ${times[Math.floor(times.length / 2)]} ms, slowest ${times[times.length - 1]} ms)`);
});

run(async () => { for (const s of servers) await s.stop(); });
