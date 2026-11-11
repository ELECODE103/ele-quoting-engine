/**
 * Time-based one-time passwords (RFC 6238, on RFC 4226 HOTP) with Node's
 * crypto: SHA-1, 6 digits, 30-second steps — what Google Authenticator,
 * 1Password, Authy and Microsoft Authenticator all read from a QR code.
 * Checked against the RFC's own test vectors in totp.test.js.
 */
const crypto = require("crypto");

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (the form authenticator apps take). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter, { digits = DIGITS, algorithm = "sha1" } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function stepAt(timeMs = Date.now()) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

/** The code for `secret` (base32) at a moment in time. */
function codeAt(secret, timeMs = Date.now(), opts) {
  return hotp(base32Decode(secret), stepAt(timeMs), opts);
}

/**
 * Check a code, allowing one step either side for clock drift.
 * @param {number|null} lastStep  the step of the last code accepted for this
 *   account; a code from that step or earlier is refused, so a code that was
 *   seen once cannot be used again.
 * @returns {number|null} the matching step (store it as the new lastStep), or null
 */
function verify(secret, code, { timeMs = Date.now(), window = 1, lastStep = null } = {}) {
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  let key;
  try { key = base32Decode(secret); } catch { return null; }
  if (key.length === 0) return null;
  const now = stepAt(timeMs);
  let matched = null;
  for (let s = now - window; s <= now + window; s++) {
    const expected = hotp(key, s);
    // Compare every candidate so timing does not say which step matched.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given)) && matched === null) matched = s;
  }
  if (matched === null) return null;
  if (lastStep !== null && lastStep !== undefined && matched <= Number(lastStep)) return null;
  return matched;
}

/** otpauth:// URI that authenticator apps read from the QR code. */
function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ─── Recovery codes ────────────────────────────────────────────
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/** `count` codes like "K7QMP-2XWRT" (about 49 bits each). */
function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let s = "";
    while (s.length < 10) {
      const b = crypto.randomBytes(1)[0];
      if (b < RECOVERY_ALPHABET.length * 8) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]; // 248 = 31 × 8: no modulo bias
    }
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}

/** Recovery codes are compared in this form: upper case, no spaces or dashes. */
function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

module.exports = { generateSecret, codeAt, verify, hotp, stepAt, otpauthUri, base32Encode, base32Decode, generateRecoveryCodes, normalizeRecoveryCode, STEP_SECONDS, DIGITS };
