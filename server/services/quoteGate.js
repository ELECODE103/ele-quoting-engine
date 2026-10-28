/**
 * Quote gate — decides whether a quote can go straight to checkout or needs a
 * person to look at it first (an RFQ).
 *
 * Instant price + checkout is the default for every process. A quote is routed
 * to RFQ when any line:
 *   - is over the quantity threshold (brand.rfqQuantityThreshold, 100)
 *   - has a hard DFM failure for its chosen process
 *   - trips a "needs a human" flag: part bigger than the machine envelope,
 *     a stock-to-part ratio that usually means multiple setups / 4th axis,
 *     a machined block priced without a feature list (legacy geometry only),
 *     a wall thinner than the review threshold,
 *     or a line total big enough that a wrong model assumption costs real money
 *
 * Thresholds come from the Gate group of the pricing rules when the caller
 * passes them (rfqQuantityThreshold, bigTicketLineTotal, lowVolumeRatio,
 * gateReviewOnLegacyFeatures, gateReviewThinWallMm); the constants below are
 * the fallbacks.
 *
 * The budgetary price is still shown in every case; only the button changes.
 */
const brand = require("../../shared/brand.json");

const RFQ_QTY_THRESHOLD = Number(brand.rfqQuantityThreshold) || 100;
const BIG_TICKET_LINE_TOTAL = 5000;  // $ — above this, a human confirms before money moves
const LOW_VOLUME_RATIO = 0.12;        // part volume / bbox volume — below this it's usually a multi-setup job

/**
 * @param {Array} lineItems — pricing-engine line items (with meta + quantity)
 * @param {Object} dfmByPartId — { [partId]: { summary, checks } } for each line's chosen process
 * @returns {{ requiresRfq: boolean, reasons: Array<{partId, code, message}> }}
 */
function evaluate(lineItems = [], dfmByPartId = {}, rules = {}) {
  const reasons = [];
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const qtyThreshold = num(rules.rfqQuantityThreshold, RFQ_QTY_THRESHOLD);
  const bigTicket = num(rules.bigTicketLineTotal, BIG_TICKET_LINE_TOTAL);
  const lowVolume = num(rules.lowVolumeRatio, LOW_VOLUME_RATIO);
  const reviewLegacy = num(rules.gateReviewOnLegacyFeatures, 1) >= 1;
  const thinWallMm = num(rules.gateReviewThinWallMm, 1.0);

  for (const li of lineItems) {
    const partId = li.partId;
    const process = li.meta?.process || "";
    const qty = Number(li.quantity) || 1;

    if (qty > qtyThreshold) {
      reasons.push({
        partId,
        code: "quantity",
        message: `${qty} pieces is over our ${qtyThreshold}-piece instant-order limit — production runs are quoted by a person within ${brand.quoteTurnaroundHours} hours`,
      });
    }

    const dfm = dfmByPartId[partId];
    if (dfm && dfm.summary && dfm.summary.manufacturable === false) {
      const fails = (dfm.checks || []).filter((c) => c.severity === "fail").map((c) => c.label);
      reasons.push({
        partId,
        code: "dfm-fail",
        message: `DFM flagged: ${fails.join(", ") || "part cannot be made as drawn"}`,
      });
    }

    if (dfm && Array.isArray(dfm.checks)) {
      const envelope = dfm.checks.find((c) => (c.id === "cnc-max-size" || c.id === "rt-bed-size") && c.severity === "warn");
      if (envelope) {
        reasons.push({ partId, code: "envelope", message: envelope.detail });
      }
    }

    if (process === "cnc") {
      const g = li.meta?.geometrySummary;
      if (g && g.volumeRatio != null && g.volumeRatio < lowVolume) {
        reasons.push({
          partId,
          code: "complex-geometry",
          message: `Part uses ${(g.volumeRatio * 100).toFixed(0)}% of its stock envelope — likely a multi-setup or 4th-axis job that the instant model under-prices`,
        });
      }
      // A block priced from legacy geometry has no hole/thread/pocket list;
      // flat and turned parts derive well without one, blocks do not. A plain
      // block (nothing removed from its envelope) has nothing hidden, so it
      // stays instant.
      const conf = li.meta?.confidence;
      const shape = g?.shape;
      const hasFeatures = g && g.volumeRatio != null && g.volumeRatio < 0.97;
      if (reviewLegacy && conf && conf.source === "legacy" && (shape === "prismatic" || shape === "freeform") && hasFeatures) {
        reasons.push({
          partId,
          code: "legacy-features",
          message: "Machined block priced without feature recognition (holes, threads and pockets not seen) — a person confirms the price",
        });
      }
      if (g && g.minWallMm != null && g.minWallMm < thinWallMm) {
        reasons.push({
          partId,
          code: "thin-wall",
          message: `Walls as thin as ${g.minWallMm} mm — a person confirms the part can be held and machined`,
        });
      }
    }

    if (Number(li.lineTotal) > bigTicket) {
      reasons.push({
        partId,
        code: "big-ticket",
        message: `Line total over $${bigTicket.toLocaleString()} — we confirm the price by hand before you pay`,
      });
    }
  }

  return { requiresRfq: reasons.length > 0, reasons, threshold: qtyThreshold };
}

module.exports = { evaluate, RFQ_QTY_THRESHOLD, BIG_TICKET_LINE_TOTAL, LOW_VOLUME_RATIO };
