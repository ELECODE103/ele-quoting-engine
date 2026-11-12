/**
 * The counters, the alerts and their limits, the conditions that raise them,
 * the daily digest and its schedule, and what the status report may contain.
 * Run: node server/ops/ops.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const { runner } = require("../testSupport/harness");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-ops-"));
process.env.QUOTING_DATA_DIR = path.join(tmp, "data");
process.env.QUOTING_DB_PATH = path.join(tmp, "data", "quoting.db");
process.env.NODE_ENV = "test";
process.env.OPS_VOLUME_ALERT_PERCENT = "101"; // how full this machine's own disk is must not decide a test
fs.mkdirSync(process.env.QUOTING_DATA_DIR, { recursive: true });
// Throwaway values made for this run; each is searched for in what the status report returns.
const SECRETS = {
  JWT_SECRET: `jwt-${crypto.randomBytes(24).toString("hex")}`,
  STRIPE_SECRET_KEY: `sk_test_${crypto.randomBytes(16).toString("hex")}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(16).toString("hex")}`,
  EMAIL_API_KEY: `re_${crypto.randomBytes(16).toString("hex")}`,
  NORD_FILE_ENC_KEY: crypto.randomBytes(36).toString("base64"),
  TURNSTILE_SECRET_KEY: `ts-secret-${crypto.randomBytes(16).toString("hex")}`,
  TURNSTILE_SITE_KEY: `ts-site-${crypto.randomBytes(8).toString("hex")}`,
};
const ADDRESSES = { ADMIN_EMAIL: "owner-marker@shop.test", RFQ_NOTIFY_TO: "notify-marker@shop.test, second-marker@shop.test", EMAIL_FROM: "Straightedge <from-marker@mail.shop.test>" };

const events = require("./events");
const observer = require("./observer");
const alerts = require("./alerts");
const state = require("./state");
const checks = require("./checks");
const digest = require("./digest");
const status = require("./status");

const { test, run } = runner("Operations");
const MB = 1024 * 1024;
const HOUR = 3600 * 1000;

const withEnv = async (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = String(v); }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
/** A stand-in for services/mailer.js: records what would be sent. */
function fakeMailer({ configured = true, ok = true } = {}) {
  const m = { sent: [], on: configured, ok };
  m.configured = () => m.on;
  m.shopNotifyAddress = () => "shop@shop.test";
  m.send = async (msg) => { m.sent.push(msg); return m.on && m.ok; };
  return m;
}
const quiet = () => {};

test("events: counts, a sliding window, digest counts that start again, labels that are not safe are dropped", () => {
  events.reset();
  const now = Date.now();
  // Recorded in the order they happen, oldest first.
  events.record("serverError", { now: now - 30 * HOUR }); // older than a day: never counted in a window
  events.record("serverError", { now: now - 2 * HOUR });
  for (let i = 4; i >= 0; i--) events.record("serverError", { now: now - i * 60 * 1000, notable: true, label: "500" });
  assert.strictEqual(events.total("serverError"), 7);
  assert.strictEqual(events.countSince("serverError", 15 * 60 * 1000, now), 5);
  assert.strictEqual(events.countSince("serverError", 3 * HOUR, now), 6);
  assert.strictEqual(events.countSince("serverError", 1000 * HOUR, now), 6, "a window is at most 24 hours");
  assert.strictEqual(events.countSince("never", HOUR, now), 0);
  assert.strictEqual(events.digestCounts().counts.serverError, 7);
  events.markDigestSent(now);
  assert.deepStrictEqual(events.digestCounts().counts, {});
  assert.strictEqual(events.total("serverError"), 7, "the running total is not reset by a digest");
  // A label is a short fixed word; anything else (an address, markup) is not kept.
  events.record("mailFailed", { notable: true, label: "someone@customer.test <b>" });
  events.record("mailFailed", { notable: true, label: "orderConfirmation" });
  const recent = events.snapshot().recent;
  assert.strictEqual(recent[0].label, "orderConfirmation");
  assert.strictEqual(recent[1].label, "");
  assert.ok(!JSON.stringify(events.snapshot()).includes("customer.test"));
  // A flood cannot grow memory without bound.
  for (let i = 0; i < 7000; i++) events.record("rateLimited", { notable: true });
  assert.ok(events.snapshot().recent.length <= 60);
  assert.strictEqual(events.countSince("rateLimited", HOUR), 5000);
  events.reset();
});

test("observer: classifies answers by route, status and our own error code; never by body", () => {
  const c = (p, s, code) => observer.classify(p, s, code).map((x) => x[0]);
  assert.deepStrictEqual(c("/api/stripe/webhook", 200), ["webhookOk"]);
  assert.deepStrictEqual(c("/api/stripe/webhook", 400), ["webhookRejected"]);
  assert.deepStrictEqual(c("/api/stripe/webhook", 503), ["webhookRefused"]);
  assert.deepStrictEqual(c("/api/stripe/webhook", 404), ["webhookFailed"]);
  assert.deepStrictEqual(c("/api/stripe/webhook", 500), ["webhookFailed", "serverError"]);
  assert.deepStrictEqual(c("/api/quote", 500), ["serverError"]);
  assert.deepStrictEqual(c("/api/upload", 503, "busy"), [], "a deliberate 503 is not a server error");
  assert.deepStrictEqual(c("/api/upload", 503, "storage-full"), ["storageRefused"]);
  assert.deepStrictEqual(c("/api/auth/login", 429, "account-locked"), ["signinPaused"]);
  assert.deepStrictEqual(c("/api/auth/login", 429, "rate-limited"), ["rateLimited"]);
  assert.deepStrictEqual(c("/api/auth/login", 401, "invalid-credentials"), []);
  assert.deepStrictEqual(c("/", 200), []);
});

test("observer on a live app: answers are unchanged, and each kind is counted once", async () => {
  events.reset();
  const app = express();
  app.use(observer.middleware);
  app.post("/api/stripe/webhook", (req, res) => res.status(400).json({ error: "Invalid signature" }));
  app.get("/api/boom", (req, res) => res.status(500).json({ error: "Internal server error" }));
  app.get("/api/locked", (req, res) => res.status(429).json({ error: "Paused", code: "account-locked", retryAfterSeconds: 60 }));
  app.get("/api/full", (req, res) => res.status(503).json({ error: "Full", code: "storage-full" }));
  app.get("/api/ok", (req, res) => res.json({ code: "not-an-error", fine: true }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hook = await fetch(`${base}/api/stripe/webhook?x=1`, { method: "POST" });
    assert.strictEqual(hook.status, 400);
    assert.deepStrictEqual(await hook.json(), { error: "Invalid signature" });
    assert.strictEqual((await fetch(`${base}/api/boom`)).status, 500);
    const locked = await fetch(`${base}/api/locked`);
    assert.deepStrictEqual(await locked.json(), { error: "Paused", code: "account-locked", retryAfterSeconds: 60 }, "the body is passed through untouched");
    await fetch(`${base}/api/full`);
    assert.deepStrictEqual(await (await fetch(`${base}/api/ok`)).json(), { code: "not-an-error", fine: true });
    await new Promise((r) => setTimeout(r, 50));
    const t = events.snapshot().totals;
    assert.deepStrictEqual({ webhookRejected: t.webhookRejected, serverError: t.serverError, signinPaused: t.signinPaused, storageRefused: t.storageRefused }, { webhookRejected: 1, serverError: 1, signinPaused: 1, storageRefused: 1 });
    assert.strictEqual(Object.keys(t).length, 4, `nothing else was counted: ${JSON.stringify(t)}`);
  } finally { await new Promise((r) => server.close(r)); events.reset(); }
});

test("mailer watch: sent, failed and not-configured are counted by template name; the caller's result is unchanged; wrapped once", async () => {
  events.reset();
  const m = fakeMailer();
  const inner = m.send;
  observer.watchMailer(m);
  observer.watchMailer(m); // a second call does not wrap it again
  assert.strictEqual(m.send.original, inner);
  assert.strictEqual(await m.send({ to: "a@b.test", subject: "x", template: "orderConfirmation" }), true);
  m.ok = false;
  assert.strictEqual(await m.send({ to: "private-marker@customer.test", subject: "Secret subject marker", template: "orderConfirmation" }), false);
  assert.strictEqual(await m.send({ to: "shop@shop.test", subject: "x", template: "opsAlert" }), false);
  m.on = false;
  assert.strictEqual(await m.send({ to: "a@b.test", subject: "x", template: "verifyEmail" }), false);
  const snap = events.snapshot();
  assert.deepStrictEqual({ s: snap.totals.mailSent, f: snap.totals.mailFailed, n: snap.totals.mailNotConfigured, c: snap.totals.mailFailedCustomerFacing }, { s: 1, f: 2, n: 1, c: 1 }, "a failed alert email is counted but is not a customer-facing failure (no alert about alerts)");
  const dump = JSON.stringify(snap);
  assert.ok(dump.includes("orderConfirmation"));
  assert.ok(!dump.includes("private-marker") && !dump.includes("Secret subject marker"), "no address and no subject is kept");
  assert.strictEqual(m.sent.length, 4, "every message still went to the real send exactly once");
  // The pause notice marks the moment an account was paused, whether or not the email itself could be sent.
  m.on = true; m.ok = true;
  await m.send({ to: "someone@customer.test", subject: "x", template: "accountLocked" });
  assert.strictEqual(events.snapshot().totals.signinPauseStarted, 1);
  events.reset();
});

test("alerts: one email per condition per cooldown, a daily cap, limits that survive a restart, and a log line either way", async () => {
  alerts.reset(); state.reset(); fs.rmSync(path.join(tmp, "data", "ops"), { recursive: true, force: true });
  const mailer = fakeMailer();
  const logs = [];
  const log = (l) => logs.push(l);
  const t0 = Date.parse("2026-11-12T15:00:00Z");
  const alert = { title: "Upload storage is 85% full", lines: ["Customer files use 1700 MB of the 2048 MB ceiling."], facts: [["Used", "1700 MB"]] };

  let r = await alerts.raise("storage-high", alert, { now: t0, mailer, log });
  assert.deepStrictEqual(r, { suppressed: false, emailed: true, reason: undefined });
  assert.strictEqual(mailer.sent.length, 1);
  assert.strictEqual(mailer.sent[0].to, "shop@shop.test", "to the shop's own address only");
  assert.strictEqual(mailer.sent[0].subject, "Straightedge alert: Upload storage is 85% full");
  assert.strictEqual(mailer.sent[0].template, "opsAlert");
  assert.ok(mailer.sent[0].text.includes("1700 MB") && mailer.sent[0].html.includes("1700 MB"));
  assert.ok(logs[0].startsWith("ALERT [storage-high] Upload storage is 85% full"));

  // The same condition five minutes later, and five hours later: nothing new. After six hours: once more.
  for (const dt of [5 * 60 * 1000, 5 * HOUR]) {
    r = await alerts.raise("storage-high", alert, { now: t0 + dt, mailer, log });
    assert.deepStrictEqual(r, { suppressed: true, emailed: false, reason: "cooldown" });
  }
  assert.strictEqual(mailer.sent.length, 1);
  assert.strictEqual(logs.length, 1, "a suppressed alert does not fill the log either");

  // A "restart": memory is gone, the file on the volume is not.
  alerts.reset(); state.reset();
  r = await alerts.raise("storage-high", alert, { now: t0 + 5.5 * HOUR, mailer, log });
  assert.strictEqual(r.suppressed, true, "the cooldown is remembered across a restart");
  r = await alerts.raise("storage-high", alert, { now: t0 + 6.1 * HOUR, mailer, log });
  assert.strictEqual(r.emailed, true);
  assert.strictEqual(mailer.sent.length, 2);

  // A different condition is not held back by the first one's cooldown.
  r = await alerts.raise("mail-failing", { title: "Emails are failing to send", lines: ["3 emails failed in the last hour."] }, { now: t0 + 6.2 * HOUR, mailer, log });
  assert.strictEqual(r.emailed, true);

  // The cap across all conditions: 12 alert emails in any 24 hours.
  const start = t0 + 48 * HOUR;
  let emailed = 0;
  for (let i = 0; i < 20; i++) {
    const x = await alerts.raise(`condition-${i}`, { title: `Condition ${i}`, lines: ["x"] }, { now: start + i * 1000, mailer, log });
    if (x.emailed) emailed++; else assert.strictEqual(x.reason, "daily-cap");
  }
  assert.strictEqual(emailed, 12);
  assert.ok(logs.filter((l) => /^ALERT \[condition-/.test(l)).length === 20, "every one of them is still in the log");
  assert.ok(logs.some((l) => /limit of 12 alert emails in 24 hours/.test(l)));
  // A day later the cap has moved on.
  r = await alerts.raise("condition-late", { title: "Later", lines: ["x"] }, { now: start + 25 * HOUR, mailer, log });
  assert.strictEqual(r.emailed, true);

  // Mailer not configured: logged, not emailed, and still subject to the cooldown.
  const off = fakeMailer({ configured: false });
  r = await alerts.raise("no-mail", { title: "T", lines: ["l"] }, { now: start, mailer: off, log });
  assert.deepStrictEqual(r, { suppressed: false, emailed: false, reason: "mailer-not-configured" });
  assert.strictEqual(off.sent.length, 0);
  // A failed send is reported as such and does not use up the daily allowance.
  const broken = fakeMailer({ ok: false });
  r = await alerts.raise("send-breaks", { title: "T", lines: ["l"] }, { now: start + 30 * HOUR, mailer: broken, log });
  assert.deepStrictEqual(r, { suppressed: false, emailed: false, reason: "send-failed" });
  await assert.rejects(alerts.raise("Not A Key!", { title: "x" }, { mailer, log }));
  alerts.reset();
});

test("conditions: storage and database at the warning line, repeated webhook, mail and server failures — each raised at its threshold and not before", async () => {
  events.reset(); alerts.reset();
  const uploads = path.join(tmp, "data", "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const guards = require("../security/uploadGuards");
  const keys = (list) => list.map((a) => a.key).sort();
  await withEnv({ UPLOAD_DIR_MAX_MB: "10", DB_MAX_MB: "16" }, async () => {
    guards.storage.invalidate();
    assert.deepStrictEqual(keys(checks.evaluate()), [], "an idle, empty site raises nothing");

    fs.writeFileSync(path.join(uploads, "a.stl"), Buffer.alloc(7.9 * MB));
    guards.storage.invalidate();
    assert.deepStrictEqual(keys(checks.evaluate()), [], "79% is below the line");
    fs.writeFileSync(path.join(uploads, "b.stl"), Buffer.alloc(0.2 * MB));
    guards.storage.invalidate();
    const high = checks.evaluate();
    assert.deepStrictEqual(keys(high), ["storage-high"]);
    assert.ok(/81% full/.test(high[0].title), high[0].title);
    assert.ok(high[0].lines.join(" ").includes("of the 10 MB ceiling"));
    fs.rmSync(path.join(uploads, "a.stl")); fs.rmSync(path.join(uploads, "b.stl"));
    guards.storage.invalidate();

    // The database file against DB_MAX_MB (16 MB here): 13 MB is over 80%.
    const dbFile = process.env.QUOTING_DB_PATH;
    const keep = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    fs.writeFileSync(dbFile, Buffer.alloc(13 * MB));
    assert.deepStrictEqual(keys(checks.evaluate()), ["database-high"]);
    if (keep) fs.writeFileSync(dbFile, keep); else fs.rmSync(dbFile);
  });
  guards.storage.invalidate();

  const now = Date.now();
  for (let i = 0; i < 2; i++) events.record("webhookRejected", { now });
  assert.deepStrictEqual(keys(checks.evaluate(now)), []);
  events.record("webhookRejected", { now });
  assert.deepStrictEqual(keys(checks.evaluate(now)), ["webhook-rejected"]);
  assert.deepStrictEqual(keys(checks.evaluate(now + 61 * 60 * 1000)), [], "an hour later the failures have aged out");

  events.reset();
  for (let i = 0; i < 3; i++) events.record("mailFailedCustomerFacing", { now });
  assert.deepStrictEqual(keys(checks.evaluate(now)), ["mail-failing"]);
  events.reset();
  for (let i = 0; i < 3; i++) events.record("mailFailed", { now, label: "opsAlert" });
  assert.deepStrictEqual(keys(checks.evaluate(now)), [], "failed alert emails alone do not raise an alert about email");

  events.reset();
  for (let i = 0; i < 4; i++) events.record("serverError", { now });
  assert.deepStrictEqual(keys(checks.evaluate(now)), []);
  events.record("serverError", { now });
  assert.deepStrictEqual(keys(checks.evaluate(now)), ["server-errors"]);
  await withEnv({ OPS_ERROR_THRESHOLD: "50" }, async () => assert.deepStrictEqual(keys(checks.evaluate(now)), [], "the threshold is a setting"));
  assert.deepStrictEqual(keys(checks.evaluate(now + 16 * 60 * 1000)), [], "fifteen minutes later they have aged out");
  events.reset();

  // run(): raises through the alert limits, and a condition that has cleared leaves the status page.
  const mailer = fakeMailer();
  for (let i = 0; i < 5; i++) events.record("serverError", { now });
  let results = await checks.run(now, { mailer, log: quiet });
  assert.deepStrictEqual(results.map((r) => [r.key, r.emailed]), [["server-errors", true]]);
  results = await checks.run(now + 60 * 1000, { mailer, log: quiet });
  assert.deepStrictEqual(results.map((r) => [r.key, r.suppressed]), [["server-errors", true]], "five minutes on: still true, not emailed again");
  assert.strictEqual(mailer.sent.length, 1);
  assert.deepStrictEqual(alerts.snapshot().map((a) => a.key), ["server-errors"]);
  await checks.run(now + 20 * 60 * 1000, { mailer, log: quiet });
  assert.deepStrictEqual(alerts.snapshot(), [], "cleared");
  events.reset(); alerts.reset();
});

test("startup: each critical protection that is off is named; the alert is repeated only when the set changes; a crash is reported once", async () => {
  alerts.reset(); state.reset(); fs.rmSync(path.join(tmp, "data", "ops"), { recursive: true, force: true });
  const allOn = { ...SECRETS, EMAIL_FROM: ADDRESSES.EMAIL_FROM, SE_TEST_HOOKS: undefined, CSP_REPORT_ONLY: undefined };
  await withEnv(allOn, async () => {
    assert.deepStrictEqual(status.criticalOff(), [], "everything set: nothing to report");
    assert.deepStrictEqual(checks.evaluateStartup(null), []);
  });
  const cases = [
    [{ TURNSTILE_SITE_KEY: undefined }, "bot-check"],
    [{ TURNSTILE_SECRET_KEY: undefined }, "bot-check"],
    [{ NORD_FILE_ENC_KEY: undefined }, "file-encryption"],
    [{ JWT_SECRET: "short-secret-of-22-chars" }, "jwt-secret"],
    [{ SE_TEST_HOOKS: "1" }, "test-hooks-off"],
    [{ STRIPE_WEBHOOK_SECRET: undefined }, "stripe-webhook-secret"],
    [{ EMAIL_API_KEY: undefined }, "mailer"],
    [{ CSP_REPORT_ONLY: "true" }, "csp-enforced"],
  ];
  for (const [change, key] of cases) {
    await withEnv({ ...allOn, ...change }, async () => {
      assert.deepStrictEqual(status.criticalOff().map((p) => p.key), [key], JSON.stringify(Object.keys(change)));
      const [a] = checks.evaluateStartup(null);
      assert.ok(/started with 1 protection switched off/.test(a.title));
      assert.ok(a.key.startsWith("startup-protections:"));
    });
  }
  // The four the brief names, together, and what the email says.
  const mailer = fakeMailer();
  const logs = [];
  await withEnv({ ...allOn, TURNSTILE_SITE_KEY: undefined, NORD_FILE_ENC_KEY: undefined, JWT_SECRET: "short", SE_TEST_HOOKS: "1" }, async () => {
    const t0 = Date.parse("2026-11-12T12:00:00Z");
    let r = await checks.runStartup(null, { now: t0, mailer, log: (l) => logs.push(l) });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].emailed, true);
    assert.strictEqual(mailer.sent[0].subject, "Straightedge alert: The site started with 4 protections switched off");
    for (const word of ["Bot check", "encrypted on the volume", "Session secret", "Test-only behaviour"]) assert.ok(mailer.sent[0].text.includes(word), word);
    assert.ok(/ALERT \[startup-protections:[0-9a-f]{10}\].*Bot check/.test(logs[0]), logs[0]);
    // Ten restarts in a row (a crash loop, a run of redeploys): one email.
    for (let i = 1; i <= 10; i++) { alerts.reset(); state.reset(); await checks.runStartup(null, { now: t0 + i * 60 * 1000, mailer, log: quiet }); }
    assert.strictEqual(mailer.sent.length, 1);
    // One of the four is fixed: the set changed, so the owner is told what is left.
    await withEnv({ SE_TEST_HOOKS: undefined }, async () => {
      r = await checks.runStartup(null, { now: t0 + 20 * 60 * 1000, mailer, log: quiet });
      assert.strictEqual(r[0].emailed, true);
      assert.ok(/3 protections/.test(mailer.sent[1].subject));
    });
  });
  // No value of any setting is in the alert.
  for (const m of mailer.sent) for (const v of Object.values(SECRETS)) assert.ok(!`${m.subject}${m.text}${m.html}`.includes(v), "no setting value is echoed");
  // The previous run crashed.
  await withEnv(allOn, async () => {
    const [a] = checks.evaluateStartup({ ended: "crash", errorName: "TypeError" });
    assert.strictEqual(a.key, "previous-run-crash");
    assert.ok(a.lines[0].includes("TypeError"));
    assert.deepStrictEqual(checks.evaluateStartup({ ended: "clean" }), []);
    // Killed from outside (out of memory, or a deploy with no draining time): its own alert, with where to look.
    const [k] = checks.evaluateStartup({ ended: "killed" });
    assert.strictEqual(k.key, "previous-run-killed");
    assert.ok(/out of memory/.test(k.lines[0]) && /MEMORY_BUDGET_MB/.test(k.lines[1]) && /draining time/.test(k.lines[1]));
  });
  alerts.reset();
});

test("digest schedule: Central time with daylight saving, once a day at the hour, late if the site was down, never twice, never without a mailer", async () => {
  // Central is UTC-6 in winter and UTC-5 in summer.
  assert.deepStrictEqual(digest.centralParts(Date.parse("2026-11-12T12:59:00Z")), { date: "2026-11-12", hour: 6 });
  assert.deepStrictEqual(digest.centralParts(Date.parse("2026-11-12T13:00:00Z")), { date: "2026-11-12", hour: 7 });
  assert.deepStrictEqual(digest.centralParts(Date.parse("2026-07-01T12:00:00Z")), { date: "2026-07-01", hour: 7 });
  assert.deepStrictEqual(digest.centralParts(Date.parse("2026-11-13T05:30:00Z")), { date: "2026-11-12", hour: 23 }, "half past five UTC is still the evening before in Central");
  assert.deepStrictEqual(digest.centralParts(Date.parse("2026-11-13T06:00:00Z")), { date: "2026-11-13", hour: 0 });

  await require("../models/database").ready;
  state.reset(); fs.rmSync(path.join(tmp, "data", "ops"), { recursive: true, force: true }); digest.resetForTests(); events.reset();
  const mailer = fakeMailer();
  await withEnv({ OPS_DIGEST_HOUR: undefined, OPS_DIGEST: undefined }, async () => {
    const day1 = (h, m = 0) => Date.parse(`2026-11-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
    assert.strictEqual((await digest.tick(day1(12, 59), { mailer })).reason, "before-hour");
    assert.strictEqual(mailer.sent.length, 0);
    events.record("mailFailed"); events.record("serverError");
    assert.deepStrictEqual(await digest.tick(day1(13, 0), { mailer }), { sent: true });
    assert.strictEqual(mailer.sent.length, 1);
    assert.strictEqual(mailer.sent[0].to, "shop@shop.test");
    assert.strictEqual(mailer.sent[0].template, "opsDigest");
    assert.ok(/^Straightedge daily digest — Thu, Nov 12, 2026$/.test(mailer.sent[0].subject), mailer.sent[0].subject);
    assert.deepStrictEqual(events.digestCounts().counts, {}, "the counters start again after the scheduled digest");
    for (const minute of [1, 2, 30]) assert.strictEqual((await digest.tick(day1(13, minute), { mailer })).reason, "already-sent");
    assert.strictEqual((await digest.tick(day1(23, 0), { mailer })).reason, "already-sent");
    // A restart later the same day: the file on the volume says it has gone out.
    state.reset(); digest.resetForTests();
    assert.strictEqual((await digest.tick(day1(18, 0), { mailer })).reason, "already-sent");
    assert.strictEqual(mailer.sent.length, 1);
    // Next day the site is down at 7 and comes back at 9:40 Central: the digest goes out then.
    const day2late = Date.parse("2026-11-13T15:40:00Z");
    assert.deepStrictEqual(await digest.tick(day2late, { mailer }), { sent: true });
    assert.strictEqual(mailer.sent.length, 2);
    // A manual send (the admin button) neither marks the day nor resets the counters.
    events.record("serverError");
    const day3 = Date.parse("2026-11-14T09:00:00Z"); // 3 am Central
    assert.deepStrictEqual(await digest.send(day3, { mailer }), { sent: true });
    assert.strictEqual(events.digestCounts().counts.serverError, 1);
    assert.deepStrictEqual(await digest.tick(Date.parse("2026-11-14T13:05:00Z"), { mailer }), { sent: true }, "the scheduled one still goes out that morning");
    assert.strictEqual(mailer.sent.length, 4);

    // A failing mailer: three tries that day, then it waits for tomorrow instead of trying every minute.
    const broken = fakeMailer({ ok: false });
    const day4 = (m) => Date.parse(`2026-11-15T13:${String(m).padStart(2, "0")}:00Z`);
    const err = console.error; console.error = quiet;
    try {
      for (let m = 0; m < 3; m++) assert.strictEqual((await digest.tick(day4(m), { mailer: broken })).reason, "send-failed");
      assert.strictEqual((await digest.tick(day4(4), { mailer: broken })).reason, "gave-up-today");
    } finally { console.error = err; }
    assert.strictEqual(broken.sent.length, 3);

    // Mailer not configured: nothing is attempted. Schedule switched off: nothing is sent.
    const off = fakeMailer({ configured: false });
    assert.strictEqual((await digest.tick(Date.parse("2026-11-16T13:00:00Z"), { mailer: off })).reason, "mailer-not-configured");
    assert.strictEqual((await digest.send(Date.now(), { mailer: off })).reason, "mailer-not-configured");
    assert.strictEqual(off.sent.length, 0);
    await withEnv({ OPS_DIGEST: "off" }, async () => assert.strictEqual((await digest.tick(Date.parse("2026-11-16T13:00:00Z"), { mailer })).reason, "schedule-off"));
    await withEnv({ OPS_DIGEST_HOUR: "17" }, async () => {
      assert.strictEqual(digest.digestHour(), 17);
      assert.strictEqual((await digest.tick(Date.parse("2026-11-16T22:59:00Z"), { mailer })).reason, "before-hour");
    });
    await withEnv({ OPS_DIGEST_HOUR: "25" }, async () => assert.strictEqual(digest.digestHour(), 7, "a nonsense hour falls back to 7"));
  });
  events.reset();
});

test("digest contents: new orders, every status including ones this code has never seen, waiting requests, lapsing quotes, sizes, failures — and no customer text", async () => {
  await require("../models/database").ready;
  const { ordersDB, rfqsDB, quotesDB } = require("../models");
  const now = Date.parse("2026-11-12T13:00:00Z");
  const iso = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const pii = { name: "Zelda Qwertyname", email: "zelda-marker@customer.test", note: "Qwertynote deliver to dock 4", company: "Qwertycorp", po: "PO-QWERTY-7", street: "77 Qwertystreet" };
  const order = (status, total, hoursAgo, extra = {}) => ordersDB.insert({ status, total, subtotal: total, customerName: pii.name, customerEmail: pii.email, shippingName: pii.name, shippingAddress: pii.street, notes: pii.note, customerNotes: pii.note, createdAt: iso(hoursAgo), ...extra });
  order("paid", 908.75, 3, { paymentMethod: "card" });
  order("pending_po", 4250, 10, { paymentMethod: "po", poNumber: pii.po });
  order("shipped", 120, 200);
  order("paid_amount_mismatch", 55.5, 30);
  // States another branch is adding: this code has no list entry for them.
  order("needs_attention", 310, 5);
  order("disputed", 77, 400);
  order("partially_refunded", 64, 300);
  order("some_future_state", 12, 90);
  rfqsDB.insert({ status: "new", contactName: pii.name, email: pii.email, company: pii.company, notes: pii.note, createdAt: iso(50) });
  rfqsDB.insert({ status: "in-review", requestType: "part", contactName: pii.name, email: pii.email, createdAt: iso(4) });
  rfqsDB.insert({ status: "quoted", quotedTotal: 1800, validUntil: new Date(now + 40 * HOUR).toISOString(), contactName: pii.name, email: pii.email, createdAt: iso(600) });
  rfqsDB.insert({ status: "quoted", quotedTotal: 99, validUntil: new Date(now + 400 * HOUR).toISOString(), contactName: pii.name, email: pii.email, createdAt: iso(100) });
  rfqsDB.insert({ status: "declined", contactName: pii.name, email: pii.email, createdAt: iso(100) });
  quotesDB.insert({ status: "draft", expiresAt: new Date(now + 20 * HOUR).toISOString(), notes: pii.note, createdAt: iso(700) });
  quotesDB.insert({ status: "draft", expiresAt: new Date(now + 500 * HOUR).toISOString(), createdAt: iso(10) });

  events.reset();
  for (let i = 0; i < 2; i++) events.record("mailFailed");
  for (let i = 0; i < 9; i++) events.record("mailSent");
  events.record("webhookRejected"); events.record("webhookOk"); events.record("serverError"); events.record("signinPaused"); events.record("signinPaused");
  events.record("signinPauseStarted");

  const m = await withEnv({ FRONTEND_URL: "https://straightedgemfg.com", ...SECRETS, EMAIL_FROM: ADDRESSES.EMAIL_FROM, SE_TEST_HOOKS: undefined }, async () => digest.build(now));
  assert.strictEqual(m.subject, "Straightedge daily digest — Thu, Nov 12, 2026");
  const t = m.text;
  assert.ok(/New orders, last 24 hours —: 3 · \$5,468\.75/.test(t), t.slice(0, 600));
  assert.ok(/\$908\.75 · paid · card/.test(t) && /\$4,250\.00 · pending_po · po/.test(t) && /\$310\.00 · needs_attention/.test(t));
  // Every status present in the database is in the list, known or not.
  for (const line of ["paid: 1", "pending_po: 1", "shipped: 1", "paid_amount_mismatch — needs a look: 1", "needs_attention (new status) — needs a look: 1", "disputed (new status) — needs a look: 1", "partially_refunded (new status): 1", "some_future_state (new status): 1"]) {
    assert.ok(t.includes(line), `status line "${line}" in:\n${t}`);
  }
  assert.ok(/All orders by status —: 8/.test(t));
  assert.ok(/Requests waiting for a quote —: 2 · oldest 2 days/.test(t));
  assert.ok(/firm quote · waiting 2 days/.test(t) && /send-us-the-part · waiting 4 h/.test(t));
  assert.ok(/Quotes lapsing within 3 days —: 1 firm · 1 instant/.test(t));
  assert.ok(/\$1,800\.00 · until Nov 13/.test(t));
  assert.ok(/Customer files: \d+ MB of 2048 MB/.test(t) && /Database: \d+ MB of 256 MB/.test(t));
  assert.ok(/Emails sent \/ failed: 9 \/ 2/.test(t));
  assert.ok(/Stripe webhooks ok \/ bad signature \/ other failure: 1 \/ 1 \/ 0/.test(t));
  assert.ok(/Server errors \(5xx\): 1/.test(t));
  assert.ok(/Sign-in: accounts paused \/ attempts refused while paused: 1 \/ 2/.test(t));
  assert.ok(/3 new orders · 2 requests waiting · 3 orders needing a look · 4 failures to check\./.test(t), t.split("\n").slice(0, 4).join("\n"));
  assert.ok(t.includes("https://straightedgemfg.com/admin"));
  assert.ok(/start again when the site restarts/.test(t), "says what resets on a restart");
  // Nothing a customer typed, and no customer address, anywhere in the message.
  const all = `${m.subject}\n${m.text}\n${m.html}`;
  for (const v of Object.values(pii)) assert.ok(!all.includes(v), `the digest must not contain "${v}"`);
  assert.ok(!/qwerty/i.test(all));
  for (const v of Object.values(SECRETS)) assert.ok(!all.includes(v));

  // Which states ask for a person, by name: the ones the payments work adds are recognised without a list here;
  // finished states (refunded, expired) are counted and listed but do not raise the "needs a look" alert for ever.
  for (const st of ["needs_attention", "needs-attention", "payment_under_review", "payment-mismatch", "paid_amount_mismatch", "duplicate-payment", "duplicate_payment", "late-payment", "late_payment", "disputed", "dispute_open", "payment_failed"]) assert.ok(status.needsAttention(st), st);
  for (const st of ["paid", "pending_payment", "pending_po", "shipped", "delivered", "refunded", "partially_refunded", "partially-refunded", "expired", "cancelled", "not_paid", "some_future_state", "", undefined]) assert.ok(!status.needsAttention(st), String(st));
  const alertNow = checks.evaluate(now).find((a) => a.key === "orders-attention");
  assert.ok(alertNow && /3 orders need a look/.test(alertNow.title), alertNow && alertNow.title);
  assert.deepStrictEqual(alertNow.facts.map((f) => f[0]), ["disputed", "needs_attention", "paid_amount_mismatch"]);

  // With protections off, the digest says which.
  const off = await withEnv({ TURNSTILE_SITE_KEY: undefined, NORD_FILE_ENC_KEY: undefined }, async () => digest.build(now));
  assert.ok(/Protections switched off —: \d/.test(off.text) && off.text.includes("Bot check (Cloudflare Turnstile)"));
  events.reset();
});

test("status report: build, uptime, hosts, protections, sizes, counts — and never a secret or an address", async () => {
  await require("../models/database").ready;
  const commit = crypto.randomBytes(20).toString("hex");
  const report = await withEnv({ ...SECRETS, ...ADDRESSES, FRONTEND_URL: "https://straightedgemfg.com", CANONICAL_HOST: "straightedgemfg.com", REDIRECT_HOSTS: "www.straightedgemfg.com,nordmfg.com", RAILWAY_GIT_COMMIT_SHA: commit, RAILWAY_GIT_BRANCH: "master", SE_TEST_HOOKS: undefined }, async () => status.collect());
  assert.strictEqual(report.build.commit, commit.slice(0, 12));
  assert.strictEqual(report.build.branch, "master");
  assert.strictEqual(report.build.node, process.version);
  assert.ok(report.uptimeSeconds >= 0 && typeof report.startedAt === "string");
  assert.deepStrictEqual(report.hosts, { canonical: "straightedgemfg.com", redirects: ["www.straightedgemfg.com", "nordmfg.com"], noindex: [], hstsAllHosts: false, frontendUrlHost: "straightedgemfg.com", seen: [], problems: [] });
  assert.ok(report.protections.every((p) => typeof p.on === "boolean" && typeof p.label === "string"));
  assert.ok(report.protections.filter((p) => p.critical).every((p) => p.on), JSON.stringify(report.protections.filter((p) => !p.on)));
  assert.ok(report.storage.files.maxBytes === 2048 * MB && report.storage.database.maxBytes === 256 * MB && report.storage.warnPercent === 80);
  assert.ok(report.business.orders.total >= 8 && report.business.requests.open === 2);
  assert.ok(Array.isArray(report.resetsOnRestart) && report.resetsOnRestart.length >= 2 && Array.isArray(report.survivesRestart));
  assert.ok(report.digest.hourCentral === 7 && report.digest.timeZone === "America/Chicago");
  const dump = JSON.stringify(report);
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!dump.includes(v), `${k} must not be in the report`);
  for (const marker of ["owner-marker", "notify-marker", "second-marker", "from-marker", "zelda-marker", "Qwerty"]) assert.ok(!dump.includes(marker), `"${marker}" must not be in the report`);
  assert.ok(!/@/.test(dump.replace(/"fix":"[^"]*"/g, "")), "no email address anywhere in the report");
  // A section whose source is missing or renamed (other branches are changing those modules) is reported as
  // unavailable; the rest of the report, the digest and the checks still work.
  const guards = require("../security/uploadGuards");
  const usage = guards.storage.usage;
  const getAll = require("../models").ordersDB.getAll;
  const warn = console.warn; console.warn = () => {};
  try {
    guards.storage.usage = undefined;
    require("../models").ordersDB.getAll = () => { throw new Error("table renamed"); };
    const partial = status.collect();
    assert.strictEqual(partial.storage.unavailable, true);
    assert.strictEqual(partial.business.unavailable, true);
    assert.ok(partial.build.node && Array.isArray(partial.protections) && partial.protections.length > 5, "the other sections are intact");
    assert.deepStrictEqual(checks.evaluate().filter((a) => /storage|database|orders/.test(a.key)), []);
    const d = digest.build();
    assert.ok(/Storage —: not available/.test(d.text) && /All orders by status —: 0/.test(d.text), d.text);
  } finally { guards.storage.usage = usage; require("../models").ordersDB.getAll = getAll; console.warn = warn; }

  // Optional getters offered by other modules: used when present, ignored when absent, and never trusted with text.
  assert.deepStrictEqual(status.extras(), {}, "none of them exists on this branch");
  const mailer = require("../services/mailer");
  mailer.capStatus = () => ({ sentToday: 41, capPerDay: 500, note: "ok", leak: "someone@customer.test wrote <b>this</b>", nested: { remaining: 459, deep: { deeper: { x: 1 } } }, list: [1, 2, 3] });
  try {
    assert.deepStrictEqual(status.extras(), { mailCap: { sentToday: 41, capPerDay: 500, note: "ok", nested: { remaining: 459 } } });
    assert.ok(/Limits and budgets/.test(digest.build().text) && /sentToday 41/.test(digest.build().text));
    mailer.capStatus = () => { throw new Error("not ready"); };
    assert.deepStrictEqual(status.extras(), {});
    mailer.capStatus = () => "free text from a customer <script>";
    assert.deepStrictEqual(status.extras(), {});
  } finally { delete mailer.capStatus; }

  // An unusable commit value is not echoed.
  const odd = await withEnv({ RAILWAY_GIT_COMMIT_SHA: "<script>alert(1)</script>" }, async () => status.build());
  assert.strictEqual(odd.commit, "unknown");
});

run(() => fs.rmSync(tmp, { recursive: true, force: true }));
