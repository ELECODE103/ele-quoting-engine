/**
 * Customer-facing documents as PDFs: quote / RFQ response, order confirmation, packing slip,
 * Certificate of Conformance, and a blank First Article Inspection report form. The last two are
 * made for an order when the customer asked for them (order.paperwork); the quote, the order
 * confirmation and the packing slip each say whether they were ordered.
 *
 * Built with PDFKit (already a dependency) and its built-in Helvetica, so nothing is fetched or
 * embedded and the files print the same on any black laser: one colour, hairline rules, no
 * filled panels. The lockup is drawn from shared/brand-mark.json (the outlines the site uses,
 * written by scripts/brand/kit.js); every company fact comes from shared/brand.json; every
 * customer fact comes from the records passed in.
 *
 * Each builder returns a Promise<Buffer>.
 */
const PDFDocument = require("pdfkit");
// Company facts, plus the ship-from street address (server-side only; see config/shipFrom.json).
const brand = { ...require("../../shared/brand.json"), ...(({ _note, ...a }) => a)(require("../config/shipFrom.json")) };
const art = require("../../shared/brand-mark.json");
const shopFacts = require("../shopFacts");
// The legal name prints only once the owner has confirmed it (shared/shop-facts.json); until then the trading name.
const businessName = () => shopFacts.businessName(brand);

const PAGE = { w: 612, h: 792, m: 54 };          // US Letter, 0.75 in margins
const INNER = PAGE.w - 2 * PAGE.m;
const BLACK = "#000000";
const DIM = "#444444";                           // prints as a clean dark gray on a laser
const RULE = "#999999";
const QUOTE_VALID_DAYS = 30;                     // the site says firm quotes hold for 30 days
const PT_PER_MM = 72 / 25.4;
// Inspection paperwork is an option the customer asks for (owner, 2026-11-11). The wording is the
// emails' wording, so a document and the message it rides with cannot disagree.
const { PAPERWORK_LABEL, quoteCovers } = require("../emails/templates");

// ─── small helpers ──────────────────────────────────────────────────────────
// Helvetica is WinAnsi-encoded: keep what it can print, replace what it cannot.
const SWAPS = { "≤": "<=", "≥": ">=", "≈": "~", "⌀": "dia. ", "→": "->", "✓": "x", "‑": "-", " ": " ", " ": " " };
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function clean(v) {
  if (v === null || v === undefined) return "";
  let out = "";
  for (const ch of String(v)) {
    const c = ch.codePointAt(0);
    if (SWAPS[ch] !== undefined) out += SWAPS[ch];
    else if (ch === "\n" || (c >= 32 && c <= 126) || (c >= 161 && c <= 255) || WINANSI_EXTRA.includes(ch)) out += ch;
    else if (c < 32 || c === 127) out += " ";
    else out += "?";
  }
  return out;
}
const money = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
function fmtDate(d) {
  const dt = d ? new Date(d) : new Date();
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Chicago" });
}
function addDays(d, n) { const dt = d ? new Date(d) : new Date(); return new Date(dt.getTime() + n * 86400000); }
/** Human document number from a record id: docNumber("Q", "3f9a12cd-…") → "Q-3F9A12CD". */
function docNumber(prefix, id) {
  const core = String(id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${prefix}-${core || "DRAFT"}`;
}
const PROCESS_LABELS = { cnc: "CNC machining", milling: "CNC milling", turning: "CNC turning", routing: "CNC routing", "3d-printing": "3D printing", "3d_printing": "3D printing", "3d": "3D printing", sheetmetal: "Sheet metal" };
const ACRONYMS = new Set(["uhmw", "hdpe", "ldpe", "petg", "pet", "pla", "abs", "asa", "peek", "ptfe", "pvc", "pom", "pc", "pp", "tpu", "pei", "sla", "fdm", "cnc", "ups", "usps", "ltl", "rfq", "po"]);
const titleFromSlug = (s) => {
  const words = String(s || "").replace(/[-_]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  if (!words.length) return "";
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ");
};
function processLabel(item) {
  const sub = item.subProcess || item.config?.subProcess || item.meta?.subProcess;
  const p = item.process || item.config?.process || item.meta?.process;
  if (p === "cnc" && PROCESS_LABELS[sub]) return PROCESS_LABELS[sub];
  return PROCESS_LABELS[p] || titleFromSlug(p);
}
/** One description line for a line item: process · material · finish. */
function describe(item) {
  const meta = item.meta || item.config || {};
  const material = item.materialName || meta.materialName || titleFromSlug(item.materialSlug || meta.materialSlug);
  const grade = shopFacts.gradeLabel(item.grade || meta.grade);
  const finishSlug = item.finishSlug || meta.finishSlug;
  const finish = item.finishName || meta.finishName || (finishSlug && finishSlug !== "raw" && finishSlug !== "none" ? titleFromSlug(finishSlug) : "");
  const thick = item.thicknessMm || meta.thicknessMm;
  return [processLabel(item), [material, grade && !String(material).includes(grade) ? grade : ""].filter(Boolean).join(" "), thick ? `${thick} mm` : "", finish].filter(Boolean).join(" · ");
}
const companyLine = () => [businessName(), [brand.address, `${brand.city}, ${brand.state}`, brand.zip].filter(Boolean).join(" "), brand.phone, brand.email, brand.domain].filter(Boolean).join("  ·  ");

// ─── document frame ─────────────────────────────────────────────────────────
function create({ title, number, subject }) {
  const doc = new PDFDocument({ size: "LETTER", margin: 0, bufferPages: true, autoFirstPage: true,
    info: { Title: `${title} ${number} - ${brand.name}`, Author: businessName(), Subject: subject || title, Creator: brand.domain } });
  doc._se = { title, number };
  return doc;
}
function finish(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const y = PAGE.h - 40;
      doc.moveTo(PAGE.m, y - 6).lineTo(PAGE.w - PAGE.m, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(DIM);
      doc.text(clean(`${businessName()}  ·  ${brand.domain}`), PAGE.m, y, { lineBreak: false });
      doc.text(clean(`${doc._se.title} ${doc._se.number}  ·  Page ${i + 1} of ${range.count}`), PAGE.m, y, { width: INNER, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
/** The compact lockup in one colour. `side` is the square's side in points. */
function drawLockup(doc, x, y, side) {
  const k = side / art.lockup.square;
  const stepped = side >= art.mark.steppedMinMm * PT_PER_MM;       // the stair needs 8.5 mm
  doc.save().translate(x, y).scale((k * art.lockup.square) / art.mark.size).path(stepped ? art.mark.stepped : art.mark.solid).fill(BLACK).restore();
  doc.save().translate(x + (art.lockup.square + art.lockup.gap) * k, y + art.lockup.baseline * k).scale(k).path(art.word.d).fill(BLACK).restore();
  return (art.lockup.square + art.lockup.gap + art.word.width) * k;
}
function header(doc) {
  const { title, number } = doc._se;
  const y0 = PAGE.m;
  // 20 pt (7 mm) square: under the stair's 8.5 mm minimum, so drawLockup uses the solid mark.
  const lw = drawLockup(doc, PAGE.m, y0 + 2, 20);
  const t = clean(title.toUpperCase());
  let size = 14;
  doc.font("Helvetica-Bold");
  while (size > 9 && doc.fontSize(size).widthOfString(t, { characterSpacing: 0.6 }) > INNER - lw - 28) size -= 0.5;
  doc.fontSize(size).fillColor(BLACK).text(t, PAGE.m, y0 + 14 - size, { width: INNER, align: "right", characterSpacing: 0.6, lineBreak: false });
  doc.font("Helvetica").fontSize(9).fillColor(BLACK).text(clean(`No. ${number}`), PAGE.m, y0 + 17, { width: INNER, align: "right", lineBreak: false });
  const yr = y0 + 34;
  doc.moveTo(PAGE.m, yr).lineTo(PAGE.w - PAGE.m, yr).lineWidth(1).strokeColor(BLACK).stroke();
  doc.font("Helvetica").fontSize(7.5).fillColor(DIM).text(clean(companyLine()), PAGE.m, yr + 5, { width: INNER, lineBreak: false });
  return yr + 26;
}
/** Slim header for continuation pages. */
function contHeader(doc) {
  drawLockup(doc, PAGE.m, PAGE.m, 14);
  doc.font("Helvetica").fontSize(8).fillColor(DIM).text(clean(`${doc._se.title} ${doc._se.number} — continued`), PAGE.m, PAGE.m + 3, { width: INNER, align: "right", lineBreak: false });
  doc.moveTo(PAGE.m, PAGE.m + 20).lineTo(PAGE.w - PAGE.m, PAGE.m + 20).lineWidth(0.5).strokeColor(BLACK).stroke();
  return PAGE.m + 32;
}
const BOTTOM = PAGE.h - 62;
function ensure(doc, y, need) {
  if (y + need <= BOTTOM) return y;
  doc.addPage({ size: "LETTER", margin: 0 });
  return contHeader(doc);
}
const label = (doc, s, x, y, w) => doc.font("Helvetica-Bold").fontSize(6.8).fillColor(DIM).text(clean(s).toUpperCase(), x, y, { width: w, characterSpacing: 0.7, lineBreak: false });
/** A row of labelled facts (Date, Valid until …). Returns the y below it. */
function facts(doc, y, pairs) {
  const list = pairs.filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== "");
  if (!list.length) return y;
  const perRow = Math.min(list.length, 4), w = INNER / perRow;
  list.forEach(([k, v], i) => {
    const x = PAGE.m + (i % perRow) * w, yy = y + Math.floor(i / perRow) * 30;
    label(doc, k, x, yy, w - 8);
    doc.font("Helvetica").fontSize(9.5).fillColor(BLACK).text(clean(v), x, yy + 10, { width: w - 8, lineBreak: false, ellipsis: true });
  });
  return y + Math.ceil(list.length / perRow) * 30 + 4;
}
/** Side-by-side address / party blocks: [{ title, lines: [...] }]. */
function parties(doc, y, blocks) {
  const w = INNER / blocks.length;
  let bottom = y;
  blocks.forEach((b, i) => {
    const x = PAGE.m + i * w;
    label(doc, b.title, x, y, w - 12);
    const lines = (b.lines || []).map(clean).filter(Boolean);
    doc.font("Helvetica").fontSize(9.5).fillColor(BLACK);
    let yy = y + 11;
    if (!lines.length) { doc.fillColor(DIM).text("—", x, yy); yy += 12; }
    lines.forEach((ln, n) => {
      doc.font(n === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(BLACK);
      doc.text(ln, x, yy, { width: w - 12 });
      yy = doc.y + 1;
    });
    bottom = Math.max(bottom, yy);
  });
  return bottom + 12;
}
/**
 * A ruled table. columns: [{ key, label, w (fraction of width), align, bold }]; rows: objects.
 * A row may carry `_note` (small text under the row). No fills — rules only.
 */
function table(doc, y, columns, rows, { rowPad = 5, minRow = 0, fontSize = 9 } = {}) {
  const total = columns.reduce((s, c) => s + c.w, 0);
  const cols = columns.map((c) => ({ ...c, pw: (c.w / total) * INNER }));
  let x = PAGE.m;
  for (const c of cols) { c.x = x; x += c.pw; }
  const head = (yy) => {
    doc.moveTo(PAGE.m, yy).lineTo(PAGE.w - PAGE.m, yy).lineWidth(1).strokeColor(BLACK).stroke();
    for (const c of cols) doc.font("Helvetica-Bold").fontSize(6.8).fillColor(BLACK).text(clean(c.label).toUpperCase(), c.x + (c.align === "right" ? 0 : 2), yy + 6, { width: c.pw - 4, align: c.align || "left", characterSpacing: 0.6, lineBreak: false });
    doc.moveTo(PAGE.m, yy + 18).lineTo(PAGE.w - PAGE.m, yy + 18).lineWidth(0.5).strokeColor(BLACK).stroke();
    return yy + 18;
  };
  y = ensure(doc, y, 60);
  y = head(y);
  for (const row of rows) {
    doc.font("Helvetica").fontSize(fontSize);
    let h = 0;
    for (const c of cols) {
      doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      h = Math.max(h, doc.heightOfString(clean(row[c.key]) || " ", { width: c.pw - 6 }));
    }
    const noteH = row._note ? doc.font("Helvetica").fontSize(7.5).heightOfString(clean(row._note), { width: INNER - cols[0].pw - 6 }) + 3 : 0;
    const rh = Math.max(minRow, h + 2 * rowPad + noteH);
    if (y + rh > BOTTOM) { doc.addPage({ size: "LETTER", margin: 0 }); y = head(contHeader(doc)); }
    for (const c of cols) {
      doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor(BLACK);
      doc.text(clean(row[c.key]), c.x + (c.align === "right" ? 0 : 2), y + rowPad, { width: c.pw - 4, align: c.align || "left" });
    }
    if (row._note) doc.font("Helvetica").fontSize(7.5).fillColor(DIM).text(clean(row._note), cols[1].x + 2, y + rowPad + h + 2, { width: INNER - cols[0].pw - 6 });
    y += rh;
    doc.moveTo(PAGE.m, y).lineTo(PAGE.w - PAGE.m, y).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  doc.moveTo(PAGE.m, y).lineTo(PAGE.w - PAGE.m, y).lineWidth(0.5).strokeColor(BLACK).stroke();
  return y + 10;
}
function totals(doc, y, pairs) {
  const list = pairs.filter(Boolean);
  y = ensure(doc, y, list.length * 15 + 12);
  const x = PAGE.w - PAGE.m - 220;
  list.forEach(([k, v, strong]) => {
    if (strong) { doc.moveTo(x, y - 2).lineTo(PAGE.w - PAGE.m, y - 2).lineWidth(1).strokeColor(BLACK).stroke(); y += 3; }
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 11 : 9.5).fillColor(BLACK);
    doc.text(clean(k), x, y, { width: 110, lineBreak: false });
    doc.text(clean(v), x + 110, y, { width: 110, align: "right", lineBreak: false });
    y += strong ? 18 : 15;
  });
  return y + 6;
}
function paragraph(doc, y, heading, body, { size = 8.5 } = {}) {
  const text = clean(body);
  if (!text) return y;
  doc.font("Helvetica").fontSize(size);
  y = ensure(doc, y, doc.heightOfString(text, { width: INNER }) + 16);
  if (heading) { label(doc, heading, PAGE.m, y, INNER); y += 11; }
  doc.font("Helvetica").fontSize(size).fillColor(BLACK).text(text, PAGE.m, y, { width: INNER, lineGap: 1.5 });
  return doc.y + 10;
}
/** Blank signature / fill-in lines: [{ label, w }] laid out across the page. */
function signLines(doc, y, fields) {
  y = ensure(doc, y, 40);
  const total = fields.reduce((s, f) => s + (f.w || 1), 0), gap = 14;
  let x = PAGE.m;
  for (const f of fields) {
    const w = ((f.w || 1) / total) * (INNER - gap * (fields.length - 1));
    if (f.value) doc.font("Helvetica").fontSize(9.5).fillColor(BLACK).text(clean(f.value), x + 2, y + 8, { width: w - 4, lineBreak: false, ellipsis: true });
    doc.moveTo(x, y + 22).lineTo(x + w, y + 22).lineWidth(0.6).strokeColor(BLACK).stroke();
    label(doc, f.label, x, y + 26, w);
    x += w + gap;
  }
  return y + 44;
}
function checkbox(doc, x, y, text, checked = false) {
  doc.rect(x, y, 8, 8).lineWidth(0.7).strokeColor(BLACK).stroke();
  if (checked) doc.moveTo(x + 1.5, y + 4).lineTo(x + 3.5, y + 6.5).lineTo(x + 6.8, y + 1.5).lineWidth(1).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(BLACK).text(clean(text), x + 12, y + 0.5, { lineBreak: false });
  return x + 12 + doc.widthOfString(clean(text)) + 16;
}
/** A box with a small label in its top-left corner, for hand entry (value prints if given). */
function fieldBox(doc, x, y, w, h, name, value) {
  doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(BLACK).stroke();
  label(doc, name, x + 4, y + 4, w - 8);
  if (value) doc.font("Helvetica").fontSize(10).fillColor(BLACK).text(clean(value), x + 5, y + 15, { width: w - 10, height: h - 16, lineBreak: false, ellipsis: true });
}

// ─── shared data shaping ────────────────────────────────────────────────────
function shipTo(order) {
  return [order.shippingName, order.shippingCompany, order.shippingAddress,
    [[order.shippingCity, order.shippingState].filter(Boolean).join(", "), order.shippingZip].filter(Boolean).join(" "),
    order.shippingCountry && order.shippingCountry !== "US" ? order.shippingCountry : ""];
}
function customerLines(c) {
  if (!c) return [];
  return [c.company || c.name || c.contactName, c.company ? (c.name || c.contactName) : "", c.email, c.phone];
}
/** A ship-by day ("2026-11-17") as the emails print it; anything else as a plain date. */
const shipByText = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? require("./shipBy").formatShipBy(v) : fmtDate(v));
const shipFrom = () => [businessName(), brand.address, [`${brand.city}, ${brand.state}`, brand.zip].filter(Boolean).join(" "), brand.phone];
const partName = (item) => item.partNumber || item.fileName || item.partId || "";
const leadTimeLabel = (v) => (v && typeof v === "object" ? v.name || titleFromSlug(v.slug) : titleFromSlug(v));

// ─── 1 · Quote / RFQ response ───────────────────────────────────────────────
/**
 * @param {Object} p
 * @param {Object} p.quote     stored quote ({ id, lineItems[{ fileName, quantity, perUnit.final, lineTotal, meta }], subtotal, leadTimeSurcharge, shippingEstimate, orderTotal, leadTimeSlug, createdAt })
 * @param {Object} [p.customer] { name, company, email, phone }
 * @param {Object} [p.rfq]     stored RFQ; when given the document is titled "RFQ Response" and uses the RFQ's contact, parts and quotedTotal
 * @param {Object} [p.options] { leadTime, validDays, notes, terms, date }
 */
async function buildQuotePdf({ quote, customer, rfq, options = {} } = {}) {
  const src = quote || {};
  const isRfq = !!rfq;
  const id = isRfq ? rfq.id : src.id;
  const number = options.number || docNumber(isRfq ? "RFQ" : "Q", id);
  const doc = create({ title: isRfq ? "RFQ Response" : "Quote", number });
  const date = options.date || (isRfq ? rfq.quotedAt : src.createdAt) || new Date();
  const validDays = options.validDays || QUOTE_VALID_DAYS;
  let y = header(doc);
  y = facts(doc, y, [
    ["Date", fmtDate(date)],
    ["Valid until", fmtDate(isRfq && rfq.validUntil ? rfq.validUntil : addDays(date, validDays))],
    ["Lead time", isRfq && rfq.quotedLeadDays != null && !options.leadTime ? `${rfq.quotedLeadDays} business day${Number(rfq.quotedLeadDays) === 1 ? "" : "s"}` : leadTimeLabel(options.leadTime || src.leadTimeSlug)],
    isRfq ? ["Your reference", rfq.reference || (src.id ? docNumber("Q", src.id) : "")] : ["Currency", "USD"],
  ]);
  const who = customer || (isRfq ? { name: rfq.contactName, company: rfq.company, email: rfq.email, phone: rfq.phone } : null);
  y = parties(doc, y, [{ title: "Prepared for", lines: customerLines(who) }, { title: "From", lines: [businessName(), `${brand.city}, ${brand.state}`, brand.email, brand.phone] }]);

  // An RFQ response carries the firm price, not the budgetary numbers the buyer saw online:
  // one part gets the quoted total on its line, several parts get quantities only.
  const firm = isRfq && Number(rfq.quotedTotal) > 0 ? Number(rfq.quotedTotal) : null;
  const items = isRfq && (!src.lineItems || !src.lineItems.length)
    ? (rfq.parts || []).map((p, i, all) => {
      const quantity = p.quotedQuantity || p.quantity;
      if (firm === null) return { ...p, quantity, perUnit: { final: p.budgetUnit }, lineTotal: p.budgetLine };
      return all.length === 1 ? { ...p, quantity, perUnit: { final: firm / (quantity || 1) }, lineTotal: firm } : { ...p, quantity, perUnit: {}, lineTotal: undefined };
    })
    : (src.lineItems || []);
  const rows = items.map((li, i) => {
    const unit = li.perUnit?.final ?? li.unitPrice;
    const breaks = (li.quantityBreaks || []).filter((b) => b.qty !== li.quantity).map((b) => `${b.qty}: ${money(b.perUnit)}`);
    return {
      n: String(i + 1), part: partName(li), desc: describe(li), qty: String(li.quantity ?? ""),
      unit: unit != null && Number.isFinite(Number(unit)) ? money(unit) : "", ext: li.lineTotal != null && Number.isFinite(Number(li.lineTotal)) ? money(li.lineTotal) : "",
      _note: breaks.length ? `Price each at other quantities — ${breaks.join("   ")}` : "",
    };
  });
  y = table(doc, y, [
    { key: "n", label: "Line", w: 5 }, { key: "part", label: "Part / file", w: 27, bold: true }, { key: "desc", label: "Process · material · finish", w: 32 },
    { key: "qty", label: "Qty", w: 8, align: "right" }, { key: "unit", label: "Unit price", w: 13, align: "right" }, { key: "ext", label: "Extended", w: 15, align: "right" },
  ], rows);

  const quotedTotal = firm;
  y = totals(doc, y, quotedTotal !== null
    ? [["Quoted total", money(quotedTotal), true]]
    : [
      ["Subtotal", money(src.subtotal)],
      Number(src.leadTimeSurcharge) > 0 ? ["Expedite", money(src.leadTimeSurcharge)] : null,
      src.paperwork ? ["Inspection paperwork", money(src.paperworkFee)] : null,
      Number.isFinite(Number(src.shippingEstimate)) ? ["Shipping (estimate)", money(src.shippingEstimate)] : null,
      ["Total", money(src.orderTotal ?? src.subtotal), true],
    ]);
  if (isRfq) {
    y = facts(doc, y, [["Quantities requested", rfq.quantities], ["Tolerance", rfq.tolerance], ["Finish", rfq.finishNotes], ["Needed by", rfq.dueDate]]);
    // A firm price always says whether it covers the inspection paperwork and, for a part that
    // was shipped in to be measured, whether the original goes back.
    y = paragraph(doc, y, "This price covers", quoteCovers(rfq).join(" "));
  } else {
    y = paragraph(doc, y, "Inspection paperwork", src.paperwork
      ? `${PAPERWORK_LABEL}: ordered. The first piece of each part number is measured against your drawing and the report ships with the parts, with a signed certificate of conformance listing material and lot.`
      : `${PAPERWORK_LABEL}: not ordered, so not in this price. Both can be added to the quote before you order.`);
  }
  y = paragraph(doc, y, "Notes", options.notes || (isRfq ? rfq.quoteNote : ""));
  y = paragraph(doc, y, "Terms", options.terms || `Prices are in US dollars and hold for ${validDays} days from the date above. This quote covers the files, materials and quantities listed; a change to any of them is re-quoted. To order or ask a question: ${brand.email} or ${brand.phone}.`);
  return finish(doc);
}

// ─── 2 · Order confirmation ─────────────────────────────────────────────────
async function buildOrderConfirmationPdf({ order, items = [], customer, options = {} } = {}) {
  const number = options.number || docNumber("SO", order.id);
  const doc = create({ title: "Order Confirmation", number });
  let y = header(doc);
  y = facts(doc, y, [
    ["Order date", fmtDate(order.createdAt)],
    ["Your PO", order.poNumber],
    ["Quote", order.quoteId ? docNumber("Q", order.quoteId) : ""],
    ["Lead time", order.leadTimeName],
    ["Ships by", options.shipBy || order.shipBy ? shipByText(options.shipBy || order.shipBy) : ""],
    ["Status", titleFromSlug(order.status)],
  ]);
  // Orders taken from a firm quote have no account: fall back to the contact stored on the order.
  const orderedBy = customer || (order.customerName || order.customerEmail ? { name: order.customerName, email: order.customerEmail } : null);
  y = parties(doc, y, [{ title: "Ordered by", lines: customerLines(orderedBy) }, { title: "Ship to", lines: shipTo(order) }]);
  const rows = items.map((it, i) => ({ n: String(i + 1), part: partName(it), desc: describe(it), qty: String(it.quantity ?? ""), unit: money(it.unitPrice), ext: money(it.lineTotal) }));
  y = table(doc, y, [
    { key: "n", label: "Line", w: 5 }, { key: "part", label: "Part / file", w: 27, bold: true }, { key: "desc", label: "Process · material · finish", w: 32 },
    { key: "qty", label: "Qty", w: 8, align: "right" }, { key: "unit", label: "Unit price", w: 13, align: "right" }, { key: "ext", label: "Extended", w: 15, align: "right" },
  ], rows);
  y = totals(doc, y, [
    ["Subtotal", money(order.subtotal)],
    Number(order.leadTimeSurcharge) > 0 ? [`${order.leadTimeName || "Faster"} lead time`, money(order.leadTimeSurcharge)] : null,
    order.paperwork ? ["Inspection paperwork", Number(order.paperworkFee) > 0 ? money(order.paperworkFee) : "Included"] : null,
    Number(order.shippingCost) > 0 ? ["Shipping", money(order.shippingCost)] : null,
    Number(order.tax) > 0 ? ["Sales tax", money(order.tax)] : null,
    ["Order total", money(order.total), true],
  ]);
  y = paragraph(doc, y, "Inspection paperwork", order.paperwork
    ? `${PAPERWORK_LABEL}: ordered${Number(order.paperworkFee) > 0 ? "" : ", included in the quoted price"}. The first piece of each part number is measured against your drawing and the report ships with the parts, with a signed certificate of conformance listing material and lot.`
    : `${PAPERWORK_LABEL}: not ordered.`);
  if (order.returnPart) y = paragraph(doc, y, "Your original part", "Returned to you in the box with the finished parts. Return shipping is included in the quoted price.");
  // The buyer's own notes. `order.notes` is the shop's internal note and never prints on a customer document.
  // (On an order taken from a firm quote that field holds the note the quote carried.)
  y = paragraph(doc, y, order.rfqId ? "Quote notes" : "Your notes", order.customerNotes);
  y = paragraph(doc, y, null, options.closing || `Please check the parts, quantities and ship-to address above and tell us about anything that is wrong before we cut material: ${brand.email} or ${brand.phone}. Please give order number ${number} in any message about this order.`);
  return finish(doc);
}

// ─── 3 · Packing slip ───────────────────────────────────────────────────────
async function buildPackingSlipPdf({ order, items = [], customer, options = {} } = {}) {
  const number = options.number || docNumber("PS", order.id);
  const doc = create({ title: "Packing Slip", number });
  let y = header(doc);
  y = facts(doc, y, [
    ["Order", docNumber("SO", order.id)],
    ["Your PO", order.poNumber],
    ["Ship date", fmtDate(options.shipDate || order.shippedAt || new Date())],
    ["Ship via", [titleFromSlug(order.shippingMethod), order.trackingNumber].filter(Boolean).join(" · ")],
  ]);
  y = parties(doc, y, [{ title: "Ship to", lines: shipTo(order) }, { title: "Ship from", lines: shipFrom() }]);
  const shipped = options.shipped || {};   // { [itemId]: qtyShipped } for partial shipments
  const rows = items.map((it, i) => {
    const s = shipped[it.id] ?? it.quantityShipped ?? it.quantity;
    const bo = Number(it.quantity) - Number(s);
    return { n: String(i + 1), part: partName(it), desc: describe(it), ord: String(it.quantity ?? ""), ship: String(s ?? ""), bo: bo > 0 ? String(bo) : "—" };
  });
  y = table(doc, y, [
    { key: "n", label: "Line", w: 5 }, { key: "part", label: "Part / file", w: 30, bold: true }, { key: "desc", label: "Description", w: 35 },
    { key: "ord", label: "Ordered", w: 10, align: "right" }, { key: "ship", label: "Shipped", w: 10, align: "right" }, { key: "bo", label: "Back order", w: 13, align: "right" },
  ], rows, { rowPad: 7 });
  // What is in the box besides the parts: only what was ordered. Tick boxes for the packer.
  if (order.paperwork || order.returnPart) {
    y = ensure(doc, y, 20 + (order.paperwork ? 30 : 0) + (order.returnPart ? 16 : 0));
    label(doc, "Also in this shipment", PAGE.m, y, INNER);
    y += 12;
    if (order.paperwork) {
      checkbox(doc, PAGE.m, y, `First-article inspection report (ordered): ${items.length} part number${items.length === 1 ? "" : "s"}`); y += 15;
      checkbox(doc, PAGE.m, y, "Certificate of conformance (ordered), signed, with material and lot"); y += 15;
    }
    if (order.returnPart) { checkbox(doc, PAGE.m, y, "Customer's original part, returned"); y += 15; }
    y += 4;
  }
  y = signLines(doc, y + 6, [{ label: "Packed by" }, { label: "Checked by" }, { label: "Cartons", w: 0.5 }, { label: "Date", w: 0.7 }]);
  y = paragraph(doc, y, null, options.closing || `Count and inspect on receipt. If anything is short, damaged or not to print, tell us right away so we can put it right: ${brand.email} or ${brand.phone}.`);
  return finish(doc);
}

// ─── 4 · Certificate of Conformance ─────────────────────────────────────────
/**
 * options.lots: { [itemId]: "lot / heat" }; options.revs: { [itemId]: "B" }; options.exceptions: string;
 * options.statement overrides the certification wording; options.signer: { name, title }.
 */
async function buildCocPdf({ order, items = [], customer, options = {} } = {}) {
  const number = options.number || docNumber("COC", order.id);
  const doc = create({ title: "Certificate of Conformance", number });
  let y = header(doc);
  y = facts(doc, y, [
    ["Date", fmtDate(options.date || new Date())],
    ["Order", docNumber("SO", order.id)],
    ["Customer PO", order.poNumber || options.poNumber],
    ["Ship date", options.shipDate || order.shippedAt ? fmtDate(options.shipDate || order.shippedAt) : ""],
  ]);
  y = parties(doc, y, [{ title: "Customer", lines: customerLines(customer).length ? customerLines(customer) : shipTo(order) }, { title: "Manufacturer", lines: shipFrom().concat(brand.email) }]);
  const lots = options.lots || {}, revs = options.revs || {};
  const rows = items.map((it, i) => {
    const meta = it.config || it.meta || {};
    const material = [it.materialName || meta.materialName || titleFromSlug(it.materialSlug || meta.materialSlug), meta.grade].filter(Boolean).join(" ");
    return { n: String(i + 1), part: partName(it), rev: revs[it.id] || it.revision || "", mat: material, qty: String(it.quantity ?? ""), lot: lots[it.id] || it.materialLot || "" };
  });
  y = table(doc, y, [
    { key: "n", label: "Line", w: 5 }, { key: "part", label: "Part number / file", w: 31, bold: true }, { key: "rev", label: "Rev", w: 7 },
    { key: "mat", label: "Material", w: 27 }, { key: "qty", label: "Qty", w: 8, align: "right" }, { key: "lot", label: "Material lot / heat", w: 22 },
  ], rows, { rowPad: 7 });
  y = paragraph(doc, y + 4, "Certification", options.statement || `${businessName()} certifies that the parts listed above were made and inspected to the drawings, models, specifications and purchase order requirements supplied by the customer, and that they conform to those requirements except as noted below.`, { size: 9.5 });
  y = ensure(doc, y, 110);
  label(doc, "Material certification", PAGE.m, y, INNER);
  let x = checkbox(doc, PAGE.m, y + 12, "Attached", options.materialCert === "attached");
  x = checkbox(doc, x, y + 12, "On file, available on request", options.materialCert === "on-file");
  checkbox(doc, x, y + 12, "Not requested", options.materialCert === "not-requested");
  y += 34;
  label(doc, "Exceptions / deviations", PAGE.m, y, INNER);
  if (options.exceptions) { doc.font("Helvetica").fontSize(9.5).fillColor(BLACK).text(clean(options.exceptions), PAGE.m, y + 11, { width: INNER }); y = doc.y + 8; }
  else { for (let i = 1; i <= 2; i++) doc.moveTo(PAGE.m, y + 11 + i * 17).lineTo(PAGE.w - PAGE.m, y + 11 + i * 17).lineWidth(0.4).strokeColor(RULE).stroke(); y += 56; }
  const signer = options.signer || {};
  y = signLines(doc, y + 6, [{ label: "Authorized signature", w: 1.4 }, { label: "Name and title", value: [signer.name, signer.title].filter(Boolean).join(", "), w: 1.4 }, { label: "Date", w: 0.7 }]);
  return finish(doc);
}

// ─── 5 · First Article Inspection report (form) ─────────────────────────────
/**
 * A form to fill in by hand at the surface plate. Everything is optional: with no arguments
 * it is blank. part: { partNumber, partName, revision, drawing, material, lot, customer, po, order, lotQty };
 * dimensions: [{ char, nominal, tol, actual, method, pass }] pre-fills rows; rows = total row count.
 */
async function buildFaiPdf({ part = {}, dimensions = [], rows, options = {} } = {}) {
  const number = options.number || (part.id ? docNumber("FAI", part.id) : "FAI-________");
  const doc = create({ title: "First Article Inspection Report", number });
  let y = header(doc);
  const h = 30, q = INNER / 4;
  const grid = [
    [["Part number", part.partNumber, 2], ["Revision", part.revision, 1], ["Drawing no.", part.drawing, 1]],
    [["Part name / description", part.partName, 2], ["Material", part.material, 2]],
    [["Customer", part.customer, 2], ["Customer PO", part.po, 1], ["Order no.", part.order, 1]],
    [["Material lot / heat", part.lot, 1], ["Lot quantity", part.lotQty, 1], ["Pieces inspected", part.inspected, 1], ["Serial / piece ID", part.serial, 1]],
  ];
  for (const row of grid) {
    let x = PAGE.m;
    for (const [name, value, span] of row) { fieldBox(doc, x, y, q * span, h, name, value); x += q * span; }
    y += h;
  }
  y += 10;
  let x = PAGE.m;
  label(doc, "Units", x, y + 1.5, 40); x += 36;
  x = checkbox(doc, x, y, "inch") + 0; x = checkbox(doc, x, y, "mm") + 14;
  label(doc, "FAI type", x, y + 1.5, 60); x += 50;
  x = checkbox(doc, x, y, "Full"); x = checkbox(doc, x, y, "Partial"); checkbox(doc, x, y, "Re-inspection after change");
  y += 20;

  // dimension table
  const cols = [
    { label: "No.", w: 5, key: "n", align: "center" }, { label: "Characteristic / zone", w: 27, key: "char" }, { label: "Nominal", w: 11, key: "nominal", align: "center" },
    { label: "Tolerance", w: 12, key: "tol", align: "center" }, { label: "Actual", w: 12, key: "actual", align: "center" }, { label: "Gage / method", w: 19, key: "method" },
    { label: "Pass", w: 7, key: "pass", align: "center" }, { label: "Fail", w: 7, key: "fail", align: "center" },
  ];
  const total = cols.reduce((s, c) => s + c.w, 0);
  let cx = PAGE.m;
  for (const c of cols) { c.x = cx; c.pw = (c.w / total) * INNER; cx += c.pw; }
  const RH = 18, HH = 18;
  const footerBlock = 112;                           // disposition + notes + signatures
  const count = rows || Math.max(dimensions.length, Math.floor((BOTTOM - footerBlock - y - HH) / RH));
  const drawHead = (yy) => {
    doc.rect(PAGE.m, yy, INNER, HH).lineWidth(1).strokeColor(BLACK).stroke();
    for (const c of cols) doc.font("Helvetica-Bold").fontSize(6.8).fillColor(BLACK).text(c.label.toUpperCase(), c.x + 3, yy + 6, { width: c.pw - 6, align: c.align || "left", characterSpacing: 0.5, lineBreak: false });
    return yy + HH;
  };
  let top = y;
  y = drawHead(y);
  const closeGrid = (from, to) => { for (const c of cols.slice(1)) doc.moveTo(c.x, from).lineTo(c.x, to).lineWidth(0.5).strokeColor(BLACK).stroke(); doc.rect(PAGE.m, from, INNER, to - from).lineWidth(0.8).strokeColor(BLACK).stroke(); };
  for (let i = 0; i < count; i++) {
    if (y + RH > BOTTOM) { closeGrid(top, y); doc.addPage({ size: "LETTER", margin: 0 }); top = contHeader(doc); y = drawHead(top); }
    const d = dimensions[i] || {};
    const cell = { n: String(i + 1), char: d.char, nominal: d.nominal, tol: d.tol, actual: d.actual, method: d.method, pass: d.pass === true ? "X" : "", fail: d.pass === false ? "X" : "" };
    for (const c of cols) {
      const v = clean(cell[c.key]);
      if (v) doc.font("Helvetica").fontSize(c.key === "n" ? 8 : 9).fillColor(c.key === "n" ? DIM : BLACK).text(v, c.x + 3, y + 6, { width: c.pw - 6, align: c.align || "left", lineBreak: false, ellipsis: true });
    }
    y += RH;
    doc.moveTo(PAGE.m, y).lineTo(PAGE.w - PAGE.m, y).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  closeGrid(top, y);
  y += 12;
  y = ensure(doc, y, footerBlock - 14);
  x = PAGE.m;
  label(doc, "Disposition", x, y + 1.5, 70); x += 62;
  x = checkbox(doc, x, y, "Accept"); x = checkbox(doc, x, y, "Reject"); checkbox(doc, x, y, "Accept with deviation (describe below)");
  y += 18;
  label(doc, "Notes / deviations / gages and calibration IDs", PAGE.m, y, INNER);
  for (let i = 1; i <= 2; i++) doc.moveTo(PAGE.m, y + 10 + i * 17).lineTo(PAGE.w - PAGE.m, y + 10 + i * 17).lineWidth(0.4).strokeColor(RULE).stroke();
  y += 52;
  signLines(doc, y, [{ label: "Inspector (print)", value: options.inspector }, { label: "Signature" }, { label: "Date", w: 0.6 }, { label: "Reviewed by", w: 0.9 }]);
  return finish(doc);
}

module.exports = {
  buildQuotePdf,
  buildOrderConfirmationPdf,
  buildPackingSlipPdf,
  buildCocPdf,
  buildFaiPdf,
  docNumber,
  QUOTE_VALID_DAYS,
  _internal: { clean, describe, money },
};
