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
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Only http(s), mailto and tel links go into an href; anything else becomes "#". */
function safeHref(url) {
  const u = String(url ?? "").trim();
  return /^(https?:\/\/|mailto:|tel:)/i.test(u) ? u : "#";
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
/**
 * "Hi Dana," only when the first word of the typed name looks like a name
 * (letters, with an apostrophe or hyphen inside, 30 characters at most). The
 * name on a request form is whatever a visitor typed, and the email goes to an
 * address they typed too, so a web address, a slogan or a string of symbols
 * never gets greeted by our domain: those read "Hello,".
 */
function greeting(name) {
  const first = firstName(name);
  return /^\p{L}[\p{L}\p{M}'’-]{0,29}$/u.test(first) ? `Hi ${first},` : "Hello,";
}

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
            <a href="${esc(safeHref(m.cta.url))}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:${BONE};text-decoration:none;">${esc(m.cta.label)}</a>
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

// Inspection paperwork is an option the customer asks for (owner, 2026-11-11), never a default.
const PAPERWORK_LABEL = "First-article inspection report and certificate of conformance";
const PAPERWORK_SHORT = "FAI + CoC";
const PAPERWORK_INCLUDED = "This price includes a first-article inspection report and a signed certificate of conformance, shipped with the parts.";
const PAPERWORK_NOT_INCLUDED = "A first-article inspection report and a certificate of conformance were not requested, so this price does not include them. Need them? Reply before you accept and we will add them to the price.";
const RETURN_INCLUDED = "This price includes shipping your original part back to you with the finished parts.";
const RETURN_NOT_INCLUDED = "You did not ask for the original part back, so this price does not include returning it. Want it back? Reply before you accept.";
const RETURN_REMINDER = "Customer wants the original back — include return shipping in the price.";
const PAPERWORK_REMINDER = "Customer asked for a first-article inspection report and a certificate of conformance — include them in the price.";
/** Was this firm-quote request a worn part shipped in to be measured? */
const isPartRequest = (rfq) => rfq.requestType === "part";

/**
 * The lines between the parts and the total: lead-time fee, inspection paperwork
 * and shipping, when the order carries them. Parts + these lines = the total.
 * On an order taken from a firm quote the paperwork has no amount of its own:
 * it is inside the quoted price, and the line says so.
 */
function chargeRows(order) {
  const rows = [];
  const fee = Number(order.leadTimeSurcharge) || 0;
  const shipping = Number(order.shippingCost) || 0;
  const paperworkFee = Number(order.paperworkFee) || 0;
  if (fee > 0.004) rows.push({ name: `${order.leadTimeName || "Faster"} lead time`, amount: fee });
  if (order.paperwork) rows.push(paperworkFee > 0.004 ? { name: PAPERWORK_LABEL, amount: paperworkFee } : { name: PAPERWORK_LABEL, detail: order.rfqId ? "included in the quoted price" : "included", amount: null });
  if (shipping > 0.004) rows.push({ name: "Shipping", amount: shipping });
  if (order.returnPart) rows.push({ name: "Your original part, returned with this order", detail: "return shipping included in the quoted price", amount: null });
  return rows;
}

/**
 * What was actually collected for an order paid by card. A promotion code lowers what Stripe
 * collects but not the order total, so when a discount is on the order the two are stated
 * side by side and never passed off as one (review F-17).
 */
function discountOf(order) {
  const d = Number(order.discountAmount);
  return Number.isFinite(d) && d > 0.004 ? d : 0;
}
function amountPaidOf(order) {
  const paid = Number(order.amountPaid);
  return discountOf(order) > 0 && Number.isFinite(paid) ? paid : Number(order.total) || 0;
}
/** The discount as a line under the charges, when there is one. */
function discountRows(order) {
  const d = discountOf(order);
  return d > 0 ? [{ name: "Order total before the promotion code", amount: Number(order.total) || 0 }, { name: "Promotion code", detail: `${money(d)} off`, amount: null }] : [];
}

const DRAWING_NOTE = "We review drawings before cutting; we'll contact you before work starts if anything changes the price.";

// ─── RFQ ───────────────────────────────────────────────────────

function rfqReceivedBuyer({ rfq, part }) {
  if (part) return { ...partRequestBuyer({ rfq, part }), template: "partRequestBuyer" };
  const n = (rfq.parts || []).length;
  return layout({
    subject: `${brand.name}: we have your quote request`,
    preheader: `A firm quote comes back${shopFacts.when("quote-turnaround", (v) => ` within ${v}`)} from the engineer who will run the job.`,
    heading: "We have your request",
    paragraphs: [
      greeting(rfq.contactName),
      `Thanks. We have your request${n ? ` for ${n} part${n === 1 ? "" : "s"}` : ""}. A firm quote comes back${shopFacts.when("quote-turnaround", (v) => ` within ${v},`)} from the engineer who will run the job.`,
      // "before then" only means something when a turnaround is stated.
      `If anything on the print needs a conversation first, you'll hear from us ${shopFacts.ok("quote-turnaround") ? "before then" : "about that first"}.`,
      ...(rfq.paperwork ? ["You asked for a first-article inspection report and a certificate of conformance. The price we quote will include them, and the quote will say so."] : []),
    ],
    items: rfqPartRows(rfq),
    facts: [["Reference", shortId(rfq.id)], ["Inspection paperwork", rfq.paperwork ? "First-article report and certificate of conformance requested" : ""]],
  });
}

/**
 * To the buyer of a replacement part with no drawing: the part is quoted from
 * the part itself, so this email carries the reference to write on the box and
 * the address to ship it to. `part` = { reference, shipTo: { name, lines } }.
 * The buyer pays to ship the part in; the original goes back with the finished
 * parts when they ticked the box, and the quoted price covers that return
 * (owner, 2026-11-11; shop-facts `part-return`). How soon a price follows is
 * said only once the owner has answered (`part-quote-time`).
 */
function partRequestBuyer({ rfq, part }) {
  const address = [part.shipTo.name, ...part.shipTo.lines].join(", ");
  const back = rfq.returnPart
    ? "You asked for the original back: we send it back with the finished parts, and the price we quote includes that return shipping."
    : "You did not ask for the original back, so we keep it with the job. Changed your mind? Reply to this email before you order and the price will cover sending it back.";
  return layout({
    subject: `${brand.name}: send us the part (reference ${part.reference})`,
    preheader: `Write ${part.reference} on the box. The ship-to address is inside.`,
    heading: "Now send us the part",
    paragraphs: [
      greeting(rfq.contactName),
      "Thanks. We have your request. The next step is yours: write the reference below on the box and ship the worn part to the address below. Shipping the part to us is at your cost.",
      `We measure the part and send you a price.${shopFacts.when("part-quote-time", (v) => ` ${v}`)} Nothing is ordered and nothing is charged until you say so.`,
    ],
    facts: [
      ["Reference (write it on the box)", part.reference],
      ["Ship the part to", address],
      ["Original part", rfq.returnPart ? "Returned with your order; return shipping is in the price we quote" : "Not being returned"],
      ["Inspection paperwork", rfq.paperwork ? "First-article report and certificate of conformance requested" : ""],
    ],
    after: [
      back,
      ...(rfq.paperwork ? ["You also asked for a first-article inspection report and a certificate of conformance. The price we quote will include them."] : []),
      `Questions, or a line that cannot run without the part? Call ${brand.phone}.`,
    ],
  });
}

/**
 * To the shop: a new request. The subject carries the reference and counts
 * only — never a name, company or note a visitor typed (subjects are where
 * injected text does the most harm, and where a mail client shows it first).
 *
 * `unverified` (the sender did not pass the bot check and is not a signed-in
 * account with a confirmed email): the notice says so at the top, and says
 * that no email went to the address they typed. `partPending`: a send-the-part
 * request whose sender has not been given the ship-to address yet.
 */
function rfqReceivedShop({ rfq, adminUrl, part, unverified = false, buyerEmailed = true, partPending = false }) {
  const parts = rfq.parts || [];
  const ref = shortId(rfq.id);
  const flag = unverified ? " [unverified sender]" : "";
  return layout({
    subject: part
      ? `RFQ: ${ref} — ${partPending ? "wants to send a part in" : "part being shipped in"}${flag}`
      : `RFQ: ${ref} — ${parts.length || "?"} part(s)${flag}`,
    preheader: unverified ? "Unverified sender: check the address before you reply." : `New RFQ ${ref}`,
    heading: unverified ? "New RFQ from an unverified sender" : `New RFQ from ${rfq.contactName}`,
    paragraphs: [
      ...(unverified ? [
        "UNVERIFIED SENDER: this request did not pass the bot check and did not come from a signed-in account with a confirmed email. No confirmation was emailed to the address below. Read it before you reply: the address may not belong to whoever typed it.",
      ] : []),
      ...(!unverified && !buyerEmailed ? ["No confirmation email went to this address (the daily limit for that address or connection was reached, or the account has not confirmed its email yet)."] : []),
      ...(partPending ? [`Send-the-part request: the sender was NOT given the ship-to address. If the request is real, reply with reference ${ref} and the address.`] : []),
      `${rfq.contactName} <${rfq.email}>${rfq.company ? " — " + rfq.company : ""}${rfq.phone ? " — " + rfq.phone : ""}`,
      ...(part && !partPending ? [`No drawing. The customer was told to write ${part.reference} on the box and ship the part to the shop at their cost. Measure it, then quote it from the RFQ queue.`] : []),
      ...(part && partPending ? ["No drawing: the customer wants to send the part in."] : []),
      ...(part && rfq.returnPart ? [RETURN_REMINDER] : []),
      ...(part && !rfq.returnPart ? ["Customer did not ask for the original back."] : []),
      ...(rfq.paperwork ? [PAPERWORK_REMINDER] : []),
      ...(rfq.reasons || []).length ? [`Why it's an RFQ: ${rfq.reasons.map((r) => r.message).join("; ")}`] : [],
      ...(rfq.notes ? [`Notes: ${rfq.notes}`] : []),
    ],
    facts: [
      ["Quantities", rfq.quantities || "(see parts)"],
      ["Tolerance", rfq.tolerance],
      ["Finish notes", rfq.finishNotes],
      ["Need by", rfq.dueDate],
      ["Drawing", rfq.drawingFileName || "none"],
      ["FAI + CoC", rfq.paperwork ? "YES — price it in" : "Not requested"],
      ["Original part back", part ? (rfq.returnPart ? "YES — price in the return shipping" : "No") : ""],
      ["Budgetary total shown", part ? "" : money(rfq.budgetTotal)],
      ["Sender", unverified ? "UNVERIFIED (no bot check, no confirmed account)" : ""],
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

/**
 * What a firm price covers besides the parts, in sentences: the inspection
 * paperwork (always stated, yes or no) and, for a part that was shipped in,
 * whether the original goes back. Used by the firm-quote email, the RFQ
 * response PDF and the customer's quote page so the three cannot disagree.
 */
function quoteCovers(rfq) {
  return [
    rfq.paperwork ? PAPERWORK_INCLUDED : PAPERWORK_NOT_INCLUDED,
    ...(isPartRequest(rfq) ? [rfq.returnPart ? RETURN_INCLUDED : RETURN_NOT_INCLUDED] : []),
  ];
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
      ...quoteCovers(rfq),
    ],
    items: rfqPartRows(rfq),
    facts: [
      ["Price", money(rfq.quotedTotal)],
      ["Inspection paperwork", rfq.paperwork ? "First-article report and certificate of conformance: included" : "Not requested, not included"],
      ["Original part", isPartRequest(rfq) ? (rfq.returnPart ? "Returned with your order: return shipping included" : "Not being returned") : ""],
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
    // Reference and amount only: the PO number, name and company are typed by the customer and stay in the body.
    subject: po
      ? `Quote ${shortId(rfq.id)} accepted on a purchase order — ${money(order.total)}`
      : `Quote ${shortId(rfq.id)} accepted, card checkout started — ${money(order.total)}`,
    preheader: `${money(order.total)} — ${po ? "PO " + order.poNumber : "paying by card"}`,
    heading: po ? "Quote accepted on a purchase order" : "Quote accepted",
    paragraphs: [
      `${rfq.contactName} <${rfq.email}>${rfq.company ? " — " + rfq.company : ""}${rfq.phone ? " — " + rfq.phone : ""}`,
      po
        ? "The customer accepted and gave a PO number. Nothing has been charged and no terms have been set up: confirm the PO with them before starting work."
        : "The customer accepted and was sent to card checkout. You'll get a separate email when the payment clears.",
      ...(rfq.paperwork ? [`${PAPERWORK_SHORT} ORDERED: the quoted price includes a first-article inspection report and a certificate of conformance. Do both before this ships.`] : []),
      ...(rfq.returnPart ? ["RETURN THE ORIGINAL: the customer's part goes back in the box with the finished parts. The quoted price includes that shipping."] : []),
    ],
    facts: [
      ["Quoted total", money(order.total)],
      [PAPERWORK_SHORT, rfq.paperwork ? "ORDERED (in the quoted price)" : "Not ordered"],
      ["Original part", isPartRequest(rfq) ? (rfq.returnPart ? "Return it with the order" : "Not being returned") : ""],
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
      ...(order.paperwork ? ["You ordered the inspection paperwork: the first piece of each part number is measured against your drawing, and the report ships with the parts, with a signed certificate of conformance listing material and lot."] : []),
      ...(order.returnPart ? ["Your original part comes back in the box with the finished parts."] : []),
    ],
    items: [...itemRows(items), ...chargeRows(order), ...discountRows(order)],
    total: { label: po ? "Order total" : "Total paid", value: money(po ? order.total : amountPaidOf(order)) },
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
    subject: `New order ${shortId(order.id)} — ${money(order.total)}${po ? " (purchase order)" : ""}`,
    preheader: `${order.customerName || order.shippingName || "Customer"} · ships by ${formatShipBy(order.shipBy)}`,
    heading: po ? "New order on a purchase order" : "New paid order",
    paragraphs: [
      `${order.customerName || order.shippingName || "Customer"}${order.customerEmail ? ` <${order.customerEmail}>` : ""}`,
      ...(warning ? [warning] : []),
      ...(order.drawingFileName ? [`Drawing attached to the order: ${order.drawingFileName}. Review it before cutting.`] : []),
      ...(order.paperwork ? [`${PAPERWORK_SHORT} ORDERED: measure the first piece of each part number against the drawing and write the first-article report, then fill in and sign the certificate of conformance with material and lot. Both ship with the parts.`] : []),
      ...(order.returnPart ? ["RETURN THE ORIGINAL: the customer's part goes back in the box with the finished parts."] : []),
    ],
    items: [...itemRows(items), ...chargeRows(order)],
    total: { label: "Total", value: money(order.total) },
    facts: [
      ["Order", shortId(order.id)],
      [PAPERWORK_SHORT, order.paperwork ? (Number(order.paperworkFee) > 0 ? `ORDERED (${money(order.paperworkFee)})` : "ORDERED (in the quoted price)") : "Not ordered"],
      ["Payment", po ? `PO ${order.poNumber} (not charged)` : discountOf(order) > 0 ? `Card, ${money(amountPaidOf(order))} collected` : "Card, paid"],
      ["Promotion code", discountOf(order) > 0 ? `${money(discountOf(order))} off the order total of ${money(order.total)}` : ""],
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

// ─── Account ───────────────────────────────────────────────────
// These go to an address somebody typed into a form, so they carry no typed
// text at all: no name, no company, nothing but our own words and one link.

/** Confirm the address on a new account. */
function verifyEmail({ verifyUrl }) {
  return layout({
    subject: `${brand.name}: confirm your email address`,
    preheader: "One click and your account is ready to check out.",
    heading: "Confirm your email address",
    paragraphs: [
      "Hello,",
      `Someone, we hope you, created a ${brand.name} account with this address. Confirm it and the account can check out and get order emails.`,
    ],
    cta: { label: "Confirm my email", url: verifyUrl },
    after: [
      "The link works once and for 24 hours. You can ask for a new one from the checkout page.",
      `Not you? Do nothing and the account stays unconfirmed. Questions: ${brand.phone}.`,
    ],
  });
}

/** A password reset was asked for. */
function passwordResetRequested({ resetUrl }) {
  return layout({
    subject: `${brand.name}: reset your password`,
    preheader: "The link works once and for one hour.",
    heading: "Reset your password",
    paragraphs: [
      "Hello,",
      `We were asked to reset the password on the ${brand.name} account for this address.`,
    ],
    cta: { label: "Choose a new password", url: resetUrl },
    after: [
      "The link works once and for one hour. Choosing a new password signs the account out everywhere else.",
      `Didn't ask for this? Do nothing: your password stays as it is. If it keeps happening, call ${brand.phone}.`,
    ],
  });
}

/** The password was changed. */
function passwordChanged({ when }) {
  return layout({
    subject: `${brand.name}: your password was changed`,
    preheader: "If this was you, nothing to do.",
    heading: "Your password was changed",
    paragraphs: [
      "Hello,",
      `The password on your ${brand.name} account was changed${when ? ` on ${longDate(when)}` : ""}. Every device that was signed in has been signed out.`,
    ],
    after: [
      `If this was you, there is nothing to do. If it wasn't, call ${brand.phone} now and we'll lock the account.`,
    ],
  });
}

/** Too many wrong passwords: sign-in is paused for a while. */
function accountLocked({ minutes, resetUrl }) {
  return layout({
    subject: `${brand.name}: sign-in paused on your account`,
    preheader: `Too many wrong passwords. Sign-in is paused for ${minutes} minutes.`,
    heading: "Sign-in is paused on your account",
    paragraphs: [
      "Hello,",
      `Someone entered the wrong password for your ${brand.name} account several times in a row, so sign-in is paused for ${minutes} minutes. Nobody got in.`,
      "If that was you, wait it out or choose a new password now. Choosing a new password lifts the pause at once.",
    ],
    cta: resetUrl ? { label: "Choose a new password", url: resetUrl } : undefined,
    after: [
      `If it wasn't you, your password held. Make sure it is one you use nowhere else. Questions: ${brand.phone}.`,
    ],
  });
}

/**
 * Many wrong passwords were tried on the account from browsers that have never signed in to it.
 * Nothing is paused for the owner (review 2026-11-11, F4), so this says what happened and what to do.
 */
function signInAttempts({ resetUrl }) {
  return layout({
    subject: `${brand.name}: wrong passwords tried on your account`,
    preheader: "Someone tried several wrong passwords. Nobody got in.",
    heading: "Wrong passwords were tried on your account",
    paragraphs: [
      "Hello,",
      `Someone entered the wrong password for your ${brand.name} account a number of times. Nobody got in.`,
      "You can still sign in as usual from a browser you have used before. If you have forgotten the password, choose a new one with the button below.",
    ],
    cta: resetUrl ? { label: "Choose a new password", url: resetUrl } : undefined,
    after: [
      `If it wasn't you, your password held. Make sure it is one you use nowhere else. Questions: ${brand.phone}.`,
    ],
  });
}

/** Two-step sign-in was switched on or off, or new recovery codes were made. */
function twoFactorChanged({ change }) {
  const what = {
    enabled: ["Two-step sign-in is on", "Two-step sign-in was switched on for your account. From now on, signing in takes your password and a code from your authenticator app."],
    disabled: ["Two-step sign-in is off", "Two-step sign-in was switched off for your account. Signing in now takes only your password."],
    "recovery-codes": ["New recovery codes were made", "New recovery codes were made for your account. The old ones no longer work."],
    "recovery-used": ["A recovery code was used to sign in", "A recovery code was used to sign in to your account in place of an authenticator code. That code is now spent."],
  }[change] || ["Your sign-in settings changed", "The sign-in settings on your account were changed."];
  return layout({
    subject: `${brand.name}: ${what[0].charAt(0).toLowerCase()}${what[0].slice(1)}`,
    preheader: what[0],
    heading: what[0],
    paragraphs: ["Hello,", what[1]],
    after: [`If this was you, there is nothing to do. If it wasn't, call ${brand.phone} now.`],
  });
}

// Every message carries the name of its template (`template`), which is all
// the mailer writes to the log about it.
const MESSAGES = {
  verifyEmail, passwordResetRequested, passwordChanged, accountLocked, signInAttempts, twoFactorChanged,
  rfqReceivedBuyer, partRequestBuyer, rfqReceivedShop, rfqQuoted, rfqAcceptedShop,
  orderConfirmation, newOrderShop, orderShipped,
};
const named = {};
for (const [name, build] of Object.entries(MESSAGES)) {
  named[name] = (...args) => {
    const message = build(...args);
    return { ...message, template: message.template || name };
  };
}

module.exports = {
  ...named,
  esc, safeHref, greeting,
  layout, trackingUrl, shortId, money, DRAWING_NOTE,
  PAPERWORK_LABEL, PAPERWORK_SHORT, PAPERWORK_INCLUDED, PAPERWORK_NOT_INCLUDED, RETURN_INCLUDED, RETURN_NOT_INCLUDED, RETURN_REMINDER, PAPERWORK_REMINDER,
  chargeRows, quoteCovers, isPartRequest, discountOf, amountPaidOf,
};
