#!/usr/bin/env node
/**
 * F-09, worst case: the order lists and the admin panel's other lists when the database is as full
 * of orders as it can get.
 *
 *   node tools/security/rereview-fixes/order-list-worst.js [targetMb=12] [segments=6000]
 *
 * The reviewer's order-list-hold.js asks for the list with four unpaid orders in it. This one asks
 * what the list costs at the largest volume there can be:
 *
 *   1. One confirmed account uploads a detailed drawing (a disc of 6,000 short segments), prices the
 *      largest quote of it the site sells online, and presses "pay" until it is refused. With the
 *      ceilings of security/orderCaps.js at their defaults that is three unpaid orders.
 *   2. The server is stopped and those orders are copied in the database file, with all their lines,
 *      as that account's own older orders and as other customers' orders, until the file is
 *      `targetMb` (12 MB of a 16 MB ceiling): what months of the same would leave behind.
 *   3. The server is started again and each list is asked for five times while another visitor asks
 *      for the health page every 20 ms. The longest answer and the longest the health page waited
 *      are printed for each.
 *
 * Exit code 1 if any answer is not 200, takes 150 ms or more, or holds the health page 150 ms or more.
 * (The paid orders among the copies put a few thousand lines in the production queue, which no
 * customer can do without paying; the queue is in the table for completeness.)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const TARGET_MB = Number(args[0]) || 12;
const VERTS = Number(args[1]) || 6000;
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };
const LIMIT_MS = 150;

function fineDisc(n) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "8", "0", "90", String(n), "70", "1"];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push("10", (50 + 50 * Math.cos(a)).toFixed(5), "20", (50 + 50 * Math.sin(a)).toFixed(5)); }
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

/**
 * Steps 1 and 2: a running server on a database filled with orders. Used here and by the browser
 * check (scripts/e2e/admin-panel-load.mjs).
 */
async function build({ targetMb = TARGET_MB, segments = VERTS } = {}) {
  const SQL = await initSqlJs();
  const env = { QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_DRAFT_KB_PER_ACCOUNT: "100000", QUOTE_DRAFT_KB_PER_CLIENT: "100000" };
  let s = await c.startServer({ stubs: true, env });
  const tmp = s.tmp;
  try {
    const ip = "192.0.2.88";
    const email = "lister@example.test";
    let token = await s.register(email, { ip });
    const part = await c.uploadOne(s, "disc.dxf", fineDisc(segments), { ip, token, fields: { process: "routing" } });
    const { line } = await c.lineFor(s, part.partId, "routing", ip);
    let lines = 100;
    const made = [];
    let refusal = null;
    for (let o = 0; o < 12 && !refusal; o++) {
      let q;
      for (;;) {
        q = await s.post("/api/quote", { parts: Array.from({ length: lines }, () => ({ ...line, quantity: 1 })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 120000 });
        if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) break;
        if (q.status === 429) { await c.sleep(2000); continue; }
        if (q.status !== 200) throw new Error(`quote: ${q.status} ${q.text.slice(0, 200)}`);
        if (lines <= 1) throw new Error(`gate: ${JSON.stringify(q.body.gate).slice(0, 300)}`);
        lines = Math.floor(lines * 0.7);
      }
      const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ip, token, timeoutMs: 120000 });
      if (co.status !== 200) { refusal = `${co.status} ${co.body && co.body.code}`; break; }
      made.push(co.body.orderId);
    }
    c.log(`one account pressed "pay" until refused: ${made.length} unpaid order(s) of ${lines} lines each, then ${refusal || "(not refused in 12 tries)"}`);
    await s.admin({ ip: "198.51.100.1" });
    const pw = s.passwords, keys = s.editKeys, secret = s.adminSecret;

    // Stop, and fill the database file with copies of those orders and their lines.
    await s.stop({ keep: true });
    const file = path.join(tmp, "data", "quoting.db");
    const db = new SQL.Database(fs.readFileSync(file));
    const all = (sql, params = []) => { const st = db.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
    const order = all("SELECT * FROM orders WHERE id = ?", [made[0]])[0];
    const items = all("SELECT * FROM order_items WHERE order_id = ?", [made[0]]);
    const insert = (table, row) => db.run(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, Object.values(row));
    const size = () => db.exec("PRAGMA page_count")[0].values[0][0] * db.exec("PRAGMA page_size")[0].values[0][0];
    let copies = 0, mineCopies = 0, itemRows = 0;
    const lineBytes = items.reduce((n, it) => n + JSON.stringify(it).length, 0);
    db.run("BEGIN");
    while (size() < targetMb * c.MB) {
      const id = crypto.randomUUID();
      const mine = copies % 2 === 0; // half are this account's own older orders, half are other customers'
      const day = new Date(Date.UTC(2026, 0, 1) + copies * 3600 * 1000).toISOString();
      // One order in 25 carries every line of the largest quote; the rest carry one line. That gives
      // both things at once: a lot of lines (megabytes of them) and a lot of orders (hundreds to thousands).
      const mineLines = copies % 25 === 0 ? items : items.slice(0, 1);
      // (2026-11-13: each copy records the number of lines it is given. The start-up check added for F-02
      // flags a paid order that holds fewer lines than it was written with, and a copy that kept the
      // original's count of 49 beside one line was, rightly, flagged: 112 flagged orders instead of 18.)
      const row = { ...order, id, user_id: mine ? order.user_id : crypto.randomUUID(), status: copies % 9 === 0 ? "paid" : "expired", paid_at: copies % 9 === 0 ? day : null, attention: copies % 50 === 0 ? "late-payment" : null, created_at: day, stripe_session_id: null };
      if ("line_count" in row) row.line_count = mineLines.length;
      insert("orders", row);
      for (const it of mineLines) { insert("order_items", { ...it, id: crypto.randomUUID(), order_id: id }); itemRows++; }
      copies++; if (mine) mineCopies++;
    }
    db.run("COMMIT");
    fs.writeFileSync(file, Buffer.from(db.export())); db.close();
    c.log(`database filled to ${(fs.statSync(file).size / c.MB).toFixed(1)} MB: ${copies} more orders (${mineCopies} of them this account's), ${itemRows} order lines, about ${Math.round(lineBytes / 1024)} kB of lines for the ${lines}-line order`);

    s = await c.startServer({ stubs: true, env, tmpDir: tmp });
    s.passwords = pw; s.editKeys = keys; s.adminSecret = secret;
    token = (await s.post("/api/auth/login", { email, password: pw[email] }, { ip })).body.token;
    const totp = require("../../../server/security/totp");
    // A code is good once: wait for the step after the one that switched two-step sign-in on.
    const enrolStep = totp.stepAt();
    while (totp.stepAt() <= enrolStep) await c.sleep(500);
    const adminLogin = await s.post("/api/auth/login", { email: s.adminEmail, password: pw[s.adminEmail], totp: totp.codeAt(secret) }, { ip: "198.51.100.1" });
    if (adminLogin.status !== 200) throw new Error(`owner sign-in: ${adminLogin.status} ${adminLogin.text.slice(0, 200)}`);
    return { s, tmp, ip, email, token, ownerToken: adminLogin.body.token, made, lines, copies, mineCopies, refusal, totp };
  } catch (err) { await s.stop(); throw err; }
}

async function main() {
  const built = await build();
  const { s, ip, token, ownerToken, made, lines, copies, mineCopies, refusal } = built;
  let failed = false;
  try {
    await c.sleep(1500);
    const rows = [];
    const run = async (label, url, tok, who) => {
      const health = []; let stop = false;
      const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.9", timeoutMs: 120000 }); } catch { /* its time counts */ } health.push(Date.now() - t); await c.sleep(20); } })();
      await c.sleep(300); health.length = 0;
      const times = []; let status = 0, bytes = 0, total = "";
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const r = await s.get(url, { ip: who, token: tok, timeoutMs: 300000 });
        times.push(Date.now() - t0); status = r.status; bytes = r.buffer.length; total = r.headers["x-total-count"] || "";
        await c.sleep(60);
      }
      await c.sleep(150); stop = true; await pinger;
      const row = { request: label, status, answerKb: Math.round(bytes / 1024), total: total ? Number(total) : undefined, worstMs: Math.max(...times), medianMs: times.slice().sort((a, b) => a - b)[2], healthWorstMs: Math.max(...health) };
      rows.push(row); c.log(JSON.stringify(row));
      if (status !== 200 || row.worstMs >= LIMIT_MS || row.healthWorstMs >= LIMIT_MS) failed = true;
    };
    const lastPage = Math.ceil((mineCopies + made.length) / 50);
    await run("customer: GET /api/orders (page 1)", "/api/orders", token, ip);
    await run(`customer: GET /api/orders?page=${lastPage} (the last page)`, `/api/orders?page=${lastPage}`, token, ip);
    await run("customer: GET /api/orders?pageSize=100", "/api/orders?pageSize=100", token, ip);
    await run(`customer: GET /api/orders/:id (one order, ${lines} lines of the detailed drawing)`, `/api/orders/${made[0]}`, token, ip);
    await run("owner: GET /api/orders (page 1; what the admin panel loads)", "/api/orders", ownerToken, "198.51.100.1");
    await run("owner: GET /api/orders?page=9999 (the last page)", "/api/orders?page=9999", ownerToken, "198.51.100.1");
    await run("owner: GET /api/orders?attention=1", "/api/orders?attention=1", ownerToken, "198.51.100.1");
    await run("owner: GET /api/orders/admin/queue", "/api/orders/admin/queue", ownerToken, "198.51.100.1");
    await run("owner: GET /api/orders/admin/payment-settings", "/api/orders/admin/payment-settings", ownerToken, "198.51.100.1");
    await run("owner: GET /api/admin/stats", "/api/admin/stats", ownerToken, "198.51.100.1");
    await run("owner: GET /api/admin/quotes", "/api/admin/quotes", ownerToken, "198.51.100.1");
    await run("owner: GET /api/admin/parts", "/api/admin/parts", ownerToken, "198.51.100.1");
    await run("owner: GET /api/rfq/admin/list", "/api/rfq/admin/list", ownerToken, "198.51.100.1");
    c.result({ test: "order-list-worst", databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)), unpaidOrdersOneAccountCouldMake: made.length, refusal, linesPerOrder: lines, copies, limitMs: LIMIT_MS, load: c.load(), rows });
    if (failed) console.log("FINDING: an answer was not 200, or took or held 150 ms or more");
    process.exitCode = failed ? 1 : 0;
  } finally { await s.stop(); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
module.exports = { build, fineDisc };
