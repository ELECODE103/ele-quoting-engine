/**
 * Unit tests for the account and bot-defence building blocks.
 * Run: `node server/security/security.test.js`
 *
 * No network: the Turnstile and Resend calls are stubbed. Every key, password
 * and token here is made at run time (Cloudflare's published dummy keys are
 * named only to prove they are refused in production).
 */
const assert = require("assert");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = `unit-${crypto.randomBytes(12).toString("hex")}`;
process.env.NODE_ENV = "test";

const { runner } = require("../testSupport/harness");
const keys = require("./keys");
const totp = require("./totp");
const passwords = require("./passwords");
const secretBox = require("./secretBox");
const tokens = require("./tokens");
const turnstile = require("./turnstile");
const { createThrottle, createTtlStore } = require("./throttle");
const loginGuard = require("./loginGuard");
const botGuard = require("./botGuard");
const { accountLinkBase } = require("./links");
const rfqToken = require("../services/rfqToken");
const mailer = require("../services/mailer");
const templates = require("../emails/templates");

const { test, run } = runner("Security building blocks");

// ─── TOTP (RFC 6238 / RFC 4226) ────────────────────────────────
test("TOTP matches the RFC 6238 test vectors (SHA-1, 8 digits)", () => {
  const secret = Buffer.from("12345678901234567890");
  const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [seconds, expected] of vectors) {
    assert.strictEqual(totp.hotp(secret, Math.floor(seconds / 30), { digits: 8 }), expected, `T=${seconds}`);
  }
});

test("HOTP matches the RFC 4226 test vectors (6 digits)", () => {
  const secret = Buffer.from("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.strictEqual(totp.hotp(secret, counter), code));
});

test("base32 round-trips, and a generated secret is 160 bits", () => {
  for (const n of [1, 5, 10, 20, 33]) {
    const buf = crypto.randomBytes(n);
    assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  }
  assert.strictEqual(totp.base32Encode(Buffer.from("foobar")), "MZXW6YTBOI"); // RFC 4648, unpadded
  const secret = totp.generateSecret();
  assert.ok(/^[A-Z2-7]{32}$/.test(secret));
  assert.strictEqual(totp.base32Decode(secret).length, 20);
});

test("a code is accepted one step either side, refused outside that, and never twice", () => {
  const secret = totp.generateSecret();
  const t = 1_800_000_000_000;
  const code = totp.codeAt(secret, t);
  const step = totp.stepAt(t);
  assert.strictEqual(totp.verify(secret, code, { timeMs: t }), step);
  assert.strictEqual(totp.verify(secret, code, { timeMs: t + 30_000 }), step, "one step late");
  assert.strictEqual(totp.verify(secret, code, { timeMs: t - 30_000 }), step, "one step early");
  assert.strictEqual(totp.verify(secret, code, { timeMs: t + 90_000 }), null, "three steps late");
  assert.strictEqual(totp.verify(secret, code, { timeMs: t, lastStep: step }), null, "replay of an accepted code");
  assert.strictEqual(totp.verify(secret, code, { timeMs: t, lastStep: step - 1 }), step);
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined, 123456.5]) assert.strictEqual(totp.verify(secret, bad, { timeMs: t }), null);
  assert.strictEqual(totp.verify("not base32 !!", code, { timeMs: t }), null);
});

test("the otpauth URI names the issuer and account and carries the secret once", () => {
  const uri = totp.otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "owner@shop.test", issuer: "Straightedge" });
  assert.ok(uri.startsWith("otpauth://totp/Straightedge:owner%40shop.test?"));
  assert.ok(uri.includes("secret=JBSWY3DPEHPK3PXP") && uri.includes("issuer=Straightedge") && uri.includes("digits=6") && uri.includes("period=30"));
});

test("recovery codes: ten, distinct, unambiguous characters, compared without dashes or case", () => {
  const codes = totp.generateRecoveryCodes(10);
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  for (const c of codes) assert.ok(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c), c);
  assert.strictEqual(totp.normalizeRecoveryCode(" abcde-fgh23 "), "ABCDEFGH23");
});

// ─── Passwords ─────────────────────────────────────────────────
test("password rules: length first, the existing three classes, nothing more", () => {
  assert.ok(/at least 10 characters/.test(passwords.problem("Sh0rtpass")));
  assert.ok(/upper-case/.test(passwords.problem("alllowercase12")));
  assert.ok(/lower-case/.test(passwords.problem("ALLUPPERCASE12")));
  assert.ok(/one number/.test(passwords.problem("NoDigitsHereAtAll")));
  assert.strictEqual(passwords.problem("Brass-Kettle-41"), null);
  assert.strictEqual(passwords.problem("correct Horse battery 9"), null, "no symbol is demanded; spaces are fine");
});

test("the most-used passwords are refused whatever their capitalisation", () => {
  assert.ok(passwords.commonCount() > 5000, "a few thousand entries are bundled");
  for (const pw of ["Password12", "Qwertyuiop1", "Basketball1", "Password123"]) {
    const lower = pw.toLowerCase();
    // Only assert on entries that are in the bundled list.
    if (require("fs").readFileSync(require("path").join(__dirname, "common-passwords.txt"), "utf8").split("\n").includes(lower)) {
      assert.ok(/most-used/.test(passwords.problem(pw)), pw);
    }
  }
  assert.ok(/most-used/.test(passwords.problem("Password12")), "password12 is on the list");
});

test("a password made of the email address, our name, or one character is refused; over 72 bytes is refused, not cut", () => {
  assert.ok(/email address/.test(passwords.problem("Danabuyer2026x", { email: "danabuyer@plant.test" })));
  assert.ok(/our name/.test(passwords.problem("Straightedge2026")));
  assert.ok(passwords.problem("A" + "a".repeat(60) + "1" + "b".repeat(20)) && /72 characters or fewer/.test(passwords.problem("A" + "a".repeat(60) + "1" + "b".repeat(20))));
  assert.strictEqual(passwords.problem("Aa1" + "x".repeat(69)), null, "exactly 72 bytes is fine");
});

// ─── Keys, sealed secrets, signed tokens ───────────────────────
test("derived keys differ per purpose and from JWT_SECRET", () => {
  const a = keys.derive("one"), b = keys.derive("two");
  assert.ok(!a.equals(b));
  assert.ok(!a.equals(Buffer.from(process.env.JWT_SECRET)));
  assert.strictEqual(keys.safeEqual("abc", "abc"), true);
  assert.strictEqual(keys.safeEqual("abc", "abd"), false);
  assert.strictEqual(keys.safeEqual("abc", "abcd"), false);
});

test("a sealed two-factor secret opens only for the same account and the same JWT_SECRET; tampering is detected", () => {
  const secret = totp.generateSecret();
  const sealed = secretBox.seal("totp", secret, "user-1");
  assert.ok(!sealed.includes(secret), "ciphertext, not the secret");
  assert.strictEqual(secretBox.open("totp", sealed, "user-1"), secret);
  assert.strictEqual(secretBox.open("totp", sealed, "user-2"), null, "copied to another account");
  assert.strictEqual(secretBox.open("other", sealed, "user-1"), null, "another purpose");
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.strictEqual(secretBox.open("totp", parts.join("."), "user-1"), null);
  assert.notStrictEqual(secretBox.seal("totp", secret, "user-1"), sealed, "a fresh nonce every time");
  const keep = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "another-secret";
  try { assert.strictEqual(secretBox.open("totp", sealed, "user-1"), null); } finally { process.env.JWT_SECRET = keep; }
  for (const junk of ["", null, "v1.a.b", "v2.a.b.c"]) assert.strictEqual(secretBox.open("totp", junk, "user-1"), null);
});

test("one kind of signed token never passes as another, as a session, or as a firm-quote link", () => {
  const human = tokens.sign("human", {});
  const form = tokens.sign("form", { form: "rfq" });
  const verify = tokens.sign("email-verify", { uid: "u1", email: "a@b.test", n: "n" });
  const reset = tokens.sign("password-reset", { uid: "u1", b: "x" });
  const all = { human, form, "email-verify": verify, "password-reset": reset };
  for (const [kind, token] of Object.entries(all)) {
    for (const other of Object.keys(all)) {
      assert.strictEqual(tokens.verify(other, token).ok, other === kind, `${kind} presented as ${other}`);
    }
    // Not a session (sessions are signed with JWT_SECRET itself)…
    assert.throws(() => jwt.verify(token, process.env.JWT_SECRET));
    // …and not a firm-quote link.
    assert.strictEqual(rfqToken.verify(token), null);
  }
  // A session token, and a firm-quote link, are refused as every kind.
  const sessionToken = jwt.sign({ userId: "u1", jti: "j", tv: 0 }, process.env.JWT_SECRET, { expiresIn: 60 });
  const quoteLink = rfqToken.sign({ id: "r1", quoteSentAt: new Date().toISOString(), validUntil: new Date(Date.now() + 864e5).toISOString() });
  for (const kind of Object.keys(all)) {
    assert.strictEqual(tokens.verify(kind, sessionToken).ok, false);
    assert.strictEqual(tokens.verify(kind, quoteLink).ok, false);
  }
  assert.throws(() => jwt.verify(quoteLink, process.env.JWT_SECRET), "a firm-quote link is not a session");
});

test("signed tokens expire: human 1 h, form 12 h, confirm-email 24 h, reset 1 h; tampering is refused", () => {
  const ago = (ms) => ({ now: Date.now() - ms });
  assert.strictEqual(tokens.verify("human", tokens.sign("human", {}, ago(59 * 60e3))).ok, true);
  assert.deepStrictEqual(tokens.verify("human", tokens.sign("human", {}, ago(61 * 60e3))), { ok: false, reason: "expired" });
  assert.strictEqual(tokens.verify("email-verify", tokens.sign("email-verify", {}, ago(23.9 * 3600e3))).ok, true);
  assert.strictEqual(tokens.verify("email-verify", tokens.sign("email-verify", {}, ago(24.1 * 3600e3))).reason, "expired");
  assert.strictEqual(tokens.verify("password-reset", tokens.sign("password-reset", {}, ago(59 * 60e3))).ok, true);
  assert.strictEqual(tokens.verify("password-reset", tokens.sign("password-reset", {}, ago(61 * 60e3))).reason, "expired");
  const t = tokens.sign("password-reset", { uid: "u1" });
  const [h, p, s] = t.split(".");
  const forged = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), uid: "u2" })).toString("base64url"), s].join(".");
  assert.deepStrictEqual(tokens.verify("password-reset", forged), { ok: false, reason: "invalid" });
  const none = [Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"), p, ""].join(".");
  assert.strictEqual(tokens.verify("password-reset", none).ok, false, "alg none");
  for (const junk of ["", null, 12, "a.b.c", "x".repeat(5000)]) assert.strictEqual(tokens.verify("human", junk).ok, false);
});

test("a part's edit key opens that part only", () => {
  const k = tokens.partEditKey("part-1");
  assert.ok(tokens.partEditKeyOk("part-1", k));
  assert.ok(!tokens.partEditKeyOk("part-2", k));
  for (const junk of ["", undefined, null, k + "0", 5]) assert.ok(!tokens.partEditKeyOk("part-1", junk));
});

// ─── Throttles ─────────────────────────────────────────────────
test("throttle: counts inside the window, frees up as it slides, says how long to wait", () => {
  const t = createThrottle({ windowMs: 1000, max: 3 });
  assert.strictEqual(t.hit("a", 0).limited, false);
  t.hit("a", 100);
  const third = t.hit("a", 200);
  assert.strictEqual(third.limited, true);
  assert.strictEqual(third.retryAfterMs, 800);
  assert.strictEqual(t.peek("b", 200).count, 0, "keys are independent");
  assert.strictEqual(t.peek("a", 1001).limited, false, "the oldest hit left the window");
  assert.strictEqual(t.peek("a", 1001).count, 2);
  t.reset("a");
  assert.strictEqual(t.peek("a", 1001).count, 0);
  const s = createTtlStore({ ttlMs: 1000 });
  s.set("k", "v", 0);
  assert.strictEqual(s.get("k", 999), "v");
  assert.strictEqual(s.get("k", 1000), undefined);
});

test("login guard: failures only; challenge after 3; the address pauses at 5 and the IP at 20", () => {
  loginGuard.resetForTests();
  const ip = "203.0.113.5", who = "dana@buyer.test";
  const t0 = 1_000_000;
  assert.strictEqual(loginGuard.challengeDue(ip, who, t0), false);
  for (let i = 0; i < 2; i++) assert.strictEqual(loginGuard.recordFailure(ip, who, t0 + i).locked, false);
  assert.strictEqual(loginGuard.challengeDue(ip, who, t0 + 2), false, "two failures: no challenge yet");
  loginGuard.recordFailure(ip, who, t0 + 3);
  assert.strictEqual(loginGuard.challengeDue(ip, who, t0 + 4), true, "three failures: challenge");
  assert.strictEqual(loginGuard.challengeDue("198.51.100.9", who, t0 + 4), true, "…for that address from any IP");
  assert.strictEqual(loginGuard.challengeDue(ip, "someone@else.test", t0 + 4), true, "…and for that IP whatever the address");
  loginGuard.recordFailure(ip, who, t0 + 5);
  assert.strictEqual(loginGuard.lockedUntil(who, null, t0 + 6), 0);
  const fifth = loginGuard.recordFailure(ip, who, t0 + 7);
  assert.strictEqual(fifth.locked, true);
  assert.strictEqual(fifth.until, t0 + 7 + 15 * 60e3);
  assert.strictEqual(loginGuard.lockedUntil(who, null, t0 + 8), fifth.until, "paused, account or no account");
  assert.strictEqual(loginGuard.lockedUntil(who, null, fifth.until + 1), 0, "the pause ends by itself");
  // A pause written to the account row counts after a restart (memory empty).
  loginGuard.resetForTests();
  const stored = new Date(t0 + 60e3).toISOString();
  assert.strictEqual(loginGuard.lockedUntil(who, { lockedUntil: stored }, t0), t0 + 60e3);
  assert.strictEqual(loginGuard.lockedUntil(who, { lockedUntil: stored }, t0 + 61e3), 0);
  // Many addresses from one IP: the IP is stopped at 20 failures.
  for (let i = 0; i < 19; i++) loginGuard.recordFailure(ip, `u${i}@x.test`, t0);
  assert.strictEqual(loginGuard.ipBlocked(ip, t0), false);
  loginGuard.recordFailure(ip, "u19@x.test", t0);
  assert.strictEqual(loginGuard.ipBlocked(ip, t0), true);
  assert.strictEqual(loginGuard.ipBlocked(ip, t0 + 15 * 60e3 + 1), false);
  loginGuard.clear(who);
  loginGuard.resetForTests();
});

// ─── Turnstile ─────────────────────────────────────────────────
function withTurnstile(env, fn) {
  const keep = { s: process.env.TURNSTILE_SITE_KEY, k: process.env.TURNSTILE_SECRET_KEY, n: process.env.NODE_ENV };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  return Promise.resolve().then(fn).finally(() => {
    turnstile.setFetchForTests();
    for (const [k, v] of [["TURNSTILE_SITE_KEY", keep.s], ["TURNSTILE_SECRET_KEY", keep.k], ["NODE_ENV", keep.n]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}
const KEYS = { TURNSTILE_SITE_KEY: `site-${crypto.randomBytes(6).toString("hex")}`, TURNSTILE_SECRET_KEY: `secret-${crypto.randomBytes(12).toString("hex")}` };

test("Turnstile is off without both keys, and verify() then verifies nothing", () => withTurnstile({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined }, async () => {
  assert.strictEqual(turnstile.configured(), false);
  assert.strictEqual(turnstile.siteKey(), "");
  let called = 0;
  turnstile.setFetchForTests(async () => { called++; return { ok: true, json: async () => ({ success: true }) }; });
  assert.deepStrictEqual(await turnstile.verify("anything"), { ok: false, reason: "off", codes: [] });
  assert.strictEqual(called, 0);
  process.env.TURNSTILE_SITE_KEY = KEYS.TURNSTILE_SITE_KEY;
  assert.strictEqual(turnstile.configured(), false, "site key alone is not enough");
}));

test("every token is checked with Cloudflare: secret, token and caller address are posted to siteverify", () => withTurnstile(KEYS, async () => {
  const calls = [];
  turnstile.setFetchForTests(async (url, init) => { calls.push({ url, body: new URLSearchParams(String(init.body)), method: init.method, signal: init.signal }); return { ok: true, json: async () => ({ success: true, action: "rfq" }) }; });
  assert.strictEqual(turnstile.configured(), true);
  assert.strictEqual(turnstile.siteKey(), KEYS.TURNSTILE_SITE_KEY);
  assert.deepStrictEqual(await turnstile.verify("tok-1", { ip: "203.0.113.4", action: "rfq" }), { ok: true, reason: "ok", codes: [] });
  assert.strictEqual(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].body.get("secret"), KEYS.TURNSTILE_SECRET_KEY);
  assert.strictEqual(calls[0].body.get("response"), "tok-1");
  assert.strictEqual(calls[0].body.get("remoteip"), "203.0.113.4");
  assert.ok(calls[0].signal, "the call carries an abort signal (timeout)");
  // A token solved for another form is refused.
  assert.strictEqual((await turnstile.verify("tok-2", { action: "register" })).ok, false);
}));

test("fail closed: a missing, oversized or rejected token, an HTTP error, garbage, a network error and a timeout all fail", () => withTurnstile(KEYS, async () => {
  let called = 0;
  turnstile.setFetchForTests(async () => { called++; return { ok: true, json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }) }; });
  for (const t of ["", undefined, null, 42, "x".repeat(2049)]) assert.strictEqual((await turnstile.verify(t)).reason, "missing");
  assert.strictEqual(called, 0, "nothing is sent for a token that cannot be one");
  assert.deepStrictEqual(await turnstile.verify("bad"), { ok: false, reason: "rejected", codes: ["invalid-input-response"] });
  turnstile.setFetchForTests(async () => ({ ok: true, json: async () => ({ success: false, "error-codes": ["timeout-or-duplicate"] }) }));
  assert.strictEqual((await turnstile.verify("spent")).reason, "rejected", "a token already used");
  turnstile.setFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.strictEqual((await turnstile.verify("t")).reason, "unavailable");
  turnstile.setFetchForTests(async () => ({ ok: true, json: async () => "nonsense" }));
  assert.strictEqual((await turnstile.verify("t")).ok, false);
  turnstile.setFetchForTests(async () => ({ ok: true, json: async () => ({ success: "true" }) }));
  assert.strictEqual((await turnstile.verify("t")).ok, false, "success must be the boolean true");
  turnstile.setFetchForTests(async () => { throw new Error("ECONNRESET"); });
  assert.deepStrictEqual(await turnstile.verify("t"), { ok: false, reason: "unavailable", codes: ["network-error"] });
  // Our own bad secret is an outage to fix, not a robot.
  const realError = console.error; console.error = () => {};
  try {
    turnstile.setFetchForTests(async () => ({ ok: true, json: async () => ({ success: false, "error-codes": ["invalid-input-secret"] }) }));
    assert.strictEqual((await turnstile.verify("t")).reason, "unavailable");
  } finally { console.error = realError; }
  // Timeout: a call that never answers is aborted.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === turnstile.TIMEOUT_MS ? 20 : ms, ...rest);
  try {
    turnstile.setFetchForTests((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    assert.deepStrictEqual(await turnstile.verify("slow"), { ok: false, reason: "unavailable", codes: ["timeout"] });
  } finally { global.setTimeout = realSetTimeout; }
}));

test("Cloudflare's public test keys count as 'not configured' in production", async () => {
  await withTurnstile({ TURNSTILE_SITE_KEY: turnstile.DUMMY_SITE_KEYS[0], TURNSTILE_SECRET_KEY: turnstile.DUMMY_SECRETS[0], NODE_ENV: "production" }, async () => {
    assert.strictEqual(turnstile.usingDummyKeys(), true);
    assert.strictEqual(turnstile.configured(), false);
    assert.strictEqual(turnstile.siteKey(), "");
    const lines = require("./index").startupWarnings(() => {});
    assert.ok(lines.some((l) => /BOT CHECK IS OFF/.test(l) && /TEST keys/.test(l)));
  });
  await withTurnstile({ TURNSTILE_SITE_KEY: turnstile.DUMMY_SITE_KEYS[0], TURNSTILE_SECRET_KEY: turnstile.DUMMY_SECRETS[0], NODE_ENV: "test" }, async () => {
    assert.strictEqual(turnstile.configured(), true, "usable in tests and local development");
  });
});

test("startup warning: with no keys it names each check that is off and what still runs; with keys and mail it says nothing", async () => {
  const keepMail = { k: process.env.EMAIL_API_KEY, f: process.env.EMAIL_FROM };
  try {
    delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM;
    await withTurnstile({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET_KEY: undefined }, async () => {
      const text = require("./index").startupWarnings(() => {}).join("\n");
      for (const needle of ["BOT CHECK IS OFF", "registration", "firm-quote form and send-us-the-part form", "password-reset request", "sign-in", "CAD upload and pricing", "UNVERIFIED SENDER", "honeypot", "minimum time to submit", "duplicate-submission"]) {
        assert.ok(text.includes(needle), `mentions ${needle}`);
      }
      assert.ok(/EMAIL VERIFICATION AND PASSWORD RESET CANNOT WORK/.test(text) && /checkout is NOT held back/.test(text));
      assert.ok(!text.includes(process.env.JWT_SECRET), "no secret in the warning");
    });
    process.env.EMAIL_API_KEY = "test-not-a-key"; process.env.EMAIL_FROM = "Straightedge <quotes@shop.test>";
    await withTurnstile(KEYS, async () => {
      const lines = require("./index").startupWarnings(() => {});
      assert.deepStrictEqual(lines, []);
    });
  } finally {
    for (const [k, v] of [["EMAIL_API_KEY", keepMail.k], ["EMAIL_FROM", keepMail.f]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ─── Form guard ────────────────────────────────────────────────
function fakeReq({ body = {}, headers = {}, ip = "203.0.113.50" } = {}) {
  return { body, headers, ip, socket: {} };
}

test("form token: refused when missing, forged, for another form, too young or too old", () => {
  botGuard.resetForTests();
  assert.strictEqual(botGuard.checkFormToken(undefined, "rfq").code, "form-token-missing");
  assert.strictEqual(botGuard.checkFormToken(tokens.sign("human", {}), "rfq").code, "form-token-missing");
  assert.strictEqual(botGuard.checkFormToken(botGuard.issueFormToken("register", { now: Date.now() - 10e3 }), "rfq").code, "form-token-missing");
  assert.strictEqual(botGuard.checkFormToken(botGuard.issueFormToken("rfq"), "rfq").code, "too-fast", "posted the instant the form loaded");
  assert.strictEqual(botGuard.checkFormToken(botGuard.issueFormToken("rfq", { now: Date.now() - 2000 }), "rfq").code, "too-fast");
  assert.strictEqual(botGuard.checkFormToken(botGuard.issueFormToken("rfq", { now: Date.now() - 4000 }), "rfq").ok, true);
  assert.strictEqual(botGuard.checkFormToken(botGuard.issueFormToken("rfq", { now: Date.now() - 13 * 3600e3 }), "rfq").code, "form-expired");
});

test("form guard: honeypot, single use, duplicate replay, per-IP and per-address limits", () => {
  botGuard.resetForTests();
  const token = () => botGuard.issueFormToken("rfq", { now: Date.now() - 10e3 });
  // Honeypot filled: flagged before anything else is looked at.
  assert.deepStrictEqual(botGuard.checkForm(fakeReq({ body: { [botGuard.HONEYPOT_FIELD]: "http://spam.example" } }), { form: "rfq", email: "a@b.test" }), { ok: false, honeypot: true });
  assert.strictEqual(botGuard.checkForm(fakeReq({ body: { [botGuard.HONEYPOT_FIELD]: "  " }, headers: { "x-form-token": token() } }), { form: "rfq", email: "a@b.test" }).ok, true, "whitespace is not a fill");

  // Single use + replay of the same submission.
  const t1 = token();
  const req = () => fakeReq({ headers: { "x-form-token": t1 } });
  const first = botGuard.checkForm(req(), { form: "rfq", email: "a@b.test", dedupe: ["Dana", "notes"] });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.replay, null);
  assert.strictEqual(botGuard.checkForm(req(), { form: "rfq", email: "a@b.test", dedupe: ["Dana", "other"] }).code, "form-reused", "in flight: a second request with the token waits");
  botGuard.recordForm(req(), first, { email: "a@b.test", response: { rfqId: "r-1" } });
  const again = botGuard.checkForm(req(), { form: "rfq", email: "A@B.test ", dedupe: ["Dana", "notes"] });
  assert.deepStrictEqual(again.replay, { rfqId: "r-1" }, "the same request again gets the first answer");
  assert.strictEqual(botGuard.checkForm(req(), { form: "rfq", email: "a@b.test", dedupe: ["Dana", "different notes"] }).code, "form-reused", "a spent token cannot carry a new request");
  // A fresh token with the same content inside half an hour is still the same request.
  assert.deepStrictEqual(botGuard.checkForm(fakeReq({ headers: { "x-form-token": token() } }), { form: "rfq", email: "a@b.test", dedupe: ["Dana", "notes"] }).replay, { rfqId: "r-1" });

  // A refused submission gives the token back.
  const t2 = token();
  const c2 = botGuard.checkForm(fakeReq({ headers: { "x-form-token": t2 } }), { form: "rfq", email: "z@b.test" });
  botGuard.releaseForm(c2);
  assert.strictEqual(botGuard.checkForm(fakeReq({ headers: { "x-form-token": t2 } }), { form: "rfq", email: "z@b.test" }).ok, true);

  // Per address: 6 an hour, whatever the IP.
  botGuard.resetForTests();
  for (let i = 0; i < 6; i++) {
    const r = fakeReq({ headers: { "x-form-token": token() }, ip: `198.51.100.${i + 1}` });
    const c = botGuard.checkForm(r, { form: "rfq", email: "busy@b.test" });
    assert.strictEqual(c.ok, true, `request ${i + 1}`);
    botGuard.recordForm(r, c, { email: "busy@b.test" });
  }
  const seventh = botGuard.checkForm(fakeReq({ headers: { "x-form-token": token() }, ip: "198.51.100.99" }), { form: "rfq", email: "Busy@B.test" });
  assert.strictEqual(seventh.status, 429);
  assert.ok(/224-213-6727/.test(seventh.error), "the refusal gives the phone number");

  // Per IP: 10 an hour, whatever the address.
  botGuard.resetForTests();
  for (let i = 0; i < 10; i++) {
    const r = fakeReq({ headers: { "x-form-token": token() } });
    const c = botGuard.checkForm(r, { form: "rfq", email: `p${i}@b.test` });
    assert.strictEqual(c.ok, true);
    botGuard.recordForm(r, c, { email: `p${i}@b.test` });
  }
  assert.strictEqual(botGuard.checkForm(fakeReq({ headers: { "x-form-token": token() } }), { form: "rfq", email: "new@b.test" }).status, 429);
  botGuard.resetForTests();
});

test("confirmation emails are capped per recipient (4 a day) and per IP (8 a day)", () => {
  botGuard.resetForTests();
  for (let i = 0; i < 4; i++) assert.strictEqual(botGuard.allowConfirmationEmail(fakeReq({ ip: `198.51.100.${i}` }), "target@victim.test"), true);
  assert.strictEqual(botGuard.allowConfirmationEmail(fakeReq({ ip: "198.51.100.77" }), "Target@Victim.test"), false, "fifth to the same address, from anywhere");
  botGuard.resetForTests();
  for (let i = 0; i < 8; i++) assert.strictEqual(botGuard.allowConfirmationEmail(fakeReq(), `r${i}@x.test`), true);
  assert.strictEqual(botGuard.allowConfirmationEmail(fakeReq(), "r9@x.test"), false, "ninth from the same IP, to anyone");
  assert.strictEqual(botGuard.allowConfirmationEmail(fakeReq(), ""), false);
  botGuard.resetForTests();
});

// ─── Links ─────────────────────────────────────────────────────
test("account links never take their host from a forged Host header in production", () => {
  const keep = { f: process.env.FRONTEND_URL, n: process.env.NODE_ENV, r: process.env.RAILWAY_PUBLIC_DOMAIN };
  const req = (host) => ({ protocol: "https", get: (h) => (h.toLowerCase() === "host" ? host : undefined) });
  try {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://straightedgemfg.com/";
    assert.strictEqual(accountLinkBase(req("evil.example")), "https://straightedgemfg.com");
    delete process.env.FRONTEND_URL;
    assert.strictEqual(accountLinkBase(req("evil.example")), "https://straightedgemfg.com", "unknown host → the brand URL");
    assert.strictEqual(accountLinkBase(req("www.straightedgemfg.com")), "https://www.straightedgemfg.com");
    assert.strictEqual(accountLinkBase(req("nordmfg.com")), "https://nordmfg.com");
    process.env.RAILWAY_PUBLIC_DOMAIN = "straightedge-production.up.railway.app";
    assert.strictEqual(accountLinkBase(req("straightedge-production.up.railway.app")), "https://straightedge-production.up.railway.app");
    process.env.NODE_ENV = "test";
    assert.strictEqual(accountLinkBase({ protocol: "http", get: () => "localhost:3091" }), "http://localhost:3091");
  } finally {
    for (const [k, v] of [["FRONTEND_URL", keep.f], ["NODE_ENV", keep.n], ["RAILWAY_PUBLIC_DOMAIN", keep.r]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ─── Mailer and templates ──────────────────────────────────────
test("a recipient is exactly one plain address; a subject is exactly one line", () => {
  assert.strictEqual(mailer.cleanAddress(" Dana.Buyer+rfq@plant.example.com "), "Dana.Buyer+rfq@plant.example.com");
  for (const bad of ["a@b", "a@b.co,c@d.co", "a@b.co;c@d.co", "\"Dana\" <a@b.co>", "<a@b.co>", "a@b.co\r\nBcc: z@y.co", "a@b.co\nx", "a b@c.co", "a@b .co", "a@@b.co", "", null, undefined, 5, ["a@b.co"], `${"a".repeat(250)}@b.co`]) {
    assert.strictEqual(mailer.cleanAddress(bad), "", JSON.stringify(bad));
  }
  assert.strictEqual(mailer.cleanSubject("RFQ: 1A2B\r\nBcc: victim@x.test\n\tX-Injected: 1 more"), "RFQ: 1A2B Bcc: victim@x.test X-Injected: 1 more");
  assert.ok(mailer.cleanSubject("x".repeat(500)).length <= 200);
});

test("the mailer refuses a typed recipient that is not one address, and never passes line breaks to Resend", async () => {
  const keep = { k: process.env.EMAIL_API_KEY, f: process.env.EMAIL_FROM };
  process.env.EMAIL_API_KEY = "test-not-a-key"; process.env.EMAIL_FROM = "Straightedge <quotes@shop.test>";
  const calls = [];
  const realFetch = global.fetch; const realErr = console.error;
  global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true }; };
  console.error = () => {};
  try {
    assert.strictEqual(await mailer.send({ to: "a@b.test\r\nBcc: victim@x.test", subject: "s", text: "t" }), false);
    assert.strictEqual(await mailer.send({ to: "a@b.test, victim@x.test", subject: "s", text: "t" }), false);
    assert.strictEqual(await mailer.send({ to: "\"x\" <victim@x.test>", subject: "s", text: "t" }), false);
    assert.strictEqual(calls.length, 0, "nothing was sent");
    assert.strictEqual(await mailer.send({ to: "buyer@plant.test", replyTo: "evil@x.test\r\nBcc: victim@x.test", subject: "Hello\r\nBcc: victim@x.test", text: "t" }), true);
    assert.deepStrictEqual(calls[0].to, ["buyer@plant.test"]);
    assert.strictEqual(calls[0].reply_to, undefined, "an unusable reply-to is dropped");
    assert.strictEqual(calls[0].subject, "Hello Bcc: victim@x.test");
    assert.ok(!/[\r\n]/.test(calls[0].subject));
    // Our own notification list (RFQ_NOTIFY_TO with commas) still works.
    assert.strictEqual(await mailer.send({ to: ["one@shop.test", "two@shop.test", "bad address"], subject: "s", text: "t" }), true);
    assert.deepStrictEqual(calls[1].to, ["one@shop.test", "two@shop.test"]);
  } finally {
    global.fetch = realFetch; console.error = realErr;
    for (const [k, v] of [["EMAIL_API_KEY", keep.k], ["EMAIL_FROM", keep.f]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

const HOSTILE = {
  id: "0b8a2f4e-3c1d-4e5f-9a6b-7c8d9e0f1a2b",
  contactName: "Claim <b>your</b> prize at https://evil.example\r\nBcc: victim@x.test",
  email: "victim@elsewhere.test",
  company: "\"><script>alert(1)</script>",
  phone: "' onmouseover='x",
  notes: "<img src=x onerror=alert(1)>",
  quantities: "<i>5</i>", tolerance: "", finishNotes: "", dueDate: "",
  parts: [{ partId: "p1", fileName: "<svg onload=alert(1)>.step", process: "cnc", materialSlug: "cnc-delrin", quantity: 5, budgetUnit: 10, budgetLine: 50 }],
  reasons: [], budgetTotal: 50, quotedTotal: 99, quotedLeadDays: 5, validUntil: "2026-12-11T00:00:00Z", quoteNote: "<u>note</u>",
};
const HOSTILE_ORDER = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", total: 99, paymentMethod: "po", poNumber: "PO\r\nBcc: victim@x.test <b>", customerName: HOSTILE.contactName, customerEmail: HOSTILE.email, shippingName: "<b>x</b>", shippingAddress: "1 Main", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120", shipBy: "2026-11-24" };

test("no email subject carries anything a visitor typed", () => {
  const part = { reference: "0B8A2F4E", shipTo: { name: "Straightedge", lines: ["1 Example St", "Town, IL 60000"] } };
  const messages = {
    rfqShop: templates.rfqReceivedShop({ rfq: HOSTILE, adminUrl: "https://shop.test/admin" }),
    rfqShopUnverified: templates.rfqReceivedShop({ rfq: HOSTILE, adminUrl: "https://shop.test/admin", unverified: true, buyerEmailed: false }),
    partShop: templates.rfqReceivedShop({ rfq: { ...HOSTILE, requestType: "part" }, part, partPending: true, unverified: true }),
    rfqBuyer: templates.rfqReceivedBuyer({ rfq: HOSTILE }),
    partBuyer: templates.rfqReceivedBuyer({ rfq: { ...HOSTILE, requestType: "part" }, part }),
    quoted: templates.rfqQuoted({ rfq: HOSTILE, acceptUrl: "https://shop.test/firm-quote/x", shipBy: "2026-12-02" }),
    acceptedPo: templates.rfqAcceptedShop({ rfq: HOSTILE, order: HOSTILE_ORDER, adminUrl: "https://shop.test/admin" }),
    acceptedCard: templates.rfqAcceptedShop({ rfq: HOSTILE, order: { ...HOSTILE_ORDER, paymentMethod: "card" }, adminUrl: "https://shop.test/admin" }),
    confirmation: templates.orderConfirmation({ order: HOSTILE_ORDER, items: [], orderUrl: "https://shop.test/orders/x" }),
    newOrder: templates.newOrderShop({ order: HOSTILE_ORDER, items: [], adminUrl: "https://shop.test/admin" }),
    shipped: templates.orderShipped({ order: { ...HOSTILE_ORDER, carrier: "ups", trackingNumber: "1Z\r\n<b>" }, items: [] }),
  };
  for (const [name, m] of Object.entries(messages)) {
    for (const typed of ["Claim", "prize", "evil.example", "Bcc", "victim", "script", "alert", "onmouseover", "PO\r", "<", ">", "\r", "\n"]) {
      assert.ok(!m.subject.includes(typed), `${name} subject contains ${JSON.stringify(typed)}: ${m.subject}`);
    }
    assert.ok(m.subject.length < 120, `${name} subject length`);
  }
  assert.ok(/^RFQ: 0B8A2F4E — 1 part\(s\)$/.test(messages.rfqShop.subject));
  assert.ok(/\[unverified sender\]$/.test(messages.rfqShopUnverified.subject));
});

test("typed values cannot add HTML to either email; the buyer is not greeted with a typed slogan or link", () => {
  const shop = templates.rfqReceivedShop({ rfq: HOSTILE, adminUrl: "https://shop.test/admin", unverified: true });
  const buyer = templates.rfqReceivedBuyer({ rfq: HOSTILE });
  for (const m of [shop, buyer]) {
    for (const raw of ["<b>your</b>", "<script>", "<img src=x", "<svg onload", "<i>5</i>", "' onmouseover='x"]) {
      assert.ok(!m.html.includes(raw), `raw ${raw} in HTML`);
    }
  }
  assert.ok(shop.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "shown to the shop as text");
  assert.ok(shop.html.includes("&#39; onmouseover=&#39;x"), "single quotes are escaped too");
  // Buyer greeting: at most the first word of the typed name, and only when it is letters.
  // The rest of what was typed as a name (a slogan, a link) is nowhere in the buyer's email.
  assert.ok(buyer.text.includes("Hi Claim,"));
  for (const rest of ["prize", "evil.example", "Bcc", "victim@x.test"]) assert.ok(!buyer.text.includes(rest) && !buyer.html.includes(rest), rest);
  const linkName = templates.rfqReceivedBuyer({ rfq: { ...HOSTILE, contactName: "https://evil.example/claim now" } });
  assert.ok(linkName.text.includes("Hello,") && !linkName.text.includes("evil.example") && !linkName.html.includes("evil.example"));
  assert.strictEqual(templates.greeting("Dana Buyer"), "Hi Dana,");
  assert.strictEqual(templates.greeting("José-María O'Neil"), "Hi José-María,");
  for (const odd of ["https://evil.example", "FREE!!!", "www.win.example", "x".repeat(40), "$$$", "", null]) assert.strictEqual(templates.greeting(odd), "Hello,", String(odd));
});

test("only http(s), mailto and tel links go into a button; anything else is neutralised", () => {
  assert.strictEqual(templates.safeHref("https://shop.test/x"), "https://shop.test/x");
  for (const bad of ["javascript:alert(1)", " JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", ""]) assert.strictEqual(templates.safeHref(bad), "#", bad);
  const m = templates.layout({ subject: "s", heading: "h", paragraphs: [], cta: { label: "Go", url: "javascript:alert(1)" } });
  assert.ok(m.html.includes('href="#"') && !m.html.includes('href="javascript'));
});

test("account emails are branded, carry no typed text, and put the link in the body only", () => {
  const link = "https://shop.test/verify-email#token=PLACEHOLDER";
  const list = [
    templates.verifyEmail({ verifyUrl: link }),
    templates.passwordResetRequested({ resetUrl: "https://shop.test/reset-password#token=PLACEHOLDER" }),
    templates.passwordChanged({ when: "2026-11-11T15:00:00Z" }),
    templates.accountLocked({ minutes: 15, resetUrl: "https://shop.test/forgot-password" }),
    templates.twoFactorChanged({ change: "enabled" }),
    templates.twoFactorChanged({ change: "disabled" }),
    templates.twoFactorChanged({ change: "recovery-codes" }),
    templates.twoFactorChanged({ change: "recovery-used" }),
  ];
  for (const m of list) {
    assert.ok(m.html.includes("STRAIGHTEDGE") && m.text.includes("224-213-6727"), "the one branded layout");
    assert.ok(m.subject.startsWith("Straightedge: ") && !m.subject.includes("token"), m.subject);
    assert.ok(m.text.includes("Hello,"));
    assert.ok(!/\bI\b|\bmy team\b/.test(m.text.replace(/Confirm my email/g, "")), "we voice");
  }
  assert.ok(list[0].text.includes(link) && list[0].html.includes("verify-email#token=PLACEHOLDER"));
  assert.ok(/works once and for 24 hours/.test(list[0].text));
  assert.ok(/works once and for one hour/.test(list[1].text));
  assert.ok(/signed out/.test(list[2].text));
  assert.ok(/paused for 15 minutes/.test(list[3].text) && /Nobody got in/.test(list[3].text));
});

// ─── Migration ─────────────────────────────────────────────────
test("the migration is additive, idempotent, and marks pre-existing accounts verified exactly once", async () => {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // The users and rfqs tables as the master branch creates them.
  db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT, company TEXT, phone TEXT, role TEXT DEFAULT 'customer', created_at TEXT, updated_at TEXT);
          CREATE TABLE rfqs (id TEXT PRIMARY KEY, quote_id TEXT, user_id TEXT, status TEXT DEFAULT 'new', contact_name TEXT, email TEXT, created_at TEXT, updated_at TEXT);`);
  db.run("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1', 'owner@shop.test', 'h1', 'admin', '2026-01-02T00:00:00Z'), ('u2', 'old@buyer.test', 'h2', 'customer', NULL)");
  db.run("INSERT INTO rfqs (id, email, status) VALUES ('r1', 'old@buyer.test', 'new')");
  const migration = require("./accountMigration");
  const first = migration.apply(db);
  assert.strictEqual(first.backfilled, 2);
  assert.ok(first.users.includes("email_verified_at") && first.users.includes("token_version") && first.users.includes("totp_secret_enc"));
  assert.deepStrictEqual(first.rfqs, ["sender_check", "buyer_emailed"]);
  const rows = () => { const out = []; const st = db.prepare("SELECT * FROM users ORDER BY id"); while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
  let users = rows();
  assert.strictEqual(users[0].email_verified_at, "2026-01-02T00:00:00Z", "verified as of when the account was made");
  assert.ok(users[1].email_verified_at, "an account with no created_at is verified too");
  assert.strictEqual(users[0].role, "admin");
  assert.strictEqual(users[0].password_hash, "h1", "nothing existing is rewritten");
  assert.strictEqual(users[0].token_version, 0);
  // An account made after the migration is not verified, and a second run does not verify it.
  db.run("INSERT INTO users (id, email, password_hash, role) VALUES ('u3', 'new@buyer.test', 'h3', 'customer')");
  const second = migration.apply(db);
  assert.deepStrictEqual(second, { users: [], rfqs: [], backfilled: 0 });
  users = rows();
  assert.strictEqual(users[2].email_verified_at, null);
  assert.strictEqual(users.length, 3);
  db.close();
});

run();
