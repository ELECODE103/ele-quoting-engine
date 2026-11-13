#!/usr/bin/env node
/**
 * How long does ONE checkout hold the server's one thread? (re-review 2026-11-12, area 5)
 *
 *   node tools/security/rereview-relaunch/checkout-hold.js [lines=100] [padMb=0,6,12]
 *
 * Checkout prices the saved quote again and writes the order in one uninterrupted step. Each order line is
 * written with its own save of the WHOLE database file (export, write, two flushes). So the step grows
 * with the number of lines and with the size of the database. This measures it:
 *
 *   - a quote of N lines of one small plain part (the cheapest thing there is: nothing dense, nothing clever),
 *     each line a different quantity, kept under the $5,000 line so it can be checked out online
 *   - the database at its natural size, then padded to 6 MB and 12 MB (a table of filler rows added while
 *     the server is stopped; the default ceiling is 16 MB), which is what a busy shop's database looks like
 *   - while one confirmed account presses "pay" once, another visitor asks for the health page every 20 ms
 *
 * Prints, for each size: the checkout's own time, the longest the health page waited, and how many
 * whole-file saves the step made. Uses the repo's child-server helper and Stripe stand-in.
 */
const fs = require("fs");
const path = require("path");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");

const LINES = Number(process.argv[2]) || 100;
const PADS = (process.argv[3] || "0,6,12").split(",").map(Number);
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

(async () => {
  const SQL = await initSqlJs();
  const env = { QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000" };
  let s = await c.startServer({ stubs: true, env });
  const tmp = s.tmp;
  const rows = [];
  try {
    const ip = "192.0.2.77";
    const email = "holder@example.test";
    let token = await s.register(email, { ip });
    const part = await c.uploadOne(s, "block.stl", c.g.stlCube(12), { ip, token });
    const proc = process.argv[4] || "3d-printing"; // the cheapest lines the site sells: the most lines under the $5,000 line
    const { line } = await c.lineFor(s, part.partId, proc, ip);
    const keys = s.editKeys, pw = s.passwords;
    for (const padMb of PADS) {
      if (padMb > 0) {
        // Stop, add filler to the database file, start again on the same folder.
        await s.stop({ keep: true });
        const file = path.join(tmp, "data", "quoting.db");
        const db = new SQL.Database(fs.readFileSync(file));
        db.run("CREATE TABLE IF NOT EXISTS rr_filler (id INTEGER PRIMARY KEY, body BLOB)");
        const have = db.exec("PRAGMA page_count")[0].values[0][0] * db.exec("PRAGMA page_size")[0].values[0][0];
        const chunk = require("crypto").randomBytes(64 * 1024);
        for (let n = have; n < padMb * c.MB; n += chunk.length) db.run("INSERT INTO rr_filler (body) VALUES (?)", [chunk]);
        fs.writeFileSync(file, Buffer.from(db.export())); db.close();
        s = await c.startServer({ stubs: true, env, tmpDir: tmp });
        s.editKeys = keys; s.passwords = pw;
        token = (await s.post("/api/auth/login", { email, password: pw[email] }, { ip })).body.token;
      }
      // The largest quote of this part the gate lets through: N lines, quantities 1, 1, 1 … (100 pieces at most online).
      let lines = LINES, q;
      for (;;) {
        q = await s.post("/api/quote", { parts: Array.from({ length: lines }, (_, i) => ({ ...line, quantity: 1 })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 120000 });
        if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) break;
        if (lines <= 1) throw new Error(`no quote: ${q.status} ${q.text.slice(0, 200)}`);
        lines = Math.floor(lines * 0.8);
      }
      await c.sleep(2000); // the draft reaches the file; the thread is quiet
      const dbMb = (c.dbBytes(s) / c.MB).toFixed(1);
      const health = []; let stop = false;
      const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.5", timeoutMs: 60000 }); } catch { /* counted as its time */ } health.push(Date.now() - t); await c.sleep(20); } })();
      await c.sleep(600);
      const quiet = Math.max(...health);
      health.length = 0;
      const t0 = Date.now();
      const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ip, token, timeoutMs: 120000 });
      const checkoutMs = Date.now() - t0;
      await c.sleep(300);
      stop = true; await pinger;
      const row = { databaseMb: Number(dbMb), lines, orderTotal: q.body.orderTotal, checkout: co.status, checkoutMs, healthWorstQuietMs: quiet, healthWorstDuringMs: Math.max(...health), healthSamplesOver250ms: health.filter((x) => x > 250).length };
      rows.push(row); c.log(JSON.stringify(row));
    }
    c.result({ test: "checkout-hold", note: "one press of 'pay' by one confirmed account; 12 are allowed per account per 15 minutes", rows });
    process.exitCode = rows.some((r) => r.healthWorstDuringMs > 2000) ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
