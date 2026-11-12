/**
 * Sign-in throttling that cannot be used to lock an account's owner out
 * (independent review 2026-11-11, F4). Run: node server/routes/signInThrottle.test.js
 *
 * Before: five wrong passwords, from anywhere, paused the ADDRESS for fifteen minutes for
 * everyone — its owner included — and could be repeated for ever. The guess rates the new
 * design allows are measured here, not just stated.
 */
const assert = require("assert");
const crypto = require("crypto");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Sign-in throttling (F4)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server runs in this process, so moving Date.now moves its clock too.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };

(async () => {
  const h = await start({ mailer: "configured" });
  const loginGuard = require("../security/loginGuard");
  const totp = require("../security/totp");
  const { usersDB } = h.models;
  const OWNER = process.env.ADMIN_EMAIL;
  const CHECK = { "X-Turnstile-Token": "pass-login" };
  const login = (email, password, extra = {}, opts = {}) => h.raw("POST", "/api/auth/login", { json: { email, password, ...extra }, ...opts });
  const deviceOf = (r) => { const c = r.headers.getSetCookie().find((x) => x.startsWith("se_device=")); return c ? c.split(";")[0] : null; };
  const code = () => totp.codeAt(h.adminSecret, Date.now());
  const nextStep = () => advance(30_000);
  const ipN = (i) => `198.${18 + Math.floor(i / 60000)}.${Math.floor(i / 250) % 240}.${(i % 250) + 1}`;
  const wrongFrom = (email, i, extra = {}) => login(email, "Wrong-password-1", extra, { ip: ipN(i), headers: CHECK });
  const mailTo = (email, re) => h.sent.filter((m) => m.to === email && (!re || re.test(m.subject)));
  // Each real attempt costs a password hash (a quarter of a second), so where a test only needs "n wrong
  // passwords have already happened from n addresses" the guard is told so directly, as the route would.
  const already = (email, n, base) => { for (let i = 0; i < n; i++) loginGuard.recordFailure({ ip: ipN(base + i), emailKey: email }); };

  let ownerDevice, danaDevice;
  test("setup: the owner (two-step sign-in on) and a customer, each having signed in once from their own browser", async () => {
    await h.admin();
    await h.register("dana@buyer.test", "Dana");
    nextStep();
    const o = await login(OWNER, h.adminPassword, { totp: code() });
    assert.strictEqual(o.status, 200, o.text);
    ownerDevice = deviceOf(o);
    const d = await login("dana@buyer.test", h.password);
    danaDevice = deviceOf(d);
    assert.ok(ownerDevice && danaDevice && ownerDevice !== danaDevice, "a successful sign-in hands the browser a device proof");
    const c = o.headers.getSetCookie().find((x) => x.startsWith("se_device="));
    assert.ok(/; HttpOnly/.test(c) && /; SameSite=Strict/.test(c) && /; Path=\//.test(c) && /; Max-Age=15552000/.test(c), "long-lived (180 days), httpOnly, same-site");
    assert.strictEqual((await h.raw("GET", "/api/auth/profile", { headers: { Cookie: ownerDevice } })).status, 401, "it is not a session");
    h.sent.length = 0;
  });

  test("the review's attack: five wrong passwords from another address no longer stop the owner signing in with the right password and code", async () => {
    loginGuard.resetForTests();
    for (let i = 0; i < 5; i++) assert.strictEqual((await login(OWNER, "Wrong-pass-12345", {}, { ip: "203.0.113.200", headers: CHECK })).status, 401);
    nextStep();
    // From the owner's own browser: no bot check, no wait.
    const known = await login(OWNER, h.adminPassword, { totp: code() }, { ip: "203.0.113.1", headers: { Cookie: ownerDevice } });
    assert.strictEqual(known.status, 200, known.text);
    // Even from a browser the account has never used, on another connection: the bot check, then in.
    for (let i = 0; i < 5; i++) await login(OWNER, "Wrong-pass-12345", {}, { ip: "203.0.113.201", headers: CHECK });
    nextStep();
    const cold = await login(OWNER, h.adminPassword, { totp: code() }, { ip: "203.0.113.2" });
    assert.deepStrictEqual([cold.status, cold.body.code], [403, "human-check-required"], "the bot check is asked of an unknown browser — a challenge, not a refusal");
    const coldChecked = await login(OWNER, h.adminPassword, { totp: code() }, { ip: "203.0.113.2", headers: CHECK });
    assert.strictEqual(coldChecked.status, 200, coldChecked.text);
    // The guessing connection itself is the one that waits.
    const guesser = await login(OWNER, "Wrong-pass-12345", {}, { ip: "203.0.113.201", headers: CHECK });
    assert.deepStrictEqual([guesser.status, guesser.body.code], [429, "try-later"]);
  });

  test("one source address: 11 guesses in the first hour, at most 5 an hour after that — and the right password makes no difference while it waits", async () => {
    loginGuard.resetForTests();
    const ip = "203.0.113.77";
    const start0 = Date.now();
    const perHour = [0, 0, 0, 0];
    let evaluated = 0, waits = [];
    while (Date.now() - start0 < 4 * 3600e3) {
      const r = await login("dana@buyer.test", "Wrong-password-1", {}, { ip, headers: CHECK });
      if (r.status === 401) { evaluated++; perHour[Math.floor((Date.now() - start0) / 3600e3)]++; continue; }
      assert.deepStrictEqual([r.status, r.body.code], [429, "try-later"], r.text);
      if (waits.length < 6) waits.push(r.body.retryAfterSeconds);
      // While it waits, even the right password from this connection is not evaluated.
      if (waits.length === 1) assert.strictEqual((await login("dana@buyer.test", h.password, {}, { ip, headers: CHECK })).status, 429);
      advance(r.body.retryAfterSeconds * 1000 + 50);
    }
    assert.deepStrictEqual(waits, [60, 120, 240, 480, 900, 900], "1, 2, 4, 8, then 15 minutes");
    assert.strictEqual(perHour[0], 11, `first hour: ${perHour}`);
    for (const n of perHour.slice(1)) assert.ok(n <= 5, `later hours: ${perHour}`);
    assert.ok(evaluated <= 11 + 3 * 5);
    // Dana, meanwhile, from her own browser: straight in. (The address had ${evaluated} failures against it.)
    const dana = await login("dana@buyer.test", h.password, {}, { headers: { Cookie: danaDevice } });
    assert.strictEqual(dana.status, 200, dana.text);
  });

  test("a thousand source addresses: 100 guesses an hour against one account and no more; its owner's browser is untouched; the owner is emailed once", async () => {
    loginGuard.resetForTests();
    advance(25 * 3600e3); // a new day for the notice limit
    h.sent.length = 0;
    // Guesses from a different address each time, three seconds apart. (The first 22 and the last 36 go
    // through the route; the 72 in between are counted by the guard directly — see `already`. Every
    // guess after the hundredth gets the answer the last 30 get here, however many addresses are used.)
    const status = {};
    const guess = async (i) => {
      const r = await wrongFrom("dana@buyer.test", i);
      const key = r.status === 401 ? "evaluated" : r.body.code;
      status[key] = (status[key] || 0) + 1;
      advance(3000);
    };
    for (let i = 0; i < 22; i++) await guess(i);
    already("dana@buyer.test", 72, 22); status.evaluated += 72; advance(72 * 3000);
    for (let i = 94; i < 130; i++) await guess(i);
    assert.deepStrictEqual(status, { evaluated: 100, "account-busy": 30 }, JSON.stringify(status));
    // An unknown address gets the same treatment, answer for answer.
    loginGuard.resetForTests();
    const ghost = {};
    already("ghost@nowhere.test", 97, 0);
    for (let i = 97; i < 105; i++) { const r = await wrongFrom("ghost@nowhere.test", i); const k = r.status === 401 ? "evaluated" : r.body.code; ghost[k] = (ghost[k] || 0) + 1; }
    assert.deepStrictEqual(ghost, { evaluated: 3, "account-busy": 5 }, "the 98th, 99th and 100th are evaluated; the rest are refused");
    already("dana@buyer.test", 100, 2000);
    // A browser the account has never used is refused for now — with the way out in the message…
    const cold = await login("dana@buyer.test", h.password, {}, { ip: "203.0.113.9", headers: CHECK });
    assert.deepStrictEqual([cold.status, cold.body.code], [429, "account-busy"]);
    assert.ok(/browser you've used before/.test(cold.body.error) && /reset your password/.test(cold.body.error));
    const ghostCold = await login("ghost@nowhere.test", "Anything-at-all-1", {}, { ip: "203.0.113.10", headers: CHECK });
    assert.deepStrictEqual([ghostCold.status, ghostCold.body.code, ghostCold.body.error], [cold.status, cold.body.code, cold.body.error], "no way to tell which address has an account");
    // …while her own browser signs in as if nothing were happening.
    const dana = await login("dana@buyer.test", h.password, {}, { headers: { Cookie: danaDevice } });
    assert.strictEqual(dana.status, 200, dana.text);
    await sleep(60);
    const notices = mailTo("dana@buyer.test", /wrong passwords tried/);
    assert.strictEqual(notices.length, 1, "one notice for hundreds of wrong passwords, not one per burst");
    assert.ok(/Nobody got in/.test(notices[0].text) && notices[0].text.includes("https://shop.test/forgot-password") && !/paused/.test(notices[0].text));
    assert.strictEqual(mailTo("ghost@nowhere.test").length, 0);
    // Later the same day, another wave: no second email.
    loginGuard.resetForTests();
    advance(3 * 3600e3);
    for (let i = 0; i < 21; i++) await wrongFrom("dana@buyer.test", 4000 + i);
    await sleep(60);
    assert.strictEqual(mailTo("dana@buyer.test", /wrong passwords tried/).length, 1, "at most one a day: it cannot be used to fill her inbox");
    advance(22 * 3600e3);
    loginGuard.resetForTests();
    for (let i = 0; i < 21; i++) await wrongFrom("dana@buyer.test", 5000 + i);
    await sleep(60);
    assert.strictEqual(mailTo("dana@buyer.test", /wrong passwords tried/).length, 2, "the next day she is told again");
  });

  test("the reset path always gets the real owner in: the browser that completes a reset becomes a known device", async () => {
    loginGuard.resetForTests();
    advance(2 * 3600e3);
    already("dana@buyer.test", 100, 7000);
    assert.strictEqual((await login("dana@buyer.test", h.password, {}, { ip: "203.0.113.11", headers: CHECK })).body.code, "account-busy");
    h.sent.length = 0;
    const ask = await h.raw("POST", "/api/auth/password-reset/request", { json: { email: "dana@buyer.test" }, headers: { "X-Form-Token": h.formToken("password-reset"), "X-Turnstile-Token": "pass-reset" } });
    assert.strictEqual(ask.status, 200, "asking for a reset is not blocked by the sign-in counters");
    await sleep(60);
    const link = (mailTo("dana@buyer.test", /reset your password/)[0].text.match(/#token=(\S+)/) || [])[1];
    const newPw = `Bb2-${crypto.randomBytes(9).toString("base64url")}`;
    const done = await h.raw("POST", "/api/auth/password-reset/confirm", { json: { token: link, password: newPw } });
    assert.strictEqual(done.status, 200, done.text);
    const fresh = deviceOf(done);
    assert.ok(fresh, "the reset hands this browser a device proof");
    // The attacker carries on…
    already("dana@buyer.test", 100, 8000);
    assert.strictEqual((await login("dana@buyer.test", newPw, {}, { ip: "203.0.113.12", headers: CHECK })).body.code, "account-busy", "a browser without the proof still waits");
    // …and the browser that did the reset signs in.
    const ok = await login("dana@buyer.test", newPw, {}, { headers: { Cookie: fresh } });
    assert.strictEqual(ok.status, 200, ok.text);
    h.passwordOfDana = newPw;
    danaDevice = deviceOf(ok);
  });

  test("a device proof is for one account, cannot be forged, and does not make guessing free", async () => {
    loginGuard.resetForTests();
    already(OWNER, 100, 9000);
    nextStep();
    // Dana's proof does nothing for the owner's account; neither does a tampered or made-up one.
    for (const cookie of [danaDevice, `${ownerDevice}x`, ownerDevice.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "se_device=eyJhbGciOiJIUzI1NiJ9.e30.x", "se_device="]) {
      const r = await login(OWNER, h.adminPassword, { totp: code() }, { headers: { Cookie: cookie, ...CHECK } });
      assert.deepStrictEqual([r.status, r.body.code], [429, "account-busy"], cookie.slice(0, 30));
    }
    const real = await login(OWNER, h.adminPassword, { totp: code() }, { headers: { Cookie: ownerDevice } });
    assert.strictEqual(real.status, 200, real.text);
    // A browser can hold proofs for more than one account.
    const both = await login("dana@buyer.test", h.passwordOfDana, {}, { headers: { Cookie: ownerDevice } });
    const two = deviceOf(both);
    assert.strictEqual(two.split("~").length, 2);
    nextStep();
    assert.strictEqual((await login(OWNER, h.adminPassword, { totp: code() }, { headers: { Cookie: two } })).status, 200);
    // Someone at a known device who keeps getting the password wrong: ten tries, then it is treated like any unknown browser.
    loginGuard.resetForTests();
    already("dana@buyer.test", 100, 9500);
    const tries = [];
    for (let i = 0; i < 12; i++) tries.push((await login("dana@buyer.test", "Wrong-password-1", {}, { ip: "203.0.113.40", headers: { Cookie: danaDevice } })).body.code);
    assert.deepStrictEqual(tries.slice(0, 10), Array(10).fill("invalid-credentials"));
    assert.deepStrictEqual(tries.slice(10), ["account-busy", "account-busy"]);
    assert.strictEqual((await login("dana@buyer.test", h.passwordOfDana, {}, { ip: "203.0.113.40", headers: { Cookie: danaDevice } })).body.code, "account-busy");
    advance(15 * 60e3 + 1000);
    assert.strictEqual((await login("dana@buyer.test", h.passwordOfDana, {}, { ip: "203.0.113.40", headers: { Cookie: danaDevice } })).status, 200, "fifteen minutes on, the device is known again");
  });

  test("the second step keeps its own, tight count: five wrong codes pause it for unknown browsers, not for the owner's", async () => {
    loginGuard.resetForTests();
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await login(OWNER, h.adminPassword, { totp: String(100000 + i) }, { ip: ipN(11000 + i), headers: CHECK })).body.code);
    assert.deepStrictEqual(results, ["two-factor-invalid", "two-factor-invalid", "two-factor-invalid", "two-factor-invalid", "two-factor-invalid", "two-factor-paused", "two-factor-paused"], "an attacker who knows the password gets five codes per fifteen minutes, whatever addresses they come from");
    nextStep();
    const cold = await login(OWNER, h.adminPassword, { totp: code() }, { ip: "203.0.113.70", headers: CHECK });
    assert.deepStrictEqual([cold.status, cold.body.code], [429, "two-factor-paused"]);
    const known = await login(OWNER, h.adminPassword, { totp: code() }, { headers: { Cookie: ownerDevice } });
    assert.strictEqual(known.status, 200, known.text);
  });

  test("nothing about the old pause is left: no account row is ever marked locked", async () => {
    assert.strictEqual(usersDB.getAll().filter((u) => u.lockedUntil).length, 0);
    loginGuard.resetForTests();
  });

  await run(async () => { Date.now = realNow; await h.stop(); });
})();
