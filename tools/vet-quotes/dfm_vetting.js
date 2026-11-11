#!/usr/bin/env node
/**
 * dfm_vetting.js — run the 17 reference parts through the DFM rules, no server needed.
 *
 * Two passes per part × configuration:
 *   legacy  — the STL is parsed with the real parser (bounding box + mesh totals) and the
 *             rules run through the feature adapter (confidence "legacy"). This is what the
 *             site does today.
 *   truth   — a `features` object hand-built from manifest.json / the part description
 *             (hole sizes, pocket depth, bore, walls) at confidence 1.0. This is what the
 *             rules will see once the geometry module lands, and proves which rules fire.
 *
 * Writes a markdown table to stdout (pasted into docs/dfm-standards.md §Validation).
 *   node tools/vet-quotes/dfm_vetting.js [--only id,id] [--json]
 */
const fs = require("fs");
const path = require("path");
const { parseSTL } = require("../../server/parsers/fileParser");
const cnc = require("../../server/processes/cnc/dfm");
const routing = require("../../server/processes/routing/dfm");
const printing = require("../../server/processes/3d-printing/dfm");

const HERE = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "parts", "manifest.json"), "utf8"));
const only = (process.argv.find((a, i) => process.argv[i - 1] === "--only") || "").split(",").filter(Boolean);
const asJson = process.argv.includes("--json");

// ─── manifest-truth features (what the geometry module should measure) ─────────────────
const F = (p, extra) => {
  const [w, h, d] = p.bbox;
  const s = [w, h, d].slice().sort((a, b) => b - a);
  const thin = s[2];
  const base = {
    schemaVersion: 1, source: "stl",
    mesh: { triangles: 0, watertight: true, manifold: true, selfIntersections: false },
    aabb: { w, h, d }, obb: { w: s[0], h: s[1], d: s[2], axes: null },
    volume: p.volume, surfaceArea: null,
    shape: { kind: thin <= 25.4 && s[1] >= 2 * thin ? "flat" : "prismatic", primaryAxis: [0, 0, 1], is25D: true, stockThickness: thin <= 25.4 ? thin : null,
      profile: { area: p.volume / thin, perimeter: p.truth.cut_perimeter_mm, innerPerimeter: 0, bboxW: s[0], bboxH: s[1], minInternalRadius: null, minSlotWidth: null }, revolved: null },
    holes: [], pockets: [], slots: [], bosses: [], fillets: null, chamfers: null, text: null,
    walls: { minThickness: thin, p05Thickness: thin, thinAreaFraction: 0, tallThinMaxAspect: 1 },
    access: { directions: [[0, 0, 1], [0, 0, -1]], minSetups3Axis: 2, undercutAreaFraction: 0 },
    cornerRadii: { minInternalVertical: null, minInternalFloor: 0 },
    overhang: { areaFraction45: 0.05, maxAngleFromVertical: 90, supportVolumeEstimate: 0 },
    bridging: null,
    stock: { block: null, bar: null, sheet: null, removalVolumeBlock: null, removalRatioBlock: null },
    confidence: { holes: 1, pockets: 1, walls: 1, shape: 1, overall: 1 }, notes: ["manifest truth"],
  };
  return merge(base, extra || {});
};
function merge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k], b[k]) : b[k];
  return out;
}
const hole = (diameter, depth, extra = {}) => ({ diameter, depth, through: true, blind: false, axis: [0, 0, 1], center: [0, 0, 0], kind: "round", depthToDiaRatio: depth / diameter, ...extra });
const rev = (maxDiameter, length, boreDiameter, extra = {}) => ({ shape: { kind: "revolved", revolved: { axis: [0, 0, 1], maxDiameter, length, minDiameter: maxDiameter, boreDiameter, segments: 1 } }, walls: { minThickness: boreDiameter ? (maxDiameter - boreDiameter) / 2 : maxDiameter }, ...extra });

const TRUTH = {
  plate_hole_pattern: (p) => F(p, { holes: Array(6).fill(hole(6.6, 6.35)), shape: { profile: { minInternalRadius: null } } }),
  pocketed_tray: (p) => F(p, { pockets: [{ area: 170 * 120, depth: 12.7, floorArea: 170 * 120, openSides: 0, minCornerRadius: 6, depthToWidthRatio: 12.7 / Math.sqrt(170 * 120), accessAxis: [0, 0, 1] }], cornerRadii: { minInternalVertical: 6 }, walls: { minThickness: 6.35, tallThinMaxAspect: 2 } }),
  conveyor_guide_rail: (p) => F(p, { holes: Array(6).fill(hole(6.6, 12.7, { kind: "countersunk" })) }),
  wear_strip: (p) => F(p, { slots: Array(4).fill({ width: 7, length: 25, depth: 9.525, through: true }), shape: { profile: { minInternalRadius: 3.5, minSlotWidth: 7 } } }),
  star_wheel: (p) => F(p, { holes: [hole(25, 12.7)], shape: { profile: { minInternalRadius: 10 } } }),
  bracket_block: (p) => F(p, { holes: Array(4).fill(hole(5, 25, { kind: "tapped-candidate" })), pockets: [{ area: 50 * 24, depth: 10, floorArea: 50 * 24, openSides: 0, minCornerRadius: 5, depthToWidthRatio: 10 / 24, accessAxis: [0, 0, 1] }], cornerRadii: { minInternalVertical: 5 }, walls: { minThickness: 5, tallThinMaxAspect: 3 } }),
  saddle_clamp: (p) => F(p, { holes: Array(2).fill(hole(8.5, 40)), cornerRadii: { minInternalVertical: 16 }, walls: { minThickness: 9, tallThinMaxAspect: 4.4 } }),
  bushing: (p) => F(p, rev(40, 30, 25)),
  roller: (p) => F(p, rev(50, 200, 20)),
  spacer: (p) => F(p, rev(12, 6, 6.5)),
  thin_wall_housing: (p) => F(p, { pockets: [{ area: 115 * 75, depth: 37, floorArea: 115 * 75, openSides: 0, minCornerRadius: 3, depthToWidthRatio: 37 / Math.sqrt(115 * 75), accessAxis: [0, 0, 1] }], cornerRadii: { minInternalVertical: 3 }, walls: { minThickness: 2.5, thinAreaFraction: 0, tallThinMaxAspect: 40 / 2.5 }, bridging: null }),
  small_clip: (p) => F(p, { holes: [hole(3, 3)], walls: { minThickness: 3.5 } }),
  gear_disc: (p) => F(p, { holes: [hole(12, 10)], shape: { profile: { minInternalRadius: 1.0, minSlotWidth: 4 } }, walls: { minThickness: 3 } }),
  oversize_panel: (p) => F(p, { holes: Array(4).fill(hole(10, 12.7)) }),
  cube_20mm: (p) => F(p, {}),
  drill_fixture_plate: (p) => F(p, { holes: Array(20).fill(hole(8, 12.7)), walls: { minThickness: 12.7 } }),
  seal_ring_peek: (p) => F(p, rev(60, 8, 45)),
};

function materialOpts(cfg) {
  const slug = cfg.materialSlug.replace(/\(.*\)|\+.*$/, "");
  const metal = /aluminum|brass|steel|stainless/.test(slug);
  return { materialSlug: slug, materialType: metal ? "metal" : "plastic" };
}
function runOne(process, geometry, cfg) {
  const opts = { ...materialOpts(cfg), subProcess: cfg.subProcess, thicknessMm: cfg.thicknessMm || undefined };
  if (process === "cnc") return cnc.run(geometry, opts);
  if (process === "routing") return routing.run(geometry, opts);
  return printing.run(geometry, { ...opts, subProcess: cfg.subProcess || cfg.materialSlug.split("-")[0] });
}
function summarise(r) {
  const fails = r.checks.filter((c) => c.severity === "fail").map((c) => c.id);
  const warns = r.checks.filter((c) => c.severity === "warn").map((c) => `${c.id}${c.cost === "major" ? "†" : ""}`);
  return { ok: r.summary.manufacturable, score: r.summary.score, fails, warns };
}

const rows = [];
for (const part of manifest.parts) {
  if (only.length && !only.includes(part.id)) continue;
  const geometry = parseSTL(fs.readFileSync(path.join(HERE, "parts", `${part.id}.stl`)));
  const truth = TRUTH[part.id] ? { features: TRUTH[part.id](part) } : null;
  const seen = new Set();
  for (const cfg of part.configs) {
    const proc = cfg.process;
    const subKey = `${proc}:${cfg.subProcess}:${materialOpts(cfg).materialSlug}`;
    if (seen.has(subKey)) continue;
    seen.add(subKey);
    // turned parts: also run the turning sub-process the shop would actually use
    const cfgs = [cfg];
    if (part.family === "turned" && proc === "cnc" && cfg.subProcess === "milling" && !cfg.label.includes("milling-for-comparison")) cfgs.push({ ...cfg, subProcess: "turning" });
    for (const c of cfgs) {
      const legacy = summarise(runOne(proc, geometry, c));
      const tr = truth ? summarise(runOne(proc, truth, c)) : null;
      rows.push({ part: part.id, config: `${proc}:${c.subProcess}:${materialOpts(c).materialSlug}`, legacy, truth: tr });
    }
  }
}

if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const fmt = (s) => s ? `${s.ok ? "ok" : "**BLOCK**"} ${s.score}% ${s.fails.length ? `fail: ${s.fails.join(", ")}; ` : ""}${s.warns.length ? `warn: ${s.warns.join(", ")}` : "—"}` : "n/a";
console.log("| Part | Config | Legacy adapter (today) | Manifest-truth features |");
console.log("|---|---|---|---|");
for (const r of rows) console.log(`| ${r.part} | ${r.config} | ${fmt(r.legacy)} | ${fmt(r.truth)} |`);
console.log("\n† = cost hint `major`");
