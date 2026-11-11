/**
 * Accounts, end to end against the real routes: registration and email
 * confirmation, sign-in throttling, password reset, sessions (token version,
 * sign-out, cookie + CSRF), the admin role and two-step sign-in.
 * Run: `node server/routes/accountSecurity.test.js`
 *
 * The mailer is "configured" (EMAIL_* set, sends captured), so confirming an
 * email is enforced; Turnstile is on with its network call stubbed. Passwords,
 * keys and codes are made at run time.
 */
const assert = require("assert");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Account security");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
const pw = () => `Kx7-${crypto.randomBytes(9).toString("base64url")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server runs in this process, so moving Date.now moves its clock too.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };
/** Put the clock two seconds into a 30-second code step, so a group of sign-ins shares one step. */
const alignToStep = () => { clockOffset += (32_000 - (Date.now() % 30_000)) % 30_000; };

(async () => {
  const h = await start({ mailer: "configured" });
  const { usersDB, revokedSessionsDB } = h.models;
  const loginGuard = require("../security/loginGuard");
  const botGuard = require("../security/botGuard");
  const session = require("../security/session");
  const tokens = require("../security/tokens");
  const totp = require("../security/totp");
  const secretBox = require("../security/secretBox");
  const rfqToken = require("../services/rfqToken");
  const adminAccount = require("../security/adminAccount");

  const regHeaders = (over = {}) => ({ "X-Form-Token": h.formToken("register"), "X-Turnstile-Token": "pass-register", ...over });
  const byEmail = (email) => usersDB.getAll().find((u) => u.email === email);
  const mailTo = (email, re) => h.sent.filter((m) => m.to === email && (!re || re.test(m.subject)));
  const linkToken = (mail) => (mail.text.match(/#token=(\S+)/) || [])[1];
  const login = (email, password, extra = {}, opts = {}) => h.raw("POST", "/api/auth/login", { json: { email, password, ...extra }, ...opts });

  // Everything the server prints while these tests run, to prove no secret reaches a log.
  const logged = [];
  for (const level of ["log", "warn", "error"]) {
    const real = console[level];
    console[level] = (...args) => { logged.push(args.map(String).join(" ")); real(...args); };
  }
  const secretsSeen = [];

  // ═══ Registration ═════════════════════════════════════════════
  test("registration needs the bot check: no token, a rejected token and an outage all refuse (fail closed)", async () => {
    const body = { email: "bot@spam.test", password: pw(), name: "Bot" };
    const none = await h.raw("POST", "/api/auth/register", { json: body, headers: regHeaders({ "X-Turnstile-Token": "" }) });
    assert.strictEqual(none.status, 403);
    assert.strictEqual(none.body.code, "human-check-required");
    const rejected = await h.raw("POST", "/api/auth/register", { json: body, headers: regHeaders({ "X-Turnstile-Token": "fail-token" }) });
    assert.strictEqual(rejected.status, 403);
    h.turnstile.mode = "down";
    const outage = await h.raw("POST", "/api/auth/register", { json: body, headers: regHeaders() });
    h.turnstile.mode = "pass";
    assert.strictEqual(outage.status, 503);
    assert.ok(/224-213-6727/.test(outage.body.error), "an outage tells the visitor how to reach us");
    assert.strictEqual(byEmail("bot@spam.test"), undefined);
    assert.strictEqual(h.sent.length, 0, "no email went anywhere");
    // The quote tool's verified-human token is not accepted here: each account needs its own fresh check.
    const reuse = await h.raw("POST", "/api/auth/register", { json: body, headers: { "X-Form-Token": h.formToken("register"), "X-Human-Token": h.humanToken } });
    assert.strictEqual(reuse.status, 403);
  });

  test("always-on form checks: no form token, a form sent in under 3 seconds, and a filled honeypot are refused", async () => {
    const body = { email: "bot2@spam.test", password: pw(), name: "Bot" };
    assert.strictEqual((await h.raw("POST", "/api/auth/register", { json: body, headers: { "X-Turnstile-Token": "pass" } })).body.code, "form-token-missing");
    const fast = await h.raw("POST", "/api/auth/register", { json: body, headers: regHeaders({ "X-Form-Token": h.formToken("register", 500) }) });
    assert.strictEqual(fast.status, 400);
    assert.strictEqual(fast.body.code, "too-fast");
    const wrongForm = await h.raw("POST", "/api/auth/register", { json: body, headers: regHeaders({ "X-Form-Token": h.formToken("rfq") }) });
    assert.strictEqual(wrongForm.body.code, "form-token-missing");
    const pot = await h.raw("POST", "/api/auth/register", { json: { ...body, website: "http://spam.example" }, headers: regHeaders() });
    assert.strictEqual(pot.status, 400);
    assert.strictEqual(byEmail("bot2@spam.test"), undefined);
  });

  test("password rules on registration: short, missing a class, common, built from the address", async () => {
    const tryPw = async (password, email = "rules@buyer.test") => h.raw("POST", "/api/auth/register", { json: { email, password, name: "R" }, headers: regHeaders() });
    for (const [password, re] of [["Sh0rtpass", /at least 10 characters/], ["alllowercase12", /upper-case/], ["Password12", /most-used/], ["Qwertyuiop1", /most-used/], ["Rules-buyer-2026", /email address/]]) {
      const r = await tryPw(password, password.startsWith("Rules") ? "rules-buyer@plant.test" : undefined);
      assert.strictEqual(r.status, 400, password);
      assert.ok(re.test(r.body.error), `${password}: ${r.body.error}`);
    }
    assert.strictEqual(byEmail("rules@buyer.test"), undefined);
  });

  test("auth requests must be JSON: a form posted from another site is refused before it is read", async () => {
    const r = await h.raw("POST", "/api/auth/login", { body: "email=a%40b.test&password=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.strictEqual(r.status, 415);
    const m = await h.raw("POST", "/api/auth/register", { body: "x", headers: { "Content-Type": "text/plain" } });
    assert.strictEqual(m.status, 415);
  });

  let dana, danaPw;
  test("a new account is a customer, signed in, unconfirmed, and is sent a confirmation link that carries no typed text", async () => {
    danaPw = pw(); secretsSeen.push(danaPw);
    h.sent.length = 0;
    const r = await h.raw("POST", "/api/auth/register", { json: { email: "Dana@Buyer.test ", password: danaPw, name: "Claim your prize at evil.example", company: "<b>Co</b>", role: "admin", emailVerifiedAt: "2020-01-01" }, headers: regHeaders() });
    assert.strictEqual(r.status, 201, r.text);
    dana = r.body.token; secretsSeen.push(dana);
    assert.strictEqual(r.body.user.email, "dana@buyer.test");
    assert.strictEqual(r.body.user.role, "customer", "a role in the request body is ignored");
    assert.strictEqual(r.body.user.emailVerified, false, "so is a verified flag");
    assert.strictEqual(r.body.verificationEnforced, true);
    assert.ok(!("passwordHash" in r.body.user) && !JSON.stringify(r.body).includes("emailVerifyNonce"));
    const row = byEmail("dana@buyer.test");
    assert.ok(row.passwordHash.startsWith("$2") && !row.emailVerifiedAt && row.emailVerifyNonce);
    assert.strictEqual(h.sent.length, 1);
    const mail = h.sent[0];
    assert.strictEqual(mail.to, "dana@buyer.test");
    assert.strictEqual(mail.subject, "Straightedge: confirm your email address");
    assert.ok(mail.text.includes("https://shop.test/verify-email#token="), "link built from FRONTEND_URL, token in the fragment");
    assert.ok(!/Claim|prize|evil/.test(mail.text + mail.html + mail.subject), "the typed name is not in an email to a typed address");
    assert.ok(mail.html.includes("STRAIGHTEDGE"));
    secretsSeen.push(linkToken(mail));
  });

  test("registering an address that already has an account creates nothing and sends nothing", async () => {
    h.sent.length = 0;
    const r = await h.raw("POST", "/api/auth/register", { json: { email: "dana@buyer.test", password: pw(), name: "Again" }, headers: regHeaders() });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.token, undefined);
    assert.strictEqual(h.sent.length, 0);
    assert.strictEqual(usersDB.getAll().filter((u) => u.email === "dana@buyer.test").length, 1);
  });

  // ═══ Email confirmation ═══════════════════════════════════════
  let partId, quoteId;
  test("an unconfirmed account can build a quote but cannot check out, and is told why", async () => {
    partId = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, dana);
    assert.strictEqual(q.status, 200, q.text);
    quoteId = q.body.quoteId;
    const c = await h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, dana);
    assert.strictEqual(c.status, 403);
    assert.strictEqual(c.body.code, "email-unverified");
    assert.ok(c.body.error.includes("dana@buyer.test"));
    assert.strictEqual(h.stripe.created.length, 0, "Stripe was never called");
  });

  test("the confirmation can be re-sent, at most once a minute and five times a day", async () => {
    h.sent.length = 0;
    const first = await h.post("/api/auth/verify-email/resend", {}, dana);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(mailTo("dana@buyer.test", /confirm your email/).length, 1);
    const again = await h.post("/api/auth/verify-email/resend", {}, dana);
    assert.strictEqual(again.status, 429);
    assert.strictEqual(mailTo("dana@buyer.test", /confirm your email/).length, 1);
    for (let i = 0; i < 4; i++) { advance(61_000); assert.strictEqual((await h.post("/api/auth/verify-email/resend", {}, dana)).status, 200); }
    advance(61_000);
    const sixth = await h.post("/api/auth/verify-email/resend", {}, dana);
    assert.strictEqual(sixth.status, 429, "sixth in a day");
    assert.strictEqual(mailTo("dana@buyer.test", /confirm your email/).length, 5);
    assert.strictEqual((await h.raw("POST", "/api/auth/verify-email/resend", { json: {} })).status, 401, "a guest cannot trigger it");
  });

  test("a confirmation link is refused when forged, of another kind, for another address, or older than 24 hours", async () => {
    const row = byEmail("dana@buyer.test");
    const verify = (token) => h.raw("POST", "/api/auth/verify-email", { json: { token } });
    assert.strictEqual((await verify("not-a-token")).status, 400);
    assert.strictEqual((await verify(tokens.sign("password-reset", { uid: row.id }))).status, 400, "a reset link is not a confirmation link");
    assert.strictEqual((await verify(dana)).status, 400, "a session token is not a confirmation link");
    assert.strictEqual((await verify(tokens.sign("email-verify", { uid: row.id, email: row.email, n: "wrong-nonce" }))).status, 400);
    assert.strictEqual((await verify(tokens.sign("email-verify", { uid: row.id, email: "other@x.test", n: row.emailVerifyNonce }))).status, 400);
    const old = tokens.sign("email-verify", { uid: row.id, email: row.email, n: row.emailVerifyNonce }, { now: Date.now() - 24.1 * 3600e3 });
    const expired = await verify(old);
    assert.strictEqual(expired.status, 400);
    assert.strictEqual(expired.body.code, "link-expired");
    assert.ok(!byEmail("dana@buyer.test").emailVerifiedAt);
  });

  test("opening the emailed link confirms the address once; checkout then works with the same session", async () => {
    const mail = mailTo("dana@buyer.test", /confirm your email/)[0]; // the first of the five re-sent links still works
    const token = linkToken(mail);
    const v = await h.raw("POST", "/api/auth/verify-email", { json: { token } });
    assert.strictEqual(v.status, 200, v.text);
    assert.deepStrictEqual({ verified: v.body.verified, already: v.body.already }, { verified: true, already: false });
    const row = byEmail("dana@buyer.test");
    assert.ok(row.emailVerifiedAt && !row.emailVerifyNonce);
    assert.strictEqual(row.role, "customer");
    // Single use: the same link again changes nothing.
    const stamp = row.emailVerifiedAt;
    const again = await h.raw("POST", "/api/auth/verify-email", { json: { token } });
    assert.strictEqual(again.body.already, true);
    assert.strictEqual(byEmail("dana@buyer.test").emailVerifiedAt, stamp);
    const s = await h.get("/api/auth/session", dana);
    assert.strictEqual(s.body.user.emailVerified, true, "the flag is read from the database, not the token");
    const c = await h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, dana);
    assert.strictEqual(c.status, 200, c.text);
    assert.ok(c.body.sessionUrl.startsWith("https://checkout.stripe.test/"));
    assert.strictEqual((await h.post("/api/auth/verify-email/resend", {}, dana)).body.verified, true);
  });

  test("with no mailer configured, confirmation cannot work, so checkout is not held back", async () => {
    const keep = { k: process.env.EMAIL_API_KEY, f: process.env.EMAIL_FROM };
    const t = await h.register("nomail@buyer.test", "No Mail", { verify: false });
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 3)], leadTimeSlug: "standard" }, t);
    assert.strictEqual((await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, t)).status, 403, "held back while the mailer is configured");
    delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM;
    try {
      assert.strictEqual((await h.get("/api/auth/session", t)).body.verificationEnforced, false);
      const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, t);
      assert.strictEqual(c.status, 200, c.text);
    } finally { process.env.EMAIL_API_KEY = keep.k; process.env.EMAIL_FROM = keep.f; }
  });

  // ═══ Admin role ═══════════════════════════════════════════════
  let owner, ownerPw;
  test("registering the ADMIN_EMAIL address does not make an admin; confirming its email does", async () => {
    ownerPw = pw(); secretsSeen.push(ownerPw);
    owner = await h.register("owner@shop.test", "Owner", { verify: false, password: ownerPw });
    assert.strictEqual(byEmail("owner@shop.test").role, "customer");
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 403);
    assert.strictEqual((await h.get("/api/rfq/admin/list", owner)).status, 403);
    // A restart does not promote it either.
    const boot = adminAccount.ensureAtStartup();
    assert.deepStrictEqual({ promoted: boot.promoted, pending: boot.pending }, { promoted: false, pending: true });
    assert.strictEqual(byEmail("owner@shop.test").role, "customer");
    await h.confirmEmail("owner@shop.test");
    assert.strictEqual(byEmail("owner@shop.test").role, "admin");
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 200, "the same session is now an admin: the role is read per request");
  });

  test("the admin role is checked against the database on every request, whatever the token says", async () => {
    const row = byEmail("owner@shop.test");
    usersDB.update(row.id, { role: "customer" });
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 403, "demoted: the old token no longer opens the admin area");
    assert.strictEqual((await h.get("/api/orders", owner)).body.length, 0, "and it lists only its own orders");
    usersDB.update(row.id, { role: "admin" });
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 200);
    // A customer's token re-signed by hand with role "admin" is not a valid session at all.
    const danaRow = byEmail("dana@buyer.test");
    const forged = jwt.sign({ userId: danaRow.id, email: danaRow.email, role: "admin", tv: 0, jti: crypto.randomUUID() }, "guessed-secret", { expiresIn: 3600 });
    assert.strictEqual((await h.get("/api/admin/stats", forged)).status, 401);
    // Even a correctly signed token that claims admin for a customer account gets the database's answer.
    const claimed = jwt.sign({ userId: danaRow.id, email: danaRow.email, role: "admin", tv: 0, jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: 3600 });
    assert.strictEqual((await h.get("/api/admin/stats", claimed)).status, 403);
  });

  test("admin sessions are shorter than customer sessions (4 h against 24 h)", async () => {
    const adminClaims = jwt.decode(await h.login("owner@shop.test", ownerPw));
    const customerClaims = jwt.decode(await h.login("dana@buyer.test", danaPw));
    assert.strictEqual(adminClaims.exp - adminClaims.iat, 4 * 3600);
    assert.strictEqual(customerClaims.exp - customerClaims.iat, 24 * 3600);
    // A token issued while the account was a customer stops opening anything once it is an admin and older than 4 hours.
    const row = byEmail("owner@shop.test");
    const iat = Math.floor(Date.now() / 1000) - 5 * 3600;
    const old = jwt.sign({ userId: row.id, email: row.email, role: "customer", tv: Number(row.tokenVersion) || 0, jti: crypto.randomUUID(), iat, exp: iat + 24 * 3600 }, process.env.JWT_SECRET);
    assert.strictEqual((await h.get("/api/auth/profile", old)).status, 401);
  });

  // ═══ Sign-in ══════════════════════════════════════════════════
  test("an unknown address and a wrong password get the same answer and the same work", async () => {
    loginGuard.resetForTests();
    let compares = 0;
    const realCompare = bcrypt.compare;
    bcrypt.compare = (...a) => { compares++; return realCompare.apply(bcrypt, a); };
    try {
      const wrong = await login("dana@buyer.test", "Not-the-password-1");
      assert.strictEqual(compares, 1);
      const unknown = await login("nobody@nowhere.test", "Not-the-password-1");
      assert.strictEqual(compares, 2, "a password hash is checked even when there is no account");
      assert.strictEqual(wrong.status, 401);
      assert.strictEqual(unknown.status, 401);
      assert.deepStrictEqual(wrong.body, unknown.body);
      assert.strictEqual(wrong.body.error, "That email and password didn't match.");
      assert.strictEqual(wrong.headers.get("set-cookie"), null);
    } finally { bcrypt.compare = realCompare; }
  });

  test("correct sign-ins are never counted: ten in a row from one address all work", async () => {
    loginGuard.resetForTests();
    for (let i = 0; i < 10; i++) {
      const r = await login("dana@buyer.test", danaPw, {}, { ip: "203.0.113.20" });
      assert.strictEqual(r.status, 200, `sign-in ${i + 1}: ${r.text}`);
    }
  });

  test("after three wrong passwords the bot check is part of signing in", async () => {
    loginGuard.resetForTests();
    const ip = "203.0.113.21";
    for (let i = 0; i < 2; i++) assert.strictEqual((await login("dana@buyer.test", "Wrong-password-1", {}, { ip })).body.challenge, false);
    const third = await login("dana@buyer.test", "Wrong-password-1", {}, { ip });
    assert.strictEqual(third.body.challenge, true, "the page is told to show the check");
    const noCheck = await login("dana@buyer.test", danaPw, {}, { ip });
    assert.strictEqual(noCheck.status, 403);
    assert.strictEqual(noCheck.body.code, "human-check-required");
    // The requirement follows the address to another connection.
    assert.strictEqual((await login("dana@buyer.test", danaPw, {}, { ip: "198.51.100.200" })).status, 403);
    const withCheck = await login("dana@buyer.test", danaPw, {}, { ip, headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual(withCheck.status, 200, withCheck.text);
    // A correct sign-in clears the address's count.
    assert.strictEqual((await login("dana@buyer.test", danaPw, {}, { ip: "198.51.100.201" })).status, 200);
  });

  test("five wrong passwords pause the address for 15 minutes from every connection, the owner is emailed, and an unknown address behaves the same", async () => {
    loginGuard.resetForTests();
    h.sent.length = 0;
    const attempt = (email, n) => login(email, "Wrong-password-1", {}, { ip: `198.51.100.${n + 1}`, headers: { "X-Turnstile-Token": "pass-login" } });
    const known = [], unknown = [];
    for (let i = 0; i < 5; i++) { known.push(await attempt("dana@buyer.test", i)); unknown.push(await attempt("ghost@nowhere.test", i + 50)); }
    assert.deepStrictEqual(known.map((r) => r.status), [401, 401, 401, 401, 401]);
    assert.deepStrictEqual(unknown.map((r) => [r.status, r.body]), known.map((r) => [r.status, r.body]), "identical answers all the way to the pause");
    // Paused: the right password, from a new address, with the bot check passed.
    const right = await login("dana@buyer.test", danaPw, {}, { ip: "203.0.113.99", headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual(right.status, 429);
    assert.strictEqual(right.body.code, "account-locked");
    assert.ok(/paused for 15 minutes/.test(right.body.error) && /reset your password/.test(right.body.error));
    const ghost = await login("ghost@nowhere.test", "anything-At-all-1", {}, { ip: "203.0.113.98", headers: { "X-Turnstile-Token": "pass-login" } });
    assert.deepStrictEqual([ghost.status, ghost.body.code, ghost.body.error], [right.status, right.body.code, right.body.error], "no way to tell which address has an account");
    await sleep(50); // the pause is written and the email sent after the response
    const row = byEmail("dana@buyer.test");
    assert.ok(new Date(row.lockedUntil).getTime() > Date.now() + 14 * 60e3, "the pause is stored on the account, so it survives a restart");
    const mails = mailTo("dana@buyer.test", /sign-in paused/);
    assert.strictEqual(mails.length, 1, "one email to the account's owner");
    assert.ok(/Nobody got in/.test(mails[0].text) && mails[0].text.includes("https://shop.test/forgot-password"));
    assert.strictEqual(mailTo("ghost@nowhere.test").length, 0, "nothing is sent to an address with no account");
    // A session that already exists keeps working: the pause is on signing in.
    assert.strictEqual((await h.get("/api/auth/profile", dana)).status, 200);
  });

  test("the pause ends after 15 minutes without anyone doing anything", async () => {
    advance(15 * 60e3 + 1000);
    const r = await login("dana@buyer.test", danaPw, {}, { ip: "203.0.113.97" });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!byEmail("dana@buyer.test").lockedUntil, "the stored pause is cleared on a good sign-in");
  });

  test("one connection trying many addresses is stopped at 20 failures; other connections are not", async () => {
    loginGuard.resetForTests();
    const ip = "203.0.113.30";
    let last;
    for (let i = 0; i < 20; i++) last = await login(`spray${i}@x.test`, "Wrong-password-1", {}, { ip, headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual(last.status, 401);
    const blocked = await login("dana@buyer.test", danaPw, {}, { ip, headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(blocked.body.code, "rate-limited");
    assert.strictEqual((await login("dana@buyer.test", danaPw, {}, { ip: "203.0.113.31" })).status, 200, "the account itself is not paused by someone else's spraying");
    loginGuard.resetForTests();
  });

  // ═══ Password reset ═══════════════════════════════════════════
  const resetHeaders = (over = {}) => ({ "X-Form-Token": h.formToken("password-reset"), "X-Turnstile-Token": "pass-reset", ...over });
  const requestReset = (email, opts = {}) => h.raw("POST", "/api/auth/password-reset/request", { json: { email }, headers: resetHeaders(), ...opts });

  test("asking for a reset answers the same for an address with an account and one without; only the real one is emailed", async () => {
    h.sent.length = 0;
    const real = await requestReset("dana@buyer.test");
    const none = await requestReset("nobody@nowhere.test");
    assert.strictEqual(real.status, 200);
    assert.deepStrictEqual(real.body, none.body);
    assert.strictEqual(real.text.length, none.text.length);
    await sleep(40);
    assert.strictEqual(mailTo("dana@buyer.test", /reset your password/).length, 1);
    assert.strictEqual(mailTo("nobody@nowhere.test").length, 0);
    const mail = mailTo("dana@buyer.test", /reset your password/)[0];
    assert.ok(mail.text.includes("https://shop.test/reset-password#token=") && /one hour/.test(mail.text));
    secretsSeen.push(linkToken(mail));
  });

  test("a reset request needs the bot check and the form checks too", async () => {
    h.sent.length = 0;
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/request", { json: { email: "dana@buyer.test" }, headers: resetHeaders({ "X-Turnstile-Token": "" }) })).status, 403);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/request", { json: { email: "dana@buyer.test" }, headers: { "X-Turnstile-Token": "pass" } })).status, 400);
    const pot = await h.raw("POST", "/api/auth/password-reset/request", { json: { email: "dana@buyer.test", website: "x" }, headers: resetHeaders() });
    assert.strictEqual(pot.status, 200, "a honeypot hit looks like success");
    await sleep(40);
    assert.strictEqual(h.sent.length, 0);
  });

  test("reset emails are limited to three an hour per address; requests to five an hour per connection", async () => {
    h.sent.length = 0;
    // One was sent in the test above; two more go out, then the address is quiet for the hour.
    for (let i = 0; i < 4; i++) assert.strictEqual((await requestReset("dana@buyer.test")).status, 200, "the answer never changes");
    await sleep(60);
    assert.strictEqual(mailTo("dana@buyer.test", /reset your password/).length, 2);
    const ip = "203.0.113.40";
    for (let i = 0; i < 5; i++) assert.strictEqual((await requestReset(`r${i}@x.test`, { ip })).status, 200);
    assert.strictEqual((await requestReset("r9@x.test", { ip })).status, 429);
  });

  let resetLink1, resetLink2, newPw;
  test("a reset link is refused when forged, expired, or of another kind; a weak new password is refused", async () => {
    const mails = mailTo("dana@buyer.test", /reset your password/);
    resetLink1 = linkToken(mails[0]); resetLink2 = linkToken(mails[1]);
    const confirm = (token, password) => h.raw("POST", "/api/auth/password-reset/confirm", { json: { token, password } });
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/check", { json: { token: resetLink1 } })).body.valid, true);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/check", { json: { token: "junk" } })).body.valid, false);
    assert.strictEqual((await confirm("junk", pw())).status, 400);
    assert.strictEqual((await confirm(dana, pw())).status, 400, "a session token is not a reset link");
    const row = byEmail("dana@buyer.test");
    assert.strictEqual((await confirm(tokens.sign("email-verify", { uid: row.id, email: row.email, n: "x" }), pw())).status, 400);
    assert.strictEqual((await confirm(tokens.sign("password-reset", { uid: row.id, b: "0".repeat(32) }), pw())).status, 400, "not bound to the current password");
    const weak = await confirm(resetLink1, "Password12");
    assert.strictEqual(weak.status, 400);
    assert.strictEqual(weak.body.code, "weak-password");
    // One hour and a minute later the same link is dead…
    advance(61 * 60e3);
    assert.strictEqual((await confirm(resetLink1, pw())).status, 400);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/check", { json: { token: resetLink1 } })).body.valid, false);
    advance(-61 * 60e3); // …so step back for the tests that use it
  });

  test("choosing a new password: the old one stops working, every earlier session ends, the link is spent, and the account is told", async () => {
    loginGuard.resetForTests();
    const before = await h.login("dana@buyer.test", danaPw);
    assert.strictEqual((await h.get("/api/auth/profile", before)).status, 200);
    h.sent.length = 0;
    newPw = pw(); secretsSeen.push(newPw);
    const done = await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: resetLink1, password: newPw } });
    assert.strictEqual(done.status, 200, done.text);
    assert.strictEqual(done.body.token, undefined, "the link does not sign anyone in");
    assert.strictEqual((await h.get("/api/auth/profile", before)).status, 401, "a session from before the change");
    assert.strictEqual((await h.get("/api/auth/profile", dana)).status, 401, "…and the one from registration");
    assert.strictEqual((await h.get("/api/orders", dana)).status, 401);
    assert.strictEqual((await login("dana@buyer.test", danaPw)).status, 401, "the old password");
    assert.strictEqual((await login("dana@buyer.test", newPw)).status, 200);
    // Single use, and the second link issued for the old password died with it.
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: resetLink1, password: pw() } })).status, 400);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: resetLink2, password: pw() } })).status, 400);
    assert.strictEqual((await login("dana@buyer.test", newPw)).status, 200, "the password set by the first link stands");
    const told = mailTo("dana@buyer.test", /password was changed/);
    assert.strictEqual(told.length, 1);
    assert.ok(/signed out/.test(told[0].text) && !told[0].text.includes(newPw));
    dana = await h.login("dana@buyer.test", newPw);
    danaPw = newPw;
  });

  test("a reset lifts a sign-in pause at once", async () => {
    loginGuard.resetForTests();
    advance(61 * 60e3); // a fresh hour for the per-address reset limit
    for (let i = 0; i < 5; i++) await login("dana@buyer.test", "Wrong-password-1", {}, { ip: `198.51.100.${i + 60}`, headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual((await login("dana@buyer.test", danaPw, {}, { headers: { "X-Turnstile-Token": "pass-login" } })).status, 429);
    h.sent.length = 0;
    await requestReset("dana@buyer.test");
    await sleep(60);
    const link = linkToken(mailTo("dana@buyer.test", /reset your password/)[0]);
    const unlockPw = pw(); secretsSeen.push(unlockPw);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: link, password: unlockPw } })).status, 200);
    const r = await login("dana@buyer.test", unlockPw);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!byEmail("dana@buyer.test").lockedUntil);
    dana = r.body.token; danaPw = unlockPw;
  });

  test("a reset proves the mailbox, so it also confirms an unconfirmed address", async () => {
    const t = await h.register("late@buyer.test", "Late", { verify: false });
    assert.strictEqual((await h.get("/api/auth/session", t)).body.user.emailVerified, false);
    h.sent.length = 0;
    await requestReset("late@buyer.test");
    await sleep(60);
    const p = pw();
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: linkToken(mailTo("late@buyer.test", /reset your password/)[0]), password: p } })).status, 200);
    const s = await h.get("/api/auth/session", await h.login("late@buyer.test", p));
    assert.strictEqual(s.body.user.emailVerified, true);
  });

  // ═══ Sessions ═════════════════════════════════════════════════
  test("signing out ends that session on the server; other sessions carry on; 'sign out everywhere' ends them all", async () => {
    const a = await h.login("dana@buyer.test", danaPw);
    const b = await h.login("dana@buyer.test", danaPw);
    const out = await h.raw("POST", "/api/auth/logout", { json: {}, token: a });
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await h.get("/api/auth/profile", a)).status, 401, "the signed-out token is dead, not just forgotten by the browser");
    assert.strictEqual((await h.get("/api/orders", a)).status, 401);
    assert.strictEqual((await h.get("/api/auth/session", a)).body.authenticated, false);
    assert.strictEqual((await h.get("/api/auth/profile", b)).status, 200);
    assert.ok(revokedSessionsDB.getById(jwt.decode(a).jti), "the session id is on the revoked list until it would have expired");
    assert.strictEqual((await h.raw("POST", "/api/auth/logout", { json: {}, token: a })).status, 200, "signing out twice is harmless");
    const all = await h.raw("POST", "/api/auth/logout-all", { json: {}, token: b });
    assert.strictEqual(all.status, 200);
    assert.strictEqual((await h.get("/api/auth/profile", b)).status, 401);
    assert.strictEqual((await h.get("/api/auth/profile", dana)).status, 401);
    dana = await h.login("dana@buyer.test", danaPw);
    // Expired revocations are swept.
    revokedSessionsDB.insert({ id: "old-session", userId: "x", expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.ok(session.sweepRevoked() >= 1);
    assert.strictEqual(revokedSessionsDB.getById("old-session"), null);
  });

  test("tokens that are not sessions open nothing: forged, unsigned, without an id, a firm-quote link, a verified-human token", async () => {
    const row = byEmail("dana@buyer.test");
    const claims = { userId: row.id, email: row.email, role: "customer", tv: Number(row.tokenVersion) || 0 };
    const cases = {
      "wrong key": jwt.sign({ ...claims, jti: "j1" }, "another-secret", { expiresIn: 600 }),
      "no session id": jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: 600 }),
      "stale token version": jwt.sign({ ...claims, tv: claims.tv - 1, jti: "j2" }, process.env.JWT_SECRET, { expiresIn: 600 }),
      "expired": jwt.sign({ ...claims, jti: "j3", iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET),
      "alg none": `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, jti: "j4" })).toString("base64url")}.`,
      "deleted account": jwt.sign({ ...claims, userId: crypto.randomUUID(), jti: "j5" }, process.env.JWT_SECRET, { expiresIn: 600 }),
      "firm-quote link": rfqToken.sign({ id: crypto.randomUUID(), quoteSentAt: new Date().toISOString(), validUntil: new Date(Date.now() + 864e5).toISOString() }),
      "verified-human token": h.humanToken,
      "reset link": tokens.sign("password-reset", { uid: row.id, userId: row.id, b: "x" }),
    };
    for (const [name, token] of Object.entries(cases)) {
      assert.strictEqual((await h.get("/api/auth/profile", token)).status, 401, name);
      assert.strictEqual((await h.get("/api/orders", token)).status, 401, name);
      assert.strictEqual((await h.get("/api/auth/session", token)).body.authenticated, false, name);
    }
  });

  test("the browser session is an httpOnly, SameSite=Strict cookie, and cookie requests that change anything need the CSRF token", async () => {
    const r = await login("dana@buyer.test", danaPw);
    const setCookie = r.headers.getSetCookie();
    assert.strictEqual(setCookie.length, 1);
    const c = setCookie[0];
    assert.ok(c.startsWith("se_session="), c.split("=")[0]);
    assert.ok(/; HttpOnly/.test(c) && /; SameSite=Strict/.test(c) && /; Path=\//.test(c) && /; Max-Age=86400/.test(c));
    const cookie = c.split(";")[0];
    // The page learns who is signed in, and its CSRF token, from the session endpoint.
    const s = await h.raw("GET", "/api/auth/session", { headers: { Cookie: cookie } });
    assert.strictEqual(s.body.authenticated, true);
    assert.strictEqual(s.body.user.email, "dana@buyer.test");
    assert.strictEqual(s.body.csrfToken, r.body.csrfToken);
    assert.ok(/^[0-9a-f]{64}$/.test(s.body.csrfToken));
    assert.strictEqual(s.headers.get("cache-control"), "no-store");
    // Reads work with the cookie alone.
    assert.strictEqual((await h.raw("GET", "/api/orders", { headers: { Cookie: cookie } })).status, 200);
    // Writes do not.
    const noCsrf = await h.raw("PUT", "/api/auth/profile", { json: { company: "Changed by another site" }, headers: { Cookie: cookie } });
    assert.strictEqual(noCsrf.status, 403);
    assert.strictEqual(noCsrf.body.code, "csrf");
    const wrongCsrf = await h.raw("PUT", "/api/auth/profile", { json: { company: "x" }, headers: { Cookie: cookie, "X-CSRF-Token": "0".repeat(64) } });
    assert.strictEqual(wrongCsrf.status, 403);
    // Another session's CSRF token does not fit this session.
    const other = await login("dana@buyer.test", danaPw);
    assert.strictEqual((await h.raw("PUT", "/api/auth/profile", { json: { company: "x" }, headers: { Cookie: cookie, "X-CSRF-Token": other.body.csrfToken } })).status, 403);
    const ok = await h.raw("PUT", "/api/auth/profile", { json: { company: "Buyer Co" }, headers: { Cookie: cookie, "X-CSRF-Token": s.body.csrfToken } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(byEmail("dana@buyer.test").company, "Buyer Co");
    // Checkout from the cookie session needs it too.
    assert.strictEqual((await h.raw("POST", "/api/orders/checkout-session", { json: { quoteId, ...SHIP }, headers: { Cookie: cookie } })).status, 403);
    // Where sign-in is optional (pricing), a cookie without the token is simply a guest.
    await h.refreshHuman(); // the suite's clock has moved more than the token's hour
    const guestLike = await h.raw("POST", "/api/quote", { json: { parts: [h.cncConfig(partId, 1)] }, headers: { Cookie: cookie, "X-Human-Token": h.humanToken } });
    assert.strictEqual(guestLike.status, 200);
    assert.strictEqual(h.models.quotesDB.getById(guestLike.body.quoteId).userId, null, "not bound to the account");
    // Sign-out clears the cookie and ends the session.
    const out = await h.raw("POST", "/api/auth/logout", { json: {}, headers: { Cookie: cookie } });
    assert.ok(/se_session=;/.test(out.headers.getSetCookie()[0]) && /Max-Age=0/.test(out.headers.getSetCookie()[0]));
    assert.strictEqual((await h.raw("GET", "/api/auth/session", { headers: { Cookie: cookie } })).body.authenticated, false);
    assert.strictEqual((await h.raw("GET", "/api/orders", { headers: { Cookie: cookie } })).status, 401);
  });

  test("in production the cookie is Secure and host-locked (__Host- prefix)", async () => {
    const keep = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const r = await login("dana@buyer.test", danaPw);
      const c = r.headers.getSetCookie()[0];
      assert.ok(c.startsWith("__Host-se_session="), c.slice(0, 20));
      assert.ok(/; Secure/.test(c) && /; HttpOnly/.test(c) && /; SameSite=Strict/.test(c) && /; Path=\//.test(c) && !/Domain=/i.test(c));
      const cookie = c.split(";")[0];
      assert.strictEqual((await h.raw("GET", "/api/auth/session", { headers: { Cookie: cookie } })).body.authenticated, true);
    } finally { process.env.NODE_ENV = keep; }
  });

  test("profile responses never carry the password hash or any secret column", async () => {
    const p = await h.get("/api/auth/profile", dana);
    assert.deepStrictEqual(Object.keys(p.body).sort(), ["company", "createdAt", "email", "emailVerified", "id", "name", "phone", "role", "twoFactorEnabled"]);
    const put = await h.put("/api/auth/profile", { name: "Dana Buyer", role: "admin", emailVerifiedAt: "x", tokenVersion: 99 }, dana);
    assert.strictEqual(put.body.role, "customer");
    assert.strictEqual(put.body.name, "Dana Buyer");
  });

  // ═══ Two-step sign-in ═════════════════════════════════════════
  let setupKey, recoveryCodes, ownerRow;
  const code = () => totp.codeAt(setupKey.replace(/\s/g, ""), Date.now());

  test("two-step sign-in is for the admin: a customer cannot reach it, and a guest cannot either", async () => {
    for (const [method, path] of [["GET", "/api/auth/2fa"], ["POST", "/api/auth/2fa/setup"], ["POST", "/api/auth/2fa/enable"], ["POST", "/api/auth/2fa/disable"], ["POST", "/api/auth/2fa/recovery-codes"]]) {
      assert.strictEqual((await h.raw(method, path, { json: method === "GET" ? undefined : {}, token: dana })).status, 403, `${path} as a customer`);
      assert.strictEqual((await h.raw(method, path, { json: method === "GET" ? undefined : {} })).status, 401, `${path} as a guest`);
    }
  });

  test("setup: needs the password, makes the secret on the server, shows the key and a locally computed QR code once, and stores only ciphertext", async () => {
    loginGuard.resetForTests();
    owner = await h.login("owner@shop.test", ownerPw);
    assert.deepStrictEqual((await h.get("/api/auth/2fa", owner)).body, { enabled: false, enabledAt: null, recoveryCodesLeft: 0, setupStarted: false });
    assert.strictEqual((await h.post("/api/auth/2fa/setup", {}, owner)).status, 401);
    assert.strictEqual((await h.post("/api/auth/2fa/setup", { password: "Wrong-password-1" }, owner)).status, 401);
    const r = await h.post("/api/auth/2fa/setup", { password: ownerPw }, owner);
    assert.strictEqual(r.status, 200, r.text);
    setupKey = r.body.setupKey;
    const raw = setupKey.replace(/\s/g, "");
    secretsSeen.push(raw, setupKey);
    assert.ok(/^[A-Z2-7]{32}$/.test(raw), "a 160-bit base32 key");
    assert.ok(r.body.otpauthUri.startsWith("otpauth://totp/Straightedge:owner%40shop.test?secret=" + raw));
    // The QR code is a grid of cells computed on the server: no outside image service, no markup.
    assert.ok(r.body.qr.size >= 21 && r.body.qr.cells.length === r.body.qr.size ** 2 && /^[01]+$/.test(r.body.qr.cells));
    assert.ok(!/https?:\/\//.test(JSON.stringify(r.body).replace(r.body.otpauthUri, "")), "nothing in the answer points at another site");
    assert.strictEqual(r.headers.get("cache-control"), "no-store");
    ownerRow = byEmail("owner@shop.test");
    assert.ok(ownerRow.totpPendingEnc && !ownerRow.totpSecretEnc && !ownerRow.totpEnabledAt);
    assert.ok(!JSON.stringify(ownerRow).includes(raw), "the database row does not contain the key");
    assert.strictEqual(secretBox.open("totp", ownerRow.totpPendingEnc, ownerRow.id), raw);
    // Nothing is switched on yet: sign-in is still password only.
    assert.strictEqual((await login("owner@shop.test", ownerPw)).status, 200);
    // Asking again makes a new key; the first is gone, not shown again.
    const again = await h.post("/api/auth/2fa/setup", { password: ownerPw }, owner);
    assert.notStrictEqual(again.body.setupKey, setupKey);
    setupKey = again.body.setupKey; secretsSeen.push(setupKey, setupKey.replace(/\s/g, ""));
    assert.strictEqual((await h.get("/api/auth/2fa", owner)).body.setupStarted, true);
  });

  let ownerBefore;
  test("enable: a wrong code changes nothing; the right code switches it on, ends other sessions, and shows ten recovery codes once", async () => {
    ownerBefore = await h.login("owner@shop.test", ownerPw);
    alignToStep();
    const wrong = await h.post("/api/auth/2fa/enable", { code: "000000" }, owner);
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual((await h.get("/api/auth/2fa", owner)).body.enabled, false);
    h.sent.length = 0;
    const r = await h.post("/api/auth/2fa/enable", { code: code() }, owner);
    assert.strictEqual(r.status, 200, r.text);
    recoveryCodes = r.body.recoveryCodes; secretsSeen.push(...recoveryCodes);
    assert.strictEqual(recoveryCodes.length, 10);
    assert.strictEqual(new Set(recoveryCodes).size, 10);
    ownerRow = byEmail("owner@shop.test");
    assert.ok(ownerRow.totpSecretEnc && ownerRow.totpEnabledAt && !ownerRow.totpPendingEnc);
    assert.strictEqual(ownerRow.recoveryCodes.length, 10);
    const stored = JSON.stringify(ownerRow);
    for (const c of recoveryCodes) assert.ok(!stored.includes(c) && !stored.includes(c.replace("-", "")), "recovery codes are stored hashed");
    assert.ok(!stored.includes(setupKey.replace(/\s/g, "")));
    // This session continues on a new token; the others are over.
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 401);
    assert.strictEqual((await h.get("/api/admin/stats", ownerBefore)).status, 401);
    owner = r.body.token;
    assert.strictEqual((await h.get("/api/admin/stats", owner)).status, 200);
    assert.strictEqual(mailTo("owner@shop.test", /two-step sign-in is on/).length, 1);
    // Status never returns the secret, and setup cannot be re-run to see it.
    const status = await h.get("/api/auth/2fa", owner);
    assert.deepStrictEqual(Object.keys(status.body).sort(), ["enabled", "enabledAt", "recoveryCodesLeft", "setupStarted"]);
    assert.strictEqual(status.body.recoveryCodesLeft, 10);
    assert.strictEqual((await h.post("/api/auth/2fa/setup", { password: ownerPw }, owner)).status, 409);
    assert.strictEqual((await h.post("/api/auth/2fa/enable", { code: code() }, owner)).status, 409);
    const profile = JSON.stringify((await h.get("/api/auth/profile", owner)).body) + JSON.stringify((await h.get("/api/auth/session", owner)).body);
    assert.ok(!/totp|recovery|secret/i.test(profile.replace("twoFactorEnabled", "")));
  });

  test("sign-in now takes the password and a current code: no code, a wrong code and a replayed code are all refused", async () => {
    loginGuard.resetForTests();
    const pwOnly = await login("owner@shop.test", ownerPw);
    assert.strictEqual(pwOnly.status, 401);
    assert.strictEqual(pwOnly.body.code, "two-factor-required");
    assert.strictEqual(pwOnly.body.token, undefined);
    assert.strictEqual(pwOnly.headers.get("set-cookie"), null, "no session of any kind before the second step");
    // A wrong password never reveals that the account has a second step.
    const wrongPw = await login("owner@shop.test", "Wrong-password-1", { totp: "123456" });
    assert.strictEqual(wrongPw.body.code, "invalid-credentials");
    assert.strictEqual(wrongPw.body.twoFactor, undefined);
    loginGuard.resetForTests();
    const wrongCode = await login("owner@shop.test", ownerPw, { totp: "000000" });
    assert.strictEqual(wrongCode.status, 401);
    assert.strictEqual(wrongCode.body.code, "two-factor-invalid");
    // The code used to enrol cannot be used again in the same 30 seconds.
    assert.strictEqual((await login("owner@shop.test", ownerPw, { totp: code() })).status, 401, "replay of the enrolment code");
    advance(30_000);
    const good = code();
    const ok = await login("owner@shop.test", ownerPw, { totp: good });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.user.twoFactorEnabled, true);
    assert.strictEqual((await h.get("/api/admin/stats", ok.body.token)).status, 200);
    assert.strictEqual((await login("owner@shop.test", ownerPw, { totp: good })).status, 401, "a code works once");
    loginGuard.resetForTests();
  });

  test("wrong codes count toward the sign-in pause like wrong passwords", async () => {
    loginGuard.resetForTests();
    for (let i = 0; i < 5; i++) assert.strictEqual((await login("owner@shop.test", ownerPw, { totp: "000000" }, { ip: `198.51.100.${i + 80}`, headers: { "X-Turnstile-Token": "pass-login" } })).status, 401);
    advance(30_000);
    const r = await login("owner@shop.test", ownerPw, { totp: code() }, { headers: { "X-Turnstile-Token": "pass-login" } });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.code, "account-locked");
    await sleep(40);
    advance(15 * 60e3 + 1000);
    loginGuard.resetForTests();
  });

  test("a recovery code signs in once, is then spent, and the owner is told it was used", async () => {
    h.sent.length = 0;
    const r = await login("owner@shop.test", ownerPw, { recoveryCode: recoveryCodes[0].toLowerCase().replace("-", " ") });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.recoveryCodesLeft, 9);
    assert.strictEqual(byEmail("owner@shop.test").recoveryCodes.length, 9);
    assert.strictEqual(mailTo("owner@shop.test", /recovery code was used/).length, 1);
    const again = await login("owner@shop.test", ownerPw, { recoveryCode: recoveryCodes[0] });
    assert.strictEqual(again.status, 401);
    assert.strictEqual(again.body.code, "two-factor-invalid");
    assert.strictEqual((await login("owner@shop.test", ownerPw, { recoveryCode: "AAAAA-AAAAA" })).status, 401);
    owner = r.body.token;
    loginGuard.resetForTests();
  });

  test("new recovery codes need a current code and retire the old ones", async () => {
    assert.strictEqual((await h.post("/api/auth/2fa/recovery-codes", { code: "000000" }, owner)).status, 400);
    advance(30_000);
    const r = await h.post("/api/auth/2fa/recovery-codes", { code: code() }, owner);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.recoveryCodes.length, 10);
    secretsSeen.push(...r.body.recoveryCodes);
    assert.strictEqual((await login("owner@shop.test", ownerPw, { recoveryCode: recoveryCodes[1] })).status, 401, "an old code");
    loginGuard.resetForTests();
    recoveryCodes = r.body.recoveryCodes;
  });

  test("a password reset does not switch the second step off", async () => {
    advance(61 * 60e3);
    h.sent.length = 0;
    await requestReset("owner@shop.test");
    await sleep(60);
    const p = pw(); secretsSeen.push(p);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: linkToken(mailTo("owner@shop.test", /reset your password/)[0]), password: p } })).status, 200);
    ownerPw = p;
    assert.strictEqual((await login("owner@shop.test", ownerPw)).body.code, "two-factor-required");
    const r = await login("owner@shop.test", ownerPw, { totp: code() });
    assert.strictEqual(r.status, 200, r.text);
    owner = r.body.token;
  });

  test("switching it off takes the password and a code; ADMIN_RECOVERY=reset-2fa is the way back in with neither", async () => {
    assert.strictEqual((await h.post("/api/auth/2fa/disable", { password: ownerPw }, owner)).status, 400);
    advance(30_000);
    assert.strictEqual((await h.post("/api/auth/2fa/disable", { password: "Wrong-password-1", code: code() }, owner)).status, 401);
    advance(30_000);
    const off = await h.post("/api/auth/2fa/disable", { password: ownerPw, code: code() }, owner);
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(byEmail("owner@shop.test").totpSecretEnc, null);
    assert.strictEqual((await login("owner@shop.test", ownerPw)).status, 200);
    // Enrol again, then lose the phone and the codes.
    owner = off.body.token;
    setupKey = (await h.post("/api/auth/2fa/setup", { password: ownerPw }, owner)).body.setupKey; secretsSeen.push(setupKey, setupKey.replace(/\s/g, ""));
    advance(30_000);
    const on = await h.post("/api/auth/2fa/enable", { code: code() }, owner);
    assert.strictEqual(on.status, 200, on.text);
    secretsSeen.push(...on.body.recoveryCodes);
    assert.strictEqual((await login("owner@shop.test", ownerPw)).body.code, "two-factor-required");
    process.env.ADMIN_RECOVERY = "reset-2fa";
    try {
      const boot = adminAccount.ensureAtStartup();
      assert.strictEqual(boot.recovery, "reset-2fa");
    } finally { delete process.env.ADMIN_RECOVERY; }
    const row = byEmail("owner@shop.test");
    assert.ok(!row.totpSecretEnc && !row.totpEnabledAt && (row.recoveryCodes || []).length === 0);
    assert.strictEqual((await h.get("/api/admin/stats", on.body.token)).status, 401, "its sessions were ended");
    const r = await login("owner@shop.test", ownerPw);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.role, "admin");
  });

  test("ADMIN_RECOVERY=verify-email confirms the owner's address when no link can be sent; it does nothing for any other account", async () => {
    const row = byEmail("owner@shop.test");
    usersDB.update(row.id, { role: "customer", emailVerifiedAt: null });
    assert.strictEqual(adminAccount.ensureAtStartup().promoted, false);
    process.env.ADMIN_RECOVERY = "verify-email";
    try {
      const boot = adminAccount.ensureAtStartup();
      assert.deepStrictEqual({ recovery: boot.recovery, promoted: boot.promoted }, { recovery: "verify-email", promoted: true });
    } finally { delete process.env.ADMIN_RECOVERY; }
    assert.strictEqual(byEmail("owner@shop.test").role, "admin");
    assert.ok(!byEmail("nomail@buyer.test").emailVerifiedAt, "other unconfirmed accounts are untouched");
    assert.strictEqual(byEmail("nomail@buyer.test").role, "customer");
  });

  test("nothing secret was written to a log: no password, session token, emailed link, setup key or recovery code", async () => {
    const all = logged.join("\n");
    assert.ok(logged.length > 0);
    for (const s of secretsSeen.filter(Boolean)) assert.ok(!all.includes(s), `a secret appeared in a log line (${s.slice(0, 4)}…)`);
    assert.ok(!all.includes(process.env.JWT_SECRET) && !all.includes(process.env.TURNSTILE_SECRET_KEY));
    assert.ok(h.turnstile.calls.every((c) => c.secretSent), "the secret key went to Cloudflare's endpoint and nowhere else");
  });

  await run(async () => { Date.now = realNow; await h.stop(); });
})();
