/**
 * Short-lived signed values that are not logins. Each kind has its own key
 * (derived from JWT_SECRET) and its own audience, so none of them can stand in
 * for another, for a session, or for a firm-quote link.
 *
 *   human         "a person passed the bot check a moment ago" — sent with
 *                 uploads and pricing so the quote tool challenges once
 *   form          issued when a form is shown; proves how long ago that was
 *                 (minimum time to submit) and may be spent once
 *   email-verify  the link in the "confirm your email" message (24 hours)
 *   password-reset the link in the reset message (1 hour, tied to the current
 *                 password so it dies the moment the password changes)
 *   part-edit     lets the browser that uploaded a part change its DXF units
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const keys = require("./keys");

const KINDS = {
  human: { ttl: 60 * 60 },
  form: { ttl: 12 * 60 * 60 },
  "email-verify": { ttl: 24 * 60 * 60 },
  "password-reset": { ttl: 60 * 60 },
};

function key(kind) {
  return keys.derive(`token:${kind}:v1`);
}

/**
 * @param {keyof KINDS} kind
 * @param {object} claims
 * @param {{now?: number}} [opts]  `now` (ms) back- or forward-dates the token; used by the suites
 */
function sign(kind, claims = {}, { now = Date.now() } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`unknown token kind ${kind}`);
  const iat = Math.floor(now / 1000);
  return jwt.sign({ ...claims, jti: crypto.randomUUID(), iat, exp: iat + spec.ttl }, key(kind), { audience: kind, algorithm: "HS256" });
}

/**
 * @returns {{ok: true, claims: object} | {ok: false, reason: "invalid"|"expired"}}
 */
function verify(kind, token) {
  if (!KINDS[kind] || typeof token !== "string" || token.length === 0 || token.length > 4096) return { ok: false, reason: "invalid" };
  try {
    const claims = jwt.verify(token, key(kind), { audience: kind, algorithms: ["HS256"] });
    return { ok: true, claims };
  } catch (err) {
    return { ok: false, reason: err && err.name === "TokenExpiredError" ? "expired" : "invalid" };
  }
}

/** Key the uploader's browser holds for one part. Not time-limited: it only ever unlocks that part's units. */
function partEditKey(partId) {
  return keys.mac("part-edit-v1", partId).slice(0, 40);
}
function partEditKeyOk(partId, given) {
  return typeof given === "string" && given.length > 0 && keys.safeEqual(given, partEditKey(partId));
}

module.exports = { sign, verify, partEditKey, partEditKeyOk, KINDS };
