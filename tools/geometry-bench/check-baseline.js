#!/usr/bin/env node
/**
 * Is the recorded baseline complete and self-consistent?
 *
 *   node tools/geometry-bench/check-baseline.js [--size small,medium,large]
 *
 * Every selected case must have an index entry; a committed snapshot must exist,
 * unpack, and hash to the values in the index. Lists what is missing. Exit 0
 * only when nothing is.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { cases } = require("./corpus");
const lib = require("./lib");

const args = lib.parseArgs(process.argv.slice(2));
const index = JSON.parse(fs.readFileSync(path.join(lib.BASELINE_DIR, "index.json"), "utf8"));
const list = lib.select(cases, args);
const missing = [], broken = [], unfinished = [];
let ok = 0;
for (const c of list) {
  const e = index.cases[c.id];
  if (!e) { missing.push(c.id); continue; }
  if (e.unfinished) { unfinished.push(`${c.id} (${e.unfinished}: ${e.note})`); continue; }
  if (!e.hash || !e.input) { broken.push(`${c.id}: entry has no hashes`); continue; }
  if (e.snapshot) {
    const f = path.join(lib.BASELINE_DIR, "snapshots", c.id + ".json.gz");
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
      const bad = ["geometry", "dfm", "price"].filter((s) => lib.sha256(lib.canonical(j[s])) !== e.hash[s]);
      if (bad.length) { broken.push(`${c.id}: snapshot does not match the index (${bad.join(", ")})`); continue; }
    } catch (err) { broken.push(`${c.id}: snapshot unreadable (${err.message})`); continue; }
  }
  ok++;
}
const known = new Set(cases.map((c) => c.id));
const stale = Object.keys(index.cases).filter((id) => !known.has(id));
console.log(`${ok} complete, ${unfinished.length} recorded as unfinished by the baseline code, ${missing.length} missing, ${broken.length} broken, ${stale.length} entries for cases no longer in the corpus`);
for (const m of missing) console.log(`  missing     ${m}`);
for (const b of broken) console.log(`  broken      ${b}`);
for (const u of unfinished) console.log(`  unfinished  ${u}`);
for (const s of stale) console.log(`  stale       ${s}`);
process.exit(missing.length || broken.length ? 1 : 0);
