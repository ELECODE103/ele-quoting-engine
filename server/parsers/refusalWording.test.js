/**
 * Two files that used to reach the customer with the wrong words (geometry speed report 2026-11-11,
 * section 9, items 1 and 3; fixed at the second integration pass, 2026-11-12):
 *
 *   a malformed ASCII STL (a facet with two vertices)   answered "Cannot read properties of undefined
 *       (reading '0')": the parser's own exception, passed through as customer text. It is refused as
 *       a damaged file before it is parsed (parsers/inputGuards.js), in words a person can act on.
 *   a drawing more than a kilometre across               ran the old crossing search out of memory
 *       ("Set maximum size exceeded" after 12 s and 1.5 GB) and was answered "this file is damaged or
 *       incomplete" — or, in the worker, a memory refusal. It is not searched at all now
 *       (geometry/dxf/analyze.js) and is told it is too large.
 *
 * Each is checked where a customer meets it: the parser, the worker pool, and the upload route.
 * Run: node server/parsers/refusalWording.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, runner } = require("../testSupport/harness");
const { cases } = require("../../tools/geometry-bench/corpus");

const { test, run } = runner("Refusal wording: malformed ASCII STL, a drawing over a kilometre across");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-wording-"));
const fileOf = (id) => { const c = cases.find((x) => x.id === id); assert.ok(c, id); const f = path.join(tmp, id + c.ext); fs.writeFileSync(f, c.build()); return { file: f, name: id + c.ext, data: fs.readFileSync(f) }; };
const settle = (p) => Promise.resolve().then(() => p).then((value) => ({ value }), (error) => ({ error }));
// Words that are the program talking to itself, not to a customer.
const PROGRAM_TALK = /cannot read|undefined|null|reading '|\bNaN\b|RangeError|TypeError|maximum size|\bSet\b|stack|at \w+ \(/i;

let h;
let pool;

test("a malformed ASCII STL is told it is damaged and what to do, by the parser, the worker and the upload route", async () => {
  h = await start();
  const { parseFile } = require("./fileParser");
  const { ParsePool } = require("./parsePool");
  pool = new ParsePool({});
  for (const id of ["ascii-missing-vertex", "ascii-extra-vertex"]) {
    const f = fileOf(id);
    const direct = await settle(Promise.resolve().then(() => parseFile(f.file)));
    assert.ok(direct.error, `${id}: refused by the parser`);
    assert.deepStrictEqual([direct.error.code, direct.error.message], ["file-damaged", "This file is damaged or incomplete. Re-export it from your CAD program and upload again."], id);
    const pooled = await settle(pool.run({ filePath: f.file }));
    assert.deepStrictEqual([pooled.error.code, pooled.error.message], ["file-damaged", direct.error.message], `${id}: the same from the worker`);
    const up = await h.form("/api/upload", {}, { files: { name: f.name, data: f.data } });
    assert.strictEqual(up.status, 200, up.text.slice(0, 200));
    assert.strictEqual(up.body.parts.length, 0);
    const told = up.body.errors[0];
    assert.deepStrictEqual([told.code, told.error], ["file-damaged", direct.error.message], `${id}: and from the upload route`);
    assert.ok(!PROGRAM_TALK.test(told.error) && /upload again/.test(told.error), told.error);
  }
});

test("a drawing more than a kilometre across is told it is too large (not 'damaged', not a memory refusal), at once, with the firm-quote offer", async () => {
  const { parseFile } = require("./fileParser");
  for (const id of ["dxf-two-kilometres", "dxf-two-kilometres-crossing"]) {
    const f = fileOf(id);
    const cpu0 = process.cpuUsage();
    const direct = await settle(Promise.resolve().then(() => parseFile(f.file)));
    const cpuMs = (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000;
    assert.ok(direct.error, `${id}: refused`);
    assert.deepStrictEqual([direct.error.code, direct.error.offerRfq], ["geometry-out-of-range", true], `${id}: ${direct.error.message}`);
    assert.ok(/far larger than anything we make/.test(direct.error.message) && /export units/.test(direct.error.message), direct.error.message);
    assert.ok(!/damaged|incomplete|memory/i.test(direct.error.message) && !PROGRAM_TALK.test(direct.error.message), direct.error.message);
    // It took 12.7 s of CPU and 1.5 GB to fail before; the answer now comes before the search starts.
    assert.ok(cpuMs < 3000, `${id}: answered after ${cpuMs.toFixed(0)} ms of CPU`);
    const pooled = await settle(pool.run({ filePath: f.file }));
    assert.deepStrictEqual([pooled.error.code, pooled.error.message], ["geometry-out-of-range", direct.error.message], `${id}: the same from the worker`);
    const up = await h.form("/api/upload", { process: "routing" }, { files: { name: f.name, data: f.data } });
    assert.strictEqual(up.status, 200, up.text.slice(0, 200));
    const told = up.body.errors[0];
    assert.deepStrictEqual([told.code, told.offerRfq, told.error], ["geometry-out-of-range", true, direct.error.message], `${id}: and from the upload route`);
  }
});

test("a drawing up to a kilometre across is still read as before: only the size beyond which nothing is a part is turned away early", async () => {
  const { readDxf, resolveUnits, normalise } = require("../geometry/dxf/parse");
  const { analyseCurves } = require("../geometry/dxf/analyze");
  const { MAX_EXTENT_MM } = require("../geometry/dxf/spatial");
  const { rectDxf } = require("../testSupport/shapes");
  assert.strictEqual(MAX_EXTENT_MM, 1e6, "a kilometre, in millimetres");
  // A square of that side in millimetres, read the way parseDXF reads it, up to the analysis.
  const curvesOf = (side) => { const doc = readDxf(rectDxf(side, side).toString("utf8")); return normalise(doc, resolveUnits(doc.header).scale).curves; };
  const within = analyseCurves(curvesOf(MAX_EXTENT_MM));
  assert.ok(within && !within.tooLarge && within.loops.length === 1, "exactly a kilometre is analysed, not turned away early");
  assert.deepStrictEqual([within.bbox.w, within.bbox.h], [MAX_EXTENT_MM, MAX_EXTENT_MM]);
  const beyond = analyseCurves(curvesOf(MAX_EXTENT_MM + 1));
  assert.deepStrictEqual([beyond.tooLarge, beyond.width, beyond.height], [true, MAX_EXTENT_MM + 1, MAX_EXTENT_MM + 1]);
  // Too many contours is still said first: the count is checked before anything is measured.
  assert.strictEqual(analyseCurves(curvesOf(MAX_EXTENT_MM + 1), { maxLoops: 0 }).tooManyLoops, true);
  // And a kilometre-wide square, although it is analysed, is not a part either: the measurement check says so
  // (GEOMETRY_MAX_EXTENT_MM, 10 m), in the same words, as it did before this change.
  const { parseFile } = require("./fileParser");
  const f = path.join(tmp, "one-kilometre.dxf");
  fs.writeFileSync(f, rectDxf(MAX_EXTENT_MM, MAX_EXTENT_MM));
  const whole = await settle(Promise.resolve().then(() => parseFile(f)));
  assert.strictEqual(whole.error && whole.error.code, "geometry-out-of-range");
});

run(async () => { if (pool) await pool.close(); if (h) await h.stop(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
