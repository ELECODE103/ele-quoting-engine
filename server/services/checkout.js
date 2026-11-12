/**
 * Checkout arithmetic: what an order comes to for the delivery choice the buyer made, and what
 * the pages show before the buyer commits. Shipping (services/shipping.js) and tax
 * (services/tax.js) meet the stored quote here.
 *
 * Server-authoritative by construction. The inputs are
 *   - the stored quote (priced by the server; a browser cannot write to it),
 *   - the admin's settings,
 *   - from the request: WHICH delivery choice ("ship" | "carrier-account" | "pickup"), the
 *     carrier account, the ship-to address, and whether an exemption is declared.
 * No amount, weight, size, rate or tax figure is read from a request. A choice that is switched
 * off in the settings is refused, not honoured.
 *
 * The total for a choice:
 *
 *   goods    = parts subtotal + lead-time fee            (as priced on the quote, to the cent)
 *   shipping = the quote's own shipping line for "ship"; 0 for a carrier account or pickup
 *   total    = max(goods + shipping, order minimum) + inspection paperwork
 *
 * For "ship" that is the quote's total, to the cent, by the same arithmetic the pricing engine
 * used: with every switch at its default nothing here changes a number.
 */
const { pricingDB } = require("../models");
const ruleSchema = require("../config/ruleSchema");
const shipping = require("./shipping");
const tax = require("./tax");
const { sanitizeString } = require("../middleware/validate");

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The current rule set (schema defaults with the admin's stored values laid over them). */
function currentRules() {
  const row = pricingDB.getAll()[0];
  return ruleSchema.mergeRules(row && row.rules && typeof row.rules === "object" ? row.rules : {});
}

/** The fixed parts of a stored quote's total, each in whole cents. */
function quoteParts(quote, rules) {
  // As stored (the engine settles it to the cent; a quote from before it did may carry a fraction,
  // and the order route has always passed that through as it is).
  const total = Number(quote.orderTotal || quote.subtotal || 0);
  const subtotal = cents(quote.subtotal);
  const lead = Math.max(0, cents(quote.leadTimeSurcharge));
  const paperwork = Boolean(quote.paperwork);
  const paperworkFee = paperwork ? Math.max(0, Number(quote.paperworkFee) || 0) : 0;
  const stored = shipping.storedFor(quote);
  const floor = cents(total - paperworkFee);             // what the minimum-order rule was applied to
  const minimumApplied = floor > subtotal + lead + stored.amount + 0.005;
  // The minimum the quote was priced under: its own floor when the minimum set the price, else
  // today's rule, never more than the quote's own floor (a held price does not go up).
  const minimum = minimumApplied ? floor : Math.min(Math.max(0, Number(rules.minimumOrderTotal) || 0), floor);
  return { total, subtotal, lead, paperwork, paperworkFee, stored, floor, minimum };
}

/** What a delivery choice comes to. `shippingCost` is null when "ship" has no price (freight to be confirmed). */
function totalFor(method, q, shipBlock) {
  const shippingCost = method === "ship" ? (shipBlock.manual ? null : shipBlock.amount) : 0;
  if (shippingCost === null) return { shippingCost: null, total: null };
  // "ship" at the quote's own shipping line is the quote's own total, exactly.
  if (method === "ship" && Math.abs(shippingCost - q.stored.amount) < 0.005 && !q.stored.manual) return { shippingCost, total: q.total };
  return { shippingCost, total: cents(Math.max(q.subtotal + q.lead + shippingCost, q.minimum) + q.paperworkFee) };
}

/**
 * The delivery choices for a quote, as the checkout page lists them.
 * `destination` ({ country, state }) is optional: before the buyer has typed an address the
 * "we ship it" line is shown as priced on the quote.
 */
function optionsFor(quote, rules = currentRules(), destination = null) {
  const s = shipping.settings(rules);
  const q = quoteParts(quote, rules);
  const ship = destination ? shipping.atDestination(q.stored, destination, rules) : q.stored;
  const words = shipping.describe(ship, rules);
  const shipTotal = totalFor("ship", q, ship);
  const options = [{
    method: "ship",
    title: "Ship to my address",
    detail: words.note,
    shippingText: words.valueText,
    available: !ship.manual,
    unavailableReason: ship.manual ? ship.reason : "",
    shippingCost: shipTotal.shippingCost,
    total: shipTotal.total,
  }];
  if (s.carrierAccount) {
    const t = totalFor("carrier-account", q, ship);
    options.push({ method: "carrier-account", title: "Ship on my carrier account", detail: "Give us your UPS or FedEx account number and we ship collect. No shipping charge from us.", shippingText: "On your account", available: true, unavailableReason: "", shippingCost: 0, total: t.total });
  }
  if (s.pickup) {
    const t = totalFor("pickup", q, ship);
    options.push({ method: "pickup", title: "Pick up at our shop", detail: "No shipping charge. The pickup address comes with your order confirmation, after payment.", shippingText: "Pickup", available: true, unavailableReason: "", shippingCost: 0, total: t.total });
  }
  return { options, ship, parts: q, carriers: shipping.CARRIERS };
}

/**
 * What the quote and checkout pages are told about shipping and tax. With every switch at its
 * default this says: one choice (we ship), the shipping line as priced, no tax note.
 */
function viewFor(quote, rules = currentRules()) {
  const { options, ship } = optionsFor(quote, rules);
  const words = shipping.describe(ship, rules);
  return {
    shipping: { mode: ship.mode, label: words.label, valueText: words.valueText, note: words.note, manual: ship.manual, packedLb: ship.packedLb },
    options,
    // The chooser appears only when there is something to choose, or when "we ship" has no price.
    showOptions: options.length > 1 || ship.manual,
    carriers: shipping.CARRIERS,
    tax: tax.publicInfo(rules),
  };
}

/**
 * Add the "freight has to be confirmed" reason to a quote's gate when the order cannot be given a
 * shipping price and the buyer has no other way to take delivery (no carrier account, no pickup):
 * such a quote goes to a firm quote like any other the gate catches.
 */
function gateWithShipping(gate, shipBlock, rules) {
  if (!shipBlock || !shipBlock.manual) return gate;
  const s = shipping.settings(rules);
  if (s.carrierAccount || s.pickup) return gate;
  // Gate reasons are phrases the pages finish with their own full stop.
  const reasons = [...(gate.reasons || []), { partId: null, code: "shipping-freight", message: String(shipBlock.reason || "").replace(/\.\s*$/, "") }];
  return { ...gate, requiresRfq: true, reasons };
}

/** The delivery choice named in a request: absent means "we ship" (as before the choice existed); anything that is not one of the three names is no choice at all. */
function requestedMethod(body) {
  const v = body.shippingOption;
  if (v === undefined || v === null) return "ship";
  return typeof v === "string" && shipping.METHODS.includes(v) ? v : null;
}

/**
 * Resolve a checkout request against a stored quote.
 * @param {object} quote  the stored quote
 * @param {object} body   the request body (only the fields named above are read)
 * @param {object} [o]    { rules, certificate: { fileName, path } | null }
 * @returns {{ ok:false, status, error, code } | { ok:true, ...everything the order row needs }}
 */
function resolve(quote, body = {}, { rules = currentRules(), certificate = null } = {}) {
  const s = shipping.settings(rules);
  const method = requestedMethod(body);
  if (!method) return { ok: false, status: 400, code: "shipping-option", error: "Choose how you want the order delivered." };
  if (method === "carrier-account" && !s.carrierAccount) return { ok: false, status: 400, code: "shipping-option", error: "Shipping on your own carrier account isn't offered. Choose another delivery option." };
  if (method === "pickup" && !s.pickup) return { ok: false, status: 400, code: "shipping-option", error: "Pickup isn't offered. Choose another delivery option." };

  const address = {
    shippingName: sanitizeString(body.shippingName || "", 200),
    shippingAddress: sanitizeString(body.shippingAddress || "", 500),
    shippingCity: sanitizeString(body.shippingCity || "", 100),
    shippingState: sanitizeString(body.shippingState || "", 100),
    shippingZip: sanitizeString(body.shippingZip || "", 20),
    shippingCountry: sanitizeString(body.shippingCountry || "US", 5),
  };

  let carrier = null;
  if (method === "carrier-account") {
    carrier = shipping.cleanCarrierAccount({ carrier: body.carrier, account: body.carrierAccount, service: body.carrierService });
    if (!carrier.ok) return { ok: false, status: 400, code: "carrier-account", error: carrier.error };
  }
  if (method === "pickup") {
    // Nothing is shipped: only the name of who is collecting is kept.
    if (!address.shippingName) return { ok: false, status: 400, code: "pickup-name", error: "Tell us who is picking the order up." };
    Object.assign(address, { shippingAddress: "", shippingCity: "", shippingState: "", shippingZip: "", shippingCountry: "US" });
  }

  const q = quoteParts(quote, rules);
  const ship = method === "ship" ? shipping.atDestination(q.stored, { country: address.shippingCountry, state: address.shippingState }, rules) : q.stored;
  const sum = totalFor(method, q, ship);
  if (sum.total === null) {
    return { ok: false, status: 409, code: "shipping-manual", error: `${ship.reason} ${s.carrierAccount || s.pickup ? "Choose another delivery option, or request a firm quote." : "Request a firm quote and we will price the freight."}`, reasonCode: ship.reasonCode };
  }

  const exemption = tax.exemptionFor({ declared: body.taxExempt, reason: body.taxExemptReason, hasCertificate: Boolean(certificate && certificate.path) }, rules);
  if (!exemption.ok) return { ok: false, status: 400, code: exemption.code, error: exemption.error };

  // The same "does it itemize" rule the order route has always used, with this choice's shipping.
  const itemized = q.subtotal > 0 && Math.abs(q.subtotal + q.lead + sum.shippingCost + q.paperworkFee - sum.total) < 0.02;
  return {
    ok: true,
    method,
    address,
    total: sum.total,
    shippingCost: itemized ? sum.shippingCost : 0,
    leadTimeSurcharge: itemized ? q.lead : 0,
    subtotal: itemized ? q.subtotal : cents(sum.total - q.paperworkFee),
    itemized,
    paperwork: q.paperwork,
    paperworkFee: q.paperworkFee,
    shippingMode: ship.mode,
    packedWeightLb: ship.packedLb,
    carrier,
    taxMode: tax.settings(rules).mode,
    exemption,
    certificate: exemption.declared ? certificate : null,
  };
}

// ─── Firm quotes ─────────────────────────────────────────────────────────────
// A firm quote's price is the owner's and is the total: there is no shipping line to work out.
// The buyer still chooses how the order is delivered when the owner has switched a choice on,
// and the same tax and exemption rules apply to a card payment. A purchase order is not charged
// here at all: its tax is "per invoice".

/** The delivery choices and tax note for the firm-quote page. */
function firmView(rules = currentRules()) {
  const s = shipping.settings(rules);
  const options = [{ method: "ship", title: "Ship to my address", detail: "Shipping to your address is in the quoted price.", shippingText: "In the quoted price", available: true }];
  if (s.carrierAccount) options.push({ method: "carrier-account", title: "Ship on my carrier account", detail: "Give us your UPS or FedEx account number and we ship collect. The quoted price does not change.", shippingText: "On your account", available: true });
  if (s.pickup) options.push({ method: "pickup", title: "Pick up at our shop", detail: "We confirm the pickup address and a time with you. The quoted price does not change.", shippingText: "Pickup", available: true });
  return { options, showOptions: options.length > 1, carriers: shipping.CARRIERS, tax: tax.publicInfo(rules) };
}

/** Resolve the delivery choice, carrier account and exemption on a firm-quote acceptance. Amounts are not touched: the total is the quoted total. */
function resolveFirm(body = {}, { rules = currentRules(), certificate = null } = {}) {
  const s = shipping.settings(rules);
  const method = requestedMethod(body);
  if (!method) return { ok: false, status: 400, code: "shipping-option", error: "Choose how you want the order delivered." };
  if (method === "carrier-account" && !s.carrierAccount) return { ok: false, status: 400, code: "shipping-option", error: "Shipping on your own carrier account isn't offered. Choose another delivery option." };
  if (method === "pickup" && !s.pickup) return { ok: false, status: 400, code: "shipping-option", error: "Pickup isn't offered. Choose another delivery option." };
  const address = {
    shippingName: sanitizeString(body.shippingName || "", 200),
    shippingAddress: sanitizeString(body.shippingAddress || "", 500),
    shippingCity: sanitizeString(body.shippingCity || "", 100),
    shippingState: sanitizeString(body.shippingState || "", 100),
    shippingZip: sanitizeString(body.shippingZip || "", 20),
    shippingCountry: sanitizeString(body.shippingCountry || "US", 5),
  };
  let carrier = null;
  if (method === "carrier-account") {
    carrier = shipping.cleanCarrierAccount({ carrier: body.carrier, account: body.carrierAccount, service: body.carrierService });
    if (!carrier.ok) return { ok: false, status: 400, code: "carrier-account", error: carrier.error };
  }
  if (method === "pickup") {
    if (!address.shippingName) return { ok: false, status: 400, code: "pickup-name", error: "Tell us who is picking the order up." };
    Object.assign(address, { shippingAddress: "", shippingCity: "", shippingState: "", shippingZip: "", shippingCountry: "US" });
  }
  const exemption = tax.exemptionFor({ declared: body.taxExempt, reason: body.taxExemptReason, hasCertificate: Boolean(certificate && certificate.path) }, rules);
  if (!exemption.ok) return { ok: false, status: 400, code: exemption.code, error: exemption.error };
  return { ok: true, method, address, carrier, shippingMode: "firm", packedWeightLb: null, taxMode: tax.settings(rules).mode, exemption, certificate: exemption.declared ? certificate : null };
}

/** The order-row fields for a resolved checkout (everything but the sealed account number, which needs the order id). */
function orderFields(r) {
  return {
    ...r.address,
    shippingMethod: r.method === "ship" ? "standard" : r.method,
    shippingMode: r.shippingMode,
    packedWeightLb: r.packedWeightLb,
    shipCarrier: r.carrier ? r.carrier.carrier : "",
    shipAccountLast4: r.carrier ? r.carrier.last4 : "",
    shipService: r.carrier ? r.carrier.service : "",
    shipAccountEnc: "",
    taxMode: r.taxMode,
    taxExempt: r.exemption.declared,
    taxExemptReason: r.exemption.reason,
    taxExemptStatus: r.exemption.status,
    taxCertFileName: r.certificate ? r.certificate.fileName : "",
    taxCertPath: r.certificate ? r.certificate.path : "",
  };
}

/**
 * An order as a page may show its delivery and tax: no sealed value, no server path. The full
 * carrier account number is opened only when `admin` is true; the pickup address is given only
 * for a pickup order that has been paid for.
 */
function orderView(order, { admin = false } = {}) {
  const { shipAccountEnc, taxCertPath, ...safe } = order;
  const out = { ...safe };
  out.hasTaxCertificate = Boolean(taxCertPath);
  out.shipAccountMasked = shipping.maskAccount(order.shipAccountLast4);
  out.deliveryLine = shipping.methodLine(order);
  out.taxLine = tax.orderLine(order);
  if (admin) {
    out.shipAccountNumber = order.shippingMethod === "carrier-account" ? shipping.openAccount(order) : null;
    out.shipAccountUnreadable = order.shippingMethod === "carrier-account" && Boolean(shipAccountEnc) && out.shipAccountNumber === null;
    out.taxExemptionLine = tax.exemptionLine(order);
  } else {
    // Internal to the shop: which Stripe IDs were collected stays on the admin view.
    delete out.customerTaxIds;
  }
  if (order.shippingMethod === "pickup" && pickupDisclosed(order)) out.pickupAddress = shipping.pickupAddress();
  return out;
}

/** A pickup order's address is given out once the order is paid for (never while payment is pending, never for a cancelled order). */
function pickupDisclosed(order) {
  return order.shippingMethod === "pickup" && Boolean(order.paidAt) && !["pending_payment", "pending_po", "cancelled", "paid_amount_mismatch"].includes(order.status);
}

module.exports = { currentRules, quoteParts, totalFor, optionsFor, viewFor, gateWithShipping, resolve, firmView, resolveFirm, orderFields, orderView, pickupDisclosed, money };
