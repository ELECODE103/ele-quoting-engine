/**
 * Dependency upgrades (hardening 2026-11-11): behaviour that must hold after
 * adm-zip 0.5 → 0.6, uuid → crypto.randomUUID, and the proxy-addr fix.
 * Run: node server/security/dependencies.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { runner } = require("../testSupport/harness");
const { box3mf, buildZip } = require("../testSupport/zip");
const { isValidUUID } = require("../middleware/validate");

const { test, run } = runner("Dependencies");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package-lock.json"), "utf8"));
const locked = (name) => lock.packages[`node_modules/${name}`];
const atLeast = (v, min) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
};

test("dev-only tools are not production dependencies", () => {
  assert.ok(!pkg.dependencies.concurrently, "concurrently must not be a production dependency");
  assert.ok(pkg.devDependencies.concurrently, "concurrently is a dev dependency (npm run dev)");
  assert.ok(locked("concurrently").dev === true, "lockfile marks concurrently dev-only");
  assert.ok(locked("shell-quote").dev === true && locked("lodash").dev === true, "its shell-quote and lodash are dev-only");
});

test("the uuid package is gone; ids come from crypto.randomUUID and keep the v4 format", () => {
  assert.ok(!pkg.dependencies.uuid && !locked("uuid"), "uuid is not installed");
  for (const f of ["models/db.js", "models/SqliteDB.js", "routes/api.js", "routes/rfq.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/require\(["']uuid["']\)/.test(src), `${f} no longer requires uuid`);
  }
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = require("crypto").randomUUID();
    assert.ok(isValidUUID(id), `id ${id} passes the server's own UUID check`);
    ids.add(id);
  }
  assert.strictEqual(ids.size, 500);
});

test("locked versions are at or past the patched releases", () => {
  const need = { "adm-zip": "0.6.1", multer: "2.5.0", "proxy-addr": "2.0.8", "path-to-regexp": "0.1.13", "body-parser": "1.20.9", qs: "6.16.1", "fast-xml-parser": "5.12.0", "fast-xml-builder": "1.1.7", express: "4.22.3" };
  for (const [name, min] of Object.entries(need)) {
    assert.ok(locked(name), `${name} is installed`);
    assert.ok(atLeast(locked(name).version, min), `${name} ${locked(name).version} >= ${min}`);
  }
});

test("adm-zip 0.6: a valid 3MF still reads to the same geometry", async () => {
  const { parse3MF } = require("../parsers/fileParser");
  const g = await parse3MF(box3mf(20, 30, 40));
  assert.strictEqual(g.triangleCount, 12);
  assert.ok(Math.abs(g.volume - 24000) < 1e-6, `volume ${g.volume}`);
  assert.ok(Math.abs(g.surfaceArea - 2 * (20 * 30 + 30 * 40 + 20 * 40)) < 1e-6, `area ${g.surfaceArea}`);
  assert.deepStrictEqual([g.boundingBox.width, g.boundingBox.height, g.boundingBox.depth], [20, 30, 40]);
});

test("adm-zip 0.6: an archive that names the model twice is refused in plain words", async () => {
  const { parse3MF } = require("../parsers/fileParser");
  const dup = buildZip([{ name: "3D/3dmodel.model", data: "<a/>" }, { name: "3D/3dmodel.model", data: "<b/>" }]);
  await assert.rejects(() => parse3MF(dup), (err) => {
    assert.ok(/3MF/.test(err.message), err.message);
    assert.ok(!/ADM-ZIP|adm-zip|node_modules/.test(err.message), `library text must not reach the customer: ${err.message}`);
    return true;
  });
});

test("one trusted proxy hop: a client-supplied X-Forwarded-For entry is never taken as the client address", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const ask = (xff) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/ip", headers: xff ? { "X-Forwarded-For": xff } : {} }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d).ip));
    });
    req.on("error", reject);
  });
  try {
    // The edge proxy appends the address it saw; whatever the client wrote sits to the left of it.
    assert.strictEqual(await ask("6.6.6.6, 203.0.113.9"), "203.0.113.9");
    assert.strictEqual(await ask("::ffff:10.0.0.1, 203.0.113.9"), "203.0.113.9");
    assert.strictEqual(await ask("10.0.0.1, ::ffff:127.0.0.1, 203.0.113.9"), "203.0.113.9");
    assert.ok(/127\.0\.0\.1$/.test(await ask()), "no header: the socket address");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

run();
