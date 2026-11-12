/**
 * Shipping: what an order is charged for getting to the buyer, and how it gets there.
 *
 * Everything here is worked out on the server from the parts in the database and the admin's
 * settings (config/ruleSchema.js, group "Shipping & tax"). Nothing a browser sends is an input to
 * an amount: the only things a buyer chooses are WHO ships (we do, their carrier account, or they
 * pick up) and, for their own carrier, the account to bill.
 *
 * How the "we ship it" line is charged (setting `shippingMethod`):
 *
 *   formula   (default: the behaviour before this file existed)
 *             shippingBaseRate + part weight in kg × shippingPerKg, exactly as the pricing engine
 *             computed it before. No size or destination rule.
 *   included  no shipping line; part prices carry the freight.
 *   table     the row of `shippingRateTable` the packed order weight falls in.
 *
 * `included` and `table` never guess. An order is "manual" (no parcel price: a person confirms
 * freight on a firm quote) when
 *   - a part's longest side is over `shippingOversizeLongestIn`,
 *   - the packed weight is over `shippingMaxParcelLb`, or past the last row of the table,
 *   - a part's weight or size cannot be worked out (no volume, no density, no dimensions):
 *     an unknown weight is never treated as zero,
 *   - the ship-to address is outside the contiguous United States.
 *
 * Packed weight = Σ (part volume × material density × quantity) × (1 + shippingPackagingPercent)
 *                 + shippingPackagingLb, in pounds. The density is the one on the material record
 * (the chosen grade's lb/in³, else the material's g/cm³). Unlike the pricing models, which fall back
 * to a typical density so a price can always be shown, a missing density here means "unknown".
 *
 * `shippingFreeOverSubtotal` > 0 makes the line free when the parts come to that much (formula and
 * table; not for a manual order).
 *
 * Buyer's choices, each behind its own switch (both off by default):
 *   carrier-account   `shippingCarrierAccount`: carrier + account number, shipping line $0
 *   pickup            `shippingLocalPickup`: collected at the shop, shipping line $0
 */
const secretBox = require("../security/secretBox");
const dxf = require("../geometry/dxf");
const brand = require("../../shared/brand.json");

const LB_PER_KG = 2.2046226218;
const MM_PER_IN = 25.4;
const LB_IN3_TO_G_CM3 = 27.6799;
const G_PER_LB = 453.59237;

const METHODS = ["ship", "carrier-account", "pickup"];
const CARRIERS = ["UPS", "FedEx", "Other"];
// The contiguous states and DC: the only destinations a table or "included" price is good for.
const CONTIGUOUS = new Set("AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const STATE_NAMES = { alabama: "AL", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", alaska: "AK", hawaii: "HI", "puerto rico": "PR" };

const num = (v, fallback) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);
const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round1 = (n) => Math.round(n * 10) / 10;

/** The shipping settings out of a rule set, each one read defensively (a missing key is the default). */
function settings(rules = {}) {
  const mode = ["formula", "included", "table"].includes(rules.shippingMethod) ? rules.shippingMethod : "formula";
  const table = (Array.isArray(rules.shippingRateTable) ? rules.shippingRateTable : [])
    .map((r) => ({ maxLb: Number(r && r.maxLb), price: Number(r && r.price) }))
    .filter((r) => r.maxLb > 0 && Number.isFinite(r.price) && r.price >= 0)
    .sort((a, b) => a.maxLb - b.maxLb);
  return {
    mode,
    table,
    baseRate: num(rules.shippingBaseRate, 0),
    perKg: num(rules.shippingPerKg, 0),
    packagingPercent: Math.max(0, num(rules.shippingPackagingPercent, 0.10)),
    packagingLb: Math.max(0, num(rules.shippingPackagingLb, 1)),
    oversizeIn: Math.max(1, num(rules.shippingOversizeLongestIn, 48)),
    maxParcelLb: Math.max(1, num(rules.shippingMaxParcelLb, 50)),
    freeOver: Math.max(0, num(rules.shippingFreeOverSubtotal, 0)),
    carrierAccount: rules.shippingCarrierAccount === "on",
    pickup: rules.shippingLocalPickup === "on",
  };
}

// ─── Weight and size ─────────────────────────────────────────────────────────

/**
 * Density of a configured part's material in g/cm³, or null when the material record does not
 * say. The chosen grade's lb/in³ first (machining and routing stock), then the material's own
 * g/cm³ (printing materials). No "typical plastic" default: unknown stays unknown.
 */
function densityGcm3(material, grade) {
  if (!material || typeof material !== "object") return null;
  const grades = Array.isArray(material.grades) ? material.grades : [];
  const g = grades.find((x) => x && x.name === grade) || grades[0];
  const lbIn3 = Number(g && g.density);
  if (Number.isFinite(lbIn3) && lbIn3 > 0 && lbIn3 <= 1) return lbIn3 * LB_IN3_TO_G_CM3;
  const gcm3 = Number(material.density);
  if (Number.isFinite(gcm3) && gcm3 >= 0.1 && gcm3 <= 25) return gcm3;
  return null;
}

/** Longest side of a part in mm from its measured extents, or null when there are none. */
function longestSideMm(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  const dims = [];
  const obb = geometry.features && geometry.features.obb;
  if (obb) dims.push(Number(obb.w), Number(obb.h), Number(obb.d));
  const bb = geometry.boundingBox;
  if (bb) dims.push(Number(bb.width), Number(bb.height), Number(bb.depth));
  const real = dims.filter((d) => Number.isFinite(d) && d > 0);
  // The oriented box is never longer than the part's true longest dimension and the
  // axis-aligned one never shorter; the larger of the two is the safe reading.
  return real.length ? Math.max(...real) : null;
}

/**
 * What a set of configured parts weighs packed, and the longest side among them.
 * @param {Array} parts  [{ geometry, material, grade, thicknessMm, quantity, fileName }] as the pricing engine gets them
 * @returns {{ partsLb:number|null, packedLb:number|null, longestIn:number|null, pieces:number, unknown:string[] }}
 *          `unknown` names what could not be worked out; when it is not empty, partsLb/packedLb are null.
 */
function measure(parts = [], rules = {}) {
  const s = settings(rules);
  const unknown = [];
  let grams = 0;
  let longestMm = 0;
  let pieces = 0;
  let sizeKnown = parts.length > 0;
  if (!parts.length) unknown.push("no parts");
  for (const part of parts) {
    const name = String((part && part.fileName) || "a part").slice(0, 80);
    let geometry = part && part.geometry;
    // A DXF is a flat profile: its volume exists only at the stock thickness the buyer picked.
    if (dxf.is2D(geometry)) {
      if (Number(part.thicknessMm) > 0) { try { geometry = dxf.materialize(geometry, Number(part.thicknessMm)); } catch { geometry = null; } } else geometry = null;
    }
    const qty = Math.max(1, Math.floor(Number(part && part.quantity) || 1));
    pieces += qty;
    const volumeMm3 = Number(geometry && geometry.volume);
    const density = densityGcm3(part && part.material, part && part.grade);
    if (!(Number.isFinite(volumeMm3) && volumeMm3 > 0)) unknown.push(`${name}: volume not known`);
    else if (density === null) unknown.push(`${name}: no density on the material`);
    else grams += (volumeMm3 / 1000) * density * qty;
    const longest = longestSideMm(geometry);
    if (longest === null) { sizeKnown = false; unknown.push(`${name}: size not known`); } else longestMm = Math.max(longestMm, longest);
  }
  const weightKnown = !unknown.some((u) => /volume|density|no parts/.test(u));
  const partsLb = weightKnown ? grams / G_PER_LB : null;
  const packedLb = weightKnown ? partsLb * (1 + s.packagingPercent) + s.packagingLb : null;
  return {
    partsLb: partsLb === null ? null : Math.round(partsLb * 1000) / 1000,
    packedLb: packedLb === null ? null : Math.round(packedLb * 1000) / 1000,
    longestIn: sizeKnown ? Math.round((longestMm / MM_PER_IN) * 100) / 100 : null,
    pieces,
    unknown,
  };
}

// ─── The "we ship it" line ───────────────────────────────────────────────────

const MANUAL_NOTE = {
  oversize: (v, s) => `One of these parts is ${round1(v.longestIn)} in on its longest side, over the ${s.oversizeIn} in we ship by parcel, so we confirm freight before you order.`,
  overweight: (v, s) => `This order packs to about ${Math.ceil(v.packedLb)} lb, over the ${s.maxParcelLb} lb we ship by parcel, so we confirm freight before you order.`,
  "over-table": (v) => `This order packs to about ${Math.ceil(v.packedLb)} lb, more than our parcel rates cover, so we confirm freight before you order.`,
  "unknown-weight": () => "We could not work out what this order weighs, so we confirm shipping before you order.",
  "unknown-size": () => "We could not work out how large these parts are, so we confirm shipping before you order.",
  destination: () => "Our parcel rates cover the contiguous United States. For this address we confirm freight before you order.",
};

/** A manual result: no amount, a reason in words. */
function manual(mode, code, v, s) {
  return { mode, method: "ship", amount: 0, manual: true, reasonCode: code, reason: MANUAL_NOTE[code](v, s), packedLb: v.packedLb, longestIn: v.longestIn, freeApplied: false };
}

/**
 * Price the "we ship it" line for a weight and a size, with no destination yet.
 * `v` = { packedLb, longestIn, unknown[] } from measure(); `formulaKg` is the part weight the
 * pricing engine summed (used by the formula only, so that mode is the same arithmetic as before).
 */
function priceShipment({ v, subtotal = 0, formulaKg = 0 }, rules = {}) {
  const s = settings(rules);
  const base = { mode: s.mode, method: "ship", manual: false, reasonCode: "", reason: "", packedLb: v ? v.packedLb : null, longestIn: v ? v.longestIn : null, freeApplied: false };
  const free = s.freeOver > 0 && Number(subtotal) >= s.freeOver;

  if (s.mode === "formula") {
    // The expression the pricing engine has always used, unrounded, so the default is not a cent different.
    const amount = s.baseRate + formulaKg * s.perKg;
    return free ? { ...base, amount: 0, freeApplied: true } : { ...base, amount };
  }

  // "included" and "table": nothing is priced that cannot go in a parcel, and nothing is guessed.
  if (!v || v.longestIn === null) return manual(s.mode, "unknown-size", v || { packedLb: null, longestIn: null }, s);
  if (v.longestIn > s.oversizeIn) return manual(s.mode, "oversize", v, s);
  if (v.packedLb === null || !(v.packedLb > 0)) return manual(s.mode, "unknown-weight", v, s);
  if (v.packedLb > s.maxParcelLb) return manual(s.mode, "overweight", v, s);

  if (s.mode === "included") return { ...base, amount: 0 };

  // Carriers bill the next whole pound; the band is looked up the same way.
  const billedLb = Math.ceil(v.packedLb - 1e-9);
  const row = s.table.find((r) => billedLb <= r.maxLb);
  if (!row) return manual(s.mode, "over-table", v, s);
  return free ? { ...base, amount: 0, freeApplied: true, bandMaxLb: row.maxLb } : { ...base, amount: cents(row.price), bandMaxLb: row.maxLb };
}

/**
 * Shipping for a quote as the pricing engine prices it.
 * @param {object} p  { parts (engine input), totalWeightKg (engine's sum), subtotal }
 * @returns the shipping block stored with the quote: { mode, method, amount, manual, reasonCode, reason, packedLb, longestIn, freeApplied }
 */
function forQuote({ parts = [], totalWeightKg = 0, subtotal = 0 }, rules = {}) {
  const s = settings(rules);
  // The formula needs no measuring (and must not start failing on parts it has always priced).
  const v = s.mode === "formula" ? softMeasure(parts, rules) : measure(parts, rules);
  return priceShipment({ v, subtotal, formulaKg: totalWeightKg }, rules);
}

/** measure() that never throws; for the formula, where the figures are only shown, never charged on. */
/**
 * The parts of a priced quote as `measure` wants them, rebuilt from its LINES and the records
 * the lines point at: geometry from the part, density from the material, grade, stock thickness
 * and quantity from the line as the pricing engine priced it. `lookup` is the database, passed
 * in ({ part(id), material(slug) }): this module reads nothing itself. A part or material that
 * is no longer there comes back without geometry or density, which `measure` reports as unknown.
 */
function partsFromLines(lineItems = [], lookup = {}) {
  return (Array.isArray(lineItems) ? lineItems : []).map((li) => {
    const meta = (li && li.meta) || {};
    const part = (li && li.partId && typeof lookup.part === "function" && lookup.part(li.partId)) || null;
    const material = (meta.materialSlug && typeof lookup.material === "function" && lookup.material(meta.materialSlug)) || null;
    return {
      partId: li && li.partId,
      fileName: (li && li.fileName) || (part && part.fileName) || "",
      geometry: part && !part.payloadError ? part.geometry : null,
      material,
      grade: meta.grade || "",
      thicknessMm: Number(meta.thicknessMm) > 0 ? Number(meta.thicknessMm) : 0,
      quantity: li && li.quantity,
    };
  });
}

/**
 * The "we ship it" line for a priced quote, worked out NOW under the given settings. This is
 * what checkout charges: the shipping amount stored on a quote is what the buyer was shown when
 * it was priced, and is never read back as the charge.
 *
 * Pure: `priced` is { lineItems, subtotal } as the pricing engine returns them (a stored quote,
 * or the same configuration priced again at checkout); `lookup` is { part(id), material(slug) }.
 * The weight the formula uses is the sum of the lines' own weights, added in line order, which
 * is the pricing engine's `totalWeight` to the last bit. A line with no weight makes the order
 * manual: an unknown weight is never zero, in any mode.
 *
 * `opt.measure: false` is for a page that only shows the line (services/checkout.js viewFor). The
 * weight formula charges from the lines' weights alone; the parts are measured there only to print
 * a packed weight on the order. So under the formula such a call reads no part and no material (a
 * quote of a hundred detailed parts is not loaded from disk every time it is looked at), and the
 * block comes back with the same amount and no packed weight or size. A rate table or "included"
 * always measures: there the weight and the size decide the price.
 */
const NOT_MEASURED = Object.freeze({ partsLb: null, packedLb: null, longestIn: null, pieces: 0, unknown: Object.freeze(["not measured"]) });
function shippingFor(priced = {}, rules = {}, lookup = {}, opt = {}) {
  const lines = Array.isArray(priced.lineItems) ? priced.lineItems : [];
  const s = settings(rules);
  const measured = s.mode !== "formula" || opt.measure !== false;
  const parts = measured ? partsFromLines(lines, lookup) : null;
  const weights = lines.map((li) => Number(li && li.weight && li.weight.total));
  if (!lines.length || weights.some((w) => !Number.isFinite(w) || w < 0)) {
    return manual(s.mode, "unknown-weight", parts ? softMeasure(parts, rules) : NOT_MEASURED, s);
  }
  const totalWeightKg = weights.reduce((sum, w) => sum + w, 0);
  const subtotal = Number(priced.subtotal) || 0;
  if (!parts) return priceShipment({ v: NOT_MEASURED, subtotal, formulaKg: totalWeightKg }, rules);
  return forQuote({ parts, totalWeightKg, subtotal }, rules);
}

function softMeasure(parts, rules) {
  try { return measure(parts, rules); } catch { return { partsLb: null, packedLb: null, longestIn: null, pieces: 0, unknown: ["not measured"] }; }
}

/**
 * The block a stored quote carries, or what an older quote (saved before the block existed)
 * amounts to: the formula, with the amount the quote already holds.
 */
function storedFor(quote) {
  const s = quote && quote.shipping;
  if (s && typeof s === "object" && ["formula", "included", "table"].includes(s.mode)) {
    return { mode: s.mode, method: "ship", amount: Math.max(0, cents(quote.shippingEstimate)), manual: s.manual === true, reasonCode: String(s.reasonCode || ""), reason: String(s.reason || ""), packedLb: num(s.packedLb, null), longestIn: num(s.longestIn, null), freeApplied: s.freeApplied === true };
  }
  return { mode: "formula", method: "ship", amount: Math.max(0, cents(quote && quote.shippingEstimate)), manual: false, reasonCode: "", reason: "", packedLb: null, longestIn: null, freeApplied: false };
}

// ─── Destination ─────────────────────────────────────────────────────────────

/** "il", "Illinois", " IL " → "IL"; anything else comes back trimmed and upper-cased. */
function stateCode(state) {
  const t = String(state || "").trim();
  return STATE_NAMES[t.toLowerCase()] || t.toUpperCase();
}

/** Is this ship-to address one a table or "included" price covers (the contiguous United States)? */
function destinationCovered({ country, state } = {}) {
  const c = String(country || "US").trim().toUpperCase();
  return (c === "US" || c === "USA") && CONTIGUOUS.has(stateCode(state));
}

/**
 * Apply the destination to a stored "we ship it" line. The formula has no destination rule (it
 * never had one); table and included prices stand only inside the contiguous United States.
 */
function atDestination(stored, destination, rules = {}) {
  if (stored.manual || stored.mode === "formula") return stored;
  if (destinationCovered(destination)) return stored;
  return manual(stored.mode, "destination", stored, settings(rules));
}

// ─── What the buyer is shown ─────────────────────────────────────────────────

/**
 * One "we ship it" line as words: { label, valueText, note }. `amount` is passed in because the
 * amount charged is decided where the order total is (services/checkout.js).
 */
function describe(block, rules = {}) {
  const s = settings(rules);
  if (block.manual) return { label: "Shipping", valueText: "To be confirmed", note: block.reason };
  if (block.freeApplied) return { label: "Shipping", valueText: "Free", note: `Free shipping on orders with ${money(s.freeOver)} or more in parts.` };
  if (block.mode === "included") return { label: "Shipping", valueText: "Included", note: "Shipping within the contiguous United States is included in the price." };
  if (block.mode === "table") return { label: "Shipping", valueText: money(block.amount), note: block.packedLb ? `Ground shipping within the contiguous United States, by packed weight (about ${Math.ceil(block.packedLb)} lb).` : "" };
  return { label: "Shipping", valueText: money(block.amount), note: "" };
}

/** How an order is getting to the buyer, as one line for emails, documents and the traveler. */
function methodLine(order) {
  if (order.shippingMethod === "pickup") return "Pickup at our shop";
  if (order.shippingMethod === "carrier-account") {
    return `Ships on your ${order.shipCarrier || "carrier"} account ${maskAccount(order.shipAccountLast4)}${order.shipService ? ` (${order.shipService})` : ""}`;
  }
  return "";
}

// ─── Carrier account ─────────────────────────────────────────────────────────

/**
 * Shipping on Stripe's page, in cents: 0 when shipping stays inside the order's one line (the
 * weight formula with tax off, which is how the site has always sent it), else the order's
 * shipping charge as its own line. `roomCents` is what is left of the pre-tax total after the
 * paperwork line, so the lines can never add up to more than the order.
 */
function stripeShippingCents(order = {}, roomCents = Infinity) {
  const ownLine = (order.shippingMode && order.shippingMode !== "formula") || order.taxMode === "stripe";
  if (!ownLine) return 0;
  return Math.max(0, Math.min(roomCents, Math.round((Number(order.shippingCost) || 0) * 100)));
}

/** The words on the shipping line of Stripe's page. */
function stripeShippingLine(order = {}) {
  return { name: "Shipping", description: order.packedWeightLb ? `Ground, about ${Math.ceil(order.packedWeightLb)} lb packed` : "Ground" };
}

/**
 * The carrier account a buyer typed, checked. An account number is letters and digits (UPS: six
 * characters; FedEx: nine digits); spaces and dashes are dropped. Nothing here is logged.
 * @returns {{ ok:true, carrier, account, last4, service } | { ok:false, error }}
 */
function cleanCarrierAccount({ carrier, account, service } = {}) {
  const name = CARRIERS.find((c) => c.toLowerCase() === String(carrier || "").trim().toLowerCase());
  if (!name) return { ok: false, error: "Choose the carrier your account is with." };
  if (typeof account !== "string") return { ok: false, error: "Enter your carrier account number." };
  const number = account.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(number)) return { ok: false, error: "That doesn't look like a carrier account number. It is 5 to 20 letters and digits." };
  const svc = String(typeof service === "string" ? service : "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return { ok: true, carrier: name, account: number, last4: number.slice(-4), service: svc };
}

/** Seal an account number to one order (the order id is bound in, so the value cannot be moved to another row). */
function sealAccount(account, orderId) {
  return secretBox.seal("carrier-account", account, `order:${orderId}`);
}
/** The full account number of an order, for the admin order view only. null when there is none or it cannot be opened. */
function openAccount(order) {
  if (!order || !order.shipAccountEnc) return null;
  return secretBox.open("carrier-account", order.shipAccountEnc, `order:${order.id}`);
}
/** "••••1234": all anyone but the admin order view ever shows. */
function maskAccount(last4) {
  const tail = String(last4 || "").replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return tail ? `••••${tail}` : "";
}

// ─── Pickup ──────────────────────────────────────────────────────────────────

/**
 * Where a paid pickup order is collected. Server-side only: the street address is in
 * config/shipFrom.json, never in the client bundle, a public page or structured data. Callers
 * give it out only for an order that has been paid for.
 */
function pickupAddress() {
  const from = require("../config/shipFrom.json");
  return { name: require("../shopFacts").businessName(brand), lines: [from.address, `${from.city}, ${from.state} ${from.zip}`] };
}
/** City, state and ZIP of the shop (already public as city and state): what a pickup order is taxed at. No street line. */
function pickupLocality() {
  const from = require("../config/shipFrom.json");
  return { city: from.city, state: from.state, postal_code: from.zip, country: "US" };
}

// ─── Admin preview ───────────────────────────────────────────────────────────

/**
 * "A 3 lb order to Ohio would be charged $16.00 shipping." for the admin console, under a
 * candidate rule set. `weightLb` is the PARTS weight (the packaging allowance is added here, as it
 * is for a real order).
 */
function preview(rules = {}, { weightLb = 3, longestIn = 12, subtotal = 150, state = "OH", country = "US" } = {}) {
  const s = settings(rules);
  const partsLb = Math.max(0, Number(weightLb) || 0);
  const v = { partsLb, packedLb: partsLb > 0 ? partsLb * (1 + s.packagingPercent) + s.packagingLb : null, longestIn: Number(longestIn) > 0 ? Number(longestIn) : null, unknown: [] };
  let block = priceShipment({ v, subtotal: Number(subtotal) || 0, formulaKg: partsLb / LB_PER_KG }, rules);
  block = atDestination(block, { country, state }, rules);
  const where = stateCode(state) || "that address";
  const what = `A ${round1(partsLb)} lb order (${money(subtotal)} in parts, longest side ${round1(v.longestIn || 0)} in) shipped to ${where}`;
  let sentence;
  if (block.manual) sentence = `${what} would not get a shipping price online: it goes to a firm quote. The buyer is told: "${block.reason}"`;
  else if (block.freeApplied) sentence = `${what} would ship free (parts are at or over ${money(s.freeOver)}).`;
  else if (block.mode === "included") sentence = `${what} would show no shipping charge: shipping is included in the price.`;
  else if (block.mode === "table") sentence = `${what} would be charged ${money(block.amount)} shipping (packs to ${round1(v.packedLb)} lb, billed as ${Math.ceil(v.packedLb - 1e-9)} lb: the "up to ${block.bandMaxLb} lb" row).`;
  else sentence = `${what} would be charged ${money(cents(block.amount))} shipping (${money(s.baseRate)} base + ${round1(partsLb / LB_PER_KG)} kg × ${money(s.perKg)}).`;
  const extras = [];
  if (s.carrierAccount) extras.push("On their own carrier account: no shipping charge.");
  if (s.pickup) extras.push("Picked up at the shop: no shipping charge.");
  return { sentence, extras, mode: s.mode, amount: block.manual ? null : cents(block.amount), manual: block.manual, packedLb: v.packedLb === null ? null : round1(v.packedLb), placeholderTable: s.mode === "table" && JSON.stringify(rules.shippingRateTable) === JSON.stringify(require("../config/ruleSchema").RULE_BY_KEY.shippingRateTable.default) };
}

module.exports = {
  shippingFor, partsFromLines, stripeShippingCents, stripeShippingLine,
  METHODS, CARRIERS, LB_PER_KG,
  settings, densityGcm3, longestSideMm, measure, priceShipment, forQuote, storedFor,
  stateCode, destinationCovered, atDestination, describe, methodLine,
  cleanCarrierAccount, sealAccount, openAccount, maskAccount,
  pickupAddress, pickupLocality, preview,
};
