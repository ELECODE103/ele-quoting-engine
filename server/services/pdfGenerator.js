/**
 * PDF Generation Service
 * Uses PDFKit to generate professional job travelers and packing lists
 */
const PDFDocument = require("pdfkit");

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

  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#000000")
    .text(value, margin + labelWidth, y);

  return y + 18;
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
  doc.text(`Order: ${orderId}`, margin, footerY + 5);

  // Right: Page number
  doc.text(`Page ${pageNum}`, doc.page.width - margin - 50, footerY + 5, {
    align: "right",
    width: 50,
  });
}

// ============================================================================
// MAIN PDF GENERATION FUNCTIONS
// ============================================================================

/**
 * Generate a Job Traveler PDF document
 * @param {Object} order - Order object with id, shippingName, etc.
 * @param {Array} items - Array of order items with part/material/finish info
 * @returns {Buffer} PDF buffer
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
  let y = margin;
  let pageNum = 1;

  // ========== PAGE 1: Header & Customer Info ==========

  // Title
  y = addHeader(doc, "JOB TRAVELER", `Order: ${order.id.substring(0, 8)}`);

  // Date and order info in two columns
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

  // Customer Info Section
  y = addSectionHeader(doc, "CUSTOMER INFORMATION", y);

  y = addInfoBlock(doc, "Ship To:", order.shippingName || "Not specified", y);
  y = addInfoBlock(
    doc,
    "Company:",
    order.company || "Not specified",
    y
  );

  const address = [
    order.shippingAddress,
    order.shippingCity,
    order.shippingState,
    order.shippingZip,
  ]
    .filter(Boolean)
    .join(", ");
  y = addInfoBlock(doc, "Address:", address || "Not specified", y);

  y += 10;

  // Items Table
  y = addSectionHeader(doc, "MANUFACTURED ITEMS", y);

  const itemColumns = [
    { label: "Part File", key: "fileName", width: 25, align: "left" },
    { label: "Process", key: "process", width: 15, align: "left" },
    { label: "Material", key: "materialName", width: 15, align: "left" },
    { label: "Finish", key: "finishName", width: 15, align: "left" },
    { label: "Qty", key: "quantity", width: 8, align: "center" },
    { label: "Unit Price", key: "unitPriceStr", width: 12, align: "right" },
    { label: "Total", key: "lineTotalStr", width: 10, align: "right" },
  ];

  const itemRows = items.map((item) => ({
    ...item,
    fileName: item.fileName.substring(0, 30),
    process: capitalizeProcess(item.process),
    unitPriceStr: `$${(item.unitPrice || 0).toFixed(2)}`,
    lineTotalStr: `$${(item.lineTotal || 0).toFixed(2)}`,
  }));

  y = addTable(doc, itemColumns, itemRows, y, { rowHeight: 22 });

  // DFM Notes Section
  if (items.some((item) => item.dfm)) {
    y += 5;
    y = addSectionHeader(doc, "DFM NOTES & SPECIAL INSTRUCTIONS", y);

    const dfmNotes = items
      .filter((item) => item.dfm)
      .map((item) => `${item.fileName}: ${item.dfm}`)
      .join("\n\n");

    if (dfmNotes) {
      doc.fontSize(9).font("Helvetica").fillColor("#000000");
      y = doc.y;
      doc.text(dfmNotes, margin + 10, y, {
        width: pageWidth - 2 * margin - 20,
        align: "left",
      });
      y = doc.y + 10;
    }
  }

  // Check for page overflow
  if (y > doc.page.height - 100) {
    doc.addPage();
    y = margin;
    pageNum++;
  }

  // QC Checklist Section
  y += 5;
  y = addSectionHeader(doc, "QUALITY CONTROL CHECKLIST", y);

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

  // Display QC checklist
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#333333");

  let qcY = doc.y;

  const uniqueProcesses = Object.keys(processGroups);
  uniqueProcesses.forEach((process) => {
    const processLabel = capitalizeProcess(process);
    doc.text(`${processLabel}:`, margin + 10, qcY);
    qcY += 15;

    const checks = qcItems[process] || qcItems["general"] || [];
    checks.forEach((check) => {
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#000000");
      qcY = addCheckboxList(doc, [check], qcY);
    });

    qcY += 5;
  });

  // Footer
  addFooter(doc, order.id.substring(0, 8), pageNum);

  // ========== PAGE 2: Order Summary & Notes ==========
  doc.addPage();
  pageNum++;
  y = margin;

  y = addHeader(doc, "ORDER SUMMARY", `Order: ${order.id.substring(0, 8)}`);

  // Order totals section
  y = addSectionHeader(doc, "ORDER DETAILS", y);

  const subtotal = items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  const tax = 0;
  const total = subtotal + tax + (order.shippingCost || 0);

  y = addInfoBlock(doc, "Subtotal:", `$${subtotal.toFixed(2)}`, y);
  y = addInfoBlock(
    doc,
    "Shipping:",
    `$${(order.shippingCost || 0).toFixed(2)}`,
    y
  );
  y = addInfoBlock(doc, "Tax:", `$${tax.toFixed(2)}`, y);
  y += 5;
  y = addInfoBlock(doc, "TOTAL:", `$${total.toFixed(2)}`, y);

  y += 15;

  // Due date section
  y = addSectionHeader(doc, "TIMELINE", y);
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#000000");
  y = addInfoBlock(doc, "Order Date:", order.createdAt || new Date().toISOString(), y);
  y = addInfoBlock(doc, "Due Date:", "[Due Date TBD]", y);
  y = addInfoBlock(doc, "Status:", order.status || "pending", y);

  y += 15;

  // Notes section
  if (order.notes) {
    y = addSectionHeader(doc, "ORDER NOTES", y);
    doc.fontSize(9).font("Helvetica").fillColor("#000000");
    y = doc.y;
    doc.text(order.notes, margin + 10, y, {
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
  addFooter(doc, order.id.substring(0, 8), pageNum);

  doc.end();

  return Buffer.concat(chunks);
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

  // Ship-to address block
  y = addSectionHeader(doc, "SHIP TO", y);

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
    .text(address || "Not specified", margin + 10, y, {
      width: pageWidth - 2 * margin - 20,
    });

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
    fileName: item.fileName.substring(0, 35),
    quantity: item.quantity || 1,
    description: `${capitalizeProcess(item.process)} - ${item.materialName}`,
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
      .text(order.notes, margin + 10, y, {
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
  doc.text("[Company Return Address]", margin + 10, y);
  doc.text("[Street Address]", margin + 10, y + 12);
  doc.text("[City, State ZIP]", margin + 10, y + 24);
  doc.text(`Order Reference: ${order.id.substring(0, 8)}`, margin + 10, y + 38);

  // Footer
  addFooter(doc, order.id.substring(0, 8), pageNum);

  doc.end();

  return Buffer.concat(chunks);
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
