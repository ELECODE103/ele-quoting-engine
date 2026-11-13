#!/usr/bin/env node
/**
 * Changing a DXF's units re-prices every draft that holds it, in the same request (author's open item 2,
 * "about 0.8 s, an estimate, not a measurement"). Measured here at the sender's full draft allowance.
 *
 *   node tools/security/rereview-relaunch/units-flip-hold.js [holes=40] [flips=6]
 *
 * One confirmed account: a small plate, as many 100-line drafts of it as the default allowance (512 kB)
 * takes, then the units are flipped mm / in / mm … while another visitor asks for the health page every
 * 20 ms. Everything is at its default except the limit on NEW quotes per hour (lifted so the allowance in
 * BYTES is what stops the drafts, which is the limit the author names).
 */
const c = require("../rereview-availability/common");
const HOLES = Number(process.argv[2]) || 40;
const FLIPS = Number(process.argv[3]) || 6;

(async () => {
  const s = await c.startServer({ stubs: true, env: { QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_NEW_PER_ACCOUNT_DAY: "1000", QUOTE_NEW_PER_CLIENT_DAY: "1000" } });
  try {
    const ip = "192.0.2.90";
    const token = await s.register("flipper@example.test", { ip });
    const part = await c.uploadOne(s, "plate.dxf", c.g.dxfPlate(HOLES), { ip, token, fields: { process: "routing" } });
    const { line, mat } = await c.lineFor(s, part.partId, "routing", ip);
    const th = (mat.thicknesses || []).map((t) => t.mm);
    let drafts = 0, stoppedBy = "";
    for (let i = 0; i < 60; i++) {
      const q = await s.post("/api/quote", { parts: Array.from({ length: 100 }, (_, k) => ({ ...line, quantity: 1 + ((i + k) % 5), thicknessMm: th[k % th.length] })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 120000 });
      if (q.status === 200) { drafts++; continue; }
      if (q.status === 429 && q.body && /pricing|busy|turn/.test(String(q.body.code))) { await c.sleep(1500); i--; continue; }
      stoppedBy = `${q.status} ${(q.body && q.body.code) || ""}`; break;
    }
    c.log(`${drafts} drafts of 100 lines held (stopped by: ${stoppedBy || "the loop"}); database ${(c.dbBytes(s) / c.MB).toFixed(1)} MB`);
    await c.sleep(2500);
    const rows = [];
    let units = "in";
    for (let f = 0; f < FLIPS; f++) {
      const health = []; let stop = false;
      const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.9", timeoutMs: 120000 }); } catch { /* counted */ } health.push(Date.now() - t); await c.sleep(20); } })();
      await c.sleep(300); health.length = 0;
      const t0 = Date.now();
      const r = await s.post(`/api/parts/${part.partId}/units`, { units, editKey: s.editKeys[part.partId] }, { ip, token, timeoutMs: 120000 });
      const ms = Date.now() - t0;
      await c.sleep(200); stop = true; await pinger;
      rows.push({ flipTo: units, status: r.status, code: r.body && r.body.code, ms, healthWorstMs: Math.max(...health) });
      c.log(JSON.stringify(rows[rows.length - 1]));
      units = units === "in" ? "mm" : "in";
      if (r.status === 429 || r.status === 503) await c.sleep(2000);
    }
    c.result({ test: "units-flip-hold", holes: HOLES, drafts, linesPerDraft: 100, stoppedBy, rows, limitThatApplies: "the general API limiter (200 requests per 15 minutes per address) and the sender's parse seconds per hour" });
    process.exitCode = rows.some((r) => r.healthWorstMs > 2000) ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
