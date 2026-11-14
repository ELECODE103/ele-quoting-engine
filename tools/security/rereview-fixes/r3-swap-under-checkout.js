#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-08 by another door: the quote is swapped for a heavy one between
 * checkout's warm-up and its final pass.
 *
 *   node tools/security/rereview-fixes/r3-swap-under-checkout.js [trials=40] [padMb=0]
 *
 * How checkout was made safe for the thread (routes/orders.js orderStep, services/pricingMemo.js): the
 * pricing is done in "warm-up" pieces with other requests served in between, and a FINAL pass then runs
 * in one piece "with everything priced already in the runner's memo". Before the final pass the runner
 * checks that no PART and no catalogue table changed. It does not check the QUOTE. The final pass reads
 * the quote afresh; if the buyer has re-priced that same draft into something else in the meantime, the
 * final pass finds none of it in the memo and prices all of it in one uninterrupted step.
 *
 * So, one confirmed account:
 *   1. a draft quote Q of one small cube (a "light" job for the runner)
 *   2. request A: re-price Q in place as N different dense drawings (a "heavy" job: about a second of
 *      pricing, done in pieces, which is fine)
 *   3. request B: "pay" for Q, sent so that it arrives just before A finishes. B is judged light (Q is
 *      still the cube), warms up in one tick on the cube, A's last piece then stores the heavy Q, and
 *      B's final pass prices the heavy Q in one step.
 *
 * The script first times A alone, then sends B at offsets around the moment A finishes, and watches the
 * health page every 5 ms. A trial "landed" when B's order has the heavy quote's lines. Prints every
 * trial and the worst hold. Exit code 1 when a landed trial held the thread 250 ms or more.
 *
 * The per-account checkout pacing (12 per 15 minutes) and the ceilings on unpaid orders are lifted for
 * the sweep: an attacker spreads the tries over accounts; each account also has its own draft to swap.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");
const { fineDisc } = require("./order-list-worst");

const TRIALS = Number(process.argv[2]) || 40;
const PAD_MB = Number(process.argv[3]) || 0;
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

(async () => {
  const env = {
    QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "100000", QUOTE_NEW_PER_CLIENT_DAY: "100000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000",
    ORDERS_UNPAID_PER_ACCOUNT: "1000", ORDERS_UNPAID_PER_CLIENT: "1000", ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY: "1000", ORDERS_UNPAID_NEW_PER_CLIENT_DAY: "1000", CHECKOUT_PER_ACCOUNT_15MIN: "1000",
    QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR: "3600", QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR: "3600", UPLOAD_MAX_PARTS_PER_15MIN: "100000",
  };
  let s = await c.startServer({ stubs: true, env });
  const tmp = s.tmp;
  try {
    const ip = "192.0.2.77";
    const email = "swapper@example.test";
    let token = await s.register(email, { ip });
    const cube = await c.uploadOne(s, "cube.stl", c.g.stlCube(12), { ip, token });
    const cubeLine = { ...(await c.lineFor(s, cube.partId, "3d-printing", ip)).line, quantity: 1 };
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push((await c.uploadOne(s, `disc-${i}.dxf`, fineDisc(6000 + 40 * i), { ip: "192.0.2.78", token, fields: { process: "routing" }, attempts: 6 })).partId);
    const { line: discLine } = await c.lineFor(s, ids[0], "routing", ip);
    // The most different discs that can still be ordered online (under the firm-quote lines).
    let n = 25; let heavy;
    for (;;) {
      heavy = ids.slice(0, n).map((id) => ({ ...discLine, partId: id, quantity: 1 }));
      const q = await s.post("/api/quote", { parts: heavy, leadTimeSlug: "standard" }, { ip, token, timeoutMs: 180000 });
      if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) { c.log(`heavy quote: ${n} different 6,000-segment discs, $${q.body.orderTotal}, orderable online`); break; }
      if (n <= 1) throw new Error(`no orderable heavy quote: ${q.status} ${q.text.slice(0, 200)}`);
      n = Math.max(1, Math.floor(n * 0.8));
    }
    if (PAD_MB > 0) {
      const keys = s.editKeys, pw = s.passwords;
      await s.stop({ keep: true });
      const SQL = await initSqlJs();
      const file = path.join(tmp, "data", "quoting.db");
      const db = new SQL.Database(fs.readFileSync(file));
      db.run("CREATE TABLE IF NOT EXISTS rr_filler (id INTEGER PRIMARY KEY, body BLOB)");
      const have = db.exec("PRAGMA page_count")[0].values[0][0] * db.exec("PRAGMA page_size")[0].values[0][0];
      const chunk = require("crypto").randomBytes(64 * 1024);
      for (let b = have; b < PAD_MB * c.MB; b += chunk.length) db.run("INSERT INTO rr_filler (body) VALUES (?)", [chunk]);
      fs.writeFileSync(file, Buffer.from(db.export())); db.close();
      s = await c.startServer({ stubs: true, env, tmpDir: tmp });
      s.editKeys = keys; s.passwords = pw;
      token = (await s.post("/api/auth/login", { email, password: pw[email] }, { ip })).body.token;
    }
    const newCubeQuote = async () => { const q = await s.post("/api/quote", { parts: [cubeLine], leadTimeSlug: "standard" }, { ip, token }); if (q.status !== 200) throw new Error(`cube quote ${q.status} ${q.text.slice(0, 160)}`); return q.body.quoteId; };
    const swap = (quoteId) => s.post("/api/quote", { parts: heavy, leadTimeSlug: "standard", quoteId }, { ip, token, timeoutMs: 180000 });

    // How long does the swap (request A) take by itself, and how much does IT hold the thread?
    const alone = [];
    for (let i = 0; i < 4; i++) {
      const id = await newCubeQuote();
      await c.sleep(1800);
      const mon = c.monitor(s, { everyMs: 5 });
      const t0 = Date.now();
      const a = await swap(id);
      const ms = Date.now() - t0;
      await c.sleep(200);
      const held = await mon.stop();
      alone.push({ ms, status: a.status, sameQuote: a.body && a.body.quoteId === id, holdMs: held.worstMs });
    }
    c.log(`request A alone (re-pricing the draft as the heavy quote, in pieces): ${JSON.stringify(alone)}`);
    const dA = alone.slice(1).map((x) => x.ms).sort((x, y) => x - y)[1] || alone[0].ms;

    const rows = [];
    for (let t = 0; t < TRIALS; t++) {
      // Offsets sweep from well before A finishes to just after it.
      const offset = Math.max(0, Math.round(dA - 160 + (t % 20) * 9));
      const id = await newCubeQuote();
      await c.sleep(1800); // the draft reaches the file; the thread is quiet
      const mon = c.monitor(s, { everyMs: 5 });
      const t0 = Date.now();
      const aP = swap(id).then((r) => ({ r, ms: Date.now() - t0 }));
      await c.sleep(offset);
      const tB = Date.now();
      const b = await s.post("/api/orders/checkout-session", { quoteId: id, ...SHIP }, { ip, token, timeoutMs: 180000 });
      const bMs = Date.now() - tB;
      const a = await aP;
      await c.sleep(250);
      const held = await mon.stop();
      let lines = null;
      if (b.status === 200) lines = ((await s.get(`/api/orders/${b.body.orderId}`, { token, ip })).body.items || []).length;
      const row = { trial: t, offsetMs: offset, aMs: a.ms, aStatus: a.r.status, aKeptTheQuote: a.r.body && a.r.body.quoteId === id, b: `${b.status}${b.body && b.body.code ? " " + b.body.code : ""}`, bMs, orderLines: lines, landed: lines === heavy.length, holdMs: held.worstMs };
      rows.push(row);
      c.log(JSON.stringify(row));
    }
    const landed = rows.filter((r) => r.landed);
    const worstLanded = landed.length ? Math.max(...landed.map((r) => r.holdMs)) : 0;
    const others = rows.filter((r) => !r.landed).map((r) => r.holdMs);
    c.result({
      test: "r3-swap-under-checkout", machine: os.loadavg()[0] > 2.5 ? "loaded" : "quiet", databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)), heavyLines: heavy.length,
      requestAAloneMs: alone.map((x) => x.ms), requestAAloneHoldMs: alone.map((x) => x.holdMs),
      trials: rows.length, landed: landed.length, landedHoldMs: landed.map((r) => r.holdMs), landedAtOrOver250: landed.filter((r) => r.holdMs >= 250).length, worstLandedHoldMs: worstLanded,
      notLandedWorstHoldMs: others.length ? Math.max(...others) : null,
    });
    const bad = landed.filter((r) => r.holdMs >= 250).length;
    console.log(bad ? `FINDING: in ${bad} of ${rows.length} tries the checkout's final pass priced the swapped-in quote in one step and held the thread ${worstLanded} ms at worst` : `HOLDS: ${landed.length} tries landed; none held the thread 250 ms or more`);
    process.exitCode = bad ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
