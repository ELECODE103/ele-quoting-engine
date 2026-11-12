/**
 * The findings each hardening branch left for the other (2026-11-11), closed
 * on the merged code, one test per finding:
 *
 *   A2  control characters in an email address (register, sign-in, reset, both request forms)
 *   A4  every signed value is verified with its algorithm named
 *   A5  sign-in, registration and form limits use the shared client key (IPv6 by /64)
 *   A7  no fixed development secret
 *   W1  an unsigned Stripe webhook is refused unless the explicit test switch is set
 *   F1  an admin edit to a finish's price is saved (and a price under a name we do not store is refused)
 *       text is stored as typed and escaped where it is shown (emails, PDFs); the client has no raw-HTML sink
 *
 * CORS and the cross-site attempt, the brand pages and the urlencoded parser are in
 * headers.test.js (they need the whole server); attachments are in uploads.test.js;
 * the mailer's log lines are in emails/templates.test.js and access.test.js.
 * Run: node server/security/crossBranch.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { start, runner } = require("../testSupport/harness");
const { pdfText } = require("../testSupport/pdfText");

const { test, run } = runner("Cross-branch findings");
const root = path.join(__dirname, "..", "..");
let h, admin, buyer;
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };

// Addresses that must never be taken: the first is the attack the server branch found (SQLite text ends at a NUL).
const BAD_ADDRESSES = [
  ["a NUL", "owner@shop.test\u0000.evil.example"],
  ["a NUL at the end", "dana@buyer.test\u0000"],
  ["a line feed inside", "dana@buyer.test\nbcc:x@evil.example"],
  ["a carriage return", "dana\r@buyer.test"],
  ["a tab inside", "da\tna@buyer.test"],
  ["an escape character", "dana\u001b[31m@buyer.test"],
  ["DEL", "dana\u007f@buyer.test"],
  ["a C1 control", "dana\u0085@buyer.test"],
  ["a zero-width space", "dana​@buyer.test"],
  ["a right-to-left override", "dana‮@buyer.test"],
  ["a byte-order mark", "﻿dana@buyer.test"],
  ["a line separator", "dana@buyer.test "],
];

test("A2: isValidEmail refuses control and invisible characters, and still takes ordinary addresses", async () => {
  h = await start({ mailer: "configured" });
  const { isValidEmail } = require("../middleware/validate");
  for (const [what, address] of BAD_ADDRESSES) assert.strictEqual(isValidEmail(address), false, what);
  for (const ok of ["dana@buyer.test", "d.o'brien+quotes@sub.example.co.uk", "josé@example.com", "user@münchen.example", "a@b.co"]) assert.strictEqual(isValidEmail(ok), true, ok);
  for (const no of ["", "no-at-sign", "two@@signs.test", "space in@side.test", "a@b", `${"x".repeat(250)}@b.co`, null, 42, ["a@b.co"], { email: "a@b.co" }]) assert.strictEqual(isValidEmail(no), false, String(no));
});

test("A2: registration, sign-in, password reset and both request forms refuse such an address before anything is stored or sent", async () => {
  buyer = await h.register("dana@buyer.test", "Dana Buyer");
  admin = await h.admin();
  const { usersDB, rfqsDB } = h.models;
  const users = usersDB.getAll().length;
  const rfqs = rfqsDB.getAll().length;
  h.sent.length = 0;
  for (const [what, address] of BAD_ADDRESSES) {
    const reg = await h.raw("POST", "/api/auth/register", { json: { email: address, password: h.password, name: "X" }, headers: { "X-Form-Token": h.formToken("register"), "X-Turnstile-Token": "pass-register" } });
    assert.strictEqual(reg.status, 400, `register with ${what} → ${reg.status} ${reg.text.slice(0, 80)}`);
    const login = await h.raw("POST", "/api/auth/login", { json: { email: address, password: h.password } });
    assert.strictEqual(login.status, 400, `sign-in with ${what} → ${login.status}`);
    assert.strictEqual(login.body.token, undefined);
    const reset = await h.raw("POST", "/api/auth/password-reset/request", { json: { email: address }, headers: { "X-Form-Token": h.formToken("password-reset"), "X-Turnstile-Token": "pass-reset" } });
    assert.strictEqual(reset.status, 400, `reset with ${what} → ${reset.status}`);
    for (const requestType of ["", "part"]) {
      const rfq = await h.form("/api/rfq", { contactName: "X", email: address, requestType, notes: `bad address ${what} ${requestType}` });
      assert.strictEqual(rfq.status, 400, `${requestType || "firm-quote"} request with ${what} → ${rfq.status} ${rfq.text.slice(0, 80)}`);
    }
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(usersDB.getAll().length, users, "no account was created");
  assert.strictEqual(rfqsDB.getAll().length, rfqs, "no request was stored");
  assert.deepStrictEqual(h.sent, [], "no email was sent to anyone");
  // The sign-in refusal is about the address's shape, not about who has an account: the real address still signs in,
  // with ordinary spaces around it dropped as before.
  assert.strictEqual((await h.raw("POST", "/api/auth/login", { json: { email: "  Dana@Buyer.test ", password: h.password } })).status, 200);
  // The owner's address with a NUL and a suffix never reaches the owner's account, on any route.
  const owner = usersDB.getAll().find((u) => u.email === "owner@shop.test");
  assert.strictEqual(usersDB.getAll().filter((u) => u.email.startsWith("owner@shop.test")).length, 1);
  assert.strictEqual(usersDB.getById(owner.id).role, "admin");
});

test("A4: every jwt.verify names its algorithm, and a token signed with the right key under another algorithm is refused", async () => {
  // Source: no verify call without `algorithms`, no sign call without `algorithm` / `expiresIn`-only defaults left unpinned.
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "fixtures") walk(p); continue; }
      if (!e.name.endsWith(".js") || e.name.endsWith(".test.js")) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/jwt\.verify\(([^;]*);/g)) if (!/algorithms:\s*\[/.test(m[1])) offenders.push(`${path.relative(root, p)}: jwt.verify without algorithms`);
      for (const m of src.matchAll(/jwt\.sign\(([\s\S]*?)\);/g)) if (!/algorithm:\s*/.test(m[1])) offenders.push(`${path.relative(root, p)}: jwt.sign without algorithm`);
      if (/jwt\.decode\(/.test(src)) offenders.push(`${path.relative(root, p)}: jwt.decode (reads a token without checking it)`);
    }
  })(path.join(root, "server"));
  assert.deepStrictEqual(offenders, []);

  const keys = require("./keys");
  const tokens = require("./tokens");
  const rfqToken = require("../services/rfqToken");
  const { usersDB, rfqsDB } = h.models;
  const dana = usersDB.getAll().find((u) => u.email === "dana@buyer.test");
  const now = Math.floor(Date.now() / 1000);

  // Sessions: the real key, HS384 / HS512 instead of HS256.
  for (const algorithm of ["HS384", "HS512"]) {
    const t = jwt.sign({ userId: dana.id, email: dana.email, role: "customer", tv: Number(dana.tokenVersion) || 0, jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: 3600, algorithm });
    assert.strictEqual((await h.get("/api/auth/profile", t)).status, 401, `a ${algorithm} session token`);
  }
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ userId: dana.id, tv: 0, jti: "x", exp: now + 600 })).toString("base64url")}.`;
  assert.strictEqual((await h.get("/api/auth/profile", unsigned)).status, 401, "alg none");
  assert.strictEqual((await h.get("/api/auth/profile", buyer)).status, 200, "the real HS256 session works");

  // Email-confirmation, reset, verified-human and form tokens: each kind's own key, another algorithm.
  for (const kind of ["email-verify", "password-reset", "human", "form"]) {
    const good = tokens.sign(kind, { uid: dana.id });
    assert.strictEqual(tokens.verify(kind, good).ok, true, kind);
    for (const algorithm of ["HS384", "HS512"]) {
      const other = jwt.sign({ uid: dana.id, jti: crypto.randomUUID(), iat: now, exp: now + 600 }, keys.derive(`token:${kind}:v1`), { audience: kind, algorithm });
      assert.deepStrictEqual(tokens.verify(kind, other), { ok: false, reason: "invalid" }, `${kind} signed ${algorithm}`);
    }
  }
  const humanHs512 = jwt.sign({ jti: crypto.randomUUID(), iat: now, exp: now + 600 }, keys.derive("token:human:v1"), { audience: "human", algorithm: "HS512" });
  const cube = fs.readFileSync(path.join(root, "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const fd = new FormData(); fd.append("files", new Blob([cube]), "cube.stl");
  assert.strictEqual((await h.raw("POST", "/api/upload", { body: fd, headers: { "X-Human-Token": humanHs512 } })).status, 403, "an HS512 verified-human token does not open the upload");

  // Firm-quote links.
  const r = await h.form("/api/rfq", { contactName: "Dana Buyer", email: "dana@buyer.test", notes: "algorithms" });
  h.sent.length = 0;
  assert.strictEqual((await h.put(`/api/rfq/admin/${r.body.rfqId}`, { status: "quoted", quotedTotal: 500, quotedLeadDays: 5 }, admin)).status, 200);
  const rfq = rfqsDB.getById(r.body.rfqId);
  const real = rfqToken.sign(rfq);
  assert.strictEqual(JSON.parse(Buffer.from(real.split(".")[0], "base64url")).alg, "HS256");
  assert.strictEqual((await h.get(`/api/rfq/quote/${real}`)).status, 200);
  const linkKey = crypto.createHmac("sha256", process.env.JWT_SECRET).update("rfq-quote-link-v1").digest();
  for (const algorithm of ["HS384", "HS512"]) {
    const forged = jwt.sign({ rfqId: rfq.id, v: rfq.quoteSentAt, exp: now + 3600 }, linkKey, { audience: "rfq-quote", algorithm });
    assert.strictEqual(rfqToken.verify(forged), null, `a ${algorithm} quote link`);
    assert.strictEqual((await h.get(`/api/rfq/quote/${forged}`)).status, 404);
    assert.strictEqual((await h.post(`/api/rfq/quote/${forged}/accept`, { method: "po", poNumber: "PO-1", ...SHIP })).status, 404);
  }
  assert.strictEqual(rfqsDB.getById(rfq.id).status, "quoted", "nothing was accepted");
});

test("A7: with no JWT_SECRET the key is random per process, not a string in the source", async () => {
  const src = ["server/security/keys.js", "server/services/rfqToken.js", "server/routes/auth.js", "server/security/session.js"].map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  assert.ok(!/dev-secret|DO-NOT-USE/i.test(src), "the fixed development secret is gone");
  const { execFileSync } = require("child_process");
  const probe = `delete process.env.JWT_SECRET; const k = require(${JSON.stringify(path.join(root, "server/security/keys.js"))}); const a = k.baseSecret(); console.log(JSON.stringify([a === k.baseSecret(), a.length]) + "|" + require("crypto").createHash("sha256").update(a).digest("hex"));`;
  const outs = [0, 1].map(() => execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim());
  for (const out of outs) assert.strictEqual(out.split("|")[0], "[true,96]", "stable within a process, 48 random bytes");
  assert.notStrictEqual(outs[0].split("|")[1], outs[1].split("|")[1], "different in every process");
});

test("A5: sign-in, registration and form limits count an IPv6 /64 as one client (and an IPv4-mapped address as its IPv4)", async () => {
  const loginGuard = require("./loginGuard");
  const botGuard = require("./botGuard");
  loginGuard.resetForTests(); botGuard.resetForTests();
  const v6 = (n) => `2001:db8:77:1:${n.toString(16)}::${((n * 7919) % 0xffff).toString(16)}`; // every address different, same /64
  const login = (email, password, ip, headers = {}) => h.raw("POST", "/api/auth/login", { json: { email, password }, ip, headers });

  // Sign-in: three failures from three addresses in one /64 and the fourth, from a fourth address, must pass the bot check.
  for (let i = 1; i <= 3; i++) assert.strictEqual((await login(`ghost${i}@nowhere.test`, "Wrong-password-1", v6(i))).status, 401);
  const fourth = await login("ghost4@nowhere.test", "Wrong-password-1", v6(4));
  assert.deepStrictEqual([fourth.status, fourth.body.code], [403, "human-check-required"], "the /64 is challenged as one client");
  const elsewhere = await login("ghost5@nowhere.test", "Wrong-password-1", "2001:db8:77:2::1");
  assert.strictEqual(elsewhere.status, 401, "the next /64 is another client");
  // The hard stop: twenty failures across the /64, then even the right password is refused from any address in it.
  for (let i = 5; i <= 21; i++) await login(`ghost${i}@nowhere.test`, "Wrong-password-1", v6(i), { "X-Turnstile-Token": `pass-${i}` });
  const blocked = await login("dana@buyer.test", h.password, v6(99), { "X-Turnstile-Token": "pass-99" });
  assert.deepStrictEqual([blocked.status, blocked.body.code], [429, "rate-limited"]);
  assert.strictEqual((await login("dana@buyer.test", h.password, "2001:db8:77:3::1")).status, 200, "another network signs in normally");
  loginGuard.resetForTests();
  // An IPv4 client seen through a dual-stack socket is the same client.
  for (let i = 1; i <= 3; i++) await login(`mapped${i}@nowhere.test`, "Wrong-password-1", i % 2 ? "203.0.113.77" : "::ffff:203.0.113.77");
  assert.strictEqual((await login("mapped4@nowhere.test", "Wrong-password-1", "::ffff:203.0.113.77")).body.code, "human-check-required");
  loginGuard.resetForTests();

  // Request form: 10 an hour per client. Ten addresses in one /64, then an eleventh.
  h.limits = true;
  try {
    for (let i = 1; i <= 10; i++) {
      h.ip = v6(100 + i);
      const r = await h.form("/api/rfq", { contactName: "V Six", email: `v6-${i}@buyer.test`, notes: `ipv6 ${i}` });
      assert.strictEqual(r.status, 201, `request ${i}: ${r.text.slice(0, 100)}`);
    }
    h.ip = v6(111);
    const eleventh = await h.form("/api/rfq", { contactName: "V Six", email: "v6-11@buyer.test", notes: "ipv6 11" });
    assert.deepStrictEqual([eleventh.status, eleventh.body.code], [429, "rate-limited"]);
    h.ip = "2001:db8:78:1::1";
    assert.strictEqual((await h.form("/api/rfq", { contactName: "V Six", email: "v6-12@buyer.test", notes: "another network" })).status, 201);
  } finally { h.limits = false; h.ip = ""; botGuard.resetForTests(); }

  // Registration: 10 an hour per client (express-rate-limit, keyed the same way).
  const register = (i, ip) => h.raw("POST", "/api/auth/register", { ip, json: { email: `v6reg${i}@buyer.test`, password: h.password, name: "V Six" }, headers: { "X-Form-Token": h.formToken("register"), "X-Turnstile-Token": "pass-register" } });
  for (let i = 1; i <= 10; i++) assert.strictEqual((await register(i, v6(200 + i))).status, 201, `registration ${i}`);
  const over = await register(11, v6(211));
  assert.deepStrictEqual([over.status, over.body.code], [429, "rate-limited"]);
  assert.strictEqual((await register(12, "2001:db8:79:1::1")).status, 201, "another network registers normally");
  botGuard.resetForTests();
  // No limiter reads the raw address any more: the only uses of req.ip are the shared key and Turnstile's remoteip.
  const users = [];
  for (const f of ["server/routes/auth.js", "server/routes/rfq.js", "server/routes/api.js", "server/routes/orders.js", "server/security/botGuard.js", "server/security/loginGuard.js", "server/security/rateLimits.js", "server/security/uploadGuards.js", "server/index.js"]) {
    if (/\breq\.ip\b/.test(fs.readFileSync(path.join(root, f), "utf8"))) users.push(f);
  }
  assert.deepStrictEqual(users, []);
  assert.strictEqual(fs.readFileSync(path.join(root, "server/routes/auth.js"), "utf8").match(/keyGenerator: clientKey/g).length, 4, "the four express-rate-limit limiters in auth.js (the admin setup route's is the fourth) use the shared key");
});

test("W1: an unsigned Stripe webhook is refused unless the test switch is set — and in production even then", async () => {
  const { ordersDB } = h.models;
  const partId = await h.uploadCube();
  const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)] }, buyer);
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
  assert.strictEqual(c.status, 200, c.text);
  const order = ordersDB.getById(c.body.orderId);
  const event = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: order.stripeSessionId, payment_status: "paid", amount_total: Math.round(order.total * 100), amount_subtotal: Math.round(order.total * 100), metadata: { orderId: order.id } } } });
  const post = () => fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: event });
  const keep = { hooks: process.env.SE_TEST_HOOKS, env: process.env.NODE_ENV };
  const quiet = console.error; console.error = () => {};
  const quietWarn = console.warn; console.warn = () => {};
  try {
    // Not production, no switch: this used to be accepted ("dev mode").
    for (const env of ["test", "development", "staging", undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      delete process.env.SE_TEST_HOOKS;
      const r = await post();
      assert.strictEqual(r.status, 503, `NODE_ENV=${env}, no switch → ${r.status}`);
      assert.strictEqual(ordersDB.getById(order.id).status, "pending_payment");
    }
    // The switch, but production: still refused.
    process.env.NODE_ENV = "production"; process.env.SE_TEST_HOOKS = "1";
    assert.strictEqual((await post()).status, 503);
    assert.strictEqual(ordersDB.getById(order.id).status, "pending_payment");
    // Only the exact value counts.
    process.env.NODE_ENV = "test"; process.env.SE_TEST_HOOKS = "yes";
    assert.strictEqual((await post()).status, 503);
    // The switch, outside production: the suites' path.
    process.env.SE_TEST_HOOKS = "1";
    assert.strictEqual((await post()).status, 200);
    assert.strictEqual(ordersDB.getById(order.id).status, "paid");
  } finally {
    console.error = quiet; console.warn = quietWarn;
    if (keep.hooks === undefined) delete process.env.SE_TEST_HOOKS; else process.env.SE_TEST_HOOKS = keep.hooks;
    if (keep.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keep.env;
  }
});

test("F1: the admin's edit to a finish price is saved and prices the next quote; a price under a name we do not store is refused", async () => {
  const { finishesDB } = h.models;
  const { DEFAULT_FINISHES } = require("../config/defaults");
  const fin = finishesDB.getAll().find((f) => f.slug === "cnc-deburr");
  const seeded = DEFAULT_FINISHES.find((f) => f.slug === "cnc-deburr");
  assert.deepStrictEqual([fin.pricePerPart, fin.pricePerSqIn], [seeded.pricePerPart, seeded.pricePerSqIn], "the database starts at the seeded price");
  const partId = await h.uploadCube();
  const config = { ...h.cncConfig(partId, 1), finishSlug: "cnc-deburr" };
  const price = async () => { const r = await h.post("/api/quote", { parts: [config] }, buyer); assert.strictEqual(r.status, 200, r.text); return r.body; };
  const before = await price();

  // What the admin panel sends when "Per Part" is edited (client/src/pages/AdminPanel.jsx).
  const put = await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: seeded.pricePerPart + 40 }, admin);
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(put.body.pricePerPart, seeded.pricePerPart + 40, "the answer carries the new price");
  assert.strictEqual(finishesDB.getById(fin.id).pricePerPart, seeded.pricePerPart + 40, "and it is in the database");
  assert.strictEqual((await h.get("/api/admin/finishes", admin)).body.find((f) => f.id === fin.id).pricePerPart, seeded.pricePerPart + 40, "and the panel reads it back");
  const after = await price();
  assert.ok(after.orderTotal > before.orderTotal, `the next quote uses it (${before.orderTotal} → ${after.orderTotal})`);
  // The other price fields the models read are editable too.
  const sq = await h.put(`/api/admin/finishes/${fin.id}`, { pricePerSqIn: 0.5, costPerDm2: 0, minCost: 0 }, admin);
  assert.deepStrictEqual([sq.status, sq.body.pricePerSqIn], [200, 0.5]);
  // Bad values are refused, not stored as NULL (an emptied number field arrives as null).
  for (const bad of [null, "abc", -1, 1e9, [], {}, ""]) {
    const r = await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: bad }, admin);
    assert.strictEqual(r.status, 400, `pricePerPart ${JSON.stringify(bad)} → ${r.status}`);
  }
  // The names the server used to list. Silently dropping them is what hid the bug: now they are an error.
  for (const legacy of ["costFlat", "costPerSqMm"]) {
    const r = await h.put(`/api/admin/finishes/${fin.id}`, { [legacy]: 3 }, admin);
    assert.strictEqual(r.status, 400, legacy);
    assert.ok(/not a field of a finish/.test(r.body.error));
  }
  assert.strictEqual(finishesDB.getById(fin.id).pricePerPart, seeded.pricePerPart + 40, "unchanged by the refused edits");
  // Still admin only, still only the listed fields.
  assert.strictEqual((await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: 0 }, buyer)).status, 403);
  assert.strictEqual((await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: 0 })).status, 401);
  const rogue = await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: seeded.pricePerPart, pricePerSqIn: seeded.pricePerSqIn, id: "other", createdAt: "1999", rogue: 1 }, admin);
  assert.deepStrictEqual([rogue.status, rogue.body.id, rogue.body.createdAt], [200, fin.id, fin.createdAt]);
  // Back at the seeded price, the quote is back at its first total: nothing seeded was changed by this work.
  assert.strictEqual((await price()).orderTotal, before.orderTotal);
  for (const f of finishesDB.getAll()) {
    const d = DEFAULT_FINISHES.find((x) => x.slug === f.slug);
    assert.deepStrictEqual([f.slug, f.pricePerPart, f.pricePerSqIn], [d.slug, d.pricePerPart, d.pricePerSqIn], `${f.slug} is at its seeded price`);
  }
});

// ─── Text is stored as typed, and shown as text ──────────────────────────────
const ORDINARY = ["tone = 5", "5 < 10 > 3", "online = yes; one=1", "Use <= 0.005\" on the bore & keep A>B", "javascript: is a language", "R&D <dept>"];
const HOSTILE = '<img src=x onerror=alert(1)><script>alert(document.domain)</script><a href="javascript:alert(2)" onclick=alert(3)>x</a>';
const NOTE = `${ORDINARY.join(" | ")} | ${HOSTILE}`;

test("typed text round-trips unchanged: ordinary notes are no longer mangled and markup is kept as the characters it is", async () => {
  const { sanitizeString } = require("../middleware/validate");
  for (const text of [...ORDINARY, HOSTILE, NOTE]) assert.strictEqual(sanitizeString(text, 5000), text, text);
  assert.strictEqual(sanitizeString("  two\nlines\tand a tab  "), "two\nlines\tand a tab", "line breaks and tabs stay; the ends are trimmed");
  assert.strictEqual(sanitizeString("a\u0000b\u0007c\u001bd\u007fe\u0085f"), "abcdef", "control characters go");
  assert.strictEqual(sanitizeString("safe‮gnp.exe"), "safegnp.exe", "bidirectional overrides go");
  assert.strictEqual(sanitizeString("x".repeat(600)).length, 500);
  for (const notText of [null, undefined, 5, {}, ["a"]]) assert.strictEqual(sanitizeString(notText), "");

  const { quotesDB, rfqsDB, ordersDB, usersDB } = h.models;
  const partId = await h.uploadCube();
  // Quote notes (the quote tool), then the order made from it.
  const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], notes: NOTE }, buyer);
  assert.strictEqual(q.body.notes, NOTE);
  assert.strictEqual(quotesDB.getById(q.body.quoteId).notes, NOTE);
  assert.strictEqual((await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body.notes, NOTE);
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, shippingName: `Dana <b>Buyer</b> & Co`, notes: NOTE }, buyer);
  assert.strictEqual(c.status, 200, c.text);
  this.orderId = c.body.orderId;
  const order = ordersDB.getById(c.body.orderId);
  assert.strictEqual(order.shippingName, "Dana <b>Buyer</b> & Co");
  assert.strictEqual(order.customerNotes, NOTE, "the buyer's note rides to the order as typed");
  // Request form fields.
  const r = await h.form("/api/rfq", { contactName: "Dana <Buyer>", email: "dana@buyer.test", company: 'Acme "R&D" <dept>', phone: "815-555-0100", notes: NOTE, finishNotes: "Ra < 32 & deburr", tolerance: "±0.005 > spec", quantities: "5 < 10 > 3" });
  assert.strictEqual(r.status, 201, r.text);
  const rfq = rfqsDB.getById(r.body.rfqId);
  assert.deepStrictEqual([rfq.contactName, rfq.company, rfq.notes, rfq.finishNotes, rfq.tolerance, rfq.quantities], ["Dana <Buyer>", 'Acme "R&D" <dept>', NOTE, "Ra < 32 & deburr", "±0.005 > spec", "5 < 10 > 3"]);
  this.rfqId = rfq.id;
  // Admin-typed text: the firm quote's note, the order's internal note.
  h.sent.length = 0;
  const quoted = await h.put(`/api/rfq/admin/${rfq.id}`, { status: "quoted", quotedTotal: 900, quotedLeadDays: 7, quoteNote: NOTE }, admin);
  assert.strictEqual(quoted.body.quoteNote, NOTE);
  const st = await h.put(`/api/orders/${order.id}/status`, { status: "in_production", notes: NOTE }, admin);
  assert.strictEqual(st.status, 200, st.text);
  assert.strictEqual(ordersDB.getById(order.id).notes, NOTE);
  // Profile.
  const p = await h.put("/api/auth/profile", { name: "Dana <i>B</i>", company: "5 < 10 > 3 LLC" }, buyer);
  assert.deepStrictEqual([p.body.name, p.body.company], ["Dana <i>B</i>", "5 < 10 > 3 LLC"]);
  assert.strictEqual(usersDB.getAll().find((u) => u.email === "dana@buyer.test").name, "Dana <i>B</i>");
});

test("…and it cannot inject into an email: every value is escaped in the HTML part and plain in the text part; no subject carries it", async () => {
  const { rfqsDB } = h.models;
  const templates = require("../emails/templates");
  const rfq = rfqsDB.getById(this.rfqId);
  // The messages the routes really sent for the request above (shop notice and firm quote), plus every
  // template fed the same row directly.
  const sentNow = h.sent.filter((m) => m.html);
  assert.ok(sentNow.some((m) => m.template === "rfqQuoted"), "the firm-quote email was captured");
  const built = [
    templates.rfqReceivedShop({ rfq, adminUrl: "https://shop.test/admin" }),
    templates.rfqReceivedShop({ rfq, adminUrl: "https://shop.test/admin", unverified: true, buyerEmailed: false }),
    templates.rfqReceivedBuyer({ rfq }),
    templates.rfqQuoted({ rfq, acceptUrl: "https://shop.test/firm-quote/token", shipBy: "2026-12-02" }),
  ];
  const order = h.models.ordersDB.getById(this.orderId);
  const items = h.models.orderItemsDB.query((i) => i.orderId === order.id);
  built.push(templates.orderConfirmation({ order, items, orderUrl: "https://shop.test/orders/x" }), templates.newOrderShop({ order, items, adminUrl: "https://shop.test/admin" }), templates.orderShipped({ order: { ...order, carrier: "ups", trackingNumber: '1Z"><script>alert(1)</script>' }, items, orderUrl: "https://shop.test/orders/x" }));
  let sawNote = 0;
  for (const m of [...sentNow, ...built]) {
    const label = m.template;
    // No element or attribute can have come from typed text: every tag in the HTML is one of the layout's own.
    const tags = [...m.html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((x) => x[1].toLowerCase());
    for (const t of tags) assert.ok(["html", "head", "meta", "title", "body", "div", "span", "table", "tr", "td", "th", "tbody", "thead", "p", "a", "b", "strong", "br", "h1", "h2", "h3", "ul", "li", "hr", "em", "small"].includes(t), `${label}: unexpected <${t}> in the HTML`);
    assert.ok(!/<script|<img|onerror\s*=\s*alert|onclick\s*=\s*alert/i.test(m.html.replace(/&lt;[\s\S]*?&gt;/g, "")), `${label}: live markup from a note`);
    for (const href of m.html.matchAll(/href="([^"]*)"/g)) assert.ok(/^(https?:\/\/|mailto:|tel:|#)/.test(href[1]), `${label}: href ${href[1].slice(0, 40)}`);
    assert.ok(!/[\r\n]/.test(m.subject) && !/[<>]|alert|tone = 5/.test(m.subject), `${label}: typed text in the subject: ${m.subject}`);
    if (m.html.includes("tone = 5")) {
      sawNote++;
      assert.ok(m.html.includes("5 &lt; 10 &gt; 3"), `${label}: the note is shown, escaped`);
      assert.ok(m.html.includes("&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;"), `${label}: markup shown as text`);
      assert.ok(m.text.includes(NOTE) || m.text.includes("5 < 10 > 3"), `${label}: the text part carries the note as typed`);
    }
  }
  assert.ok(sawNote >= 4, `the note was actually in ${sawNote} of the messages checked`);
});

test("…nor into a PDF: the documents draw the text as text, with no script, action or link made from it", async () => {
  const docs = [
    ["firm quote", `/api/pdf/rfq-response/${this.rfqId}`, ["5 < 10 > 3", "tone = 5"]],
    ["order confirmation", `/api/pdf/order-confirmation/${this.orderId}`, ["5 < 10 > 3", "tone = 5"]],
    ["job traveler", `/api/pdf/traveler/${this.orderId}`, null],
    ["packing slip", `/api/pdf/packing-slip/${this.orderId}`, null],
  ];
  for (const [name, url, expect] of docs) {
    const res = await fetch(`${h.base}${url}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.strictEqual(res.status, 200, `${name}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 5).toString("latin1"), "%PDF-", name);
    const raw = buf.toString("latin1");
    // Nothing in the file can run or navigate: no JavaScript, no automatic or launch actions, no link annotation built from a note.
    for (const key of ["/JavaScript", "/JS ", "/JS(", "/OpenAction", "/AA ", "/AA<", "/Launch", "/EmbeddedFile", "/RichMedia", "/SubmitForm", "/ImportData", "/GoToR"]) assert.ok(!raw.includes(key), `${name}: contains ${key}`);
    for (const uri of raw.matchAll(/\/URI\s*\(([^)]*)\)/g)) assert.ok(/^(https?:\/\/(shop\.test|straightedgemfg\.com)|mailto:|tel:)/.test(uri[1]), `${name}: link to ${uri[1].slice(0, 60)}`);
    const text = pdfText(buf).replace(/\s+/g, " ");
    if (expect) {
      for (const piece of expect) assert.ok(text.includes(piece), `${name}: "${piece}" is printed as typed (got: ${text.slice(0, 300)})`);
      assert.ok(text.includes("<img src=x onerror=alert(1)>") || text.includes("<img src=x"), `${name}: markup is printed as characters`);
    }
  }
});

test("…nor into the admin pages: the client renders strings through React and has no raw-HTML sink", async () => {
  const sinks = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(jsx?|mjs)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      // The one innerHTML in the client empties the 3D viewer's container (assigning the empty string).
      const stripped = src.replace(/container\.innerHTML = '';/g, "");
      for (const sink of ["dangerouslySetInnerHTML", ".innerHTML", ".outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "srcdoc", "new Function(", "eval("]) {
        if (stripped.includes(sink)) sinks.push(`${path.relative(root, p)}: ${sink}`);
      }
    }
  })(path.join(root, "client", "src"));
  assert.deepStrictEqual(sinks, []);
  // (The browser run, scripts/e2e/hardening-accounts.mjs, opens the admin queue on a request carrying this note
  // and checks that nothing ran and the note reads as typed.)
});

test("leftovers: no urlencoded parser, no reflected CORS origin, the stale 'ephemeral storage' comment is gone", async () => {
  const index = fs.readFileSync(path.join(root, "server/index.js"), "utf8");
  assert.ok(!/express\.urlencoded\(/.test(index), "index.js mounts no urlencoded parser");
  assert.ok(!/origin:\s*true/.test(index + fs.readFileSync(path.join(root, "server/security/cors.js"), "utf8")), "no environment reflects an arbitrary origin");
  const api = fs.readFileSync(path.join(root, "server/routes/api.js"), "utf8");
  assert.ok(!/ephemeral|resets on every deploy/i.test(api));
  assert.ok(/volume mounted at \/app\/data/.test(api));
  const cors = require("./cors");
  const req = (host, protocol = "https") => ({ protocol, get: () => host });
  const keep = { env: process.env.NODE_ENV, front: process.env.FRONTEND_URL };
  try {
    process.env.NODE_ENV = "production"; process.env.FRONTEND_URL = "https://straightedgemfg.com/";
    assert.strictEqual(cors.originAllowed(req("app.example.test"), "https://app.example.test"), true, "the site itself");
    assert.strictEqual(cors.originAllowed(req("app.example.test"), "http://app.example.test"), false, "another scheme");
    assert.strictEqual(cors.originAllowed(req("app.example.test"), "https://app.example.test:8443"), false, "another port");
    assert.strictEqual(cors.originAllowed(req("app.example.test"), "https://straightedgemfg.com"), true, "FRONTEND_URL");
    for (const o of ["http://localhost:3001", "http://localhost:3000", "https://evil.example", "null", "https://straightedgemfg.com.evil.example", "not a url"]) assert.strictEqual(cors.originAllowed(req("app.example.test"), o), false, o);
    process.env.NODE_ENV = "development";
    assert.strictEqual(cors.originAllowed(req("localhost:3000", "http"), "http://localhost:3001"), true, "the dev server, in development");
    assert.strictEqual(cors.originAllowed(req("localhost:3000", "http"), "https://evil.example"), false, "and still nobody else");
  } finally {
    if (keep.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keep.env;
    if (keep.front === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = keep.front;
  }
});

run(async () => {
  if (h) await h.stop();
  await require("../parsers/parsePool").pool.close();
});
