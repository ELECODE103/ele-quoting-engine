#!/usr/bin/env node
/**
 * Second re-review (2026-11-13): the re-recorded geometry price baseline, compared with the one it
 * replaced FIELD BY FIELD (the author says 404 priced cases in 113 files differ, only in shipping fields).
 *
 *   node tools/security/rereview-fixes/r3-baseline-diff.js [oldRef=dce1e38]
 *
 * Reads every tools/geometry-bench/baseline/snapshots/*.json.gz as it is now and as git has it at
 * `oldRef`, and lists every leaf value that differs, grouped by the name of the field it is in.
 * Needs nothing but git and Node. Exit code 1 if a field that is not about shipping differs.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OLD = process.argv[2] || "dce1e38";
const ROOT = path.join(__dirname, "..", "..", "..");
const DIR = "tools/geometry-bench/baseline/snapshots";
const SHIPPING = /(^|\.)(shipping(\.|$)|shippingEstimate$|orderTotal$)/;
const GATE = /(^|\.)gate(\.|$)|requiresRfq|reasons/;

function leaves(v, at, out) {
  if (v === null || typeof v !== "object") { out.set(at, JSON.stringify(v)); return; }
  if (Array.isArray(v)) { out.set(`${at}.length`, String(v.length)); v.forEach((x, i) => leaves(x, `${at}[${i}]`, out)); return; }
  for (const k of Object.keys(v)) leaves(v[k], at ? `${at}.${k}` : k, out);
}
const names = fs.readdirSync(path.join(ROOT, DIR)).filter((n) => n.endsWith(".json.gz")).sort();
const byField = new Map(); // generalised path → count
const filesDiffer = new Set();
const casesDiffer = new Set();
const other = [];
let added = 0, compared = 0;
for (const name of names) {
  const now = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, DIR, name))).toString());
  let was;
  try { was = JSON.parse(zlib.gunzipSync(execFileSync("git", ["show", `${OLD}:${DIR}/${name}`], { cwd: ROOT, maxBuffer: 1 << 28 })).toString()); } catch { added++; continue; }
  compared++;
  const a = new Map(), b = new Map();
  leaves(was, "", a); leaves(now, "", b);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) === b.get(key)) continue;
    filesDiffer.add(name);
    const general = key.replace(/\[\d+\]/g, "[]");
    byField.set(general, (byField.get(general) || 0) + 1);
    // One "priced case" is one price entry of one file: the path up to and including the price's own key.
    const at = key.indexOf(".quote.");
    casesDiffer.add(`${name}:${at > 0 ? key.slice(0, at) : key}`);
    if (!SHIPPING.test(general)) other.push({ file: name, field: key, was: a.get(key), now: b.get(key) });
  }
}
const rows = [...byField.entries()].sort((x, y) => y[1] - x[1]);
console.log(`snapshots now: ${names.length}; compared with ${OLD}: ${compared}; new files with no older version: ${added}`);
console.log(`files that differ: ${filesDiffer.size}; priced cases that differ (one case = one configuration at one quantity in one file): ${casesDiffer.size}`);
console.log("fields that differ (path with list positions removed → number of values):");
for (const [f, n] of rows.slice(0, 40)) console.log(`  ${String(n).padStart(6)}  ${f}${SHIPPING.test(f) ? "" : GATE.test(f) ? "   <-- gate" : "   <-- NOT a shipping field"}`);
const notShipping = other.filter((o) => !GATE.test(o.field));
console.log(`values that differ outside the shipping block, shippingEstimate and orderTotal: ${other.length} (of which about the gate: ${other.length - notShipping.length})`);
for (const o of other.slice(0, 12)) console.log(`  ${o.file} ${o.field}: ${String(o.was).slice(0, 80)} → ${String(o.now).slice(0, 80)}`);
process.exit(notShipping.length ? 1 : 0);
