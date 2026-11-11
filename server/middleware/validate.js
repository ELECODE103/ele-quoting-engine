/**
 * Input validation & sanitization helpers.
 * Keeps route handlers clean; centralises security logic.
 */

// ─── Sanitisers ──────────────────────────────────────────────

/**
 * Text a person typed, kept as they typed it.
 *
 * What is removed: characters that are not text at all — control characters
 * (NUL first of all; tab, line feed and carriage return stay) and the
 * invisible bidirectional override characters that can make a line read
 * differently from what it says. What is done besides: trim, and cut to
 * `maxLength`.
 *
 * What is deliberately NOT done here: stripping things that look like markup.
 * The earlier version deleted anything between "<" and ">" and anything shaped
 * like `on…=`, which turned "5 < 10 > 3" into "5  3" and "tone = 5" into "t 5",
 * and was never what kept a note from running as script. That is the job of
 * the place a value is shown: React escapes every string it renders (there is
 * no dangerouslySetInnerHTML in the client), the email templates escape every
 * value they put into HTML (emails/templates.js `esc`, links through
 * `safeHref`) and send the text part as text, and PDFKit draws strings as
 * text. A value stored here is data, shown as data.
 */
function sanitizeString(val, maxLength = 500) {
  if (typeof val !== "string") return "";
  return val
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "") // control characters (keeps \t \n \r)
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")                             // bidirectional overrides and isolates
    .trim()
    .slice(0, maxLength);
}

// Characters that never belong in an email address: control characters (a NUL
// ends the text in SQLite, so "owner@shop.test\0.example" would be stored as
// someone else's address), line and paragraph separators, and invisible
// formatting characters (zero-width, bidirectional, byte-order mark).
// eslint-disable-next-line no-control-regex
const EMAIL_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;

/** Validate email format (RFC 5322 simplified). The address is checked exactly as given: it is not trimmed here. */
function isValidEmail(email) {
  if (typeof email !== "string") return false;
  if (email.length === 0 || email.length > 254) return false;
  if (EMAIL_FORBIDDEN.test(email)) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/** Ensure value is a positive integer (for quantities, etc.) */
function positiveInt(val, fallback = 1) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Ensure value is a non-negative number (prices, costs) */
function nonNegativeNumber(val, fallback = 0) {
  const n = parseFloat(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Validate a slug: lowercase alphanumeric + hyphens only */
function isValidSlug(val) {
  if (typeof val !== "string") return false;
  return /^[a-z0-9][a-z0-9-]{0,60}$/.test(val);
}

/** Validate UUID v4 format */
function isValidUUID(val) {
  if (typeof val !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
}

// ─── Express middleware factory ──────────────────────────────

/**
 * Validate request body fields.
 *
 * Usage:
 *   router.post("/route", validateBody({ email: "email", name: "string" }), handler)
 *
 * Field types: "string", "email", "number", "positiveInt", "slug", "uuid", "boolean"
 * Prefix with "?" to mark optional: "?string"
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rule] of Object.entries(schema)) {
      const optional = rule.startsWith("?");
      const type = optional ? rule.slice(1) : rule;
      const val = req.body[field];

      // Skip optional fields that are absent
      if (optional && (val === undefined || val === null || val === "")) {
        continue;
      }

      // Required field check
      if (!optional && (val === undefined || val === null || val === "")) {
        errors.push(`${field} is required`);
        continue;
      }

      // Type-specific validation
      switch (type) {
        case "email":
          if (!isValidEmail(val)) errors.push(`${field} must be a valid email address`);
          break;
        case "string":
          if (typeof val !== "string" || val.trim().length === 0) {
            errors.push(`${field} must be a non-empty string`);
          } else if (val.length > 1000) {
            errors.push(`${field} must be under 1000 characters`);
          }
          break;
        case "number":
          if (typeof val !== "number" || !Number.isFinite(val)) {
            errors.push(`${field} must be a valid number`);
          }
          break;
        case "positiveInt":
          if (!Number.isInteger(val) || val < 1) {
            errors.push(`${field} must be a positive integer`);
          }
          break;
        case "slug":
          if (!isValidSlug(val)) errors.push(`${field} must be a valid slug`);
          break;
        case "uuid":
          if (!isValidUUID(val)) errors.push(`${field} must be a valid ID`);
          break;
        case "boolean":
          if (typeof val !== "boolean") errors.push(`${field} must be a boolean`);
          break;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join("; ") });
    }
    next();
  };
}

module.exports = {
  sanitizeString,
  isValidEmail,
  positiveInt,
  nonNegativeNumber,
  isValidSlug,
  isValidUUID,
  validateBody,
};
