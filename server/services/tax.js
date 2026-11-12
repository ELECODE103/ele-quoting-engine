/**
 * Sales tax at checkout.
 *
 * Two modes (setting `taxMode`, group "Shipping & tax"):
 *
 *   off      (default: the behaviour before this file existed) no tax is added, none is mentioned,
 *            the Stripe session is created exactly as before.
 *   stripe   Stripe Tax works the tax out on its hosted payment page (`automatic_tax`), from
 *            the registrations and the head office address the owner set up in the Stripe
 *            dashboard. We do not compute a rate anywhere: with no registration in Stripe for
 *            the buyer's location, Stripe's answer is zero tax.
 *
 * Where the buyer is, for tax: Stripe uses the address on the Customer we create for the session:
 * the ship-to address typed at checkout, or for a pickup order the shop's own city, state and ZIP
 * (the goods change hands there). The buyer is not asked for the address a second time on
 * Stripe's page, so the address the order ships to is the address it is taxed at.
 *
 * Exemptions (`taxExemptDeclare`, `taxTrustDeclaredExemptions`):
 *   A buyer may declare an order exempt (resale, manufacturing machinery, exempt organisation) and
 *   must attach the certificate. What the declaration does is the owner's choice, not the buyer's:
 *     trust off (default)  the order is charged tax like any other; the owner reads the
 *                          certificate and refunds the tax in Stripe.
 *     trust on             the Stripe Customer is marked tax-exempt and no tax is charged.
 *   Either way the order carries the declaration, its status and the certificate for the admin.
 *
 * What this does not do: file a return, register anywhere, judge a certificate, or decide which
 * tax applies to a custom part. docs/launch/tax-and-shipping.md has the brief for the accountant.
 */
const NONTAXABLE_CODE = "txcd_00000000"; // Stripe's "Nontaxable" (docs.stripe.com/tax/tax-codes, read 2026-11-11)

const EXEMPT_REASONS = [
  { value: "resale", label: "Resale: we resell these parts or build them into a product we sell" },
  { value: "manufacturing", label: "Manufacturing machinery and equipment, or its repair and replacement parts" },
  { value: "organization", label: "Exempt organization (government, school, charity) with an exemption number" },
  { value: "other", label: "Another exemption, explained on the certificate" },
];

function settings(rules = {}) {
  const mode = rules.taxMode === "stripe" ? "stripe" : "off";
  return {
    mode,
    productCode: /^txcd_[0-9]{8}$/.test(String(rules.taxProductCode || "")) ? rules.taxProductCode : "",
    shipping: rules.taxShipping === "nontaxable" ? "nontaxable" : "goods",
    taxIds: mode === "stripe" && rules.taxIdCollection === "on",
    // Declaring an exemption only means something when tax is being charged.
    declare: mode === "stripe" && rules.taxExemptDeclare === "on",
    trust: mode === "stripe" && rules.taxExemptDeclare === "on" && rules.taxTrustDeclaredExemptions === "on",
  };
}

/**
 * What the pages say about tax under the current settings, in the shop's own words. With tax
 * off every string is empty and the pages read exactly as before.
 */
function publicInfo(rules = {}) {
  const s = settings(rules);
  if (s.mode === "off") return { mode: "off", note: "", poNote: "", exemption: { offered: false, trusted: false, reasons: [] } };
  return {
    mode: "stripe",
    note: "Sales tax, where it applies, is worked out from your address and added on the secure payment page before you pay.",
    poNote: "Sales tax on a purchase order is per invoice: any tax due is on the invoice we send, not in this price.",
    exemption: {
      offered: s.declare,
      trusted: s.trust,
      reasons: s.declare ? EXEMPT_REASONS : [],
      note: !s.declare ? ""
        : s.trust ? "Tick the box and attach your certificate and this order is charged with no sales tax. We keep the certificate with the order."
          : "Tick the box and attach your certificate. The order is charged with tax today; once we have read the certificate we refund the tax to your card.",
    },
  };
}

/**
 * What a declared exemption amounts to for one order. `declared` and `reason` come from the
 * buyer; whether a certificate is on file comes from the database; what it does comes from the
 * settings. A declaration without the switch on is ignored (the order is simply taxed).
 * @returns {{ ok:true, declared:boolean, reason:string, status:""|"untaxed"|"taxed" } | { ok:false, error, code }}
 */
function exemptionFor({ declared, reason, hasCertificate }, rules = {}) {
  const s = settings(rules);
  const said = declared === true || declared === "true" || declared === 1 || declared === "1" || declared === "on";
  if (!s.declare || !said) return { ok: true, declared: false, reason: "", status: "" };
  const known = EXEMPT_REASONS.find((r) => r.value === reason);
  if (!known) return { ok: false, code: "exemption-reason", error: "Choose the reason this order is tax-exempt." };
  if (!hasCertificate) return { ok: false, code: "certificate-required", error: "Attach your exemption certificate, or untick the tax-exempt box." };
  return { ok: true, declared: true, reason: known.value, status: s.trust ? "untaxed" : "taxed" };
}

const reasonLabel = (value) => (EXEMPT_REASONS.find((r) => r.value === value) || { label: "" }).label.split(":")[0];

/** The address Stripe taxes an order at: the ship-to address, or the shop's locality for a pickup. */
function taxAddress(order) {
  if (order.shippingMethod === "pickup") return { name: order.customerName || order.shippingName || "", address: require("./shipping").pickupLocality() };
  const country = String(order.shippingCountry || "US").trim().toUpperCase().slice(0, 2) || "US";
  return {
    name: order.shippingName || order.customerName || "",
    address: {
      line1: order.shippingAddress || undefined,
      city: order.shippingCity || undefined,
      state: country === "US" ? require("./shipping").stateCode(order.shippingState) : (order.shippingState || undefined),
      postal_code: order.shippingZip || undefined,
      country,
    },
  };
}

/**
 * The extra Stripe Checkout parameters for an order checked out with Stripe Tax, after creating
 * the Stripe Customer the session is tied to. For an order with tax off this returns null and
 * the session is created exactly as it always was.
 *
 * @param {object} stripe  the Stripe client (or the test stub)
 * @param {object} order   the stored order (taxMode, taxExemptStatus, ship-to fields)
 * @param {string} email
 * @returns {Promise<null | { session: object, decorate: (line, kind) => object }>}
 *          `session`: parameters to spread into checkout.sessions.create (they replace customer_email);
 *          `decorate`: adds tax_behavior and the tax code to one line item ("goods" | "paperwork" | "shipping").
 */
async function stripeParams(stripe, order, email, rules = {}) {
  if (order.taxMode !== "stripe") return null;
  const s = settings({ ...rules, taxMode: "stripe" });
  const where = taxAddress(order);
  const exempt = order.taxExempt === true && order.taxExemptStatus === "untaxed";
  const customer = await stripe.customers.create({
    email: email || undefined,
    name: where.name || undefined,
    // Checkout taxes an existing customer at the saved shipping address when it does not collect one itself.
    shipping: { name: where.name || "Customer", address: where.address },
    address: where.address,
    tax_exempt: exempt ? "exempt" : "none",
    // A bad address is refused here, with a message we can show, rather than on Stripe's page.
    tax: { validate_location: "immediately" },
    metadata: { orderId: order.id },
  });
  const session = {
    customer: customer.id,
    automatic_tax: { enabled: true },
    // Tax ID collection with an existing customer needs the name kept in step (Stripe's requirement).
    ...(s.taxIds ? { tax_id_collection: { enabled: true }, customer_update: { name: "auto" } } : {}),
  };
  const decorate = (line, kind) => {
    const code = kind === "shipping" && s.shipping === "nontaxable" ? NONTAXABLE_CODE : s.productCode;
    return {
      ...line,
      price_data: {
        ...line.price_data,
        // Our prices never include tax: Stripe adds it on top.
        tax_behavior: "exclusive",
        product_data: { ...line.price_data.product_data, ...(code ? { tax_code: code } : {}) },
      },
    };
  };
  return { session, decorate };
}

/**
 * What a paid Checkout session says about tax and discounts, in cents.
 * `preTax` is what the lines came to before any promo code and before tax: the figure the
 * order's own total is checked against.
 */
function readSession(session = {}) {
  const d = session.total_details || {};
  const tax = Math.max(0, Math.round(Number(d.amount_tax) || 0));
  const discount = Math.max(0, Math.round(Number(d.amount_discount) || 0));
  const shipping = Math.max(0, Math.round(Number(d.amount_shipping) || 0));
  const preTax = Number.isFinite(Number(session.amount_subtotal)) && session.amount_subtotal !== null
    ? Number(session.amount_subtotal) + shipping
    // No subtotal on the object: take the tax (and any discount) back out of what was charged.
    : (Number.isFinite(Number(session.amount_total)) && session.amount_total !== null ? Number(session.amount_total) - tax + discount : null);
  const ids = ((session.customer_details && session.customer_details.tax_ids) || [])
    .map((t) => `${String(t.type || "").slice(0, 20)} ${String(t.value || "").slice(0, 40)}`.trim()).filter(Boolean).slice(0, 5);
  return { taxCents: tax, discountCents: discount, preTaxCents: preTax, taxIds: ids.join("; ") };
}

/**
 * How an order's tax reads on a page, an email or a document: null when there is nothing to say
 * (tax off and none charged), else { label, valueText, amount }.
 */
function orderLine(order) {
  const tax = Number(order.tax) || 0;
  if (tax > 0.004) return { label: "Sales tax", amount: tax, valueText: null };
  if (order.taxMode !== "stripe") return null;
  if (order.paymentMethod === "po") return { label: "Sales tax", amount: null, valueText: "Per invoice" };
  if (order.taxExempt && order.taxExemptStatus === "untaxed") return { label: "Sales tax", amount: null, valueText: "Exempt (certificate on file)" };
  if (order.status === "pending_payment") return { label: "Sales tax", amount: null, valueText: "Added at payment" };
  return { label: "Sales tax", amount: 0, valueText: null };
}

/** The exemption on an order as one line for the shop: "" when none was declared. */
function exemptionLine(order) {
  if (!order.taxExempt) return "";
  const why = reasonLabel(order.taxExemptReason) || "Declared exempt";
  return order.taxExemptStatus === "untaxed"
    ? `${why}: charged with NO tax (declared exemptions are trusted). Check the certificate.`
    : `${why}: charged WITH tax. Read the certificate, then refund the tax in Stripe if it holds.`;
}

module.exports = { settings, publicInfo, exemptionFor, stripeParams, readSession, orderLine, exemptionLine, taxAddress, reasonLabel, EXEMPT_REASONS, NONTAXABLE_CODE };
