/**
 * Geometry speed and sameness (no framework). Run: `node server/geometry/speed.test.js`
 *
 * The analysis was made faster on the condition that no result changes. This
 * suite keeps both halves of that:
 *
 *  1. every small case of the benchmark corpus (tools/geometry-bench) still
 *     returns exactly what the code returned before the speed work — the
 *     committed baseline — field for field: geometry, DFM for every process,
 *     and price (price is skipped, with a note, when pricing rules or the
 *     material catalog have changed since the baseline was recorded);
 *  2. the DXF analysis gives the same profile with its spatial indexes, with
 *     the indexes forced on, and with the original exhaustive loops;
 *  3. medium inputs that used to take from tens of seconds to minutes stay
 *     within generous CPU-time bounds, so a quadratic loop cannot come back
 *     unnoticed. CPU time, not wall time: the bound holds on a busy machine.
 *
 * If (1) fails after an intended change to recognition, DFM rules or pricing
 * defaults, read the differences it prints, and when they are what you meant
 * re-record with `node tools/geometry-bench/snapshot.js --size small,medium`.
 * Set GEOMETRY_SKIP_PERF=1 to skip (3).
 */
const assert = require("assert");
const path = require("path");

const bench = path.join(__dirname, "..", "..", "tools", "geometry-bench");
const { cases, byId } = require(path.join(bench, "corpus"));
const lib = require(path.join(bench, "lib"));
const compare = require(path.join(bench, "compare"));
const { parseFile } = require("../parsers/fileParser");
const { readDxf, resolveUnits, normalise } = require("./dxf/parse");
const { analyseCurves } = require("./dxf/analyze");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

/** CPU milliseconds this process spends parsing one corpus case. */
async function cpuMs(id) {
  const c = byId(id);
  const buffer = c.build();
  const c0 = process.cpuUsage();
  try { await parseFile("case" + c.ext, { ext: c.ext, buffer, ...(c.options || {}) }); } catch { /* a refusal is an answer too */ }
  const u = process.cpuUsage(c0);
  return (u.user + u.system) / 1000;
}

(async () => {
  console.log("Geometry speed and sameness");

  await test("small corpus: every result is identical to the recorded baseline", async () => {
    const log = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(" "));
    let r;
    try { r = await compare.main(["--size", "small", "--in-process", "--quiet"]); } finally { console.log = log; }
    for (const l of lines) if (/^NOTE/.test(l)) console.log(`       ${l}`);
    assert.strictEqual(r.bad, 0, `\n${lines.filter((l) => !/^NOTE/.test(l)).join("\n")}`);
    assert.ok(r.n >= 130, `only ${r.n} small cases ran`);
  });

  await test("DXF profile: spatial indexes, forced indexes and the exhaustive loops agree on every small drawing", () => {
    let n = 0;
    for (const c of cases) {
      if (c.ext !== ".dxf" || c.size !== "small") continue;
      const doc = readDxf(c.build());
      const units = resolveUnits(doc.header, c.options && c.options.units);
      // the profile, or the error raised (a drawing too wide for the indexes takes the exhaustive
      // path either way, including where that path fails)
      const run = (opts) => { try { return lib.canonical(analyseCurves(normalise(doc, units.scale).curves, opts)); } catch (err) { return `throws ${err.name}: ${err.message}`; } };
      const exhaustive = run({ exhaustive: true });
      assert.strictEqual(run({}), exhaustive, `${c.id}: default differs from exhaustive`);
      assert.strictEqual(run({ rayIndex: "always" }), exhaustive, `${c.id}: forced ray index differs from exhaustive`);
      n++;
    }
    assert.ok(n >= 35, `only ${n} drawings compared`);
  });

  await test("preview mesh is still a plain array of numbers (it is stored and sent as JSON), whole or down-sampled", async () => {
    for (const id of ["box", "plate-10k", "sphere-1k-ascii", "sphere-1k-3mf"]) {
      const c = byId(id);
      const g = (await parseFile("case" + c.ext, { ext: c.ext, buffer: c.build() })).geometry;
      assert.ok(Array.isArray(g.meshData.positions), `${id}: positions is ${Object.prototype.toString.call(g.meshData.positions)}`);
      assert.strictEqual(g.meshData.positions.length, g.triangleCount * 9, id);
      assert.ok(g.meshData.positions.every((x) => typeof x === "number"), id);
    }
    const big = byId("sphere-100k"); // more than 50,000 triangles: every Nth is kept
    const g = (await parseFile("case.stl", { ext: ".stl", buffer: big.build() })).geometry;
    assert.ok(Array.isArray(g.meshData.positions) && g.meshData.positions.length === 50000 * 9 && g.meshData.triangleCount === 50000);
  });

  if (process.env.GEOMETRY_SKIP_PERF !== "1") {
    // id, CPU-time bound in ms, what it took before the speed work (CPU, same machine)
    const bounds = [
      ["sphere-100k", 10000, "40 s"],
      ["blob-100k", 10000, "135 s"],
      ["plate-100k", 10000, "1.5 s"],
      ["soup-100k", 20000, "3.9 s and 458 MB"],
      ["dxf-crossing-5k", 5000, "18 s"],
      ["dxf-perforated-5k", 5000, "3.7 s"],
      ["dxf-windows-5k", 5000, "5 s"],
    ];
    for (const [id, bound, before] of bounds) {
      await test(`${id}: analysed within ${bound / 1000} s of CPU time (was ${before})`, async () => {
        const ms = await cpuMs(id);
        assert.ok(ms < bound, `${id} took ${Math.round(ms)} ms of CPU time`);
        console.log(`       (${Math.round(ms)} ms)`);
      });
    }
  }

  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
})();
