/**
 * At-rest encryption for uploaded customer CAD files.
 *
 * Customer files are proprietary, so once parsed they are stored encrypted on
 * disk and decrypted only for the authenticated admin download route. Uses
 * AES-256-GCM (authenticated) with a key derived from NORD_FILE_ENC_KEY.
 *
 * OPT-IN + NON-BREAKING: if NORD_FILE_ENC_KEY is not set, encryption is a no-op
 * and files are stored as-is (existing behavior). Set the env var to enable.
 *
 * On-disk format for an encrypted file: [ iv(12) | authTag(16) | ciphertext ].
 */
const crypto = require("crypto");
const fs = require("fs");

const ALGO = "aes-256-gcm";
const ENC_SUFFIX = ".enc";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const secret = process.env.NORD_FILE_ENC_KEY;
  if (!secret) return null;
  // Derive a stable 32-byte key from the configured secret.
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function isEnabled() {
  return !!getKey();
}

function isEncryptedPath(p) {
  return typeof p === "string" && p.endsWith(ENC_SUFFIX);
}

/**
 * Encrypt a plaintext file in place: writes `<path>.enc`, deletes the plaintext,
 * and returns the new encrypted path. No-op (returns the original path) when
 * encryption is not configured.
 */
function encryptFileInPlace(plainPath) {
  const key = getKey();
  if (!key) return plainPath;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = fs.readFileSync(plainPath);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encPath = plainPath + ENC_SUFFIX;
  fs.writeFileSync(encPath, Buffer.concat([iv, tag, ciphertext]));
  fs.unlinkSync(plainPath);
  return encPath;
}

/** Decrypt an encrypted file to a Buffer (throws if the key is wrong/missing). */
function decryptToBuffer(encPath) {
  const key = getKey();
  if (!key) throw new Error("File encryption key not configured");
  const data = fs.readFileSync(encPath);
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { isEnabled, isEncryptedPath, encryptFileInPlace, decryptToBuffer, ENC_SUFFIX };
