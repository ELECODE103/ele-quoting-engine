#!/usr/bin/env node
/**
 * Round 2, RR-07: what a customer meets AFTER memory-hungry uploads, when the process has kept memory.
 *
 *   node tools/security/availability-fixes/after-the-flood.js [hungryUploads=6] [customers=4]
 *
 * One address uploads the re-review's small-on-disk, large-in-memory 3MF several times (each is refused,
 * as it should be). Then customers upload the repository's 2 MB STEP one at a time, by themselves.
 * A good result: every customer is "parsed". "busy" means the server asked them to try again because it
 * had no room left (the log line says SHORT OF MEMORY); "parse-memory" would be the wrong answer.
 * Limits are the defaults. The real server on a throwaway folder.
 */
const c = require("../rereview-availability/common");
const codeOf = (r) => (r.body && r.body.parts && r.body.parts.length ? "parsed" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status));
function hungrySmall3mf(bytes = 60 * c.MB) {
  let x = 777; const pick = ["0.000", "7.123"]; const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return pick[(x >>> 16) % 2]; };
  const parts = []; let n = 0;
  while (n < bytes) { const row = []; for (let i = 0; i < 2000; i++) row.push(`<vertex x="${rnd()}" y="${rnd()}" z="${rnd()}"/>`); const t = row.join(""); parts.push(t); n += t.length; }
  return c.g.threeMf(`<?xml version="1.0"?><model unit="millimeter"><resources><object id="1"><mesh><vertices>${parts.join("")}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
}
(async () => {
  const nHungry = Number(process.argv[2]) || 6; const nCustomers = Number(process.argv[3]) || 4;
  const s = await c.startServer({ env: { PARSE_CONCURRENCY: "2" } });
  s.pid = s.pid || (s.child && s.child.pid);
  try {
    const hungry = hungrySmall3mf(); const step = c.g.stepPlate400();
    const rows = { rssMbAtStart: c.rssMb(s.pid), hungry: [], customers: [] };
    for (let i = 0; i < nHungry; i++) {
      const t = Date.now(); const r = await s.upload([{ name: "big.3mf", data: hungry }], { ip: `192.0.2.${100 + (i % 3)}`, timeoutMs: 300000 });
      rows.hungry.push({ code: codeOf(r), seconds: Number(((Date.now() - t) / 1000).toFixed(1)), rssMbAfter: c.rssMb(s.pid) });
    }
    await c.sleep(3000);
    for (let i = 0; i < nCustomers; i++) {
      const before = c.rssMb(s.pid); const t = Date.now();
      const r = await s.upload([{ name: "plate.step", data: step }], { ip: `203.0.113.${20 + i}`, timeoutMs: 300000 });
      rows.customers.push({ code: codeOf(r), seconds: Number(((Date.now() - t) / 1000).toFixed(1)), rssMbBefore: before, rssMbAfter: c.rssMb(s.pid) });
      await c.sleep(2000);
    }
    const log = s.log().split("\n").filter((l) => /Parse pool/.test(l)).map((l) => l.replace(/^.*Parse pool: /, "").slice(0, 110));
    c.result({ test: "after-the-flood", ...rows, customersParsed: rows.customers.filter((x) => x.code === "parsed").length, customersAskedToRetry: rows.customers.filter((x) => x.code === "busy").length, customersWronglyRefused: rows.customers.filter((x) => x.code === "parse-memory").length, poolLog: log.slice(-8) });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
