#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-08: how long does a 100-line checkout hold the server's one thread,
 * as a DISTRIBUTION and not a best of three.
 *
 *   node tools/security/rereview-fixes/r3-checkout-dist.js [mode=single] [padMb=11.7] [batches=10] [perBatch=3]
 *   node tools/security/rereview-fixes/with-load.js 4 tools/security/rereview-fixes/r3-checkout-dist.js single 11.7 10 3
 *
 *   mode single      one account presses "pay" on 100 lines of a printed cube
 *   mode together    three accounts press "pay" on their own 100-line quotes at the same instant
 *   mode draft       the buyer re-prices the quote and presses "pay" 150 ms later (the draft's own
 *                    write of the file is still waiting when the checkout arrives)
 *
 * Every 100-line unpaid order adds about 0.3 MB to the database, so each batch starts a NEW server on a
 * new folder, pads its database to `padMb` and makes `perBatch` checkouts: the file is between padMb and
 * padMb + 0.3 x perBatch MB for every sample (11.7 to 12.6 MB by default; the line the fix was given is
 * "under 250 ms on a 12 MB database"). The ceilings on unpaid orders are lifted for the script, as the
 * author's scripts do: one account makes several unpaid orders here on purpose.
 *
 * The hold is measured by asking for the health page every 5 ms on overlapping connections for the
 * whole of each checkout: the longest wait is the longest the thread was held (to within 5 ms). The
 * author's scripts ask every 20 ms and one at a time, which can under-read a hold by up to 20 ms.
 *
 * Two readings are taken at once: on new connections (`holdMs`) and on connections that are already open
 * (`holdOpenMs`); see monitorOpen below for why they differ.
 *
 * Prints every sample, then the median, the 90th percentile, the worst, and how many were at or over
 * 250 ms. Exit code 1 if any sample is at or over 250 ms.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");

const MODE = process.argv[2] || "single";
const PAD_MB = Number(process.argv[3]) || 11.7;
const BATCHES = Number(process.argv[4]) || 10;
const PER_BATCH = Number(process.argv[5]) || 3;
const LINES = 100;
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

/**
 * The same watch on connections that are ALREADY OPEN (kept alive), which is how a browser that is on the
 * site, or a proxy in front of it, reaches the server. A request on an open connection is read at the
 * server's next look at the network; one on a NEW connection is accepted at that look and read at the one
 * after, so when the server does two pieces of work back to back with one look between them (checkout:
 * the final pricing pass, then the write of the file) a new connection waits for both and an open one for
 * the longer of the two. Both are reported: `holdMs` (new connections) and `holdOpenMs` (open ones).
 */
function monitorOpen(s, { everyMs = 5, sockets = 24 } = {}) {
  const http = require("http");
  const agent = new http.Agent({ keepAlive: true, maxSockets: sockets, maxFreeSockets: sockets });
  const lat = [];
  let inFlight = 0; let stopped = false;
  const one = () => new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: "127.0.0.1", port: s.port, path: "/api/health", agent }, (res) => { res.resume(); res.on("end", () => { lat.push(Number(process.hrtime.bigint() - t0) / 1e6); resolve(); }); });
    req.on("error", () => resolve());
    req.end();
  });
  const tick = () => { if (stopped || inFlight >= sockets) return; inFlight++; one().then(() => { inFlight--; }); };
  const timer = setInterval(tick, everyMs);
  return {
    // Open the connections first, so that none of the samples that follow is on a new one.
    async warm() { await Promise.all(Array.from({ length: sockets }, () => one())); lat.length = 0; },
    async stop() { stopped = true; clearInterval(timer); for (let i = 0; i < 100 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 30)); agent.destroy(); return { worstMs: Math.round(Math.max(0, ...lat)), samples: lat.length }; },
  };
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

(async () => {
  const SQL = await initSqlJs();
  const env = {
    QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000",
    ORDERS_UNPAID_PER_ACCOUNT: "1000", ORDERS_UNPAID_PER_CLIENT: "1000", ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY: "1000", ORDERS_UNPAID_NEW_PER_CLIENT_DAY: "1000",
  };
  const samples = [];
  const buyers = MODE === "together" ? 3 : 1;
  for (let batch = 0; batch < BATCHES; batch++) {
    let s = await c.startServer({ stubs: true, env });
    const tmp = s.tmp;
    try {
      const who = [];
      for (let b = 0; b < buyers; b++) {
        const ip = `192.0.2.${70 + b}`;
        const email = `holder${b}@example.test`;
        const token = await s.register(email, { ip });
        const part = await c.uploadOne(s, "block.stl", c.g.stlCube(12), { ip, token });
        who.push({ ip, email, partId: part.partId });
      }
      const { line } = await c.lineFor(s, who[0].partId, "3d-printing", who[0].ip);
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
      for (const w of who) w.token = (await s.post("/api/auth/login", { email: w.email, password: pw[w.email] }, { ip: w.ip })).body.token;

      for (let round = 0; round < PER_BATCH; round++) {
        const quotes = [];
        for (const w of who) {
          const q = await s.post("/api/quote", { parts: Array.from({ length: LINES }, () => ({ ...line, partId: w.partId, quantity: 1 })), leadTimeSlug: "standard" }, { ip: w.ip, token: w.token, timeoutMs: 120000 });
          if (q.status !== 200 || (q.body.gate && q.body.gate.requiresRfq)) throw new Error(`no quote: ${q.status} ${q.text.slice(0, 200)}`);
          quotes.push(q.body);
        }
        await c.sleep(2300); // the drafts reach the file; the thread is quiet
        const dbMb = Number((c.dbBytes(s) / c.MB).toFixed(2));
        const before = c.monitor(s, { everyMs: 5 });
        await c.sleep(500);
        const quiet = await before.stop();
        const during = c.monitor(s, { everyMs: 5 });
        const open = monitorOpen(s, { everyMs: 5 });
        await open.warm();
        if (MODE === "draft") {
          // Re-price the same draft (its write of the file may wait 1.5 s), then pay 150 ms later.
          await s.post("/api/quote", { parts: Array.from({ length: LINES }, () => ({ ...line, partId: who[0].partId, quantity: 1 })), leadTimeSlug: "standard", quoteId: quotes[0].quoteId }, { ip: who[0].ip, token: who[0].token, timeoutMs: 120000 });
          await c.sleep(150);
        }
        const t0 = Date.now();
        const answers = await Promise.all(who.map((w, i) => s.post("/api/orders/checkout-session", { quoteId: quotes[i].quoteId, ...SHIP }, { ip: w.ip, token: w.token, timeoutMs: 120000 })));
        const checkoutMs = Date.now() - t0;
        await c.sleep(350);
        const held = await during.stop();
        const heldOpen = await open.stop();
        const row = { mode: MODE, batch, round, databaseMb: dbMb, lines: LINES, checkouts: answers.map((a) => a.status).join(","), checkoutMs, holdQuietMs: quiet.worstMs, holdMs: held.worstMs, holdOpenMs: heldOpen.worstMs, samples: held.samples };
        samples.push(row);
        c.log(JSON.stringify(row));
        if (answers.some((a) => a.status !== 200)) c.log(`  a checkout was not accepted: ${answers.map((a) => `${a.status} ${(a.body && a.body.code) || ""}`).join(" | ")}`);
      }
    } finally { await s.stop(); }
  }
  const holds = samples.map((r) => r.holdMs);
  const summary = {
    test: "r3-checkout-dist", mode: MODE, machine: os.loadavg()[0] > 2.5 ? "loaded" : "quiet", samples: holds.length,
    databaseMb: [Math.min(...samples.map((r) => r.databaseMb)), Math.max(...samples.map((r) => r.databaseMb))],
    holdMs: { median: pct(holds, 0.5), p90: pct(holds, 0.9), worst: Math.max(...holds), atOrOver250: holds.filter((x) => x >= 250).length, atOrOver200: holds.filter((x) => x >= 200).length },
    holdOpenMs: (() => { const o = samples.map((r) => r.holdOpenMs); return { median: pct(o, 0.5), p90: pct(o, 0.9), worst: Math.max(...o), atOrOver250: o.filter((x) => x >= 250).length }; })(),
    quietBaselineWorstMs: Math.max(...samples.map((r) => r.holdQuietMs)),
    checkoutMs: { median: pct(samples.map((r) => r.checkoutMs), 0.5), worst: Math.max(...samples.map((r) => r.checkoutMs)) },
    all: holds,
  };
  c.result(summary);
  process.exitCode = summary.holdMs.atOrOver250 > 0 ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(2); });
