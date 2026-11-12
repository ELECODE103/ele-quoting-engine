/**
 * Reopening a quote, and how previews are served (independent review 2026-11-11, C1).
 *
 * Before: GET /api/quote/:id/session carried every line's preview mesh, read and
 * re-serialised on the main thread — 100 lines of one dense part was a 478 MB
 * answer and four requests took the site down.
 * Now: the answer names each distinct part once and says where its preview is;
 * the preview is streamed from its own route under the part's access rule.
 * Run: node server/routes/quoteSessionMesh.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Quote session and part previews");
const parts = path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts");
const dense = fs.readFileSync(path.join(parts, "star_wheel.stl"));   // ~6,000 triangles: its mesh lives in a file
const cube = fs.readFileSync(path.join(parts, "cube_20mm.stl"));     // 16 triangles: its mesh lives in the row

let h;
let buyer;
const upload = async (name, data) => {
  const r = await h.form("/api/upload", {}, { files: { name, data } });
  assert.strictEqual(r.status, 200, r.text);
  return r.body.parts[0];
};
const mesh = (part, headers = {}) => h.raw("GET", part.mesh.url, { headers: { "X-Human-Token": h.humanToken, ...headers } });

test("an upload answer carries a small mesh, and names a large one by URL instead of embedding it", async () => {
  h = await start();
  buyer = await h.register("buyer@example.test");
  const small = await upload("cube.stl", cube);
  assert.ok(small.meshPreview.positions.length > 0, "a few-kB mesh still comes with the answer");
  const big = await upload("wheel.stl", dense);
  assert.deepStrictEqual(big.meshPreview.positions, [], "the dense mesh is not in the answer");
  assert.ok(big.meshPreview.triangleCount > 1000);
  assert.strictEqual(big.mesh.url, `/api/parts/${big.partId}/mesh`);
  assert.ok(big.mesh.bytes > 16 * 1024);
  assert.ok(big.editKey, "the browser gets the key that opens the preview");
});

test("100 lines of one dense part: the session answer is small, describes the part once and embeds no mesh", async () => {
  const part = await upload("wheel.stl", dense);
  const line = h.cncConfig(part.partId, 1);
  const q = await h.post("/api/quote", { parts: Array.from({ length: 100 }, () => line) }, buyer);
  assert.strictEqual(q.status, 200, q.text);
  const s = await h.get(`/api/quote/${q.body.quoteId}/session`, buyer);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.parts.length, 100, "every line is there");
  assert.deepStrictEqual(Object.keys(s.body.partsById), [part.partId], "the part is described once");
  const described = s.body.partsById[part.partId];
  assert.deepStrictEqual(described.meshPreview.positions, []);
  assert.strictEqual(described.mesh.url, `/api/parts/${part.partId}/mesh`);
  assert.ok(described.geometry.boundingBox.width > 0 && described.dfm, "measurements and DFM are there");
  assert.ok(!("meshData" in described.geometry));
  assert.ok(described.editKey && s.body.parts[0].editKey === described.editKey);
  // The old answer was 100 × the mesh (tens of MB for this part). The whole answer is now a few tens of kB.
  assert.ok(s.text.length < 200 * 1024, `session answer is ${s.text.length} bytes`);
  assert.ok(!/"positions":\[-?\d/.test(s.text), "no vertex list anywhere in the answer");
});

test("the preview route: needs the part's key, streams the stored mesh, and can be cached privately", async () => {
  const part = await upload("wheel.stl", dense);
  assert.strictEqual((await mesh(part)).status, 404, "the part id alone is not enough");
  assert.strictEqual((await mesh(part, { "X-Part-Key": "0".repeat(40) })).status, 404);
  const other = await upload("cube.stl", cube);
  assert.strictEqual((await mesh(part, { "X-Part-Key": other.editKey })).status, 404, "another part's key does not open it");

  const ok = await mesh(part, { "X-Part-Key": part.editKey });
  assert.strictEqual(ok.status, 200, ok.text.slice(0, 200));
  assert.strictEqual(ok.body.positions.length, ok.body.triangleCount * 9);
  assert.strictEqual(ok.body.triangleCount, part.meshPreview.triangleCount);
  assert.match(ok.headers.get("cache-control"), /^private/);
  assert.ok(!/public|no-store/.test(ok.headers.get("cache-control")));
  const etag = ok.headers.get("etag");
  assert.ok(etag);
  const again = await mesh(part, { "X-Part-Key": part.editKey, "If-None-Match": etag });
  assert.strictEqual(again.status, 304, "an unchanged preview costs a 304");
  // exactly what is stored
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.QUOTING_DATA_DIR, "part-payloads", `${part.partId}.mesh.json`), "utf8"));
  assert.deepStrictEqual(ok.body, stored);

  // a small mesh that lives in the row is served by the same route
  const small = await mesh(other, { "X-Part-Key": other.editKey });
  assert.strictEqual(small.status, 200);
  assert.deepStrictEqual(small.body.positions, other.meshPreview.positions);
  // unknown part, malformed id
  assert.strictEqual((await h.raw("GET", "/api/parts/00000000-0000-4000-8000-000000000000/mesh", { headers: { "X-Human-Token": h.humanToken } })).status, 404);
  assert.strictEqual((await h.raw("GET", "/api/parts/..%2f..%2fetc/mesh", { headers: { "X-Human-Token": h.humanToken } })).status, 404);
});

test("the preview route has a size cap and a per-client byte allowance", async () => {
  const part = await upload("wheel.stl", dense);
  process.env.PART_PAYLOAD_SERVE_MAX_MB = "1";
  const bytes = part.mesh.bytes;
  try {
    // 1 MB is the smallest cap that can be set; this mesh is under it, so shrink the allowance instead and check both refusals by code.
    assert.ok(bytes < 1024 * 1024);
    process.env.PART_PREVIEW_MB_PER_CLIENT_HOUR = "1";
    h.ip = "203.0.113.200";
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await mesh(part, { "X-Part-Key": part.editKey })).status);
    assert.ok(statuses[0] === 200 && statuses.includes(429), `allowance of 1 MB/h: ${statuses.join(" ")}`);
    const refused = await mesh(part, { "X-Part-Key": part.editKey });
    assert.strictEqual(refused.body.code, "preview-limit");
    assert.ok(refused.headers.get("retry-after"));
    assert.ok(statuses.filter((s) => s === 200).length * bytes <= 1024 * 1024 + bytes);
  } finally {
    delete process.env.PART_PAYLOAD_SERVE_MAX_MB;
    delete process.env.PART_PREVIEW_MB_PER_CLIENT_HOUR;
    h.ip = "";
  }
  // The size cap, on the file itself.
  const payloads = require("../models/partPayloads");
  const file = payloads.locate(part.partId, "mesh");
  fs.appendFileSync(file.path, Buffer.alloc(1024 * 1024 + 10, 0x20));
  process.env.PART_PAYLOAD_SERVE_MAX_MB = "1";
  try {
    const tooBig = await mesh(part, { "X-Part-Key": part.editKey });
    assert.strictEqual(tooBig.status, 413);
    assert.strictEqual(tooBig.body.code, "preview-too-large");
  } finally { delete process.env.PART_PAYLOAD_SERVE_MAX_MB; }
});

test("with file encryption on, the preview is decrypted as a stream, and a damaged file is refused before a byte is sent", async () => {
  process.env.NORD_FILE_ENC_KEY = require("crypto").randomBytes(32).toString("hex");
  try {
    const part = await upload("wheel.stl", dense);
    const payloads = require("../models/partPayloads");
    const file = payloads.locate(part.partId, "mesh");
    assert.ok(file.encrypted && file.path.endsWith(".enc"));
    assert.ok(!fs.readFileSync(file.path).includes(Buffer.from('"positions"')), "nothing readable on disk");
    const ok = await mesh(part, { "X-Part-Key": part.editKey });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.positions.length, ok.body.triangleCount * 9);
    // and with a key set, the small DXF outline is not in the answer or the row either: it has its own file
    const dxf = await upload("plate.dxf", fs.readFileSync(path.join(parts, "dxf_plate_holes.dxf")));
    assert.ok(dxf.geometryDetail && dxf.geometryDetail.url.endsWith("/geometry"));
    const detail = await h.raw("GET", dxf.geometryDetail.url, { headers: { "X-Human-Token": h.humanToken, "X-Part-Key": dxf.editKey } });
    assert.strictEqual(detail.status, 200);
    assert.ok(detail.body.profile2d && detail.body.profile2d.units, "the outline comes from the encrypted file");
    const row = h.models.partsDB.getRow(dxf.partId);
    assert.deepStrictEqual(Object.keys(row.geometry.profile2d).sort(), ["bbox", "detail", "units"], "the row keeps the drawing's size and units, and no outline, when a key is set");
    assert.ok(!JSON.stringify(row.geometry).includes('"loops"') && !JSON.stringify(row.geometry).includes('"holes":['));
    // one flipped byte
    const raw = fs.readFileSync(file.path);
    raw[raw.length - 20] ^= 0xff;
    fs.writeFileSync(file.path, raw);
    const quiet = console.error; console.error = () => {};
    let bad;
    try { bad = await mesh(part, { "X-Part-Key": part.editKey }); } finally { console.error = quiet; }
    assert.strictEqual(bad.status, 409);
    assert.strictEqual(bad.body.code, "preview-unavailable");
  } finally {
    delete process.env.NORD_FILE_ENC_KEY;
  }
});

test("no JSON answer leaves the API over the ceiling: it is refused with a code, and the log names the route", async () => {
  const app = express();
  require("../security/answerCeiling").install(app);
  app.get("/api/big", (req, res) => res.json({ blob: "x".repeat(2 * 1024 * 1024) }));
  app.get("/api/small", (req, res) => res.json({ ok: true }));
  app.get("/api/file", (req, res) => { res.locals.skipAnswerCeiling = true; res.json({ blob: "x".repeat(2 * 1024 * 1024) }); });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.JSON_ANSWER_MAX_MB = "1";
  const logged = [];
  const quiet = console.error; console.error = (...a) => logged.push(a.join(" "));
  try {
    const big = await fetch(`${base}/api/big`);
    assert.strictEqual(big.status, 500);
    const body = await big.json();
    assert.strictEqual(body.code, "answer-too-large");
    assert.ok(/email|call/i.test(body.error), "the refusal says who to contact");
    assert.ok(logged.some((l) => /ANSWER TOO LARGE: GET \/api\/big/.test(l)));
    assert.deepStrictEqual(await (await fetch(`${base}/api/small`)).json(), { ok: true });
    assert.strictEqual((await fetch(`${base}/api/file`)).status, 200, "a download the admin asked for is exempt");
  } finally {
    console.error = quiet;
    delete process.env.JSON_ANSWER_MAX_MB;
    await new Promise((r) => server.close(r));
  }
});

run(async () => { if (h) await h.stop(); process.exit(process.exitCode || 0); });
