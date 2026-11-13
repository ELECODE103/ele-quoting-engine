#!/usr/bin/env node
/**
 * Can unpaid orders pin the file store? (re-review 2026-11-12, area 5)
 *
 * The retention rule: an unpaid order holds its files outright "until the later of 48 hours and its
 * payment window". The pressure pass never removes a file held outright. So: N confirmed accounts,
 * each from its own address, each uploads up to its allowance, prices it and presses "pay" (and never
 * pays). Then a visitor and a new customer try to upload.
 *
 *   node tools/security/rereview-relaunch/storage-pin-orders.js pin       accounts check out (unpaid orders)
 *   node tools/security/rereview-relaunch/storage-pin-orders.js control   the same uploads, quotes only
 *
 * Scaled 1:10 like the author's storage-pin.js so it runs in minutes: ceiling 200 MB (default 2,048),
 * 15 MB stored per address and per account (default 150). STORAGE_EVICT_MIN_AGE_MINUTES is 1 (default 2) and
 * CUSTOMER_PART_KEEP_MINUTES is 1 (a signed-in customer's new part is otherwise spared by every pass for its
 * first hours, which would hide the difference between the two modes): both favour the defender.
 * Everything else is the default. Uses the repo's own child-server helper and Stripe stand-in.
 */
const c = require("../rereview-availability/common");
const { solidStl } = require("../../../server/testSupport/zip");

const mode = process.argv[2] === "control" ? "control" : "pin";
const CEILING_MB = 200;
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

(async () => {
  const s = await c.startServer({ stubs: true, env: { UPLOAD_DIR_MAX_MB: String(CEILING_MB), UPLOAD_STORED_MB_PER_IP: "15", UPLOAD_STORED_MB_PER_ACCOUNT: "15", STORAGE_EVICT_MIN_AGE_MINUTES: "1", CUSTOMER_PART_KEEP_MINUTES: "1" } });
  try {
    const stored = () => ["uploads", "part-payloads", "quote-drawings", "rfq-drawings"].reduce((n, d) => n + c.dirBytes(s, d), 0);
    const pct = () => Math.round(100 * stored() / (CEILING_MB * c.MB));
    const file = solidStl(80); // a plain block, finely meshed: 3.8 MB
    const rows = [];
    let stopAll = "";
    for (let a = 0; a < 20 && !stopAll; a++) {
      const ip = `192.0.2.${20 + a}`;
      let token;
      try { token = await s.register(`pinner${a}@example.test`, { ip }); } catch (e) { rows.push({ address: ip, note: `register: ${String(e.message).slice(0, 80)}` }); break; }
      const o = { ip, token };
      const ids = []; let stop = "";
      for (let i = 0; i < 6; i++) {
        const r = await s.upload([{ name: `block-${a}-${i}.stl`, data: file }], { ...o, timeoutMs: 200000 });
        const part = r.body && r.body.parts && r.body.parts[0];
        if (part) { ids.push(part.partId); continue; }
        stop = (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status);
        if (stop === "busy" || stop === "parse-timeout") { await c.sleep(3000); continue; }
        break;
      }
      let did = "";
      if (ids.length) {
        const { line } = await c.lineFor(s, ids[0], "cnc", ip);
        const q = await s.post("/api/quote", { parts: ids.map((id) => ({ ...line, partId: id, subProcess: "milling" })), leadTimeSlug: "standard" }, o);
        did = `quote ${q.status}${q.body && q.body.gate && q.body.gate.requiresRfq ? " (firm quote)" : ""}`;
        if (q.status === 200 && mode === "pin") {
          const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, o);
          did += `, checkout ${co.status} ${(co.body && co.body.code) || ""}`;
        }
      }
      rows.push({ address: ip, partsStored: ids.length, stoppedBy: stop, did, storedPercent: pct() });
      c.log(JSON.stringify(rows[rows.length - 1]));
      if (stop === "storage-full" || stop === "uploads-paused") stopAll = stop;
    }
    const probe = async (label) => {
      const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
      const anon = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip });
      const tok = await s.register(`customer-${Date.now()}@example.test`, { ip });
      const cust = await s.upload([{ name: "housing.stl", data: c.g.stlCube(40) }], { ip, token: tok, timeoutMs: 200000 }); // a small part: the probe must not fill the store itself
      const code = (r) => (r.body && r.body.parts && r.body.parts.length ? "accepted" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status));
      const out = { at: label, storedPercent: pct(), visitorWithoutAccount: code(anon), confirmedCustomer: code(cust), customerMessage: cust.body && cust.body.parts && cust.body.parts.length ? "" : String((cust.body && (cust.body.error || (cust.body.errors && cust.body.errors[0] && cust.body.errors[0].error))) || "").slice(0, 160) };
      c.log(JSON.stringify(out));
      return out;
    };
    const rightAfter = await probe("right after the flood");
    // The pressure pass runs when an upload is refused (at most every 20 s) and every 5 minutes.
    await c.sleep(95000);
    await probe("knock 1"); await c.sleep(25000);
    const afterPass = await probe("after the pressure pass");
    await c.sleep(22000);
    const later = await probe("two minutes on");
    const pinned = afterPass.confirmedCustomer !== "accepted" || later.confirmedCustomer !== "accepted";
    c.result({ test: "storage-pin-orders", mode, ceilingMb: CEILING_MB, attackers: rows.length, stoppedBy: stopAll || "ran out of attackers", rows, rightAfter, afterPass, later,
      verdict: mode === "pin" ? (pinned ? "FINDING: unpaid orders hold the store full; a new customer cannot upload after the clean-up" : "HOLDS: customers upload again after the clean-up") : "control" });
    process.exitCode = mode === "pin" && pinned ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
