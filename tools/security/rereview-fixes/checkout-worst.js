#!/usr/bin/env node
/**
 * F-08, worst case: how long one checkout holds the server's one thread, and what another visitor
 * gets while it runs, at a 12 MB database.
 *
 *   node tools/security/rereview-fixes/checkout-worst.js [padMb=12] [cases=A,B,C,D]
 *   node tools/security/rereview-fixes/with-load.js 4 tools/security/rereview-fixes/checkout-worst.js   (the same, loaded)
 *
 * The reviewer's checkout-hold.js presses "pay" on 100 lines of a cube and watches the health page.
 * This one presses "pay" on the heaviest quotes the site sells online:
 *
 *   A  100 lines of a 12 mm cube, printed                 (the reviewer's case: the most lines, the most rows to write)
 *   B  100 lines of one drawing with 1,600 holes, routed   (one dense part on every line)
 *   C  25 lines, each a DIFFERENT disc of 6,000 segments  (the most pricing work that fits under $5,000: nothing is shared between lines)
 *   D  lines, each a DIFFERENT drawing with 3,000 holes    (the densest drawings; few fit under $5,000)
 *
 * each as many lines as the gate lets through under $5,000, on a database padded to `padMb`, and each
 * three times (three unpaid orders is what one account may hold). While each checkout runs:
 *   - the health page is asked for every 20 ms                  → the longest wait = the longest hold of the thread
 *   - another visitor re-prices a one-line quote every 120 ms   → median and worst of what a real customer waits
 *
 * Prints one row per checkout. Exit code 1 if a checkout fails, or (quiet machine only) the health
 * page waits 250 ms or more, or the other visitor's median re-price is 1 s or more.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");

const PAD_MB = Number(process.argv[2]) || 12;
const CASES = String(process.argv[3] || "A,B,C,D").split(",");
const { fineDisc } = require("./order-list-worst");
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

(async () => {
  const SQL = await initSqlJs();
  const env = {
    QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000",
    // Nine checkouts by one account in a few minutes, on purpose: the ceilings on unpaid orders and on pricing time have their own proofs.
    ORDERS_UNPAID_PER_ACCOUNT: "1000", ORDERS_UNPAID_PER_CLIENT: "1000", ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY: "1000", ORDERS_UNPAID_NEW_PER_CLIENT_DAY: "1000",
    QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR: "3600", QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR: "3600", UPLOAD_MAX_PARTS_PER_15MIN: "100000",
  };
  let s = await c.startServer({ stubs: true, env });
  const tmp = s.tmp;
  const rows = [];
  let failed = false;
  const loaded = os.loadavg()[0] > 2.5;
  try {
    const ip = "192.0.2.77";
    const email = "holder@example.test";
    let token = await s.register(email, { ip });
    const quotes = {};
    const largest = async (label, make) => {
      let lines = make.max, q;
      for (;;) {
        q = await s.post("/api/quote", { parts: make.lines(lines), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 180000 });
        if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) break;
        if (q.status === 429 || q.status === 503) { await c.sleep(3000); continue; }
        if (lines <= 1) throw new Error(`${label}: no quote: ${q.status} ${q.text.slice(0, 200)}`);
        lines = Math.max(1, Math.floor(lines * 0.8));
      }
      return { lines, body: make.lines(lines), total: q.body.orderTotal };
    };
    if (CASES.includes("A")) {
      const cube = await c.uploadOne(s, "block.stl", c.g.stlCube(12), { ip, token });
      const { line } = await c.lineFor(s, cube.partId, "3d-printing", ip);
      quotes.A = { label: "A: lines of a 12 mm cube, printed", ...(await largest("A", { max: 100, lines: (n) => Array.from({ length: n }, () => ({ ...line, quantity: 1 })) })) };
    }
    if (CASES.includes("B")) {
      const sheet = await c.uploadOne(s, "holes-1600.dxf", c.g.dxfManyHoles(1600), { ip, token, fields: { process: "routing" }, attempts: 6 });
      const { line } = await c.lineFor(s, sheet.partId, "routing", ip);
      quotes.B = { label: "B: lines of one 1,600-hole drawing, routed", ...(await largest("B", { max: 100, lines: (n) => Array.from({ length: n }, () => ({ ...line, quantity: 1 })) })) };
    }
    if (CASES.includes("C")) {
      // A disc drawn as thousands of short segments is cheap to cut and large to measure: the most
      // pricing work per dollar, so the most distinct heavy parts that fit under $5,000.
      const ids = [];
      for (let i = 0; i < 25; i++) ids.push((await c.uploadOne(s, `disc-${i}.dxf`, fineDisc(6000 + 40 * i), { ip: "192.0.2.78", token, fields: { process: "routing" }, attempts: 6 })).partId);
      const { line } = await c.lineFor(s, ids[0], "routing", ip);
      quotes.C = { label: "C: lines, each a different disc of 6,000 segments, routed", ...(await largest("C", { max: 25, lines: (n) => ids.slice(0, n).map((id) => ({ ...line, partId: id, quantity: 1 })) })) };
    }
    if (CASES.includes("D")) {
      const ids = [];
      for (let i = 0; i < 25; i++) ids.push((await c.uploadOne(s, `sheet-${i}.dxf`, c.g.dxfManyHoles(3000 + i), { ip: "192.0.2.79", token, fields: { process: "routing" }, attempts: 6 })).partId);
      const { line } = await c.lineFor(s, ids[0], "routing", ip);
      quotes.D = { label: "D: lines, each a different 3,000-hole drawing, routed", ...(await largest("D", { max: 25, lines: (n) => ids.slice(0, n).map((id) => ({ ...line, partId: id, quantity: 1 })) })) };
    }
    // The other visitor: a cube of their own, one line.
    const V = "203.0.113.9";
    const vCube = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip: V });
    const vLine = { ...(await c.lineFor(s, vCube.partId, "cnc", V)).line, subProcess: "milling" };
    const v0 = await s.post("/api/quote", { parts: [vLine], leadTimeSlug: "standard" }, { ip: V });
    const keys = s.editKeys, pw = s.passwords;

    // Pad the database while the server is stopped.
    await s.stop({ keep: true });
    const file = path.join(tmp, "data", "quoting.db");
    const db = new SQL.Database(fs.readFileSync(file));
    db.run("CREATE TABLE IF NOT EXISTS rr_filler (id INTEGER PRIMARY KEY, body BLOB)");
    const have = db.exec("PRAGMA page_count")[0].values[0][0] * db.exec("PRAGMA page_size")[0].values[0][0];
    const chunk = require("crypto").randomBytes(64 * 1024);
    for (let n = have; n < PAD_MB * c.MB; n += chunk.length) db.run("INSERT INTO rr_filler (body) VALUES (?)", [chunk]);
    fs.writeFileSync(file, Buffer.from(db.export())); db.close();
    s = await c.startServer({ stubs: true, env, tmpDir: tmp });
    s.editKeys = keys; s.passwords = pw;
    token = (await s.post("/api/auth/login", { email, password: pw[email] }, { ip })).body.token;

    for (const key of Object.keys(quotes)) {
      const Q = quotes[key];
      for (let round = 1; round <= 3; round++) {
        const q = await s.post("/api/quote", { parts: Q.body, leadTimeSlug: "standard" }, { ip, token, timeoutMs: 180000 });
        if (q.status !== 200) throw new Error(`${key}: quote ${q.status} ${q.text.slice(0, 160)}`);
        await c.sleep(2200); // the draft reaches the file; the thread is quiet
        const health = []; const visitor = []; let stop = false;
        const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.5", timeoutMs: 60000 }); } catch { /* its time counts */ } health.push(Date.now() - t); await c.sleep(20); } })();
        const other = (async () => { let n = 0; while (!stop) { const t = Date.now(); const r = await s.post("/api/quote", { parts: [{ ...vLine, quantity: 1 + (n++ % 9) }], leadTimeSlug: "standard", quoteId: v0.body.quoteId }, { ip: V, timeoutMs: 60000 }).catch(() => ({ status: 0 })); visitor.push({ ms: Date.now() - t, status: r.status }); await c.sleep(120); } })();
        await c.sleep(800);
        const before = { health: Math.max(...health), visitor: median(visitor.map((x) => x.ms)) };
        health.length = 0; visitor.length = 0;
        const t0 = Date.now();
        const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ip, token, timeoutMs: 180000 });
        const checkoutMs = Date.now() - t0;
        await c.sleep(400);
        stop = true; await Promise.all([pinger, other]);
        const vms = visitor.map((x) => x.ms);
        const row = {
          case: Q.label, round, databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)), lines: Q.lines, orderTotal: Q.total, checkout: co.status, code: (co.body && co.body.code) || undefined, checkoutMs,
          healthWorstBeforeMs: before.health, healthWorstDuringMs: Math.max(...health),
          otherVisitor: { tries: visitor.length, priced: visitor.filter((x) => x.status === 200).length, medianMs: median(vms), worstMs: Math.max(...vms), medianBeforeMs: before.visitor },
        };
        rows.push(row); c.log(JSON.stringify(row));
        // Loaded, a quote the instant quote cannot price in time is refused in words (422 quote-too-slow, 503 pricing-busy): that is an answer, not a failure.
        const answered = co.status === 200 || (loaded && [422, 429, 503].includes(co.status));
        if (!answered) failed = true;
        if (!loaded && (row.healthWorstDuringMs >= 250 || row.otherVisitor.medianMs >= 1000)) failed = true;
        if (loaded && row.otherVisitor.medianMs >= 1000) failed = true;
      }
    }
    c.result({ test: "checkout-worst", machine: loaded ? "loaded" : "quiet", limits: { healthWorstQuietMs: 250, otherVisitorMedianMs: 1000 }, rows });
    if (failed) console.log("FINDING: a checkout failed, or held the thread 250 ms or more (quiet), or the other visitor's median re-price was 1 s or more");
    process.exitCode = failed ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
