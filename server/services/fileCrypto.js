/**
 * At-rest encryption for files customers send us: CAD uploads, the drawing a
 * buyer attaches to an instant quote, and RFQ attachments — and for what we
 * derive from them and keep in files: each part's preview mesh and large
 * geometry detail (data/part-payloads, models/partPayloads.js).
 *
 * Customer files are proprietary, so once an upload has been read it is stored
 * encrypted and decrypted only for an authorised download (admin, or the
 * buyer's own drawing) and for a DXF re-read. AES-256-GCM (authenticated).
 *
 * OPT-IN: without NORD_FILE_ENC_KEY nothing is encrypted and files are stored
 * as they arrive. The owner creates the key himself — see
 * docs/security/file-encryption.md. It is never generated, logged or stored by
 * this code.
 *
 * Keys
 *   NORD_FILE_ENC_KEY            the key new files are encrypted with (32+ characters)
 *   NORD_FILE_ENC_KEY_PREVIOUS   optional, comma-separated: older keys that can
 *                                still DECRYPT (for changing the key without
 *                                losing the files already on disk)
 *
 * On-disk format (file name ends in .enc)
 *   v1  "SEF1" | keyId(4) | iv(12) | tag(16) | ciphertext
 *       keyId = first 4 bytes of HMAC-SHA256(key, "straightedge-file-key-id"):
 *       it names the key without revealing it, so a file written under another
 *       key is recognised as such instead of failing with a bare cipher error.
 *   v0  iv(12) | tag(16) | ciphertext        (written before 2026-11-11; still read)
 *
 * Failing safely: a missing key, a different key, a truncated or altered file
 * all throw a FileCryptoError before any plaintext is returned. Nothing is
 * ever decrypted to disk.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const ALGO = "aes-256-gcm";
const ENC_SUFFIX = ".enc";
const MAGIC = Buffer.from("SEF1", "ascii");
const KEY_ID_LEN = 4;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + KEY_ID_LEN + IV_LEN + TAG_LEN;
const MIN_SECRET_LENGTH = 32;

class FileCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FileCryptoError";
    this.code = code; // "no-key" | "wrong-key" | "corrupt"
  }
}

/** A 32-byte key and its id from a configured secret. (Derivation kept from v0 so older files still open.) */
function deriveKey(secret) {
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  const id = crypto.createHmac("sha256", key).update("straightedge-file-key-id").digest().subarray(0, KEY_ID_LEN);
  return { key, id };
}

function primarySecret() {
  const s = process.env.NORD_FILE_ENC_KEY;
  return s && String(s).trim() ? String(s).trim() : null;
}

function getKey() {
  const s = primarySecret();
  return s ? deriveKey(s) : null;
}

/** Every key that may decrypt: the current one first, then NORD_FILE_ENC_KEY_PREVIOUS. */
function decryptKeys() {
  const out = [];
  const cur = getKey();
  if (cur) out.push(cur);
  for (const s of String(process.env.NORD_FILE_ENC_KEY_PREVIOUS || "").split(",")) {
    if (s.trim()) out.push(deriveKey(s.trim()));
  }
  return out;
}

function isEnabled() {
  return !!getKey();
}

/**
 * What is wrong with the configured key, in words, or null when it is usable
 * (or not set at all). Checked at startup; the key itself is never printed.
 */
function configProblem() {
  const s = primarySecret();
  if (!s) return null;
  if (s.length < MIN_SECRET_LENGTH) return `NORD_FILE_ENC_KEY is only ${s.length} characters long; it must be at least ${MIN_SECRET_LENGTH}. Generate one as described in docs/security/file-encryption.md.`;
  if (/^(change-this|changeme|example|test|password)/i.test(s) || new Set(s).size < 8) return "NORD_FILE_ENC_KEY looks like a placeholder, not a random key. Generate one as described in docs/security/file-encryption.md.";
  return null;
}

function isEncryptedPath(p) {
  return typeof p === "string" && p.endsWith(ENC_SUFFIX);
}

function header(keyId, iv, tag) {
  return Buffer.concat([MAGIC, keyId, iv, tag]);
}

/**
 * Encrypt a plaintext file in place: writes `<path>.enc`, deletes the plaintext,
 * and returns the new path. No-op (returns the original path) when encryption
 * is not configured. Synchronous: for small files and scripts; requests use
 * encryptFile().
 */
function encryptFileInPlace(plainPath) {
  const k = getKey();
  if (!k) return plainPath;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k.key, iv);
  const plaintext = fs.readFileSync(plainPath);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encPath = plainPath + ENC_SUFFIX;
  fs.writeFileSync(encPath, Buffer.concat([header(k.id, iv, cipher.getAuthTag()), ciphertext]), { mode: 0o600 });
  fs.unlinkSync(plainPath);
  return encPath;
}

/**
 * The same, streamed: constant memory and no pause in the event loop however
 * large the file is. Resolves with the path now on disk. If anything fails the
 * partial .enc file is removed and the plaintext is left where it was, so the
 * caller decides what to do with it.
 */
async function encryptFile(plainPath) {
  const k = getKey();
  if (!k) return plainPath;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k.key, iv);
  const encPath = plainPath + ENC_SUFFIX;
  let created = false;
  try {
    // "wx": never write over an existing file. Header with an empty tag first;
    // the tag is only known once the last block is through.
    const out = fs.createWriteStream(encPath, { flags: "wx", mode: 0o600 });
    out.once("open", () => { created = true; });
    out.write(header(k.id, iv, Buffer.alloc(TAG_LEN)));
    await pipeline(fs.createReadStream(plainPath), cipher, out);
    const handle = await fs.promises.open(encPath, "r+");
    try {
      await handle.write(cipher.getAuthTag(), 0, TAG_LEN, MAGIC.length + KEY_ID_LEN + IV_LEN);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.unlink(plainPath);
    return encPath;
  } catch (err) {
    if (created) await fs.promises.unlink(encPath).catch(() => {});
    throw err;
  }
}

/**
 * Encrypt bytes we already hold in memory (a part's stored mesh, say) into the
 * same on-disk format a file gets, so nothing readable is ever written first.
 * Throws when no key is configured: the caller decides whether to store plain.
 */
function encryptBuffer(plaintext) {
  const k = getKey();
  if (!k) throw new FileCryptoError("no-key", "No file encryption key is configured (NORD_FILE_ENC_KEY).");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header(k.id, iv, cipher.getAuthTag()), ciphertext]);
}

function decryptBuffer(data) {
  const keys = decryptKeys();
  if (keys.length === 0) throw new FileCryptoError("no-key", "This file is encrypted and no file encryption key is configured (NORD_FILE_ENC_KEY).");

  const v1 = data.length >= HEADER_LEN && data.subarray(0, MAGIC.length).equals(MAGIC);
  let candidates, iv, tag, ciphertext;
  if (v1) {
    const keyId = data.subarray(MAGIC.length, MAGIC.length + KEY_ID_LEN);
    iv = data.subarray(MAGIC.length + KEY_ID_LEN, MAGIC.length + KEY_ID_LEN + IV_LEN);
    tag = data.subarray(HEADER_LEN - TAG_LEN, HEADER_LEN);
    ciphertext = data.subarray(HEADER_LEN);
    candidates = keys.filter((k) => k.id.equals(keyId));
    if (candidates.length === 0) throw new FileCryptoError("wrong-key", "This file was encrypted with a different key than the one configured (NORD_FILE_ENC_KEY). Put the earlier key in NORD_FILE_ENC_KEY_PREVIOUS to read it.");
  } else {
    if (data.length < IV_LEN + TAG_LEN) throw new FileCryptoError("corrupt", "This encrypted file is incomplete.");
    iv = data.subarray(0, IV_LEN);
    tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
    ciphertext = data.subarray(IV_LEN + TAG_LEN);
    candidates = keys; // v0 files carry no key id: try each
  }
  for (const k of candidates) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, k.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { /* authentication failed under this key: try the next */ }
  }
  // The key id matched (or there was none) and authentication still failed: the bytes were changed, or it is the wrong key.
  throw new FileCryptoError(v1 ? "corrupt" : "wrong-key", v1
    ? "This encrypted file is damaged: it failed authentication (the integrity check)."
    : "This file could not be decrypted with the configured key (wrong key, or the file is damaged).");
}

/** Decrypt an encrypted file to a Buffer (throws FileCryptoError; never returns partial plaintext). */
function decryptToBuffer(encPath) {
  return decryptBuffer(fs.readFileSync(encPath));
}

/** The same without blocking on the read. */
async function decryptFile(encPath) {
  return decryptBuffer(await fs.promises.readFile(encPath));
}

/** Read `length` bytes at `position`. */
async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/**
 * Decrypt an encrypted file as a STREAM: constant memory, nothing held on the
 * main thread however large the file is (a part's preview mesh is megabytes).
 *
 * The promise this module makes — no plaintext before the file has passed its
 * integrity check — is kept by reading the file twice: once through the
 * cipher with the output thrown away, which authenticates it, and only then a
 * second time for the stream that is handed back. Both passes are chunked and
 * asynchronous.
 *
 * @returns {Promise<{ stream: import("stream").Readable, bytes: number }>} the plaintext and its length
 * @throws {FileCryptoError} no-key / wrong-key / corrupt, before any plaintext
 */
async function openDecryptStream(encPath) {
  const keys = decryptKeys();
  if (keys.length === 0) throw new FileCryptoError("no-key", "This file is encrypted and no file encryption key is configured (NORD_FILE_ENC_KEY).");
  let handle;
  let size;
  let head;
  try {
    handle = await fs.promises.open(encPath, "r");
    size = (await handle.stat()).size;
    head = await readAt(handle, 0, Math.min(HEADER_LEN, size));
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    throw new FileCryptoError("corrupt", `This encrypted file could not be opened (${err.code || "error"}).`);
  }
  await handle.close().catch(() => {});

  const v1 = head.length >= HEADER_LEN && head.subarray(0, MAGIC.length).equals(MAGIC);
  let candidates, iv, tag, start;
  if (v1) {
    const keyId = head.subarray(MAGIC.length, MAGIC.length + KEY_ID_LEN);
    iv = head.subarray(MAGIC.length + KEY_ID_LEN, MAGIC.length + KEY_ID_LEN + IV_LEN);
    tag = head.subarray(HEADER_LEN - TAG_LEN, HEADER_LEN);
    start = HEADER_LEN;
    candidates = keys.filter((k) => k.id.equals(keyId));
    if (candidates.length === 0) throw new FileCryptoError("wrong-key", "This file was encrypted with a different key than the one configured (NORD_FILE_ENC_KEY). Put the earlier key in NORD_FILE_ENC_KEY_PREVIOUS to read it.");
  } else {
    if (size < IV_LEN + TAG_LEN) throw new FileCryptoError("corrupt", "This encrypted file is incomplete.");
    iv = head.subarray(0, IV_LEN);
    tag = head.subarray(IV_LEN, IV_LEN + TAG_LEN);
    start = IV_LEN + TAG_LEN;
    candidates = keys; // v0 files carry no key id: try each
  }

  const decipherFor = (k) => { const d = crypto.createDecipheriv(ALGO, k.key, iv); d.setAuthTag(tag); return d; };
  const cipherText = () => fs.createReadStream(encPath, { start });
  // Pass 1: authenticate (output discarded). The first key that passes is the key.
  let good = null;
  for (const k of candidates) {
    try {
      const decipher = decipherFor(k);
      decipher.on("data", () => {}); // discard
      await pipeline(cipherText(), decipher);
      good = k;
      break;
    } catch { /* authentication failed under this key (or the file could not be read): try the next */ }
  }
  if (!good) {
    throw new FileCryptoError(v1 ? "corrupt" : "wrong-key", v1
      ? "This encrypted file is damaged: it failed authentication (the integrity check)."
      : "This file could not be decrypted with the configured key (wrong key, or the file is damaged).");
  }
  // Pass 2: the plaintext, streamed.
  const source = cipherText();
  const stream = decipherFor(good);
  source.on("error", (err) => stream.destroy(err));
  source.pipe(stream);
  return { stream, bytes: Math.max(0, size - start) };
}

/**
 * Can the configured key (or a listed previous key) open this encrypted file?
 * Reads the 8-byte header only: the file names the key it was written under.
 * @returns {true | false | null} null: cannot tell (an old-format file, or unreadable)
 */
function keyOpens(encPath) {
  let fd;
  try {
    fd = fs.openSync(encPath, "r");
    const head = Buffer.alloc(MAGIC.length + KEY_ID_LEN);
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const keyId = head.subarray(MAGIC.length);
    return decryptKeys().some((k) => k.id.equals(keyId));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * At start-up: do the keys we have open the encrypted files that are on disk?
 * Looks at the newest files in each folder (headers only).
 * @param {string[]} dirs
 * @returns {{ checked: number, locked: number }}
 */
function checkKeysAgainst(dirs, perDir = 25) {
  let checked = 0;
  let locked = 0;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(ENC_SUFFIX)); } catch { continue; }
    const newest = names.map((n) => { try { return { n, t: fs.statSync(path.join(dir, n)).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t).slice(0, perDir);
    for (const f of newest) {
      const ok = keyOpens(path.join(dir, f.n));
      if (ok === null) continue;
      checked++;
      if (!ok) locked++;
    }
  }
  return { checked, locked };
}

/** The bytes of a stored file, whether or not it is encrypted. */
async function readStored(storedPath) {
  return isEncryptedPath(storedPath) ? decryptFile(storedPath) : fs.promises.readFile(storedPath);
}

/**
 * Send a stored file as a download under the customer's own file name.
 * Encrypted files are decrypted in memory; plain ones are streamed. The name
 * goes through Express's Content-Disposition encoder (never string-built), and
 * the type is forced to a download so nothing a customer sent is ever rendered
 * in the admin's browser.
 */
async function sendDownload(res, storedPath, downloadName) {
  const fallback = path.basename(String(storedPath || "")).replace(/\.enc$/, "") || "file";
  const name = String(downloadName || fallback).replace(/[\r\n\u0000-\u001f]/g, "").trim() || fallback;
  if (!storedPath || !fs.existsSync(storedPath)) return res.status(404).json({ error: "File missing on disk" });
  res.set("X-Content-Type-Options", "nosniff");
  if (!isEncryptedPath(storedPath)) {
    return res.download(storedPath, name, { headers: { "Content-Type": "application/octet-stream" } }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: "Failed to read file" });
    });
  }
  try {
    const buf = await decryptFile(storedPath);
    res.attachment(name);
    res.set("Content-Type", "application/octet-stream");
    return res.send(buf);
  } catch (err) {
    // Say which of the three it is in the log (no key material, no file contents); the browser gets a plain answer.
    console.error(`File decrypt failed (${err.code || "error"}) for ${path.basename(storedPath)}: ${err.message}`);
    const message = err.code === "no-key" || err.code === "wrong-key"
      ? "This file is encrypted with a key this server does not have. See docs/security/file-encryption.md."
      : "Failed to read file";
    return res.status(500).json({ error: message, code: err.code || "decrypt-failed" });
  }
}

module.exports = {
  isEnabled, configProblem, isEncryptedPath,
  encryptFileInPlace, encryptFile, encryptBuffer,
  decryptBuffer, decryptToBuffer, decryptFile, openDecryptStream, keyOpens, checkKeysAgainst, readStored, sendDownload,
  FileCryptoError, ENC_SUFFIX, MIN_SECRET_LENGTH,
};
