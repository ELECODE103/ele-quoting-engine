#!/usr/bin/env node
/**
 * RR-13: POST /api/quote after the C2 fix, against lines that are all DIFFERENT parts (the per-request
 * memo cannot help) from eight addresses (the site-wide number of pricing requests in flight).
 * A passing fix: healthMedianMs stays in single figures and `otherVisitor` keeps getting prices.
 *
 *   node tools/security/rereview-availability/pricing-eight.js [holes=3000] [parts=25] [addresses=1,2,4,8] [secondsEach=25]
 *
 * No account is used. Every limit is the default. The dense DXF is uploaded `parts` times by three
 * addresses (a part id works from any address), then each attacking address prices one 25-line quote
 * over and over at the pace its rate limit allows. /api/health is sampled throughout, and a ninth,
 * innocent visitor re-prices a one-line quote of a small cube every two seconds.
 */
const c = require("./common");

(async () => {
  const holes = Number(process.argv[2]) || 3000;
  const nParts = Math.min(25, Number(process.argv[3]) || 25);
  const addressCounts = String(process.argv[4] || "1,2,4,8").split(",").map(Number).filter((n) => n > 0);
  const seconds = Number(process.argv[5]) || 25;
  const s = await c.startServer();
  try {
    const data = c.g.dxfManyHoles(holes);
    const ids = [];
    for (let i = 0; i < nParts; i++) {
      const ip = `192.0.2.${10 + (i % 5)}`;
      const p = await c.uploadOne(s, `sheet-${i}.dxf`, data, { ip, fields: { process: "routing" }, attempts: 6 });
      ids.push(p.partId);
    }
    const { line } = await c.lineFor(s, ids[0], "routing", "192.0.2.10");
    const body = { parts: ids.map((id) => ({ ...line, partId: id })), leadTimeSlug: "standard" };
    // The innocent visitor.
    const V = "203.0.113.9";
    const cube = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip: V });
    const vLine = { ...(await c.lineFor(s, cube.partId, "cnc", V)).line, subProcess: "milling" };
    const v0 = await s.post("/api/quote", { parts: [vLine], leadTimeSlug: "standard" }, { ip: V });
    // One such quote alone, for scale.
    const t1 = Date.now();
    const alone = await s.post("/api/quote", body, { ip: "192.0.2.50", timeoutMs: 120000 });
    const aloneMs = Date.now() - t1;
    let mon = c.monitor(s); await c.sleep(4000); const quiet = await mon.stop();

    const phases = [];
    for (const nAddr of addressCounts) {
      mon = c.monitor(s);
      let stop = false; const outcomes = {}; const visitor = [];
      const attacker = async (n) => {
        const ip = `198.51.${nAddr}.${10 + n}`; let quoteId;
        while (!stop) {
          const r = await s.post("/api/quote", { ...body, ...(quoteId ? { quoteId } : {}) }, { ip, timeoutMs: 120000 });
          const k = r.status === 200 ? "priced" : (r.body && r.body.code) || String(r.status);
          outcomes[k] = (outcomes[k] || 0) + 1;
          if (r.status === 200) quoteId = r.body.quoteId;
          if (r.status === 429) await c.sleep(1000);
        }
      };
      const innocent = async () => { let n = 0; while (!stop) { const t = Date.now(); const r = await s.post("/api/quote", { parts: [{ ...vLine, quantity: 1 + (n++ % 9) }], leadTimeSlug: "standard", quoteId: v0.body.quoteId }, { ip: V, timeoutMs: 120000 }); visitor.push({ status: r.status, code: (r.body && r.body.code) || "", ms: Date.now() - t }); await c.sleep(2000); } };
      const all = [...Array.from({ length: nAddr }, (_, n) => attacker(n)), innocent()];
      await c.sleep(seconds * 1000); stop = true; await Promise.all(all);
      const m = await mon.stop();
      const vms = visitor.map((x) => x.ms).sort((x, y) => x - y);
      const row = { attackerAddresses: nAddr, attackerOutcomes: outcomes, healthMedianMs: m.medianMs, healthWorstMs: m.worstMs, healthSamples: m.samples, otherVisitor: { tries: visitor.length, priced: visitor.filter((x) => x.status === 200).length, refused: visitor.filter((x) => x.status !== 200).map((x) => x.code || x.status), medianMs: vms[Math.floor(vms.length / 2)], worstMs: vms[vms.length - 1] }, loadAverage: c.load()[0] };
      phases.push(row); c.log(JSON.stringify(row));
      await c.sleep(5000);
    }
    c.result({
      test: "pricing-eight", holes, dxfKb: Math.round(data.length / 1024), distinctPartsPerQuote: nParts, account: "none", secondsEach: seconds,
      oneSuchQuoteAlone: { status: alone.status, code: (alone.body && alone.body.code) || "", ms: aloneMs },
      healthQuiet: { medianMs: quiet.medianMs, worstMs: quiet.worstMs }, phases,
    });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
