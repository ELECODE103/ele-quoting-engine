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
 *     a line priced as lathe work while turning is not sold as its own operation,
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
const shopFacts = require("../shopFacts");

const RFQ_QTY_THRESHOLD = Number(brand.rfqQuantityThreshold) || 100;
const BIG_TICKET_LINE_TOTAL = 5000;  // $ — above this, a human confirms before money moves
const LOW_VOLUME_RATIO = 0.12;        // part volume / bbox volume — below this it's usually a multi-setup job

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Limits are applied to what is being bought, not to how it was typed in (payments review
 * 2026-11-11, F-03): the quantity limit is applied to each line, to each part summed over its
 * lines (and over lines whose stored geometry is identical), and to the order; the big-ticket
 * limit to each line and to the order's parts total; and each line is judged on the DFM result
 * of ITS process and configuration, never on another line's result for the same part.
 *
 * @param {Array} lineItems — pricing-engine line items (with meta + quantity)
 * @param {Array|Object} dfmByLine — the DFM result of each line, in line order: [{ summary, checks }, …].
 *   (An object keyed by part id is still accepted for callers with one line per part.)
 * @param {Object} [rules] — pricing rules; the gate thresholds (rfqQuantityThreshold,
 *   bigTicketLineTotal, lowVolumeRatio) are read from here when present so the
 *   admin pricing console can tune them. Missing keys fall back to the constants.
 * @param {Object} [opts] — { geometryKeys: string[] } a key per line that is equal for lines whose
 *   stored geometry is identical (the same drawing uploaded twice), so their quantities are summed
 * @returns {{ requiresRfq: boolean, reasons: Array<{partId, code, message}> }}
 */
function evaluate(lineItems = [], dfmByLine = {}, rules = {}, opts = {}) {
  const reasons = [];
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const qtyThreshold = num(rules.rfqQuantityThreshold, RFQ_QTY_THRESHOLD);
  const bigTicket = num(rules.bigTicketLineTotal, BIG_TICKET_LINE_TOTAL);
  const lowVolume = num(rules.lowVolumeRatio, LOW_VOLUME_RATIO);
  const reviewLegacy = num(rules.gateReviewOnLegacyFeatures, 1) >= 1;
  const thinWallMm = num(rules.gateReviewThinWallMm, 1.0);

  const person = shopFacts.when("quote-turnaround", (v) => ` within ${v}`);
  for (const [index, li] of lineItems.entries()) {
    const partId = li.partId;
    const process = li.meta?.process || "";
    const qty = Number(li.quantity) || 1;

    if (qty > qtyThreshold) {
      reasons.push({
        partId,
        code: "quantity",
        message: `${qty} pieces is over our ${qtyThreshold}-piece instant-order limit — production runs are quoted by a person${shopFacts.when("quote-turnaround", (v) => ` within ${v}`)}`,
      });
    }

    const dfm = Array.isArray(dfmByLine) ? dfmByLine[index] : dfmByLine[partId];
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

    // Lathe work is a supporting operation here (a manual lathe for bores and
    // second operations), not something sold by the click: a line priced as
    // turning keeps its budgetary price and goes to a person.
    if (process === "cnc" && li.meta?.subProcess === "turning" && !shopFacts.ok("turning")) {
      reasons.push({ partId, code: "turning-review", message: "Turned parts are quoted by a person — lathe work here is done by hand" });
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

  // ── What the lines add up to ────────────────────────────────────────────────
  const qtyOf = (li) => Number(li.quantity) || 1;
  const flagged = (code, ids) => reasons.some((r) => r.code === code && (!ids || ids.has(r.partId)));
  // The same part on several lines, or the same geometry uploaded more than once: one run.
  const geometryKeys = Array.isArray(opts.geometryKeys) ? opts.geometryKeys : [];
  const groups = new Map();
  lineItems.forEach((li, i) => {
    for (const key of [`part:${li.partId}`, geometryKeys[i] ? `geometry:${geometryKeys[i]}` : null]) {
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { lines: 0, pieces: 0, partIds: new Set(), first: li.partId });
      const g = groups.get(key);
      g.lines++; g.pieces += qtyOf(li); g.partIds.add(li.partId);
    }
  });
  const summed = new Set();
  for (const g of groups.values()) {
    if (g.lines < 2 || g.pieces <= qtyThreshold || flagged("quantity", g.partIds) || summed.has(g.first)) continue;
    summed.add(g.first);
    reasons.push({
      partId: g.first,
      code: "quantity",
      message: `${g.pieces} pieces of this part across ${g.lines} lines is over our ${qtyThreshold}-piece instant-order limit — production runs are quoted by a person${person}`,
    });
  }
  const orderPieces = lineItems.reduce((sum, li) => sum + qtyOf(li), 0);
  if (lineItems.length > 1 && orderPieces > qtyThreshold && !flagged("quantity")) {
    reasons.push({
      partId: null,
      code: "order-quantity",
      message: `${orderPieces} pieces in one order is over our ${qtyThreshold}-piece instant-order limit — production runs are quoted by a person${person}`,
    });
  }
  // The big-ticket limit is the same figure for a line and for the order's parts total.
  const partsTotal = lineItems.reduce((sum, li) => sum + (Number(li.lineTotal) || 0), 0);
  if (lineItems.length > 1 && partsTotal > bigTicket && !flagged("big-ticket")) {
    reasons.push({
      partId: null,
      code: "big-ticket-order",
      message: `Order total over $${bigTicket.toLocaleString()} — we confirm the price by hand before you pay`,
    });
  }

  return { requiresRfq: reasons.length > 0, reasons, threshold: qtyThreshold };
}

module.exports = { evaluate, RFQ_QTY_THRESHOLD, BIG_TICKET_LINE_TOTAL, LOW_VOLUME_RATIO };
