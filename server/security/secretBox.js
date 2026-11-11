/**
 * AES-256-GCM for small secrets kept in the database (two-factor secrets).
 * The key is derived from JWT_SECRET for one stated purpose; `context` (the
 * account id) is bound in as associated data, so a ciphertext copied onto
 * another account's row does not decrypt.
 *
 * Changing JWT_SECRET makes every stored value unreadable. For two-factor
 * that means the admin enrols again (see ADMIN_RECOVERY in the hardening doc).
 */
const crypto = require("crypto");
const keys = require("./keys");

const VERSION = "v1";

function seal(purpose, plaintext, context = "") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.derive(`box:${purpose}`), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** @returns {string|null} the plaintext, or null when the value is missing, tampered with, or sealed under another key/context */
function open(purpose, sealed, context = "") {
  try {
    const [version, iv, tag, ct] = String(sealed || "").split(".");
    if (version !== VERSION || !iv || !tag || !ct) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys.derive(`box:${purpose}`), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(String(context)));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

module.exports = { seal, open };
