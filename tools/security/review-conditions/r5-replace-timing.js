#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13): what does the NEW path cost? A checkout that
 * replaces an earlier unpaid order runs the checkout step twice (once to find the order to close,
 * once after its page is closed at Stripe). The reviewer's timing script (r3-checkout-dist.js) only
 * measures a first checkout, which does not take that path.
 *
 *   node tools/security/review-conditions/r5-replace-timing.js [lines=100] [samples=12]
 *
 * In-process harness (Stripe stand-in answers at once). For each sample: a new account, a quote of
 * `lines` lines checked out (A: a first checkout), then one line taken off and checked out again
 * (B: a checkout that replaces A's order). Wall time of each request, and the longest stretch the
 * one thread was held during it (a 2 ms timer's worst lateness).
 */
const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { liftPacing, SHIP } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const { start } = require(path.join(ROOT, "server/testSupport/harness"));
const LINES = Number(process.argv[2]) || 100;
const SAMPLES = Number(process.argv[3]) || 12;
const PROCESS = process.argv[4] || "3d-printing"; // a printed cube, as r3-checkout-dist.js uses: 100 of them stay under the firm-quote lines
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured" });
  const timed = async (fn) => {
    let worst = 0; let last = process.hrtime.bigint();
    const t = setInterval(() => { const now = process.hrtime.bigint(); worst = Math.max(worst, Number(now - last) / 1e6 - 2); last = now; }, 2);
    const t0 = process.hrtime.bigint();
    const r = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    clearInterval(t);
    return { r, ms: Math.round(ms), held: Math.round(worst) };
  };
  const first = [], replace = [], sessions = [];
  for (let i = 0; i < SAMPLES; i++) {
    const who = await h.register(`t${i}@buyer.test`, "Buyer");
    const part = await h.uploadCube();
    const mat = h.models.materialsDB.getAll().find((m) => m.process === PROCESS && m.active);
    const parts = (bump) => Array.from({ length: LINES - bump }, () => ({ partId: part, materialSlug: mat.slug, quantity: 1, process: PROCESS }));
    const q1 = await h.post("/api/quote", { parts: parts(0), leadTimeSlug: "standard" }, who);
    assert.strictEqual(q1.status, 200, q1.text.slice(0, 200));
    const before = h.stripe.seq;
    const a = await timed(() => h.post("/api/orders/checkout-session", { quoteId: q1.body.quoteId, ...SHIP }, who));
    assert.strictEqual(a.r.status, 200, a.r.text.slice(0, 200));
    const q2 = await h.post("/api/quote", { parts: parts(1), leadTimeSlug: "standard", quoteId: q1.body.quoteId }, who);
    assert.strictEqual(q2.status, 200, q2.text.slice(0, 200));
    const b = await timed(() => h.post("/api/orders/checkout-session", { quoteId: q2.body.quoteId, ...SHIP }, who));
    assert.strictEqual(b.r.status, 200, b.r.text.slice(0, 200));
    assert.strictEqual(h.models.ordersDB.getById(a.r.body.orderId).status, "expired");
    first.push(a); replace.push(b); sessions.push(h.stripe.seq - before);
  }
  const line = (name, rows) => `${name}: answered in ${median(rows.map((x) => x.ms))} ms (median), ${Math.max(...rows.map((x) => x.ms))} ms at worst; longest hold of the thread ${median(rows.map((x) => x.held))} ms (median), ${Math.max(...rows.map((x) => x.held))} ms at worst`;
  console.log(`${LINES} lines, ${SAMPLES} samples, database ${(require(path.join(ROOT, "server/models/database")).liveSize() / 1e6).toFixed(1)} MB at the end`);
  console.log(line("A  a first checkout                 ", first));
  console.log(line("B  a checkout that replaces an order", replace));
  console.log(`difference of the medians: ${median(replace.map((x) => x.ms)) - median(first.map((x) => x.ms))} ms in the answer, ${median(replace.map((x) => x.held)) - median(first.map((x) => x.held))} ms in the longest hold`);
  await h.stop();
})().catch((e) => { console.error(e); process.exit(2); });
