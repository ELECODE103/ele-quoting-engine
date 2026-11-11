/**
 * Unit tests for the guard modules: limits from the environment, the client
 * key, the ZIP pre-flight, the content check, the upload budget, the storage
 * and database ceilings, safe file names and the drawing sweep.
 * Run: node server/security/guards.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-guards-"));
process.env.QUOTING_DATA_DIR = path.join(tmp, "data");
process.env.QUOTING_DB_PATH = path.join(tmp, "data", "quoting.db");
fs.mkdirSync(process.env.QUOTING_DATA_DIR, { recursive: true });

const { limits, envInt } = require("./limits");
const { keyForAddress, clientKey } = require("./clientKey");
const { inspectZip, read3mfModel } = require("../parsers/zipGuard");
const { buildZip, boxModelXml, binaryStl } = require("../testSupport/zip");
const { contentMatchesExtension } = require("../middleware/fileValidator");
const guards = require("./uploadGuards");
const retention = require("../services/fileRetention");

const { test, run } = runner("Guards");
const MB = 1024 * 1024;
const withEnv = (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = String(v); }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const silently = (fn) => {
  const { error, warn } = console; const lines = [];
  console.error = (...a) => lines.push(a.join(" ")); console.warn = (...a) => lines.push(a.join(" "));
  try { return { result: fn(), lines }; } finally { console.error = error; console.warn = warn; }
};

test("limits: safe defaults; an override is honoured; a typo or an absurd value falls back to the default", () => {
  withEnv({ UPLOAD_MAX_FILE_MB: undefined, UPLOAD_MAX_FILES: undefined, JSON_BODY_LIMIT_KB: undefined, PARSE_TIMEOUT_MS: undefined, MESH_MAX_TRIANGLES: undefined }, () => {
    assert.strictEqual(limits.uploadMaxFileBytes, 50 * MB);
    assert.strictEqual(limits.uploadMaxFiles, 10);
    assert.strictEqual(limits.jsonBodyBytes, 1024 * 1024);
    assert.strictEqual(limits.parseTimeoutMs, 60000);
    assert.strictEqual(limits.meshMaxTriangles, 500000);
    assert.strictEqual(limits.uploadDailyBytesPerClient, 500 * MB);
    assert.strictEqual(limits.trustProxyHops, 1);
  });
  withEnv({ UPLOAD_MAX_FILE_MB: "20", UPLOAD_MAX_FILES: "4" }, () => {
    assert.strictEqual(limits.uploadMaxFileBytes, 20 * MB);
    assert.strictEqual(limits.uploadMaxFiles, 4);
  });
  for (const bad of ["", "abc", "0", "-5", "NaN", "Infinity", "999999999", "1e99"]) {
    withEnv({ UPLOAD_MAX_FILE_MB: bad }, () => assert.strictEqual(limits.uploadMaxFileBytes, 50 * MB, `UPLOAD_MAX_FILE_MB=${JSON.stringify(bad)} must not switch the limit off`));
  }
  assert.strictEqual(envInt("SE_TEST_UNSET_VALUE", 7, 1, 10), 7);
});

test("client key: IPv4-mapped IPv6 is the IPv4 client; an IPv6 client is its /64", () => {
  assert.strictEqual(keyForAddress("203.0.113.9"), "203.0.113.9");
  assert.strictEqual(keyForAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.strictEqual(keyForAddress("::ffff:cb00:7109"), "203.0.113.9");
  assert.strictEqual(keyForAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), keyForAddress("2001:db8:1:2::1"), "same /64, same client");
  assert.notStrictEqual(keyForAddress("2001:db8:1:2::1"), keyForAddress("2001:db8:1:3::1"), "another /64 is another client");
  assert.strictEqual(keyForAddress(""), "unknown");
  assert.strictEqual(clientKey({ ip: "::ffff:10.1.2.3" }), "10.1.2.3");
  assert.strictEqual(clientKey({ socket: { remoteAddress: "198.51.100.4" } }), "198.51.100.4");
});

test("ZIP pre-flight: entry count, total size, ratio, encryption and repeated names — judged from the directory alone", () => {
  const model = Buffer.from(boxModelXml());
  const good = buildZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "3D/3dmodel.model", data: model }]);
  assert.strictEqual(inspectZip(good).entries.length, 2);
  assert.ok(read3mfModel(good).includes("<vertex"));
  // case and a leading slash do not hide the model
  assert.ok(read3mfModel(buildZip([{ name: "/3D/3DModel.model", data: model }])).includes("<vertex"));

  const code = (fn) => { try { fn(); return null; } catch (e) { assert.strictEqual(e.expose, true, "message is for the customer"); assert.ok(!/adm-zip|ADM-ZIP/.test(e.message)); return e.code; } };
  assert.strictEqual(code(() => inspectZip(Buffer.from("not a zip at all, just some text that is long enough"))), "ZIP_MALFORMED");
  assert.strictEqual(code(() => inspectZip(Buffer.alloc(5))), "ZIP_MALFORMED");
  assert.strictEqual(code(() => inspectZip(good, { maxEntries: 1 })), "ZIP_TOO_LARGE");
  assert.strictEqual(code(() => inspectZip(buildZip([{ name: "3D/3dmodel.model", data: Buffer.alloc(8 * MB, 0x20) }]))), "ZIP_BOMB", "8 MB of spaces deflates ~1000:1");
  assert.strictEqual(code(() => inspectZip(buildZip([{ name: "a", data: "x", declaredSize: 0xfffffff0 }]))), "ZIP_BOMB", "a declared 4 GB entry in a 100-byte archive");
  assert.strictEqual(code(() => inspectZip(buildZip([{ name: "a", data: Buffer.alloc(3 * MB, 1), method: "store" }, { name: "b", data: Buffer.alloc(3 * MB, 2), method: "store" }]), { maxTotalBytes: 5 * MB })), "ZIP_TOO_LARGE");
  assert.strictEqual(code(() => inspectZip(buildZip([{ name: "3D/3dmodel.model", data: model }, { name: "3d/3dmodel.MODEL", data: "<x/>" }]))), "ZIP_DUPLICATE");
  assert.strictEqual(code(() => inspectZip(buildZip([{ name: "a.txt", data: "x" }, { name: "a.txt", data: "y" }]))), "ZIP_DUPLICATE");
  assert.strictEqual(code(() => read3mfModel(buildZip([{ name: "readme.txt", data: "hello" }]))), "ZIP_NO_MODEL");
  assert.strictEqual(code(() => read3mfModel(buildZip([{ name: "3D/3dmodel.model", data: model }]), { maxModelBytes: 100 })), "ZIP_TOO_LARGE");
  // A directory that understates the size: the inflater stops at the declared size, and the result is refused.
  const lying = buildZip([{ name: "3D/3dmodel.model", data: Buffer.concat([model, Buffer.alloc(2 * MB, 0x20)]), declaredSize: 2000 }]);
  assert.strictEqual(code(() => read3mfModel(lying)), "ZIP_CORRUPT");
  // An encrypted entry (general-purpose bit 0)
  const enc = buildZip([{ name: "3D/3dmodel.model", data: model }]);
  const cen = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(1, cen + 8);
  assert.strictEqual(code(() => inspectZip(enc)), "ZIP_ENCRYPTED");
});

test("content check: each format by its structure, not its name", () => {
  const f = (name, data) => { const p = path.join(tmp, name); fs.writeFileSync(p, data); return p; };
  const stl = binaryStl(10);
  assert.strictEqual(contentMatchesExtension(f("a.stl", stl), ".stl"), true);
  assert.strictEqual(contentMatchesExtension(f("a2.stl", Buffer.from("solid part\n facet normal 0 0 1\n")), ".stl"), true);
  assert.strictEqual(contentMatchesExtension(f("b.stl", Buffer.concat([stl, Buffer.alloc(5000)])), ".stl"), false, "trailing bulk after the triangles");
  assert.strictEqual(contentMatchesExtension(f("c.stl", stl.subarray(0, stl.length - 10)), ".stl"), false, "shorter than the header's count");
  assert.strictEqual(contentMatchesExtension(f("d.stl", Buffer.from("solid prose, and then nothing a mesh would have: just words that go on and on and on and on and on and on")), ".stl"), false);
  assert.strictEqual(contentMatchesExtension(f("e.step", Buffer.from("ISO-10303-21;\nHEADER;")), ".step"), true);
  assert.strictEqual(contentMatchesExtension(f("e2.step", Buffer.from("PK\u0003\u0004ISO")), ".step"), false);
  assert.strictEqual(contentMatchesExtension(f("g.3mf", Buffer.from("PK\u0003\u0004rest")), ".3mf"), true);
  assert.strictEqual(contentMatchesExtension(f("g2.3mf", Buffer.from("PK\u0005\u0006rest")), ".3mf"), false);
  assert.strictEqual(contentMatchesExtension(f("h.igs", Buffer.from(`${"".padEnd(72)}S      1\n`)), ".igs"), true);
  assert.strictEqual(contentMatchesExtension(f("h2.igs", Buffer.from("S 1 this has an S and a space but is not IGES\n")), ".igs"), false, "the old check accepted any text with 'S '");
  assert.strictEqual(contentMatchesExtension(f("i.dxf", Buffer.from("0\nSECTION\n2\nHEADER\n")), ".dxf"), true);
  assert.strictEqual(contentMatchesExtension(f("i2.dxf", Buffer.from("AC1027\u0000\u0000binary dwg")), ".dxf"), false);
  assert.strictEqual(contentMatchesExtension(f("j.exe", stl), ".exe"), false, "no validator, no pass");
  assert.strictEqual(contentMatchesExtension(path.join(tmp, "missing.stl"), ".stl"), false);
  assert.strictEqual(contentMatchesExtension(path.join(live(), "server", "security", "fixtures", "box_hole.igs"), ".igs"), true, "a real IGES from OpenCascade");
});
function live() { return path.join(__dirname, "..", ".."); }

test("safe file names: a label, never a path", () => {
  const n = guards.safeFileName;
  assert.strictEqual(n("bracket.stl"), "bracket.stl");
  assert.strictEqual(n("My Bracket (rev B) - 6061.step"), "My Bracket (rev B) - 6061.step");
  assert.strictEqual(n("../../etc/passwd.stl"), "passwd.stl");
  assert.strictEqual(n("..\\..\\windows\\evil.stl"), "evil.stl");
  assert.strictEqual(n("C:\\Users\\me\\part.stl"), "part.stl");
  assert.strictEqual(n('x"; filename*=UTF-8\'\'evil.exe .stl'), "x_; filename_=UTF-8''evil.exe .stl");
  assert.strictEqual(n("a\r\nSet-Cookie: x=1.stl"), "aSet-Cookie_ x=1.stl");
  assert.strictEqual(n("<img src=x onerror=alert(1)>.stl"), "_img src=x onerror=alert(1)_.stl");
  assert.strictEqual(n("...hidden.stl"), "hidden.stl");
  assert.strictEqual(n("part\u202egpj.stl"), "partgpj.stl", "right-to-left override removed");
  assert.strictEqual(n(""), "file");
  assert.strictEqual(n(null, "drawing.pdf"), "drawing.pdf");
  assert.strictEqual(n(`${"a".repeat(400)}.stl`).length, 255);
  assert.ok(n(`${"a".repeat(400)}.stl`).endsWith(".stl"), "the extension survives the cut");
});

test("daily byte budget: per client, rolling 24 hours, bounded memory", () => {
  withEnv({ UPLOAD_DAILY_MB_PER_IP: "10" }, () => {
    guards.budget.reset();
    const t0 = 1700000000000;
    guards.budget.add("a", 6 * MB, t0);
    assert.strictEqual(guards.budget.remaining("a", t0 + 1000), 4 * MB);
    assert.strictEqual(guards.budget.remaining("b", t0 + 1000), 10 * MB, "another client has its own budget");
    guards.budget.add("a", 6 * MB, t0 + 2000);
    assert.strictEqual(guards.budget.remaining("a", t0 + 3000), 0);
    assert.strictEqual(guards.budget.remaining("a", t0 + 24 * 3600 * 1000 + 1), 10 * MB, "a day later the budget is whole again");
    guards.budget.prune(t0 + 25 * 3600 * 1000);
    assert.strictEqual(guards.budget.windows.size, 0, "finished windows are dropped");
    const max = guards.budget.MAX_KEYS;
    guards.budget.MAX_KEYS = 100;
    for (let i = 0; i < 1000; i++) guards.budget.add(`k${i}`, 1, t0 + i);
    assert.ok(guards.budget.windows.size <= 100, `the table is capped (${guards.budget.windows.size})`);
    guards.budget.MAX_KEYS = max;
    guards.budget.reset();
  });
});

test("admit(): refuses on Content-Length before anything is read — too large, over budget, storage full, database full", () => {
  const call = (opt, headers, ip = "203.0.113.5") => {
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    const req = { headers, ip };
    guards.admit(opt)(req, res, () => { passed = true; });
    return { passed, res, req };
  };
  withEnv({ UPLOAD_DAILY_MB_PER_IP: "10", UPLOAD_DIR_MAX_MB: "20", DB_MAX_MB: "16" }, () => {
    guards.budget.reset(); guards.storage.invalidate();
    const ok = call({}, { "content-length": String(MB) });
    assert.strictEqual(ok.passed, true);
    assert.strictEqual(ok.req.uploadClientKey, "203.0.113.5");

    const big = call({ maxRequestBytes: () => 5 * MB }, { "content-length": String(6 * MB) });
    assert.deepStrictEqual([big.passed, big.res.code, big.res.body.code], [false, 413, "request-too-large"]);
    assert.strictEqual(big.res.headers.Connection, "close", "the body is not read");

    const over = call({}, { "content-length": String(11 * MB) });
    assert.deepStrictEqual([over.passed, over.res.code, over.res.body.code], [false, 429, "daily-upload-limit"]);

    // chargeDeclared (the RFQ form): what was declared is counted at the door
    for (let i = 0; i < 2; i++) assert.strictEqual(call({ chargeDeclared: true }, { "content-length": String(4 * MB) }, "203.0.113.6").passed, true);
    assert.strictEqual(call({ chargeDeclared: true }, { "content-length": String(4 * MB) }, "203.0.113.6").res.code, 429);

    // storage: 19 MB on disk + 2 MB incoming > 20 MB
    fs.mkdirSync(path.join(process.env.QUOTING_DATA_DIR, "quote-drawings"), { recursive: true });
    const filler = path.join(process.env.QUOTING_DATA_DIR, "quote-drawings", "filler.pdf");
    fs.writeFileSync(filler, Buffer.alloc(19 * MB));
    guards.storage.invalidate();
    const { result: full, lines } = silently(() => call({}, { "content-length": String(2 * MB) }, "203.0.113.7"));
    assert.deepStrictEqual([full.passed, full.res.code, full.res.body.code], [false, 503, "storage-full"]);
    assert.ok(lines.some((l) => /UPLOAD STORAGE FULL/.test(l) && /UPLOAD_DIR_MAX_MB/.test(l)), "the refusal is logged with what to do about it");
    assert.ok(!/MB|disk|storage/i.test(full.res.body.error), "the customer is not told about our disk");
    // under the ceiling but past the warning line: allowed, with a warning in the log
    fs.writeFileSync(filler, Buffer.alloc(17 * MB));
    guards.storage.invalidate(); guards.storage.lastWarnAt = 0;
    const { result: warn, lines: warnLines } = silently(() => call({}, { "content-length": "1000" }, "203.0.113.8"));
    assert.strictEqual(warn.passed, true);
    assert.ok(warnLines.some((l) => /upload storage at 85%/.test(l)), warnLines.join("|"));
    fs.unlinkSync(filler);
    guards.storage.invalidate();

    // database ceiling: only for routes that add geometry rows
    const realSize = guards.database.size;
    guards.database.size = () => 17 * MB;
    const { result: dbFull, lines: dbLines } = silently(() => call({ addsRows: true }, { "content-length": "1000" }, "203.0.113.9"));
    assert.deepStrictEqual([dbFull.passed, dbFull.res.code, dbFull.res.body.code], [false, 503, "storage-full"]);
    assert.ok(dbLines.some((l) => /DATABASE FULL/.test(l)));
    assert.strictEqual(silently(() => call({}, { "content-length": "1000" }, "203.0.113.9")).result.passed, true, "a drawing upload adds no geometry row");
    guards.database.size = realSize;
    guards.budget.reset();
  });
});

test("drawing sweep: files no quote, order or request refers to are removed after a day; referenced ones never", () => {
  const dir = path.join(tmp, "drawings");
  fs.mkdirSync(dir, { recursive: true });
  const old = Date.now() / 1000 - 3 * 24 * 3600;
  const mk = (name, aged) => { const p = path.join(dir, name); fs.writeFileSync(p, "x"); if (aged) fs.utimesSync(p, old, old); return p; };
  const onQuote = mk("on-quote.pdf", true), onOrder = mk("on-order.pdf.enc", true), onRfq = mk("on-rfq.png", true);
  mk("orphan-old.pdf", true); mk("orphan-new.pdf", false);
  const table = (rows) => ({ getAll: () => rows });
  const models = { quotesDB: table([{ drawingPath: onQuote }, { drawingPath: "" }]), ordersDB: table([{ drawingPath: onOrder }]), rfqsDB: table([{ drawingPath: onRfq }, {}]) };
  assert.deepStrictEqual([...retention.referencedDrawings(models)].sort(), ["on-order.pdf.enc", "on-quote.pdf", "on-rfq.png"]);
  assert.strictEqual(retention.sweepDrawings([dir, path.join(tmp, "no-such-dir")], models), 1);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["on-order.pdf.enc", "on-quote.pdf", "on-rfq.png", "orphan-new.pdf"]);
});

run(() => fs.rmSync(tmp, { recursive: true, force: true }));
