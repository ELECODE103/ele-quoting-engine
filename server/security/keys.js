/**
 * Purpose-bound keys derived from JWT_SECRET.
 *
 * Every kind of signed value (login session, verified-human token, email
 * verification link, password-reset link, form token, part edit key, the key
 * that encrypts two-factor secrets) is signed with its own key, so one kind
 * can never be replayed as another. The firm-quote link key in
 * services/rfqToken.js follows the same pattern.
 */
const crypto = require("crypto");

const DEV_FALLBACK = "dev-secret-DO-NOT-USE-IN-PROD"; // same fallback routes/auth.js has always used outside production

function baseSecret() {
  return process.env.JWT_SECRET || DEV_FALLBACK;
}

/** 32-byte key for `label` (HMAC-SHA256 of the label under JWT_SECRET). */
function derive(label) {
  return crypto.createHmac("sha256", baseSecret()).update(`straightedge:${label}`).digest();
}

/** Hex HMAC-SHA256 of `value` under the key for `label`. */
function mac(label, value) {
  return crypto.createHmac("sha256", derive(label)).update(String(value)).digest("hex");
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { baseSecret, derive, mac, safeEqual };
