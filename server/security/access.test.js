/**
 * Who can reach what, on the real server in production mode: admin routes,
 * backups, PDFs, downloads, one customer's records from another's account —
 * and what an error or a log line is allowed to say.
 * Run: node server/security/access.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Access, errors and logs (live server)");
const cube = fs.readFileSync(path.join(live.ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
let s, admin, alice, bob;
const st = {};
let ipN = 0;
const ip = () => `198.51.100.${(++ipN % 250) + 1}`; // spread across addresses: this suite is about access, not rate limits
const INTERNALS = /node_modules|\/server\/|\.js:\d+|\bat [A-Za-z_.<>]+ \(|ENOENT|EACCES|SQLITE|sql\.js|Error:\s|stack/i;

test("setup: an admin, two buyers, a quote each, a drawing and a request", async () => {
  s = await live.start({ env: { RATE_PDF_PER_15MIN: "1000" } });
  admin = await s.admin({ ip: ip() });
  alice = await s.register("alice@example.com", { ip: ip() });
  bob = await s.register("bob@example.com", { ip: ip() });
  const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: ip() });
  st.partId = up.body.parts[0].partId;
  const mats = (await s.get("/api/materials?process=cnc", { ip: ip() })).body;
  st.config = { partId: st.partId, materialSlug: mats[0].slug, quantity: 2, process: "cnc", subProcess: "milling" };
  const qa = await s.post("/api/quote", { parts: [st.config] }, { ip: ip(), token: alice });
  assert.strictEqual(qa.status, 200, qa.text);
  st.aliceQuote = qa.body.quoteId;
  const d = await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: `/api/quote/${st.aliceQuote}/drawing`, ip: ip(), token: alice });
  assert.strictEqual(d.status, 200, d.text);
  const rfq = await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: "/api/rfq", ip: ip(), token: alice, fields: { contactName: "Alice", email: "alice@example.com", quoteId: st.aliceQuote } });
  assert.strictEqual(rfq.status, 201, rfq.text);
  st.aliceRfq = rfq.body.rfqId;
});

test("every admin route: 401 without a token, 403 with a buyer's, never a body", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const routes = [
    ["GET", "/api/admin/materials"], ["POST", "/api/admin/materials"], ["PUT", `/api/admin/materials/${id}`], ["DELETE", `/api/admin/materials/${id}`], ["POST", `/api/admin/materials/${id}/duplicate`],
    ["GET", "/api/admin/finishes"], ["POST", "/api/admin/finishes"], ["PUT", `/api/admin/finishes/${id}`],
    ["GET", "/api/admin/lead-times"], ["PUT", `/api/admin/lead-times/${id}`],
    ["GET", "/api/admin/pricing"], ["PUT", "/api/admin/pricing"], ["GET", "/api/admin/pricing/schema"], ["POST", "/api/admin/pricing/preview"], ["GET", "/api/admin/pricing/history"], ["POST", `/api/admin/pricing/restore/${id}`], ["POST", "/api/admin/pricing/reset"],
    ["GET", "/api/admin/calibration"], ["PUT", `/api/admin/order-items/${id}/actuals`],
    ["GET", "/api/admin/quotes"], ["GET", "/api/admin/stats"], ["GET", "/api/admin/parts"],
    ["GET", "/api/admin/backup/db"], ["GET", "/api/admin/backup/json"],
    ["GET", `/api/parts/${st.partId}/download`],
    ["GET", `/api/pdf/traveler/${id}`], ["GET", `/api/pdf/packing-list/${id}`], ["GET", `/api/pdf/quote/${st.aliceQuote}`], ["GET", `/api/pdf/rfq-response/${st.aliceRfq}`], ["GET", `/api/pdf/order-confirmation/${id}`], ["GET", `/api/pdf/packing-slip/${id}`], ["GET", `/api/pdf/coc/${id}`], ["GET", "/api/pdf/fai"],
    ["POST", "/api/orders"], ["PUT", `/api/orders/${id}/status`], ["GET", "/api/orders/admin/queue"],
    ["GET", "/api/rfq/admin/list"], ["PUT", `/api/rfq/admin/${st.aliceRfq}`], ["GET", `/api/rfq/admin/${st.aliceRfq}/drawing`],
  ];
  for (const [method, url] of routes) {
    const anon = await s.req({ method, url, ip: ip(), json: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.strictEqual(anon.status, 401, `${method} ${url} without a token → ${anon.status}`);
    const buyer = await s.req({ method, url, ip: ip(), token: alice, json: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.strictEqual(buyer.status, 403, `${method} ${url} as a buyer → ${buyer.status}`);
    for (const r of [anon, buyer]) {
      assert.ok(r.text.length < 200 && r.body && Object.keys(r.body).join() === "error", `${method} ${url} answered with more than an error: ${r.text.slice(0, 120)}`);
      assert.ok(!r.buffer.includes(Buffer.from("SQLite format 3")) && !r.buffer.includes(Buffer.from("%PDF")));
    }
  }
});

test("forged, altered and expired tokens are refused", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { userId: "x", email: s.adminEmail, role: "admin", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const parts = alice.split(".");
  const forged = {
    "alg none": `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`,
    "signed with another secret": jwt.sign(claims, crypto.randomBytes(32).toString("hex")),
    "a buyer's token with the role edited": `${parts[0]}.${b64({ ...JSON.parse(Buffer.from(parts[1], "base64url")), role: "admin" })}.${parts[2]}`,
    "a buyer's token with the signature removed": `${parts[0]}.${parts[1]}.`,
    "empty": "",
    "garbage": "not.a.token",
  };
  for (const [what, token] of Object.entries(forged)) {
    const r = await s.req({ url: "/api/admin/stats", ip: ip(), headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(r.status, 401, `${what} → ${r.status}`);
  }
  assert.strictEqual((await s.get("/api/admin/stats", { ip: ip(), token: admin })).status, 200, "the real admin token works");
});

test("backups, PDFs and downloads: admin only; ids are ids, never paths", async () => {
  const db = await s.get("/api/admin/backup/db", { ip: ip(), token: admin });
  assert.strictEqual(db.status, 200);
  assert.strictEqual(db.buffer.subarray(0, 15).toString("latin1"), "SQLite format 3");
  assert.ok(/^attachment; filename="straightedge-backup-[0-9T-]+\.db"$/.test(db.headers["content-disposition"]), db.headers["content-disposition"]);
  assert.strictEqual(db.headers["cache-control"], "no-store");
  const json = await s.get("/api/admin/backup/json", { ip: ip(), token: admin });
  assert.strictEqual(json.status, 200);
  assert.ok(!/password_hash|passwordHash|\$2[aby]\$/.test(json.text), "the JSON export holds no password hashes");

  const quotePdf = await s.get(`/api/pdf/quote/${st.aliceQuote}`, { ip: ip(), token: admin });
  assert.strictEqual(quotePdf.status, 200);
  assert.strictEqual(quotePdf.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(/^inline; filename="[A-Z]+-[A-Za-z0-9-]+\.pdf"$/.test(quotePdf.headers["content-disposition"]), quotePdf.headers["content-disposition"]);
  assert.ok(/^attachment;/.test((await s.get(`/api/pdf/quote/${st.aliceQuote}?download=1`, { ip: ip(), token: admin })).headers["content-disposition"]));

  const traversal = ["..%2F..%2F..%2Fetc%2Fpasswd", "..%2Fquoting.db", "%2e%2e%2f%2e%2e%2fpackage.json", "....//....//etc/passwd", "quoting.db", `${st.aliceQuote}%00.pdf`, encodeURIComponent("' OR '1'='1"), `${st.aliceQuote}/../../admin/backup/db`];
  for (const bad of traversal) {
    for (const url of [`/api/pdf/quote/${bad}`, `/api/pdf/traveler/${bad}`, `/api/pdf/coc/${bad}`, `/api/parts/${bad}/download`, `/api/rfq/admin/${bad}/drawing`, `/api/orders/${bad}/drawing`, `/api/quote/${bad}`, `/api/quote/${bad}/session`]) {
      const r = await s.get(url, { ip: ip(), token: admin });
      assert.ok([400, 404].includes(r.status), `${url} → ${r.status}`);
      assert.ok(!r.buffer.includes(Buffer.from("root:")) && !r.buffer.includes(Buffer.from("SQLite format 3")) && !r.buffer.includes(Buffer.from('"dependencies"')), `${url} returned a file`);
      assert.ok(!INTERNALS.test(r.text), `${url}: ${r.text.slice(0, 160)}`);
    }
  }
  // static files: nothing outside client/dist, and the prerender folder is not browsable
  for (const url of ["/..%2f..%2fpackage.json", "/assets/..%2f..%2f..%2fserver/index.js", "/%2e%2e/%2e%2e/.env", "/.env", "/.git/config", "/server/index.js", "/package.json", "/data/quoting.db", "/_prerender/index.html"]) {
    const r = await s.get(url, { ip: ip() });
    assert.ok([400, 403, 404].includes(r.status), `${url} → ${r.status}`);
    assert.ok(!/JWT_SECRET|"dependencies"|require\("express"\)|\[core\]/.test(r.text), `${url} leaked a file`);
  }
});

test("one customer's records from another's account: not found", async () => {
  // a quote bound to Alice
  assert.strictEqual((await s.get(`/api/quote/${st.aliceQuote}`, { ip: ip(), token: alice })).status, 200);
  for (const token of [bob, undefined]) {
    assert.strictEqual((await s.get(`/api/quote/${st.aliceQuote}`, { ip: ip(), token })).status, 404);
    assert.strictEqual((await s.get(`/api/quote/${st.aliceQuote}/session`, { ip: ip(), token })).status, 404);
    assert.strictEqual((await s.upload([{ field: "drawing", name: "x.pdf", data: pdf }], { url: `/api/quote/${st.aliceQuote}/drawing`, ip: ip(), token })).status, 404);
    assert.strictEqual((await s.req({ url: `/api/quote/${st.aliceQuote}/drawing`, method: "DELETE", ip: ip(), token })).status, 404);
    assert.strictEqual((await s.get(`/api/rfq/${st.aliceRfq}`, { ip: ip(), token })).status, 404);
    // re-pricing "into" Alice's quote id does not touch her quote
    const hijack = await s.post("/api/quote", { parts: [{ ...st.config, quantity: 999 }], quoteId: st.aliceQuote }, { ip: ip(), token });
    assert.ok(hijack.status === 200 && hijack.body.quoteId !== st.aliceQuote, "a new quote is made instead");
  }
  const hers = (await s.get(`/api/quote/${st.aliceQuote}`, { ip: ip(), token: alice })).body;
  assert.strictEqual(hers.lineItems[0].quantity, 2, "Alice's quote is as she left it");
  assert.strictEqual(hers.drawingFileName, "print.pdf");
  assert.strictEqual(s.files("quote-drawings").length, 1, "no drawing was written for the refused attempts");
  // orders: Bob cannot open, pay, reorder or download from an order that is not his (there are none of Alice's here, so use a made-up id and the list)
  assert.deepStrictEqual((await s.get("/api/orders", { ip: ip(), token: bob })).body, []);
  assert.strictEqual((await s.get("/api/orders", { ip: ip() })).status, 401);
  // profile: the token's own user only, and no field but name, company, phone
  const p = await s.req({ url: "/api/auth/profile", method: "PUT", ip: ip(), token: bob, json: { name: "Bob", role: "admin", email: "alice@example.com", id: "x", passwordHash: "x" } });
  assert.strictEqual(p.status, 200);
  assert.deepStrictEqual([p.body.role, p.body.email], ["customer", "bob@example.com"]);
  assert.strictEqual((await s.get("/api/admin/stats", { ip: ip(), token: bob })).status, 403);
});

test("CORS in production: the dev-server origins are no longer trusted", async () => {
  for (const origin of ["http://localhost:3000", "http://localhost:3001", "https://evil.example", "null"]) {
    const r = await s.get("/api/materials", { ip: ip(), headers: { Origin: origin } });
    assert.strictEqual(r.headers["access-control-allow-origin"], undefined, `${origin} is granted access`);
  }
  assert.strictEqual((await s.get("/api/materials", { ip: ip(), headers: { Origin: s.base } })).headers["access-control-allow-origin"], s.base);
});

test("errors say nothing about the server: no stack, no path, no library, in any answer", async () => {
  const raw = (url, body, type = "application/json", method = "POST") => s.req({ url, method, ip: ip(), headers: { "Content-Type": type }, body: Buffer.from(body) });
  const answers = [
    await raw("/api/quote", "{bad json"),
    await raw("/api/quote", JSON.stringify({ parts: [{ partId: st.partId, materialSlug: st.config.materialSlug, process: {}, quantity: -1 }] })),
    await raw("/api/quote", JSON.stringify({ parts: [{ partId: "x".repeat(100), materialSlug: "nope" }] })),
    await raw("/api/upload", "--x\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.stl\"\r\n\r\n", "multipart/form-data; boundary=x"),
    await raw("/api/upload", "not multipart at all", "multipart/form-data"),
    await raw("/api/rfq", "--x\r\nbroken", "multipart/form-data; boundary=x"),
    await raw("/api/auth/login", JSON.stringify({ email: { $gt: "" }, password: { $gt: "" } })),
    await raw("/api/auth/login", JSON.stringify({ email: "nobody@example.com", password: "wrong" })),
    await raw("/api/orders/checkout-session", JSON.stringify({ quoteId: { a: 1 } })),
    await raw("/api/stripe/webhook", "{}"),
    await raw(`/api/parts/${st.partId}/units`, JSON.stringify({ units: "mm" })),
    await s.get("/api/nope/nothing", { ip: ip() }),
    await s.get("/api/quote/%E0%A4%A", { ip: ip() }),          // malformed percent-encoding
    await s.get(`/api/orders/${"a".repeat(3000)}`, { ip: ip(), token: alice }),
    await s.req({ url: "/api/admin/pricing", method: "PUT", ip: ip(), token: admin, json: { rules: { cncMachineRatePerHour: "DROP TABLE" }, note: "x" } }),
    await s.req({ url: "/api/quote", method: "TRACE", ip: ip() }),
  ];
  for (const r of answers) {
    assert.ok(r.status >= 400 && r.status < 600, `status ${r.status}`);
    assert.ok(!INTERNALS.test(r.text), `(${r.status}) leaks internals: ${r.text.slice(0, 200)}`);
    assert.ok(!r.text.includes(s.tmp) && !r.text.includes(live.ROOT), "a server path in a response");
    if (/json/.test(r.headers["content-type"] || "")) assert.ok(r.body && typeof r.body.error === "string" && r.body.error.length < 400, r.text.slice(0, 200));
    assert.ok(!r.headers["x-powered-by"]);
  }
  assert.strictEqual((await s.get("/api/health")).status, 200, "and the server is still up");
});

test("logs hold no password, login token, signed link or request body", async () => {
  // A firm-quote link is a credential in a URL. Make the error handler log a request to one.
  const linkToken = jwt.sign({ rfqId: st.aliceRfq, v: "x", exp: Math.floor(Date.now() / 1000) + 3600 }, crypto.randomBytes(32).toString("hex"));
  const marker = `SECRETBODY${crypto.randomBytes(8).toString("hex")}`;
  const big = await s.post(`/api/rfq/quote/${linkToken}/accept?utm=${marker}`, { method: "card", pad: marker + "x".repeat(1100 * 1024) }, { ip: ip() });
  assert.strictEqual(big.status, 413);
  await s.post("/api/auth/login", { email: "alice@example.com", password: `Wrong${marker}` }, { ip: ip() });
  await s.req({ url: "/api/quote", method: "POST", ip: ip(), token: alice, headers: { "Content-Type": "application/json" }, body: Buffer.from(`{"note":"${marker}"`) });
  await new Promise((r) => setTimeout(r, 200));
  const log = s.log();
  assert.ok(/POST \/api\/rfq\/quote\/\[token\]\/accept → 413/.test(log), `the request is logged by route: ${log.split("\n").filter((l) => /413/.test(l)).join(" | ")}`);
  assert.ok(!log.includes(linkToken), "the signed link is not in the log");
  assert.ok(!log.includes(marker), "no query string, password or request body in the log");
  for (const token of [admin, alice, bob]) assert.ok(!log.includes(token) && !log.includes(token.split(".")[2]), "no login token in the log");
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(log), "nothing shaped like a JWT in the log");
  assert.ok(!/Bearer\s+\S{20,}|password["']?\s*[:=]\s*["']?\S{4,}/i.test(log));
  const { redactUrl } = require("./redact");
  assert.strictEqual(redactUrl(`/firm-quote/${linkToken}?paid=true`), "/firm-quote/[token]");
  assert.strictEqual(redactUrl("/api/orders/123?token=abc"), "/api/orders/123");
  assert.strictEqual(redactUrl(`/api/x/${"a".repeat(80)}/y`), "/api/x/[redacted]/y");
  assert.strictEqual(redactUrl("/api/rfq/quote/short/accept"), "/api/rfq/quote/[token]/accept");
});

run(async () => { if (s) await s.stop(); });
