#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-12 the other way round: can the new "close unpaid orders when the
 * file store is full" hurt an HONEST customer, or the owner's own phone order?
 *
 *   node tools/security/rereview-fixes/r3-pressure-collateral.js
 *
 * The rule (services/storagePressure.js relieveUnpaidOrders): when the store is still full after
 * everything softer has gone, unpaid card orders are closed, "heaviest holder first". Whose order counts
 * as "heavy" is worked out from the files that closing it would free NOW, and a signed-in customer's file
 * is not freeable in its first hour (CUSTOMER_PART_KEEP_MINUTES, 60). So:
 *
 *   - an attacker's accounts that have just uploaded hold nothing "freeable": they are not on the list
 *   - a real customer who uploaded over an hour ago and is on the payment page IS on the list
 *
 * This script shows what then happens. Scaled like the earlier reviewer's storage-pin-orders.js so it
 * runs in minutes: store ceiling 200 MB (production 2,048), 15 MB per address and per account (150), and
 * the customer's "first hour" is 4 MINUTES here (CUSTOMER_PART_KEEP_MINUTES=4): the honest customers
 * upload, reach the payment page and wait 4.5 minutes (in production: come back after lunch); the
 * attackers then fill the store in under a minute with files that are "new".
 *
 *   H1  a customer with a small part, on the payment page (never paid during the run)
 *   H2  a customer with a 3.8 MB part, on the payment page
 *   P   the OWNER'S phone order (made in Admin from a quote, waiting for a cheque): no payment page
 *   A*  attacker accounts, each from its own address: upload to their allowance, nothing else
 *
 * Prints what became of H1, H2 and P, what they were emailed, whether H1 can simply check out again, and
 * whether the store was freed. Exit code 1 if an honest order or the phone order was closed.
 */
const c = require("../rereview-availability/common");
const { solidStl } = require("../../../server/testSupport/zip");

const CEILING_MB = 200;
const KEEP_MIN = 4;
const SHIP = { shippingName: "Honest Buyer", shippingAddress: "1 Test St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };

(async () => {
  const s = await c.startServer({ stubs: true, mail: true, env: { UPLOAD_DIR_MAX_MB: String(CEILING_MB), UPLOAD_STORED_MB_PER_IP: "15", UPLOAD_STORED_MB_PER_ACCOUNT: "15", CUSTOMER_PART_KEEP_MINUTES: String(KEEP_MIN) } });
  try {
    const stored = () => ["uploads", "part-payloads", "quote-drawings", "rfq-drawings"].reduce((n, d) => n + c.dirBytes(s, d), 0);
    const pct = () => Math.round(100 * stored() / (CEILING_MB * c.MB));
    const big = solidStl(80); // 3.8 MB
    const order = async (token, id) => (await s.get(`/api/orders/${id}`, { token })).body || {};

    // ── The honest customers and the owner's phone order ──
    const honest = [];
    for (const [name, data, ip] of [["H1 (small part)", c.g.stlCube(30), "198.18.1.1"], ["H2 (3.8 MB part)", big, "198.18.1.2"]]) {
      const email = `${name.slice(0, 2).toLowerCase()}@customer.test`;
      const token = await s.register(email, { ip });
      const part = await c.uploadOne(s, "housing.stl", data, { ip, token });
      const { line } = await c.lineFor(s, part.partId, "cnc", ip);
      const q = await s.post("/api/quote", { parts: [{ ...line, subProcess: "milling", quantity: 2 }], leadTimeSlug: "standard" }, { ip, token });
      const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ip, token });
      if (co.status !== 200) throw new Error(`${name}: checkout ${co.status} ${co.text.slice(0, 200)}`);
      honest.push({ name, email, ip, token, partId: part.partId, quoteId: q.body.quoteId, orderId: co.body.orderId, total: q.body.orderTotal });
      c.log(`${name}: on the payment page for order ${co.body.orderId.slice(0, 8)}, $${q.body.orderTotal}`);
    }
    const admin = await s.admin({ ip: "198.18.2.1" });
    const ownerPart = await c.uploadOne(s, "customer-bracket.stl", c.g.stlCube(25), { ip: "198.18.2.1", token: admin });
    const { line: ownerLine } = await c.lineFor(s, ownerPart.partId, "cnc", "198.18.2.1");
    const ownerQuote = await s.post("/api/quote", { parts: [{ ...ownerLine, subProcess: "milling", quantity: 5 }], leadTimeSlug: "standard" }, { ip: "198.18.2.1", token: admin });
    const phone = await s.post("/api/orders", { quoteId: ownerQuote.body.quoteId, shippingName: "Phone Customer", shippingAddress: "9 Mill Rd", shippingCity: "Cary", shippingState: "IL", shippingZip: "60013", shippingCost: 15, notes: "cheque in the post" }, { ip: "198.18.2.1", token: admin });
    if (phone.status !== 201) throw new Error(`phone order: ${phone.status} ${phone.text.slice(0, 200)}`);
    c.log(`P: the owner's phone order ${phone.body.orderId.slice(0, 8)}, $${phone.body.total}, waiting for a cheque`);

    c.log(`waiting ${KEEP_MIN + 0.5} minutes: the honest customers' files stop being "new" (in production this is the first hour)`);
    await c.sleep((KEEP_MIN + 0.5) * 60 * 1000);

    // ── The flood ──
    const t0 = Date.now();
    let accounts = 0; let stopAll = "";
    for (let a = 0; a < 24 && !stopAll; a++) {
      const ip = `192.0.2.${20 + a}`;
      const token = await s.register(`flood${a}@example.test`, { ip });
      accounts++;
      for (let i = 0; i < 6; i++) {
        const r = await s.upload([{ name: `block-${a}-${i}.stl`, data: big }], { ip, token, timeoutMs: 200000 });
        if (r.body && r.body.parts && r.body.parts[0]) continue;
        const stop = (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status);
        if (stop === "busy" || stop === "parse-timeout") { await c.sleep(2000); continue; }
        if (stop === "storage-full" || stop === "uploads-paused") stopAll = stop;
        break;
      }
    }
    c.log(`flood: ${accounts} accounts, ${Math.round((Date.now() - t0) / 1000)} s, store at ${pct()} %, stopped by "${stopAll}"`);

    // The pressure pass runs when an upload is refused (at most every 20 s) and every 5 minutes.
    const knock = async () => { const r = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip: `203.0.113.${Math.floor(Math.random() * 200) + 1}` }); return r.body && r.body.parts && r.body.parts.length ? "accepted" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status); };
    const seen = [];
    for (let i = 0; i < 4; i++) { seen.push(await knock()); await c.sleep(24000); }

    // ── What became of the honest orders ──
    const rows = [];
    for (const h of honest) {
      const o = await order(h.token, h.orderId);
      const mails = s.mail(h.email).filter((m) => !/confirm your email/i.test(m.subject)).map((m) => m.subject);
      rows.push({ who: h.name, order: h.orderId.slice(0, 8), total: h.total, statusNow: o.status, emailed: mails });
    }
    const p = await order(admin, phone.body.orderId);
    const ownerMails = s.mail("owner@shop.test").map((m) => m.subject).filter((x) => /closed|not paid|order/i.test(x));
    rows.push({ who: "P (owner's phone order)", order: phone.body.orderId.slice(0, 8), total: phone.body.total, statusNow: p.status, emailed: ownerMails });
    for (const r of rows) c.log(JSON.stringify(r));

    // Can H1 simply press pay again? And does that order survive the next pass?
    const h1 = honest[0];
    let again = null; let againAfter = null;
    if (rows[0].statusNow === "expired") {
      const co = await s.post("/api/orders/checkout-session", { quoteId: h1.quoteId, ...SHIP }, { ip: h1.ip, token: h1.token });
      again = `${co.status} ${(co.body && co.body.code) || ""}`.trim();
      if (co.status === 200) {
        for (let i = 0; i < 3; i++) { await knock(); await c.sleep(24000); }
        againAfter = (await order(h1.token, co.body.orderId)).status;
      }
    }
    const closedLines = s.log().split("\n").filter((l) => /unpaid order\(s\) closed|closed to make room|File storage at/i.test(l)).slice(-6);
    const out = {
      test: "r3-pressure-collateral", scale: `1:10 in megabytes; the customer's first hour is ${KEEP_MIN} minutes here`,
      floodAccounts: accounts, storeAfterFloodPercent: pct(), uploadsDuringThePasses: seen,
      orders: rows, h1ChecksOutAgain: again, thatOrderAfterTheNextPasses: againAfter, serverSaid: closedLines.map((l) => l.slice(0, 260)),
      storeAtTheEndPercent: pct(), visitorUploadAtTheEnd: await knock(),
    };
    c.result(out);
    const hurt = rows.filter((r) => r.statusNow !== "pending_payment");
    console.log(hurt.length ? `FINDING: ${hurt.map((r) => `${r.who} is now "${r.statusNow}"`).join("; ")}; the store is at ${out.storeAtTheEndPercent} % and a visitor's upload is "${out.visitorUploadAtTheEnd}"` : "HOLDS: no honest order and no phone order was closed");
    process.exitCode = hurt.length ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
