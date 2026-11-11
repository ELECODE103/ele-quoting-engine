/**
 * The owner's account.
 *
 * ADMIN_EMAIL names it. The admin role is given to that account only once its
 * email address has been confirmed (by the emailed link, or by a password
 * reset, which proves the same thing). So on a new, empty database nobody can
 * claim the admin role by registering the address before the owner does: an
 * unconfirmed account with that address is an ordinary customer.
 *
 * Accounts that existed before this rule (the owner's among them) were marked
 * confirmed by the migration, so nothing changes for them.
 *
 * ADMIN_RECOVERY is the owner's way back in without touching the database. Set
 * it in the host's variables, restart, then remove it:
 *   ADMIN_RECOVERY=verify-email   mark the ADMIN_EMAIL account's address as
 *                                 confirmed (for a deployment with no mailer,
 *                                 where no link can be sent). Only set it after
 *                                 registering that account yourself and
 *                                 signing in to it once.
 *   ADMIN_RECOVERY=reset-2fa      switch two-step sign-in off for that account
 *                                 (lost phone and lost recovery codes) and end
 *                                 its sessions. Enrol again right after.
 * While the variable is set the action repeats on every start, and a warning
 * is printed, so it is not left in place.
 */
const { usersDB } = require("../models");
const session = require("./session");

function adminEmail() {
  return (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
}

function ownerAccount() {
  const email = adminEmail();
  return email ? usersDB.getAll().find((u) => u.email === email) || null : null;
}

/** Called once the database is seeded. Returns what it did, for the log and the tests. */
function ensureAtStartup() {
  const email = adminEmail();
  const result = { adminEmail: email, found: false, promoted: false, pending: false, recovery: null, otherAdmins: [] };
  if (!email) return result;
  let owner = ownerAccount();
  result.found = Boolean(owner);

  const recovery = (process.env.ADMIN_RECOVERY || "").trim().toLowerCase();
  if (recovery) {
    if (!owner) {
      console.warn(`WARNING: ADMIN_RECOVERY=${recovery} is set but there is no account for ADMIN_EMAIL yet. Register it first, then restart.`);
    } else if (recovery === "verify-email") {
      if (!session.isEmailVerified(owner)) owner = usersDB.update(owner.id, { emailVerifiedAt: new Date().toISOString(), emailVerifyNonce: null });
      result.recovery = "verify-email";
      console.warn("WARNING: ADMIN_RECOVERY=verify-email — the ADMIN_EMAIL account was marked as confirmed without an emailed link. Remove ADMIN_RECOVERY now.");
    } else if (recovery === "reset-2fa") {
      owner = session.bumpTokenVersion(owner, { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] });
      result.recovery = "reset-2fa";
      console.warn("WARNING: ADMIN_RECOVERY=reset-2fa — two-step sign-in was switched OFF for the ADMIN_EMAIL account and its sessions were ended. Sign in, enrol again, and remove ADMIN_RECOVERY now.");
    } else {
      console.warn(`WARNING: ADMIN_RECOVERY=${recovery} is not a known action (verify-email, reset-2fa). Nothing was done.`);
    }
  }

  if (!owner) {
    console.log(`  ADMIN_EMAIL set to ${email} but no matching user yet.`);
  } else if (owner.role === "admin") {
    console.log(`  Admin user ${email} already has admin role.`);
  } else if (session.isEmailVerified(owner)) {
    usersDB.update(owner.id, { role: "admin" });
    result.promoted = true;
    console.log(`  Promoted ${email} to admin role.`);
  } else {
    result.pending = true;
    console.log(`  ${email} is registered but its email is not confirmed yet: it stays a customer account until it is.`);
  }

  // An admin whose address is not ADMIN_EMAIL is worth a line in the deploy log.
  result.otherAdmins = usersDB.getAll().filter((u) => u.role === "admin" && u.email !== email).map((u) => u.email);
  if (result.otherAdmins.length) console.warn(`WARNING: ${result.otherAdmins.length} admin account(s) besides ADMIN_EMAIL: ${result.otherAdmins.join(", ")}`);
  return result;
}

module.exports = { ensureAtStartup, ownerAccount, adminEmail };
