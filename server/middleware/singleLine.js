/**
 * Single-line fields, checked at the boundary.
 *
 * A PO number, a name, a company, a phone number, a street line, a carrier: each is one line
 * of printable text. They are printed on the traveler, the packing slip and the order
 * confirmation and shown in emails, where a line break typed into one of them becomes a line
 * of the buyer's own text standing beside ours ("PAID IN FULL - SHIP TODAY" under the PO
 * number, review F-10).
 *
 * A value that is not one printable line is REFUSED, not rewritten: the person who typed it is
 * told which field to fix. Nothing is stripped silently, so what is stored is what was typed.
 *
 *   const r = singleLine(body.poNumber, { field: "poNumber", label: "PO number", max: 60, required: true });
 *   if (!r.ok) return res.status(400).json({ error: r.error, code: r.code, field: r.field });
 *   r.value   // trimmed
 */

// Line breaks and tabs, every other control character, the Unicode line and paragraph
// separators, and the invisible formatting characters (zero-width, bidirectional, byte-order mark).
// eslint-disable-next-line no-control-regex
const NOT_ONE_LINE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

/**
 * @param {*} value
 * @param {{field: string, label?: string, max?: number, required?: boolean, pattern?: RegExp}} rule
 * @returns {{ok: true, value: string} | {ok: false, code: string, field: string, error: string}}
 */
function singleLine(value, { field, label, max = 200, required = false, pattern } = {}) {
  const name = label || field || "This field";
  const fail = (code, error) => ({ ok: false, code, field, error });
  if (value === undefined || value === null || value === "") {
    return required ? fail("field-required", `${name} is required.`) : { ok: true, value: "" };
  }
  if (typeof value !== "string") return fail("field-invalid", `${name} must be text.`);
  if (NOT_ONE_LINE.test(value)) return fail("field-single-line", `${name} must be a single line of plain text, with no line breaks or hidden characters.`);
  const trimmed = value.trim();
  if (!trimmed) return required ? fail("field-required", `${name} is required.`) : { ok: true, value: "" };
  if (trimmed.length > max) return fail("field-too-long", `${name} can be at most ${max} characters.`);
  if (pattern && !pattern.test(trimmed)) return fail("field-invalid", `${name} has characters that are not allowed.`);
  return { ok: true, value: trimmed };
}

/**
 * Check several fields at once. `rules` is { field: { label, max, required } }.
 * @returns {{ok: true, values: object} | {ok: false, code, field, error}} the first failure, or every cleaned value
 */
function singleLines(source, rules) {
  const values = {};
  for (const [field, rule] of Object.entries(rules)) {
    const r = singleLine(source ? source[field] : undefined, { field, ...rule });
    if (!r.ok) return r;
    values[field] = r.value;
  }
  return { ok: true, values };
}

// A purchase-order number: letters, digits, spaces and the punctuation real PO numbers use.
const PO_NUMBER = /^[\p{L}\p{N} .,_#/&()+:\-]+$/u;

/** A PO number as typed on the firm-quote page: one line, 60 characters at most. */
function poNumber(value, { required = true } = {}) {
  const r = singleLine(value, { field: "poNumber", label: "The PO number", max: 60, required, pattern: PO_NUMBER });
  if (r.ok) return r;
  return { ...r, code: r.code === "field-required" ? "po-number-required" : "po-number-invalid", error: r.code === "field-required" ? "Enter your purchase order number" : "The PO number must be a single line of up to 60 letters, numbers, spaces and . , - _ # / & ( ) + :" };
}

/** The ship-to block every order route takes. */
const SHIPPING_RULES = {
  shippingName: { label: "The ship-to name", max: 200 },
  shippingAddress: { label: "The street address", max: 500 },
  shippingCity: { label: "The city", max: 100 },
  shippingState: { label: "The state", max: 100 },
  shippingZip: { label: "The ZIP code", max: 20 },
  shippingCountry: { label: "The country", max: 5 },
};

/** One-line text for a place that prints stored data as it is (rows written before these checks existed). */
function printable(value) {
  // eslint-disable-next-line no-control-regex
  return String(value === undefined || value === null ? "" : value).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+/g, " ").replace(/ {2,}/g, " ").trim();
}

module.exports = { singleLine, singleLines, poNumber, SHIPPING_RULES, printable, NOT_ONE_LINE };
