/**
 * The parse pool cannot be cheaply occupied (independent review 2026-11-11, H2, L4).
 *
 * Before: two requests of ten 950-byte DXFs held both workers for 605 seconds
 * (each file ran to the 60 s limit and the request went on to the next), and
 * one address could take all eight waiting places.
 * Run: node server/parsers/parseFairness.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const { ParsePool } = require("./parsePool");

const { test, run } = runner("Parse pool fairness and budgets");
const cube = path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl");
const cubeBytes = fs.readFileSync(cube);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-fair-"));
const pools = [];
const make = (opts) => { const p = new ParsePool(opts); pools.push(p); return p; };
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("one client may hold only its share of the waiting line; another client still gets a place", async () => {
  const pool = make({ parseConcurrency: 1, parseQueueMax: 8, parseQueuePerClient: 2, parseQueueWaitMs: 5000, testDelayMs: 300 });
  const a = Array.from({ length: 6 }, () => settle(pool.run({ filePath: cube, client: "attacker" })));
  const b = settle(pool.run({ filePath: cube, client: "customer" }));
  const results = await Promise.all([...a, b]);
  const refused = results.slice(0, 6).filter((r) => r.error);
  assert.strictEqual(refused.length, 3, "1 running + 2 waiting for one client; the other three are told busy at once");
  for (const r of refused) { assert.strictEqual(r.error.code, "busy"); assert.strictEqual(r.error.status, 503); }
  assert.ok(results[6].value, "the customer was queued and served although the attacker asked for six places first");
  assert.strictEqual(pool.stats().queueFullForClient, 3);
});

test("round-robin: when a worker frees up, the client that has not had a turn goes before the one that just did", async () => {
  const pool = make({ parseConcurrency: 1, parseQueueMax: 8, parseQueuePerClient: 3, parseQueueWaitMs: 10000, testDelayMs: 150 });
  const order = [];
  const go = (client, tag) => settle(pool.run({ filePath: cube, client })).then((r) => { order.push(tag); return r; });
  const jobs = [go("A", "A1"), go("A", "A2"), go("A", "A3")];
  await sleep(30);
  jobs.push(go("B", "B1"), go("C", "C1"));
  await Promise.all(jobs);
  assert.deepStrictEqual(order, ["A1", "B1", "C1", "A2", "A3"], "first come first served would have been A1 A2 A3 B1 C1");
});

test("a parsing allowance per client per hour, charged for the time really used, including a parse that was stopped", async () => {
  const pool = make({ parseConcurrency: 2, parseQueueMax: 4, parseTimeoutMs: 400, parseSecondsPerClientHour: 1, testDelayMs: 2000 });
  // Two parses, each stopped at 400 ms: 0.8 s of the 1 s allowance.
  for (let i = 0; i < 2; i++) {
    const r = await settle(pool.run({ filePath: cube, client: "slow" }));
    assert.strictEqual(r.error.code, "parse-timeout");
  }
  assert.ok(pool.budget.usedMs("slow") >= 700, `stopped parses were charged: ${pool.budget.usedMs("slow")} ms`);
  const third = await settle(pool.run({ filePath: cube, client: "slow" }));
  assert.strictEqual(third.error.code, "parse-timeout"); // 0.8 s used: still under 1 s when it started
  const fourth = await settle(pool.run({ filePath: cube, client: "slow" }));
  assert.strictEqual(fourth.error.code, "parse-budget", "the allowance is used up: refused before the file is read");
  assert.strictEqual(fourth.error.status, 429);
  assert.strictEqual(fourth.error.offerRfq, true);
  assert.ok(fourth.error.retryAfter >= 60);
  assert.ok(/email/i.test(fourth.error.message) && !/worker|thread|budget|second/i.test(fourth.error.message), fourth.error.message);
  // another client is not affected
  const quick = make({ parseConcurrency: 1 });
  assert.ok((await settle(quick.run({ filePath: cube, client: "other" }))).value);
  assert.strictEqual(pool.budget.usedMs("other"), 0);
});

test("after a parse of theirs is stopped, a client does not get the last free worker; everyone else does", async () => {
  const pool = make({ parseConcurrency: 2, parseQueueMax: 8, parseQueuePerClient: 4, parsePerClient: 2, parseTimeoutMs: 300, parseQueueWaitMs: 5000, testDelayMs: 1500 });
  const first = await settle(pool.run({ filePath: cube, client: "suspect" }));
  assert.strictEqual(first.error.code, "parse-timeout");
  // Both workers are free. The suspect starts one parse (a worker is still free after it) …
  const s1 = settle(pool.run({ filePath: cube, client: "suspect" }));
  await sleep(20);
  assert.strictEqual(pool.stats().running, 1);
  // … and its next one waits even though a worker is idle …
  const s2 = settle(pool.run({ filePath: cube, client: "suspect" }));
  await sleep(20);
  assert.deepStrictEqual([pool.stats().running, pool.stats().queued], [1, 1], "the last free worker is not given to the suspect");
  // … while a client with a clean record takes it at once.
  const clean = settle(pool.run({ filePath: cube, client: "clean" }));
  await sleep(20);
  assert.deepStrictEqual([pool.stats().running, pool.stats().queued], [2, 1]);
  await Promise.all([s1, s2, clean]);
});

test("time by file kind: 10 s for a DXF, a base plus time per megabyte for the others, never more than the overall limit", async () => {
  const pool = make({});
  const MB = 1024 * 1024;
  assert.strictEqual(pool._timeoutFor({ filePath: "a.dxf", sizeBytes: 900 }), 10000);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.dxf", sizeBytes: 40 * MB }), 10000);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.stl", sizeBytes: 1 * MB }), 17000);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.3mf", sizeBytes: 10 * MB }), 35000);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.step", sizeBytes: 2 * MB }), 50000);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.igs", sizeBytes: 12 * 1024 }), 30117);
  assert.strictEqual(pool._timeoutFor({ filePath: "a.step", sizeBytes: 49 * MB }), 60000, "capped by PARSE_TIMEOUT_MS");
  assert.strictEqual(pool._timeoutFor({ filePath: "/x/y.enc", options: { ext: ".dxf" }, buffer: Buffer.alloc(10) }), 10000, "a decrypted re-read is judged by its real kind");
  process.env.PARSE_TIMEOUT_MS = "5000";
  try { assert.strictEqual(pool._timeoutFor({ filePath: "a.step", sizeBytes: MB }), 5000); } finally { delete process.env.PARSE_TIMEOUT_MS; }
});

test("memory limits derive from one setting, MEMORY_BUDGET_MB, with a default that fits a 1 GB container", async () => {
  const { limits } = require("../security/limits");
  const saved = { ...process.env };
  for (const k of ["MEMORY_BUDGET_MB", "PARSE_MAX_HEAP_MB", "PARSE_RSS_LIMIT_MB", "DB_MAX_MB"]) delete process.env[k];
  try {
    // worker heap, the parsing share (several parses / one alone), the line for the whole process (resident memory)
    const lines = () => [limits.parseMaxHeapMb, limits.parseRssLimitMb, limits.parseRssSoloLimitMb, limits.parseRssCeilingMb];
    assert.deepStrictEqual([limits.memoryBudgetMb, ...lines()], [1024, 384, 512, 634, 942]);
    process.env.MEMORY_BUDGET_MB = "2048";
    assert.deepStrictEqual(lines(), [768, 1024, 1269, 1884]);
    process.env.MEMORY_BUDGET_MB = "4096";
    assert.deepStrictEqual(lines(), [1536, 2048, 2539, 3768]);
    // The database ceiling no longer follows memory: it is what keeps a save short (16 MB, about 30 ms).
    assert.strictEqual(limits.databaseMaxBytes / 1048576, 16);
    process.env.PARSE_MAX_HEAP_MB = "512";
    assert.strictEqual(limits.parseMaxHeapMb, 512, "an explicit setting still wins");
    process.env.MEMORY_BUDGET_MB = "not a number";
    assert.strictEqual(limits.memoryBudgetMb, 1024, "a typo falls back to the default, never to no limit");
  } finally {
    for (const k of ["MEMORY_BUDGET_MB", "PARSE_MAX_HEAP_MB", "PARSE_RSS_LIMIT_MB", "DB_MAX_MB"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// ─── Through the upload route ────────────────────────────────
let server;
test("a request whose first file runs out of time: the rest of the request is not read, and the client's allowance is charged", async () => {
  // "A DXF that is slow to read" is made with the test hook (the worker spins 5 s before any .dxf),
  // not with a pathological drawing: how fast the parser reads a given file changes from branch to
  // branch, and this test is about what the pool does when a file runs out of time.
  server = await live.start({ env: { PARSE_TIMEOUT_DXF_MS: "700", PARSE_SECONDS_PER_CLIENT_HOUR: "5", PARSE_CONCURRENCY: "2", PARSE_TEST_DELAY_MS: "5000", PARSE_TEST_DELAY_EXT: ".dxf" } });
  const slow = Buffer.from("0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n10\n50\n20\n0\n10\n50\n20\n30\n10\n0\n20\n30\n0\nENDSEC\n0\nEOF\n");
  const files = [{ name: "slow.dxf", data: slow }, { name: "a.stl", data: cubeBytes }, { name: "b.stl", data: cubeBytes }, { name: "c.dxf", data: slow }];
  const t0 = Date.now();
  const r = await server.upload(files, { ip: "203.0.113.81" });
  const took = Date.now() - t0;
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.deepStrictEqual(r.body.parts, []);
  assert.deepStrictEqual(r.body.errors.map((e) => e.code), ["parse-timeout", "not-read", "not-read", "not-read"]);
  assert.ok(/by itself/i.test(r.body.errors[1].error), r.body.errors[1].error);
  // The limit is 0.7 s of the worker's CPU time; on the clock that may be up to four times as long on a busy machine.
  assert.ok(took < 5000, `one file's limit, not four: ${took} ms (load ${os.loadavg()[0].toFixed(1)})`);
  assert.deepStrictEqual(server.files("uploads"), [], "nothing is left on disk");

  // A real customer on another address is read normally meanwhile and afterwards.
  const ok = await server.upload([{ name: "cube.stl", data: cubeBytes }], { ip: "203.0.113.82" });
  assert.strictEqual(ok.body.parts.length, 1);

  // The slow sender's allowance (5 s on the clock here) runs out after a few more stopped files; then it is refused before parsing.
  const codes = [];
  for (let i = 0; i < 10 && !codes.includes("parse-budget"); i++) {
    const again = await server.upload([{ name: "slow.dxf", data: slow }], { ip: "203.0.113.81" });
    codes.push(again.body.errors[0].code);
  }
  assert.ok(codes.includes("parse-budget"), `codes: ${codes.join(" ")}`);
  assert.ok(codes.filter((c) => c === "parse-timeout").length <= 10);
  const t1 = Date.now();
  const refused = await server.upload([{ name: "cube.stl", data: cubeBytes }, { name: "cube2.stl", data: cubeBytes }], { ip: "203.0.113.81" });
  assert.deepStrictEqual(refused.body.errors.map((e) => e.code), ["parse-budget", "parse-budget"]);
  assert.ok(Date.now() - t1 < 1500, "refused without a parse");
  assert.strictEqual(refused.body.errors[0].offerRfq, true);
});

test("the reading limit is the worker's CPU time, not the clock: a busy machine does not turn a file into a refusal, and the clock still has the last word", async () => {
  if (!fs.existsSync("/proc/thread-self")) { console.log("       (no per-thread CPU clock on this system: the limit is on the clock, as before)"); return; }
  // A parse that needs 300 ms of CPU, with a 600 ms limit, while three other threads compete for the processor.
  const { Worker } = require("worker_threads");
  const hogs = Array.from({ length: Math.max(3, os.cpus().length * 2) }, () => new Worker("const until = Date.now() + 4000; while (Date.now() < until) {}", { eval: true }));
  try {
    const pool = make({ parseConcurrency: 1, parseTimeoutMs: 600, testDelayMs: 300 });
    const t0 = Date.now();
    const r = await settle(pool.run({ filePath: cube, client: "customer" }));
    const took = Date.now() - t0;
    assert.ok(r.value, `read in ${took} ms on the clock with the processor contended: ${r.error && r.error.code}`);
    // The same file given too little CPU time is still stopped, and the answer says so.
    const tight = make({ parseConcurrency: 1, parseTimeoutMs: 150, testDelayMs: 2000 });
    const s = await settle(tight.run({ filePath: cube, client: "customer" }));
    assert.strictEqual(s.error && s.error.code, "parse-timeout");
    // On the clock a parse may take PARSE_WALL_FACTOR times its limit and no more, however little CPU it was given.
    const wall = make({ parseConcurrency: 1, parseTimeoutMs: 200, parseWallFactor: 1, testDelayMs: 2000 });
    const t1 = Date.now();
    const w = await settle(wall.run({ filePath: cube, client: "customer" }));
    assert.strictEqual(w.error && w.error.code, "parse-timeout");
    assert.ok(Date.now() - t1 < 1500, `stopped on the clock after ${Date.now() - t1} ms`);
  } finally { for (const h of hogs) await h.terminate(); }
});

run(async () => {
  for (const p of pools) await p.close();
  if (server) await server.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
