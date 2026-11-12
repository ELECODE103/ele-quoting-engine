#!/usr/bin/env node
/**
 * Health-check latency while 100-line quotes of a dense DXF are priced — the
 * independent review's C2 measurement (tools/security/review-uploads/availability.js
 * mainthread), repeated as a SIGNED-IN customer, because since the availability
 * fixes a visitor without an account may price 25 lines at once, not 100.
 *
 *   node tools/security/availability-fixes/measure-pricing.js [holes=4900] [seconds=30]
 *
 * One address sends 100-line quotes of one perforated plate, eight at a time,
 * for the given time; /api/health is polled every 50 ms throughout. Starts its
 * own local server (throwaway data folder and secrets) and removes it afterwards.
 * Run with any proxy variables unset.
 */
const g = require("../review-uploads/gen");
const { startServer, monitor, sleep } = require("../review-uploads/lib");

(async () => {
  const holes = Number(process.argv[2]) || 4900;
  const seconds = Number(process.argv[3]) || 30;
  const s = await startServer();
  try {
    const ip = "192.0.2.80";
    const token = await s.register("measure@example.test", { ip });
    const data = g.dxfManyHoles(holes);
    const up = await s.upload([{ name: "perforated.dxf", data }], { ip, token, timeoutMs: 200000, fields: { process: "routing" } });
    const part = up.body && up.body.parts && up.body.parts[0];
    if (!part) { console.log("upload failed:", up.status, up.text.slice(0, 200)); return; }
    const mat = (await s.get("/api/materials?process=routing", { ip })).body[0];
    const line = { partId: part.partId, materialSlug: mat.slug, quantity: 1, process: "routing", thicknessMm: (mat.thicknesses && mat.thicknesses[0] && mat.thicknesses[0].mm) || 6.35 };
    const t1 = Date.now();
    const one = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip, token });
    const oneMs = Date.now() - t1;
    const body = { parts: Array.from({ length: 100 }, () => line), leadTimeSlug: "standard" };
    const t100 = Date.now();
    const first = await s.post("/api/quote", body, { ip, token, timeoutMs: 300000 });
    const hundredMs = Date.now() - t100;
    const mon = monitor(s);
    const times = [];
    let stop = false;
    const worker = async () => { while (!stop) { const q0 = Date.now(); const r = await s.post("/api/quote", { ...body, quoteId: first.body && first.body.quoteId }, { ip, token, timeoutMs: 300000 }); times.push({ ms: Date.now() - q0, status: r.status }); if (r.status === 429) await sleep(250); } };
    const ws = Array.from({ length: 8 }, worker);
    await sleep(seconds * 1000); stop = true; await Promise.all(ws);
    const m = await mon.stop();
    const ok = times.filter((t) => t.status === 200).map((t) => t.ms).sort((a, b) => a - b);
    console.log(JSON.stringify({
      test: "pricing (signed in)", holes, dxfKb: Math.round(data.length / 1024),
      oneLineQuote: { status: one.status, ms: oneMs }, hundredLineQuote: { status: first.status, ms: hundredMs },
      seconds, requests: times.length, priced: ok.length, toldToRetry: times.filter((t) => t.status === 429).length,
      otherStatuses: [...new Set(times.filter((t) => t.status !== 200 && t.status !== 429).map((t) => t.status))],
      medianQuoteMs: ok[Math.floor(ok.length / 2)], healthMedianMs: m.medianMs, healthWorstMs: m.worstMs, healthSamples: m.samples, peakRssMb: m.peakRssMb,
    }));
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
