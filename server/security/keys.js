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

// With no JWT_SECRET (a developer's machine; production refuses to start without one) the
// secret is a random value made for this process. It used to be a fixed string in the source,
// which anyone could sign with on a server started without `npm start` (no NODE_ENV). Now such a
// server simply forgets its sessions and links at each restart.
let processSecret = null;

function baseSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!processSecret) processSecret = crypto.randomBytes(48).toString("hex");
  return processSecret;
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
