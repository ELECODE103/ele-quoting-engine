/**
 * Input validation & sanitization helpers.
 * Keeps route handlers clean; centralises security logic.
 */

// âââ Sanitisers ââââââââââââââââââââââââââââââââââââââââââââââ

/** Strip HTML/script tags, JS protocol handlers, event handlers, and control chars */
function sanitizeString(val, maxLength = 500) {
  if (typeof val !== "string") return "";
  return val
    .replace(/<script[\s\S]*?<\/script>/gi, "")  // strip script blocks
    .replace(/<[^>]*>/g, "")                       // strip HTML tags
    .replace(/[<>]/g, "")                          // remove stray angle brackets
    .replace(/javascript\s*:/gi, "")               // block javascript: protocol
    .replace(/on\w+\s*=/gi, "")                    // strip inline event handlers
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // remove control characters
    .trim()
    .slice(0, maxLength);
}

/** Validate email format (RFC 5322 simplified) */
function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email) && email.length <= 254;
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

// âââ Express middleware factory ââââââââââââââââââââââââââââââ

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
