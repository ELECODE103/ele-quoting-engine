/**
 * Login sessions.
 *
 * A session is a JWT signed with JWT_SECRET. The browser holds it in an
 * httpOnly, SameSite=Strict cookie (Secure in production), so page script
 * cannot read it; API clients and the test suites may send the same token as
 * `Authorization: Bearer`. Either way the token alone is never enough:
 *
 *   - the account is loaded from the database on every request, so the role
 *     (admin or not), the email-verified flag and a deleted account are read
 *     fresh and nothing inside the token is trusted for them;
 *   - `tv` (token version) must equal the account's: a password change or
 *     "sign out everywhere" bumps it and every older session stops working;
 *   - `jti` must not be in revoked_sessions: signing out ends that session on
 *     the server, not just in the browser;
 *   - an admin's session is good for ADMIN_SESSION_HOURS (default 4) from
 *     sign-in, a customer's for 24 hours.
 *
 * Cookie-borne sessions also need the CSRF token (X-CSRF-Token) on anything
 * that is not a GET. The token is an HMAC of the session id, handed to the
 * page by /api/auth/session, so another site can neither read nor guess it.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { usersDB, revokedSessionsDB, USE_SQLITE } = require("../models");
const keys = require("./keys");

const CUSTOMER_SESSION_HOURS = 24;
const COOKIE_BASE = "se_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function adminSessionHours() {
  const n = Number(process.env.ADMIN_SESSION_HOURS);
  return Number.isFinite(n) && n >= 0.25 && n <= CUSTOMER_SESSION_HOURS ? n : 4;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** `__Host-` pins the cookie to this exact host over HTTPS; it needs Secure, so plain-HTTP dev uses the bare name. */
function cookieName() {
  return isProduction() ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function loginSecret() {
  return keys.baseSecret();
}

/** Accounts from before verification existed (JSON store: no such field at all) count as verified. */
function isEmailVerified(user) {
  if (!user) return false;
  if (user.emailVerifiedAt) return true;
  return !USE_SQLITE && !("emailVerifiedAt" in user);
}

function hasTwoFactor(user) {
  return Boolean(user && user.totpEnabledAt && user.totpSecretEnc);
}

function sessionHours(user) {
  return user.role === "admin" ? adminSessionHours() : CUSTOMER_SESSION_HOURS;
}

function csrfTokenFor(sessionId) {
  return keys.mac("csrf-v1", sessionId);
}

/** What the browser may know about the signed-in account. Never includes hashes or secrets. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    company: user.company || "",
    phone: user.phone || "",
    role: user.role || "customer",
    emailVerified: isEmailVerified(user),
    twoFactorEnabled: hasTwoFactor(user),
    // An admin must switch two-step sign-in on before any admin page opens.
    twoFactorRequired: adminEnrolmentRequired(user),
    createdAt: user.createdAt,
  };
}

/**
 * Start a session for `user`. Sets the cookie when `res` is given.
 * @returns {{token: string, csrfToken: string, expiresAt: string}}
 */
function issue(user, res, req) {
  const jti = crypto.randomUUID();
  const hours = sessionHours(user);
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role || "customer", tv: Number(user.tokenVersion) || 0, jti },
    loginSecret(),
    { expiresIn: Math.round(hours * 3600), algorithm: "HS256" }
  );
  if (res) setCookie(res, token, hours * 3600, req);
  return { token, csrfToken: csrfTokenFor(jti), expiresAt: new Date(Date.now() + hours * 3600e3).toISOString() };
}

function setCookie(res, token, maxAgeSeconds, req) {
  const secure = isProduction() || Boolean(req && req.secure);
  const parts = [`${cookieName()}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.max(0, Math.round(maxAgeSeconds))}`];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, req) {
  setCookie(res, "", 0, req);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header || typeof header !== "string") return "";
  for (const piece of header.split(";")) {
    const i = piece.indexOf("=");
    if (i < 0) continue;
    if (piece.slice(0, i).trim() === name) return piece.slice(i + 1).trim();
  }
  return "";
}

/** The session token on this request and how it arrived. A Bearer header wins over the cookie. */
function credential(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return { token: auth.slice(7).trim(), via: "bearer" };
  const fromCookie = readCookie(req, cookieName());
  if (fromCookie) return { token: fromCookie, via: "cookie" };
  return { token: "", via: "none" };
}

/**
 * Resolve the session on a request.
 * @returns {{ok: true, user: object, claims: object, via: string} | {ok: false, reason: string}}
 */
function resolve(req) {
  const { token, via } = credential(req);
  if (!token) return { ok: false, reason: "none" };
  let claims;
  try {
    claims = jwt.verify(token, loginSecret(), { algorithms: ["HS256"] });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // Other signed values (quote links, reset links…) carry an audience and a different key; a session has neither.
  if (!claims || !claims.userId || !claims.jti || claims.aud !== undefined) return { ok: false, reason: "invalid" };
  const user = usersDB.getById(claims.userId);
  if (!user) return { ok: false, reason: "invalid" };
  if ((Number(user.tokenVersion) || 0) !== (Number(claims.tv) || 0)) return { ok: false, reason: "superseded" };
  if (revokedSessionsDB.getById(claims.jti)) return { ok: false, reason: "signed-out" };
  // An account that became an admin after sign-in still gets the shorter admin lifetime.
  if (user.role === "admin" && claims.iat && Date.now() / 1000 - claims.iat > adminSessionHours() * 3600) return { ok: false, reason: "expired" };
  return { ok: true, user, claims, via };
}

function csrfOk(req, session) {
  if (session.via !== "cookie" || SAFE_METHODS.has(req.method)) return true;
  const sent = req.headers["x-csrf-token"];
  return typeof sent === "string" && keys.safeEqual(sent, csrfTokenFor(session.claims.jti));
}

/** Text and code of the refusal an admin gets on every admin route until two-step sign-in is switched on. */
const ENROLMENT_REQUIRED = { error: "Set up two-step sign-in before using the admin pages.", code: "two-factor-enrolment-required" };

/** An admin account that has not switched two-step sign-in on yet. */
function adminEnrolmentRequired(user) {
  return Boolean(user && user.role === "admin" && !hasTwoFactor(user));
}

function attach(req, session) {
  const { user, claims } = session;
  // Two-step sign-in is required for the admin role (owner decision, 2026-11-11).
  // Until it is switched on, an admin account's session carries the customer
  // role: every check of `req.user.role === "admin"`, in any route, fails closed.
  // Only the enrolment endpoints (requireAdminAccount) know the account by its stored role.
  const pending = adminEnrolmentRequired(user);
  req.user = {
    userId: user.id,
    email: user.email,
    role: pending ? "customer" : (user.role || "customer"),
    adminEnrolmentRequired: pending,
    emailVerified: isEmailVerified(user),
    twoFactorEnabled: hasTwoFactor(user),
    sessionId: claims.jti,
    sessionExpiresAt: claims.exp,
    via: session.via,
  };
  req.account = user;
}

// ─── Middleware ────────────────────────────────────────────────

function authenticate(req, res, next) {
  const session = resolve(req);
  if (!session.ok) {
    if (session.reason === "none") return res.status(401).json({ error: "Authentication required", code: "auth-required" });
    return res.status(401).json({ error: "Invalid or expired token", code: "session-ended" });
  }
  if (!csrfOk(req, session)) return res.status(403).json({ error: "This request could not be confirmed as coming from our site. Reload the page and try again.", code: "csrf" });
  attach(req, session);
  next();
}

/** Sets req.user when a valid session is present; never rejects. A cookie session without its CSRF token is treated as a guest. */
function optionalAuth(req, res, next) {
  const session = resolve(req);
  if (session.ok && csrfOk(req, session)) attach(req, session);
  next();
}

/**
 * After `authenticate`. The role comes from the database row loaded for this
 * request, and counts only once two-step sign-in is on: an admin who has not
 * enrolled gets 403 with a code the page turns into the enrolment screen.
 */
function requireAdmin(req, res, next) {
  if (req.user && req.user.adminEnrolmentRequired) return res.status(403).json(ENROLMENT_REQUIRED);
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/**
 * After `authenticate`. For the two-step enrolment endpoints only: the account
 * is an admin by its stored role, enrolled or not. Nothing else may use this.
 */
function requireAdminAccount(req, res, next) {
  if (!req.account || req.account.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/** End one session on the server. */
function revoke(sessionId, userId, expSeconds) {
  if (!sessionId) return;
  sweepRevoked();
  if (revokedSessionsDB.getById(sessionId)) return;
  const expiresAt = new Date((expSeconds ? expSeconds * 1000 : Date.now() + CUSTOMER_SESSION_HOURS * 3600e3)).toISOString();
  revokedSessionsDB.insert({ id: sessionId, userId: userId || null, expiresAt });
}

/** Drop revocation rows whose token has expired anyway. */
function sweepRevoked(now = Date.now()) {
  let removed = 0;
  for (const row of revokedSessionsDB.getAll()) {
    if (!row.expiresAt || new Date(row.expiresAt).getTime() < now) { revokedSessionsDB.delete(row.id); removed++; }
  }
  return removed;
}

/** End every session of an account (password change, two-factor change, "sign out everywhere"). */
function bumpTokenVersion(user, extra = {}) {
  return usersDB.update(user.id, { tokenVersion: (Number(user.tokenVersion) || 0) + 1, ...extra });
}

module.exports = {
  authenticate, optionalAuth, requireAdmin, requireAdminAccount, adminEnrolmentRequired, ENROLMENT_REQUIRED,
  issue, resolve, revoke, sweepRevoked, bumpTokenVersion, clearCookie, credential,
  publicUser, isEmailVerified, hasTwoFactor, csrfTokenFor, cookieName,
  adminSessionHours, CUSTOMER_SESSION_HOURS,
};
