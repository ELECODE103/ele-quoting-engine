/**
 * Signed, expiring links for firm quotes.
 *
 * The customer accepts a quoted RFQ from an emailed link without an account,
 * so the link itself is the credential: a JWT naming the RFQ, expiring with
 * the quote's validity date, and stamped with the send time so re-sending a
 * revised quote kills the older link.
 *
 * It is signed with a key derived from JWT_SECRET (not JWT_SECRET itself), so
 * a quote link can never pass as a login token or the other way round.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const AUDIENCE = "rfq-quote";

const ALGORITHM = "HS256"; // signed and verified with this one algorithm, named on both sides

function key() {
  return crypto.createHmac("sha256", require("../security/keys").baseSecret()).update("rfq-quote-link-v1").digest();
}

/** The quoted total in whole cents, or null when there is none. */
function amountCents(rfq) {
  const n = Number(rfq && rfq.quotedTotal);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * A fingerprint of the terms a firm quote offers: the total, the lines and their quantities,
 * the lead time, the validity date, and what the price covers. It is stored on the request
 * when the quote is sent (`sentTerms`). A quote whose terms no longer match what was sent has
 * no usable link until the owner sends it again (review F-9): the buyer can never accept an
 * amount, a quantity or a date other than the ones in the email they hold.
 */
function termsFingerprint(rfq) {
  const terms = [
    amountCents(rfq),
    rfq.quotedLeadDays === undefined ? null : rfq.quotedLeadDays,
    rfq.validUntil || null,
    Boolean(rfq.paperwork),
    Boolean(rfq.returnPart),
    String(rfq.quoteNote || ""),
    (rfq.parts || []).map((p) => [p.partId || "", p.fileName || "", p.quotedQuantity || p.quantity || null, p.process || "", p.materialSlug || "", p.finishSlug || ""]),
  ];
  // Where it ships is one of the terms (review of 2026-11-13, N-05): a price is for a destination.
  // Added to the list only when the request has one, so the fingerprint of a quote sent before
  // requests carried an address is what it always was and its link still opens.
  if (rfq.shipToKind) terms.push(shipToKey(rfq));
  return crypto.createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 40);
}

/**
 * Where a request ships, as one comparable value: "pickup", or the street, city, state, ZIP code
 * and country in one case with single spaces. The NAME on the box is not part of it: who signs for
 * the parcel does not change what freight costs.
 */
function shipToKey(a) {
  if (!a) return "";
  if (a.shipToKind === "pickup") return "pickup";
  const norm = (v) => String(v === undefined || v === null ? "" : v).toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  return ["address", norm(a.shippingAddress), norm(a.shippingCity), norm(a.shippingState), norm(a.shippingZip).replace(/[-\s]\d{4}$/, ""), norm(a.shippingCountry || "US")].join("|");
}

/**
 * @param {{id:string, quoteSentAt:string, validUntil:string, quotedTotal:number}} rfq
 * The link names the request, the send it belongs to (`v`) and the amount it was issued for (`amt`, cents).
 */
function sign(rfq) {
  const exp = Math.floor(new Date(rfq.validUntil).getTime() / 1000);
  return jwt.sign({ rfqId: rfq.id, v: rfq.quoteSentAt, amt: amountCents(rfq), exp }, key(), { audience: AUDIENCE, algorithm: ALGORITHM });
}

/**
 * @returns {{rfqId:string, v:string, amt:number|null, expired:boolean}|null} null when the token
 * is forged or malformed. An expired token still verifies (with `expired`) so
 * the caller can say "this quote expired" instead of "bad link". `amt` is null on
 * a link issued before links carried an amount.
 */
function verify(token) {
  try {
    const p = jwt.verify(String(token || ""), key(), { audience: AUDIENCE, algorithms: [ALGORITHM], ignoreExpiration: true });
    if (!p || !p.rfqId || !p.exp) return null;
    return { rfqId: p.rfqId, v: p.v, amt: Number.isInteger(p.amt) ? p.amt : null, expired: p.exp * 1000 < Date.now() };
  } catch {
    return null;
  }
}

module.exports = { sign, verify, termsFingerprint, amountCents, shipToKey };
