/**
 * Accounts: register, sign in / out, the session, email verification,
 * password reset and two-step sign-in for the admin.
 *
 * The pieces live in server/security/:
 *   session.js     the session token, cookie, CSRF check, revocation
 *   loginGuard.js  failures-only counters per IP and per account
 *   botGuard.js    Turnstile, honeypot, minimum time to submit, form limits
 *   passwords.js   password rules and the common-password list
 *   tokens.js      signed links (verify email, reset password)
 *   totp.js        RFC 6238 codes and recovery codes
 *   secretBox.js   encryption of the two-factor secret at rest
 *
 * What a caller can learn about whether an address has an account:
 *   - sign-in answers the same (words, status, and a password hash is always
 *     computed) for an unknown address and a wrong password, and the
 *     per-address pause applies to unknown addresses too;
 *   - password reset always answers the same and does its work after
 *     answering;
 *   - registration does say when an address is taken. It has to, because a
 *     new account is signed in at once; it is bot-checked and limited per IP.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { usersDB } = require("../models");
const { sanitizeString, isValidEmail } = require("../middleware/validate");
const session = require("../security/session");
const loginGuard = require("../security/loginGuard");
const botGuard = require("../security/botGuard");
const passwords = require("../security/passwords");
const tokens = require("../security/tokens");
const totp = require("../security/totp");
const secretBox = require("../security/secretBox");
const keys = require("../security/keys");
const { createThrottle, clientIp } = require("../security/throttle");
const { accountLinkBase } = require("../security/links");
const mailer = require("../services/mailer");
const templates = require("../emails/templates");
const brand = require("../../shared/brand.json");

const router = express.Router();
const { authenticate, optionalAuth, requireAdmin } = session;

// --- JWT Secret: REQUIRE in production, warn in dev ---
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET environment variable is required in production");
    process.exit(1);
  } else {
    console.warn("WARNING: JWT_SECRET not set - using insecure dev fallback. Do NOT use in production.");
  }
}

const BCRYPT_COST = 12;
const HOUR = 60 * 60 * 1000;
const CALL = `call ${brand.phone}`;

const MSG = {
  badLogin: "That email and password didn't match.",
  locked: (minutes) => `Too many wrong passwords for this address. Sign-in is paused for ${minutes} minute${minutes === 1 ? "" : "s"}. Wait, or reset your password to sign in now.`,
  ipBlocked: `Too many sign-in attempts from this connection. Try again in 15 minutes, or ${CALL}.`,
  resetSent: "If that address has an account, a link to choose a new password is on its way. It works for one hour.",
  resetBad: "This reset link has been used, replaced or has expired. Ask for a new one.",
  verifyBad: "This confirmation link has been used, replaced or has expired. Sign in and ask for a new one.",
};

// --- Rate limiters (per IP) ---
const registerLimiter = rateLimit({
  windowMs: HOUR,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later.", code: "rate-limited" },
});
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Too many attempts. Try again in 15 minutes, or ${CALL}.`, code: "rate-limited" },
});

// Password reset: per IP and per address. Verification resend: per account.
const resetPerIp = createThrottle({ windowMs: HOUR, max: 5 });
const resetPerAddress = createThrottle({ windowMs: HOUR, max: 3 });
const resendPerMinute = createThrottle({ windowMs: 60 * 1000, max: 1 });
const resendPerDay = createThrottle({ windowMs: 24 * HOUR, max: 5 });
const lockMailPerDay = createThrottle({ windowMs: 24 * HOUR, max: 3 });

/** Unsafe requests to this router carry JSON (or nothing). A form posted from another site is refused before it is read. */
function jsonOnly(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const type = req.headers["content-type"];
  if (type) {
    if (!/^application\/json\b/i.test(type)) return res.status(415).json({ error: "Send this request as JSON." });
  } else if (Number(req.headers["content-length"]) > 0) {
    return res.status(415).json({ error: "Send this request as JSON." });
  }
  next();
}
router.use(jsonOnly);

function normalizeEmail(email) {
  return String(email || "").toLowerCase().trim();
}

function findByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return usersDB.getAll().find((u) => u.email === e) || null;
}

// A real bcrypt hash of a random value: an unknown address costs the same work as a wrong password.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash(crypto.randomBytes(24).toString("hex"), BCRYPT_COST);
  return dummyHashPromise;
}
dummyHash();

function sessionBody(user, issued) {
  return {
    token: issued.token,
    csrfToken: issued.csrfToken,
    expiresAt: issued.expiresAt,
    user: session.publicUser(user),
    // Is confirming the email enforced right now? Not while the mailer is unconfigured: no link could be sent.
    verificationEnforced: mailer.configured(),
  };
}

// ─── Email verification ────────────────────────────────────────

/** The link in the "confirm your email" message. Rides in the URL fragment so it never reaches a server log. */
function verificationUrl(user, req) {
  const token = tokens.sign("email-verify", { uid: user.id, email: user.email, n: user.emailVerifyNonce });
  return `${accountLinkBase(req)}/verify-email#token=${token}`;
}

/** Send (or re-send) the confirmation link. Every link sent in the last 24 hours works until one of them is used. */
function sendVerification(user, req) {
  let u = user;
  if (!u.emailVerifyNonce) u = usersDB.update(u.id, { emailVerifyNonce: crypto.randomBytes(16).toString("hex") });
  return mailer.send({ to: u.email, replyTo: mailer.shopNotifyAddress(), ...templates.verifyEmail({ verifyUrl: verificationUrl(u, req) }) });
}

/**
 * The address named in ADMIN_EMAIL becomes the admin only once its email is
 * confirmed, so registering that address first on a new database gains nothing.
 */
function promoteIfOwner(user) {
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  if (adminEmail && user.email === adminEmail && session.isEmailVerified(user) && user.role !== "admin") {
    console.log("  Promoted the ADMIN_EMAIL account to the admin role (email confirmed).");
    return usersDB.update(user.id, { role: "admin" });
  }
  return user;
}

// POST /api/auth/register
router.post("/register", registerLimiter, async (req, res) => {
  let check = null;
  try {
    const { email, password, name, company, phone } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const normalizedEmail = normalizeEmail(typeof email === "string" ? email : "");
    if (!isValidEmail(normalizedEmail) || !mailer.cleanAddress(normalizedEmail) || typeof password !== "string") {
      return res.status(400).json({ error: "Please enter a valid email address" });
    }

    // Always-on form checks, then the bot check.
    check = botGuard.checkForm(req, { form: "register", email: normalizedEmail });
    if (!check.ok) {
      if (check.honeypot) return res.status(400).json({ error: `We couldn't create the account. Try again, or ${CALL}.` });
      return res.status(check.status).json({ error: check.error, code: check.code });
    }
    const human = await botGuard.assess(req, { action: "register", allowAccount: false, allowHumanToken: false });
    if (!human.verified && human.method !== "off") {
      botGuard.releaseForm(check);
      return human.method === "unavailable"
        ? res.status(503).json({ error: botGuard.MESSAGES.humanUnavailable, code: "human-check-unavailable" })
        : res.status(403).json({ error: botGuard.MESSAGES.humanRequired, code: "human-check-required" });
    }

    const pwProblem = passwords.problem(password, { email: normalizedEmail });
    if (pwProblem) {
      botGuard.releaseForm(check);
      return res.status(400).json({ error: pwProblem, code: "weak-password" });
    }

    if (findByEmail(normalizedEmail)) {
      botGuard.releaseForm(check);
      return res.status(409).json({ error: "An account with this email already exists. Sign in, or reset the password if you've forgotten it.", code: "account-exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    // Every new account starts as a customer with an unconfirmed address.
    // ADMIN_EMAIL is promoted when its address is confirmed (promoteIfOwner).
    const user = usersDB.insert({
      email: normalizedEmail,
      passwordHash,
      name: sanitizeString(name || "", 100),
      company: sanitizeString(company || "", 100),
      phone: sanitizeString(phone || "", 30),
      role: "customer",
      emailVerifiedAt: null,
      emailVerifyNonce: crypto.randomBytes(16).toString("hex"),
      tokenVersion: 0,
      passwordChangedAt: new Date().toISOString(),
    });
    botGuard.recordForm(req, check, { email: normalizedEmail });

    // Best-effort; a logged no-op until the mailer is configured.
    const sent = await sendVerification(user, req).catch(() => false);

    const issued = session.issue(user, res, req);
    res.status(201).json({ ...sessionBody(user, issued), verificationSent: Boolean(sent) });
  } catch (err) {
    botGuard.releaseForm(check);
    console.error("Registration error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login   { email, password, totp?, recoveryCode? }
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const ip = clientIp(req);
    const emailKey = normalizeEmail(email).slice(0, 254);
    const now = Date.now();

    if (loginGuard.ipBlocked(ip, now)) {
      return res.status(429).json({ error: MSG.ipBlocked, code: "rate-limited" });
    }

    const user = findByEmail(emailKey);

    // Paused? Same answer whether or not the address has an account.
    const until = loginGuard.lockedUntil(emailKey, user, now);
    if (until) {
      const minutes = Math.max(1, Math.ceil((until - now) / 60000));
      return res.status(429).json({ error: MSG.locked(minutes), code: "account-locked", retryAfterSeconds: Math.ceil((until - now) / 1000) });
    }

    // After repeated failures the bot check is part of signing in.
    if (loginGuard.challengeDue(ip, emailKey, now)) {
      const human = await botGuard.assess(req, { action: "login", allowAccount: false, allowHumanToken: false });
      if (!human.verified && human.method !== "off") {
        return human.method === "unavailable"
          ? res.status(503).json({ error: botGuard.MESSAGES.humanUnavailable, code: "human-check-unavailable", challenge: true })
          : res.status(403).json({ error: botGuard.MESSAGES.humanRequired, code: "human-check-required", challenge: true });
      }
    }

    // Always one bcrypt comparison, against a real hash.
    const valid = await bcrypt.compare(password, user ? user.passwordHash : await dummyHash());

    const fail = (extra = {}) => {
      const r = loginGuard.recordFailure(ip, emailKey);
      if (r.locked) lockAccount(user, emailKey, r.until, req);
      return res.status(401).json({
        error: MSG.badLogin, code: "invalid-credentials",
        // Tells the page to show the bot check before the next try.
        challenge: loginGuard.challengeDue(ip, emailKey),
        ...extra,
      });
    };

    if (!user || !valid) return fail();

    // Second step, once enrolled.
    let usedRecovery = false;
    let totpStep = null;
    if (session.hasTwoFactor(user)) {
      const code = typeof req.body.totp === "string" ? req.body.totp : "";
      const recovery = typeof req.body.recoveryCode === "string" ? req.body.recoveryCode : "";
      if (!code && !recovery) {
        // The password was right; nothing is counted. No session yet.
        return res.status(401).json({ error: "Enter the 6-digit code from your authenticator app.", code: "two-factor-required", twoFactor: true });
      }
      if (code) {
        const secret = secretBox.open("totp", user.totpSecretEnc, user.id);
        totpStep = secret ? totp.verify(secret, code, { lastStep: user.totpLastStep }) : null;
        if (totpStep === null) return fail({ error: "That code didn't match. Codes change every 30 seconds; enter the current one.", code: "two-factor-invalid", twoFactor: true });
      } else {
        const hash = recoveryHash(user.id, recovery);
        const left = (user.recoveryCodes || []).filter((h) => !keys.safeEqual(h, hash));
        if (left.length === (user.recoveryCodes || []).length) return fail({ error: "That recovery code isn't valid, or has been used already.", code: "two-factor-invalid", twoFactor: true });
        usersDB.update(user.id, { recoveryCodes: left });
        usedRecovery = true;
      }
    }

    // Signed in.
    loginGuard.clear(emailKey);
    const updates = { lastLoginAt: new Date().toISOString() };
    if (user.lockedUntil) updates.lockedUntil = null;
    if (totpStep !== null) updates.totpLastStep = totpStep;
    const fresh = usersDB.update(user.id, updates) || user;
    if (usedRecovery) mailer.send({ to: fresh.email, ...templates.twoFactorChanged({ change: "recovery-used" }) });

    const issued = session.issue(fresh, res, req);
    res.json({ ...sessionBody(fresh, issued), ...(usedRecovery ? { recoveryCodesLeft: (fresh.recoveryCodes || []).length } : {}) });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * Start a pause. The in-memory pause is already in force; what is left is to
 * write it to the account (so it survives a restart) and tell the owner. Both
 * happen after the response has gone, so the answer takes the same time for an
 * address with no account.
 */
function lockAccount(user, emailKey, until, req) {
  if (!user) return;
  const base = accountLinkBase(req);
  setImmediate(() => {
    try {
      usersDB.update(user.id, { lockedUntil: new Date(until).toISOString(), lockNotifiedAt: new Date().toISOString() });
      // At most a few of these a day per account, however long the guessing goes on.
      if (!lockMailPerDay.peek(emailKey).limited) {
        lockMailPerDay.hit(emailKey);
        mailer.send({ to: user.email, ...templates.accountLocked({ minutes: loginGuard.LOCK_MINUTES, resetUrl: `${base}/forgot-password` }) });
      }
    } catch (err) {
      console.error("Lock bookkeeping error:", err.message);
    }
  });
}

// POST /api/auth/logout — ends this session on the server.
router.post("/logout", (req, res) => {
  const s = session.resolve(req);
  if (s.ok) session.revoke(s.claims.jti, s.user.id, s.claims.exp);
  session.clearCookie(res, req);
  res.json({ ok: true });
});

// POST /api/auth/logout-all — ends every session of the account.
router.post("/logout-all", authenticate, (req, res) => {
  session.bumpTokenVersion(req.account);
  session.clearCookie(res, req);
  res.json({ ok: true });
});

// GET /api/auth/session — who is signed in (the page asks on load; the cookie itself is not readable by script).
router.get("/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  const s = session.resolve(req);
  if (!s.ok) {
    if (s.reason !== "none") session.clearCookie(res, req);
    return res.json({ authenticated: false, verificationEnforced: mailer.configured() });
  }
  res.json({
    authenticated: true,
    user: session.publicUser(s.user),
    csrfToken: session.csrfTokenFor(s.claims.jti),
    expiresAt: new Date(s.claims.exp * 1000).toISOString(),
    verificationEnforced: mailer.configured(),
  });
});

// POST /api/auth/verify-email   { token }
router.post("/verify-email", tokenLimiter, (req, res) => {
  const v = tokens.verify("email-verify", req.body && req.body.token);
  if (!v.ok) return res.status(400).json({ error: MSG.verifyBad, code: v.reason === "expired" ? "link-expired" : "link-invalid" });
  const user = usersDB.getById(v.claims.uid);
  if (!user || user.email !== v.claims.email) return res.status(400).json({ error: MSG.verifyBad, code: "link-invalid" });
  if (session.isEmailVerified(user)) return res.json({ verified: true, already: true, email: user.email });
  if (!user.emailVerifyNonce || !v.claims.n || !keys.safeEqual(user.emailVerifyNonce, v.claims.n)) {
    return res.status(400).json({ error: MSG.verifyBad, code: "link-invalid" });
  }
  let updated = usersDB.update(user.id, { emailVerifiedAt: new Date().toISOString(), emailVerifyNonce: null });
  updated = promoteIfOwner(updated);
  res.json({ verified: true, already: false, email: updated.email, role: updated.role });
});

// POST /api/auth/verify-email/resend — signed-in account asks for the link again.
router.post("/verify-email/resend", authenticate, async (req, res) => {
  const user = req.account;
  if (session.isEmailVerified(user)) return res.json({ sent: false, verified: true });
  if (resendPerMinute.peek(user.id).limited) return res.status(429).json({ error: "We just sent one. Give it a minute, and check the spam folder.", code: "rate-limited" });
  if (resendPerDay.peek(user.id).limited) return res.status(429).json({ error: `That's the limit for today. If the email isn't arriving, ${CALL}.`, code: "rate-limited" });
  resendPerMinute.hit(user.id);
  resendPerDay.hit(user.id);
  const sent = await sendVerification(user, req).catch(() => false);
  res.json({ sent: Boolean(sent), verified: false, configured: mailer.configured() });
});

// ─── Password reset ────────────────────────────────────────────

/** Ties a reset link to the password it was issued for: once the password (or token version) changes, the link is dead. */
function resetBinding(user) {
  return keys.mac("password-reset-bind-v1", `${user.id}:${user.passwordHash}:${Number(user.tokenVersion) || 0}`).slice(0, 32);
}

// POST /api/auth/password-reset/request   { email }
// Always the same answer. The lookup and the email happen after the response.
router.post("/password-reset/request", async (req, res) => {
  let check = null;
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: "Please enter a valid email address" });
    const ip = clientIp(req);
    if (resetPerIp.peek(ip).limited) return res.status(429).json({ error: `Too many reset requests from this connection. Try again in an hour, or ${CALL}.`, code: "rate-limited" });

    check = botGuard.checkForm(req, { form: "password-reset", email: "" });
    if (!check.ok) {
      if (check.honeypot) return res.json({ ok: true, message: MSG.resetSent });
      return res.status(check.status).json({ error: check.error, code: check.code });
    }
    const human = await botGuard.assess(req, { action: "password-reset", allowAccount: false, allowHumanToken: false });
    if (!human.verified && human.method !== "off") {
      botGuard.releaseForm(check);
      return human.method === "unavailable"
        ? res.status(503).json({ error: botGuard.MESSAGES.humanUnavailable, code: "human-check-unavailable" })
        : res.status(403).json({ error: botGuard.MESSAGES.humanRequired, code: "human-check-required" });
    }
    resetPerIp.hit(ip);
    botGuard.recordForm(req, check, {});

    const base = accountLinkBase(req);
    res.json({ ok: true, message: MSG.resetSent });

    setImmediate(() => {
      try {
        const user = findByEmail(email);
        if (!user) return;
        if (resetPerAddress.peek(email).limited) return;
        resetPerAddress.hit(email);
        const token = tokens.sign("password-reset", { uid: user.id, b: resetBinding(user) });
        mailer.send({ to: user.email, ...templates.passwordResetRequested({ resetUrl: `${base}/reset-password#token=${token}` }) });
      } catch (err) {
        console.error("Password reset request error:", err.message);
      }
    });
  } catch (err) {
    botGuard.releaseForm(check);
    console.error("Password reset request error:", err.message);
    res.status(500).json({ error: `Something went wrong on our side. Try again, or ${CALL}.` });
  }
});

function resetTarget(token) {
  const v = tokens.verify("password-reset", token);
  if (!v.ok) return null;
  const user = usersDB.getById(v.claims.uid);
  if (!user || !v.claims.b || !keys.safeEqual(v.claims.b, resetBinding(user))) return null;
  return user;
}

// POST /api/auth/password-reset/check   { token } — lets the page say "link expired" before a password is typed.
router.post("/password-reset/check", tokenLimiter, (req, res) => {
  res.json({ valid: Boolean(resetTarget(req.body && req.body.token)) });
});

// POST /api/auth/password-reset/confirm   { token, password }
router.post("/password-reset/confirm", tokenLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const user = resetTarget(token);
    if (!user) return res.status(400).json({ error: MSG.resetBad, code: "link-invalid" });
    const pwProblem = passwords.problem(password, { email: user.email });
    if (pwProblem) return res.status(400).json({ error: pwProblem, code: "weak-password" });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    // Re-check after the slow hash: two requests with the same link, one wins.
    const current = usersDB.getById(user.id);
    if (!current || !keys.safeEqual(resetBinding(current), resetBinding(user))) return res.status(400).json({ error: MSG.resetBad, code: "link-invalid" });

    const now = new Date().toISOString();
    let updated = session.bumpTokenVersion(current, {
      passwordHash,
      passwordChangedAt: now,
      lockedUntil: null,
      // Opening the link proves the mailbox, which is what confirming the address proves.
      ...(session.isEmailVerified(current) ? {} : { emailVerifiedAt: now, emailVerifyNonce: null }),
    });
    updated = promoteIfOwner(updated);
    loginGuard.clear(updated.email);
    session.clearCookie(res, req);
    mailer.send({ to: updated.email, ...templates.passwordChanged({ when: now }) });
    res.json({ ok: true });
  } catch (err) {
    console.error("Password reset confirm error:", err.message);
    res.status(500).json({ error: `Something went wrong on our side. Try again, or ${CALL}.` });
  }
});

// ─── Profile ───────────────────────────────────────────────────

// GET /api/auth/profile
router.get("/profile", authenticate, (req, res) => {
  res.json(session.publicUser(req.account));
});

// PUT /api/auth/profile
router.put("/profile", authenticate, (req, res) => {
  const { name, company, phone } = req.body || {};
  const updates = {};
  if (name !== undefined) updates.name = sanitizeString(name, 100);
  if (company !== undefined) updates.company = sanitizeString(company, 100);
  if (phone !== undefined) updates.phone = sanitizeString(phone, 30);

  const updated = usersDB.update(req.user.userId, updates);
  if (!updated) return res.status(404).json({ error: "User not found" });
  res.json(session.publicUser(updated));
});

// ─── Two-step sign-in (admin) ──────────────────────────────────

function recoveryHash(userId, code) {
  return keys.mac("recovery-code-v1", `${userId}:${totp.normalizeRecoveryCode(code)}`);
}

function newRecoveryCodes(userId) {
  const codes = totp.generateRecoveryCodes(10);
  return { codes, hashes: codes.map((c) => recoveryHash(userId, c)) };
}

const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 15 minutes.", code: "rate-limited" },
});

async function passwordOk(user, password) {
  return typeof password === "string" && password.length > 0 && bcrypt.compare(password, user.passwordHash);
}

/** A current authenticator code, or an unused recovery code (which is then spent). */
function secondFactorOk(user, { code, recoveryCode }) {
  if (typeof code === "string" && code) {
    const secret = secretBox.open("totp", user.totpSecretEnc, user.id);
    const step = secret ? totp.verify(secret, code, { lastStep: user.totpLastStep }) : null;
    if (step === null) return null;
    return { totpLastStep: step };
  }
  if (typeof recoveryCode === "string" && recoveryCode) {
    const hash = recoveryHash(user.id, recoveryCode);
    const left = (user.recoveryCodes || []).filter((h) => !keys.safeEqual(h, hash));
    if (left.length === (user.recoveryCodes || []).length) return null;
    return { recoveryCodes: left };
  }
  return null;
}

// GET /api/auth/2fa — status only; the secret is never returned after setup.
router.get("/2fa", authenticate, requireAdmin, (req, res) => {
  const u = req.account;
  res.set("Cache-Control", "no-store");
  res.json({
    enabled: session.hasTwoFactor(u),
    enabledAt: session.hasTwoFactor(u) ? u.totpEnabledAt : null,
    recoveryCodesLeft: session.hasTwoFactor(u) ? (u.recoveryCodes || []).length : 0,
    setupStarted: Boolean(u.totpPendingEnc),
  });
});

// POST /api/auth/2fa/setup   { password }
// Makes a new secret on the server and shows it once: the setup key and a QR
// code drawn here (no outside service). Nothing is switched on until a code
// from the app is confirmed. Asking again makes a new secret; the old pending
// one is thrown away, never shown again.
router.post("/2fa/setup", twoFactorLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const u = req.account;
    if (session.hasTwoFactor(u)) return res.status(409).json({ error: "Two-step sign-in is already on. Switch it off first to set it up again.", code: "already-enabled" });
    if (!(await passwordOk(u, req.body && req.body.password))) return res.status(401).json({ error: "Enter your current password to set this up.", code: "invalid-credentials" });
    const secret = totp.generateSecret();
    usersDB.update(u.id, { totpPendingEnc: secretBox.seal("totp", secret, u.id) });
    const otpauthUri = totp.otpauthUri({ secret, account: u.email, issuer: brand.name });
    const qrSvg = await require("qrcode").toString(otpauthUri, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    res.set("Cache-Control", "no-store");
    res.json({ setupKey: secret.replace(/(.{4})/g, "$1 ").trim(), otpauthUri, qrSvg });
  } catch (err) {
    console.error("2FA setup error:", err.message);
    res.status(500).json({ error: "Could not start the setup. Try again." });
  }
});

// POST /api/auth/2fa/enable   { code }
// Confirms the app is producing the right codes, switches the second step on,
// and returns ten recovery codes — once. Only their hashes are kept.
router.post("/2fa/enable", twoFactorLimiter, authenticate, requireAdmin, (req, res) => {
  const u = req.account;
  if (session.hasTwoFactor(u)) return res.status(409).json({ error: "Two-step sign-in is already on.", code: "already-enabled" });
  const secret = secretBox.open("totp", u.totpPendingEnc, u.id);
  if (!secret) return res.status(400).json({ error: "Start the setup again to get a new key.", code: "setup-missing" });
  const step = totp.verify(secret, req.body && req.body.code);
  if (step === null) return res.status(400).json({ error: "That code didn't match. Enter the 6-digit code the app shows now.", code: "two-factor-invalid" });
  const { codes, hashes } = newRecoveryCodes(u.id);
  // Every other session of this account ends; this one continues on a fresh token.
  const updated = session.bumpTokenVersion(u, {
    totpSecretEnc: secretBox.seal("totp", secret, u.id),
    totpPendingEnc: null,
    totpEnabledAt: new Date().toISOString(),
    totpLastStep: step,
    recoveryCodes: hashes,
  });
  mailer.send({ to: updated.email, ...templates.twoFactorChanged({ change: "enabled" }) });
  const issued = session.issue(updated, res, req);
  res.set("Cache-Control", "no-store");
  res.json({ enabled: true, recoveryCodes: codes, ...sessionBody(updated, issued) });
});

// POST /api/auth/2fa/recovery-codes   { code }
// New codes (the old ones stop working), shown once. Needs a current authenticator code.
router.post("/2fa/recovery-codes", twoFactorLimiter, authenticate, requireAdmin, (req, res) => {
  const u = req.account;
  if (!session.hasTwoFactor(u)) return res.status(409).json({ error: "Two-step sign-in is not on.", code: "not-enabled" });
  const ok = secondFactorOk(u, { code: req.body && req.body.code });
  if (!ok) return res.status(400).json({ error: "That code didn't match. Enter the 6-digit code the app shows now.", code: "two-factor-invalid" });
  const { codes, hashes } = newRecoveryCodes(u.id);
  usersDB.update(u.id, { ...ok, recoveryCodes: hashes });
  mailer.send({ to: u.email, ...templates.twoFactorChanged({ change: "recovery-codes" }) });
  res.set("Cache-Control", "no-store");
  res.json({ recoveryCodes: codes });
});

// POST /api/auth/2fa/disable   { password, code | recoveryCode }
router.post("/2fa/disable", twoFactorLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const u = req.account;
    if (!session.hasTwoFactor(u)) return res.status(409).json({ error: "Two-step sign-in is not on.", code: "not-enabled" });
    if (!(await passwordOk(u, req.body && req.body.password))) return res.status(401).json({ error: "Enter your current password.", code: "invalid-credentials" });
    if (!secondFactorOk(u, { code: req.body.code, recoveryCode: req.body.recoveryCode })) {
      return res.status(400).json({ error: "That code didn't match.", code: "two-factor-invalid" });
    }
    const updated = session.bumpTokenVersion(u, { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] });
    mailer.send({ to: updated.email, ...templates.twoFactorChanged({ change: "disabled" }) });
    const issued = session.issue(updated, res, req);
    res.json({ enabled: false, ...sessionBody(updated, issued) });
  } catch (err) {
    console.error("2FA disable error:", err.message);
    res.status(500).json({ error: "Could not switch it off. Try again." });
  }
});

module.exports = router;
module.exports.authenticate = authenticate;
module.exports.optionalAuth = optionalAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.promoteIfOwner = promoteIfOwner;
module.exports.sendVerification = sendVerification;
