#!/usr/bin/env node
/**
 * Run one corpus case in a real parse worker and write the measured result.
 * Used by snapshot.js and compare.js (one process per case so memory peaks
 * belong to that case alone).
 *
 *   node tools/geometry-bench/run-case.js <id> <out.json> [--heap 768]
 *
 * out.json       { id, input, hash, summary, timing, stages }
 * out.json.full  the canonical text of the three sections (gzip)
 */
const fs = require("fs");
const os = require("os");
const zlib = require("zlib");
const { byId } = require("./corpus");
const lib = require("./lib");

(async () => {
  const args = lib.parseArgs(process.argv.slice(2));
  const c = byId(args._[0]);
  if (!c) throw new Error(`unknown case ${args._[0]}`);
  const file = lib.inputFile(c);
  const stat = fs.statSync(file);
  const input = { bytes: stat.size, sha256: lib.sha256(fs.readFileSync(file)) };
  const load0 = os.loadavg()[0];
  const m = await lib.runInWorker(file, c.options || {}, { heapMb: Number(args.heap) || 768 });
  const t1 = Date.now();
  const sec = lib.sections(m.parsed, m.error);
  const d = lib.digest(sec);
  const out = {
    id: c.id, input, hash: d.hash, summary: lib.summarise(sec),
    timing: { wallMs: m.wallMs, cpuMs: m.cpuMs, peakHeapMb: m.peakHeapMb, peakV8HeapMb: m.peakV8HeapMb, peakRssMb: m.peakRssMb, baseRssMb: m.baseRssMb, afterParseMs: Date.now() - t1, load: Math.round(load0 * 10) / 10 },
    stages: m.stages,
  };
  fs.writeFileSync(args._[1], JSON.stringify(out));
  fs.writeFileSync(args._[1] + ".full", zlib.gzipSync(`{"geometry":${d.text.geometry},"dfm":${d.text.dfm},"price":${d.text.price}}`));
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
