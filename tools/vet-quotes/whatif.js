#!/usr/bin/env node
/**
 * whatif.js — re-price the last vetting run OFFLINE with different pricing rules.
 *
 * Reads tools/vet-quotes/results.json (geometry the server parsed for each part)
 * and parts/manifest.json (configs + shop estimates), then calls the engine's
 * own pricing modules (server/processes/<slug>/pricing.js) directly with
 * DEFAULT_PRICING_RULES plus your overrides. Nothing is written to the engine
 * and no server is needed. Use it to see what a knob change does to every
 * part before touching the admin pricing page.
 *
 * Usage:
 *   node tools/vet-quotes/whatif.js --set cncMinimumMachineTime=0.1 --set cncToolingCostBase=1.5
 *   node tools/vet-quotes/whatif.js --rules my-rules.json          # JSON object of overrides
 *   node tools/vet-quotes/whatif.js --set routerFeedMmPerMin.soft=3000 --qty 10 --process routing
 *
 * Nested keys use dots (routerFeedMmPerMin.soft). Output: one line per quote
 * (base → what-if, and both as a ratio of the shop estimate), then the median
 * engine÷estimate ratio per process before and after.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const { DEFAULT_PRICING_RULES, DEFAULT_MATERIALS, DEFAULT_FINISHES } = require(path.join(ROOT, "server/config/defaults"));
const pricing = {
  cnc: require(path.join(ROOT, "server/processes/cnc/pricing")),
  routing: require(path.join(ROOT, "server/processes/routing/pricing")),
  "3d-printing": require(path.join(ROOT, "server/processes/3d-printing/pricing")),
};

const argv = process.argv.slice(2);
const sets = [];
let rulesFile = null, onlyQty = null, onlyProcess = null, onlyPart = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--set") sets.push(argv[++i]);
  else if (argv[i] === "--rules") rulesFile = argv[++i];
  else if (argv[i] === "--qty") onlyQty = Number(argv[++i]);
  else if (argv[i] === "--process") onlyProcess = argv[++i];
  else if (argv[i] === "--part") onlyPart = argv[++i];
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] = cur[k] ?? {};
  const last = keys[keys.length - 1];
  const n = Number(value);
  cur[last] = Number.isFinite(n) && value !== "" ? n : value;
}

const base = DEFAULT_PRICING_RULES;
const whatif = deepClone(DEFAULT_PRICING_RULES);
if (rulesFile) {
  const o = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
  for (const [k, v] of Object.entries(o)) typeof v === "object" && !Array.isArray(v) ? Object.assign(whatif[k] = whatif[k] || {}, v) : (whatif[k] = v);
}
for (const s of sets) { const [k, v] = s.split("="); setPath(whatif, k, v); }

const results = JSON.parse(fs.readFileSync(path.join(__dirname, "results.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "parts", "manifest.json"), "utf8"));
const partById = Object.fromEntries(manifest.parts.map((p) => [p.id, p]));
const matBySlug = Object.fromEntries(DEFAULT_MATERIALS.map((m) => [m.slug, m]));
const finBySlug = Object.fromEntries(DEFAULT_FINISHES.map((f) => [f.slug, f]));

function geometryFor(partId) {
  const g = results.parsedByPart[partId];
  return {
    boundingBox: { width: g.bbox[0], height: g.bbox[1], depth: g.bbox[2] },
    volume: g.volume, surfaceArea: g.surfaceArea, estimatedThickness: g.estimatedThickness,
    flatWidth: g.flatWidth, flatHeight: g.flatHeight, flatArea: g.flatWidth * g.flatHeight,
    estimatedPerimeter: g.estimatedPerimeter, estimatedHoles: g.estimatedHoles, estimatedSlots: g.estimatedSlots, estimatedBends: g.estimatedBends,
  };
}
function priceWith(rules, row) {
  const mat = matBySlug[row.material];
  const fin = row.finish ? finBySlug[row.finish] : null;
  const params = {
    geometry: geometryFor(row.part), material: mat, grade: mat.grades?.[0]?.name, finish: fin,
    quantity: row.qty, subProcess: row.subProcess, thicknessMm: Number(row.thicknessMm) || 0, totalPartsInOrder: 1,
  };
  return pricing[row.process].calculate(params, rules);
}

const money = (v) => `$${Number(v).toFixed(2)}`;
const rows = results.rows.filter((r) => (!onlyQty || r.qty === onlyQty) && (!onlyProcess || r.process === onlyProcess) && (!onlyPart || r.part === onlyPart));
const ratios = { base: {}, whatif: {} };
console.log(`Overrides: ${JSON.stringify(Object.fromEntries(Object.keys(whatif).filter((k) => JSON.stringify(whatif[k]) !== JSON.stringify(base[k])).map((k) => [k, whatif[k]])))}\n`);
console.log(`${"part".padEnd(22)} ${"configuration".padEnd(40)} qty   base   →  what-if   | time base → what-if | est.mid  base÷est → whatif÷est`);
for (const r of rows) {
  const a = priceWith(base, r), b = priceWith(whatif, r);
  const t = (p) => p.meta.machineTimeHours != null ? `${(p.meta.machineTimeHours * 60).toFixed(1)}m` : p.meta.cycleMinutes != null ? `${p.meta.cycleMinutes}m` : `${p.meta.printTimeHours.toFixed(2)}h`;
  const est = Number(r.expectedMid) || null;
  const ra = est ? a.perUnit.final / est : null, rb = est ? b.perUnit.final / est : null;
  if (est) { (ratios.base[r.process] = ratios.base[r.process] || []).push(ra); (ratios.whatif[r.process] = ratios.whatif[r.process] || []).push(rb); }
  console.log(`${r.part.padEnd(22)} ${r.label.padEnd(40)} ${String(r.qty).padStart(3)} ${money(a.perUnit.final).padStart(8)} → ${money(b.perUnit.final).padStart(8)}  | ${t(a).padStart(7)} → ${t(b).padStart(7)} | ${est ? money(est).padStart(8) : "        "}  ${ra ? ra.toFixed(2).padStart(5) : "     "} → ${rb ? rb.toFixed(2).padStart(5) : ""}`);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
console.log(`\nmedian engine ÷ shop-estimate (qty 1/10/25 rows with an estimate):`);
for (const p of Object.keys(ratios.base)) {
  const fb = ratios.base[p].filter((_, i) => [1, 10, 25].includes(rows.filter((r) => r.process === p && r.expectedMid)[i]?.qty));
  const fw = ratios.whatif[p].filter((_, i) => [1, 10, 25].includes(rows.filter((r) => r.process === p && r.expectedMid)[i]?.qty));
  console.log(`  ${p.padEnd(12)} base ×${median(fb).toFixed(2)}  →  what-if ×${median(fw).toFixed(2)}   (spread base ${Math.min(...fb).toFixed(2)}–${Math.max(...fb).toFixed(2)}, what-if ${Math.min(...fw).toFixed(2)}–${Math.max(...fw).toFixed(2)})`);
}
