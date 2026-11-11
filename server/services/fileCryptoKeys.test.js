/**
 * File encryption: keys, formats and failure modes. Every key here is random
 * and made at run time; none is written anywhere.
 * Run: node server/services/fileCryptoKeys.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");
const fileCrypto = require("./fileCrypto");

const { test, run } = runner("File encryption: keys and failure modes");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-crypto-"));
const newKey = () => crypto.randomBytes(36).toString("base64");
const plain = crypto.randomBytes(300 * 1024 + 17); // not a multiple of the cipher's block
let n = 0;
const fresh = (data = plain) => { const p = path.join(tmp, `f${++n}.step`); fs.writeFileSync(p, data); return p; };
const useKey = (key, previous) => {
  if (key === null) delete process.env.NORD_FILE_ENC_KEY; else process.env.NORD_FILE_ENC_KEY = key;
  if (previous) process.env.NORD_FILE_ENC_KEY_PREVIOUS = previous; else delete process.env.NORD_FILE_ENC_KEY_PREVIOUS;
};
const errorOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

test("no key: nothing is encrypted and the file is left exactly as it was", async () => {
  useKey(null);
  const p = fresh();
  assert.strictEqual(fileCrypto.isEnabled(), false);
  assert.strictEqual(await fileCrypto.encryptFile(p), p);
  assert.ok(fs.readFileSync(p).equals(plain));
  assert.ok((await fileCrypto.readStored(p)).equals(plain));
});

test("with a key: streamed encryption round-trips, the plaintext is gone, the bytes on disk are not the file", async () => {
  useKey(newKey());
  const p = fresh();
  const enc = await fileCrypto.encryptFile(p);
  assert.strictEqual(enc, `${p}.enc`);
  assert.ok(!fs.existsSync(p), "plaintext removed");
  const onDisk = fs.readFileSync(enc);
  assert.strictEqual(onDisk.subarray(0, 4).toString("ascii"), "SEF1");
  assert.strictEqual(onDisk.length, plain.length + 36, "header (4 + 4 + 12 + 16) plus ciphertext");
  assert.strictEqual(onDisk.indexOf(plain.subarray(0, 64)), -1, "no run of plaintext in the stored file");
  assert.ok((await fileCrypto.decryptFile(enc)).equals(plain));
  assert.ok(fileCrypto.decryptToBuffer(enc).equals(plain));
  assert.ok((await fileCrypto.readStored(enc)).equals(plain));
  assert.strictEqual(fs.statSync(enc).mode & 0o077, 0, "readable by the service user only");
  // the synchronous path writes the same format
  const enc2 = fileCrypto.encryptFileInPlace(fresh());
  assert.ok(fileCrypto.decryptToBuffer(enc2).equals(plain));
  // two encryptions of the same bytes never look alike (fresh nonce each time)
  assert.ok(!fs.readFileSync(enc2).subarray(8).equals(onDisk.subarray(8)));
  // an empty file is fine too
  const empty = await fileCrypto.encryptFile(fresh(Buffer.alloc(0)));
  assert.strictEqual((await fileCrypto.decryptFile(empty)).length, 0);
});

test("key lost: an encrypted file cannot be read, and says why; nothing is written or returned", async () => {
  useKey(newKey());
  const enc = await fileCrypto.encryptFile(fresh());
  useKey(null);
  const before = fs.readdirSync(tmp).length;
  const err = await errorOf(() => fileCrypto.decryptFile(enc));
  assert.ok(err instanceof fileCrypto.FileCryptoError);
  assert.strictEqual(err.code, "no-key");
  assert.throws(() => fileCrypto.decryptToBuffer(enc), (e) => e.code === "no-key");
  assert.strictEqual(fs.readdirSync(tmp).length, before, "no partial output on disk");
});

test("key changed: files written under the old key are refused as 'different key' — and read again once it is listed as a previous key", async () => {
  const oldKey = newKey(), nextKey = newKey();
  useKey(oldKey);
  const encOld = await fileCrypto.encryptFile(fresh());
  useKey(nextKey);
  const err = await errorOf(() => fileCrypto.decryptFile(encOld));
  assert.strictEqual(err.code, "wrong-key");
  assert.ok(/NORD_FILE_ENC_KEY_PREVIOUS/.test(err.message), "the message says how to recover");
  assert.ok(!err.message.includes(oldKey) && !err.message.includes(nextKey), "no key material in the message");
  const encNew = await fileCrypto.encryptFile(fresh());
  // rotation: the new key encrypts, the old one still opens what it wrote
  useKey(nextKey, `${newKey()}, ${oldKey}`);
  assert.ok((await fileCrypto.decryptFile(encOld)).equals(plain));
  assert.ok((await fileCrypto.decryptFile(encNew)).equals(plain));
  const encAfter = await fileCrypto.encryptFile(fresh());
  useKey(oldKey);
  assert.strictEqual((await errorOf(() => fileCrypto.decryptFile(encAfter))).code, "wrong-key", "new files are written under the new key only");
});

test("a damaged file never yields plaintext: flipped bit, cut short, altered header, swapped tag", async () => {
  useKey(newKey());
  const enc = await fileCrypto.encryptFile(fresh());
  const good = fs.readFileSync(enc);
  const variants = {
    "one bit flipped in the ciphertext": (b) => { b[b.length - 100] ^= 1; return b; },
    "one bit flipped in the nonce": (b) => { b[10] ^= 1; return b; },
    "one bit flipped in the tag": (b) => { b[25] ^= 1; return b; },
    "last kilobyte missing": (b) => b.subarray(0, b.length - 1024),
    "only the header": (b) => b.subarray(0, 36),
    "ten bytes": (b) => b.subarray(0, 10),
    "another file's ciphertext under this header": (b) => Buffer.concat([b.subarray(0, 36), crypto.randomBytes(5000)]),
  };
  for (const [what, damage] of Object.entries(variants)) {
    const p = path.join(tmp, `damaged-${++n}.enc`);
    fs.writeFileSync(p, damage(Buffer.from(good)));
    const err = await errorOf(() => fileCrypto.decryptFile(p));
    assert.ok(err instanceof fileCrypto.FileCryptoError, `${what}: must throw, got ${err}`);
    assert.ok(["corrupt", "wrong-key"].includes(err.code), `${what}: ${err.code}`);
  }
});

test("files written in the earlier format (no header) still open with the same key", async () => {
  const key = newKey();
  useKey(key);
  // v0 as the previous version of this module wrote it: iv | tag | ciphertext, key = SHA-256(secret)
  const k = crypto.createHash("sha256").update(key).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const p = path.join(tmp, "legacy.stl.enc");
  fs.writeFileSync(p, Buffer.concat([iv, c.getAuthTag(), ct]));
  assert.ok((await fileCrypto.decryptFile(p)).equals(plain));
  useKey(newKey());
  assert.strictEqual((await errorOf(() => fileCrypto.decryptFile(p))).code, "wrong-key");
});

test("a failed encryption leaves the plaintext in place and no half-written .enc", async () => {
  useKey(newKey());
  const p = fresh();
  fs.writeFileSync(`${p}.enc`, "already here"); // the target exists: open(wx) fails
  const err = await errorOf(() => fileCrypto.encryptFile(p));
  assert.ok(err, "the caller is told");
  assert.ok(fs.readFileSync(p).equals(plain), "the upload itself is untouched");
});

test("startup check: a short or placeholder key is named as a problem; a real one is not; the key is never echoed", () => {
  useKey(null);
  assert.strictEqual(fileCrypto.configProblem(), null, "no key is a choice, not a misconfiguration");
  for (const weak of ["short", "x".repeat(40), "change-this-to-a-long-random-string-please-now", `password${"1".repeat(40)}`]) {
    useKey(weak);
    const problem = fileCrypto.configProblem();
    assert.ok(problem && /NORD_FILE_ENC_KEY/.test(problem), `${weak.slice(0, 12)}… should be refused`);
    assert.ok(!problem.includes(weak), "the message does not contain the key");
  }
  useKey(newKey());
  assert.strictEqual(fileCrypto.configProblem(), null);
});

test("download helper: decrypts for the response, forces a download, and builds the header safely", async () => {
  const fakeRes = () => ({
    headers: {}, statusCode: 200, sent: null,
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    attachment(name) { this.headers["content-disposition"] = require("express/lib/response").attachment ? `attachment; filename=${JSON.stringify(name)}` : name; this.attached = name; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.sent = b; return this; },
  });
  const key = newKey();
  useKey(key);
  const enc = await fileCrypto.encryptFile(fresh());
  const res = fakeRes();
  await fileCrypto.sendDownload(res, enc, 'bracket"; filename*=x\r\nSet-Cookie: a=b.step');
  assert.ok(res.sent.equals(plain));
  assert.strictEqual(res.headers["content-type"], "application/octet-stream");
  assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
  assert.ok(!/[\r\n]/.test(res.attached), "no line breaks reach the header");
  // the wrong key gives an error body and no bytes, and the log names the reason without the key
  useKey(newKey());
  const lines = []; const orig = console.error; console.error = (...a) => lines.push(a.join(" "));
  const res2 = fakeRes();
  try { await fileCrypto.sendDownload(res2, enc, "bracket.step"); } finally { console.error = orig; }
  assert.strictEqual(res2.statusCode, 500);
  assert.strictEqual(res2.sent, null);
  assert.strictEqual(res2.body.code, "wrong-key");
  assert.ok(lines.length === 1 && /wrong-key/.test(lines[0]) && !lines[0].includes(key) && !lines[0].includes(process.env.NORD_FILE_ENC_KEY));
  const res3 = fakeRes();
  await fileCrypto.sendDownload(res3, path.join(tmp, "gone.step.enc"), "x.step");
  assert.strictEqual(res3.statusCode, 404);
});

run(() => { useKey(null); fs.rmSync(tmp, { recursive: true, force: true }); });
