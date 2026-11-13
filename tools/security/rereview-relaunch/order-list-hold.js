#!/usr/bin/env node
/**
 * The "My orders" list reads every part of every line of every order (re-review 2026-11-12, area 5; new).
 *
 *   node tools/security/rereview-relaunch/order-list-hold.js [vertices=6000] [orders=4]
 *
 * GET /api/orders (routes/orders.js) loads the part of each order line with partsDB.getById and puts its
 * measurements in the answer. For a detailed drawing those measurements live in a file, so one request
 * reads and parses that file once per LINE per ORDER, on the server's one thread. An order does not have
 * to be paid for to be in the list.
 *
 * One confirmed account: a small outline drawn with many short segments (cheap to cut, large to store),
 * a 100-line quote of it, "pay" pressed (never paid), a few times. Then the list is asked for while
 * another visitor asks for the health page every 20 ms.
 */
const c = require("../rereview-availability/common");

const VERTS = Number(process.argv[2]) || 6000;
const ORDERS = Number(process.argv[3]) || 4;
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

/** A 100 mm disc drawn as a closed polyline of n short segments (millimetres). */
function fineDisc(n) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "8", "0", "90", String(n), "70", "1"];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push("10", (50 + 50 * Math.cos(a)).toFixed(5), "20", (50 + 50 * Math.sin(a)).toFixed(5)); }
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

(async () => {
  const s = await c.startServer({ stubs: true, env: { QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000" } });
  try {
    const ip = "192.0.2.88";
    const token = await s.register("lister@example.test", { ip });
    const data = fineDisc(VERTS);
    const part = await c.uploadOne(s, "disc.dxf", data, { ip, token, fields: { process: "routing" } });
    const { line } = await c.lineFor(s, part.partId, "routing", ip);
    const made = [];
    let lines = 100;
    for (let o = 0; o < ORDERS; o++) {
      let q;
      for (;;) {
        q = await s.post("/api/quote", { parts: Array.from({ length: lines }, () => ({ ...line, quantity: 1 })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 120000 });
        if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) break;
        if (q.status !== 200 && q.status !== 429) throw new Error(`quote: ${q.status} ${q.text.slice(0, 200)}`);
        if (q.status === 429) { await c.sleep(2000); continue; }
        if (lines <= 1) throw new Error(`gate: ${JSON.stringify(q.body.gate).slice(0, 300)}`);
        lines = Math.floor(lines * 0.7);
      }
      const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ip, token, timeoutMs: 120000 });
      if (co.status !== 200) { c.log(`checkout ${o}: ${co.status} ${co.text.slice(0, 160)}`); break; }
      made.push({ lines, total: q.body.orderTotal });
    }
    const files = c.ls(s, "part-payloads");
    c.log(`drawing ${Math.round(data.length / 1024)} kB, ${VERTS} segments; ${made.length} unpaid order(s) of ${lines} lines, $${made[0] && made[0].total} each; part payload files on disk: ${files.length} (${Math.round(c.dirBytes(s, "part-payloads") / 1024)} kB)`);
    await c.sleep(1500);
    const run = async (label, url) => {
      const health = []; let stop = false;
      const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.9", timeoutMs: 120000 }); } catch { /* its time counts */ } health.push(Date.now() - t); await c.sleep(20); } })();
      await c.sleep(400); health.length = 0;
      const t0 = Date.now();
      const r = await s.get(url, { ip, token, timeoutMs: 300000 });
      const ms = Date.now() - t0;
      await c.sleep(200); stop = true; await pinger;
      const row = { request: label, status: r.status, code: r.body && r.body.code, answerMb: Number((r.buffer.length / c.MB).toFixed(2)), ms, healthWorstMs: Math.max(...health) };
      c.log(JSON.stringify(row));
      return row;
    };
    const rows = [];
    rows.push(await run("GET /api/orders (the customer's own list)", "/api/orders"));
    rows.push(await run("GET /api/orders again", "/api/orders"));
    // The OWNER's admin panel loads the same route for every order of every customer (client/src/pages/AdminPanel.jsx
    // loadData: seven requests in one Promise.all; if one fails, none of the seven is shown).
    const owner = await s.admin({ ip: "198.51.100.1" });
    const runAs = async (label, url, tok) => { const keep = token; const t0 = Date.now(); const r = await s.get(url, { ip: "198.51.100.1", token: tok, timeoutMs: 300000 }); const row = { request: label, status: r.status, code: r.body && r.body.code, answerMb: Number((r.buffer.length / c.MB).toFixed(2)), ms: Date.now() - t0 }; c.log(JSON.stringify(row)); return row; };
    const adminList = await runAs("GET /api/orders as the OWNER (the admin panel's order list)", "/api/orders", owner);
    rows.push(adminList);
    rows.push(await runAs("GET /api/orders/admin/queue as the owner (the production queue)", "/api/orders/admin/queue", owner));
    rows.push(await runAs("GET /api/admin/quotes as the owner", "/api/admin/quotes", owner));
    rows.push(await runAs("GET /api/admin/parts as the owner", "/api/admin/parts", owner));
    c.result({ test: "order-list-hold", vertices: VERTS, orders: made.length, linesPerOrder: lines, rows, limitThatApplies: "the general API limiter: 200 requests per 15 minutes per address" });
    const broken = rows.filter((r) => r.status >= 500);
    if (broken.length) console.log(`FINDING: ${broken.map((r) => `${r.request}: ${r.status} ${r.code}`).join("; ")}`);
    process.exitCode = broken.length || rows.some((r) => r.healthWorstMs > 2000) ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
