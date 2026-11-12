#!/usr/bin/env node
/**
 * Where the time goes for one corpus case: the recogniser's own stage
 * stopwatch plus a sampled CPU profile (top functions by self time).
 *
 *   node tools/geometry-bench/profile.js <id> [--top 25] [--save out.cpuprofile]
 *
 * Runs on this thread (no worker) so the profiler sees the parse.
 */
const fs = require("fs");
const path = require("path");
const inspector = require("inspector");
const { byId } = require("./corpus");
const lib = require("./lib");

(async () => {
  const args = lib.parseArgs(process.argv.slice(2));
  const c = byId(args._[0]);
  if (!c) { console.error(`unknown case ${args._[0] || ""}`); process.exit(2); }
  const { parseFile } = require(path.join(lib.ROOT, "server", "parsers", "fileParser"));
  const buffer = fs.readFileSync(lib.inputFile(c));
  const session = new inspector.Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  const t0 = process.hrtime.bigint(), cpu0 = process.cpuUsage();
  let parsed = null, error = null;
  try { parsed = await parseFile("case" + c.ext, { ext: c.ext, buffer, ...(c.options || {}) }); } catch (err) { error = err; }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6, cpu = process.cpuUsage(cpu0);
  const { profile } = await post("Profiler.stop");
  if (args.save) fs.writeFileSync(String(args.save), JSON.stringify(profile));

  const self = new Map();
  const dt = profile.timeDeltas || [];
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byNode.get(profile.samples[i]), d = (dt[i] || 0) / 1000;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${path.relative(lib.ROOT, (f.url || "").replace("file://", "")) || "(native)"}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + d);
    total += d;
  }
  console.log(`${c.id}: ${wall.toFixed(0)} ms wall, ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms cpu${error ? ` — refused: ${error.message.slice(0, 80)}` : ""}`);
  const stages = parsed && parsed.geometry.features && parsed.geometry.features.timings;
  if (stages) console.log("stages (ms): " + Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(", "));
  const top = Array.from(self.entries()).sort((a, b) => b[1] - a[1]).slice(0, Number(args.top) || 25);
  for (const [k, ms] of top) console.log(`${ms.toFixed(0).padStart(8)} ms ${((100 * ms) / total).toFixed(1).padStart(5)}%  ${k}`);
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
