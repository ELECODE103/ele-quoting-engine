#!/usr/bin/env node
/**
 * RR-08: the file ceiling is still fillable (independent review H4): files named by an OPEN request
 * (or an order that was never paid) are never evicted, and opening a request costs nothing.
 * A passing fix: in `pin`, `afterThePressurePass` shows customers uploading again without the owner
 * deleting anything (or the attacker stopped well short of the ceiling by a cap on pinned bytes).
 *
 *   node tools/security/rereview-availability/storage-pin.js pin       fill, pin with one request per address, wait, look
 *   node tools/security/rereview-availability/storage-pin.js control   the same uploads with no request: the pressure pass clears them
 *
 * Scaled 1:10 so it runs in minutes: ceiling 200 MB (default 2,048) and 40 MB stored per address
 * (default 400): the same five-and-a-bit addresses to the ceiling. STORAGE_EVICT_MIN_AGE_MINUTES is 1
 * (default 30) so the wait for the pressure pass is a minute, which favours the defender.
 * Everything else is the default. Bot check off; add `turnstile` to run with the stand-in on.
 */
const fs = require("fs");
const path = require("path");
const c = require("./common");
const { solidStl } = require("../../../server/testSupport/zip");

const mode = process.argv[2] === "control" ? "control" : "pin";
const turnstile = process.argv.includes("turnstile");
const CEILING_MB = 200;
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");

(async () => {
  const s = await c.startServer({ stubs: true, turnstile, env: { UPLOAD_DIR_MAX_MB: String(CEILING_MB), UPLOAD_STORED_MB_PER_IP: "40", STORAGE_EVICT_MIN_AGE_MINUTES: "1" } });
  try {
    const stored = () => ["uploads", "part-payloads", "quote-drawings", "rfq-drawings"].reduce((n, d) => n + c.dirBytes(s, d), 0);
    const pct = () => Math.round(100 * stored() / (CEILING_MB * c.MB));
    const file = solidStl(80); // a plain 60 x 40 x 20 block, finely meshed: 76,800 triangles, 3.8 MB
    const gate = async (ip) => (turnstile ? { "X-Human-Token": await c.humanToken(s, ip) } : {});
    const T = turnstile ? { "X-Turnstile-Token": "pass-x" } : {};
    const account = await s.register("attacker@example.test", { ip: "192.0.2.199", headers: T }); // a confirmed account: needed only for the last 15 %
    const rows = [];
    let pausedAt = null; let fullAt = null;
    for (let a = 0; a < 12 && !fullAt; a++) {
      const ip = `192.0.2.${120 + a}`;
      const useAccount = Boolean(pausedAt); // past 85 % a visitor without an account is refused; a confirmed account is not
      const o = { ip, headers: await gate(ip), ...(useAccount ? { token: account } : {}) };
      const ids = []; let stop = "";
      for (let i = 0; i < 12; i++) {
        const r = await s.upload([{ name: `block-${a}-${i}.stl`, data: file }], { ...o, timeoutMs: 200000 });
        const part = r.body && r.body.parts && r.body.parts[0];
        if (part) { ids.push(part.partId); continue; }
        stop = (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status);
        if (stop === "busy" || stop === "parse-timeout") { await c.sleep(3000); continue; }
        break;
      }
      let request = null;
      if (ids.length && mode === "pin") {
        const { line } = await c.lineFor(s, ids[0], "cnc", ip);
        const q = await s.post("/api/quote", { parts: ids.map((id) => ({ ...line, partId: id, subProcess: "milling" })), leadTimeSlug: "standard" }, o);
        if (q.status === 200) {
          const r = await s.rfq({ contactName: "Buyer", email: useAccount ? "attacker@example.test" : `buyer${a}@example.test`, quoteId: q.body.quoteId, notes: `job ${a}` }, [], { ...o, headers: { ...o.headers, ...T } });
          request = r.status;
        } else request = `quote ${q.status} ${(q.body && q.body.code) || ""}`;
      }
      rows.push({ address: ip, as: useAccount ? "confirmed account" : "no account", partsStored: ids.length, stoppedBy: stop, request, storedPercent: pct() });
      c.log(JSON.stringify(rows[rows.length - 1]));
      if (stop === "uploads-paused" && !pausedAt) pausedAt = pct();
      if (stop === "storage-full") fullAt = pct();
    }
    const probe = async (label) => {
      const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
      const anon = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip, headers: await gate(ip) });
      const tok = await s.register(`customer-${label}-${Date.now()}@example.test`, { ip, headers: T });
      const cust = await s.upload([{ name: "housing.stl", data: file }], { ip, token: tok, timeoutMs: 200000 }); // an ordinary 3.8 MB model
      const code = (r) => (r.body && r.body.parts && r.body.parts.length ? "accepted" : (r.body && r.body.code) || String(r.status));
      return { storedPercent: pct(), visitorWithoutAccount: code(anon), confirmedCustomer: code(cust) };
    };
    const after = await probe("a");
    // The pressure pass: runs when an upload is refused (at most every 20 s) and every 5 minutes. Give it its minute, then knock twice.
    await c.sleep(75000);
    await probe("k1"); await c.sleep(22000); await probe("k2"); await c.sleep(3000);
    const afterPass = await probe("b");
    const relief = (s.log().match(/File storage at \d+% of its ceiling: removed[^\n]*/g) || []);
    // What the owner can do: delete the requests in the admin panel.
    let afterOwner = null;
    if (mode === "pin") {
      const admin = await s.admin({ ip: "198.51.100.1", headers: T });
      const h = await s.browser(admin);
      const list = (await s.get("/api/rfq/admin/list", { ip: "198.51.100.1", headers: h })).body || [];
      let deleted = 0;
      for (const r of list) { const d = await s.req({ method: "DELETE", url: `/api/admin/requests/${r.id}`, ip: "198.51.100.1", headers: h }); if (d.status === 200) deleted++; }
      // The quotes behind the deleted requests are ordinary drafts again; the pass takes them once they have sat a minute.
      await c.sleep(75000); await probe("k3"); await c.sleep(22000); await probe("k4"); await c.sleep(3000);
      afterOwner = { requestsTheOwnerDeletedByHand: deleted, ...(await probe("c")), note: "the parts on the confirmed account's quote stay: a signed-in customer's draft is kept for its 30-day hold" };
    }
    c.result({
      test: `storage-pin ${mode}`, botCheck: turnstile ? "on (stand-in)" : "off", ceilingMb: CEILING_MB, storedPerAddressMb: 40,
      attackerAddresses: rows.length, attackerRows: rows, anonymousPausedAtPercent: pausedAt, everyoneRefusedAtPercent: fullAt,
      rightAfter: after, afterThePressurePass: afterPass, pressurePassLog: relief.length ? relief : "nothing removed", afterTheOwnerDeletesTheRequests: afterOwner,
      atTheDefaults: "2,048 MB ceiling, 400 MB stored and 500 MB a day per address: five addresses to pause visitors without an account, six with one confirmed account to refuse everyone",
    });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
