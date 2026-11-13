#!/usr/bin/env node
/**
 * F-12 at full scale: can accounts that press "pay" and never pay hold the file store full?
 *
 *   node tools/security/rereview-fixes/storage-pin-orders-full.js [pin|control] [scale=1]
 *
 * The reviewer's storage-pin-orders.js runs at 1:10 (a 200 MB store, 15 MB per account) with one
 * unpaid order per account. This one runs at the real sizes by default (scale 1: the 2,048 MB store
 * and 150 MB per address and per account that the site ships with; scale 10 is the reviewer's) and
 * has every account do the most the site lets one account do:
 *
 *   - upload to its storage allowance (blocks of about 7 MB each),
 *   - put them on as many quotes as it may hold unpaid orders for (three), each as large as the
 *     gate lets through, and press "pay" on every one of them. Nothing is ever paid.
 *
 * until uploads are refused for everybody. Then a visitor and a new customer knock every 20 seconds
 * (a refused upload is what starts the clean-up) and the script reports the store, what each of
 * them was told, how many unpaid orders the clean-up closed and how many buyers were emailed.
 *
 * As in the reviewer's script, STORAGE_EVICT_MIN_AGE_MINUTES and CUSTOMER_PART_KEEP_MINUTES are set
 * to 1: a signed-in customer's new upload is otherwise never removed in its first hour, by any
 * pass, which is deliberate and would hide what is being tested. Everything else is the default.
 * Exit code 1 (pin mode) if a new customer still cannot upload four minutes after the flood.
 */
const c = require("../rereview-availability/common");
const { solidStl } = require("../../../server/testSupport/zip");

const mode = process.argv[2] === "control" ? "control" : "pin";
const SCALE = Math.max(1, Number(process.argv[3]) || 1);
const CEILING_MB = Math.round(2048 / SCALE);
const PER_SENDER_MB = Math.max(4, Math.round(150 / SCALE));
const SHIP = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

(async () => {
  const env = {
    UPLOAD_DIR_MAX_MB: String(CEILING_MB), UPLOAD_STORED_MB_PER_IP: String(PER_SENDER_MB), UPLOAD_STORED_MB_PER_ACCOUNT: String(PER_SENDER_MB),
    STORAGE_EVICT_MIN_AGE_MINUTES: "1", CUSTOMER_PART_KEEP_MINUTES: "1",
  };
  const s = await c.startServer({ stubs: true, mail: true, env });
  try {
    const stored = () => ["uploads", "part-payloads", "quote-drawings", "rfq-drawings"].reduce((n, d) => n + c.dirBytes(s, d), 0);
    const pct = () => Math.round(100 * stored() / (CEILING_MB * c.MB));
    const file = solidStl(SCALE >= 8 ? 80 : 110); // a plain block, finely meshed: 3.8 MB (scaled runs) or about 7 MB
    c.log(`mode ${mode}; store ${CEILING_MB} MB; ${PER_SENDER_MB} MB per address and per account; one upload is ${(file.length / c.MB).toFixed(1)} MB`);
    const rows = [];
    let stopAll = "";
    let unpaidOrders = 0;
    const t0 = Date.now();
    for (let a = 0; a < 40 && !stopAll; a++) {
      const ip = `192.0.2.${20 + a}`;
      let token;
      try { token = await s.register(`pinner${a}@example.test`, { ip }); } catch (e) { rows.push({ address: ip, note: `register: ${String(e.message).slice(0, 80)}` }); break; }
      const o = { ip, token };
      const ids = []; let stop = "";
      for (let i = 0; i < 400; i++) {
        const r = await s.upload([{ name: `block-${a}-${i}.stl`, data: file }], { ...o, timeoutMs: 300000 });
        const part = r.body && r.body.parts && r.body.parts[0];
        if (part) { ids.push(part.partId); continue; }
        stop = (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status);
        if (stop === "busy" || stop === "parse-timeout" || stop === "429") { await c.sleep(3000); continue; }
        break;
      }
      let did = [];
      if (ids.length) {
        const { line } = await c.lineFor(s, ids[0], "cnc", ip);
        // Three groups (one account may hold three unpaid orders), each cut down until the gate lets it through.
        const groups = [0, 1, 2].map((g) => ids.filter((_, i) => i % 3 === g)).filter((g) => g.length);
        for (const group of groups) {
          let take = group.length, q = null;
          while (take > 0) {
            q = await s.post("/api/quote", { parts: group.slice(0, take).map((id) => ({ ...line, partId: id, subProcess: "milling" })), leadTimeSlug: "standard" }, { ...o, timeoutMs: 180000 });
            if (q.status === 200 && !(q.body.gate && q.body.gate.requiresRfq)) break;
            if (q.status === 429 || q.status === 503) { await c.sleep(3000); continue; }
            take = Math.floor(take * 0.7);
          }
          if (!take) { did.push("no quote the gate lets through"); continue; }
          if (mode === "pin") {
            const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { ...o, timeoutMs: 180000 });
            did.push(`${take} part(s) $${q.body.orderTotal}: checkout ${co.status}${co.body && co.body.code ? ` ${co.body.code}` : ""}`);
            if (co.status === 200) unpaidOrders++;
          } else did.push(`${take} part(s) $${q.body.orderTotal}: quote only`);
        }
      }
      rows.push({ address: ip, partsStored: ids.length, stoppedBy: stop, did: did.join("; "), storedPercent: pct() });
      c.log(JSON.stringify(rows[rows.length - 1]));
      if (stop === "storage-full" || stop === "uploads-paused") stopAll = stop;
    }
    const floodSeconds = Math.round((Date.now() - t0) / 1000);
    c.log(`the flood: ${rows.length} accounts in ${floodSeconds} s, ${unpaidOrders} unpaid orders, store at ${pct()}%, stopped by ${stopAll || "running out of accounts"}`);
    const probe = async (label) => {
      const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
      const anon = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip });
      const tok = await s.register(`customer-${Date.now()}@example.test`, { ip });
      const cust = await s.upload([{ name: "housing.stl", data: c.g.stlCube(40) }], { ip, token: tok, timeoutMs: 200000 });
      const code = (r) => (r.body && r.body.parts && r.body.parts.length ? "accepted" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status));
      const out = { at: label, secondsAfterFlood: Math.round((Date.now() - t0) / 1000) - floodSeconds, storedPercent: pct(), visitorWithoutAccount: code(anon), confirmedCustomer: code(cust) };
      c.log(JSON.stringify(out));
      return out;
    };
    const probes = [await probe("right after the flood")];
    // The pressure pass runs when an upload is refused (at most every 20 s) and every 5 minutes; a file
    // is left alone in its first minute here. Knock every 20 s for four minutes, or until the store opens.
    let open = null;
    for (let k = 1; k <= 12 && !open; k++) {
      await c.sleep(20000);
      const p = await probe(`knock ${k}`);
      probes.push(p);
      if (p.confirmedCustomer === "accepted" && p.visitorWithoutAccount === "accepted") open = p;
    }
    await c.sleep(3000);
    const closedMail = s.mail(undefined, /unpaid order .* was closed/i).length;
    const log = s.log();
    const closedLine = (log.match(/(\d+) unpaid order\(s\) closed to make room/g) || []).join("; ");
    const last = probes[probes.length - 1];
    const pinned = last.confirmedCustomer !== "accepted";
    c.result({ test: "storage-pin-orders-full", mode, scale: `1:${SCALE}`, ceilingMb: CEILING_MB, perSenderMb: PER_SENDER_MB, accounts: rows.length, unpaidOrders, floodSeconds, stoppedBy: stopAll || "ran out of accounts",
      storedPercentAfterFlood: probes[0].storedPercent, probes, serverSaid: closedLine || "(no unpaid order was closed)", buyersEmailedThatTheirOrderWasClosed: closedMail,
      verdict: mode === "pin" ? (pinned ? "FINDING: unpaid orders hold the store full; a new customer cannot upload after the clean-up" : "HOLDS: a visitor and a new customer upload again after the clean-up") : "control" });
    process.exitCode = mode === "pin" && pinned ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
