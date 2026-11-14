#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-05: the server is killed INSIDE the window between "the payment is on
 * the disk" and "the buyer and the shop have been told", with the mail provider switched on.
 *
 *   node tools/security/rereview-fixes/r3-paid-mail-window.js [rounds=25] [modes=begin,accepted,answered,random] [after=event,start]
 *
 * Why another script. The earlier reviewer's durability-kill.js section D kills at a random moment and, in
 * the fix author's final run, never landed in the window (50 of 50 kills fell before the answer). The
 * author's own paid-mail-kill.js runs the server with NO mail provider, which is a different path in the
 * code: without a provider the "email owed" row is closed straight away. In production the provider is
 * on, a message counts as sent only when the provider answers 200, and the provider call takes tens to
 * hundreds of milliseconds: that call IS the window.
 *
 * Here the server runs as in production with a placeholder mail key, and the provider's API is answered
 * by a local stand-in (r3-mail-stub-preload.js) that takes 40 ms to accept a message and 40 ms more to
 * answer, and writes each step to a file. The script watches that file and kills the server at an exact
 * step:
 *
 *   begin      the first email of the paid order has just reached the provider (nothing accepted yet)
 *   accepted   the provider has just accepted an email and has not answered the server yet
 *   answered   the provider has just answered; the server is about to write "sent" and start the next
 *   random     1 to 120 ms after the event is posted
 *
 * After the kill the server is started again and then either the same event is delivered again (what
 * Stripe does: "event") or nothing is ("start": only the start-up pass can send what is owed).
 *
 * Counted per order, from what the PROVIDER accepted (not from what the server meant to send): how many
 * confirmations for the buyer and how many notices for the shop; and for a message accepted twice,
 * whether both requests carried the same Idempotency-Key (the provider can drop the repeat) or not.
 * Exit code 1 if any paid order ends with the buyer or the shop never told.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const live = require("../../../server/testSupport/liveServer");

const ROUNDS = Number(process.argv[2]) || 25;
const MODES = String(process.argv[3] || "begin,accepted,answered,random").split(",");
const AFTERS = String(process.argv[4] || "event,start").split(",");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };
const cube = fs.readFileSync(path.join(__dirname, "..", "..", "vet-quotes", "parts", "cube_20mm.stl"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "r3-mail-"));
  const stripeFile = path.join(scratch, "stripe.json");
  const mailLog = path.join(scratch, "provider.log");
  fs.writeFileSync(mailLog, "");
  const whsec = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const env = {
    NODE_OPTIONS: `--require ${path.join(__dirname, "r3-mail-stub-preload.js")}`, RR_STRIPE_FILE: stripeFile, R3_MAIL_LOG: mailLog, R3_MAIL_BEFORE_MS: "40", R3_MAIL_AFTER_MS: "40",
    EMAIL_API_KEY: "r3-not-a-key", EMAIL_FROM: "Straightedge <quotes@straightedge.test>",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"), STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_local_only",
    CHECKOUT_PER_ACCOUNT_15MIN: "100000", QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_DAY: "100000", QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "100000",
    QUOTE_DRAFT_KB_PER_CLIENT: "100000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000",
    // Every round pays its order, so the ceilings on unpaid orders are not met; they are left as production has them.
  };
  let s = await live.start({ env });
  const tmp = s.tmp;
  const provider = () => fs.readFileSync(mailLog, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const markPaid = (id) => { const j = JSON.parse(fs.readFileSync(stripeFile, "utf8")); Object.assign(j.sessions[id], { status: "complete", payment_status: "paid", payment_intent: `pi_${id}` }); fs.writeFileSync(stripeFile, JSON.stringify(j)); return j.sessions[id]; };
  const signed = (event) => {
    const payload = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac("sha256", whsec).update(`${t}.${payload}`).digest("hex");
    return { body: Buffer.from(payload), headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)), "Stripe-Signature": `t=${t},v1=${v1}` } };
  };
  const webhook = (event) => { const w = signed(event); return s.req({ url: "/api/stripe/webhook", method: "POST", body: w.body, headers: w.headers }); };
  const kill = async () => { s.child.kill("SIGKILL"); await new Promise((r) => (s.exited() ? r() : s.child.once("exit", r))); };
  const restart = async () => { const keys = s.editKeys, pw = s.passwords; s = await live.start({ env, tmpDir: tmp }); s.editKeys = keys; s.passwords = pw; };
  const login = async (email) => (await s.post("/api/auth/login", { email, password: s.passwords[email] }, {})).body.token;
  const BUYER = "dana@buyer.test";
  const results = [];
  try {
    let buyer = await s.register(BUYER);
    const up = await s.upload([{ name: "cube.stl", data: cube }], { token: buyer });
    const partId = up.body.parts[0].partId;
    const mat = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc")[0];
    const line = (qty) => ({ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: qty, process: "cnc", subProcess: "milling" });
    let n = 0;
    for (const after of AFTERS) for (const mode of MODES) {
      const tally = { mode, after, rounds: 0, killInTheWindow: 0, killedBeforeTheAnswer: 0, paidOnDiskAtTheKill: 0, toldOnce: 0, untold: 0, toldTwiceSameKey: 0, toldTwiceOtherKey: 0, notPaid: 0, messagesWithoutAKey: 0 };
      const odd = [];
      for (let i = 0; i < ROUNDS; i++) {
        n++;
        const q = await s.post("/api/quote", { parts: [line(1 + (n % 3)), line(2)], leadTimeSlug: "standard" }, { token: buyer });
        const c = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { token: buyer });
        if (c.status !== 200) throw new Error(`checkout ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
        const ref = c.body.orderId.slice(0, 8).toUpperCase();
        const sid = String(c.body.sessionUrl).split("/").pop();
        const event = { id: `evt_r3_${n}_${Date.now()}`, type: "checkout.session.completed", data: { object: markPaid(sid) } };
        const seenBefore = provider().length;
        let answered = false;
        const p = webhook(event).then((r) => { answered = r.status === 200; }).catch(() => null);
        // Kill at the chosen step of the provider's handling of THIS order's first email, or at a random moment.
        let stepAtKill = "none";
        if (mode === "random") {
          await sleep(1 + Math.floor(Math.random() * 120));
        } else {
          const deadline = Date.now() + 3000;
          for (;;) {
            const now = provider().slice(seenBefore);
            if (now.some((l) => l.step === mode)) { stepAtKill = mode; break; }
            if (Date.now() > deadline) break;
            await new Promise((r) => setImmediate(r));
          }
        }
        await kill();
        await p;
        const atKill = provider().slice(seenBefore);
        tally.rounds++;
        if (!answered) tally.killedBeforeTheAnswer++;
        await restart(); buyer = await login(BUYER);
        const before = (await s.get(`/api/orders/${c.body.orderId}`, { token: buyer })).body;
        // "In the window": the payment was on the disk and at least one of the two emails had not been answered for.
        const answeredAtKill = atKill.filter((l) => l.step === "answered").length;
        if (before.status === "paid" && answeredAtKill < 2) tally.killInTheWindow++;
        if (before.status === "paid" && !answered) tally.paidOnDiskAtTheKill++;
        if (after === "event" || before.status !== "paid") await webhook(event);
        // Let whatever is owed go out (the stand-in takes 80 ms a message; the start-up pass has already begun).
        for (let w = 0; w < 30; w++) { await sleep(100); const acc = provider().filter((l) => l.step === "accepted" && String(l.subject).toUpperCase().includes(ref)); if (acc.length >= 2 && w > 5) break; }
        const o = (await s.get(`/api/orders/${c.body.orderId}`, { token: buyer })).body;
        const accepted = provider().filter((l) => l.step === "accepted" && String(l.subject).toUpperCase().includes(ref));
        const forBuyer = accepted.filter((l) => l.to === BUYER || (Array.isArray(l.to) && l.to.includes(BUYER)));
        const forShop = accepted.filter((l) => l.to === s.adminEmail || (Array.isArray(l.to) && l.to.includes(s.adminEmail)));
        tally.messagesWithoutAKey += accepted.filter((l) => !l.key).length;
        const twice = (list) => list.length > 1;
        const sameKey = (list) => new Set(list.map((l) => l.key)).size === 1 && Boolean(list[0].key);
        if (o.status !== "paid") { tally.notPaid++; odd.push(`round ${n}: order ${o.status}`); }
        else if (forBuyer.length === 0 || forShop.length === 0) { tally.untold++; odd.push(`round ${n} (${mode}/${after}): PAID and buyer ${forBuyer.length}, shop ${forShop.length}; step at kill ${stepAtKill}; answered ${answered}`); }
        else if (twice(forBuyer) || twice(forShop)) {
          const same = (!twice(forBuyer) || sameKey(forBuyer)) && (!twice(forShop) || sameKey(forShop));
          if (same) tally.toldTwiceSameKey++; else { tally.toldTwiceOtherKey++; odd.push(`round ${n} (${mode}/${after}): twice with DIFFERENT keys: buyer ${forBuyer.map((l) => l.key).join(" / ")}; shop ${forShop.map((l) => l.key).join(" / ")}`); }
        } else tally.toldOnce++;
      }
      for (const l of odd) console.log(`  ${l}`);
      console.log(JSON.stringify(tally));
      results.push(tally);
    }
    const sum = (k) => results.reduce((a, r) => a + r[k], 0);
    const total = { test: "r3-paid-mail-window", rounds: sum("rounds"), killInTheWindow: sum("killInTheWindow"), toldOnce: sum("toldOnce"), untold: sum("untold"), toldTwiceSameKey: sum("toldTwiceSameKey"), toldTwiceOtherKey: sum("toldTwiceOtherKey"), notPaid: sum("notPaid"), messagesWithoutAKey: sum("messagesWithoutAKey"), node: process.version };
    console.log(JSON.stringify(total));
    console.log(total.untold || total.notPaid ? "FINDING: a paid order whose buyer or shop was never told, or a payment that was lost" : `HOLDS: ${total.rounds} kills (${total.killInTheWindow} inside the window): every order paid, nobody left untold. Told twice: ${total.toldTwiceSameKey} with the same Idempotency-Key, ${total.toldTwiceOtherKey} with different keys`);
    process.exitCode = total.untold || total.notPaid ? 1 : 0;
  } finally { try { await s.stop(); } catch { /* gone */ } try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* gone */ } }
})().catch((e) => { console.error(e); process.exit(2); });
