/**
 * Tests for at-rest file encryption + retention sweep.
 * Run: `node server/services/fileCrypto.test.js`
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
function freshCrypto() {
  delete require.cache[require.resolve("./fileCrypto")];
  return require("./fileCrypto");
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nordfc-"));

console.log("File crypto + retention");

test("no key configured → encrypt is a no-op (existing behavior preserved)", () => {
  delete process.env.NORD_FILE_ENC_KEY;
  const fc = freshCrypto();
  const p = path.join(tmp, "plain.stl");
  fs.writeFileSync(p, "SOLID DATA");
  const out = fc.encryptFileInPlace(p);
  assert.strictEqual(out, p);
  assert.strictEqual(fs.readFileSync(p, "utf8"), "SOLID DATA");
  assert.strictEqual(fc.isEnabled(), false);
});

test("with key → encrypt then decrypt round-trips; plaintext removed; bytes differ", () => {
  process.env.NORD_FILE_ENC_KEY = "test-secret-key";
  const fc = freshCrypto();
  const p = path.join(tmp, "secret.step");
  const original = Buffer.from("PROPRIETARY GEOMETRY \x00\x01\x02\xff");
  fs.writeFileSync(p, original);
  const enc = fc.encryptFileInPlace(p);
  assert.ok(enc.endsWith(".enc"), "encrypted path has .enc suffix");
  assert.ok(!fs.existsSync(p), "plaintext deleted");
  assert.ok(fs.existsSync(enc));
  assert.notStrictEqual(fs.readFileSync(enc).toString("latin1"), original.toString("latin1"), "stored bytes differ from plaintext");
  const dec = fc.decryptToBuffer(enc);
  assert.strictEqual(Buffer.compare(dec, original), 0, "decrypt restores original");
});

test("tampered ciphertext fails GCM authentication", () => {
  process.env.NORD_FILE_ENC_KEY = "test-secret-key";
  const fc = freshCrypto();
  const p = path.join(tmp, "t.stl");
  fs.writeFileSync(p, "abc");
  const enc = fc.encryptFileInPlace(p);
  const buf = fs.readFileSync(enc);
  buf[buf.length - 1] ^= 0xff; // flip a byte
  fs.writeFileSync(enc, buf);
  assert.throws(() => fc.decryptToBuffer(enc), /auth|tag|unable|decrypt/i);
});

test("retention sweep removes files older than the window, keeps fresh ones", () => {
  const { sweepOnce } = require("./fileRetention");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordret-"));
  const oldF = path.join(dir, "old.stl");
  const newF = path.join(dir, "new.stl");
  fs.writeFileSync(oldF, "x");
  fs.writeFileSync(newF, "y");
  const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(oldF, tenDaysAgo, tenDaysAgo);
  const removed = sweepOnce(dir, 7 * 24 * 3600 * 1000);
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(oldF), "old file removed");
  assert.ok(fs.existsSync(newF), "fresh file kept");
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
