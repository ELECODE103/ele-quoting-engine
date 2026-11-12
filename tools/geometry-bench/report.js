#!/usr/bin/env node
/**
 * Before/after table (Markdown) from the recorded baseline and a comparer run.
 *
 *   node tools/geometry-bench/compare.js --size small,medium,large --out after.json
 *   node tools/geometry-bench/report.js after.json [--size medium,large] [--match re] > table.md
 *
 * Times are CPU time of the worker thread (wall time in brackets): on a shared
 * machine only CPU time is comparable between runs.
 */
const fs = require("fs");
const path = require("path");
const { cases } = require("./corpus");
const lib = require("./lib");

const args = lib.parseArgs(process.argv.slice(2));
const after = JSON.parse(fs.readFileSync(args._[0], "utf8")).cases;
const index = JSON.parse(fs.readFileSync(path.join(lib.BASELINE_DIR, "index.json"), "utf8")).cases;
const t = (ms) => (ms == null ? "–" : ms >= 100000 ? `${Math.round(ms / 1000)} s` : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const size = (c, r) => {
  const s = (r && r.summary) || (index[c.id] && index[c.id].summary) || {};
  if (s.triangles != null) return `${s.triangles.toLocaleString("en-US")} tri`;
  if (s.loops != null) return `${s.loops.toLocaleString("en-US")} contours`;
  return c.n != null ? `~${c.n.toLocaleString("en-US")}${c.ext === ".dxf" ? " ent." : " tri"}` : "";
};
console.log("| Case | Size | Before (CPU, wall) | After (CPU, wall) | Peak memory after: V8 heap / process | Result identical |");
console.log("|---|---|---|---|---|---|");
for (const c of lib.select(cases, args)) {
  const b = index[c.id], a = after[c.id];
  if (!a) continue;
  const before = !b ? "not recorded" : b.unfinished ? `did not finish (${b.note})` : `${t(b.timing.cpuMs)} (${t(b.timing.wallMs)})`;
  const now = a.timing ? `${t(a.timing.cpuMs)} (${t(a.timing.wallMs)})` : "–";
  const mem = a.timing ? `${a.timing.peakV8HeapMb != null ? Math.round(a.timing.peakV8HeapMb) : "?"} / ${Math.round(a.timing.peakRssMb)} MB` : "–";
  const outcome = a.summary && a.summary.status === "refused" ? ` — refused: ${a.summary.code || a.summary.message.slice(0, 60)}` : "";
  const same = !b ? "no baseline" : b.unfinished ? `no baseline answer${outcome}` : a.identical ? "yes" : "**NO**";
  console.log(`| ${c.id} | ${size(c, a)} | ${before} | ${now} | ${mem} | ${same} |`);
}
