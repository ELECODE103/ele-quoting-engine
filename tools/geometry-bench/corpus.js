/**
 * The benchmark corpus: every input the geometry code is checked against.
 *
 *   const { cases } = require("./corpus");
 *   cases[i] = { id, ext, size, family, n, build() → Buffer, options? }
 *
 * size   "small"  up to ~10k triangles / ~2k entities — full result snapshots are committed
 *        "medium" up to ~100k triangles / ~20k entities — full result snapshots are committed
 *        "large"  up to the ceilings (500,000 triangles, 100,000 entities) — result hashes only
 * n      nominal triangle or entity count (the real count is in the snapshot)
 *
 * Generated inputs are made at run time (gen/*.js, deterministic). Repo
 * fixtures (tools/vet-quotes/parts, server/geometry/fixtures,
 * server/security/fixtures, the brand DXFs) are read from disk.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const M = require("./gen/mesh");
const D = require("./gen/dxf");
const F = require("./gen/formats");

const ROOT = path.join(__dirname, "..", "..");
const cases = [];
const add = (c) => { if (cases.some((x) => x.id === c.id)) throw new Error(`duplicate case id ${c.id}`); cases.push(c); };
const sizeOf = (n) => (n <= 12000 ? "small" : n <= 120000 ? "medium" : "large");
const tag = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A generated mesh as binary STL at each size, plus ASCII STL / 3MF where listed. */
function meshFamily(family, make, sizes, { ascii = [], threemf = [] } = {}) {
  for (const n of sizes) add({ id: `${family}-${tag(n)}`, ext: ".stl", size: sizeOf(n), family, n, build: () => F.binaryStl(make(n).a) });
  for (const n of ascii) add({ id: `${family}-${tag(n)}-ascii`, ext: ".stl", size: sizeOf(n), family, n, build: () => F.asciiStl(make(n).a) });
  for (const n of threemf) add({ id: `${family}-${tag(n)}-3mf`, ext: ".3mf", size: sizeOf(n), family, n, build: () => F.threeMf(make(n).a) });
}
const K = [1000, 10000, 100000, 500000];
// Generators that overshoot their nominal count are asked for a little less at the ceiling.
const under = (make, f = 0.96) => (n) => make(n >= 500000 ? n * f : n);

// ── curved / organic ─────────────────────────────────────────────────────────
meshFamily("sphere", under((n) => M.uvSphere(n, 25)), K, { ascii: [1000, 10000], threemf: [1000, 10000, 100000] });
meshFamily("torus", under((n) => M.torus(n)), K);
meshFamily("blob", under((n) => M.uvSphere(n, 25, M.lobes(11))), K, { ascii: [10000], threemf: [10000] });
meshFamily("roughblob", under((n) => M.uvSphere(n, 25, M.roughLobes(12))), K);
add({ id: "icosphere-1k", ext: ".stl", size: "small", family: "icosphere", n: 1280, build: () => F.binaryStl(M.icosphere(3).a) });
add({ id: "icosphere-20k", ext: ".stl", size: "medium", family: "icosphere", n: 20480, build: () => F.binaryStl(M.icosphere(5).a) });
add({ id: "icosphere-82k", ext: ".stl", size: "medium", family: "icosphere", n: 81920, build: () => F.binaryStl(M.icosphere(6).a) });
add({ id: "icosphere-328k", ext: ".stl", size: "large", family: "icosphere", n: 327680, build: () => F.binaryStl(M.icosphere(7).a) });

// ── prismatic with features ──────────────────────────────────────────────────
meshFamily("plate", under((n) => M.featurePlateFor(n, "many"), 0.9), K, { ascii: [1000, 10000], threemf: [1000, 10000, 100000] });
meshFamily("plate-dense", under((n) => M.featurePlateFor(n, "dense"), 0.9), [10000, 100000, 500000]);
add({ id: "plate-tilted-10k", ext: ".stl", size: "small", family: "plate", n: 10000, build: () => F.binaryStl(M.featurePlateFor(10000).map(M.rotation(0.4, 0.25, -0.6)).a) });
add({ id: "plate-holes-only-10k", ext: ".stl", size: "small", family: "plate", n: 10000, build: () => F.binaryStl(M.featurePlate(12, 24, { kinds: ["hole"] }).a) });
add({ id: "plate-pockets-only-10k", ext: ".stl", size: "small", family: "plate", n: 10000, build: () => F.binaryStl(M.featurePlate(12, 24, { kinds: ["pocket", "blind", "pocket", null] }).a) });
meshFamily("waffle", under((n) => M.waffle(n), 0.85), K);
meshFamily("textplate", under((n) => M.textPlateFor(n), 0.75), [7000, 100000, 500000]);
add({ id: "textplate-engraved-100k", ext: ".stl", size: "medium", family: "textplate", n: 100000, build: () => F.binaryStl(M.textPlateFor(100000, -0.6).a) });
add({ id: "bracket-tilted", ext: ".stl", size: "small", family: "primitive", n: 28, build: () => F.binaryStl(M.bracket(true).a) });
add({ id: "bracket-square", ext: ".stl", size: "small", family: "primitive", n: 28, build: () => F.binaryStl(M.bracket(false).a) });
add({ id: "box", ext: ".stl", size: "small", family: "primitive", n: 12, build: () => F.binaryStl(M.box(40, 30, 12).a) });
add({ id: "box-ascii", ext: ".stl", size: "small", family: "primitive", n: 12, build: () => F.asciiStl(M.box(40, 30, 12).a) });
add({ id: "hexprism", ext: ".stl", size: "small", family: "primitive", n: 24, build: () => F.binaryStl(M.prism(6, 12, 30).a) });
add({ id: "tslot-block", ext: ".stl", size: "small", family: "primitive", n: 60, build: () => F.binaryStl(M.fromPositions(M.testMesh.buildTSlotBlock(60, 40, 30, 8, 30, 6, 16, 34, 10)).a) });

// ── revolved, thin-walled ────────────────────────────────────────────────────
meshFamily("cup", under((n) => M.cup(n)), K);
meshFamily("vase", (n) => M.vase(n), [10000, 100000]);
meshFamily("shaft", (n) => M.shaft(n), [1000, 10000, 100000]);
meshFamily("hollow-sphere", (n) => M.hollowSphere(n), [10000, 100000]);

// ── relief, lattices, several bodies ─────────────────────────────────────────
meshFamily("relief", under((n) => M.relief(n)), K);
meshFamily("lattice", under((n) => M.lattice(n, 4)), K);
meshFamily("lattice-round", (n) => M.lattice(n, 8), [10000, 100000]);
meshFamily("multibody", under((n) => M.multiBody(n), 0.85), K, { threemf: [10000] });
meshFamily("intersecting", (n) => M.intersecting(n), [10000, 100000]);

// ── open, non-manifold, defective ────────────────────────────────────────────
meshFamily("open-sphere", (n) => { const st = Math.max(3, Math.round(Math.sqrt(n / 4))); return M.uvSphere(n, 25, null, { skipBand: [Math.floor(st * 0.3), Math.floor(st * 0.4)] }); }, [1000, 10000, 100000]);
meshFamily("open-sheet", under((n) => M.openSheet(n)), K);
meshFamily("mixed-winding", (n) => M.mixedWinding(n), [1000, 10000, 100000]);
meshFamily("shattered", (n) => M.shattered(n), [1000, 10000, 100000]);
meshFamily("soup", (n) => M.randomSoup(n, 2), K);
meshFamily("soup-wide", (n) => M.randomSoup(n, 100), K);
add({ id: "nonmanifold-boxes", ext: ".stl", size: "small", family: "defect", n: 25, build: () => F.binaryStl(M.nonManifold().a) });
add({ id: "tjunction-box", ext: ".stl", size: "small", family: "defect", n: 810, build: () => F.binaryStl(M.tJunctionBox(20).a) });
add({ id: "plate-defects-10k", ext: ".stl", size: "small", family: "defect", n: 10000, build: () => F.binaryStl(M.withDefects(M.featurePlateFor(10000)).a) });
add({ id: "sphere-inverted-10k", ext: ".stl", size: "small", family: "defect", n: 10000, build: () => F.binaryStl(M.uvSphere(10000, 25).flipped().a) });
add({ id: "single-triangle", ext: ".stl", size: "small", family: "defect", n: 1, build: () => F.binaryStl([0, 0, 0, 10, 0, 0, 0, 10, 0]) });
add({ id: "zero-area-only", ext: ".stl", size: "small", family: "defect", n: 2, build: () => F.binaryStl([0, 0, 0, 10, 0, 0, 20, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]) });
add({ id: "flat-sheet-two-sided", ext: ".stl", size: "small", family: "defect", n: 4, build: () => F.binaryStl([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10, 0, 0, 0, 0, 0, 0, 10, 0, 10, 10, 0]) });
add({ id: "sphere-inch-3mf", ext: ".3mf", size: "small", family: "sphere", n: 1000, build: () => F.threeMf(M.uvSphere(1000, 1).a, { unit: "inch", transform: "1 0 0 0 1 0 0 0 1 2 3 4" }) });

// ── malformed and extreme input (results, or the errors raised, must not change either) ──
const facet = (v) => `facet normal 0 0 1\nouter loop\n${v.map((p) => `vertex ${p.join(" ")}`).join("\n")}\nendloop\nendfacet\n`;
add({ id: "ascii-missing-vertex", ext: ".stl", size: "small", family: "malformed", n: 2, build: () => Buffer.from("solid a\n" + facet([[0, 0, 0], [1, 0, 0], [0, 1, 0]]) + facet([[0, 0, 0], [1, 0, 0]]) + "endsolid a\n") });
add({ id: "ascii-extra-vertex", ext: ".stl", size: "small", family: "malformed", n: 2, build: () => Buffer.from("solid a\n" + facet([[0, 0, 0], [10, 0, 0], [0, 10, 0], [50, 50, 50]]) + facet([[0, 0, 0], [0, 10, 0], [0, 0, 10]]) + "endsolid a\n") });
add({ id: "stl-nan-vertex", ext: ".stl", size: "small", family: "malformed", n: 1000, build: () => { const b = F.binaryStl(M.uvSphere(1000, 25).a); b.writeFloatLE(NaN, 84 + 50 * 7 + 12); b.writeFloatLE(Infinity, 84 + 50 * 300 + 20); return b; } });
add({ id: "stl-far-from-origin", ext: ".stl", size: "small", family: "malformed", n: 1000, build: () => F.binaryStl(M.featurePlateFor(1000).map(M.translate(1e6, -2e6, 5e5)).a) });
add({ id: "stl-microscopic", ext: ".stl", size: "small", family: "malformed", n: 1000, build: () => F.binaryStl(M.featurePlateFor(1000).map((p) => [p[0] * 1e-4, p[1] * 1e-4, p[2] * 1e-4]).a) });
add({ id: "stl-kilometre", ext: ".stl", size: "small", family: "malformed", n: 1000, build: () => F.binaryStl(M.uvSphere(1000, 5e5).a) });

// ── the triangle ceiling ─────────────────────────────────────────────────────
add({ id: "ceiling-sphere-500000", ext: ".stl", size: "large", family: "ceiling", n: 500000, build: () => { const s = M.uvSphere(499000, 25); while (s.count < 500000) s.add(M.box(1, 1, 1, 60 + s.count % 7, 0, 0)); s.a.length = 500000 * 9; return F.binaryStl(s.a); } });
add({ id: "ceiling-over-500001", ext: ".stl", size: "small", family: "ceiling", n: 500001, build: () => { const b = Buffer.alloc(84 + 500001 * 50); b.writeUInt32LE(500001, 80); return b; } });

// ── DXF ──────────────────────────────────────────────────────────────────────
const dsize = (n) => (n <= 2500 ? "small" : n <= 25000 ? "medium" : "large");
const dxf = (id, n, text, options) => add({ id, ext: ".dxf", size: dsize(n), family: id.replace(/-[0-9]+k?$/, ""), n, build: () => Buffer.from(text()), options });
for (const n of [100, 600, 2000, 5000, 20000, 50000, 100000]) dxf(`dxf-crossing-${tag(n)}`, n, () => D.crossingLines(n));
for (const n of [100, 1000, 4900, 6000, 20000, 99999]) dxf(`dxf-perforated-${tag(n)}`, n, () => D.perforated(n));
dxf("dxf-perforated-hex-4900", 4900, () => D.perforated(4900, { hex: true, pitch: 7 }));
dxf("dxf-perforated-tight-1000", 1000, () => D.perforated(1000, { d: 4, pitch: 4.4 }));
dxf("dxf-insert-array-70x70", 4900, () => D.perforatedInsert(70, 70));
dxf("dxf-insert-array-100x100", 10000, () => D.perforatedInsert(100, 100));
for (const n of [20, 500, 4000, 20000]) dxf(`dxf-mixed-cutouts-${tag(n)}`, n, () => D.mixedCutouts(n));
for (const n of [200, 5000, 50000, 99000]) dxf(`dxf-loose-outline-${tag(n)}`, n, () => D.looseLineOutline(n));
for (const n of [2000, 20000, 100000]) dxf(`dxf-dense-outline-${tag(n)}`, n, () => D.denseOutline(n));
dxf("dxf-dense-outline-bulged-20k", 20000, () => D.denseOutline(20000, true));
dxf("dxf-nested-2", 2, () => D.nested(2));
dxf("dxf-nested-4", 4, () => D.nested(4));
dxf("dxf-nested-many", 300, () => D.nested(3, 100));
for (const n of [50, 2000, 4900, 30000]) dxf(`dxf-windows-${tag(n)}`, n, () => D.windows(n));
for (const n of [20, 1000, 10000, 33000]) dxf(`dxf-open-contours-${tag(n)}`, n * 3, () => D.openContours(n));
for (const m of [10, 50, 100, 223]) dxf(`dxf-line-grid-${m}`, 2 * m * (m + 1), () => D.lineGrid(m, true));
dxf("dxf-line-grid-long-300", 602, () => D.lineGrid(300, false));
dxf("dxf-line-grid-long-2000", 4002, () => D.lineGrid(2000, false));
for (const n of [100, 5000, 40000]) dxf(`dxf-duplicates-${tag(n)}`, n * 2, () => D.duplicates(n));
for (const n of [50, 1000, 4500, 20000]) dxf(`dxf-scattered-rects-${tag(n)}`, n, () => D.scatteredRects(n));
for (const n of [9, 400, 2500]) dxf(`dxf-splines-${tag(n)}`, n * 10, () => D.splines(n));
dxf("dxf-annotated-inch", 12, () => D.annotated());
dxf("dxf-annotated-as-mm", 12, () => D.annotated(), { units: "mm" });
dxf("dxf-inserts", 10, () => D.inserts());
dxf("dxf-inserted-holes", 20, () => D.insertedHoles());
for (const n of [20, 1000, 10000]) dxf(`dxf-open-inside-${tag(n)}`, n * 3, () => D.openContours(n, 8, true));
dxf("dxf-separate-parts-3", 6, () => D.separateParts(3));
dxf("dxf-separate-parts-2000", 4000, () => D.separateParts(2000));
dxf("dxf-self-crossing", 4, () => D.selfCrossing());
dxf("dxf-tight-webs", 7, () => D.tightWebs());
// far from the origin, and wider than the range the spatial indexes are proven for (they must stand aside)
dxf("dxf-far-from-origin", 500, () => D.farFromOrigin(500));
dxf("dxf-two-kilometres", 400, () => D.perforated(400, { d: 4000, pitch: 100000, margin: 50000 }));
dxf("dxf-two-kilometres-crossing", 300, () => D.crossingLines(300).replace(/^(10|20|11|21)\n(-?[0-9.e+-]+)$/gm, (m, code, v) => `${code}\n${Number(v) * 3000}`));

// ── every CAD file already in the repo ───────────────────────────────────────
function fixture(rel, opts = {}) {
  const file = path.join(ROOT, rel);
  const gz = rel.endsWith(".gz");
  const base = path.basename(rel).replace(/\.gz$/, "");
  const ext = path.extname(base).toLowerCase();
  add({
    id: `fixture-${opts.prefix || ""}${base.replace(/\.[a-z0-9]+$/i, "")}-${ext.slice(1)}`, ext, size: opts.size || "small", family: "fixture", n: null, file: rel,
    build: () => (gz ? zlib.gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file)),
  });
}
for (const dir of ["tools/vet-quotes/parts", "server/geometry/fixtures", "server/security/fixtures", "client/public/brand/machine"]) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).sort()) {
    if (!/\.(stl|step|stp|3mf|dxf|iges|igs)(\.gz)?$/i.test(f)) continue;
    fixture(`${dir}/${f}`, { size: /plate_400_holes/.test(f) ? "medium" : "small", prefix: dir.includes("brand") ? "brand-" : "" });
  }
}

module.exports = { cases, byId: (id) => cases.find((c) => c.id === id), ROOT };
