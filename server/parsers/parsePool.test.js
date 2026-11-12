/**
 * Worker pool for geometry parsing: same answers as the main thread, bounded
 * concurrency and queue, a real timeout, memory ceilings, fairness, and a main
 * thread that stays free while a large file is read.
 * Run: node server/parsers/parsePool.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { runner } = require("../testSupport/harness");
const { box3mf, binaryStl } = require("../testSupport/zip");
const { machineProbe, assertResponsive } = require("../testSupport/latency");
const { ParsePool } = require("./parsePool");
const { parseFile } = require("./fileParser");

const { test, run } = runner("Parse pool (worker threads)");
const root = path.join(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-pool-"));
const write = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };

const bigStep = write("plate_400_holes.step", zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "security", "fixtures", "plate_400_holes.step.gz"))));
const cube = path.join(root, "tools", "vet-quotes", "parts", "cube_20mm.stl");

/** A DXF of `n` random crossing lines: half a megabyte of it keeps the contour builder busy for tens of seconds. */
function crossingLinesDxf(n) {
  let seed = 1;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
  let s = "0\nSECTION\n2\nENTITIES\n";
  for (let i = 0; i < n; i++) s += `0\nLINE\n8\n0\n10\n${r()}\n20\n${r()}\n11\n${r()}\n21\n${r()}\n`;
  return s + "0\nENDSEC\n0\nEOF\n";
}

/** Everything but the stopwatch readings the recogniser attaches. */
function withoutTimings(result) {
  const copy = JSON.parse(JSON.stringify(result));
  if (copy.geometry && copy.geometry.features) delete copy.geometry.features.timings;
  return copy;
}

const pools = [];
const make = (opts) => { const p = new ParsePool(opts); pools.push(p); return p; };
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

test("a file parsed in a worker gives exactly the result the main thread gives (STL, STEP, IGES, DXF, 3MF)", async () => {
  const pool = make({});
  const files = [
    cube,
    path.join(root, "server", "geometry", "fixtures", "plate_holes.step"),
    path.join(root, "server", "geometry", "fixtures", "tray.step"),
    path.join(__dirname, "..", "security", "fixtures", "box_hole.igs"),
    path.join(root, "tools", "vet-quotes", "parts", "dxf_plate_holes.dxf"),
    path.join(root, "tools", "vet-quotes", "parts", "bushing.stl"),
    write("box.3mf", box3mf(20, 30, 40)),
  ];
  for (const f of files) {
    const inWorker = await pool.run({ filePath: f });
    const inline = await parseFile(f);
    assert.deepStrictEqual(withoutTimings(inWorker), withoutTimings(inline), `${path.basename(f)} differs between worker and main thread`);
    assert.ok(inWorker.geometry.boundingBox.width > 0, `${path.basename(f)} has a real bounding box`);
  }
  assert.ok(pool.stats().workersStarted <= 2, "small files reuse a warm worker");
});

test("bytes handed over in memory (a decrypted upload) parse the same as the file on disk", async () => {
  const pool = make({});
  const f = path.join(root, "tools", "vet-quotes", "parts", "dxf_inch_guard.dxf");
  const fromBuffer = await pool.run({ filePath: "/nonexistent/renamed.dxf.enc", buffer: fs.readFileSync(f), options: { ext: ".dxf", units: "in" } });
  const inline = await parseFile(f, { units: "in" });
  assert.deepStrictEqual(withoutTimings(fromBuffer).geometry, withoutTimings(inline).geometry);
});

test("the parser's own messages and error codes come back from the worker intact", async () => {
  const pool = make({});
  const r = await settle(pool.run({ filePath: write("empty.3mf", Buffer.from("PK\u0003\u0004 not really a zip")) }));
  assert.ok(r.error && /3MF/.test(r.error.message), r.error && r.error.message);
  assert.strictEqual(r.error.fromParser, true);
  const missing = await settle(pool.run({ filePath: path.join(tmp, "does-not-exist.stl") }));
  assert.ok(missing.error, "a missing file is an error, not a hang");
  // and the pool still works afterwards
  assert.ok(Math.abs((await pool.run({ filePath: cube })).geometry.volume - 8000) < 1, "a good file still parses");
});

test("concurrency limit: never more files in flight than PARSE_CONCURRENCY", async () => {
  const pool = make({ parseConcurrency: 2, parsePerClient: 5, parseQueueMax: 20, testDelayMs: 250 });
  let peak = 0;
  const probe = setInterval(() => { peak = Math.max(peak, pool.stats().running); }, 10);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => pool.run({ filePath: cube, client: `c${i}` })));
  clearInterval(probe);
  assert.strictEqual(peak, 2, `peak concurrency ${peak}`);
  assert.ok(Date.now() - t0 >= 3 * 250 - 50, "six 250 ms jobs through two workers take at least three rounds");
});

test("queue limit: past PARSE_QUEUE_MAX the caller is told 'busy' (503 + Retry-After) at once", async () => {
  const pool = make({ parseConcurrency: 1, parsePerClient: 5, parseQueueMax: 2, testDelayMs: 400, parseTimeoutMs: 20000 });
  const machine = machineProbe();
  const jobs = Array.from({ length: 5 }, () => settle(pool.run({ filePath: cube })));
  const t0 = Date.now();
  const refused = await Promise.race(jobs.slice(3));
  const waited = Date.now() - t0;
  // "At once": well inside the 400 ms a queued job would take — 200 ms on a quiet machine, plus any stall the
  // machine itself showed while this ran, and never the 400 ms of a job (was a flat "< 200").
  const stall = await machine.stop();
  assert.ok(waited < Math.min(390, 200 + stall), `the refusal is immediate, not after a wait (${waited} ms; machine stall ${stall} ms)`);
  assert.strictEqual(refused.error.code, "busy");
  assert.strictEqual(refused.error.status, 503);
  assert.ok(refused.error.retryAfter >= 5, "says when to retry");
  assert.ok(/try|again/i.test(refused.error.message), refused.error.message);
  const all = await Promise.all(jobs);
  assert.strictEqual(all.filter((r) => r.value).length, 3, "one running + two queued complete");
  assert.strictEqual(all.filter((r) => r.error && r.error.code === "busy").length, 2);
  assert.strictEqual(pool.stats().busy, 2);
});

test("queue wait limit: a file that waits longer than PARSE_QUEUE_WAIT_MS is told 'busy' too", async () => {
  const pool = make({ parseConcurrency: 1, parsePerClient: 5, parseQueueMax: 5, parseQueueWaitMs: 150, testDelayMs: 600 });
  const first = settle(pool.run({ filePath: cube }));
  const waiting = await settle(pool.run({ filePath: cube }));
  assert.strictEqual(waiting.error.code, "busy");
  assert.ok((await first).value, "the running job is not disturbed");
});

test("wall-clock timeout: the worker is terminated and the caller gets a firm-quote message", async () => {
  const pool = make({ parseConcurrency: 1, parseTimeoutMs: 300, testDelayMs: 30000 });
  const t0 = Date.now();
  const r = await settle(pool.run({ filePath: cube }));
  const took = Date.now() - t0;
  assert.strictEqual(r.error.code, "parse-timeout");
  assert.strictEqual(r.error.status, 422);
  assert.strictEqual(r.error.offerRfq, true);
  assert.ok(/firm quote/i.test(r.error.message), r.error.message);
  assert.ok(took < 1500, `gave up after ${took} ms, not 30 s`);
  assert.deepStrictEqual([pool.stats().running, pool.stats().idleWorkers, pool.stats().timedOut], [0, 0, 1], "the stuck worker is gone, not parked");
});

test("timeout against a real pathological file: 5,000 crossing lines (a 480 kB DXF) are stopped mid-parse", async () => {
  const pool = make({ parseConcurrency: 1, parseTimeoutMs: 1200 });
  const dxf = write("crossing.dxf", crossingLinesDxf(5000));
  assert.ok(fs.statSync(dxf).size < 600 * 1024, "the file is small — size limits alone would not catch it");
  const t0 = Date.now();
  const r = await settle(pool.run({ filePath: dxf }));
  assert.strictEqual(r.error.code, "parse-timeout");
  assert.ok(Date.now() - t0 < 3000, `stopped in ${Date.now() - t0} ms`);
  // the slot is free again and a good file parses
  assert.ok(Math.abs((await pool.run({ filePath: cube })).geometry.volume - 8000) < 1, "a good file still parses");
});

test("memory ceiling: a worker that outgrows its heap limit is stopped; the server process is untouched", async () => {
  const pool = make({ parseConcurrency: 1, parseMaxHeapMb: 24, parseTimeoutMs: 60000 });
  const stl = write("big.stl", binaryStl(400000)); // 20 MB of triangles → several hundred MB of arrays
  const r = await settle(pool.run({ filePath: stl }));
  assert.strictEqual(r.error.code, "parse-memory", r.error && r.error.message);
  assert.strictEqual(r.error.offerRfq, true);
  assert.ok(/memory/i.test(r.error.message) && /firm quote/i.test(r.error.message), r.error.message);
  assert.strictEqual(pool.stats().outOfMemory, 1);
  assert.ok(Math.abs((await make({}).run({ filePath: cube })).geometry.volume - 8000) < 1, "this process is alive and can still parse");
});

test("memory watchdog: when parsing has added more than PARSE_RSS_LIMIT_MB to the process, the longest-running parse is stopped", async () => {
  let rss = 100 * 1024 * 1024;
  const pool = make({ parseConcurrency: 2, parsePerClient: 2, parseRssLimitMb: 500, watchIntervalMs: 50, rssProbe: () => rss, testDelayMs: 1500 });
  const first = settle(pool.run({ filePath: cube }));
  await new Promise((r) => setTimeout(r, 100));
  const second = settle(pool.run({ filePath: cube }));
  await new Promise((r) => setTimeout(r, 100));
  rss = 900 * 1024 * 1024; // +800 MB of WASM / typed-array memory the V8 heap limit does not see
  const a = await first;
  assert.strictEqual(a.error && a.error.code, "parse-memory", "the oldest parse is the one stopped");
  rss = 100 * 1024 * 1024;
  assert.ok((await second).value, "the other parse finishes once memory is back under the line");
});

test("fairness: one client's files queue behind each other, not in front of everyone else", async () => {
  const pool = make({ parseConcurrency: 2, parsePerClient: 1, parseQueueMax: 20, testDelayMs: 300 });
  const order = [];
  const go = (client, label) => pool.run({ filePath: cube, client }).then(() => order.push(label));
  const jobs = [go("A", "A1"), go("A", "A2"), go("A", "A3"), go("B", "B1")];
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(pool.stats().running, 2, "A1 and B1 run together; A2 waits although a worker was free when it arrived");
  await Promise.all(jobs);
  assert.ok(order.indexOf("B1") < order.indexOf("A2"), `order was ${order.join(", ")}`);
});

test("cancel: a job whose client went away frees its worker and its place in the queue", async () => {
  const pool = make({ parseConcurrency: 1, parsePerClient: 5, parseQueueMax: 5, testDelayMs: 5000, parseTimeoutMs: 20000 });
  const running = pool.run({ filePath: cube });
  const queued = pool.run({ filePath: cube });
  const a = settle(running), b = settle(queued);
  await new Promise((r) => setTimeout(r, 100));
  queued.cancel();
  running.cancel();
  assert.strictEqual((await a).error.code, "cancelled");
  assert.strictEqual((await b).error.code, "cancelled");
  assert.deepStrictEqual([pool.stats().running, pool.stats().queued], [0, 0]);
});

test("the main thread stays free while a 2 MB STEP file (400 holes, ~10 s of OpenCascade) is read", async () => {
  const pool = make({ parseTimeoutMs: 120000 });
  let worstLag = 0, ticks = 0, last = Date.now();
  // An idle timer on its own thread sees only what the machine does to every thread; the one below also sees this thread's work.
  const machine = machineProbe();
  const timer = setInterval(() => { const now = Date.now(); worstLag = Math.max(worstLag, now - last - 20); last = now; ticks++; }, 20);
  const t0 = Date.now();
  const parsed = await pool.run({ filePath: bigStep, sizeBytes: fs.statSync(bigStep).size });
  clearInterval(timer);
  const took = Date.now() - t0;
  const machineMs = await machine.stop();
  assert.strictEqual(parsed.geometry.estimatedHoles, 400, "the plate's 400 holes were recognised");
  assert.ok(took > 1500, `the parse really is slow (${took} ms)`);
  // Was a flat "< 250 ms". Now 250 ms plus the stall an idle thread saw in the same window, and never over the
  // ceiling of 1000 ms / half the parse time, which a parse on this thread cannot meet (testSupport/latency.js).
  assertResponsive([worstLag], { tightMs: 250, tookMs: took, machineMs, what: "longest the main thread was held during the parse" });
  assert.ok(ticks > took / 20 / 2, `timers kept firing (${ticks} ticks in ${took} ms)`);
  assert.strictEqual(pool.stats().idleWorkers, 0, "a worker that read a large, slow file is retired, not kept warm");
  console.log(`       (STEP parse ${took} ms in a worker; worst main-thread lag ${worstLag} ms)`);
});

run(async () => {
  for (const p of pools) await p.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
