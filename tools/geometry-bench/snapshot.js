#!/usr/bin/env node
/**
 * Record the baseline: run the code as it stands over the corpus and save what
 * it returned.
 *
 *   node tools/geometry-bench/snapshot.js [--size small,medium,large] [--only id,…] [--match re] [--jobs 1] [--heap 4096]
 *
 * Writes tools/geometry-bench/baseline/
 *   index.json                 per case: input hash, result hashes (geometry / dfm / price), summary,
 *                              time, peak memory, per-stage stopwatch
 *   snapshots/<id>.json.gz     the full result of every small and medium case (canonical JSON)
 * and, not committed, .cache/full/<id>.json.gz for the large cases so a later
 * mismatch can still be shown value by value on this machine.
 *
 * The worker's heap ceiling is lifted (default 4096 MB) and no time limit is
 * applied: the point is to learn what the present code answers, however long
 * it takes. Existing entries for cases not selected are kept, so the corpus can
 * be recorded in several sittings.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { cases } = require("./corpus");
const lib = require("./lib");
const { runMany, fmtMs } = require("./pool");

const MAX_COMMITTED_SNAPSHOT = 400 * 1024; // gzip bytes; a bigger result is kept as hashes only

(async () => {
  const args = lib.parseArgs(process.argv.slice(2));
  const list = lib.select(cases, args);
  const indexFile = path.join(lib.BASELINE_DIR, "index.json");
  fs.mkdirSync(path.join(lib.BASELINE_DIR, "snapshots"), { recursive: true });
  fs.mkdirSync(path.join(lib.CACHE_DIR, "full"), { recursive: true });
  // The index is re-read before every write so two recordings running at once (say, the large
  // cases in one shell and a single new case in another) do not overwrite each other's entries.
  const load = () => (fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : { cases: {} });
  const save = (id, entry) => {
    const index = load();
    Object.assign(index, { node: process.version, platform: `${process.platform}-${process.arch}`, generatorKey: lib.generatorKey(), pricingFingerprint: lib.pricingFingerprint() });
    if (id) index.cases[id] = entry;
    const sorted = {};
    for (const k of Object.keys(index.cases).sort()) sorted[k] = index.cases[k];
    index.cases = sorted;
    const tmp = indexFile + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 1) + "\n");
    fs.renameSync(tmp, indexFile);
  };
  let failed = 0, done = 0;
  await runMany(list, {
    jobs: Number(args.jobs) || 1, heap: Number(args.heap) || 4096,
    onResult: (c, r, full, err) => {
      done++;
      if (err) { failed++; console.error(`✗ ${c.id}: ${err.message}`); return; }
      const gz = zlib.gzipSync(full, { level: 9 });
      const committed = c.size !== "large" && gz.length <= MAX_COMMITTED_SNAPSHOT;
      const snap = path.join(lib.BASELINE_DIR, "snapshots", c.id + ".json.gz"), cache = path.join(lib.CACHE_DIR, "full", c.id + ".json.gz");
      if (committed) { fs.writeFileSync(snap, gz); fs.rmSync(cache, { force: true }); } else { fs.rmSync(snap, { force: true }); fs.writeFileSync(cache, gz); }
      save(c.id, { size: c.size, family: c.family, ext: c.ext, n: c.n, input: r.input, hash: r.hash, snapshot: committed, summary: r.summary, timing: r.timing, stages: r.stages });
      console.log(`[${done}/${list.length}] ${c.id.padEnd(38)} ${fmtMs(r.timing.wallMs).padStart(9)} wall ${fmtMs(r.timing.cpuMs).padStart(9)} cpu  heap ${String(r.timing.peakHeapMb).padStart(6)} MB  rss ${String(r.timing.peakRssMb).padStart(6)} MB  ${r.summary.status}${r.summary.code ? " " + r.summary.code : ""}`);
    },
  });
  console.log(`\n${done - failed}/${list.length} cases recorded in ${path.relative(process.cwd(), indexFile)}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
