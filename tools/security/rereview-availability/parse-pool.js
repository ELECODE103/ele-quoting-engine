#!/usr/bin/env node
/**
 * RR-07: the parse pool's "stopped for memory, run again alone" rule (L4) seen from a customer.
 * A passing fix: in `steal`, the customer's upload is never the parse that is stopped while the
 * small memory-hungry file runs on, and `customer.code` is "parsed" every round.
 *
 *   node tools/security/rereview-availability/parse-pool.js steal [rounds=3] [big]
 *       ONE address uploads a 3MF that is small on disk and large in memory, again and again;
 *       a customer uploads the repository's 2 MB STEP plate at the same moment. Whose parse is stopped?
 *   node tools/security/rereview-availability/parse-pool.js pair [rounds=3] [customers=2]
 *       RR-07: NO attacker. Two customers upload the same 2 MB STEP at once: is either refused?
 *   node tools/security/rereview-availability/parse-pool.js solo
 *       two addresses, two memory-hungry files: how long is the pool closed to everyone else?
 *
 * Limits are the defaults (MEMORY_BUDGET_MB 1024: 512 MB for parsing in all, two workers).
 */
const c = require("./common");
const mode = process.argv[2] || "steal";
const poolLines = (s) => s.log().split("\n").filter((l) => /Parse pool/.test(l));
const codeOf = (r) => (r.body && r.body.parts && r.body.parts.length ? "parsed" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || String(r.status));

/**
 * 60 MB of <vertex/> rows whose coordinates take one of two values: the archive is 1.25 MB (48:1, under
 * the 100:1 guard), smaller on disk than the customer's 1.95 MB STEP, and needs hundreds of MB to read.
 */
function hungrySmall3mf(bytes = 60 * c.MB) {
  let x = 777;
  const pick = ["0.000", "7.123"];
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return pick[(x >>> 16) % 2]; };
  const parts = []; let n = 0;
  while (n < bytes) { const row = []; for (let i = 0; i < 2000; i++) row.push(`<vertex x="${rnd()}" y="${rnd()}" z="${rnd()}"/>`); const t = row.join(""); parts.push(t); n += t.length; }
  return c.g.threeMf(`<?xml version="1.0"?><model unit="millimeter"><resources><object id="1"><mesh><vertices>${parts.join("")}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
}

async function steal() {
  const rounds = Number(process.argv[3]) || 3;
  const s = await c.startServer({ env: { PARSE_CONCURRENCY: "2" } });
  try {
    // `steal big`: the reviewer's 17.5 MB archive (larger than the customer's file); default: the 1.25 MB one.
    const hungry = process.argv[4] === "big" ? c.g.threeMfRandomVertices(60 * c.MB) : hungrySmall3mf();
    const step = c.g.stepPlate400();
    c.log(`attacker file: ${(hungry.length / c.MB).toFixed(2)} MB 3MF; customer file: ${(step.length / c.MB).toFixed(2)} MB STEP`);
    // The customer's file alone, for the baseline.
    const t0 = Date.now();
    const alone = await s.upload([{ name: "plate.step", data: step }], { ip: "203.0.113.50", timeoutMs: 300000 });
    const aloneMs = Date.now() - t0;
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      const before = poolLines(s).length;
      const a0 = Date.now();
      const attacker = s.upload([{ name: "big.3mf", data: hungry }], { ip: "192.0.2.100", timeoutMs: 300000 }).then((r) => ({ code: codeOf(r), ms: Date.now() - a0 }));
      await c.sleep(1500);
      const c0 = Date.now();
      const customer = await s.upload([{ name: "plate.step", data: step }], { ip: `203.0.113.${60 + i}`, timeoutMs: 300000 });
      const row = { round: i + 1, customer: { code: codeOf(customer), ms: Date.now() - c0 }, attacker: await attacker, poolLog: poolLines(s).slice(before).map((l) => l.replace(/^.*Parse pool: /, "")) };
      rows.push(row);
      c.log(JSON.stringify(row));
      await c.sleep(3000);
    }
    c.result({ test: "parse-pool steal", customerAlone: { code: codeOf(alone), ms: aloneMs }, rounds: rows, peakRssMb: c.rssMb(s.pid) });
  } finally { await s.stop(); }
}

async function solo() {
  const s = await c.startServer({ env: { PARSE_CONCURRENCY: "2" } });
  try {
    const hungry = hungrySmall3mf();
    const cube = c.g.stlCube(20);
    const t0 = Date.now();
    const a = [1, 2].map((n) => s.upload([{ name: "big.3mf", data: hungry }], { ip: `192.0.2.${110 + n}`, timeoutMs: 300000 }).then((r) => ({ address: n, code: codeOf(r), ms: Date.now() - t0 })));
    // Customers with a 684-byte cube, one every 3 seconds, each from its own address.
    const customers = [];
    for (let i = 0; i < 20; i++) {
      await c.sleep(3000);
      const c0 = Date.now();
      customers.push(s.upload([{ name: "cube.stl", data: cube }], { ip: `203.0.113.${100 + i}`, timeoutMs: 300000 }).then((r) => ({ at: Math.round((c0 - t0) / 1000), code: codeOf(r), waitedMs: Date.now() - c0 })));
    }
    const rows = await Promise.all(customers);
    c.result({ test: "parse-pool solo", attackers: await Promise.all(a), customers: rows, longestCustomerWaitMs: Math.max(...rows.map((r) => r.waitedMs)), customersRefused: rows.filter((r) => r.code !== "parsed").length, poolLog: poolLines(s).map((l) => l.replace(/^.*Parse pool: /, "")) });
  } finally { await s.stop(); }
}

/**
 * No attacker at all: two (or three) customers upload the repository's 2 MB STEP plate at the same moment,
 * `rounds` times. At the default memory budget the two parses together cross the 512 MB line; one is
 * stopped and run again alone. Is it then served, or refused?
 */
async function pair() {
  const rounds = Number(process.argv[3]) || 3;
  const n = Number(process.argv[4]) || 2;
  const s = await c.startServer({ env: { PARSE_CONCURRENCY: "2" } });
  try {
    const step = c.g.stepPlate400();
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      const before = poolLines(s).length;
      const t0 = Date.now();
      const rs = await Promise.all(Array.from({ length: n }, (_, k) => c.sleep(k * 300).then(() => s.upload([{ name: "plate.step", data: step }], { ip: `203.0.113.${10 + i * 10 + k}`, timeoutMs: 300000 })).then((r) => ({ code: codeOf(r), seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) }))));
      const row = { round: i + 1, customers: rs, rssMbAfter: c.rssMb(s.pid), load: c.load()[0], poolLog: poolLines(s).slice(before).map((l) => l.replace(/^.*Parse pool: /, "").slice(0, 150)) };
      rows.push(row); c.log(JSON.stringify(row));
      await c.sleep(4000);
    }
    const all = rows.flatMap((r) => r.customers);
    c.result({ test: "parse-pool pair", customersAtOnce: n, rounds, served: all.filter((x) => x.code === "parsed").length, refused: all.filter((x) => x.code !== "parsed").map((x) => x.code), rows });
  } finally { await s.stop(); }
}

({ steal, solo, pair }[mode] || steal)().catch((e) => { console.error(e); process.exit(1); });
