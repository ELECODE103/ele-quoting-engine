/**
 * A model without real measurements is never priced (independent review 2026-11-11, H1, L3),
 * and a file padded far past what its model needs is not stored (H4).
 *
 * Before: one NaN or Infinity coordinate emptied the bounding box, area and
 * volume; pricing worked from the empty values and a 400 mm block that honestly
 * quotes $3,727 (sent to a person) was quoted $352.04 with checkout open.
 * Run: node server/parsers/saneGeometry.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, runner } = require("../testSupport/harness");
const g = require("../../tools/security/review-uploads/gen");
const { parseFile } = require("./fileParser");
const { assertSaneGeometry, isSaneGeometry } = require("./saneGeometry");
const { box3mf } = require("../testSupport/zip");

const { test, run } = runner("Sane geometry (parsers and pricing)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-sane-"));
const parse = async (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); try { return { ok: await parseFile(p) }; } catch (err) { return { err }; } finally { fs.unlinkSync(p); } };
const cubeTris = (s) => { const b = g.stlCube(s); const t = []; for (let i = 0; i < 12; i++) { const o = 84 + i * 50 + 12; t.push([0, 1, 2].map((k) => [b.readFloatLE(o + k * 12), b.readFloatLE(o + k * 12 + 4), b.readFloatLE(o + k * 12 + 8)])); } return t; };
/** Every refusal: a stable code, a message in plain words that offers the manual quote, nothing technical. */
function assertRefusal(err, code) {
  assert.ok(err, "the file was refused");
  assert.strictEqual(err.code, code, err.message);
  assert.ok(!/NaN|Infinity|undefined|null|bounding box|float|vertex|parser/i.test(err.message), `plain words: ${err.message}`);
  if (err.offerRfq) assert.ok(/quote it by hand|firm quote|send it to us|email/i.test(err.message), `offers a way out: ${err.message}`);
}

test("binary STL: a NaN or Infinity coordinate, or one far outside any real part, is refused before analysis", async () => {
  const big = cubeTris(400);
  for (const [label, data, code] of [
    ["one stray triangle with an Infinity corner", g.stl([...big, [[Infinity, Infinity, Infinity], [0, 0, 0], [1, 0, 0]]]), "geometry-not-measurable"],
    ["one stray triangle with a NaN corner", g.stl([...big, [[NaN, NaN, NaN], [0, 0, 0], [1, 0, 0]]]), "geometry-not-measurable"],
    ["one NaN vertex in a cube", g.stlCubeWith(NaN), "geometry-not-measurable"],
    ["every coordinate NaN", g.stlCubeWith(NaN, { all: true }), "geometry-not-measurable"],
    ["cube scaled by 1e30", g.stlCubeScaled(1e30), "geometry-out-of-range"],
  ]) {
    const r = await parse("part.stl", data);
    assertRefusal(r.err, code);
    assert.strictEqual(r.err.offerRfq, true, label);
  }
});

test("ASCII STL: 'e', '+-' and 1e999 are not numbers; three vertices per facet or it is damaged", async () => {
  assertRefusal((await parse("a.stl", g.stlAsciiWeird("e"))).err, "geometry-not-measurable");
  assertRefusal((await parse("a.stl", g.stlAsciiWeird("+-"))).err, "geometry-not-measurable");
  assertRefusal((await parse("a.stl", g.stlAsciiWeird("1e999"))).err, "geometry-not-measurable");
  assertRefusal((await parse("a.stl", g.stlAsciiVertexFlood(256 * 1024))).err, "file-damaged");
  const ok = await parse("a.stl", g.stlAsciiCube(20));
  assert.ok(ok.ok && ok.ok.geometry.volume > 7999 && ok.ok.geometry.volume < 8001, "an honest ASCII cube still reads");
});

test("microscopic, zero-volume and self-cancelling models go to a person, not to a price", async () => {
  assertRefusal((await parse("t.stl", g.stlCubeScaled(1e-30))).err, "geometry-too-small");
  assertRefusal((await parse("t.stl", g.stlCubeScaled(0.01))).err, "geometry-too-small"); // a 0.2 mm cube
  assertRefusal((await parse("c.stl", g.stlCancellingCube(200))).err, "geometry-not-measurable");
  // a single flat triangle: a surface with no inside
  assertRefusal((await parse("f.stl", g.stl([[[0, 0, 0], [20, 0, 0], [0, 20, 0]]]))).err, "geometry-not-measurable");
  // the small parts the shop does make are untouched: a 3 mm cube, a 20 mm cube
  for (const s of [3, 20, 400]) {
    const r = await parse("ok.stl", g.stlCube(s));
    assert.ok(r.ok, `a ${s} mm cube is read: ${r.err && r.err.message}`);
    assert.ok(Math.abs(r.ok.geometry.boundingBox.width - s) < 1e-3);
  }
});

test("3MF: a vertex or transform that is not a number is refused; an honest box still reads", async () => {
  const model = (vertexX) => `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>`
    + `<vertex x="${vertexX}" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="20"/></vertices>`
    + `<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const zip = (xml) => require("../testSupport/zip").buildZip([{ name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>` }, { name: "3D/3dmodel.model", data: xml }]);
  assertRefusal((await parse("m.3mf", zip(model("abc")))).err, "geometry-not-measurable");
  assertRefusal((await parse("m.3mf", zip(model("1e400")))).err, "geometry-not-measurable");
  assertRefusal((await parse("m.3mf", zip(model("1e9")))).err, "geometry-out-of-range");
  assert.ok((await parse("m.3mf", zip(model("0")))).ok, "the honest tetrahedron reads");
  assert.ok((await parse("b.3mf", box3mf(20, 30, 40))).ok);
});

test("a file padded far past what its model needs is refused: binary STL by its arithmetic, ASCII STL per facet", async () => {
  // binary: exactly 84 + 50 × triangles, nothing after
  const cube = g.stlCube(20);
  assertRefusal((await parse("p.stl", Buffer.concat([cube, Buffer.alloc(600)]))).err, "file-padded");
  assertRefusal((await parse("p.stl", g.stlLyingCount(1))).err, "file-padded"); // header says 1 triangle, 12 are present
  // ASCII: a cube followed by megabytes of blanks was accepted (49 MB of it, in two seconds)
  assertRefusal((await parse("p.stl", g.stlAsciiPadded(2 * 1024 * 1024))).err, "file-padded");
  // a text CAD file that is almost all blanks
  const step = fs.readFileSync(path.join(__dirname, "..", "geometry", "fixtures", "plate_holes.step"));
  assertRefusal((await parse("p.step", Buffer.concat([step, Buffer.alloc(8 * step.length + 512 * 1024, 0x20)]))).err, "file-padded");
  assert.ok((await parse("ok.step", step)).ok, "the honest STEP reads");
});

test("DXF: nested block arrays and an ellipse with an absurd angle are refused in milliseconds (each used to hold a worker for 60 s)", async () => {
  for (const [data, code] of [[g.dxfInsertBomb(8, 1, 100, 100), "dxf-too-many-blocks"], [g.dxfEllipseSpin(), "dxf-bad-ellipse"]]) {
    const t0 = Date.now();
    const r = await parse("b.dxf", data);
    assert.ok(r.err, "refused");
    assert.strictEqual(r.err.code, code, r.err.message);
    assert.ok(Date.now() - t0 < 2000, `refused in ${Date.now() - t0} ms`);
    assert.ok(/firm quote/i.test(r.err.message));
  }
  assert.ok((await parse("ok.dxf", g.dxfPlate(4))).ok, "an honest plate with holes reads");
  assert.ok((await parse("self.dxf", g.dxfSelfInsert())).ok, "a block that inserts itself is still cut off at depth 8, as before");
});

test("assertSaneGeometry: what a part row stored before the fix looks like (measurements null) is not sane; a 2D outline is judged as 2D", async () => {
  const good = (await parse("ok.stl", g.stlCube(20))).ok.geometry;
  assert.strictEqual(assertSaneGeometry(good), good);
  // NaN and Infinity were stored as null
  const stored = JSON.parse(JSON.stringify({ ...good, boundingBox: { min: { x: NaN, y: 0, z: 0 }, max: { x: Infinity, y: 20, z: 20 }, width: NaN, height: 20, depth: 20 }, surfaceArea: NaN, volume: NaN }));
  assert.strictEqual(stored.volume, null);
  assert.throws(() => assertSaneGeometry(stored), (e) => e.code === "geometry-not-measurable" && e.status === 422 && e.extra.offerRfq === true);
  assert.throws(() => assertSaneGeometry(stored, { partId: "p1" }), (e) => e.extra.partId === "p1");
  for (const bad of [null, {}, { boundingBox: null }, { ...good, volume: 0 }, { ...good, surfaceArea: -1 }, { ...good, volume: "8000" }]) assert.strictEqual(isSaneGeometry(bad), false);
  const dxf = (await parse("ok.dxf", g.dxfPlate(4))).ok.geometry;
  assert.strictEqual(isSaneGeometry(dxf), true, "a flat outline has no depth or volume of its own and is still a part");
  assert.strictEqual(isSaneGeometry({ ...dxf, boundingBox: { ...dxf.boundingBox, width: 0 } }), false);
});

// ─── Through the routes ──────────────────────────────────────
let h;
test("upload: the doctored 400 mm block is refused with a message that offers the manual quote, and its file is deleted", async () => {
  h = await start();
  const doctored = g.stl([...cubeTris(400), [[Infinity, Infinity, Infinity], [0, 0, 0], [1, 0, 0]]]);
  const before = fs.readdirSync(path.join(process.env.QUOTING_DATA_DIR, "uploads")).length;
  const r = await h.form("/api/upload", {}, { files: { name: "block.stl", data: doctored } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.parts, []);
  assert.strictEqual(r.body.errors[0].code, "geometry-not-measurable");
  assert.strictEqual(r.body.errors[0].offerRfq, true);
  assert.strictEqual(fs.readdirSync(path.join(process.env.QUOTING_DATA_DIR, "uploads")).length, before, "nothing was kept");
  // the honest block is read, priced, and sent to a person as it always was
  const honest = await h.form("/api/upload", {}, { files: { name: "block.stl", data: g.stlCube(400) } });
  const q = await h.post("/api/quote", { parts: [h.cncConfig(honest.body.parts[0].partId, 1)] });
  assert.strictEqual(q.status, 200);
  assert.strictEqual(q.body.gate.requiresRfq, true);
  assert.ok(q.body.orderTotal > 3000, `the honest block still quotes in the thousands ($${q.body.orderTotal})`);
});

test("pricing: a part stored before the fix with empty measurements is refused, not priced low with checkout open", async () => {
  // What the old upload route stored for the Infinity block: the row, with the measurements null.
  const partId = await h.uploadCube();
  const row = h.models.partsDB.getRow(partId);
  const empty = JSON.parse(JSON.stringify({ ...row.geometry, boundingBox: { min: { x: NaN, y: NaN, z: NaN }, max: { x: NaN, y: NaN, z: NaN }, width: NaN, height: NaN, depth: NaN }, surfaceArea: NaN, volume: NaN, flatWidth: NaN, flatHeight: NaN, flatArea: NaN }));
  h.models.partsDB.table.update(partId, { geometry: empty });
  for (const config of [h.cncConfig(partId, 1), { partId, materialSlug: h.models.materialsDB.getAll().find((m) => m.process === "3d-printing" && m.active).slug, quantity: 1, process: "3d-printing" }]) {
    const q = await h.post("/api/quote", { parts: [config] });
    assert.strictEqual(q.status, 422, q.text.slice(0, 200));
    assert.strictEqual(q.body.code, "geometry-not-measurable");
    assert.strictEqual(q.body.offerRfq, true);
    assert.strictEqual(q.body.partId, partId);
    assert.ok(q.body.lineItems === undefined && q.body.quoteId === undefined, "no price, no quote");
  }
});

// ─── Independent re-review 2026-11-12, RR-09: finite but wrong ───

/** Twelve triangles of an axis-aligned box at `o`, facing out (or in, with flip). */
const boxTris = (w, d, hgt, o = [0, 0, 0], flip = false) => {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => [o[0] + p[0] * w, o[1] + p[1] * d, o[2] + p[2] * hgt]);
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return t.map((f) => (flip ? [f[0], f[2], f[1]] : f).map((i) => v[i]));
};

test("RR-09: one closed shell inside another is sent to a person, whichever way the inner one faces and however it is written; parts side by side are not", async () => {
  const outer = boxTris(100, 100, 100);
  for (const [label, tris] of [
    ["an inside-out cube a micrometre smaller (the solid cancelled down to a skin; it priced $100 with checkout open)", [...outer, ...boxTris(99.998, 99.998, 99.998, [0.001, 0.001, 0.001], true)]],
    ["five cubes nested inside, all facing out (the volume counted 5.16 times)", [...outer, ...[10, 20, 30, 40, 45].flatMap((m) => boxTris(100 - 2 * m, 100 - 2 * m, 100 - 2 * m, [m, m, m]))]],
    ["sixty closed boxes hidden inside one bar of a frame", [...boxTris(100, 4, 4), ...boxTris(4, 100, 4, [0, 4, 0]), ...Array.from({ length: 60 }, (_, i) => boxTris(1, 2, 2, [2 + i * 1.5, 1, 1])).flat()]],
    ["an honest hollow box with a sealed cavity (real, and not something the instant quote can price)", [...outer, ...boxTris(80, 80, 80, [10, 10, 10], true)]],
  ]) {
    const binary = await parse("p.stl", g.stl(tris));
    assertRefusal(binary.err, "nested-shells");
    assert.strictEqual(binary.err.offerRfq, true, label);
  }
  // the same written as an ASCII STL, and as a 3MF
  const hidden = [...outer, ...boxTris(10, 10, 10, [45, 45, 45])];
  const ascii = `solid p\n${hidden.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((v) => `vertex ${v.join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid p\n`;
  assertRefusal((await parse("p.stl", Buffer.from(ascii))).err, "nested-shells");
  // Not flagged: two parts side by side; a small part in the open corner of an L (inside its box, outside its surface).
  const sideBySide = await parse("two.stl", g.stl([...boxTris(20, 20, 20), ...boxTris(20, 20, 20, [30, 0, 0])]));
  assert.ok(sideBySide.ok, sideBySide.err && sideBySide.err.message);
  const ell = [...boxTris(100, 20, 20), ...boxTris(20, 80, 20, [0, 20, 0])];
  const inTheCorner = await parse("ell.stl", g.stl([...ell, ...boxTris(10, 10, 10, [60, 60, 5])]));
  assert.ok(inTheCorner.ok, inTheCorner.err && inTheCorner.err.message);
  // The shell test alone, on a large mesh: it is linear in the triangles.
  const { findNestedShells } = require("./meshShells");
  const many = Array.from({ length: 4000 }, (_, i) => boxTris(1, 1, 1, [(i % 100) * 3, Math.floor(i / 100) * 3, 0])).flat();
  const xyz = new Float32Array(many.length * 9);
  many.forEach((t, i) => t.forEach((v, k) => { xyz[i * 9 + k * 3] = v[0]; xyz[i * 9 + k * 3 + 1] = v[1]; xyz[i * 9 + k * 3 + 2] = v[2]; }));
  const t0 = Date.now();
  assert.deepStrictEqual(findNestedShells(xyz, many.length), { shells: 4000, nested: false });
  assert.ok(Date.now() - t0 < 2000, `48,000 triangles in 4,000 separate boxes: ${Date.now() - t0} ms`);
});

test("RR-09: a counted volume larger than the bounding box is not a measurement", () => {
  const cube = { boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 100 }, width: 100, height: 100, depth: 100 }, surfaceArea: 60000, volume: 1e6 };
  assert.ok(isSaneGeometry(cube));
  assert.ok(isSaneGeometry({ ...cube, volume: 1e6 * 1.0005 }), "rounding is allowed for");
  assert.strictEqual(isSaneGeometry({ ...cube, volume: 5.16e6 }), false);
  try { assertSaneGeometry({ ...cube, volume: 5.16e6 }); assert.fail("accepted"); } catch (err) { assertRefusal(err, "geometry-not-measurable"); }
});

test("RR-09: a part thinner than a printer makes is not priced for printing (it was $19.59 with checkout open); the same part for machining is judged as before", async () => {
  const sheet = { boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 0.011 }, width: 100, height: 100, depth: 0.011 }, surfaceArea: 20004.4, volume: 110 };
  assert.ok(isSaneGeometry(sheet), "with no process named it is a measurable part");
  assert.doesNotThrow(() => assertSaneGeometry(sheet, { config: { process: "cnc" } }));
  try { assertSaneGeometry(sheet, { partId: "p1", config: { process: "3d-printing" } }); assert.fail("priced"); } catch (err) {
    assertRefusal(err, "too-thin-to-print");
    assert.deepStrictEqual([err.status, err.extra.partId, err.offerRfq], [422, "p1", true]);
  }
  // A thin skin that is not thin in any one direction: a 100 mm cube's worth of box with 100 mm³ of material.
  const skin = { boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 100 }, width: 100, height: 100, depth: 100 }, surfaceArea: 120000, volume: 100 };
  assert.throws(() => assertSaneGeometry(skin, { config: { process: "3d-printing" } }), (err) => err.code === "too-thin-to-print");
  // Ordinary printed parts are untouched: a solid cube, a 1.5 mm wall enclosure (twice its volume over its surface is its wall).
  const enclosure = { boundingBox: skin.boundingBox, surfaceArea: 2 * 60000, volume: 60000 * 1.5 };
  for (const g2 of [{ ...skin, surfaceArea: 60000, volume: 1e6 }, enclosure]) assert.doesNotThrow(() => assertSaneGeometry(g2, { config: { process: "3d-printing" } }));
  // Through the routes: the sheet uploads, prices for machining as before, and is refused for printing.
  h = h || await start({});
  const up = await h.form("/api/upload", {}, { files: { name: "sheet.stl", data: g.stl(boxTris(100, 100, 0.011)) } });
  assert.strictEqual(up.status, 200, up.text.slice(0, 200));
  const partId = up.body.parts[0].partId;
  const printMat = h.models.materialsDB.getAll().find((m) => m.process === "3d-printing" && m.active);
  const printed = await h.post("/api/quote", { parts: [{ partId, materialSlug: printMat.slug, quantity: 1, process: "3d-printing" }] });
  assert.deepStrictEqual([printed.status, printed.body.code, printed.body.offerRfq], [422, "too-thin-to-print", true], printed.text.slice(0, 200));
  // a line that does not say its process: the material decides
  assert.strictEqual((await h.post("/api/quote", { parts: [{ partId, materialSlug: printMat.slug, quantity: 1 }] })).body.code, "too-thin-to-print");
});

run(async () => { fs.rmSync(tmp, { recursive: true, force: true }); if (h) await h.stop(); process.exit(process.exitCode || 0); });
