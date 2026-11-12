#!/usr/bin/env node
/**
 * Compare what the code returns now with the recorded baseline. Fails on ANY
 * difference and prints where: the JSON path, the baseline value and the
 * current value.
 *
 *   node tools/geometry-bench/compare.js [--size small,medium,large] [--only id,…] [--match re] [--jobs 1]
 *                                        [--heap 768] [--out timings.json] [--in-process]
 *
 * --heap        worker heap ceiling in MB (default 768, the production value)
 * --out         also write the measured times and memory of this run
 * --in-process  parse on this thread, no worker and no measurements (fast; what `npm test` uses for the small corpus)
 *
 * Exit code 0 only when every selected case has a baseline and matches it.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { cases } = require("./corpus");
const lib = require("./lib");
const { runMany, fmtMs } = require("./pool");

/** Baseline sections of a case as parsed JSON, or null when only hashes were kept. */
function baselineFull(id) {
  for (const f of [path.join(lib.BASELINE_DIR, "snapshots", id + ".json.gz"), path.join(lib.CACHE_DIR, "full", id + ".json.gz")]) {
    if (fs.existsSync(f)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  }
  return null;
}

/**
 * @returns {string[]} problems (empty when identical)
 */
function check(c, base, now, fullText, opts = {}) {
  const problems = [];
  if (!base) return [`no baseline recorded for ${c.id} (run snapshot.js on the baseline commit)`];
  if (base.unfinished) return [];
  if (base.input.sha256 !== now.input.sha256) {
    return [`the INPUT differs from the one the baseline was recorded with (${base.input.bytes} → ${now.input.bytes} bytes): a generator or the Node version changed, so results are not comparable`];
  }
  const sectionsToCheck = ["geometry", "dfm", "price"].filter((s) => !(s === "price" && opts.skipPrice));
  const changed = sectionsToCheck.filter((s) => base.hash[s] !== now.hash[s]);
  if (!changed.length) return problems;
  const before = baselineFull(c.id), after = fullText ? JSON.parse(fullText) : null;
  for (const s of changed) {
    if (!before || !after) { problems.push(`${s}: result hash differs (${base.hash[s].slice(0, 12)} → ${now.hash[s].slice(0, 12)}); the full baseline of this large case is not on this machine — record it with snapshot.js on the baseline commit to see the values`); continue; }
    const diffs = lib.differences(before[s], after[s], 25);
    for (const d of diffs) problems.push(`${s}${d.path === "(root)" ? "" : d.path}: ${lib.short(d.before)} → ${lib.short(d.after)}`);
    if (diffs.length >= 25) problems.push(`${s}: … more differences not shown`);
  }
  return problems;
}

async function main(argv) {
  const args = lib.parseArgs(argv);
  const list = lib.select(cases, args);
  const index = JSON.parse(fs.readFileSync(path.join(lib.BASELINE_DIR, "index.json"), "utf8"));
  const skipPrice = index.pricingFingerprint !== lib.pricingFingerprint();
  if (skipPrice) console.log("NOTE: pricing rules or the material catalog changed since the baseline was recorded — prices are not compared (geometry and DFM still are). Re-record the baseline to compare prices again.");
  const results = {};
  let bad = 0, n = 0, unfinished = 0;
  const report = (c, now, fullText, err) => {
    n++;
    const base0 = index.cases[c.id];
    if (!err && base0 && base0.unfinished) {
      // The baseline code never produced an answer for this input (it ran out of time or memory),
      // so there is nothing to be identical to. Shown, counted apart, not a failure.
      unfinished++;
      if (now) results[c.id] = { timing: now.timing || null, stages: now.stages || null, summary: now.summary, identical: null, baselineUnfinished: base0.note };
      console.log(`  no baseline answer  ${c.id.padEnd(30)} baseline: ${base0.note}; now: ${now.summary.status}${now.summary.message ? " — " + now.summary.message : ""}`);
      return;
    }
    const problems = err ? [err.message] : check(c, index.cases[c.id], now, fullText, { skipPrice });
    if (now) results[c.id] = { timing: now.timing || null, stages: now.stages || null, summary: now.summary, identical: problems.length === 0 };
    const base = index.cases[c.id];
    const t = now && now.timing ? `${fmtMs(now.timing.cpuMs != null ? now.timing.cpuMs : now.timing.wallMs).padStart(9)}${base && base.timing ? ` (was ${fmtMs(base.timing.cpuMs != null ? base.timing.cpuMs : base.timing.wallMs)})` : ""}` : "";
    if (problems.length) {
      bad++;
      console.log(`✗ ${c.id} ${t}`);
      for (const p of problems) console.log(`    ${p}`);
    } else if (!args.quiet) console.log(`  identical  ${c.id.padEnd(38)} ${t}`);
  };
  if (args["in-process"]) {
    for (const c of list) {
      try {
        const r = await lib.runInProcess(c);
        const d = lib.digest(r.sections);
        report(c, { input: r.input, hash: d.hash, summary: lib.summarise(r.sections) }, `{"geometry":${d.text.geometry},"dfm":${d.text.dfm},"price":${d.text.price}}`, null);
      } catch (err) { report(c, null, null, err); }
    }
  } else {
    await runMany(list, { jobs: Number(args.jobs) || 1, heap: Number(args.heap) || 768, onResult: (c, r, full, err) => report(c, r, full, err) });
  }
  if (args.out) fs.writeFileSync(String(args.out), JSON.stringify({ node: process.version, cases: results }, null, 1) + "\n");
  console.log(`\n${n - bad - unfinished}/${n - unfinished} cases identical to the baseline${bad ? ` — ${bad} DIFFER` : ""}${unfinished ? ` (${unfinished} more have no baseline answer: the old code did not finish them)` : ""}`);
  return { bad, n, unfinished, results };
}

if (require.main === module) main(process.argv.slice(2)).then((r) => process.exit(r.bad ? 1 : 0)).catch((err) => { console.error(err.stack || err.message); process.exit(1); });
module.exports = { main, check };
