/**
 * Email templates. Every message goes through one branded layout and comes
 * back as { subject, text, html } ready for mailer.send().
 *
 * Brand facts (name, phone, email, address, turnaround) come from
 * shared/brand.json. No remote images: the wordmark is bold text. Colours are
 * ink, bone, and brass for a single hairline.
 *
 * Preview: `node scripts/preview-emails.js [outDir]`.
 */
const brand = require("../../shared/brand.json");
const shopFacts = require("../shopFacts");
const { formatShipBy, SHOP_TZ } = require("../services/shipBy");

const INK = "#101C33";
const BRASS = "#A8834E";
const BONE = "#F4F1EA";
const MUTED = "#5B6477";   // ink, lightened for secondary text
const RULE = "#E4DFD3";    // bone, darkened for table rules
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

const PROCESS_LABELS = { cnc: "CNC machining", routing: "CNC routing", "3d-printing": "3D printing", sheetmetal: "Sheet metal" };

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function money(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function longDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: SHOP_TZ, month: "long", day: "numeric", year: "numeric" });
}
function shortId(id) {
  return String(id || "").slice(0, 8).toUpperCase();
}
function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}
const greeting = (name) => (firstName(name) ? `Hi ${firstName(name)},` : "Hello,");

const TRACKING_URLS = {
  ups: (n) => `https://www.ups.com/track?tracknum=${n}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  dhl: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`,
};
/** Carrier tracking page for a tracking number, or "" when the carrier isn't one we know. */
function trackingUrl(carrier, number) {
  const fn = TRACKING_URLS[String(carrier || "").toLowerCase()];
  return fn && number ? fn(encodeURIComponent(String(number).trim())) : "";
}

// ─── Layout ────────────────────────────────────────────────────

/**
 * @param {Object} m
 * @param {string} m.preheader  inbox preview line
 * @param {string} m.heading
 * @param {string[]} m.paragraphs  plain strings (escaped here)
 * @param {Array<[string,string]>} [m.facts]  label/value rows
 * @param {Array} [m.items]  line items { name, detail, qty, amount }
 * @param {{label:string,value:string}} [m.total]
 * @param {{label:string,url:string}} [m.cta]
 * @param {string[]} [m.after]  paragraphs below the button
 */
function layout(m) {
  const wordmark = brand.name.toUpperCase();
  const p = (t) => `<p style="margin:0 0 14px;font:15px/1.6 ${FONT};color:${INK};">${esc(t)}</p>`;

  const facts = (m.facts || []).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const factsHtml = facts.length ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border-top:1px solid ${RULE};">
          ${facts.map(([k, v]) => `<tr>
            <td style="padding:9px 12px 9px 0;border-bottom:1px solid ${RULE};font:13px/1.4 ${FONT};color:${MUTED};white-space:nowrap;vertical-align:top;">${esc(k)}</td>
            <td style="padding:9px 0;border-bottom:1px solid ${RULE};font:600 14px/1.4 ${FONT};color:${INK};text-align:right;">${esc(v)}</td>
          </tr>`).join("")}
        </table>` : "";

  const items = m.items || [];
  const itemsHtml = items.length ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border-top:1px solid ${RULE};">
          ${items.map((it) => `<tr>
            <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${RULE};vertical-align:top;">
              <div style="font:600 14px/1.4 ${FONT};color:${INK};word-break:break-word;">${esc(it.name)}</div>
              <div style="font:13px/1.4 ${FONT};color:${MUTED};">${esc([it.qty ? `${it.qty} pc${it.qty === 1 ? "" : "s"}` : "", it.detail].filter(Boolean).join(" · "))}</div>
            </td>
            <td style="padding:10px 0;border-bottom:1px solid ${RULE};font:14px/1.4 ${FONT};color:${INK};text-align:right;white-space:nowrap;vertical-align:top;">${it.amount != null ? esc(money(it.amount)) : ""}</td>
          </tr>`).join("")}
          ${m.total ? `<tr>
            <td style="padding:12px 12px 0 0;font:600 14px/1.4 ${FONT};color:${INK};">${esc(m.total.label)}</td>
            <td style="padding:12px 0 0;font:700 18px/1.4 ${FONT};color:${INK};text-align:right;white-space:nowrap;">${esc(m.total.value)}</td>
          </tr>` : ""}
        </table>` : "";

  const ctaHtml = m.cta ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr>
          <td style="background:${INK};border-radius:4px;">
            <a href="${esc(m.cta.url)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:${BONE};text-decoration:none;">${esc(m.cta.label)}</a>
          </td>
        </tr></table>
        <p style="margin:0 0 14px;font:12px/1.5 ${FONT};color:${MUTED};word-break:break-all;">If the button doesn't work, paste this into your browser:<br>${esc(m.cta.url)}</p>` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(m.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BONE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BONE};">${esc(m.preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BONE};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
      <tr><td style="background:${INK};padding:22px 32px;">
        <span style="font:700 18px/1 ${FONT};letter-spacing:3px;color:${BONE};">${esc(wordmark)}</span>
      </td></tr>
      <tr><td style="height:2px;line-height:2px;font-size:0;background:${BRASS};">&nbsp;</td></tr>
      <tr><td style="background:#FFFFFF;padding:30px 32px 18px;">
        <h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${INK};">${esc(m.heading)}</h1>
        ${(m.paragraphs || []).map(p).join("\n        ")}
        ${factsHtml}${itemsHtml}${ctaHtml}
        ${(m.after || []).map(p).join("\n        ")}
      </td></tr>
      <tr><td style="padding:20px 32px 8px;font:12px/1.7 ${FONT};color:${MUTED};">
        <strong style="color:${INK};">${esc(brand.name)}</strong> · ${esc(brand.descriptor)}<br>
        ${esc(shopFacts.businessName(brand))}, ${esc(brand.city)}, ${esc(brand.state)}<br>
        <a href="${esc(brand.phoneHref)}" style="color:${INK};">${esc(brand.phone)}</a> ·
        <a href="mailto:${esc(brand.email)}" style="color:${INK};">${esc(brand.email)}</a> ·
        <a href="${esc(brand.url)}" style="color:${INK};">${esc(brand.domain)}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    m.heading,
    "",
    ...(m.paragraphs || []).flatMap((t) => [t, ""]),
    ...facts.map(([k, v]) => `${k}: ${v}`),
    facts.length ? "" : null,
    ...items.map((it) => `  - ${it.name}${it.qty ? ` x ${it.qty}` : ""}${it.detail ? ` (${it.detail})` : ""}${it.amount != null ? `  ${money(it.amount)}` : ""}`),
    m.total ? `${m.total.label}: ${m.total.value}` : null,
    items.length ? "" : null,
    m.cta ? `${m.cta.label}: ${m.cta.url}` : null,
    m.cta ? "" : null,
    ...(m.after || []).flatMap((t) => [t, ""]),
    "--",
    `${brand.name} · ${brand.phone} · ${brand.email}`,
    `${shopFacts.businessName(brand)}, ${brand.city}, ${brand.state} · ${brand.url}`,
  ].filter((l) => l !== null).join("\n");

  return { subject: m.subject, text, html };
}

// ─── Shared pieces ─────────────────────────────────────────────

function itemRows(items = []) {
  return items.map((it) => ({
    name: it.fileName || "Part",
    qty: it.quantity,
    detail: [it.materialName || it.materialSlug, PROCESS_LABELS[it.process] || it.process, it.finishName && it.finishName !== "As Machined" ? it.finishName : ""].filter(Boolean).join(" · "),
    amount: it.lineTotal,
  }));
}

function shipTo(order) {
  const line2 = [order.shippingCity, order.shippingState].filter(Boolean).join(", ");
  return [order.shippingName, order.shippingAddress, [line2, order.shippingZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function rfqPartRows(rfq) {
  return (rfq.parts || []).map((p) => ({
    name: p.fileName || "Part",
    qty: p.quotedQuantity || p.quantity,
    detail: [p.materialName || p.materialSlug, PROCESS_LABELS[p.process] || p.process].filter(Boolean).join(" · "),
    amount: null,
  }));
}

/** The lines between the parts and the total: lead-time fee and shipping, when the order carries them. */
function chargeRows(order) {
  const rows = [];
  const fee = Number(order.leadTimeSurcharge) || 0;
  const shipping = Number(order.shippingCost) || 0;
  if (fee > 0.004) rows.push({ name: `${order.leadTimeName || "Faster"} lead time`, amount: fee });
  if (shipping > 0.004) rows.push({ name: "Shipping", amount: shipping });
  return rows;
}

const DRAWING_NOTE = "We review drawings before cutting; we'll contact you before work starts if anything changes the price.";

// ─── RFQ ───────────────────────────────────────────────────────

function rfqReceivedBuyer({ rfq }) {
  const n = (rfq.parts || []).length;
  return layout({
    subject: `${brand.name}: we have your quote request`,
    preheader: `A firm quote comes back${shopFacts.when("quote-turnaround", (v) => ` within ${v}`)} from the person who will run the job.`,
    heading: "We have your request",
    paragraphs: [
      greeting(rfq.contactName),
      `Thanks. We have your request${n ? ` for ${n} part${n === 1 ? "" : "s"}` : ""}. A firm quote comes back${shopFacts.when("quote-turnaround", (v) => ` within ${v},`)} from the person who will run the job.`,
      // "before then" only means something when a turnaround is stated.
      `If anything on the print needs a conversation first, you'll hear from us ${shopFacts.ok("quote-turnaround") ? "before then" : "about that first"}.`,
    ],
    items: rfqPartRows(rfq),
    facts: [["Reference", shortId(rfq.id)]],
  });
}

function rfqReceivedShop({ rfq, adminUrl }) {
  const parts = rfq.parts || [];
  return layout({
    subject: `RFQ: ${rfq.contactName}${rfq.company ? " / " + rfq.company : ""} — ${parts.length || "?"} part(s)`,
    preheader: `New RFQ from ${rfq.contactName}`,
    heading: `New RFQ from ${rfq.contactName}`,
    paragraphs: [
      `${rfq.contactName} <${rfq.email}>${rfq.company ? " — " + rfq.company : ""}${rfq.phone ? " — " + rfq.phone : ""}`,
      ...(rfq.reasons || []).length ? [`Why it's an RFQ: ${rfq.reasons.map((r) => r.message).join("; ")}`] : [],
      ...(rfq.notes ? [`Notes: ${rfq.notes}`] : []),
    ],
    facts: [
      ["Quantities", rfq.quantities || "(see parts)"],
      ["Tolerance", rfq.tolerance],
      ["Finish notes", rfq.finishNotes],
      ["Need by", rfq.dueDate],
      ["Drawing", rfq.drawingFileName || "none"],
      ["Budgetary total shown", money(rfq.budgetTotal)],
      ["Reference", shortId(rfq.id)],
    ],
    items: parts.map((p) => ({
      name: p.fileName || "Part",
      qty: p.quantity,
      detail: [p.materialSlug, PROCESS_LABELS[p.process] || p.process, `budgetary ${money(p.budgetUnit)}/ea`].filter(Boolean).join(" · "),
      amount: p.budgetLine,
    })),
    cta: adminUrl ? { label: "Open the RFQ queue", url: adminUrl } : undefined,
  });
}

/** The firm quote, sent when the admin marks an RFQ quoted. */
function rfqQuoted({ rfq, acceptUrl, shipBy }) {
  const days = rfq.quotedLeadDays;
  return layout({
    subject: `${brand.name}: your firm quote — ${money(rfq.quotedTotal)}`,
    preheader: `${money(rfq.quotedTotal)}, good until ${longDate(rfq.validUntil)}.`,
    heading: "Your firm quote",
    paragraphs: [
      greeting(rfq.contactName),
      "Here is the firm price for your parts. Review it and accept online: pay by card, or send a purchase order number.",
      ...(rfq.quoteNote ? [rfq.quoteNote] : []),
    ],
    items: rfqPartRows(rfq),
    facts: [
      ["Price", money(rfq.quotedTotal)],
      ["Lead time", days != null ? `${days} business day${days === 1 ? "" : "s"}${shipBy ? ` (ships by ${formatShipBy(shipBy)} if ordered today)` : ""}` : ""],
      ["Good until", longDate(rfq.validUntil)],
      ["Reference", shortId(rfq.id)],
    ],
    cta: { label: "Review and accept", url: acceptUrl },
    after: [
      `The link is yours alone and stops working after ${longDate(rfq.validUntil)}. Questions? Reply to this email or call ${brand.phone}.`,
    ],
  });
}

/** To the shop: a customer accepted a firm quote (card checkout started, or PO given). */
function rfqAcceptedShop({ rfq, order, adminUrl }) {
  const po = order.paymentMethod === "po";
  return layout({
    subject: po
      ? `Quote accepted on PO ${order.poNumber}: ${rfq.contactName}${rfq.company ? " / " + rfq.company : ""}`
      : `Quote accepted, card checkout started: ${rfq.contactName}${rfq.company ? " / " + rfq.company : ""}`,
    preheader: `${money(order.total)} — ${po ? "PO " + order.poNumber : "paying by card"}`,
    heading: po ? "Quote accepted on a purchase order" : "Quote accepted",
    paragraphs: [
      `${rfq.contactName} <${rfq.email}>${rfq.company ? " — " + rfq.company : ""}${rfq.phone ? " — " + rfq.phone : ""}`,
      po
        ? "The customer accepted and gave a PO number. Nothing has been charged and no terms have been set up: confirm the PO with them before starting work."
        : "The customer accepted and was sent to card checkout. You'll get a separate email when the payment clears.",
    ],
    facts: [
      ["Quoted total", money(order.total)],
      ["PO number", po ? order.poNumber : ""],
      ["Ship to", shipTo(order)],
      ["Ships by", formatShipBy(order.shipBy)],
      ["Order", shortId(order.id)],
      ["RFQ", shortId(rfq.id)],
    ],
    items: rfqPartRows(rfq),
    cta: adminUrl ? { label: "Open admin", url: adminUrl } : undefined,
  });
}

// ─── Orders ────────────────────────────────────────────────────

/** To the customer: order confirmed (card paid, or PO on file). */
function orderConfirmation({ order, items, orderUrl }) {
  const po = order.paymentMethod === "po";
  return layout({
    subject: `${brand.name}: order ${shortId(order.id)} confirmed`,
    preheader: order.shipBy ? `Ships by ${formatShipBy(order.shipBy)}.` : "We have your order.",
    heading: po ? "We have your order" : "Order confirmed",
    paragraphs: [
      greeting(order.customerName || order.shippingName),
      po
        ? `Thanks. Your order is in under PO ${order.poNumber}. We'll confirm the PO with you and then start work.`
        : "Thanks. Your payment went through and your parts are in the queue.",
      ...(order.drawingFileName ? [DRAWING_NOTE] : []),
    ],
    items: [...itemRows(items), ...chargeRows(order)],
    total: { label: po ? "Order total" : "Total paid", value: money(order.total) },
    facts: [
      ["Order", shortId(order.id)],
      ["Ships by", formatShipBy(order.shipBy)],
      ["Ship to", shipTo(order)],
      ["PO number", po ? order.poNumber : ""],
      [order.rfqId ? "Quote notes" : "Your notes", order.customerNotes],
      ["Drawing", order.drawingFileName],
    ],
    cta: orderUrl ? { label: "View your order", url: orderUrl } : undefined,
    after: [`Need to change something? Reply to this email or call ${brand.phone} before we start cutting.`],
  });
}

/** To the shop: a paid order (or a PO order) landed. */
function newOrderShop({ order, items, adminUrl, warning }) {
  const po = order.paymentMethod === "po";
  return layout({
    subject: `New order ${shortId(order.id)} — ${money(order.total)}${po ? ` (PO ${order.poNumber})` : ""}`,
    preheader: `${order.customerName || order.shippingName || "Customer"} · ships by ${formatShipBy(order.shipBy)}`,
    heading: po ? "New order on a purchase order" : "New paid order",
    paragraphs: [
      `${order.customerName || order.shippingName || "Customer"}${order.customerEmail ? ` <${order.customerEmail}>` : ""}`,
      ...(warning ? [warning] : []),
      ...(order.drawingFileName ? [`Drawing attached to the order: ${order.drawingFileName}. Review it before cutting.`] : []),
    ],
    items: [...itemRows(items), ...chargeRows(order)],
    total: { label: "Total", value: money(order.total) },
    facts: [
      ["Order", shortId(order.id)],
      ["Payment", po ? `PO ${order.poNumber} (not charged)` : "Card, paid"],
      ["Lead time", order.leadTimeName],
      ["Ships by", formatShipBy(order.shipBy)],
      ["Ship to", shipTo(order)],
      ["Customer notes", order.customerNotes],
    ],
    cta: adminUrl ? { label: "Open admin", url: adminUrl } : undefined,
  });
}

/** To the customer: the order shipped. */
function orderShipped({ order, items, orderUrl }) {
  const url = trackingUrl(order.carrier, order.trackingNumber);
  return layout({
    subject: `${brand.name}: order ${shortId(order.id)} has shipped`,
    preheader: order.trackingNumber ? `${order.carrier || "Tracking"} ${order.trackingNumber}` : "Your parts are on the way.",
    heading: "Your order has shipped",
    paragraphs: [
      greeting(order.customerName || order.shippingName),
      order.trackingNumber
        ? "Your parts are on the way. Tracking is below."
        : "Your parts are on the way. We'll send tracking if the carrier gives us a number.",
    ],
    facts: [
      ["Order", shortId(order.id)],
      ["Carrier", order.carrier],
      ["Tracking number", order.trackingNumber],
      ["Shipped", longDate(order.shippedAt)],
      ["Ship to", shipTo(order)],
    ],
    items: itemRows(items).map((it) => ({ ...it, amount: null })),
    cta: url ? { label: "Track the shipment", url } : (orderUrl ? { label: "View your order", url: orderUrl } : undefined),
    after: [`Anything wrong when it arrives? Reply to this email or call ${brand.phone}.`],
  });
}

module.exports = {
  layout, trackingUrl, shortId, money, DRAWING_NOTE,
  rfqReceivedBuyer, rfqReceivedShop, rfqQuoted, rfqAcceptedShop,
  orderConfirmation, newOrderShop, orderShipped,
};
