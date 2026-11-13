#!/usr/bin/env node
/**
 * F-05, counted exactly: the server is killed hard at a random moment while it handles the "paid"
 * event, started again, and Stripe's second delivery of the same event is sent. For every order:
 * how many emails about it reached the buyer and the shop: none (lost), one (right), or two (twice).
 *
 *   node tools/security/rereview-fixes/paid-mail-kill.js [rounds=40] [windowMs=40] [mode=event|start]
 *
 * The reviewer's durability-kill.js section D counts "at least one". This counts exactly, in two modes:
 *   event   after the restart the same event is delivered again (what Stripe does)
 *   start   after the restart NOTHING is delivered: only the start-up pass can send what is owed
 *
 * The test server has no mail provider: a message is "sent" when it is written to the outbox folder,
 * and the row that says it is owed is closed in the next database write. A kill that lands between
 * those two is the one case a message can go twice (with the real provider the request carries an
 * Idempotency-Key, which a local run cannot show). The script reports how often that happened.
 * Exit code 1 if any order was paid and the buyer or the shop got no email.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const live = require("../../../server/testSupport/liveServer");

const ROUNDS = Number(process.argv[2]) || 40;
const WINDOW = Number(process.argv[3]) || 40;
const MODE = process.argv[4] === "start" ? "start" : "event";
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };
const cube = fs.readFileSync(path.join(__dirname, "..", "..", "vet-quotes", "parts", "cube_20mm.stl"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stripeFile = path.join(require("os").tmpdir(), `rf-stripe-${crypto.randomBytes(4).toString("hex")}.json`);
  const whsec = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const env = {
    NODE_OPTIONS: `--require ${path.join(__dirname, "..", "rereview-relaunch", "stripe-stub-preload.js")}`, RR_STRIPE_FILE: stripeFile,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"), STRIPE_WEBHOOK_SECRET: whsec, STRIPE_SECRET_KEY: "sk_test_local_only",
    CHECKOUT_PER_ACCOUNT_15MIN: "100000", QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_DAY: "100000", QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "100000",
    QUOTE_DRAFT_KB_PER_CLIENT: "100000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000",
    // One account checks out many times here on purpose: the ceilings on unpaid orders have their own proofs.
    ORDERS_UNPAID_PER_ACCOUNT: "100000", ORDERS_UNPAID_PER_CLIENT: "100000", ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY: "100000", ORDERS_UNPAID_NEW_PER_CLIENT_DAY: "100000",
  };
  let s = await live.start({ env });
  const tmp = s.tmp;
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
  try {
    let buyer = await s.register("dana@buyer.test");
    const up = await s.upload([{ name: "cube.stl", data: cube }], { token: buyer });
    const partId = up.body.parts[0].partId;
    const mat = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc")[0];
    const line = (qty) => ({ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: qty, process: "cnc", subProcess: "milling" });
    const tally = { rounds: 0, killedBeforeAnswer: 0, paidOnDiskAtKill: 0, exactlyOnce: 0, lost: 0, twice: 0, notPaid: 0 };
    const odd = [];
    for (let i = 0; i < ROUNDS; i++) {
      const q = await s.post("/api/quote", { parts: [line(1 + (i % 3)), line(2)], leadTimeSlug: "standard" }, { token: buyer });
      const c = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { token: buyer });
      if (c.status !== 200) throw new Error(`checkout ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
      const sid = String(c.body.sessionUrl).split("/").pop();
      const event = { id: `evt_rf_${i}_${Date.now()}`, type: "checkout.session.completed", data: { object: markPaid(sid) } };
      let answered = false;
      const p = webhook(event).then((r) => { answered = r.status === 200; }).catch(() => null);
      await sleep(1 + Math.floor(Math.random() * WINDOW));
      await kill();
      await p;
      tally.rounds++;
      if (!answered) tally.killedBeforeAnswer++;
      await restart(); buyer = await login("dana@buyer.test");
      const before = (await s.get(`/api/orders/${c.body.orderId}`, { token: buyer })).body;
      if (before.status === "paid" && !answered) tally.paidOnDiskAtKill++;
      if (MODE === "event" || before.status !== "paid") await webhook(event); // (in "start" mode an order that never became paid still needs its event)
      await sleep(400);
      const o = (await s.get(`/api/orders/${c.body.orderId}`, { token: buyer })).body;
      const ref = c.body.orderId.slice(0, 8).toUpperCase();
      const toBuyer = s.mail("dana@buyer.test").filter((m) => (m.subject + m.text).toUpperCase().includes(ref)).length;
      const toShop = s.mail(s.adminEmail).filter((m) => (m.subject + m.text).toUpperCase().includes(ref)).length;
      if (o.status !== "paid") { tally.notPaid++; odd.push(`round ${i}: order ${o.status}`); }
      else if (toBuyer === 0 || toShop === 0) { tally.lost++; odd.push(`round ${i}: paid; buyer ${toBuyer}, shop ${toShop}`); }
      else if (toBuyer > 1 || toShop > 1) { tally.twice++; odd.push(`round ${i}: paid; buyer ${toBuyer}, shop ${toShop} (answered before the kill: ${answered})`); }
      else tally.exactlyOnce++;
    }
    for (const line of odd) console.log(`  ${line}`);
    console.log(JSON.stringify({ test: "paid-mail-kill", mode: MODE, windowMs: WINDOW, ...tally }));
    console.log(tally.lost || tally.notPaid ? "FINDING: an order was paid and somebody was never told, or a payment was lost" : `HOLDS: ${tally.rounds} kills, every order paid, nobody left untold; told twice: ${tally.twice}`);
    process.exitCode = tally.lost || tally.notPaid ? 1 : 0;
  } finally { try { await s.stop(); } catch { /* gone */ } try { fs.rmSync(stripeFile); } catch { /* gone */ } }
})().catch((e) => { console.error(e); process.exit(2); });
