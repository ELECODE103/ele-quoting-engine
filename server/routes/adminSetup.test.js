/**
 * The admin account (independent review 2026-11-11, F3; F7).
 * Run: node server/routes/adminSetup.test.js
 *
 * Before the fix, whoever registered the ADMIN_EMAIL address first became the admin when the real
 * owner opened the confirmation link that landed in his inbox (or ran ADMIN_RECOVERY=verify-email).
 * Now no public route gives the role, the address cannot be registered, confirmed or reset in
 * public, and the account is made by a one-time setup with a code only the owner can set.
 */
const assert = require("assert");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Admin account: one-time setup");
const pw = () => `Aa1-${crypto.randomBytes(9).toString("base64url")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const h = await start({ mailer: "configured" });
  const { usersDB } = h.models;
  const adminAccount = require("../security/adminAccount");
  const tokens = require("../security/tokens");
  const totp = require("../security/totp");
  const ADMIN = process.env.ADMIN_EMAIL;
  const CODE = process.env.ADMIN_SETUP_CODE;
  const byEmail = (email) => usersDB.getAll().find((u) => u.email === email);
  const regHeaders = () => ({ "X-Form-Token": h.formToken("register"), "X-Turnstile-Token": "pass-register" });
  const resetHeaders = () => ({ "X-Form-Token": h.formToken("password-reset"), "X-Turnstile-Token": "pass-reset" });
  const setup = (body, opts = {}) => h.raw("POST", "/api/auth/admin-setup", { json: body, ...opts });
  const mailTo = (email, re) => h.sent.filter((m) => m.to === email && (!re || re.test(m.subject)));

  const logged = [];
  for (const level of ["log", "warn", "error"]) {
    const real = console[level];
    console[level] = (...args) => { logged.push(args.map(String).join(" ")); real(...args); };
  }

  let dana;
  test("the admin address cannot be registered, and registration, sign-in and reset answer for it exactly as for any other address", async () => {
    dana = await h.register("dana@buyer.test", "Dana");
    h.sent.length = 0;
    // Registration: the same answer as for an address that already has an account.
    const taken = await h.raw("POST", "/api/auth/register", { json: { email: "dana@buyer.test", password: pw(), name: "x" }, headers: regHeaders() });
    const grab = await h.raw("POST", "/api/auth/register", { json: { email: ADMIN, password: pw(), name: "x" }, headers: regHeaders() });
    const shouting = await h.raw("POST", "/api/auth/register", { json: { email: `  ${ADMIN.toUpperCase()} `, password: pw(), name: "x" }, headers: regHeaders() });
    assert.deepStrictEqual([grab.status, grab.body], [taken.status, taken.body]);
    assert.deepStrictEqual([shouting.status, shouting.body], [taken.status, taken.body], "whatever the case or the spaces around it");
    assert.strictEqual(grab.headers.getSetCookie().length, 0, "no session");
    assert.strictEqual(byEmail(ADMIN), undefined, "no account was made for it");
    // Sign-in: the same answer as for an address with no account (which is what it is until setup).
    const nobody = await h.raw("POST", "/api/auth/login", { json: { email: "nobody@nowhere.test", password: "Some-password-1" } });
    const asAdmin = await h.raw("POST", "/api/auth/login", { json: { email: ADMIN, password: "Some-password-1" } });
    assert.deepStrictEqual([asAdmin.status, asAdmin.body], [nobody.status, nobody.body]);
    // Reset: the same answer as always, and nothing is sent.
    const realReset = await h.raw("POST", "/api/auth/password-reset/request", { json: { email: "dana@buyer.test" }, headers: resetHeaders() });
    const adminReset = await h.raw("POST", "/api/auth/password-reset/request", { json: { email: ADMIN }, headers: resetHeaders() });
    assert.deepStrictEqual([adminReset.status, adminReset.body], [realReset.status, realReset.body]);
    await sleep(60);
    assert.strictEqual(mailTo(ADMIN).length, 0, "nothing reaches the owner's inbox from a public form");
    assert.strictEqual(mailTo("dana@buyer.test", /reset your password/).length, 1);
    // And a restart gives nobody the role.
    const boot = adminAccount.ensureAtStartup();
    assert.deepStrictEqual({ promoted: boot.promoted, adminExists: boot.adminExists, setupOpen: boot.setupOpen, setupReason: boot.setupReason }, { promoted: false, adminExists: false, setupOpen: true, setupReason: "first-setup" });
    assert.strictEqual(usersDB.getAll().filter((u) => u.role === "admin").length, 0);
  });

  test("setup needs the owner's code: a wrong code, no code, and a closed setup are one and the same answer; guesses are limited per connection and then for everyone", async () => {
    adminAccount.resetForTests();
    const password = pw();
    const wrong = await setup({ code: "x".repeat(40), password }, { ip: "203.0.113.1" });
    assert.deepStrictEqual([wrong.status, wrong.body.code], [403, "setup-refused"]);
    for (const body of [{ password }, { code: "", password }, { code: 12345, password }, { code: CODE.slice(0, -1), password }, { code: `${CODE}x`, password }, { code: CODE.toUpperCase(), password }, { code: [CODE], password }]) {
      adminAccount.resetForTests();
      const r = await setup(body);
      assert.deepStrictEqual([r.status, r.body], [wrong.status, wrong.body], JSON.stringify(Object.keys(body)));
    }
    // The owner has not set a code, or set one that is too short or too simple: closed, with the same answer, even to the "right" value.
    for (const value of [undefined, "", "short", "a".repeat(40), "abcdefg".repeat(6), "  "]) {
      adminAccount.resetForTests();
      if (value === undefined) delete process.env.ADMIN_SETUP_CODE; else process.env.ADMIN_SETUP_CODE = value;
      try {
        assert.strictEqual(adminAccount.setupState().open, false, String(value));
        const r = await setup({ code: value === undefined ? "" : value, password });
        assert.deepStrictEqual([r.status, r.body], [wrong.status, wrong.body], `code ${JSON.stringify(value)}`);
      } finally { process.env.ADMIN_SETUP_CODE = CODE; }
    }
    assert.strictEqual(byEmail(ADMIN), undefined);
    // One connection: five wrong codes, then nothing more for 15 minutes — not even the right code.
    adminAccount.resetForTests();
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) assert.strictEqual((await setup({ code: `guess-${i}-${"z".repeat(30)}`, password }, { ip })).status, 403);
    const limited = await setup({ code: CODE, password }, { ip });
    assert.deepStrictEqual([limited.status, limited.body.code], [429, "rate-limited"]);
    assert.strictEqual(byEmail(ADMIN), undefined);
    // Everyone together: twenty wrong codes lock setup until the server restarts.
    adminAccount.resetForTests();
    for (let i = 0; i < 20; i++) assert.strictEqual((await setup({ code: `guess-${i}-${"z".repeat(30)}`, password }, { ip: `198.51.100.${i + 1}` })).status, 403);
    const locked = await setup({ code: CODE, password }, { ip: "203.0.113.60" });
    assert.deepStrictEqual([locked.status, locked.body], [wrong.status, wrong.body], "locked: the right code is refused like any other");
    assert.strictEqual(adminAccount.setupState().reason, "locked");
    assert.ok(logged.some((l) => /admin setup is LOCKED after 20 wrong setup codes/.test(l)), "and the owner is told in the log");
    assert.strictEqual(byEmail(ADMIN), undefined);
    adminAccount.resetForTests(); // the restart
  });

  // ── A squatter: an ordinary account that got hold of the admin address before this rule existed ──
  let squatterToken, squatterPw, verifyLink, resetLink;
  test("an ordinary account that already holds the admin address stays ordinary: not confirmed, not reset, not promoted — by its link, by a resend, or by a restart", async () => {
    squatterPw = pw();
    const nonce = crypto.randomBytes(16).toString("hex");
    const row = usersDB.insert({ email: ADMIN, passwordHash: await bcrypt.hash(squatterPw, 4), name: "Squatter", role: "customer", emailVerifiedAt: null, emailVerifyNonce: nonce, tokenVersion: 0, passwordChangedAt: new Date().toISOString() });
    squatterToken = (await h.raw("POST", "/api/auth/login", { json: { email: ADMIN, password: squatterPw } })).body.token;
    assert.ok(squatterToken, "it can sign in — as the customer it is");
    assert.strictEqual((await h.get("/api/admin/stats", squatterToken)).status, 403);
    // The confirmation link the old code mailed to the owner's inbox, and a reset link for the account.
    verifyLink = tokens.sign("email-verify", { uid: row.id, email: ADMIN, n: nonce });
    const keys = require("../security/keys");
    resetLink = tokens.sign("password-reset", { uid: row.id, b: keys.mac("password-reset-bind-v1", `${row.id}:${row.passwordHash}:0`).slice(0, 32) });
    // The owner opens the confirmation link (the attack in the review).
    const v = await h.raw("POST", "/api/auth/verify-email", { json: { token: verifyLink } });
    assert.deepStrictEqual([v.status, v.body.code], [400, "link-invalid"]);
    assert.deepStrictEqual([byEmail(ADMIN).role, byEmail(ADMIN).emailVerifiedAt], ["customer", null]);
    assert.strictEqual((await h.get("/api/auth/session", squatterToken)).body.user.role, "customer", "the squatter's live session is still a customer's");
    // Asking for the link again: the usual answer, and no email to the owner's inbox.
    h.sent.length = 0;
    const control = await h.register("late@buyer.test", "Late", { verify: false });
    h.sent.length = 0;
    const normal = await h.raw("POST", "/api/auth/verify-email/resend", { json: {}, token: control });
    const resend = await h.raw("POST", "/api/auth/verify-email/resend", { json: {}, token: squatterToken });
    assert.deepStrictEqual([resend.status, Object.keys(resend.body).sort(), resend.body.verified], [normal.status, Object.keys(normal.body).sort(), false]);
    assert.strictEqual(mailTo(ADMIN).length, 0);
    // A password reset would confirm the address: not for this account. Same public answers, nothing sent, the link dead.
    await h.raw("POST", "/api/auth/password-reset/request", { json: { email: ADMIN }, headers: resetHeaders() });
    await sleep(60);
    assert.strictEqual(mailTo(ADMIN).length, 0);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/check", { json: { token: resetLink } })).body.valid, false);
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: resetLink, password: pw() } })).status, 400);
    // Restarts, with and without the old recovery switch.
    for (const recovery of [undefined, "verify-email"]) {
      if (recovery) process.env.ADMIN_RECOVERY = recovery;
      try {
        const boot = adminAccount.ensureAtStartup();
        assert.deepStrictEqual({ promoted: boot.promoted, reserved: boot.reserved, adminExists: boot.adminExists }, { promoted: false, reserved: true, adminExists: false });
      } finally { delete process.env.ADMIN_RECOVERY; }
    }
    assert.deepStrictEqual([byEmail(ADMIN).role, byEmail(ADMIN).emailVerifiedAt], ["customer", null]);
    assert.ok(logged.some((l) => /an ordinary account .* already uses the ADMIN_EMAIL address/.test(l)), "the startup log says so");
  });

  let ownerPw, ownerToken;
  test("the one-time setup takes the address over: new password, every old session and link dead, address confirmed, role admin, an audit line — and straight into forced two-step enrolment", async () => {
    adminAccount.resetForTests();
    logged.length = 0;
    const weak = await setup({ code: CODE, password: "password" });
    assert.deepStrictEqual([weak.status, weak.body.code], [400, "weak-password"], "the existing password rules apply");
    assert.strictEqual(byEmail(ADMIN).role, "customer", "nothing happened yet");
    ownerPw = pw();
    // As the setup screen sends it: a browser, which gets its session as a cookie and no token in the body (F7).
    const r = await h.raw("POST", "/api/auth/admin-setup", { json: { code: `  ${CODE}\n`, password: ownerPw }, browser: true });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.token, undefined, "no session token in the JSON for a browser");
    assert.deepStrictEqual([r.body.user.role, r.body.user.emailVerified, r.body.user.twoFactorRequired, r.body.user.twoFactorEnabled], ["admin", true, true, false]);
    const cookies = r.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith("se_session=") && /HttpOnly/.test(c) && /SameSite=Strict/.test(c)));
    const row = byEmail(ADMIN);
    assert.strictEqual(row.role, "admin");
    assert.ok(row.emailVerifiedAt && !row.emailVerifyNonce);
    assert.strictEqual(Number(row.tokenVersion), 1, "the token version moved");
    assert.ok(await bcrypt.compare(ownerPw, row.passwordHash));
    assert.ok(!(await bcrypt.compare(squatterPw, row.passwordHash)));
    // Everything the squatter held is dead.
    assert.strictEqual((await h.get("/api/auth/profile", squatterToken)).status, 401, "the squatter's session");
    assert.strictEqual((await h.raw("POST", "/api/auth/login", { json: { email: ADMIN, password: squatterPw } })).status, 401, "the squatter's password");
    assert.strictEqual((await h.raw("POST", "/api/auth/password-reset/check", { json: { token: resetLink } })).body.valid, false, "the outstanding reset link");
    const v = await h.raw("POST", "/api/auth/verify-email", { json: { token: verifyLink } });
    assert.ok(v.status === 400 || v.body.already === true, "the outstanding confirmation link changes nothing");
    assert.strictEqual(byEmail(ADMIN).role, "admin");
    // Audit: a line in the log and a row in the admin change log; the code is in neither.
    assert.ok(logged.some((l) => /AUDIT admin-setup: the existing account for ADMIN_EMAIL .* was taken over/.test(l)));
    assert.ok(logged.some((l) => /Remove ADMIN_SETUP_CODE/.test(l)));
    assert.ok(!logged.join("\n").includes(CODE) && !logged.join("\n").includes(ownerPw), "neither the code nor the password is logged");
    assert.ok(row.setupCodeMac && row.setupCodeMac !== CODE && !JSON.stringify(row).includes(CODE), "only a keyed hash of the code is kept");
    assert.ok(h.models.adminAuditDB.getAll().some((e) => e.area === "admin-account" && e.action === "takeover"));
    // Forced enrolment: the admin pages are shut until two-step sign-in is on.
    ownerToken = (await h.raw("POST", "/api/auth/login", { json: { email: ADMIN, password: ownerPw } })).body.token;
    const shut = await h.get("/api/admin/stats", ownerToken);
    assert.deepStrictEqual([shut.status, shut.body.code], [403, "two-factor-enrolment-required"]);
    const key = (await h.post("/api/auth/2fa/setup", { password: ownerPw }, ownerToken)).body.setupKey.replace(/\s/g, "");
    const on = await h.post("/api/auth/2fa/enable", { code: totp.codeAt(key) }, ownerToken);
    assert.strictEqual(on.status, 200, on.text);
    ownerToken = on.body.token;
    h.adminSecret = key; h.adminPassword = ownerPw;
    assert.strictEqual((await h.get("/api/admin/stats", ownerToken)).status, 200);
  });

  test("setup works once: the same code again, a new code, and a restart all leave the existing admin exactly as it is", async () => {
    adminAccount.resetForTests();
    const before = JSON.stringify(byEmail(ADMIN));
    const refused = await setup({ code: "x".repeat(40), password: pw() });
    const again = await setup({ code: CODE, password: pw() });
    assert.deepStrictEqual([again.status, again.body], [refused.status, refused.body], "the used code is refused like any wrong code");
    process.env.ADMIN_SETUP_CODE = `fresh-${crypto.randomBytes(18).toString("base64url")}`;
    try {
      assert.deepStrictEqual(adminAccount.setupState(), { open: false, reason: "admin-exists", recovery: false });
      const other = await setup({ code: process.env.ADMIN_SETUP_CODE, password: pw() });
      assert.deepStrictEqual([other.status, other.body], [refused.status, refused.body], "a new code does nothing while an admin exists");
      logged.length = 0;
      const boot = adminAccount.ensureAtStartup();
      assert.deepStrictEqual({ promoted: boot.promoted, adminExists: boot.adminExists, setupOpen: boot.setupOpen }, { promoted: false, adminExists: true, setupOpen: false });
      assert.ok(logged.some((l) => /ADMIN_SETUP_CODE is still set/.test(l) && /remove it/.test(l)), "the startup log tells the owner to remove the variable");
      assert.ok(!logged.join("\n").includes(process.env.ADMIN_SETUP_CODE));
    } finally { process.env.ADMIN_SETUP_CODE = CODE; }
    assert.strictEqual(JSON.stringify(byEmail(ADMIN)), before, "the admin row is byte for byte what it was");
    assert.strictEqual((await h.get("/api/admin/stats", ownerToken)).status, 200, "and its session still works");
    // Still not registrable, and a customer's confirmation never touches a role.
    assert.strictEqual((await h.raw("POST", "/api/auth/register", { json: { email: ADMIN, password: pw(), name: "x" }, headers: regHeaders() })).status, 409);
    assert.strictEqual(byEmail("dana@buyer.test").role, "customer");
    assert.strictEqual(usersDB.getAll().filter((u) => u.role === "admin").length, 1);
  });

  test("ADMIN_RECOVERY=setup-code, with a new code, is the way back in without email: a new password, sessions ended, two-step cleared and enrolled again", async () => {
    adminAccount.resetForTests();
    const fresh = `again-${crypto.randomBytes(18).toString("base64url")}`;
    process.env.ADMIN_SETUP_CODE = fresh;
    process.env.ADMIN_RECOVERY = "setup-code";
    try {
      assert.deepStrictEqual(adminAccount.setupState(), { open: true, reason: "recovery", recovery: true });
      logged.length = 0;
      assert.strictEqual(adminAccount.ensureAtStartup().recovery, "setup-code");
      assert.ok(logged.some((l) => /one-time admin setup is OPEN/.test(l) && /remove ADMIN_RECOVERY/.test(l)));
      const newPw = pw();
      assert.strictEqual((await setup({ code: CODE, password: newPw })).status, 403, "the old, used code does not work in recovery either");
      const r = await setup({ code: fresh, password: newPw });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual((await h.get("/api/admin/stats", ownerToken)).status, 401, "the old session is over");
      assert.strictEqual((await h.raw("POST", "/api/auth/login", { json: { email: ADMIN, password: ownerPw } })).status, 401, "the old password too");
      const row = byEmail(ADMIN);
      assert.ok(row.role === "admin" && !row.totpSecretEnc && !row.totpEnabledAt, "two-step starts from nothing");
      assert.deepStrictEqual([(await h.get("/api/admin/stats", r.body.token)).body.code], ["two-factor-enrolment-required"]);
      assert.strictEqual((await setup({ code: fresh, password: pw() })).status, 403, "and that code is spent");
      ownerPw = newPw;
    } finally { process.env.ADMIN_SETUP_CODE = CODE; delete process.env.ADMIN_RECOVERY; }
  });

  test("F7: the session token is in the JSON only for a caller that asks for it; the browser app never gets it", async () => {
    const browser = await h.raw("POST", "/api/auth/login", { json: { email: "dana@buyer.test", password: h.password }, browser: true });
    assert.strictEqual(browser.status, 200, browser.text);
    assert.strictEqual(browser.body.token, undefined);
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(browser.text), "nothing that looks like a signed token is in the body");
    assert.ok(browser.body.csrfToken && browser.body.user.email === "dana@buyer.test", "the page still gets what it uses");
    const cookie = browser.headers.getSetCookie().find((c) => c.startsWith("se_session=")).split(";")[0];
    assert.strictEqual((await h.raw("GET", "/api/auth/profile", { headers: { Cookie: cookie }, browser: true })).status, 200, "the cookie is the session");
    const reg = await h.raw("POST", "/api/auth/register", { json: { email: "new@buyer.test", password: pw(), name: "New" }, headers: regHeaders(), browser: true });
    assert.deepStrictEqual([reg.status, reg.body.token], [201, undefined]);
    // An API client asks, and gets it.
    const api = await h.raw("POST", "/api/auth/login", { json: { email: "dana@buyer.test", password: h.password } });
    assert.ok(typeof api.body.token === "string" && api.body.token.split(".").length === 3);
    assert.strictEqual((await h.get("/api/auth/profile", api.body.token)).status, 200);
    // Nothing in the client reads a token from a response.
    const fs = require("fs"), path = require("path");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : []));
    for (const file of walk(path.join(__dirname, "..", "..", "client", "src"))) {
      const src = fs.readFileSync(file, "utf8");
      assert.ok(!/\b(res|result|data|body|r|response|session)\.token\b/.test(src) && !/X-Session-Token/i.test(src), `${path.basename(file)} reads a session token`);
    }
  });

  await run(() => h.stop());
})();
