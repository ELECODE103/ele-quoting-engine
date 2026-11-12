/**
 * The owner's (admin) account.
 *
 * ADMIN_EMAIL names its address. The account is PROVISIONED OUT OF BAND — it is
 * never the result of anything a visitor can do (independent review 2026-11-11,
 * F3). The rule used to be "the account that holds ADMIN_EMAIL becomes the admin
 * once its email is confirmed", so whoever registered that address first was
 * promoted when the real owner clicked the confirmation link in his own inbox.
 * Now:
 *
 *   - the admin address cannot be registered, confirmed or reset through the
 *     public pages (routes/auth.js answers for it exactly as for any address
 *     that is already taken), and no public route changes a role;
 *   - the admin account is made by a ONE-TIME SETUP that only the person who
 *     controls the host's variables can perform:
 *
 *       1. The owner invents a setup code (at least MIN_CODE_LENGTH characters)
 *          and sets it himself as ADMIN_SETUP_CODE in the host's variables.
 *          The server never generates it, logs it or sends it anywhere.
 *       2. While there is NO admin account, POST /api/auth/admin-setup accepts
 *          that code with a new password, creates the account (role admin,
 *          address confirmed) and signs in; the admin pages then force
 *          two-step enrolment before anything else opens.
 *       3. If an ordinary account already holds the address (someone registered
 *          it before this rule existed), setup takes it over: new password,
 *          every session and emailed link of that account ended, two-step
 *          cleared, address confirmed, role set. An audit line is written.
 *       4. The moment an admin exists, setup is closed. A code is accepted
 *          once, ever (its keyed hash is kept on the account). The startup log
 *          says to remove the variable.
 *
 *   An admin that already exists in the database is never touched by any of
 *   this: no role is given or taken at startup.
 *
 * ADMIN_RECOVERY is the owner's way back in without touching the database. Set
 * it in the host's variables, restart, do the thing, then remove it:
 *   ADMIN_RECOVERY=setup-code   re-open the one-time setup for the ADMIN_EMAIL
 *                               account although an admin exists (lost password
 *                               and no working mailbox): needs a NEW
 *                               ADMIN_SETUP_CODE; sets a new password, ends the
 *                               account's sessions and clears two-step, exactly
 *                               like a first setup.
 *   ADMIN_RECOVERY=reset-2fa    switch two-step sign-in off for that account
 *                               (lost phone and lost recovery codes) and end
 *                               its sessions. Enrol again right after.
 * (ADMIN_RECOVERY=verify-email no longer exists: it marked whatever account
 * held the address as confirmed, which is what promoted a squatter.)
 * While the variable is set a warning is printed at every start.
 */
const bcrypt = require("bcryptjs");
const { usersDB } = require("../models");
const session = require("./session");
const keys = require("./keys");
const passwords = require("./passwords");
const { createThrottle } = require("./throttle");

const MIN_CODE_LENGTH = 20;
const MIN_DISTINCT_CHARS = 8;
const BCRYPT_COST = 12;
const CLIENT_FAILURES_MAX = 5;      // wrong codes one client may send in 15 minutes
const GLOBAL_FAILURES_MAX = 20;     // wrong codes from everyone before setup locks until the next restart

const clientFailures = createThrottle({ windowMs: 15 * 60 * 1000, max: CLIENT_FAILURES_MAX });
let globalFailures = 0;
let lockLogged = false;

function adminEmail() {
  return (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
}

/** Is this (already normalised) address the one reserved for the admin account? */
function isAdminAddress(email) {
  const admin = adminEmail();
  return Boolean(admin) && typeof email === "string" && email === admin;
}

/** An account that holds the admin address without being the admin: it may not be confirmed, reset or promoted by any public route. */
function isReservedAccount(user) {
  return Boolean(user) && isAdminAddress(user.email) && user.role !== "admin";
}

function ownerAccount() {
  const email = adminEmail();
  return email ? usersDB.getAll().find((u) => u.email === email) || null : null;
}

function adminExists() {
  return usersDB.getAll().some((u) => u.role === "admin");
}

function recoveryAction() {
  return (process.env.ADMIN_RECOVERY || "").trim().toLowerCase();
}

/** The code the owner set, or "" (surrounding white space from a pasted value is dropped). */
function setupCode() {
  return typeof process.env.ADMIN_SETUP_CODE === "string" ? process.env.ADMIN_SETUP_CODE.trim() : "";
}

/** Why the configured code cannot be used, or null. Never returns or logs the code. */
function codeProblem(code = setupCode()) {
  if (!code) return "not-set";
  if (code.length < MIN_CODE_LENGTH) return "too-short";
  if (new Set(code).size < MIN_DISTINCT_CHARS) return "too-simple";
  return null;
}

function codeMac(code) {
  return keys.mac("admin-setup-code-v1", code);
}

function codeAlreadyUsed(code = setupCode()) {
  if (!code) return false;
  const mac = codeMac(code);
  return usersDB.getAll().some((u) => u.setupCodeMac && keys.safeEqual(u.setupCodeMac, mac));
}

/**
 * Is the one-time setup open right now?
 * @returns {{open: boolean, reason: string, recovery: boolean}}
 */
function setupState() {
  const recovery = recoveryAction() === "setup-code";
  if (!adminEmail()) return { open: false, reason: "no-admin-email", recovery };
  const problem = codeProblem();
  if (problem) return { open: false, reason: `code-${problem}`, recovery };
  if (globalFailures >= GLOBAL_FAILURES_MAX) return { open: false, reason: "locked", recovery };
  if (codeAlreadyUsed()) return { open: false, reason: "code-used", recovery };
  if (adminExists() && !recovery) return { open: false, reason: "admin-exists", recovery };
  return { open: true, reason: recovery && adminExists() ? "recovery" : "first-setup", recovery };
}

/**
 * Try the one-time setup.
 * @param {{code: string, password: string, client: string}} p  client: the caller's rate-limit key
 * @returns {Promise<{ok: true, user: object, tookOver: boolean} | {ok: false, status: number, code: string, error: string}>}
 *   Every refusal that is not about the new password is the same answer (`setup-refused`): it does not
 *   say whether setup is open, whether an admin exists, or how close a code was.
 */
async function attemptSetup({ code, password, client }) {
  const refused = { ok: false, status: 403, code: "setup-refused", error: "That didn't work. Check the setup code and try again. If the admin account has already been set up, sign in instead." };
  const now = Date.now();
  if (clientFailures.peek(client, now).limited) {
    return { ok: false, status: 429, code: "rate-limited", error: "Too many tries. Wait 15 minutes and try again." };
  }
  const state = setupState();
  const given = typeof code === "string" ? code.trim() : "";
  // Compared as keyed hashes of equal length, in constant time, whether or not setup is open.
  const expected = codeMac(state.open ? setupCode() : `closed:${now}`);
  const match = keys.safeEqual(codeMac(given), expected) && given.length > 0;
  if (!state.open || !match) {
    clientFailures.hit(client, now);
    if (state.open) {
      globalFailures++;
      if (globalFailures >= GLOBAL_FAILURES_MAX && !lockLogged) {
        lockLogged = true;
        console.error(`SECURITY: admin setup is LOCKED after ${GLOBAL_FAILURES_MAX} wrong setup codes. It stays locked until the server restarts. Set a new ADMIN_SETUP_CODE and redeploy.`);
      }
    }
    return refused;
  }

  const email = adminEmail();
  const problem = passwords.problem(password, { email });
  if (problem) return { ok: false, status: 400, code: "weak-password", error: problem };
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  // Re-check after the slow hash: two requests with the right code, one wins.
  const again = setupState();
  if (!again.open) return refused;

  const stamp = new Date().toISOString();
  const fields = {
    passwordHash,
    passwordChangedAt: stamp,
    role: "admin",
    emailVerifiedAt: stamp,
    emailVerifyNonce: null,
    lockedUntil: null,
    // Two-step starts from nothing: the admin pages force enrolment before anything else opens.
    totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [],
    setupCodeMac: codeMac(setupCode()),
  };
  const existing = ownerAccount();
  let user;
  if (existing) {
    // Whoever held the address (a squatter, an old customer account, or — in recovery — the admin
    // himself) loses every session and every emailed link issued for the account.
    user = session.bumpTokenVersion(existing, fields);
    console.warn(`AUDIT admin-setup: the existing account for ADMIN_EMAIL (id ${String(existing.id).slice(0, 8)}, role was "${existing.role || "customer"}", created ${existing.createdAt || "?"}) was taken over by the one-time setup: new password, sessions and links ended, two-step cleared, address confirmed, role admin.`);
  } else {
    user = usersDB.insert({ email, name: "", company: "", phone: "", tokenVersion: 0, ...fields });
    console.warn(`AUDIT admin-setup: the admin account for ADMIN_EMAIL was created by the one-time setup (id ${String(user.id).slice(0, 8)}).`);
  }
  try {
    require("../services/audit").record({ actor: { userId: user.id, email }, area: "admin-account", action: existing ? (again.recovery && existing.role === "admin" ? "recovery" : "takeover") : "create", target: email, changes: { role: [existing ? existing.role || "customer" : null, "admin"] } });
  } catch { /* the console line above is the record of last resort */ }
  console.warn("Admin setup is now CLOSED. Remove ADMIN_SETUP_CODE" + (again.recovery ? " and ADMIN_RECOVERY" : "") + " from the host's variables.");
  return { ok: true, user, tookOver: Boolean(existing) };
}

/**
 * Called once the database is seeded. Gives nobody a role and takes none away.
 * Returns what it found, for the log and the tests.
 */
function ensureAtStartup() {
  const email = adminEmail();
  const result = { adminEmail: email, found: false, adminExists: adminExists(), promoted: false, setupOpen: false, setupReason: "", recovery: null, reserved: false, otherAdmins: [] };
  if (!email) return result;
  let owner = ownerAccount();
  result.found = Boolean(owner);

  const recovery = recoveryAction();
  if (recovery === "reset-2fa") {
    if (!owner || owner.role !== "admin") {
      console.warn("WARNING: ADMIN_RECOVERY=reset-2fa is set but there is no admin account for ADMIN_EMAIL. Nothing was done.");
    } else {
      owner = session.bumpTokenVersion(owner, { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] });
      result.recovery = "reset-2fa";
      console.warn("WARNING: ADMIN_RECOVERY=reset-2fa — two-step sign-in was switched OFF for the ADMIN_EMAIL account and its sessions were ended. Sign in, enrol again, and remove ADMIN_RECOVERY now.");
    }
  } else if (recovery === "setup-code") {
    result.recovery = "setup-code";
  } else if (recovery === "verify-email") {
    console.warn("WARNING: ADMIN_RECOVERY=verify-email no longer exists and did nothing. To get back into the admin account without email, set ADMIN_RECOVERY=setup-code with a new ADMIN_SETUP_CODE (docs/security/hardening-2026-11-11-accounts.md).");
  } else if (recovery) {
    console.warn("WARNING: ADMIN_RECOVERY is set to a value that is not a known action (setup-code, reset-2fa). Nothing was done.");
  }

  const state = setupState();
  result.setupOpen = state.open;
  result.setupReason = state.reason;
  result.reserved = isReservedAccount(owner);

  if (result.adminExists) {
    console.log(owner && owner.role === "admin" ? `  Admin account ${email}: present.` : "  An admin account is present.");
    if (state.open) console.warn("WARNING: ADMIN_RECOVERY=setup-code — the one-time admin setup is OPEN for the ADMIN_EMAIL account at /admin/setup for whoever holds ADMIN_SETUP_CODE. Use it, then remove ADMIN_RECOVERY and ADMIN_SETUP_CODE.");
    else if (setupCode()) console.warn("WARNING: ADMIN_SETUP_CODE is still set. Setup is closed (an admin account exists" + (state.reason === "code-used" ? " and this code has been used" : "") + "), so the variable does nothing: remove it.");
  } else if (state.open) {
    console.warn("NOTICE: there is no admin account yet. The one-time admin setup is OPEN at /admin/setup for whoever holds ADMIN_SETUP_CODE. It closes the moment the account is made.");
  } else {
    const why = {
      "code-not-set": "ADMIN_SETUP_CODE is not set",
      "code-too-short": `ADMIN_SETUP_CODE is shorter than ${MIN_CODE_LENGTH} characters`,
      "code-too-simple": `ADMIN_SETUP_CODE has fewer than ${MIN_DISTINCT_CHARS} different characters`,
      "code-used": "this ADMIN_SETUP_CODE has already been used once",
      locked: "setup is locked after too many wrong codes",
    }[state.reason] || state.reason;
    console.warn(`WARNING: there is no admin account, and nobody can make one: ${why}. To set the admin account up, invent a setup code of at least ${MIN_CODE_LENGTH} characters, set it as ADMIN_SETUP_CODE in the host's variables, restart, and open /admin/setup.`);
  }
  if (result.reserved) {
    console.warn(`WARNING: an ordinary account (id ${String(owner.id).slice(0, 8)}, created ${owner.createdAt || "?"}) already uses the ADMIN_EMAIL address. It is NOT an admin and cannot become one, be confirmed or be reset from the public pages. The one-time setup takes it over.`);
  }

  // An admin whose address is not ADMIN_EMAIL is worth a line in the deploy log.
  result.otherAdmins = usersDB.getAll().filter((u) => u.role === "admin" && u.email !== email).map((u) => u.email);
  if (result.otherAdmins.length) console.warn(`WARNING: ${result.otherAdmins.length} admin account(s) besides ADMIN_EMAIL: ${result.otherAdmins.join(", ")}`);
  return result;
}

function resetForTests() {
  clientFailures.reset();
  globalFailures = 0;
  lockLogged = false;
}

module.exports = {
  ensureAtStartup, ownerAccount, adminEmail, isAdminAddress, isReservedAccount, adminExists,
  setupState, attemptSetup, codeProblem, resetForTests,
  MIN_CODE_LENGTH, CLIENT_FAILURES_MAX, GLOBAL_FAILURES_MAX,
};
