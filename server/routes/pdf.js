/**
 * PDF Routes
 * Endpoints for generating and serving PDF documents (job travelers, packing lists)
 */
const express = require("express");
const { ordersDB, orderItemsDB, partsDB } = require("../models");
const { authenticate, requireAdmin } = require("./auth");
const { generateJobTraveler, generatePackingList } = require("../services/pdfGenerator");

const router = express.Router();

// ============================================================================
// GET /api/pdf/traveler/:orderId - Generate Job Traveler PDF
// ============================================================================
router.get("/traveler/:orderId", authenticate, requireAdmin, (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch order
    const order = ordersDB.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Fetch order items
    const items = orderItemsDB.query((i) => i.orderId === orderId);
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Order has no items" });
    }

    // Enrich items with part geometry/DFM data
    const enrichedItems = items.map((item) => {
      let part = null;
      let geometry = null;
      let dfm = null;

      if (item.partId) {
        part = partsDB.getById(item.partId);
        if (part) {
          geometry = part.geometry || null;
          dfm = part.dfm || null;
        }
      }

      return {
        ...item,
        geometry,
        dfm,
      };
    });

    // Generate PDF
    const pdfBuffer = generateJobTraveler(order, enrichedItems);

    // Send as PDF response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="traveler_${orderId.substring(0, 8)}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Job Traveler PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate job traveler PDF" });
  }
});

// ============================================================================
// GET /api/pdf/packing-list/:orderId - Generate Packing List PDF
// ============================================================================
router.get("/packing-list/:orderId", authenticate, requireAdmin, (req, res) => {
  try {
    const { orderId } = req.params;

    // Fetch order
    const order = ordersDB.getById(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Fetch order items
    const items = orderItemsDB.query((i) => i.orderId === orderId);
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Order has no items" });
    }

    // Generate PDF
    const pdfBuffer = generatePackingList(order, items);

    // Send as PDF response
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="packing-list_${orderId.substring(0, 8)}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Packing List PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate packing list PDF" });
  }
});

module.exports = router;
