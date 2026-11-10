#!/usr/bin/env node
/**
 * generate_dxf_parts.js — DXF parts for the quote-vetting library.
 *
 * Writes four DXF files into tools/vet-quotes/parts/ plus dxf_manifest.json,
 * which run_vetting.js merges into the part list. Each part records its
 * analytic truth (perimeters, area, holes) and names a STEP twin
 * (generate_dxf_twins.py, same profile extruded to the quoted thickness):
 * the harness quotes both and fails if the routed prices differ by more than
 * 2 %.
 *
 * Usage: node tools/vet-quotes/generate_dxf_parts.js [--out tools/vet-quotes/parts]
 */
const fs = require("fs");
const path = require("path");
const w = require("../../server/geometry/dxf/writer");

const i = process.argv.indexOf("--out");
const OUT = i >= 0 ? process.argv[i + 1] : path.join(__dirname, "parts");
const PI = Math.PI;
const cfg = (materialSlug, thicknessMm) => ({ process: "routing", materialSlug, subProcess: "sheet", thicknessMm, finishSlug: null, label: `routing:${materialSlug}@${thicknessMm}` });

const parts = [];
function add(id, text, meta) {
  fs.writeFileSync(path.join(OUT, `${id}.dxf`), text);
  const t = meta.thicknessMm;
  parts.push({
    id, file: `${id}.dxf`, twin: `${id}.step`, family: "flat-sheet", hand_sized: true, source: "dxf",
    bbox: [meta.w, meta.h, t], volume: meta.area * t,
    truth: {
      holes: meta.holes, slots: meta.slots || 0, pockets: 0, countersinks: 0,
      cut_perimeter_mm: meta.outer + meta.inner, outer_perimeter_mm: meta.outer, inner_perimeter_mm: meta.inner, area_mm2: meta.area,
      removed_mm3: (meta.w * meta.h - meta.area) * t,
    },
    description: meta.description, configs: meta.configs, expected: {}, reasoning: meta.reasoning,
  });
  console.log("wrote", path.join(OUT, `${id}.dxf`));
}

// 1. 150 × 100 plate, six Ø6.6 holes — the DXF of plate_hole_pattern.stl
{
  const holes = [-50, 0, 50].flatMap((x) => [-25, 25].map((y) => [75 + x, 50 + y]));
  add("dxf_plate_holes", w.dxf({ insunits: 4, measurement: 1, entities: [w.rect(0, 0, 150, 100), ...holes.map(([x, y]) => w.circle(x, y, 3.3))] }), {
    w: 150, h: 100, thicknessMm: 6.35, holes: 6, outer: 500, inner: 6 * PI * 6.6, area: 15000 - 6 * PI * 3.3 ** 2,
    description: "DXF: flat plate 150 × 100 with six Ø6.6 through holes (LWPOLYLINE + CIRCLE, mm). Same part as plate_hole_pattern.",
    reasoning: "Must price like plate_hole_pattern.stl and its STEP twin at 1/4\".",
    configs: [cfg("rt-hdpe", 6.35), cfg("rt-delrin", 6.35)],
  });
}
// 2. Slotted guide: R10 corners as a bulged polyline, 60 × 12 stadium slot, two Ø8.5 holes
add("dxf_slotted_guide", w.dxf({ insunits: 4, measurement: 1, entities: [w.roundRect(0, 0, 200, 80, 10), w.slot(100, 40, 60, 12), w.circle(25, 40, 4.25), w.circle(175, 40, 4.25)] }), {
  w: 200, h: 80, thicknessMm: 12.7, holes: 2, slots: 1, outer: 2 * (180 + 60) + 2 * PI * 10, inner: 2 * 48 + PI * 12 + 2 * PI * 8.5,
  area: 200 * 80 - (4 - PI) * 100 - (48 * 12 + PI * 36) - 2 * PI * 4.25 ** 2,
  description: "DXF: conveyor guide 200 × 80 with R10 corners (bulged LWPOLYLINE), a 60 × 12 adjustment slot and two Ø8.5 holes, quoted in 1/2\" UHMW.",
  reasoning: "Arcs via bulges; 1/2\" stock takes the 3/8\" tool in two passes.",
  configs: [cfg("rt-uhmw", 12.7), cfg("rt-hdpe", 12.7)],
});
// 3. L bracket with a square window: sharp inside corners force the 1/8" tool
add("dxf_bracket_window", w.dxf({ insunits: 4, measurement: 1, entities: [
  w.line(0, 0, 160, 0), w.line(160, 0, 160, 50), w.line(160, 50, 60, 50), w.line(60, 50, 60, 120), w.line(60, 120, 0, 120), w.line(0, 120, 0, 0), // outline as loose LINEs
  w.rect(15, 70, 30, 30), w.circle(30, 25, 4.5), w.circle(130, 25, 4.5),
] }), {
  w: 160, h: 120, thicknessMm: 9.5, holes: 2, outer: 560, inner: 120 + 2 * PI * 9, area: 160 * 50 + 60 * 70 - 900 - 2 * PI * 4.5 ** 2,
  description: "DXF: L bracket 160 × 120 drawn as six separate LINEs, with a square 30 × 30 window and two Ø9 holes, quoted in 3/8\" acetal.",
  reasoning: "Outline must chain from loose lines; the square window's corners select the 1/8\" tool (slower feed), same as the STEP.",
  configs: [cfg("rt-delrin", 9.5)],
});
// 4. Machine guard drawn in inches ($INSUNITS = 1): 6 × 4 in, four Ø0.25 in holes
{
  const k = 25.4;
  add("dxf_inch_guard", w.dxf({ insunits: 1, measurement: 0, entities: [w.rect(0, 0, 6, 4), ...[[0.5, 0.5], [5.5, 0.5], [0.5, 3.5], [5.5, 3.5]].map(([x, y]) => w.circle(x, y, 0.125))] }), {
    w: 6 * k, h: 4 * k, thicknessMm: 6.35, holes: 4, outer: 20 * k, inner: 4 * PI * 0.25 * k, area: (24 - 4 * PI * 0.125 ** 2) * k * k,
    description: "DXF drawn in inches: 6 × 4 in guard panel with four Ø1/4\" holes, quoted in 1/4\" polycarbonate and acrylic.",
    reasoning: "Units come from $INSUNITS; a wrong scale would be off by 25.4× and fail the parser checks.",
    configs: [cfg("rt-polycarbonate", 6.35), cfg("rt-acrylic", 6.35)],
  });
}

fs.writeFileSync(path.join(OUT, "dxf_manifest.json"), JSON.stringify({ units: "mm", parts }, null, 1) + "\n");
console.log("wrote", path.join(OUT, "dxf_manifest.json"));
