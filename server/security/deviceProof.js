/**
 * "Known device" proof (independent review 2026-11-11, F4).
 *
 * When a sign-in succeeds — or a password reset is completed — the browser is
 * given a long-lived, signed, httpOnly cookie that says "this browser has
 * signed in to account X before". It is not a session and opens nothing: all
 * it does is let that browser's later sign-in attempts be throttled on their
 * own (per device) instead of by the counters an outsider can run up against
 * the address (security/loginGuard.js). So someone hammering an address with
 * wrong passwords cannot lock its owner out of the browser they always use.
 *
 * The proof is per account (it names the account id and is signed with its own
 * key), and a browser can hold a few of them (one per account it has used).
 */
const crypto = require("crypto");
const tokens = require("./tokens");

const COOKIE_BASE = "se_device";
const MAX_PROOFS = 3;
const SEPARATOR = "~"; // not a character a signed token can contain
const MAX_AGE_S = tokens.KINDS.device.ttl;

function isProduction() {
  return process.env.NODE_ENV === "production";
}
function cookieName() {
  return isProduction() ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header || typeof header !== "string") return "";
  for (const piece of header.split(";")) {
    const i = piece.indexOf("=");
    if (i > 0 && piece.slice(0, i).trim() === cookieName()) return piece.slice(i + 1).trim();
  }
  return "";
}

/** Every valid proof on the request: [{ token, uid, id }]. */
function proofs(req) {
  const raw = readCookie(req);
  if (!raw || raw.length > 4096) return [];
  const out = [];
  for (const token of raw.split(SEPARATOR).slice(0, MAX_PROOFS)) {
    const v = tokens.verify("device", token);
    if (v.ok && typeof v.claims.uid === "string" && typeof v.claims.did === "string") out.push({ token, uid: v.claims.uid, id: v.claims.did });
  }
  return out;
}

/** The proof this request holds for `user`, or null. */
function forUser(req, user) {
  if (!user || !user.id) return null;
  return proofs(req).find((p) => p.uid === user.id) || null;
}

/** Give this browser a proof for `user` (keeping the ones it holds for other accounts). */
function issue(res, req, user) {
  if (!res || !user || !user.id) return;
  const kept = proofs(req).filter((p) => p.uid !== user.id).slice(0, MAX_PROOFS - 1).map((p) => p.token);
  const mine = tokens.sign("device", { uid: user.id, did: crypto.randomUUID() });
  const secure = isProduction() || Boolean(req && req.secure);
  const parts = [`${cookieName()}=${[mine, ...kept].join(SEPARATOR)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${MAX_AGE_S}`];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

module.exports = { forUser, issue, proofs, cookieName, MAX_AGE_S };
