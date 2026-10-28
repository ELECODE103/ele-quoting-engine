/**
 * Geometry recognition tests (no framework). Run: `node server/geometry/geometry.test.js`
 *
 * Every assertion is against a synthetic part whose true value is known
 * analytically (testMesh.js), the 17 reference STLs in tools/vet-quotes/parts
 * (manifest.json truth), and the STEP fixtures in ./fixtures (fixtures.json).
 * Set GEOMETRY_SKIP_PERF=1 to skip the 500k-triangle timing test.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { analyzeGeometry } = require("./index");
const T = require("./testMesh");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${what || ""} expected ${b} ±${tol * 100}% got ${a}`);
const stl = (positions, extra) => analyzeGeometry(Object.assign({ positions, source: "stl" }, extra || {}));

function readSTL(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  const pos = new Float64Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) { o += 12; for (let k = 0; k < 9; k++) { pos[i * 9 + k] = buf.readFloatLE(o); o += 4; } o += 2; }
  return pos;
}

console.log("Geometry — synthetic parts");

test("20 mm cube: everything trivial and confident", () => {
  const f = stl(T.buildBox(20, 20, 20));
  assert.strictEqual(f.mesh.watertight, true);
  assert.strictEqual(f.mesh.manifold, true);
  assert.strictEqual(f.mesh.selfIntersections, false);
  near(f.volume, 8000, 1e-6, "volume"); near(f.surfaceArea, 2400, 1e-6, "area");
  assert.deepStrictEqual([f.aabb.w, f.aabb.h, f.aabb.d], [20, 20, 20]);
  assert.deepStrictEqual([f.obb.w, f.obb.h, f.obb.d], [20, 20, 20]);
  assert.strictEqual(f.holes.length, 0); assert.strictEqual(f.pockets.length, 0); assert.strictEqual(f.slots.length, 0); assert.strictEqual(f.bosses.length, 0);
  assert.strictEqual(f.shape.is25D, true); assert.strictEqual(f.shape.kind, "prismatic"); assert.strictEqual(f.shape.revolved, null);
  near(f.shape.profile.perimeter, 80, 1e-6); near(f.shape.profile.area, 400, 1e-6); assert.strictEqual(f.shape.profile.innerPerimeter, 0);
  near(f.walls.minThickness, 20, 1e-6); assert.strictEqual(f.walls.thinAreaFraction, 0);
  assert.strictEqual(f.access.undercutAreaFraction, 0); assert.strictEqual(f.access.minSetups3Axis, 2);
  assert.strictEqual(f.overhang.areaFraction45, 0); assert.strictEqual(f.overhang.supportVolumeEstimate, 0);
  assert.deepStrictEqual(f.stock.block, { w: 26, h: 26, d: 26, volume: 26 ** 3 });
  near(f.stock.removalVolumeBlock, 26 ** 3 - 8000, 1e-6);
  assert.ok(f.confidence.overall >= 0.8, `overall ${f.confidence.overall}`);
  assert.ok(f.confidence.shape >= 0.9);
});

test("plate with 6 holes of three diameters: count, diameters ±2%, through, depth, perimeters exact", () => {
  const W = 150, H = 100, Th = 6.35;
  const xs = [0, 50, 100, 150], ys = [0, 50, 100];
  const dias = { "0,0": 6.6, "1,0": 8.0, "2,0": 10.0, "0,1": 6.6, "1,1": 8.0, "2,1": 10.0 };
  const feats = {};
  for (const k of Object.keys(dias)) { const [ix, iy] = k.split(",").map(Number); feats[k] = { kind: "hole", loop: T.circle(dias[k] / 2, 40, xs[ix] + 25, ys[iy] + 25) }; }
  const { positions, truth } = T.buildPlate(W, H, Th, xs, ys, feats);
  const f = stl(positions);
  assert.strictEqual(f.holes.length, 6);
  assert.strictEqual(f.holeCount, 6);
  const got = f.holes.map((h) => h.diameter).sort((a, b) => a - b);
  const want = Object.values(dias).sort((a, b) => a - b);
  got.forEach((d, i) => near(d, want[i], 0.02, "diameter"));
  for (const h of f.holes) { assert.strictEqual(h.through, true); assert.strictEqual(h.blind, false); near(h.depth, Th, 0.01, "depth"); near(Math.abs(h.axis[2]), 1, 1e-3); assert.strictEqual(h.kind, "round"); }
  assert.strictEqual(f.shape.kind, "flat"); assert.strictEqual(f.shape.is25D, true); near(f.shape.stockThickness, Th, 1e-6);
  near(f.shape.profile.perimeter, 2 * (W + H), 1e-6, "outer perimeter");
  near(f.shape.profile.innerPerimeter, truth.cutPerimeter - 2 * (W + H), 1e-4, "inner perimeter");
  assert.strictEqual(f.shape.profile.cutoutCount, 6);
  near(f.shape.profile.area, W * H - Object.values(dias).reduce((s, d) => s + Math.PI * (d / 2) ** 2, 0), 0.002, "profile area");
  assert.ok(f.stock.sheet && Math.abs(f.stock.sheet.thickness - Th) < 1e-6);
  near(f.walls.minThickness, Th, 1e-3, "plate thickness");
  assert.ok(f.confidence.holes <= 0.8 && f.confidence.holes >= 0.6, "STL holes confidence ≤ 0.8");
});

test("blind hole, counterbore and countersink are classified with their dimensions", () => {
  const W = 120, H = 40, Th = 10;
  const xs = [0, 40, 80, 120], ys = [0, 40];
  const feats = {
    "0,0": { kind: "blind", loop: T.circle(2.5, 32, 20, 20), depth: 6 },
    "1,0": { kind: "cbore", loop: T.circle(3.3, 32, 60, 20), loopTop: T.circle(5.5, 32, 60, 20), depth: 4 },
    "2,0": { kind: "csk", loop: T.circle(3.3, 32, 100, 20), loopTop: T.circle(6.5, 32, 100, 20), depth: 3.2 },
  };
  const f = stl(T.buildPlate(W, H, Th, xs, ys, feats).positions);
  assert.strictEqual(f.holes.length, 3, JSON.stringify(f.holes));
  const blind = f.holes.find((h) => h.blind);
  assert.ok(blind, "blind hole found"); near(blind.diameter, 5, 0.02); near(blind.depth, 6, 0.02); assert.strictEqual(blind.through, false);
  const cb = f.holes.find((h) => h.kind === "counterbored");
  assert.ok(cb, "counterbore found"); near(cb.diameter, 6.6, 0.02); near(cb.counterbore.diameter, 11, 0.02); near(cb.counterbore.depth, 4, 0.02); assert.strictEqual(cb.through, true); near(cb.depth, Th, 0.01);
  const csk = f.holes.find((h) => h.kind === "countersunk");
  assert.ok(csk, "countersink found"); near(csk.diameter, 6.6, 0.02); near(csk.countersink.diameter, 13, 0.02); near(csk.countersink.angleDeg, 90, 0.05); assert.strictEqual(csk.through, true);
  assert.strictEqual(f.pockets.length, 0, "hole floors are not pockets");
});

test("tube Ø40/Ø25 × 60: revolved with bore, one through hole, bar stock", () => {
  const f = stl(T.buildRing(T.circle(20, 64), T.circle(12.5, 48), 60));
  assert.strictEqual(f.shape.kind, "revolved");
  assert.ok(f.shape.revolved);
  near(f.shape.revolved.maxDiameter, 40, 0.01); near(f.shape.revolved.boreDiameter, 25, 0.02); near(f.shape.revolved.length, 60, 1e-6);
  near(Math.abs(f.shape.revolved.axis[2]), 1, 1e-3);
  assert.strictEqual(f.holes.length, 1); near(f.holes[0].diameter, 25, 0.02); near(f.holes[0].depth, 60, 0.01); assert.strictEqual(f.holes[0].through, true);
  assert.ok(f.stock.bar); near(f.stock.bar.diameter, 46, 0.01); near(f.stock.bar.length, 66, 1e-6);
  near(f.walls.minThickness, 7.5, 0.02, "wall");
  assert.strictEqual(f.bosses.length, 0);
});

test("pocketed tray: one pocket with depth and floor area ±5%, closed, corner radius", () => {
  const W = 200, H = 150, Th = 19.05;
  const loop = T.roundedRect(170, 120, 6, 8, 100, 75);
  const { positions, truth } = T.buildPlate(W, H, Th, [0, W], [0, H], { "0,0": { kind: "pocket", loop, depth: 12.7 } });
  const f = stl(positions);
  assert.strictEqual(f.pockets.length, 1, JSON.stringify(f.pockets));
  const p = f.pockets[0];
  near(p.depth, 12.7, 0.05, "depth"); near(p.floorArea, truth.pocketArea, 0.05, "floor area"); near(p.area, truth.pocketArea, 0.05, "area");
  assert.strictEqual(p.openSides, 0); near(p.minCornerRadius, 6, 0.1, "corner radius"); near(Math.abs(p.accessAxis[2]), 1, 1e-3);
  near(p.perimeter, T.perimeter(loop), 0.01, "pocket perimeter");
  near(f.cornerRadii.minInternalVertical, 6, 0.1); assert.strictEqual(f.cornerRadii.minInternalFloor, 0);
  assert.strictEqual(f.holes.length, 0);
  near(f.walls.minThickness, Th - 12.7, 0.01, "floor thickness");
});

test("U-clamp (channel extrusion): is25D along the extrusion axis, internal radius and channel width", () => {
  // XZ profile: 80 wide, 40 tall, channel 40 wide x 25 deep with R5 bottom corners, CCW
  const r = 5, arc = (cx, cz, a0, a1, n) => { const o = []; for (let k = 0; k <= n; k++) { const t = a0 + (a1 - a0) * (k / n); o.push([cx + r * Math.cos(t), cz + r * Math.sin(t)]); } return o; };
  const prof = [[-40, 0], [40, 0], [40, 40], [20, 40], [20, 15 + r]]
    .concat(arc(20 - r, 15 + r, 0, -Math.PI / 2, 8).slice(1))
    .concat([[-20 + r, 15]])
    .concat(arc(-20 + r, 15 + r, -Math.PI / 2, -Math.PI, 8).slice(1))
    .concat([[-20, 40], [-40, 40]]);
  const f = stl(T.extrudeProfileY(prof, 100));
  assert.strictEqual(f.shape.is25D, true);
  near(Math.abs(f.shape.primaryAxis[1]), 1, 1e-3, "primary axis is Y");
  assert.strictEqual(f.shape.kind, "prismatic");
  near(f.shape.profile.minInternalRadius, 5, 0.1, "internal radius");
  near(f.shape.profile.minSlotWidth, 40, 0.02, "channel width");
  assert.strictEqual(f.holes.length, 0);
  assert.strictEqual(f.access.undercutAreaFraction, 0);
});

test("thin-wall box: wall thickness ±10% and tall-thin aspect", () => {
  const W = 120, H = 80, Th = 40, wall = 2, floor = 3;
  const loop = T.roundedRect(W - 2 * wall, H - 2 * wall, 4, 8, W / 2, H / 2);
  const f = stl(T.buildPlate(W, H, Th, [0, W], [0, H], { "0,0": { kind: "pocket", loop, depth: Th - floor } }).positions);
  near(f.walls.minThickness, wall, 0.1, "min wall");
  near(f.walls.p05Thickness, wall, 0.1, "p05");
  assert.strictEqual(f.walls.thinAreaFraction, 0);
  // the worst "wall" is the 3 mm floor spanning 80 mm (span / thickness), ahead of the 37 mm tall 2 mm walls
  near(f.walls.tallThinMaxAspect, Math.max((Th - floor) / wall, H / floor), 0.1, "aspect");
  assert.strictEqual(f.pockets.length, 1); near(f.pockets[0].depth, Th - floor, 0.01);
  assert.strictEqual(f.shape.kind, "prismatic");
});

test("closed T-slot block: undercut area > 0, bridging span and support volume", () => {
  const f = stl(T.buildTSlotBlock(60, 60, 30, 10, 30, 8, 20, 40, 8));
  assert.strictEqual(f.mesh.watertight, true);
  near(f.surfaceArea, 17000, 1e-6); near(f.volume, 108000 - 10 * 30 * 8 - 20 * 40 * 8, 1e-6);
  assert.ok(f.access.undercutAreaFraction > 0, "undercut");
  // the ceiling (20 x 40 - 10 x 30 = 500 mm²) is unreachable from every axis direction
  assert.ok(f.access.undercutAreaFraction * f.surfaceArea >= 500 * 0.95, `undercut area ${f.access.undercutAreaFraction * f.surfaceArea}`);
  assert.ok(f.bridging && Math.abs(f.bridging.maxSpan - 20) < 1e-6, "bridging span = ceiling extent");
  near(f.overhang.supportVolumeEstimate, 500 * 8, 0.05, "support volume under the ceiling");
  assert.ok(f.overhang.areaFraction45 > 0);
  assert.strictEqual(f.pockets.length, 0, "a covered cavity is not a pocket");
});

test("features survive JSON serialisation and stay small; no mesh data inside", () => {
  const f = stl(T.buildPlate(100, 60, 10, [0, 50, 100], [0, 60], { "0,0": { kind: "hole", loop: T.circle(4, 32, 25, 30) } }).positions);
  const json = JSON.stringify(f);
  const back = JSON.parse(json);
  assert.strictEqual(back.holes.length, 1);
  assert.strictEqual(back.schemaVersion, 1);
  assert.ok(json.length < 16 * 1024, `features json ${json.length} bytes`);
  assert.ok(!("meshData" in back) && !("positions" in back));
  for (const k of ["mesh", "aabb", "obb", "volume", "surfaceArea", "shape", "holes", "pockets", "slots", "bosses", "fillets", "chamfers", "walls", "access", "cornerRadii", "overhang", "stock", "confidence", "notes"]) assert.ok(k in back, `missing ${k}`);
  assert.strictEqual(back.text, null);
});

test("degenerate input does not throw", () => {
  const f = analyzeGeometry({ positions: new Float64Array(0), source: "stl" });
  assert.strictEqual(f.holes.length, 0);
  assert.ok(f.notes.length > 0);
  assert.strictEqual(f.confidence.overall, 0);
});

// ── Reference library ──
console.log("Geometry — 17 reference parts (tools/vet-quotes/parts)");
const partsDir = path.join(__dirname, "../../tools/vet-quotes/parts");
const manifest = JSON.parse(fs.readFileSync(path.join(partsDir, "manifest.json"), "utf8"));
const refResults = [];
for (const p of manifest.parts) {
  test(`${p.id}: holes=${p.truth.holes} slots=${p.truth.slots} pockets=${p.truth.pockets}`, () => {
    const f = stl(readSTL(path.join(partsDir, p.id + ".stl")));
    refResults.push({ part: p, f });
    assert.strictEqual(f.holes.length, p.truth.holes, `holes ${f.holes.length}`);
    // manifest "slots" counts stadium through-slots; a half-round channel is reported as a slot too
    assert.strictEqual(f.slots.length, p.truth.slots + (p.truth.channel ? 1 : 0), `slots ${JSON.stringify(f.slots)}`);
    assert.strictEqual(f.pockets.length, p.truth.pockets, `pockets ${JSON.stringify(f.pockets)}`);
    if (p.truth.countersinks) assert.strictEqual(f.holes.filter((h) => h.kind === "countersunk").length, p.truth.countersinks);
    near(f.volume, p.volume, 1e-3, "volume"); // manifest volumes are analytic; meshes are polygonal
    if (p.truth.cut_perimeter_mm > 0) {
      const cut = f.shape.profile.perimeter + f.shape.profile.innerPerimeter + f.pockets.reduce((s, q) => s + q.perimeter, 0) + f.slots.filter((s) => s.shape === "half-round").reduce((s, q) => s + Math.PI * q.width / 2, 0);
      near(cut, p.truth.cut_perimeter_mm, 0.01, "cut perimeter");
    }
    if (p.family === "turned") { assert.strictEqual(f.shape.kind, "revolved"); assert.ok(f.stock.bar); }
    if (p.family === "flat-sheet") assert.strictEqual(f.shape.kind, "flat");
  });
}

test("reference thickness: thin-wall housing 2.5 mm walls, plate 6.35, cube 20", () => {
  const by = (id) => refResults.find((r) => r.part.id === id).f;
  near(by("thin_wall_housing").walls.minThickness, 2.5, 0.05);
  near(by("plate_hole_pattern").walls.minThickness, 6.35, 0.01);
  near(by("cube_20mm").walls.minThickness, 20, 0.01);
  near(by("bushing").walls.minThickness, 7.5, 0.02);
  near(by("bracket_block").walls.minThickness, 5.0, 0.02); // web between Ø5 hole and the block edge
});

// ── Performance ──
if (!process.env.GEOMETRY_SKIP_PERF) {
  test("500k+ triangles analysed in under 10 s with downsampling noted", () => {
    let pos = readSTL(path.join(partsDir, "bracket_block.stl"));
    const subdivide = (p) => {
      const n = p.length / 9, out = new Float64Array(n * 36);
      for (let t = 0; t < n; t++) {
        const o = t * 9, a = [p[o], p[o + 1], p[o + 2]], b = [p[o + 3], p[o + 4], p[o + 5]], c = [p[o + 6], p[o + 7], p[o + 8]];
        const ab = a.map((x, i) => (x + b[i]) / 2), bc = b.map((x, i) => (x + c[i]) / 2), ca = c.map((x, i) => (x + a[i]) / 2);
        [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]].forEach((tr, k) => { const q = (t * 4 + k) * 9; for (let v = 0; v < 3; v++) for (let i = 0; i < 3; i++) out[q + v * 3 + i] = tr[v][i]; });
      }
      return out;
    };
    while (pos.length / 9 < 500000) pos = subdivide(pos);
    const t0 = Date.now();
    const f = stl(pos);
    const ms = Date.now() - t0;
    assert.ok(ms < 10000, `took ${ms} ms for ${pos.length / 9} triangles`);
    assert.strictEqual(f.holes.length, 4); assert.strictEqual(f.pockets.length, 1);
    assert.ok(f.notes.some((n) => /sampled on/.test(n)), "downsampling noted");
    console.log(`       (${pos.length / 9} triangles in ${ms} ms)`);
  });
}

// ── STEP fixtures (B-rep path) ──
async function stepTests() {
  const fixturesDir = path.join(__dirname, "fixtures");
  const truth = JSON.parse(fs.readFileSync(path.join(fixturesDir, "fixtures.json"), "utf8"));
  const occt = await require("occt-import-js")();
  const load = (name) => {
    const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(path.join(fixturesDir, name + ".step"))), null);
    assert.ok(r.success, "occt read " + name);
    const pos = [], nrm = [], faces = [];
    let tri = 0;
    for (const mesh of r.meshes) {
      const P = mesh.attributes.position.array, N = mesh.attributes.normal ? mesh.attributes.normal.array : null, idx = mesh.index.array, base = tri;
      for (let i = 0; i < idx.length; i += 3) { for (let v = 0; v < 3; v++) { const k = idx[i + v]; pos.push(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]); if (N) nrm.push(N[k * 3], N[k * 3 + 1], N[k * 3 + 2]); } tri++; }
      for (const f of mesh.brep_faces || []) faces.push({ first: base + f.first, last: base + f.last });
    }
    return analyzeGeometry({ positions: Float64Array.from(pos), source: "step", brepFaces: faces, vertexNormals: nrm.length ? Float64Array.from(nrm) : null });
  };
  console.log("Geometry — STEP fixtures (B-rep faces)");
  test("STEP plate: 7 holes incl. blind, counterbore, countersink; holes confidence 1.0", () => {
    const f = load("plate_holes"), t = truth.plate_holes;
    assert.strictEqual(f.holes.length, t.holes);
    assert.strictEqual(f.holes.filter((h) => h.through).length, t.through);
    assert.strictEqual(f.holes.filter((h) => h.blind).length, t.blind);
    const cb = f.holes.find((h) => h.kind === "counterbored"); assert.ok(cb); near(cb.counterbore.diameter, t.cboreDiameter, 0.01); near(cb.counterbore.depth, t.cboreDepth, 0.01);
    const csk = f.holes.find((h) => h.kind === "countersunk"); assert.ok(csk); near(csk.countersink.diameter, t.cskDiameter, 0.01); near(csk.countersink.angleDeg, 90, 0.01);
    const blind = f.holes.find((h) => h.blind); near(blind.depth, t.blindDepth, 0.01); near(blind.diameter, 5, 0.01);
    assert.strictEqual(f.confidence.holes, 1);
    assert.strictEqual(f.source, "step");
    assert.strictEqual(f.pockets.length, 0);
    near(f.walls.minThickness, 2, 0.01, "web under the counterbore");
  });
  test("STEP tube: revolved, bore 25", () => {
    const f = load("tube"), t = truth.tube;
    assert.strictEqual(f.shape.kind, "revolved"); near(f.shape.revolved.boreDiameter, t.bore, 0.01); near(f.shape.revolved.maxDiameter, t.od, 0.01); near(f.shape.revolved.length, t.length, 1e-6);
    assert.strictEqual(f.holes.length, 1);
  });
  test("STEP tray: one pocket, depth 12, area ±1%, R8 corners, 4 fillets", () => {
    const f = load("tray"), t = truth.tray;
    assert.strictEqual(f.pockets.length, 1); near(f.pockets[0].depth, t.pocketDepth, 1e-6); near(f.pockets[0].area, t.pocketArea, 0.01); near(f.pockets[0].minCornerRadius, t.pocketCornerRadius, 0.02);
    assert.strictEqual(f.fillets.count, 4); near(f.fillets.minRadius, 8, 0.01);
    assert.ok(f.confidence.pockets >= 0.9);
  });
  test("STEP closed T-slot: undercut detected", () => {
    const f = load("tslot_block"), t = truth.tslot_block;
    assert.ok(f.access.undercutAreaFraction * f.surfaceArea >= t.undercutArea * 0.95);
    near(f.surfaceArea, t.surfaceArea, 1e-6);
  });
  test("STEP boss plate: one boss Ø20 × 10 and a Ø8 through hole", () => {
    const f = load("boss_plate"), t = truth.boss_plate;
    assert.strictEqual(f.bosses.length, t.bosses); near(f.bosses[0].diameter, t.bossDiameter, 0.01); near(f.bosses[0].height, t.bossHeight, 0.01);
    assert.strictEqual(f.holes.length, 1); near(f.holes[0].diameter, t.holeDiameter, 0.01); near(f.holes[0].depth, t.holeDepth, 0.01);
  });
  await testAsync("parseFile wires features into geometry and upgrades the legacy fields", async () => {
    const { parseFile } = require("../parsers/fileParser");
    const r = await parseFile(path.join(partsDir, "drill_fixture_plate.stl"));
    assert.strictEqual(r.geometry.estimatedHoles, 20);
    assert.strictEqual(r.geometry.features.holeCount, 20);
    near(r.geometry.estimatedPerimeter, 1301.85, 0.01);
    near(r.geometry.estimatedThickness, 12.7, 0.01);
    assert.ok(!("meshData" in r.geometry.features));
    const s = await parseFile(path.join(fixturesDir, "plate_holes.step"));
    assert.strictEqual(s.geometry.features.source, "step");
    assert.strictEqual(s.geometry.estimatedHoles, 7);
    assert.strictEqual(s.geometry.features.confidence.holes, 1);
  });
}

stepTests().then(() => {
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
}).catch((err) => {
  console.error("STEP tests failed to run:", err);
  process.exitCode = 1;
});
