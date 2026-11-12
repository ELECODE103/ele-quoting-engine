#!/usr/bin/env node
/**
 * Item 10 of the re-review (RR-11): what are the single slow health samples, and can a sender make them worse?
 * A passing fix: `saveMsAtSize` stays flat as the database grows (a save no longer rewrites the whole file on the one thread).
 *
 *   node tools/security/rereview-availability/stall-probe.js sizes          time of one save at 1, 8, 16, 32, 48 and 60 MB of database
 *   node tools/security/rereview-availability/stall-probe.js storm [secs=30] the fix write-up's pricing storm, with every slow health sample attributed
 *   node tools/security/rereview-availability/stall-probe.js held [mb=54]    the database held near its "visitors paused" line while ONE address re-prices one quote: health for everyone
 *
 * The server is the real one; tools/security/rereview-availability/probe-preload.js is loaded into it
 * to time saves, garbage collection and the event loop. `sizes` and `held` lift the limits on NEW
 * drafts (they are measurements of the save, not attacks; db-ceiling.js is the attack).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("./common");

const mode = process.argv[2] || "sizes";
const PROBE = path.join(__dirname, "probe-preload.js");
const STUBS = c.PRELOAD;

async function start(env = {}) {
  const logFile = path.join(os.tmpdir(), `se-rereview-probe-${process.pid}-${Date.now()}.jsonl`);
  const s = await c.live.start({ env: { PARSE_CONCURRENCY: "2", REVIEW_STUBS: "1", NODE_OPTIONS: `--require ${STUBS} --require ${PROBE}`, REREVIEW_PROBE_LOG: logFile, ...env } });
  s.pid = s.child.pid;
  s.probe = () => { try { return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const stop = s.stop.bind(s);
  s.stop = async (o) => { await stop(o); try { fs.unlinkSync(logFile); } catch { /* gone */ } };
  return s;
}
// 2026-11-12, added with the round-2 fix: one sender may now hold 512 kB of drafts, so one account can no
// longer build the 60 MB database this probe times a save at (and its pricing time per hour would run out on the
// way: stored lines are compressed, so 60 MB is several thousand quotes). The two allowances and the pricing time
// are lifted here with the other limits on new drafts (same sizes, same saves: a measurement, as the header says;
// db-ceiling.js is the attack).
const LIFT = { QUOTE_NEW_PER_CLIENT_HOUR: "100000", QUOTE_NEW_PER_CLIENT_DAY: "1000000", QUOTE_NEW_PER_ACCOUNT_HOUR: "100000", QUOTE_NEW_PER_ACCOUNT_DAY: "1000000", RATE_QUOTE_PER_15MIN: "100000", RATE_QUOTE_BURST_PER_10SEC: "10000", QUOTE_DRAFT_KB_PER_CLIENT: "1048576", QUOTE_DRAFT_KB_PER_ACCOUNT: "1048576", QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR: "86400", QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR: "86400" };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Health sampled every 25 ms with the time of each sample, so a slow one can be matched to what the server was doing. */
function sampler(s) {
  const samples = []; let stop = false;
  const loop = (async () => { while (!stop) { const at = Date.now(); try { await c.live.request(s.port, { url: "/api/health", timeoutMs: 60000 }); samples.push({ at, ms: Date.now() - at }); } catch { samples.push({ at, ms: -1 }); } await c.sleep(25); } })();
  return { async stop() { stop = true; await loop; return samples; } };
}

async function fill(s, token, ip, line, targetBytes) {
  const body = { parts: c.distinctLines(line, 100), leadTimeSlug: "standard" };
  while (c.dbBytes(s) < targetBytes) { const r = await s.post("/api/quote", body, { ip, token, timeoutMs: 60000 }); if (r.status !== 200) throw new Error(`fill stopped: ${r.status} ${r.text.slice(0, 120)}`); }
}

async function sizes() {
  const s = await start({ ...LIFT, DB_MAX_MB: "256" });
  try {
    const ip = "192.0.2.180";
    const token = await s.register("probe@example.test", { ip });
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, token });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const rows = [];
    for (const mb of [1, 8, 16, 32, 48, 60]) {
      await fill(s, token, ip, line, mb * c.MB);
      await c.sleep(2000);
      const before = s.probe().length;
      const health = sampler(s);
      // Five single saves, each caused by one tiny new draft (one line), two seconds apart.
      const reqMs = [];
      for (let i = 0; i < 5; i++) { const t = Date.now(); await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip, token }); reqMs.push(Date.now() - t); await c.sleep(2000); }
      const hs = await health.stop();
      const ev = s.probe().slice(before);
      const exp = ev.filter((e) => e.type === "db-export").map((e) => e.ms); const wr = ev.filter((e) => e.type === "db-write").map((e) => e.ms);
      const row = { databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)), saves: exp.length, exportMsMedian: med(exp), writeMsMedian: med(wr), saveMsMedian: med(exp.map((e, i) => e + (wr[i] || 0))), oneLineQuoteRequestMsMedian: med(reqMs), healthWorstMs: Math.max(...hs.map((h) => h.ms)), gcOver20Ms: ev.filter((e) => e.type === "gc").map((e) => e.ms), serverRssMb: c.rssMb(s.pid) };
      rows.push(row); c.log(JSON.stringify(row));
    }
    c.result({ test: "stall-probe sizes", saveMsAtSize: rows, defaultCeilingMb: 64 });
  } finally { await s.stop(); }
}

async function storm() {
  const seconds = Number(process.argv[3]) || 30;
  const s = await start();
  try {
    const ip = "192.0.2.80";
    const token = await s.register("measure@example.test", { ip });
    const part = await c.uploadOne(s, "perforated.dxf", c.g.dxfManyHoles(4900), { ip, token, fields: { process: "routing" } });
    const { line } = await c.lineFor(s, part.partId, "routing", ip);
    const body = { parts: Array.from({ length: 100 }, () => line), leadTimeSlug: "standard" };
    const first = await s.post("/api/quote", body, { ip, token, timeoutMs: 300000 });
    const before = s.probe().length;
    const health = sampler(s);
    let stop = false; let priced = 0; let retried = 0;
    const worker = async () => { while (!stop) { const r = await s.post("/api/quote", { ...body, quoteId: first.body.quoteId }, { ip, token, timeoutMs: 300000 }); if (r.status === 200) priced++; else { retried++; await c.sleep(250); } } };
    const ws = Array.from({ length: 8 }, worker);
    await c.sleep(seconds * 1000); stop = true; await Promise.all(ws);
    const hs = await health.stop();
    const ev = s.probe().slice(before);
    // Attribute: for each health sample over 100 ms, what overlapped it?
    const slow = hs.filter((h) => h.ms >= 100).map((h) => {
      const during = ev.filter((e) => e.type !== "loop-max-in-last-second" && e.at >= h.at - 5 && e.at - e.ms <= h.at + h.ms);
      return { healthMs: h.ms, overlapping: during.map((e) => `${e.type} ${e.ms} ms${e.mb ? ` (${e.mb} MB)` : ""}`) };
    });
    const ms = hs.map((h) => h.ms);
    const of = (type) => ev.filter((e) => e.type === type).map((e) => e.ms).sort((a, b) => a - b);
    const sum = (type) => { const a = of(type); return { count: a.length, medianMs: med(a), worstMs: a.length ? a[a.length - 1] : 0, totalMs: a.reduce((x, y) => x + y, 0) }; };
    const explained = slow.filter((x) => x.overlapping.length > 0).length;
    c.result({
      test: "stall-probe storm", seconds, priced, toldToRetry: retried, healthSamples: ms.length, healthMedianMs: med(ms), healthWorstMs: Math.max(...ms),
      samplesOver100Ms: slow.length, ofThoseOverlappingAnEventTheProbeTimed: explained, worstFive: [...slow].sort((a, b) => b.healthMs - a.healthMs).slice(0, 5),
      inTheServer: {
        databaseSaves: { ...sum("db-export"), writeWorstMs: sum("db-write").worstMs, databaseMb: (ev.find((e) => e.type === "db-export") || {}).mb },
        garbageCollectionOver20Ms: sum("gc"), readingThePartsMeasurementsFile: sum("part-file-read"), parsingJsonOver200kB: sum("json-parse"), buildingJsonOver20Ms: sum("json-stringify"),
        loopHeldWorstMsEachSecond: of("loop-max-in-last-second"),
      },
    });
  } finally { await s.stop(); }
}

async function held() {
  const mb = Number(process.argv[3]) || 54;
  const s = await start({ ...LIFT });
  try {
    const ip = "192.0.2.181";
    const token = await s.register("probe@example.test", { ip });
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, token });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    await fill(s, token, ip, line, mb * c.MB);
    await c.sleep(3000);
    let h = sampler(s); await c.sleep(10000);
    const quiet = (await h.stop()).map((x) => x.ms);
    // One visitor at the DEFAULT rate limits would be allowed this: re-price one open quote of one line, three times a second.
    const q = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip: "192.0.2.182" });
    const before = s.probe().length;
    h = sampler(s);
    const t0 = Date.now(); let n = 0;
    while (Date.now() - t0 < 30000) { await s.post("/api/quote", { parts: [{ ...line, quantity: 1 + (n++ % 50) }], leadTimeSlug: "standard", quoteId: q.body.quoteId }, { ip: "192.0.2.182" }); await c.sleep(330); }
    const busy = await h.stop();
    const ev = s.probe().slice(before);
    const saves = ev.filter((e) => e.type === "db-export");
    const ms = busy.map((x) => x.ms).sort((a, b) => a - b);
    // The clean-up pass itself: above 80 % it runs whenever a row is added or an upload refused (at most every 20 s)
    // and on a five-minute timer. Here nothing it may remove exists (the drafts are a signed-in customer's), so
    // all it does is look. Three passes, each set off by one small upload, 22 s apart.
    await c.sleep(22000);
    const passes = [];
    for (let i = 0; i < 3; i++) {
      const mark = s.probe().length;
      const hp = sampler(s);
      await s.upload([{ name: "knock.stl", data: c.g.stlCube(10 + i) }], { ip, token });
      await c.sleep(4000);
      const hsamples = (await hp.stop()).map((x) => x.ms);
      const pe = s.probe().slice(mark);
      passes.push({ healthWorstMs: Math.max(...hsamples), loopHeldWorstMs: Math.max(0, ...pe.filter((e) => e.type === "loop-max-in-last-second").map((e) => e.ms)), saves: pe.filter((e) => e.type === "db-export").length, saveMs: pe.filter((e) => e.type === "db-export" || e.type === "db-write").reduce((a, e) => a + e.ms, 0), gcMs: pe.filter((e) => e.type === "gc").reduce((a, e) => a + e.ms, 0) });
      await c.sleep(18000);
    }
    c.result({
      test: "stall-probe held", databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)),
      healthQuiet: { medianMs: med(quiet), worstMs: Math.max(...quiet) },
      oneAddressRePricingOneQuoteThreeTimesASecond: { seconds: 30, rePrices: n, savesItCaused: saves.length, saveMsMedian: med(saves.map((e, i) => e.ms + ((ev.filter((x) => x.type === "db-write")[i] || {}).ms || 0))), healthMedianMs: med(ms), healthP90Ms: ms[Math.floor(ms.length * 0.9)], healthWorstMs: ms[ms.length - 1], healthSamplesOver100Ms: ms.filter((x) => x >= 100).length, healthSamples: ms.length, shareOfTheThreadSpentSavingPercent: Math.round(100 * ev.filter((e) => e.type === "db-export" || e.type === "db-write").reduce((a, e) => a + e.ms, 0) / 30000) },
      oneSmallUploadAbove80Percent: passes,
      serverRssMb: c.rssMb(s.pid),
    });
  } finally { await s.stop(); }
}

({ sizes, storm, held }[mode] || sizes)().catch((e) => { console.error(e); process.exit(1); });
