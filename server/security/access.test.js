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
let s, admin, pendingAdmin, alice, bob;
const st = {};
let ipN = 0;
const ip = () => `198.51.100.${(++ipN % 250) + 1}`; // spread across addresses: this suite is about access, not rate limits
const INTERNALS = /node_modules|\/server\/|\.js:\d+|\bat [A-Za-z_.<>]+ \(|ENOENT|EACCES|SQLITE|sql\.js|Error:\s|stack/i;

test("setup: an admin, two buyers, a quote each, a drawing and a request", async () => {
  s = await live.start({ env: { RATE_PDF_PER_15MIN: "1000" } });
  // The owner's account, registered and confirmed but not yet enrolled in two-step sign-in.
  pendingAdmin = await s.admin({ ip: ip(), enrol: false });
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
  const rfq = await s.rfq({ contactName: "Alice", email: "alice@example.com", quoteId: st.aliceQuote }, [{ name: "print.pdf", data: pdf }], { ip: ip(), token: alice });
  assert.strictEqual(rfq.status, 201, rfq.text);
  st.aliceRfq = rfq.body.rfqId;
});

const ID = "00000000-0000-4000-8000-000000000000";
const adminRoutes = () => {
  const id = ID;
  return [
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
};
const bodyFor = (method) => (method === "GET" || method === "DELETE" ? undefined : {});

test("an admin who has not switched two-step sign-in on reaches the enrolment endpoints and nothing else", async () => {
  const before = (await s.get("/api/auth/session", { ip: ip(), token: pendingAdmin })).body;
  assert.deepStrictEqual([before.authenticated, before.user.role, before.user.twoFactorEnabled, before.user.twoFactorRequired], [true, "admin", false, true]);
  for (const [method, url] of adminRoutes()) {
    const r = await s.req({ method, url, ip: ip(), token: pendingAdmin, json: bodyFor(method) });
    assert.strictEqual(r.status, 403, `${method} ${url} as an admin without two-step sign-in → ${r.status}`);
    assert.strictEqual(r.body && r.body.code, "two-factor-enrolment-required", `${method} ${url}: ${r.text.slice(0, 120)}`);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ["code", "error"]);
    assert.ok(!r.buffer.includes(Buffer.from("SQLite format 3")) && !r.buffer.includes(Buffer.from("%PDF")));
  }
  // The admin role does nothing for it elsewhere either: another customer's quote and request stay hidden.
  assert.strictEqual((await s.get(`/api/quote/${st.aliceQuote}`, { ip: ip(), token: pendingAdmin })).status, 404);
  assert.strictEqual((await s.get(`/api/rfq/${st.aliceRfq}`, { ip: ip(), token: pendingAdmin })).status, 404);
  // What it can reach: the status of the second step, its setup, and sign-out.
  assert.strictEqual((await s.get("/api/auth/2fa", { ip: ip(), token: pendingAdmin })).status, 200);
  assert.strictEqual((await s.get("/api/auth/2fa", { ip: ip(), token: alice })).status, 403, "a buyer has no enrolment screen");
  const throwaway = (await s.post("/api/auth/login", { email: s.adminEmail, password: s.passwords[s.adminEmail] }, { ip: ip() })).body.token;
  assert.strictEqual((await s.post("/api/auth/logout", {}, { ip: ip(), token: throwaway })).status, 200);
  assert.strictEqual((await s.get("/api/auth/profile", { ip: ip(), token: throwaway })).status, 401, "sign-out ended that session");
  // Enrolling opens the admin routes, on the session issued at enrolment.
  admin = await s.enrol(pendingAdmin, { ip: ip() });
  assert.strictEqual((await s.get("/api/admin/stats", { ip: ip(), token: admin })).status, 200);
  assert.strictEqual((await s.get("/api/admin/stats", { ip: ip(), token: pendingAdmin })).status, 401, "the session from before enrolment is over");
});

test("every admin route: 401 without a session, 403 with a buyer's (bearer token or browser cookie), never a body", async () => {
  const aliceBrowser = await s.browser(alice);
  const aliceNoCsrf = await s.browser(alice, { csrf: false });
  for (const [method, url] of adminRoutes()) {
    const anon = await s.req({ method, url, ip: ip(), json: bodyFor(method) });
    assert.strictEqual(anon.status, 401, `${method} ${url} without a token → ${anon.status}`);
    const buyer = await s.req({ method, url, ip: ip(), token: alice, json: bodyFor(method) });
    assert.strictEqual(buyer.status, 403, `${method} ${url} as a buyer → ${buyer.status}`);
    // The same buyer the way the site's own pages send it: session cookie + CSRF token.
    const cookie = await s.req({ method, url, ip: ip(), headers: aliceBrowser, json: bodyFor(method) });
    assert.strictEqual(cookie.status, 403, `${method} ${url} as a buyer (cookie session) → ${cookie.status}`);
    // The refusal is a sentence and, for a missing session, the code the page reads to show sign-in. Nothing else.
    assert.deepStrictEqual(anon.body, { error: "Authentication required", code: "auth-required" }, `${method} ${url}: ${anon.text.slice(0, 120)}`);
    for (const r of [buyer, cookie]) {
      assert.ok(r.text.length < 200 && r.body && Object.keys(r.body).join() === "error", `${method} ${url} answered with more than an error: ${r.text.slice(0, 120)}`);
    }
    for (const r of [anon, buyer, cookie]) {
      assert.ok(!r.buffer.includes(Buffer.from("SQLite format 3")) && !r.buffer.includes(Buffer.from("%PDF")));
    }
    // A cookie alone (what another site could make the browser send) is refused before the role is even looked at.
    if (method !== "GET") {
      const forged = await s.req({ method, url, ip: ip(), headers: aliceNoCsrf, json: bodyFor(method) });
      assert.strictEqual(forged.status, 403, `${method} ${url} with a cookie and no CSRF token → ${forged.status}`);
      assert.strictEqual(forged.body.code, "csrf");
    }
  }
  // The admin's own cookie without the CSRF token changes nothing either.
  const adminNoCsrf = await s.browser(admin, { csrf: false });
  const before = (await s.get("/api/admin/pricing", { ip: ip(), token: admin })).text;
  const put = await s.req({ method: "PUT", url: "/api/admin/pricing", ip: ip(), headers: adminNoCsrf, json: { rules: { cncMachineRatePerHour: 1 }, note: "forged" } });
  assert.deepStrictEqual([put.status, put.body.code], [403, "csrf"]);
  assert.strictEqual((await s.get("/api/admin/pricing", { ip: ip(), token: admin })).text, before, "pricing is unchanged");
  assert.strictEqual((await s.req({ url: "/api/admin/stats", ip: ip(), headers: await s.browser(admin) })).status, 200, "the admin's cookie session works for the admin");
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
    // (Review fix F5: Alice's part is hers too, so the attempt is made with a part of the caller's own;
    // with her part it is refused outright, as for a part that does not exist.)
    const withHers = await s.post("/api/quote", { parts: [{ ...st.config, quantity: 999 }], quoteId: st.aliceQuote }, { ip: ip(), token });
    assert.deepStrictEqual([withHers.status, withHers.body.code, withHers.body.quoteId], [400, "part-not-found", undefined]);
    const own = (await s.upload([{ name: "cube.stl", data: cube }], { ip: ip(), token })).body.parts[0].partId;
    const hijack = await s.post("/api/quote", { parts: [{ ...st.config, partId: own, quantity: 999 }], quoteId: st.aliceQuote }, { ip: ip(), token });
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
  // Email is not configured on this server: each message is logged as its template and a count, never
  // the customer's address, the subject or the body (cross-branch finding M1).
  assert.ok(/\[mailer\] \(not configured, not sent\) template verifyEmail, 1 recipient/.test(log), "the unsent confirmation is logged by template name");
  assert.ok(/template rfqReceivedShop, 1 recipient/.test(log));
  for (const address of ["alice@example.com", "bob@example.com"]) assert.ok(!log.includes(address), `a customer's address (${address}) is in the log`);
  assert.ok(!/To:\s*\S+@|#token=|Confirm your email|reference [0-9A-F]{8}/i.test(log), "no recipient line, link, subject or reference from a message in the log");
  const { redactUrl } = require("./redact");
  assert.strictEqual(redactUrl(`/firm-quote/${linkToken}?paid=true`), "/firm-quote/[token]");
  assert.strictEqual(redactUrl("/api/orders/123?token=abc"), "/api/orders/123");
  assert.strictEqual(redactUrl(`/api/x/${"a".repeat(80)}/y`), "/api/x/[redacted]/y");
  assert.strictEqual(redactUrl("/api/rfq/quote/short/accept"), "/api/rfq/quote/[token]/accept");
});

run(async () => { if (s) await s.stop(); });
