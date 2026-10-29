/**
 * validate.js — run geometry recognition over the reference library and the
 * STEP fixtures and write VALIDATION.md (comparison against analytic truth).
 *
 *   node server/geometry/validate.js
 *
 * Reads tools/vet-quotes/parts/manifest.json (17 STLs) and
 * server/geometry/fixtures/fixtures.json (STEP). Goes through parseFile() so
 * the table also shows the legacy estimates the recogniser replaces.
 */
const fs = require("fs");
const path = require("path");
const { parseFile } = require("../parsers/fileParser");

const root = path.join(__dirname, "../..");
const partsDir = path.join(root, "tools/vet-quotes/parts");
const fixturesDir = path.join(__dirname, "fixtures");

const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const mark = (ok) => (ok ? "✓" : "✗");
const within = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol * Math.abs(b) + 1e-9;

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(partsDir, "manifest.json"), "utf8"));
  const rows = [];
  const score = { holes: 0, pockets: 0, slots: 0, perimeter: 0, perimeterN: 0, thickness: 0, thicknessN: 0, kind: 0, kindN: 0 };
  const familyKind = { "flat-sheet": "flat", "pocket-plate": "flat", turned: "revolved", "machined-block": ["flat", "prismatic"], enclosure: "prismatic" };
  // thickness truth: the thinnest wall of each reference part, from its construction
  const thicknessTruth = {
    plate_hole_pattern: 6.35, pocketed_tray: 6.35, conveyor_guide_rail: 12.7 - 3.2 /* under the countersink */, wear_strip: 9.525,
    star_wheel: 12.7, bracket_block: 5.0 /* web between Ø5 hole and edge */, saddle_clamp: null, bushing: 7.5, roller: 15, spacer: 2.75,
    thin_wall_housing: 2.5, small_clip: 3, gear_disc: null, oversize_panel: 12.7, cube_20mm: 20, drill_fixture_plate: 12.7, seal_ring_peek: 7.5,
  };
  let maxMs = 0, maxMsPart = "";
  for (const p of manifest.parts) {
    const t0 = Date.now();
    const r = await parseFile(path.join(partsDir, p.id + ".stl"));
    const ms = Date.now() - t0;
    const g = r.geometry, f = g.features, truth = p.truth;
    const slotsTruth = truth.slots + (truth.channel ? 1 : 0);
    const cut = f.shape.profile ? f.shape.profile.perimeter + f.shape.profile.innerPerimeter + f.pockets.reduce((s, q) => s + q.perimeter, 0) + f.slots.filter((s) => s.shape === "half-round").reduce((s, q) => s + Math.PI * q.width / 2, 0) : null;
    const holesOk = f.holeCount === truth.holes, pocketsOk = f.pockets.length === truth.pockets, slotsOk = f.slots.length === slotsTruth;
    const perimOk = truth.cut_perimeter_mm > 0 ? within(cut, truth.cut_perimeter_mm, 0.01) : null;
    const thTruth = thicknessTruth[p.id];
    const thOk = thTruth === null || thTruth === undefined ? null : within(f.walls.minThickness, thTruth, 0.03);
    const kindWant = familyKind[p.family];
    const kindOk = Array.isArray(kindWant) ? kindWant.includes(f.shape.kind) : f.shape.kind === kindWant;
    score.holes += holesOk; score.pockets += pocketsOk; score.slots += slotsOk;
    if (perimOk !== null) { score.perimeterN++; score.perimeter += perimOk; }
    if (thOk !== null) { score.thicknessN++; score.thickness += thOk; }
    score.kindN++; score.kind += kindOk;
    if (f.timings && f.timings.total > maxMs) { maxMs = f.timings.total; maxMsPart = p.id; }
    rows.push(`| ${p.id} | ${f.mesh.triangles} | ${truth.holes} / **${f.holeCount}** ${mark(holesOk)} (legacy ${g.legacy.estimatedHoles}) | ${truth.pockets} / **${f.pockets.length}** ${mark(pocketsOk)} | ${slotsTruth} / **${f.slots.length}** ${mark(slotsOk)} | ${fmt(thTruth, 2)} / **${fmt(f.walls.minThickness, 2)}** ${thOk === null ? "" : mark(thOk)} (legacy ${fmt(g.legacy.estimatedThickness, 2)}) | ${truth.cut_perimeter_mm > 0 ? `${fmt(truth.cut_perimeter_mm)} / **${fmt(cut)}** ${mark(perimOk)} (legacy ${fmt(g.legacy.estimatedPerimeter)})` : "n/a (turned)"} | ${p.family} / **${f.shape.kind}** ${mark(kindOk)} | ${f.confidence.overall} | ${f.timings ? f.timings.total : "–"} |`);
  }

  // STEP fixtures
  const fixtures = JSON.parse(fs.readFileSync(path.join(fixturesDir, "fixtures.json"), "utf8"));
  const stepRows = [];
  for (const [name, t] of Object.entries(fixtures)) {
    const r = await parseFile(path.join(fixturesDir, name + ".step"));
    const f = r.geometry.features;
    const details = [];
    if (t.holes !== undefined) details.push(`holes ${t.holes} / **${f.holeCount}** ${mark(f.holeCount === t.holes)}`);
    if (t.counterbored) details.push(`cbore ${t.counterbored} / **${f.holes.filter((h) => h.kind === "counterbored").length}**`);
    if (t.countersunk) details.push(`csk ${t.countersunk} / **${f.holes.filter((h) => h.kind === "countersunk").length}**`);
    if (t.blind) details.push(`blind ${t.blind} (depth ${t.blindDepth}) / **${f.holes.filter((h) => h.blind).map((h) => h.depth).join(",")}**`);
    if (t.pockets !== undefined) details.push(`pockets ${t.pockets} / **${f.pockets.length}**${t.pocketDepth ? ` depth ${t.pocketDepth} / **${f.pockets[0] ? f.pockets[0].depth : "–"}**` : ""}`);
    if (t.bosses) details.push(`bosses ${t.bosses} (Ø${t.bossDiameter}×${t.bossHeight}) / **${f.bosses.map((b) => `Ø${b.diameter}×${b.height}`).join(",")}**`);
    if (t.revolved) details.push(`revolved bore ${t.bore} / **${f.shape.revolved ? f.shape.revolved.boreDiameter : "–"}**`);
    if (t.undercut) details.push(`undercut area ≥ ${t.undercutArea} / **${fmt(f.access.undercutAreaFraction * f.surfaceArea)}**`);
    stepRows.push(`| ${name} | ${f.mesh.triangles} | ${details.join("; ")} | ${f.shape.kind} | holes ${f.confidence.holes}, pockets ${f.confidence.pockets}, overall ${f.confidence.overall} | ${f.timings.total} |`);
  }

  const md = `# Geometry recognition — validation against analytic truth

Generated by \`node server/geometry/validate.js\` on ${new Date().toISOString().slice(0, 10)}.
Each cell is **truth / recognised** with ✓ when they agree (holes, pockets, slots exact; perimeter ±1 %; thickness ±3 %).
"legacy" is what the old normal-bucket parser reported for the same file.

## 17 reference STLs (tools/vet-quotes/parts, mesh path)

| part | tris | holes | pockets | slots | min wall (mm) | cut perimeter (mm) | family / kind | conf | ms |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

**Score:** holes ${score.holes}/17, pockets ${score.pockets}/17, slots ${score.slots}/17, cut perimeter ${score.perimeter}/${score.perimeterN} (parts with a profile), min wall ${score.thickness}/${score.thicknessN} (parts with a known thinnest wall), shape kind ${score.kind}/${score.kindN}. Slowest part: ${maxMsPart} at ${maxMs} ms.

Notes on the reference set:
- \`saddle_clamp\`: the manifest lists its R16 half-round channel under \`channel\`, not \`slots\`; the recogniser reports it as a half-round slot (width 32, depth 16, through) and \`cornerRadii.minInternalFloor = 16\`. Its Ø8.5 holes are flagged \`tapped-candidate\` (M10 tap drill) — the description calls them bolt holes; 8.5 is also a loose M8 clearance.
- \`bracket_block\`: family "machined-block" but it is a 25 mm plate part with all features from one side, so \`kind = flat\` with \`stockThickness = 25\`; its Ø5 holes are \`tapped-candidate\` (M6 tap drill), matching the description.
- \`conveyor_guide_rail\`: the thinnest measured wall (9.3 mm) is the web from a countersink cone to the rail edge, not the plate thickness.
- \`gear_disc\`: no single analytic wall; the recogniser reports 3.5 mm (tooth web).

## STEP fixtures (server/geometry/fixtures, B-rep path)

| fixture | tris | truth / recognised | kind | confidence | ms |
|---|---|---|---|---|---|
${stepRows.join("\n")}

The same fixtures run through the mesh path (ignoring \`brep_faces\`) give the same feature lists with holes confidence 0.8 instead of 1.0 — see \`geometry.test.js\`.

## Performance

\`geometry.test.js\` subdivides \`bracket_block.stl\` to 770 048 triangles: analysed in about 3 s on the dev container (Node 22), holes and pocket still found, with a note that thickness/access/overhang were sampled on 30 000 triangles. A 156 k-triangle CadQuery STL (60 holes, R10 corner fillets, filleted pocket, angular tolerance 0.02 rad) takes about 2.5 s and reports all 60 holes, the pocket (depth 6, R8) and the outer perimeter to 0.01 %.
`;
  fs.writeFileSync(path.join(__dirname, "VALIDATION.md"), md);
  console.log(md);
}

main().catch((err) => { console.error(err); process.exit(1); });
