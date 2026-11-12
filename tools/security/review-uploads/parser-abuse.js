#!/usr/bin/env node
/**
 * Item 2 of the review: hostile CAD files against the local server, one at a time, measured.
 *
 *   node tools/security/review-uploads/parser-abuse.js [filter-regex] [--out file.jsonl]
 *
 * For every input: HTTP status and error code, seconds until the server answered (= time to
 * cut-off for the ones that are stopped), peak memory of the server process while it was being
 * read, worst /api/health latency during the read, what was left in data/uploads, and whether a
 * normal cube still quotes afterwards. After each parsed part the price is requested too, to see
 * what NaN / Infinity / zero geometry does to it.
 */
const fs = require("fs");
const g = require("./gen");
const { startServer, monitor, sleep, ls, threadCount, rssMb } = require("./lib");

const MB = g.MB;
const cases = [
  // ── STL ──
  ["stl control: 20 mm cube", "cube.stl", () => g.stlCube()],
  ["stl header count 4,294,967,295, 12 triangles present", "lie-max.stl", () => g.stlLyingCount(0xffffffff)],
  ["stl header count 500,000, 12 triangles present", "lie-500k.stl", () => g.stlLyingCount(500000)],
  ["stl header count 1, 12 triangles present (trailing data)", "lie-low.stl", () => g.stlLyingCount(1)],
  ["stl one vertex NaN", "nan-one.stl", () => g.stlCubeWith(NaN)],
  ["stl every coordinate NaN", "nan-all.stl", () => g.stlCubeWith(NaN, { all: true })],
  ["stl one vertex +Infinity", "inf-one.stl", () => g.stlCubeWith(Infinity)],
  ["stl 200 mm cube + one NaN vertex", "bigcube-nan.stl", () => g.stlBigCubeOneNaN()],
  ["stl 200 mm cube + inverted copy (volume cancels)", "cancel.stl", () => g.stlCancellingCube(200)],
  ["stl cube scaled 1e30 (float max range)", "huge.stl", () => g.stlCubeScaled(1e30)],
  ["stl cube scaled 1e-30", "tiny.stl", () => g.stlCubeScaled(1e-30)],
  ["stl binary with 'solid' header", "solid-binary.stl", () => g.stlSolidHeaderBinary()],
  ["stl ascii, numbers 'e' / '+-' (parse to NaN)", "ascii-nan.stl", () => g.stlAsciiWeird("e")],
  ["stl ascii, numbers 1e999 (Infinity)", "ascii-inf.stl", () => g.stlAsciiWeird("1e999")],
  ["stl ascii cube + 49 MB padding", "ascii-pad.stl", () => g.stlAsciiPadded(49 * MB)],
  ["stl ascii 1 facet + 49 MB of vertex lines (3.9 M vertices)", "ascii-vflood.stl", () => g.stlAsciiVertexFlood(49 * MB)],
  ["stl 500,000 random triangles (25 MB)", "soup-500k.stl", () => g.stlSoup(500000)],
  ["stl 500,000 coplanar grid triangles (25 MB)", "grid-500k.stl", () => g.stlGrid(500000)],
  ["stl 500,000 degenerate triangles (25 MB)", "degenerate-500k.stl", () => g.stlDegenerate(500000)],
  ["stl 100,000 random triangles (5 MB)", "soup-100k.stl", () => g.stlSoup(100000)],
  // ── 3MF ──
  ["3mf control: box", "box.3mf", () => g.threeMf(g.boxModelXml(20, 20, 20))],
  ["3mf model declares 1 MB, inflates to 2 GB", "lying-2g.3mf", () => g.threeMfLyingSize(2048 * MB, 1 * MB)],
  ["3mf model declares 60 MB, inflates to 2 GB", "lying-60m.3mf", () => g.threeMfLyingSize(2048 * MB, 60 * MB)],
  ["3mf honest 60 MB of blanks (ratio ~1000:1)", "honest-bomb.3mf", () => g.threeMfHonestBomb(60 * MB)],
  ["3mf 900 directory entries on one local file (overlap)", "overlap.3mf", () => g.threeMfOverlapping(900)],
  ["3mf 60,000 overlapping entries", "overlap-60k.3mf", () => g.threeMfOverlapping(60000)],
  ["3mf data-descriptor flag, zero local sizes", "datadesc.3mf", () => g.threeMfDataDescriptor()],
  ["3mf ZIP64 record claims 2^40 entries", "zip64-lie.3mf", () => g.threeMfZip64Lie()],
  ["3mf XML nested 100,000 deep", "deep.3mf", () => g.threeMfDeep(100000)],
  ["3mf XML entity bomb (billion laughs)", "laughs.3mf", () => g.threeMfLaughs()],
  ["3mf one element with 200,000 attributes", "attrs.3mf", () => g.threeMfAttrs(200000)],
  ["3mf 60 MB of <vertex/> (2.2 M vertices, 1 triangle)", "vflood.3mf", () => g.threeMfVertexFlood(60 * MB)],
  ["3mf 60 MB of vertices with random coordinates (1.5 M vertices, 1 triangle)", "vrandom.3mf", () => g.threeMfRandomVertices(60 * MB)],
  ["3mf component fan-out 8^15 over a 2,000-vertex mesh", "fan.3mf", () => g.threeMfComponentFan(15, 8, 2000)],
  ["3mf self-referencing component", "selfref.3mf", () => g.threeMfSelfRef()],
  // ── DXF ──
  ["dxf control: plate with 4 holes", "plate.dxf", () => g.dxfPlate(4)],
  ["dxf block inserts itself", "self-insert.dxf", () => g.dxfSelfInsert()],
  ["dxf 8 nested 100x100 block arrays, empty leaf (1 kB)", "insert-bomb.dxf", () => g.dxfInsertBomb(8, 1, 100, 100)],
  ["dxf ELLIPSE with parameter 1e308 (1 kB)", "ellipse-spin.dxf", () => g.dxfEllipseSpin()],
  ["dxf 100,000 crossing LINEs", "lines-100k.dxf", () => g.dxfManyEntities(100000)],
  ["dxf 20,000 crossing LINEs", "lines-20k.dxf", () => g.dxfManyEntities(20000)],
  ["dxf plate with 4,900 holes", "holes-4900.dxf", () => g.dxfManyHoles(4900)],
  ["dxf one polyline, 1,000,000 vertices", "poly-1m.dxf", () => g.dxfHugePolyline(1000000)],
  ["dxf self-crossing zig-zag, 20,000 vertices", "zigzag-20k.dxf", () => g.dxfSelfCrossing(20000)],
  ["dxf SPLINE, 50,000 control points", "spline-50k.dxf", () => g.dxfSpline(50000)],
  ["dxf 49 MB of empty group pairs", "token-flood.dxf", () => g.dxfTokenFlood(49 * MB)],
  ["dxf coordinates 1e300", "extreme.dxf", () => g.dxfExtremeCoords(1e300)],
  ["dxf NaN / Infinity / 1e308 bulges, negative and zero radius", "badnum.dxf", () => g.dxfBadNumbers()],
  // ── STEP / IGES ──
  ["step control: tube", "tube.step", () => g.stepFixture("tube.step")],
  ["step plate with 400 holes (2 MB, repo fixture)", "plate400.step", () => g.stepPlate400()],
  ["step 400-hole plate x6 (12 MB)", "plate400x6.step", () => g.stepRepeat(g.stepPlate400(), 6)],
  ["step 400-hole plate x24 (49 MB)", "plate400x24.step", () => g.stepRepeat(g.stepPlate400(), 24)],
  ["step self-referencing entities + mapped item loop", "cyclic.step", () => g.stepCyclic()],
  ["step mapped-item tree 4^12 instances (13 kB)", "instances.step", () => g.stepInstanceBomb(12, 4)],
  ["step 49 MB unterminated entity", "unterminated.step", () => g.stepUnterminated(49 * MB)],
  ["step 1,000,000 nested parentheses", "parens.step", () => g.stepDeepParens(1000000)],
  ["iges control: box with hole", "box.igs", () => g.igesFixture()],
  ["iges 20 MB of transformation-matrix records", "flood.igs", () => g.igesFlood(20 * MB)],
  ["iges every pointer rewritten to entity 1", "loops.igs", () => g.igesLoops()],
];

async function quoteFor(s, partId, ip, is2D) {
  const out = {};
  const tries = is2D
    ? [["routing", { process: "routing", thicknessMm: 6.35 }]]
    : [["cnc", { process: "cnc", subProcess: "milling" }], ["3d-printing", { process: "3d-printing" }]];
  for (const [proc, extra] of tries) {
    const mats = (await s.get(`/api/materials?process=${proc}`, { ip })).body || [];
    const mat = mats[0];
    if (!mat) { out[proc] = "no material"; continue; }
    const cfg = { partId, materialSlug: mat.slug, quantity: 1, subProcess: mat.subProcess || extra.subProcess || "", ...extra };
    const r = await s.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard" }, { ip });
    out[proc] = r.status === 200
      ? { unit: r.body.lineItems?.[0]?.perUnit?.final, total: r.body.orderTotal, rfq: Boolean(r.body.gate?.requiresRfq), reasons: (r.body.gate?.reasons || []).map((x) => x.code || x).slice(0, 4) }
      : { status: r.status, error: (r.body && r.body.error || "").slice(0, 90) };
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const filter = args[0] && !args[0].startsWith("--") ? new RegExp(args[0], "i") : null;
  const s = await startServer({ env: { RATE_UPLOAD_PER_15MIN: "100000", RATE_API_PER_15MIN: "100000", UPLOAD_DAILY_MB_PER_IP: "100000" } });
  const cube = g.stlCube();
  let n = 0;
  const rows = [];
  try {
    for (const [label, name, make] of cases) {
      if (filter && !filter.test(label) && !filter.test(name)) continue;
      n++;
      const ip = `198.51.100.${(n % 250) + 1}`;
      const data = await make();
      const before = { rss: rssMb(s.pid), threads: threadCount(s.pid), uploads: ls(s, "uploads").length, payloads: ls(s, "part-payloads").length };
      const mon = monitor(s);
      const t0 = Date.now();
      let r;
      try { r = await s.upload([{ name, data }], { ip, timeoutMs: 200000 }); } catch (err) { r = { status: 0, body: { error: String(err.message) } }; }
      const seconds = (Date.now() - t0) / 1000;
      const m = await mon.stop();
      const part = r.body?.parts?.[0];
      const err = r.body?.errors?.[0] || (r.status !== 200 ? r.body : null);
      const row = {
        label, bytes: data.length, status: r.status,
        outcome: part ? "parsed" : (err?.code || "refused"),
        message: part ? "" : String(err?.error || "").slice(0, 110),
        seconds: Number(seconds.toFixed(1)),
        peakRssMb: m.peakRssMb, baseRssMb: before.rss, addedMb: m.peakRssMb - before.rss,
        healthWorstMs: m.worstMs, healthMedianMs: m.medianMs, healthFailures: m.failures,
        alive: !s.exited(),
      };
      if (part) {
        const geo = part.geometry || {};
        row.geometry = { bbox: [geo.boundingBox?.width, geo.boundingBox?.height, geo.boundingBox?.depth], volume: geo.volume, area: geo.surfaceArea, triangles: geo.triangleCount };
        row.price = await quoteFor(s, part.partId, ip, Boolean(geo.is2D));
        row.responseBytes = r.text.length;
      }
      if (s.exited()) { row.crashed = s.exited(); rows.push(row); console.log(JSON.stringify(row)); break; }
      await sleep(1500); // let a terminated worker go
      row.leftInUploads = ls(s, "uploads").length - before.uploads - (part ? 1 : 0);
      row.threadsAfter = threadCount(s.pid) - before.threads;
      row.rssAfterMb = rssMb(s.pid);
      // is the service still fine for the next customer?
      const c0 = Date.now();
      const c = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.200" });
      row.cubeAfter = c.status === 200 && c.body.parts.length === 1 ? `ok ${Date.now() - c0} ms` : `FAILED ${c.status}`;
      rows.push(row);
      console.log(JSON.stringify(row));
      if (outFile) fs.writeFileSync(outFile, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    }
    const log = s.log();
    const interesting = log.split("\n").filter((l) => /Parse pool|FATAL|Error|error|heap|memory/i.test(l)).slice(-40);
    console.log("--- server log (parse pool lines) ---\n" + interesting.join("\n"));
  } finally {
    await s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
