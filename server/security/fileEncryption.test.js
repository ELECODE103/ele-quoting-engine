/**
 * Files at rest, end to end on the real server: with a key every customer
 * file is stored encrypted (CAD uploads, quote drawings, RFQ attachments) and
 * still usable; losing or changing the key fails safely.
 *
 * The keys are random strings made here at run time. They are never written
 * to the repository and the test checks they never reach the server's log.
 * Run: node server/security/fileEncryption.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Files at rest (live server)");
const parts = path.join(live.ROOT, "tools", "vet-quotes", "parts");
const cube = fs.readFileSync(path.join(parts, "cube_20mm.stl"));
const step = fs.readFileSync(path.join(live.ROOT, "server", "geometry", "fixtures", "plate_holes.step"));
const dxf = fs.readFileSync(path.join(parts, "dxf_inch_guard.dxf"));
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n% a drawing with a recognisable line: PROPRIETARY-TITLE-BLOCK-7731\n"), crypto.randomBytes(2000), Buffer.from("\n%%EOF\n")]);
const photo = fs.readFileSync(path.join(live.ROOT, "client", "public", "apple-touch-icon.png"));

const keyA = crypto.randomBytes(36).toString("base64");
const keyB = crypto.randomBytes(36).toString("base64");
const jwtSecret = crypto.randomBytes(32).toString("hex"); // the same across restarts so the admin's token stays valid
const ip = "203.0.113.40";
const state = {};
let s;
const logs = [];
const restart = async (env) => {
  const tmpDir = s.tmp;
  logs.push(s.log());
  await s.stop({ keep: true });
  const keys = s.editKeys; // the visitor's browser still holds its parts' edit keys after the server restarts
  s = await live.start({ tmpDir, env: { JWT_SECRET: jwtSecret, ...env } });
  Object.assign(s.editKeys, keys);
};
const onDisk = (folder) => s.files(folder).map((f) => ({ name: f, bytes: fs.readFileSync(path.join(s.dir(folder), f)) }));
const containsAny = (haystack, needles) => needles.some((n) => haystack.indexOf(n) !== -1);

test("with a key: CAD uploads are stored encrypted and still price, re-read and download", async () => {
  s = await live.start({ env: { JWT_SECRET: jwtSecret, NORD_FILE_ENC_KEY: keyA } });
  assert.ok(/File encryption: on/.test(s.log()), "startup says encryption is on");
  const up = await s.upload([{ name: "cube.stl", data: cube }, { name: "plate.step", data: step }, { name: "guard.dxf", data: dxf }], { ip, fields: { process: "routing" } });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.body.parts.length, 3, JSON.stringify(up.body.errors));
  const stored = onDisk("uploads");
  assert.strictEqual(stored.length, 3);
  for (const f of stored) {
    assert.ok(/^[0-9a-f-]{36}\.(stl|step|dxf)\.enc$/.test(f.name), `${f.name} is an encrypted file under a server name`);
    assert.strictEqual(f.bytes.subarray(0, 4).toString("ascii"), "SEF1");
    assert.ok(!containsAny(f.bytes, [cube.subarray(84, 148), Buffer.from("ISO-10303-21"), Buffer.from("SECTION"), Buffer.from("ENTITIES")]), `${f.name} holds no plaintext`);
  }
  state.cubeId = up.body.parts.find((p) => p.fileName === "cube.stl").partId;
  state.dxfId = up.body.parts.find((p) => p.fileName === "guard.dxf").partId;
  // The uploader's browser holds an edit key for each part; changing a DXF's units needs it (X-Part-Key).
  state.dxfKey = { "X-Part-Key": up.body.parts.find((p) => p.fileName === "guard.dxf").editKey };
  assert.ok(/^[0-9a-f]{40}$/.test(state.dxfKey["X-Part-Key"]), "the upload answer carries the part's edit key");
  assert.strictEqual((await s.post(`/api/parts/${state.dxfId}/units`, { units: "mm" }, { ip })).status, 404, "without the key the part is not found");

  // The DXF's units can still be changed: the stored file is decrypted in memory and read again in a worker.
  const before = up.body.parts.find((p) => p.fileName === "guard.dxf").geometry.boundingBox.width;
  const mm = await s.post(`/api/parts/${state.dxfId}/units`, { units: "mm" }, { ip, headers: state.dxfKey });
  assert.strictEqual(mm.status, 200, mm.text);
  const inch = await s.post(`/api/parts/${state.dxfId}/units`, { units: "in" }, { ip, headers: state.dxfKey });
  assert.strictEqual(inch.status, 200, inch.text);
  assert.ok(Math.abs(inch.body.geometry.boundingBox.width / mm.body.geometry.boundingBox.width - 25.4) < 1e-6, "inch reading is 25.4× the millimetre reading");
  assert.ok(before > 0);
  assert.strictEqual(s.files("uploads").filter((f) => !f.endsWith(".enc")).length, 0, "re-reading left no decrypted copy on disk");

  // Only an admin can take the file out, and gets the original bytes under the original name.
  state.admin = await s.admin({ ip });
  state.buyer = await s.register("buyer@example.com", { ip });
  assert.strictEqual((await s.get(`/api/parts/${state.cubeId}/download`, { ip })).status, 401);
  assert.strictEqual((await s.get(`/api/parts/${state.cubeId}/download`, { ip, token: state.buyer })).status, 403);
  const dl = await s.get(`/api/parts/${state.cubeId}/download`, { ip, token: state.admin });
  assert.strictEqual(dl.status, 200);
  assert.ok(dl.buffer.equals(cube), "decrypted download is byte-for-byte the upload");
  assert.ok(/attachment/.test(dl.headers["content-disposition"]) && /cube\.stl/.test(dl.headers["content-disposition"]));
  assert.strictEqual(dl.headers["content-type"], "application/octet-stream");
  assert.strictEqual((await s.get("/api/parts/..%2F..%2Fquoting.db/download", { ip, token: state.admin })).status, 404, "a part id is an id, not a path");
});

test("with a key: the drawing on an instant quote and the RFQ attachment are encrypted too", async () => {
  const mats = (await s.get("/api/materials?process=cnc", { ip })).body;
  const q = await s.post("/api/quote", { parts: [{ partId: state.cubeId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] }, { ip });
  assert.strictEqual(q.status, 200, q.text);
  const d = await s.upload([{ field: "drawing", name: "print.pdf", data: pdf }], { url: `/api/quote/${q.body.quoteId}/drawing`, ip });
  assert.strictEqual(d.status, 200, d.text);
  const drawings = onDisk("quote-drawings");
  assert.strictEqual(drawings.length, 1);
  assert.ok(/\.pdf\.enc$/.test(drawings[0].name), drawings[0].name);
  assert.ok(!containsAny(drawings[0].bytes, [Buffer.from("%PDF"), Buffer.from("PROPRIETARY-TITLE-BLOCK-7731")]), "the drawing is not readable on disk");

  for (const [name, data] of [["print.pdf", pdf], ["worn-part.png", photo]]) {
    const r = await s.rfq({ contactName: "A Buyer", email: "buyer@example.com" }, [{ name, data }], { ip });
    assert.strictEqual(r.status, 201, r.text);
    state[name] = r.body.rfqId;
  }
  const attachments = onDisk("rfq-drawings");
  assert.strictEqual(attachments.length, 2);
  for (const f of attachments) {
    assert.ok(f.name.endsWith(".enc"), f.name);
    assert.ok(!containsAny(f.bytes, [Buffer.from("PROPRIETARY-TITLE-BLOCK-7731"), photo.subarray(0, 8), photo.subarray(100, 164)]), `${f.name} holds no plaintext`);
  }
  // The shop opens them from the admin queue, decrypted.
  assert.strictEqual((await s.get(`/api/rfq/admin/${state["print.pdf"]}/drawing`, { ip, token: state.buyer })).status, 403);
  const a = await s.get(`/api/rfq/admin/${state["print.pdf"]}/drawing`, { ip, token: state.admin });
  assert.strictEqual(a.status, 200);
  assert.ok(a.buffer.equals(pdf));
  assert.ok(/attachment/.test(a.headers["content-disposition"]), "sent as a download, never rendered in the admin's browser");
  const b = await s.get(`/api/rfq/admin/${state["worn-part.png"]}/drawing`, { ip, token: state.admin });
  assert.ok(b.buffer.equals(photo));
  assert.strictEqual(b.headers["content-type"], "application/octet-stream");
});

test("key changed: old files are refused with a clear reason, nothing else breaks; listing the old key as 'previous' brings them back", async () => {
  await restart({ NORD_FILE_ENC_KEY: keyB });
  const dl = await s.get(`/api/parts/${state.cubeId}/download`, { ip, token: state.admin });
  assert.strictEqual(dl.status, 500);
  assert.strictEqual(dl.body.code, "wrong-key");
  assert.ok(!dl.buffer.includes(cube.subarray(84, 148)), "no bytes of the file in the refusal");
  const a = await s.get(`/api/rfq/admin/${state["print.pdf"]}/drawing`, { ip, token: state.admin });
  assert.strictEqual(a.status, 500);
  assert.strictEqual(a.body.code, "wrong-key");
  assert.ok(/wrong-key/.test(s.log()), "the reason is in the server log");
  // Quoting never needed the file: the stored geometry still prices.
  const mats = (await s.get("/api/materials?process=cnc", { ip })).body;
  assert.strictEqual((await s.post("/api/quote", { parts: [{ partId: state.cubeId, materialSlug: mats[0].slug, quantity: 3, process: "cnc", subProcess: "milling" }] }, { ip })).status, 200);
  // Re-reading the DXF does need it: a plain "upload it again", no detail.
  const units = await s.post(`/api/parts/${state.dxfId}/units`, { units: "mm" }, { ip, headers: state.dxfKey });
  assert.strictEqual(units.status, 500);
  assert.ok(/upload the file again/i.test(units.body.error) && !/key|decrypt|crypto/i.test(units.body.error), units.body.error);
  // New uploads work under the new key.
  const up = await s.upload([{ name: "cube2.stl", data: cube }], { ip });
  assert.strictEqual(up.body.parts.length, 1, up.text);
  state.cube2 = up.body.parts[0].partId;
  assert.ok((await s.get(`/api/parts/${state.cube2}/download`, { ip, token: state.admin })).buffer.equals(cube));

  await restart({ NORD_FILE_ENC_KEY: keyB, NORD_FILE_ENC_KEY_PREVIOUS: keyA });
  assert.ok((await s.get(`/api/parts/${state.cubeId}/download`, { ip, token: state.admin })).buffer.equals(cube), "old file readable again");
  assert.ok((await s.get(`/api/parts/${state.cube2}/download`, { ip, token: state.admin })).buffer.equals(cube), "new file readable");
  assert.ok((await s.get(`/api/rfq/admin/${state["print.pdf"]}/drawing`, { ip, token: state.admin })).buffer.equals(pdf));
});

test("key lost: encrypted files stay unreadable (never served as ciphertext); the site runs; the startup warning says what is unencrypted", async () => {
  await restart({});
  const log = s.log();
  assert.ok(/NORD_FILE_ENC_KEY not set/.test(log) && /UNENCRYPTED/.test(log), "startup warning present");
  for (const what of ["CAD uploads", "data/uploads", "quote", "data/quote-drawings", "RFQ attachments", "data/rfq-drawings", "docs/security/file-encryption.md"]) {
    assert.ok(log.includes(what), `the warning names ${what}`);
  }
  const dl = await s.get(`/api/parts/${state.cubeId}/download`, { ip, token: state.admin });
  assert.strictEqual(dl.status, 500);
  assert.strictEqual(dl.body.code, "no-key");
  assert.ok(!dl.buffer.subarray(0, 4).equals(Buffer.from("SEF1")), "the ciphertext is not handed out in place of the file");
  // Without a key new files are stored as they arrive (the documented default)…
  const up = await s.upload([{ name: "plain.stl", data: cube }], { ip });
  assert.strictEqual(up.body.parts.length, 1);
  assert.ok(s.files("uploads").some((f) => /\.stl$/.test(f)), "stored unencrypted, as the warning says");
  // …and the retention sweep and the rest of the site are unaffected by the encrypted files it cannot read.
  assert.strictEqual((await s.get("/api/health")).status, 200);
});

test("a key that is set but unusable stops the deploy instead of pretending to encrypt; no key ever appears in a log", async () => {
  logs.push(s.log());
  for (const weak of ["hunter2", "x".repeat(40)]) {
    let err = null;
    try { const bad = await live.start({ env: { NORD_FILE_ENC_KEY: weak } }); await bad.stop(); } catch (e) { err = e; }
    assert.ok(err, "the server must not start");
    assert.strictEqual(err.exitCode, 1);
    assert.ok(/FATAL: NORD_FILE_ENC_KEY/.test(err.output), err.output.slice(0, 300));
    assert.ok(!err.output.includes(weak), "the bad key is not echoed");
    logs.push(err.output);
  }
  const all = logs.join("\n");
  for (const secret of [keyA, keyB, jwtSecret]) assert.ok(!all.includes(secret), "a secret reached the log");
  assert.ok(!/sk_test_[0-9a-f]{8}/.test(all), "the Stripe key is not logged");
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(all), "no login token or signed link in the log");
});

run(async () => { if (s) await s.stop(); });
