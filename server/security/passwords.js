/**
 * Password rules for new passwords (registration and reset). Existing
 * passwords keep working; the rules bite the next time one is set.
 *
 * Length does the work: at least 10 characters. The three character-class
 * rules that were already here stay (upper case, lower case, a number) and
 * nothing is added to them. On top of that a password is refused when it is
 * one of the most-used passwords (the bundled list, compared without regard
 * to case), is one character repeated, or is built from the account's own
 * email address or our name.
 *
 * bcrypt reads only the first 72 bytes, so anything longer is refused rather
 * than silently cut.
 *
 * common-passwords.txt: the entries of 10 characters or more from the UK
 * NCSC / Have I Been Pwned "100k most used passwords" list (as published in
 * SecLists, MIT licence), lower-cased. Shorter entries are left out because
 * the length rule already refuses them.
 */
const fs = require("fs");
const path = require("path");

const MIN_LENGTH = 10;
const MAX_BYTES = 72;

let common = null;
function commonSet() {
  if (!common) {
    const text = fs.readFileSync(path.join(__dirname, "common-passwords.txt"), "utf8");
    common = new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return common;
}

/** One sentence for forms, so the page and the server say the same thing. */
const HINT = `At least ${MIN_LENGTH} characters, with an upper-case letter, a lower-case letter and a number. Not a common password.`;

/**
 * @param {string} password
 * @param {{email?: string}} [context]
 * @returns {string|null} a sentence saying what to change, or null when the password is acceptable
 */
function problem(password, { email } = {}) {
  if (typeof password !== "string" || password.length === 0) return "Enter a password.";
  const missing = [];
  if (password.length < MIN_LENGTH) missing.push(`at least ${MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(password)) missing.push("one upper-case letter");
  if (!/[a-z]/.test(password)) missing.push("one lower-case letter");
  if (!/[0-9]/.test(password)) missing.push("one number");
  if (missing.length) return `Password must contain: ${missing.join(", ")}.`;
  if (Buffer.byteLength(password, "utf8") > MAX_BYTES) return `Password must be ${MAX_BYTES} characters or fewer.`;

  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(lower)) return "That password is one character repeated. Choose something harder to guess.";
  if (commonSet().has(lower)) return "That password is on the list of most-used passwords. Choose one that is yours alone.";
  const local = String(email || "").toLowerCase().split("@")[0];
  if (local.length >= 4 && lower.includes(local)) return "Don't build the password from your email address.";
  if (lower.includes("straightedge")) return "Don't build the password from our name.";
  return null;
}

module.exports = { problem, HINT, MIN_LENGTH, MAX_BYTES, commonCount: () => commonSet().size };
