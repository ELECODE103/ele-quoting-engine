/**
 * Part payloads in files (server report O1): a part's preview mesh and large
 * geometry detail live under data/part-payloads, not in its database row.
 * What is proven here:
 *   - what goes where, and that what comes back is what the database gave before
 *     (same values, same key order), so prices cannot move;
 *   - files are written whole, owner-only, encrypted when a key is set, counted
 *     against the storage ceiling, deleted with the row, and swept when orphaned;
 *   - the startup migration moves existing rows' payloads out, shrinks the file,
 *     can be repeated, and leaves a row alone when its file cannot be written.
 * Keys are random strings made here at run time.
 * Run: node server/models/partPayloads.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Part payloads in files");
const root = path.join(__dirname, "..", "..");
const partsDir = path.join(root, "tools", "vet-quotes", "parts");
let h, payloads, dataDir, payloadDir;
const ENV_KEYS = ["NORD_FILE_ENC_KEY", "NORD_FILE_ENC_KEY_PREVIOUS", "PART_INLINE_MESH_KB", "PART_INLINE_GEOMETRY_KB", "UPLOAD_DIR_MAX_MB", "UPLOAD_DIR_RESERVED_PERCENT"];
const withEnv = async (env, fn) => {
  const keep = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    payloads.clearCacheForTests();
    require("../security/uploadGuards").storage.invalidate();
  }
};
const files = () => fs.readdirSync(payloadDir).sort();
const filesOf = (id) => files().filter((f) => f.startsWith(id));
const upload = async (name, data, fields = {}) => {
  const r = await h.form("/api/upload", fields, { files: { name, data } });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.parts.length, 1, JSON.stringify(r.body.errors));
  return r.body.parts[0];
};
// A mesh big enough to leave the row: n triangles' worth of made-up vertices.
const bigGeometry = (n = 4000) => ({
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 }, width: 10, height: 20, depth: 30 },
  surfaceArea: 2200.5, volume: 6000.25, triangleCount: n, units: "mm",
  features: { holes: [{ d: 5, depth: 10 }], confidence: 0.9 },
  meshData: { positions: Array.from({ length: n * 9 }, (_, i) => Math.fround(Math.sin(i) * 100)), triangleCount: n },
  legacy: { note: "kept after the mesh, to show key order survives" },
});

test("setup", async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "se-payload-"));
  process.env.QUOTING_DATA_DIR = dataDir;
  for (const k of ENV_KEYS) delete process.env[k];
  h = await start({ turnstile: "off" });
  payloads = require("./partPayloads");
  payloadDir = payloads.dir();
  assert.strictEqual(payloadDir, path.join(dataDir, "part-payloads"));
});

test("what stays in the row: a small mesh and ordinary geometry; a large mesh and oversized detail go to files", async () => {
  const small = { volume: 8, meshData: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangleCount: 1 }, units: "mm" };
  assert.deepStrictEqual(payloads.split(small), { row: small, meshJson: null, geometryJson: null });
  const flat = { volume: 0, profile2d: { loops: [] }, meshData: { positions: [], triangleCount: 0 } };
  assert.deepStrictEqual(payloads.split(flat), { row: flat, meshJson: null, geometryJson: null }, "a DXF has no mesh to move");
  for (const notGeometry of [null, undefined, "text", 5, []]) assert.deepStrictEqual(payloads.split(notGeometry), { row: notGeometry, meshJson: null, geometryJson: null });

  const g = bigGeometry();
  const s = payloads.split(g);
  assert.strictEqual(s.meshJson, JSON.stringify(g.meshData), "the mesh file is exactly the mesh's JSON");
  assert.strictEqual(s.geometryJson, null, "the rest fits in the row");
  assert.deepStrictEqual(s.row.meshData, { positions: [], triangleCount: 4000 }, "the row keeps a stub: same key, no vertices");
  assert.deepStrictEqual(Object.keys(s.row), Object.keys(g), "same keys in the same order");
  assert.ok(JSON.stringify(s.row).length < 600, `the row's geometry is ${JSON.stringify(s.row).length} bytes`);
  assert.strictEqual(g.meshData.positions.length, 36000, "the caller's object is not modified");

  // Oversized detail (hundreds of holes, a DXF's loops): the file gets all of it, the row a summary.
  const heavy = { ...bigGeometry(), features: { holes: Array.from({ length: 3000 }, (_, i) => ({ id: i, d: 5.5, x: i * 1.25, y: i * 2.5, depth: 12.7, through: true })) }, profile2d: { units: { unit: "mm" }, loops: Array.from({ length: 800 }, (_, i) => ({ role: "hole", pts: Array.from({ length: 24 }, (_, j) => [i + j / 10, j]) })) } };
  const hs = payloads.split(heavy);
  assert.ok(hs.meshJson && hs.geometryJson);
  assert.deepStrictEqual(JSON.parse(hs.geometryJson), JSON.parse(JSON.stringify({ ...heavy, meshData: { positions: [], triangleCount: 4000 } })), "the geometry file is the whole geometry with the mesh stubbed");
  assert.deepStrictEqual(Object.keys(JSON.parse(hs.geometryJson)), Object.keys(heavy), "in the original key order");
  assert.deepStrictEqual([hs.row.volume, hs.row.surfaceArea, hs.row.triangleCount, hs.row.units, hs.row.boundingBox.width], [6000.25, 2200.5, 4000, "mm", 10], "the row keeps the scalars and the bounding box");
  // Of the drawing the row keeps only its size and units (so a DXF is still recognisable as one from its row); no loops.
  assert.deepStrictEqual(hs.row.profile2d, { bbox: heavy.profile2d.bbox, units: { unit: "mm" }, detail: "file" });
  assert.ok(!("features" in hs.row) && !JSON.stringify(hs.row).includes("loops") && JSON.stringify(hs.row).length < 2000, "and none of the bulk");
  // The thresholds are the documented settings.
  await withEnv({ PART_INLINE_MESH_KB: "1024", PART_INLINE_GEOMETRY_KB: "4096" }, async () => {
    assert.deepStrictEqual(payloads.split(heavy), { row: heavy, meshJson: null, geometryJson: null }, "raised limits keep everything inline");
  });
});

test("store and read back: the row is small, the files hold the rest, and what comes back is what the database used to give", async () => {
  const { partsDB } = h.models;
  const g = bigGeometry();
  const before = fs.statSync(process.env.QUOTING_DB_PATH).size;
  const part = partsDB.insert({ fileName: "big.stl", storedName: "x.stl", fileSize: 123, geometry: g, dfm: { summary: "ok" } });
  assert.ok(part.id && part.geometry === g, "insert answers with the part and the geometry it was given");
  const grew = fs.statSync(process.env.QUOTING_DB_PATH).size - before;
  assert.ok(grew < 16 * 1024, `the database grew by ${grew} bytes for a part whose mesh is ${JSON.stringify(g.meshData).length} bytes`);
  assert.deepStrictEqual(filesOf(part.id), [`${part.id}.mesh.json`]);
  const meshFile = path.join(payloadDir, `${part.id}.mesh.json`);
  assert.strictEqual(fs.readFileSync(meshFile, "utf8"), JSON.stringify(g.meshData));
  assert.strictEqual(fs.statSync(meshFile).mode & 0o777, 0o600, "owner-only");
  assert.ok(!files().some((f) => f.startsWith(".tmp-")), "no temporary file is left");

  // What the old code path gave: the geometry after a JSON round trip (a database row is JSON text).
  const asStoredBefore = JSON.parse(JSON.stringify(g));
  const withMesh = partsDB.getById(part.id, { mesh: true });
  assert.deepStrictEqual(withMesh.geometry, asStoredBefore);
  assert.strictEqual(JSON.stringify(withMesh.geometry), JSON.stringify(asStoredBefore), "byte for byte, key order included");
  // Pricing and DFM never read the vertex list: they get everything else, unchanged, in the same order.
  const forPricing = partsDB.getById(part.id);
  assert.strictEqual(JSON.stringify(forPricing.geometry), JSON.stringify({ ...asStoredBefore, meshData: { positions: [], triangleCount: 4000 } }));
  assert.deepStrictEqual([forPricing.meshBytes, forPricing.detailBytes, forPricing.payloadError, forPricing.meshError], [fs.statSync(meshFile).size, 0, undefined, undefined]);
  assert.deepStrictEqual(forPricing.dfm, { summary: "ok" });
  // Lists read the rows: no mesh comes along.
  const listed = partsDB.getAll().find((p) => p.id === part.id);
  assert.deepStrictEqual(listed.geometry.meshData, { positions: [], triangleCount: 4000 });
  assert.strictEqual(listed.geometry.volume, 6000.25);

  // A new geometry (a DXF re-read at another scale) replaces the files; one without a mesh leaves none behind.
  const g2 = bigGeometry(3000);
  partsDB.update(part.id, { geometry: g2 });
  assert.strictEqual(JSON.stringify(partsDB.getById(part.id, { mesh: true }).geometry), JSON.stringify(g2));
  partsDB.update(part.id, { geometry: { volume: 1, meshData: { positions: [], triangleCount: 0 } } });
  assert.deepStrictEqual(filesOf(part.id), [], "the mesh file went with the mesh");
  assert.deepStrictEqual(partsDB.getById(part.id, { mesh: true }).geometry, { volume: 1, meshData: { positions: [], triangleCount: 0 } });
  assert.strictEqual(partsDB.getById(part.id).meshBytes, 0);
  // An update that does not touch the geometry does not touch the files.
  partsDB.update(part.id, { geometry: g });
  const mtime = fs.statSync(meshFile).mtimeMs;
  partsDB.update(part.id, { dfm: { summary: "again" } });
  assert.strictEqual(fs.statSync(meshFile).mtimeMs, mtime);
  assert.strictEqual(partsDB.update("00000000-0000-4000-8000-000000000000", { geometry: g }), null, "no row, no file");
  assert.deepStrictEqual(filesOf("00000000-0000-4000-8000-000000000000"), []);

  // Deleted with the row.
  assert.strictEqual(partsDB.delete(part.id), true);
  assert.deepStrictEqual(filesOf(part.id), []);
  assert.strictEqual(partsDB.getById(part.id), null);
});

test("what is kept of an upload counts against the sender's daily budget: the file and its payload", async () => {
  const guards = require("../security/uploadGuards");
  const stl = fs.readFileSync(path.join(partsDir, "star_wheel.stl"));
  h.ip = "203.0.113.200";
  try {
    const before = guards.budget.used("203.0.113.200");
    const part = await upload("star_wheel.stl", stl);
    const meshBytes = fs.statSync(path.join(payloadDir, `${part.partId}.mesh.json`)).size;
    const charged = guards.budget.used("203.0.113.200") - before;
    assert.ok(meshBytes > 2 * stl.length, `the mesh file (${meshBytes} bytes) is larger than the upload (${stl.length} bytes)`);
    assert.ok(charged >= stl.length + meshBytes, `charged ${charged} bytes for a ${stl.length}-byte file and a ${meshBytes}-byte mesh`);
  } finally { h.ip = ""; }
});

test("a part id is never a path: ids that are not our UUIDs are hashed, and no file leaves the folder", async () => {
  for (const id of ["../../etc/passwd", "..\\..\\x", "a/b", "", "quoting.db", "%2e%2e", "x".repeat(500)]) {
    const stem = payloads.stem(id);
    assert.ok(/^x[0-9a-f]{40}$/.test(stem), `${id.slice(0, 20)} → ${stem}`);
    assert.strictEqual(payloads.exists(id, "mesh"), false);
  }
  assert.strictEqual(payloads.stem("0B6F2C1E-AAAA-4BBB-8CCC-1234567890AB"), "0b6f2c1e-aaaa-4bbb-8ccc-1234567890ab");
  assert.throws(() => payloads.write("0b6f2c1e-aaaa-4bbb-8ccc-1234567890ab", "../evil", "{}"), /unknown kind/);
  const tree = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else tree.push(path.relative(dataDir, p)); } })(dataDir);
  assert.ok(tree.every((f) => /^(uploads|quote-drawings|rfq-drawings|part-payloads)\//.test(f) || /^quoting\.db/.test(f)), tree.join(", "));
});

test("a write that fails leaves nothing: no temporary file, no half-written payload, no row", async () => {
  const { partsDB } = h.models;
  const id = crypto.randomUUID();
  // Something is in the way of the mesh file's name, so the final rename cannot happen.
  fs.mkdirSync(path.join(payloadDir, `${id}.mesh.json`));
  const quiet = console.error; console.error = () => {};
  try {
    assert.throws(() => partsDB.insert({ id, fileName: "blocked.stl", geometry: bigGeometry() }), (err) => err.name === "PayloadError" && err.code === "write-failed");
  } finally { console.error = quiet; }
  assert.strictEqual(partsDB.getById(id), null, "no row was written for a part whose payload was not stored");
  assert.ok(!files().some((f) => f.startsWith(".tmp-")), "the temporary file was removed");
  fs.rmdirSync(path.join(payloadDir, `${id}.mesh.json`));
  // And through the upload route: the customer is told, the CAD file is not kept.
  const stl = fs.readFileSync(path.join(partsDir, "star_wheel.stl"));
  const real = partsDB.insert.bind(partsDB);
  partsDB.insert = () => { throw new payloads.PayloadError("write-failed", "disk"); };
  const uploadsBefore = fs.readdirSync(path.join(dataDir, "uploads")).length;
  console.error = () => {};
  let r;
  try { r = await h.form("/api/upload", {}, { files: { name: "star_wheel.stl", data: stl } }); } finally { partsDB.insert = real; console.error = quiet; }
  assert.deepStrictEqual([r.status, r.body.parts.length, r.body.errors[0].code], [200, 0, "store-failed"]);
  assert.ok(/email it to/.test(r.body.errors[0].error) && !/disk|payload|ENOSPC/i.test(r.body.errors[0].error));
  assert.strictEqual(fs.readdirSync(path.join(dataDir, "uploads")).length, uploadsBefore, "the upload was deleted");
});

test("the storage ceiling counts payload files and refuses a part that would cross it", async () => {
  const { partsDB } = h.models;
  const guards = require("../security/uploadGuards");
  assert.ok(guards.STORAGE_DIRS.includes(payloadDir), "data/part-payloads is one of the folders under the ceiling");
  assert.ok(!guards.DRAWING_DIRS.includes(payloadDir), "and is not swept as a drawing folder");
  const filler = path.join(payloadDir, ".tmp-filler");
  // UPLOAD_DIR_RESERVED_PERCENT=0: this test is about the ceiling itself. The share kept back for
  // signed-in customers (visitors without an account stop at 85 %) is tested in services/storagePressure.test.js.
  await withEnv({ UPLOAD_DIR_MAX_MB: "10", UPLOAD_DIR_RESERVED_PERCENT: "0" }, async () => {
    // Fill the folders to within `room` bytes of a 10 MB ceiling, whatever earlier tests left in them.
    const leave = (room) => { try { fs.unlinkSync(filler); } catch { /* first time */ } fs.writeFileSync(filler, Buffer.alloc(10 * 1024 * 1024 - guards.storage.scan() - room)); guards.storage.invalidate(); };
    leave(20000);
    const quiet = console.error; const lines = []; console.error = (...a) => lines.push(a.join(" "));
    try {
      assert.throws(() => partsDB.insert({ fileName: "over.stl", geometry: bigGeometry() }), (err) => err.name === "PayloadError" && err.code === "storage-full");
      assert.ok(lines.some((l) => /UPLOAD STORAGE FULL/.test(l) && /data\/part-payloads/.test(l)), "the refusal is logged, naming the folder");
      assert.strictEqual(partsDB.getAll().filter((p) => p.fileName === "over.stl").length, 0);
      // Through the upload route the customer gets the same words as for a full upload folder.
      const stl = fs.readFileSync(path.join(partsDir, "star_wheel.stl"));
      leave(400000); // room for the 300 kB STL, not for its 850 kB mesh
      const r = await h.form("/api/upload", {}, { files: { name: "star_wheel.stl", data: stl } });
      assert.deepStrictEqual([r.status, r.body.parts.length, r.body.errors[0].code], [200, 0, "storage-full"], r.text.slice(0, 200));
      assert.strictEqual(r.body.errors[0].error, guards.FULL_MESSAGE);
    } finally { console.error = quiet; fs.unlinkSync(filler); }
  });
  // With room again, the same part is stored.
  const ok = partsDB.insert({ fileName: "fits.stl", geometry: bigGeometry() });
  assert.strictEqual(filesOf(ok.id).length, 1);
  partsDB.delete(ok.id);
});

test("with a file-encryption key: payloads are encrypted before they touch the disk, and a lost or changed key fails safely", async () => {
  const { partsDB } = h.models;
  const keyA = crypto.randomBytes(36).toString("base64");
  const keyB = crypto.randomBytes(36).toString("base64");
  const g = { ...bigGeometry(), marker: "PROPRIETARY-GEOMETRY-MARKER-5512", features: { holes: Array.from({ length: 4000 }, (_, i) => ({ id: i, d: 6.35, x: i, y: i * 2, depth: 9.5 })) } };
  let part;
  const quiet = console.error; const lines = []; console.error = (...a) => lines.push(a.join(" "));
  try {
    await withEnv({ NORD_FILE_ENC_KEY: keyA }, async () => {
      part = partsDB.insert({ fileName: "secret.step", geometry: g });
      assert.deepStrictEqual(filesOf(part.id), [`${part.id}.geometry.json.enc`, `${part.id}.mesh.json.enc`]);
      for (const f of filesOf(part.id)) {
        const bytes = fs.readFileSync(path.join(payloadDir, f));
        assert.strictEqual(bytes.subarray(0, 4).toString("latin1"), "SEF1", "the same format as the customer's own files");
        assert.ok(!bytes.includes(Buffer.from("positions")) && !bytes.includes(Buffer.from("PROPRIETARY-GEOMETRY-MARKER-5512")) && !bytes.includes(Buffer.from('"holes"')), `${f} holds no plaintext`);
        assert.strictEqual(fs.statSync(path.join(payloadDir, f)).mode & 0o777, 0o600);
      }
      assert.ok(!files().some((f) => f.startsWith(".tmp-") || (f.startsWith(part.id) && !f.endsWith(".enc"))), "no plaintext copy, no temporary file");
      assert.strictEqual(JSON.stringify(partsDB.getById(part.id, { mesh: true }).geometry), JSON.stringify(g), "reads back whole");
      // The database row holds neither the mesh nor the detail.
      const dbBytes = fs.readFileSync(process.env.QUOTING_DB_PATH);
      assert.ok(!dbBytes.includes(Buffer.from('"holes":[{"id":0')), "the detail is not in the database file");
    });
    // Key changed: the part comes back flagged, never with wrong or partial data, and is not priced.
    await withEnv({ NORD_FILE_ENC_KEY: keyB }, async () => {
      const p = partsDB.getById(part.id, { mesh: true });
      assert.deepStrictEqual([p.payloadError, p.meshError], ["wrong-key", "wrong-key"], "neither file opens under another key, and each says why");
      assert.ok(!p.geometry.features && p.geometry.volume === 6000.25, "what is left is the row's summary");
      const mat = h.models.materialsDB.getAll().find((m) => m.process === "cnc" && m.active);
      // (The part was put in the table directly, so its edit key is worked out here; a part without its key is simply "not found".)
      const q = await h.post("/api/quote", { parts: [{ partId: part.id, editKey: require("../security/tokens").partEditKey(part.id), materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" }] });
      assert.deepStrictEqual([q.status, q.body.code], [409, "part-data-unavailable"]);
      assert.ok(/Upload it again/.test(q.body.error) && !/key|decrypt|payload/i.test(q.body.error), q.body.error);
      // Listing the old key as "previous" brings it back.
      process.env.NORD_FILE_ENC_KEY_PREVIOUS = keyA;
      payloads.clearCacheForTests();
      assert.strictEqual(JSON.stringify(partsDB.getById(part.id, { mesh: true }).geometry), JSON.stringify(g));
      // A re-store under the new key replaces the file written under the old one.
      partsDB.update(part.id, { geometry: g });
      delete process.env.NORD_FILE_ENC_KEY_PREVIOUS;
      payloads.clearCacheForTests();
      assert.strictEqual(JSON.stringify(partsDB.getById(part.id, { mesh: true }).geometry), JSON.stringify(g));
    });
    // Key lost: flagged, and the ciphertext is never handed out as data.
    await withEnv({}, async () => {
      const p = partsDB.getById(part.id, { mesh: true });
      assert.strictEqual(p.payloadError, "no-key");
      assert.ok(!JSON.stringify(p).includes("SEF1"));
    });
    // A damaged file is "corrupt", not garbage.
    await withEnv({ NORD_FILE_ENC_KEY: keyB }, async () => {
      const f = path.join(payloadDir, `${part.id}.geometry.json.enc`);
      const bytes = fs.readFileSync(f); bytes[bytes.length - 5] ^= 0xff; fs.writeFileSync(f, bytes);
      assert.strictEqual(partsDB.getById(part.id).payloadError, "corrupt");
    });
    assert.ok(lines.some((l) => /Part payload unreadable \(wrong-key\)/.test(l) && /file-encryption\.md/.test(l)), "the reason is logged once, pointing at the guide");
    assert.ok(!lines.join("\n").includes(keyA) && !lines.join("\n").includes(keyB), "no key in the log");
  } finally { console.error = quiet; }
  // A key set later: new writes are encrypted and the plain copy of the same payload goes.
  const plain = partsDB.insert({ fileName: "later.stl", geometry: bigGeometry() });
  assert.deepStrictEqual(filesOf(plain.id), [`${plain.id}.mesh.json`]);
  await withEnv({ NORD_FILE_ENC_KEY: keyA }, async () => {
    assert.strictEqual(partsDB.getById(plain.id, { mesh: true }).geometry.meshData.positions.length, 36000, "a plain file from before the key was set still reads");
    partsDB.update(plain.id, { geometry: bigGeometry() });
    // With a key set nothing of the shape stays in the (unencrypted) database row: the detail has its own encrypted file too.
    assert.deepStrictEqual(filesOf(plain.id), [`${plain.id}.geometry.json.enc`, `${plain.id}.mesh.json.enc`]);
    assert.ok(!JSON.stringify(partsDB.getRow(plain.id).geometry).includes('"holes"'), "the row keeps numbers only");
  });
  partsDB.delete(plain.id); partsDB.delete(part.id);
});

test("prices do not move: a part priced from files gives the same quote as the same part priced from the row", async () => {
  const mats = h.models.materialsDB.getAll();
  const cnc = mats.find((m) => m.process === "cnc" && m.active);
  const routing = mats.find((m) => m.process === "routing" && m.active && m.thicknesses?.length);
  const writer = require("../geometry/dxf/writer");
  const ents = [writer.rect(0, 0, 420, 420)];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) ents.push(writer.circle(10 + i * 10, 10 + j * 10, 2));
  const cases = [
    ["a dense STL (mesh in a file)", "star_wheel.stl", fs.readFileSync(path.join(partsDir, "star_wheel.stl")), {}, (id) => ({ partId: id, materialSlug: cnc.slug, quantity: 5, process: "cnc", subProcess: "milling" }), ["mesh"]],
    ["a STEP plate (mesh in a file)", "dxf_slotted_guide.step", fs.readFileSync(path.join(partsDir, "dxf_slotted_guide.step")), {}, (id) => ({ partId: id, materialSlug: cnc.slug, quantity: 10, process: "cnc", subProcess: "milling" }), ["mesh"]],
    ["a 1,600-hole DXF (loops and features in a file)", "perforated.dxf", Buffer.from(writer.dxf({ entities: ents })), { process: "routing" }, (id) => ({ partId: id, materialSlug: routing.slug, thicknessMm: routing.thicknesses[0].mm, quantity: 3, process: "routing" }), ["geometry"]],
  ];
  const scrub = (body) => JSON.stringify(body, (k, v) => (["quoteId", "partId", "expiresAt", "shipBy", "createdAt", "id"].includes(k) ? undefined : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, "ID");
  for (const [what, name, data, fields, config, kinds] of cases) {
    // As it is stored now.
    const stored = await upload(name, data, fields);
    assert.deepStrictEqual(filesOf(stored.partId).map((f) => f.split(".")[1]).sort(), kinds, `${what}: files ${filesOf(stored.partId)}`);
    if (name.endsWith(".dxf")) assert.strictEqual((await h.raw("POST", `/api/parts/${stored.partId}/units`, { json: { units: "mm" }, headers: { "X-Part-Key": stored.editKey } })).status, 200);
    const fromFiles = await h.post("/api/quote", { parts: [config(stored.partId)] });
    assert.strictEqual(fromFiles.status, 200, `${what}: ${fromFiles.text.slice(0, 200)}`);
    // The same file stored the way it was before this change: everything in the row.
    let inline;
    await withEnv({ PART_INLINE_MESH_KB: "1024", PART_INLINE_GEOMETRY_KB: "4096" }, async () => {
      inline = await upload(name, data, fields);
      if (name.endsWith(".dxf")) assert.strictEqual((await h.raw("POST", `/api/parts/${inline.partId}/units`, { json: { units: "mm" }, headers: { "X-Part-Key": inline.editKey } })).status, 200);
    });
    assert.deepStrictEqual(filesOf(inline.partId), [], `${what}: the comparison part has no files`);
    const fromRow = await h.post("/api/quote", { parts: [config(inline.partId)] });
    assert.strictEqual(fromRow.status, 200, fromRow.text.slice(0, 200));
    assert.strictEqual(scrub(fromFiles.body), scrub(fromRow.body), `${what}: the two quotes differ`);
    assert.ok(fromFiles.body.orderTotal > 0);
    // And the geometry each one prices from is the same, key for key (apart from the recogniser's own
    // stopwatch readings, which differ between any two parses of one file).
    const noClock = (g) => JSON.stringify(g, (k, v) => (k === "timings" ? undefined : v));
    const a = h.models.partsDB.getById(stored.partId, { mesh: true }).geometry;
    const b = h.models.partsDB.getById(inline.partId, { mesh: true }).geometry;
    assert.strictEqual(noClock(a), noClock(b), `${what}: the stored geometry differs`);
    assert.strictEqual(noClock({ ...a, meshData: { ...a.meshData, positions: [] } }), noClock(h.models.partsDB.getById(stored.partId).geometry), `${what}: pricing reads the same geometry, without the vertex list`);
    // Without its geometry file a part is refused, not priced from the summary.
    if (kinds.includes("geometry")) {
      fs.renameSync(path.join(payloadDir, `${stored.partId}.geometry.json`), path.join(dataDir, "moved-away.json"));
      payloads.clearCacheForTests();
      const quiet = console.error; console.error = () => {};
      try {
        const gone = await h.post("/api/quote", { parts: [config(stored.partId)] });
        assert.deepStrictEqual([gone.status, gone.body.code], [409, "part-data-unavailable"]);
      } finally { console.error = quiet; }
      fs.renameSync(path.join(dataDir, "moved-away.json"), path.join(payloadDir, `${stored.partId}.geometry.json`));
      assert.strictEqual(scrub((await h.post("/api/quote", { parts: [config(stored.partId)] })).body), scrub(fromRow.body));
    }
  }
});

test("reopening a quote brings the 3D preview back from its file; if the file is gone the quote still opens, without the preview", async () => {
  const cnc = h.models.materialsDB.getAll().find((m) => m.process === "cnc" && m.active);
  const up = await upload("star_wheel.stl", fs.readFileSync(path.join(partsDir, "star_wheel.stl")));
  // A mesh that lives in a file is not embedded in answers any more (independent review 2026-11-11, C1):
  // the answer says where it is, and the browser fetches it with the part's key.
  assert.deepStrictEqual(up.meshPreview.positions, []);
  const preview = (part) => h.raw("GET", part.mesh.url, { headers: { "X-Part-Key": part.editKey } });
  const fromUpload = await preview(up);
  assert.strictEqual(fromUpload.status, 200);
  assert.ok(fromUpload.body.positions.length > 10000, "the preview route serves the mesh");
  const q = await h.post("/api/quote", { parts: [{ partId: up.partId, materialSlug: cnc.slug, quantity: 1, process: "cnc", subProcess: "milling" }] });
  const session = await h.get(`/api/quote/${q.body.quoteId}/session`);
  assert.strictEqual(session.status, 200);
  const described = session.body.partsById[up.partId];
  assert.deepStrictEqual(described.mesh, up.mesh, "the session names the same preview the upload did");
  assert.deepStrictEqual((await preview({ mesh: described.mesh, editKey: described.editKey })).body, fromUpload.body, "the same vertices the upload's preview had");
  assert.ok(!("meshData" in described.geometry));
  assert.deepStrictEqual(described.geometry.boundingBox, up.geometry.boundingBox);
  // Other answers that carry a part's geometry no longer drag the mesh along.
  const view = await h.get(`/api/quote/${q.body.quoteId}`);
  assert.ok(view.text.length < 60000 && !/"positions":\[[-0-9.]/.test(view.text));
  // An order's answers carry the part's measurements and never a mesh, large or small.
  const buyer = await h.register("orders@buyer.test");
  const cube = await upload("cube_20mm.stl", fs.readFileSync(path.join(partsDir, "cube_20mm.stl")));
  assert.deepStrictEqual(filesOf(cube.partId), [], "a 12-triangle cube's mesh stays in its row");
  const oq = await h.post("/api/quote", { parts: [up, cube].map((p) => ({ partId: p.partId, materialSlug: cnc.slug, quantity: 1, process: "cnc", subProcess: "milling" })) }, buyer);
  const co = await h.post("/api/orders/checkout-session", { quoteId: oq.body.quoteId, shippingName: "A Buyer", shippingAddress: "1 Test St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" }, buyer);
  assert.strictEqual(co.status, 200, co.text);
  const list = await h.get("/api/orders", buyer);
  assert.strictEqual(list.body[0].items.length, 2);
  for (const it of list.body[0].items) {
    assert.ok(it.geometry && it.geometry.boundingBox && !("meshData" in it.geometry), `${it.fileName}: geometry without a mesh`);
  }
  assert.ok(!/"positions"/.test(list.text) && list.text.length < 40000, `the order list is ${list.text.length} bytes`);
  fs.unlinkSync(path.join(payloadDir, `${up.partId}.mesh.json`));
  // (As the buyer from here on: the part became theirs when they priced it signed in, a few lines up, so the
  // visitor who uploaded it no longer opens it with the key alone: security/partAccess.js.)
  const without = await h.get(`/api/quote/${q.body.quoteId}/session`, buyer);
  assert.strictEqual(without.status, 200, "the quote still opens");
  assert.ok(without.body.partsById[up.partId], "and still describes the part");
  const gone = await h.raw("GET", up.mesh.url, { headers: { "X-Part-Key": up.editKey }, token: buyer });
  assert.deepStrictEqual([gone.status, gone.body.code], [404, "preview-unavailable"], "the preview says it is unavailable; nothing else is affected");
  assert.strictEqual((await h.raw("GET", up.mesh.url, { headers: { "X-Part-Key": up.editKey } })).status, 404, "without the account the key alone no longer opens the part at all");
  assert.strictEqual((await h.post("/api/quote", { parts: [{ partId: up.partId, materialSlug: cnc.slug, quantity: 2, process: "cnc", subProcess: "milling" }], quoteId: q.body.quoteId }, buyer)).status, 200, "and it still prices: the mesh is display only");
});

test("retention: payload files go with their part row, and the sweep removes whatever has no row", async () => {
  const { partsDB } = h.models;
  const { sweepRows } = require("../services/rowRetention");
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const abandoned = partsDB.insert({ fileName: "abandoned.stl", geometry: bigGeometry(), createdAt: old });
  const kept = partsDB.insert({ fileName: "kept.stl", geometry: bigGeometry() });
  assert.strictEqual(filesOf(abandoned.id).length, 1);
  const r = sweepRows(h.models);
  assert.ok(r.parts >= 1);
  assert.strictEqual(partsDB.getById(abandoned.id), null);
  assert.deepStrictEqual(filesOf(abandoned.id), [], "row retention took the file with the row");
  assert.strictEqual(filesOf(kept.id).length, 1);

  // Orphans: a payload with no row, a kind its row does not claim, a temp file from a crash, a stray file.
  const ghost = crypto.randomUUID();
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  const strays = [`${ghost}.mesh.json`, `${ghost}.geometry.json.enc`, `${kept.id}.geometry.json`, ".tmp-0011223344556677-x.mesh.json", "notes.txt"];
  for (const name of strays) { fs.writeFileSync(path.join(payloadDir, name), "{}"); fs.utimesSync(path.join(payloadDir, name), hourAgo, hourAgo); }
  const fresh = `${crypto.randomUUID()}.mesh.json`;
  fs.writeFileSync(path.join(payloadDir, fresh), "{}"); // a part being stored this instant: its row is a moment behind
  const before = files().length;
  const swept = partsDB.sweepPayloads();
  assert.strictEqual(swept.removed, strays.length, `removed ${swept.removed}`);
  assert.strictEqual(files().length, before - strays.length);
  for (const name of strays) assert.ok(!fs.existsSync(path.join(payloadDir, name)), name);
  assert.ok(fs.existsSync(path.join(payloadDir, fresh)), "a file younger than the grace period is left");
  assert.ok(fs.existsSync(path.join(payloadDir, `${kept.id}.mesh.json`)), "a file its row claims is kept, whatever its age");
  fs.utimesSync(path.join(payloadDir, `${kept.id}.mesh.json`), hourAgo, hourAgo);
  assert.strictEqual(partsDB.sweepPayloads().removed, 0);
  assert.strictEqual(partsDB.sweepPayloads({ graceMs: 0 }).removed, 1, "with no grace the fresh orphan goes too");
  assert.strictEqual(partsDB.getById(kept.id, { mesh: true }).geometry.meshData.positions.length, 36000);
});

// ─── Migration ───────────────────────────────────────────────────────────────

test("migration: existing rows' payloads move out in one batch, the file shrinks after VACUUM, and a second run changes nothing", async () => {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const migration = require("./partPayloadMigration");
  const db = new SQL.Database();
  // The parts table as every earlier version created it: no payload columns.
  db.run("CREATE TABLE parts (id TEXT PRIMARY KEY, file_name TEXT, stored_name TEXT, file_path TEXT, file_size INTEGER, geometry_json TEXT, dfm_json TEXT, created_at TEXT)");
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ id: crypto.randomUUID(), geometry: bigGeometry(3000 + i * 100) });
  rows.push({ id: crypto.randomUUID(), geometry: { volume: 8, meshData: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangleCount: 1 } } }); // small: stays inline
  rows.push({ id: crypto.randomUUID(), geometry: { volume: 0, profile2d: { loops: [] }, meshData: { positions: [], triangleCount: 0 } } }); // a DXF
  for (const r of rows) db.run("INSERT INTO parts (id, file_name, geometry_json, dfm_json, created_at) VALUES (?, ?, ?, ?, ?)", [r.id, "p.stl", JSON.stringify(r.geometry), '{"summary":"ok"}', "2026-11-01T00:00:00Z"]);
  db.run("INSERT INTO parts (id, file_name, geometry_json) VALUES ('legacy-not-a-uuid', 'odd.stl', ?)", [JSON.stringify(bigGeometry(2500))]);
  db.run("INSERT INTO parts (id, file_name, geometry_json) VALUES (?, 'broken.stl', '{not json')", [crypto.randomUUID()]);
  db.run("INSERT INTO parts (id, file_name, geometry_json) VALUES (?, 'none.stl', NULL)", [crypto.randomUUID()]);
  const sizeBefore = db.export().length;
  const filesBefore = files().length;

  const logs = [];
  const first = migration.apply(db, { log: (l) => logs.push(l), warn: (l) => logs.push(l) });
  assert.deepStrictEqual(first.columns, ["mesh_bytes", "detail_bytes"]);
  assert.deepStrictEqual([first.examined, first.moved, first.meshFiles, first.geometryFiles, first.failed, first.vacuumed], [17, 13, 13, 0, 0, true]);
  const sizeAfter = db.export().length;
  assert.ok(sizeAfter < sizeBefore / 20, `the database went from ${sizeBefore} to ${sizeAfter} bytes`);
  assert.strictEqual(files().length, filesBefore + 13);
  assert.ok(logs.some((l) => /moved 13 preview mesh/.test(l)));
  console.log(`       (17 rows: database ${(sizeBefore / 1e6).toFixed(2)} MB → ${(sizeAfter / 1e6).toFixed(3)} MB)`);

  // Every row reads back, through the same code the server uses, as it was before.
  const one = (sql, params) => { const st = db.prepare(sql); st.bind(params); const row = st.step() ? st.getAsObject() : null; st.free(); return row; };
  const { PartsStore } = require("./partsStore");
  const view = new PartsStore({ tableName: "parts", getById: (id) => { const r = one("SELECT * FROM parts WHERE id = ?", [id]); return r && { id: r.id, geometry: r.geometry_json ? JSON.parse(r.geometry_json) : null, meshBytes: r.mesh_bytes, detailBytes: r.detail_bytes }; } });
  for (const r of [...rows, { id: "legacy-not-a-uuid", geometry: bigGeometry(2500) }]) {
    assert.strictEqual(JSON.stringify(view.getById(r.id, { mesh: true }).geometry), JSON.stringify(r.geometry), `row ${r.id}`);
    const stored = one("SELECT length(geometry_json) AS n, mesh_bytes FROM parts WHERE id = ?", [r.id]);
    assert.ok(stored.n < 2000, `row ${r.id} is ${stored.n} bytes`);
  }
  assert.ok(fs.existsSync(path.join(payloadDir, `${payloads.stem("legacy-not-a-uuid")}.mesh.json`)), "an id that is not a UUID got a hashed file name");
  assert.strictEqual(one("SELECT geometry_json FROM parts WHERE file_name = 'broken.stl'", []).geometry_json, "{not json", "text that is not JSON is left exactly as it was");
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM parts WHERE mesh_bytes IS NULL", []).n, 0, "every row has been looked at");

  // Again: nothing to do, nothing rewritten.
  const mtimes = files().map((f) => fs.statSync(path.join(payloadDir, f)).mtimeMs).join();
  const second = migration.apply(db, { log: (l) => logs.push(l) });
  assert.deepStrictEqual([second.columns, second.examined, second.moved, second.vacuumed], [[], 0, 0, false]);
  assert.strictEqual(files().map((f) => fs.statSync(path.join(payloadDir, f)).mtimeMs).join(), mtimes);
  assert.strictEqual(db.export().length, sizeAfter);
  for (const r of rows) payloads.remove(r.id);
  payloads.remove("legacy-not-a-uuid");
  db.close();
});

test("migration: a row whose file cannot be written stays as it was and is moved at the next start; an interrupted run is simply repeated", async () => {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const migration = require("./partPayloadMigration");
  const make = () => {
    const db = new SQL.Database();
    db.run("CREATE TABLE parts (id TEXT PRIMARY KEY, file_name TEXT, geometry_json TEXT, dfm_json TEXT, created_at TEXT)");
    return db;
  };
  const a = { id: crypto.randomUUID(), geometry: bigGeometry(3000) };
  const b = { id: crypto.randomUUID(), geometry: bigGeometry(3100) };
  const db = make();
  for (const r of [a, b]) db.run("INSERT INTO parts (id, file_name, geometry_json) VALUES (?, 'p.stl', ?)", [r.id, JSON.stringify(r.geometry)]);
  const snapshot = Buffer.from(db.export()); // the database file as it is on disk before the migration saves anything
  fs.mkdirSync(path.join(payloadDir, `${b.id}.mesh.json`)); // b's file cannot be put in place
  const warnings = [];
  const first = migration.apply(db, { log: () => {}, warn: (l) => warnings.push(l) });
  assert.deepStrictEqual([first.moved, first.failed], [1, 1]);
  assert.ok(/1 part\(s\) could not have their payloads moved/.test(warnings[0]) && /tried again at the next start/.test(warnings[0]));
  const get = (d, id) => { const st = d.prepare("SELECT geometry_json, mesh_bytes FROM parts WHERE id = ?"); st.bind([id]); st.step(); const r = st.getAsObject(); st.free(); return r; };
  assert.strictEqual(get(db, b.id).geometry_json, JSON.stringify(b.geometry), "b is untouched: its mesh is still in the row");
  assert.strictEqual(get(db, b.id).mesh_bytes, null);
  assert.ok(get(db, a.id).mesh_bytes > 0);
  assert.ok(!files().some((f) => f.startsWith(".tmp-")));
  fs.rmdirSync(path.join(payloadDir, `${b.id}.mesh.json`));
  const second = migration.apply(db, { log: () => {}, warn: (l) => warnings.push(l) });
  assert.deepStrictEqual([second.examined, second.moved, second.failed], [1, 1, 0], "only b was looked at again");
  assert.strictEqual(fs.readFileSync(path.join(payloadDir, `${b.id}.mesh.json`), "utf8"), JSON.stringify(b.geometry.meshData));

  // A crash after the files were written but before the database was saved: the old file is loaded
  // again (payloads inline) and the same migration runs over it, replacing the files with the same bytes.
  const again = new SQL.Database(snapshot);
  const redo = migration.apply(again, { log: () => {}, warn: () => {} });
  assert.deepStrictEqual([redo.moved, redo.failed], [2, 0]);
  for (const r of [a, b]) assert.strictEqual(fs.readFileSync(path.join(payloadDir, `${r.id}.mesh.json`), "utf8"), JSON.stringify(r.geometry.meshData));
  for (const r of [a, b]) payloads.remove(r.id);
  db.close(); again.close();
});

test("the statements the migration runs name only its own constants", async () => {
  const src = fs.readFileSync(path.join(__dirname, "partPayloadMigration.js"), "utf8");
  const sql = [...src.matchAll(/(?:run|prepare)\(\s*(["`])((?:SELECT|UPDATE|ALTER|PRAGMA|VACUUM|INSERT|DELETE)[^"`]*)\1/g)].map((m) => m[2]);
  assert.ok(sql.length >= 5, `${sql.length} statements`);
  for (const s of sql) for (const m of s.matchAll(/\$\{([^}]+)\}/g)) assert.ok(["table", "name", "type"].includes(m[1].trim()), s);
  assert.ok(/vetted\(table, name, type\)/.test(src));
  const fake = { prepare: () => ({ step: () => false, free() {}, getAsObject: () => ({}), bind() {}, reset() {} }), run() {} };
  assert.doesNotThrow(() => require("./partPayloadMigration").apply(fake, { log: () => {}, warn: () => {} }));
});

run(async () => {
  if (h) await h.stop();
  await require("../parsers/parsePool").pool.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});
