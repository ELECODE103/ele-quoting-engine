/**
 * PDF Generation Service
 * Uses PDFKit to generate professional job travelers and packing lists
 */
const PDFDocument = require("pdfkit");
const brand = { ...require("../../shared/brand.json"), ...(({ _note, ...a }) => a)(require("../config/shipFrom.json")) };
const shopFacts = require("../shopFacts");
// The full description of an order line and the one-line layout of typed text are the customer
// documents' own (services/documents.js), so the traveler and the confirmation cannot disagree.
const { specOf, oneLine } = require("./documents");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Add a header section to the PDF
 */
function addHeader(doc, title, subtitle = "") {
  const pageWidth = doc.page.width;
  const margin = 50;

  // Title
  doc
    .fontSize(28)
    .font("Helvetica-Bold")
    .text(title, margin, margin, {
      width: pageWidth - 2 * margin,
      align: "left",
    });

  // Subtitle if provided
  if (subtitle) {
    doc.fontSize(12).font("Helvetica").text(subtitle, margin, margin + 35, {
      width: pageWidth - 2 * margin,
      align: "left",
    });
  }

  return margin + 70;
}

/**
 * Add a section header with background
 */
function addSectionHeader(doc, title, y) {
  const margin = 50;
  const pageWidth = doc.page.width;
  const sectionWidth = pageWidth - 2 * margin;

  // Light gray background
  doc.rect(margin, y, sectionWidth, 25).fill("#f5f5f5").stroke("#cccccc");

  // Title text
  doc
    .fontSize(12)
    .font("Helvetica-Bold")
    .fillColor("#333333")
    .text(title, margin + 10, y + 6);

  return y + 30;
}

/**
 * Add a two-column info block
 */
function addInfoBlock(doc, label, value, y, labelWidth = 120) {
  const margin = 50;

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#333333")
    .text(label, margin, y);

  // The value wraps inside the page (a long one used to run off the right edge).
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#000000")
    .text(value, margin + labelWidth, y, { width: doc.page.width - 2 * margin - labelWidth });

  return Math.max(y + 18, doc.y + 6);
}

/**
 * Create a table with headers and rows
 */
function addTable(doc, columns, rows, y, options = {}) {
  const margin = 50;
  const pageWidth = doc.page.width;
  const tableWidth = pageWidth - 2 * margin;
  const rowHeight = options.rowHeight || 25;
  const headerHeight = options.headerHeight || 25;

  // Column widths (proportional)
  const colWidths = columns.map((col) => (col.width / 100) * tableWidth);

  let currentY = y;

  // Draw header
  doc.rect(margin, currentY, tableWidth, headerHeight).fill("#2c3e50");

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#ffffff");

  let currentX = margin;
  for (let i = 0; i < columns.length; i++) {
    doc.text(columns[i].label, currentX + 5, currentY + 7, {
      width: colWidths[i] - 10,
      height: headerHeight - 10,
      align: columns[i].align || "left",
    });
    currentX += colWidths[i];
  }

  currentY += headerHeight;

  // Draw rows
  rows.forEach((row, rowIndex) => {
    const isEvenRow = rowIndex % 2 === 0;
    const bgColor = isEvenRow ? "#ffffff" : "#f9f9f9";

    doc.rect(margin, currentY, tableWidth, rowHeight).fill(bgColor).stroke("#dddddd");

    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#000000");

    currentX = margin;
    for (let i = 0; i < columns.length; i++) {
      const cellValue = row[columns[i].key] || "";
      doc.text(String(cellValue), currentX + 5, currentY + 7, {
        width: colWidths[i] - 10,
        height: rowHeight - 10,
        align: columns[i].align || "left",
      });
      currentX += colWidths[i];
    }

    currentY += rowHeight;
  });

  return currentY + 10;
}

/**
 * Add a checkbox list section
 */
function addCheckboxList(doc, items, y) {
  const margin = 50;
  const checkboxSize = 12;
  const itemSpacing = 20;

  let currentY = y;

  items.forEach((item) => {
    // Empty checkbox
    doc.rect(margin, currentY, checkboxSize, checkboxSize).stroke("#999999");

    // Text
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#000000")
      .text(item, margin + checkboxSize + 10, currentY + 2);

    currentY += itemSpacing;
  });

  return currentY + 5;
}

/**
 * Add footer with order info and page number
 */
function addFooter(doc, orderId, pageNum) {
  const margin = 50;
  const pageHeight = doc.page.height;
  const footerY = pageHeight - 40;

  // Separator line
  doc.moveTo(margin, footerY).lineTo(doc.page.width - margin, footerY).stroke("#cccccc");

  // Footer text
  doc.fontSize(8).font("Helvetica").fillColor("#666666");

  // Left: Order ID as barcode-style
  doc.text(`${brand.name} · Order: ${orderId}`, margin, footerY + 5);

  // Right: Page number
  doc.text(`Page ${pageNum}`, doc.page.width - margin - 50, footerY + 5, {
    align: "right",
    width: 50,
  });
}

/** Helvetica (WinAnsi) has no "•" outside its own range mapping here: the masked account prints as "xxxx1234". */
function pdfSafe(text) {
  return String(text || "").replace(/•/g, "x");
}

// ============================================================================
// MAIN PDF GENERATION FUNCTIONS
// ============================================================================

/**
 * Generate a Job Traveler PDF document: the sheet that goes to the machine with the job.
 *
 * What it has to carry, because the shop works from it and nothing else:
 *   - at the top, in boxes nobody can miss: inspection paperwork was bought (first-article
 *     report + certificate of conformance), and the customer's original part goes back in the
 *     box. When neither applies the sheet says so, so a missing box is never read as "not known";
 *   - for every line, the full description the order was priced on (documents.specOf): process,
 *     material, grade, stock thickness, size and drawing units, finish, tolerance, layer height,
 *     quantity. A value the order line does not carry prints as "NOT RECORDED — confirm with
 *     customer" and is counted in a box at the top; it is never left blank. A DXF has no
 *     thickness of its own, so a routed line with no thickness on it must stop the job;
 *   - what the customer typed (PO number, notes), each as one line of text inside its own field.
 *
 * @param {Object} order - Order object with id, shippingName, etc.
 * @param {Array} items - Array of order items with part/material/finish info (and, when the part
 *                        still exists, its measured `geometry` and `dfm`)
 * @returns {Promise<Buffer>} PDF buffer
 */
function generateJobTraveler(order, items) {
  const doc = new PDFDocument({
    size: "Letter",
    margin: 0,
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const pageWidth = doc.page.width;
  const margin = 50;
  const inner = pageWidth - 2 * margin;
  const orderRef = String(order.id || "").substring(0, 8);
  let y = margin;
  let pageNum = 1;
  /** Start a new page when fewer than `need` points are left above the footer. */
  const room = (need) => {
    if (y + need <= doc.page.height - 60) return;
    addFooter(doc, orderRef, pageNum);
    doc.addPage();
    pageNum++;
    y = margin;
  };
  const line = (v, max) => oneLine(v, max);
  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const specs = items.map((item) => specOf(item));
  const missing = specs.reduce((n, sp) => n + sp.missing.length, 0);
  const paperworkFee = Number(order.paperworkFee) || 0;

  // ========== PAGE 1: Header ==========
  y = addHeader(doc, "JOB TRAVELER", `Order: ${orderRef}`);

  const dateStr = new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  const payment = order.paymentMethod === "po" || order.status === "pending_po"
    ? `Purchase order ${line(order.poNumber, 60) || "(number not recorded)"} - NOT CHARGED. Confirm the PO with the customer before starting.`
    : order.status === "pending_payment" ? "Card payment NOT yet received. Do not start." : "Paid by card";
  doc.fontSize(10).font("Helvetica").fillColor("#666666").text(`Printed: ${dateStr}     Payment: ${payment}`, margin, y, { width: inner });
  y = doc.y + 10;

  // ---------- The two things that change what goes in the box ----------
  /** A heavy box: a line of capitals and one sentence under it. */
  const flagBox = (title, body) => {
    const w = inner - 24;
    doc.fontSize(13).font("Helvetica-Bold");
    const titleHeight = doc.heightOfString(title, { width: w });
    doc.fontSize(9).font("Helvetica");
    const bodyHeight = doc.heightOfString(body, { width: w });
    const h = 10 + titleHeight + 4 + bodyHeight + 10;
    room(h + 8);
    doc.lineWidth(2.5).rect(margin, y, inner, h).fillAndStroke("#ffffff", "#000000");
    doc.lineWidth(1);
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#000000").text(title, margin + 12, y + 10, { width: w });
    doc.fontSize(9).font("Helvetica").fillColor("#000000").text(body, margin + 12, y + 10 + titleHeight + 4, { width: w });
    y += h + 8;
  };
  if (order.paperwork) {
    flagBox(
      "INSPECTION PAPERWORK ORDERED: FIRST-ARTICLE REPORT + CERTIFICATE OF CONFORMANCE",
      `The customer bought both${paperworkFee > 0 ? ` (${usd(paperworkFee)})` : " (in the quoted price)"}. Measure the first piece of each part number against the drawing and write the first-article report; fill in and sign the certificate of conformance with material and lot. Both ship in the box with the parts.`,
    );
  }
  if (order.returnPart) {
    flagBox(
      "RETURN THE CUSTOMER'S ORIGINAL PART WITH THIS ORDER",
      "The customer sent in a part to be measured and asked for it back. It goes in the box with the finished parts; the price already covers the return shipping. Do not scrap it, and do not ship without it.",
    );
  }
  if (missing > 0) {
    flagBox(
      `CHECK BEFORE CUTTING: ${missing} VALUE${missing === 1 ? "" : "S"} NOT RECORDED ON THIS ORDER`,
      "Each one is marked NOT RECORDED in the line it belongs to below. Confirm it with the customer and write it on this sheet before any material is cut.",
    );
  }
  if (!order.paperwork || !order.returnPart) {
    room(16);
    doc.fontSize(9).font("Helvetica").fillColor("#333333").text(
      [!order.paperwork ? "Inspection paperwork (first-article report, certificate of conformance): not ordered." : "", !order.returnPart ? "Customer's original part: none to return." : ""].filter(Boolean).join("   "),
      margin, y, { width: inner },
    );
    y = doc.y + 10;
  }

  // ---------- Customer ----------
  room(100);
  y = addSectionHeader(doc, "CUSTOMER INFORMATION", y);
  y = addInfoBlock(doc, "Ship To:", line(order.shippingName, 80) || "Not specified", y);
  y = addInfoBlock(doc, "Company:", line(order.company, 80) || "Not specified", y);
  const address = [order.shippingAddress, order.shippingCity, order.shippingState, order.shippingZip].map((v) => line(v, 80)).filter(Boolean).join(", ");
  y = addInfoBlock(doc, "Address:", address || (order.shippingMethod === "pickup" ? "Customer pickup" : "Not specified"), y);
  // How it leaves the shop when it is not our own shipment: a pickup, or the buyer's carrier
  // account (last four characters only; the full number is on the order in admin).
  const delivery = require("./shipping").methodLine(order);
  if (delivery) y = addInfoBlock(doc, "Delivery:", pdfSafe(order.shippingMethod === "pickup" ? "CUSTOMER PICKUP - do not ship" : `${line(delivery, 80)} - ship collect, see the order in admin for the full account number`), y);
  if (Number(order.packedWeightLb) > 0) y = addInfoBlock(doc, "Packed wt (est.):", `${Math.ceil(Number(order.packedWeightLb))} lb`, y);
  y += 10;

  // ---------- What to make ----------
  room(90);
  y = addSectionHeader(doc, "MANUFACTURED ITEMS", y);
  items.forEach((item, i) => {
    const description = specs[i].parts.join("  \u00b7  ");
    doc.fontSize(9.5).font("Helvetica");
    const descHeight = doc.heightOfString(description, { width: inner - 20, lineGap: 2 });
    doc.fontSize(11).font("Helvetica-Bold");
    const name = line(item.fileName, 140) || "(no file name)";
    const nameHeight = doc.heightOfString(`${i + 1}.  ${name}`, { width: inner - 110 });
    const h = 8 + nameHeight + 4 + descHeight + 16 + 8;
    room(h);
    doc.rect(margin, y, inner, h).fillAndStroke(i % 2 === 0 ? "#ffffff" : "#f9f9f9", "#bbbbbb");
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000").text(`${i + 1}.  ${name}`, margin + 10, y + 8, { width: inner - 110 });
    doc.fontSize(14).font("Helvetica-Bold").text(`QTY ${item.quantity || "?"}`, margin + inner - 100, y + 7, { width: 90, align: "right", lineBreak: false });
    doc.fontSize(9.5).font("Helvetica").fillColor("#000000").text(description, margin + 10, y + 8 + nameHeight + 4, { width: inner - 20, lineGap: 2 });
    doc.fontSize(8).font("Helvetica").fillColor("#555555").text(`Unit ${usd(item.unitPrice)}     Line ${usd(item.lineTotal)}`, margin + 10, y + h - 16, { width: inner - 20, lineBreak: false });
    y += h + 4;
  });
  y += 6;

  // ---------- What the buyer asked for: the promised date, their PO, their notes, their drawing ----------
  const fromCustomer = [
    order.shipBy ? `Promised ship-by: ${require("./shipBy").formatShipBy(order.shipBy)}${order.leadTimeName ? ` (${line(order.leadTimeName, 40)})` : ""}` : "",
    // One line whatever is stored: a PO number saved before it was checked at the door can hold a line break or
    // hidden characters, which would print the buyer's own words as a line of this document (review F-10).
    order.poNumber ? `Customer PO (as typed): ${line(order.poNumber, 60)}` : "",
    order.customerNotes ? `Customer notes (as typed, on one line): "${line(order.customerNotes, 2000)}"` : "",
    order.drawingFileName ? `Drawing on the order: ${line(order.drawingFileName, 140)} - review before cutting` : "",
  ].filter(Boolean);
  const dfmNotes = items
    .filter((item) => item.dfm)
    .map((item) => {
      // item.dfm is the stored analysis ({ summary, checks }); print what needs attention, not the object.
      if (typeof item.dfm === "string") return `${line(item.fileName, 80)}: ${line(item.dfm, 600)}`;
      const flagged = (item.dfm.checks || []).filter((c) => c.status === "warn" || c.status === "fail");
      return flagged.length ? `${line(item.fileName, 80)}: ${flagged.map((c) => `${String(c.status).toUpperCase()} ${c.name}${c.detail ? " - " + c.detail : ""}`).join("; ")}` : "";
    })
    .filter(Boolean)
    .map((t) => line(t, 1200));
  if (fromCustomer.length || dfmNotes.length) {
    room(60);
    y = addSectionHeader(doc, "DFM NOTES & SPECIAL INSTRUCTIONS", y);
    for (const note of [...fromCustomer, ...dfmNotes]) {
      doc.fontSize(9).font("Helvetica").fillColor("#000000");
      room(doc.heightOfString(note, { width: inner - 20 }) + 8);
      doc.fontSize(9).font("Helvetica").fillColor("#000000").text(note, margin + 10, y, { width: inner - 20, align: "left" });
      y = doc.y + 6;
    }
    y += 4;
  }

  // ---------- QC checklist ----------
  // Group items by process type
  const processGroups = {};
  items.forEach((item) => {
    const process = item.process || "general";
    if (!processGroups[process]) {
      processGroups[process] = [];
    }
    processGroups[process].push(item);
  });

  // QC items per process type
  const qcItems = {
    sheetmetal: [
      "Dimensions within tolerance (+/- 0.03 in)",
      "Bend angles correct and consistent",
      "Hole positions verified to drawing",
      "Edge quality acceptable (deburr/finish)",
      "Surface finish meets specification",
    ],
    cnc: [
      "Dimensions within tolerance (+/- 0.005 in)",
      "Surface finish Ra value verified",
      "Thread gauging passed",
      "No tool marks or burrs present",
      "Features match engineering drawing",
    ],
    "3d_printing": [
      "Layer adhesion acceptable throughout",
      "Support removal clean and complete",
      "Dimensional accuracy verified",
      "Surface quality acceptable",
      "No warping or deformation detected",
    ],
  };
  qcItems["3d-printing"] = qcItems["3d_printing"];
  // What was bought on top of the parts is checked off like everything else.
  const orderChecks = [
    ...(order.paperwork ? ["First-article report written: first piece of each part number measured against the drawing", "Certificate of conformance filled in and signed, with material and lot", "Both documents in the box"] : []),
    ...(order.returnPart ? ["Customer's original part in the box"] : []),
  ];
  const uniqueProcesses = Object.keys(processGroups).filter((process) => (qcItems[process] || []).length > 0);
  if (uniqueProcesses.length || orderChecks.length) {
    room(70);
    y += 5;
    y = addSectionHeader(doc, "QUALITY CONTROL CHECKLIST", y);
    const group = (title, checks) => {
      room(20 + checks.length * 20);
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#333333").text(`${title}:`, margin + 10, y);
      y += 15;
      checks.forEach((check) => { room(22); y = addCheckboxList(doc, [check], y) - 5; });
      y += 8;
    };
    if (orderChecks.length) group("This order", orderChecks);
    uniqueProcesses.forEach((process) => group(capitalizeProcess(process), qcItems[process]));
  }

  // Footer
  addFooter(doc, orderRef, pageNum);

  // ========== LAST PAGE: Order Summary & Notes ==========
  doc.addPage();
  pageNum++;
  y = margin;

  y = addHeader(doc, "ORDER SUMMARY", `Order: ${orderRef}`);

  // Order totals section
  y = addSectionHeader(doc, "ORDER DETAILS", y);

  const subtotal = items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  const tax = Number(order.tax) || 0; // what Stripe added at payment (0 when tax is not collected)
  // The order's own total is the amount charged (it can include a lead-time fee and the paperwork fee); the sum is only a fallback for old records.
  const fee = Number(order.leadTimeSurcharge) || 0;
  const total = Number(order.total) > 0 ? Number(order.total) : subtotal + fee + paperworkFee + tax + (order.shippingCost || 0);

  y = addInfoBlock(doc, "Parts:", usd(subtotal), y, 170);
  if (fee > 0) y = addInfoBlock(doc, `${line(order.leadTimeName, 30) || "Lead-time"} fee:`, usd(fee), y, 170);
  y = addInfoBlock(doc, "Inspection paperwork:", order.paperwork ? (paperworkFee > 0 ? `${usd(paperworkFee)}  (first-article report + certificate of conformance ORDERED)` : "ORDERED, in the quoted price") : "Not ordered", y, 170);
  y = addInfoBlock(doc, "Original part to return:", order.returnPart ? "YES - return shipping is in the price" : "No", y, 170);
  y = addInfoBlock(
    doc,
    "Shipping:",
    usd(order.shippingCost),
    y,
    170,
  );
  y = addInfoBlock(doc, "Tax:", order.taxMode === "stripe" && order.paymentMethod === "po" ? "Per invoice" : usd(tax), y, 170);
  if (order.taxExempt) y = addInfoBlock(doc, "Tax exemption:", order.taxExemptStatus === "untaxed" ? "Declared, no tax charged" : "Declared, tax charged", y, 170);
  y += 5;
  y = addInfoBlock(doc, "TOTAL:", usd(total), y, 170);

  y += 15;

  // Due date section
  y = addSectionHeader(doc, "TIMELINE", y);
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#000000");
  y = addInfoBlock(doc, "Order Date:", new Date(order.createdAt || Date.now()).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" }), y);
  y = addInfoBlock(doc, "Ship by:", order.shipBy ? require("./shipBy").formatShipBy(order.shipBy) : "Not set", y);
  y = addInfoBlock(doc, "Status:", line(order.status, 40) || "pending", y);

  y += 15;

  // Notes section (the shop's own note on the order)
  if (order.notes) {
    y = addSectionHeader(doc, "ORDER NOTES", y);
    doc.fontSize(9).font("Helvetica").fillColor("#000000");
    doc.text(line(order.notes, 2000), margin + 10, y, {
      width: pageWidth - 2 * margin - 20,
      align: "left",
    });
    y = doc.y + 10;
  }

  // Signature line
  y += 20;
  doc
    .moveTo(margin, y)
    .lineTo(margin + 200, y)
    .stroke("#000000");
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#333333")
    .text("Production Lead Signature", margin, y + 5);

  // Footer
  addFooter(doc, orderRef, pageNum);

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/**
 * Generate a Packing List PDF document
 * @param {Object} order - Order object with shipping details
 * @param {Array} items - Array of order items
 * @returns {Buffer} PDF buffer
 */
function generatePackingList(order, items) {
  const doc = new PDFDocument({
    size: "Letter",
    margin: 0,
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const pageWidth = doc.page.width;
  const margin = 50;
  let y = margin;
  const pageNum = 1;

  // ========== HEADER ==========
  y = addHeader(doc, "PACKING LIST", `Order: ${order.id.substring(0, 8)}`);

  // Date
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#666666")
    .text(`Date: ${dateStr}`, margin, y);

  y += 20;

  // Ship-to address block (a pickup order has no address: it is handed over at the shop)
  y = addSectionHeader(doc, order.shippingMethod === "pickup" ? "CUSTOMER PICKUP" : "SHIP TO", y);

  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text(order.shippingName || "Not specified", margin + 10, y);

  y += 18;

  const address = [
    order.shippingAddress,
    order.shippingCity,
    order.shippingState,
    order.shippingZip,
    order.shippingCountry,
  ]
    .filter(Boolean)
    .join(", ");

  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#000000")
    .text(address || (order.shippingMethod === "pickup" ? "Handed over at the shop" : "Not specified"), margin + 10, y, {
      width: pageWidth - 2 * margin - 20,
    });
  if (order.shippingMethod === "carrier-account") {
    doc.text(pdfSafe(require("./shipping").methodLine(order)), margin + 10, doc.y + 4, { width: pageWidth - 2 * margin - 20 });
  }

  y = doc.y + 15;

  // Items table
  y = addSectionHeader(doc, "CONTENTS", y);

  const packingColumns = [
    { label: "", key: "checkbox", width: 8, align: "center" },
    { label: "Part Name", key: "fileName", width: 40, align: "left" },
    { label: "Qty", key: "quantity", width: 12, align: "center" },
    { label: "Description", key: "description", width: 40, align: "left" },
  ];

  const packingRows = items.map((item) => ({
    checkbox: "☐",
    fileName: oneLine(item.fileName, 35),
    quantity: item.quantity || 1,
    description: `${capitalizeProcess(item.process)} - ${oneLine(item.materialName, 40)}`,
  }));

  y = addTable(doc, packingColumns, packingRows, y, { rowHeight: 20 });

  y += 10;

  // Total items
  y = addSectionHeader(doc, "SUMMARY", y);

  const totalItems = items.reduce((sum, item) => sum + (item.quantity || 1), 0);

  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text(`Total Items: ${totalItems}`, margin + 10, y);

  y += 20;

  // Notes section
  y = addSectionHeader(doc, "SPECIAL INSTRUCTIONS", y);

  if (order.notes) {
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#000000")
      .text(oneLine(order.notes, 2000), margin + 10, y, {
        width: pageWidth - 2 * margin - 20,
      });
  } else {
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#999999")
      .text("No special instructions", margin + 10, y);
  }

  y = doc.y + 15;

  // Return address placeholder
  y = addSectionHeader(doc, "RETURN ADDRESS", y);

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#666666");
  doc.text(shopFacts.businessName(brand), margin + 10, y);
  doc.text([brand.address, `${brand.city}, ${brand.state}`, brand.zip].filter(Boolean).join(" "), margin + 10, y + 12);
  doc.text(`${brand.phone} · ${brand.email}`, margin + 10, y + 24);
  doc.text(`Order Reference: ${order.id.substring(0, 8)}`, margin + 10, y + 38);

  // Footer
  addFooter(doc, order.id.substring(0, 8), pageNum);

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/**
 * Helper to capitalize process names
 */
function capitalizeProcess(process) {
  const processMap = {
    sheetmetal: "Sheet Metal",
    cnc: "CNC Machining",
    "3d_printing": "3D Printing",
    "3d": "3D Printing",
  };

  return processMap[process?.toLowerCase?.()] || process || "General";
}

module.exports = {
  generateJobTraveler,
  generatePackingList,
};
