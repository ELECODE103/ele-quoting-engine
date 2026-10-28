/**
 * CNC routing DFM — flat / plate parts on the 59" × 96" router.
 * Signature: run(geometry, options) → { checks, summary }
 *
 * Severity tiers follow server/processes/shared.js: only a genuinely
 * un-cuttable part (bigger than the bed) FAILS; everything else informs or warns.
 */
const { summarizeChecks } = require("../shared");

// Techno HD-II: 59" × 96" bed, 12" under the gantry. Usable sheet is 48" × 96".
const BED_X_MM = 2438;   // 96"
const BED_Y_MM = 1499;   // 59"
const BED_Z_MM = 300;    // 12"
const SHEET_PLATE_LIMIT_MM = 25.4;   // over 1" the part is really a milling job
const STD_TOOL_DIA_MM = 6.35;        // 1/4" — default profile tool
const SMALL_TOOL_DIA_MM = 3.175;     // 1/8" — on request
const MIN_TOOL_DIA_MM = 1.6;         // 1/16" — small parts / tight corners

function run(geometry, options = {}) {
  const checks = [];
  const bb = geometry.boundingBox || {};
  const dims = [bb.width || 0, bb.height || 0, bb.depth || 0].sort((a, b) => a - b);
  const [thick, mid, long] = dims;
  const selectedThickness = Number(options.thicknessMm) || 0;
  const flatW = geometry.flatWidth || mid;
  const flatH = geometry.flatHeight || long;

  // 1. Fits the bed (hard limit — either orientation)
  const fitsBed =
    (Math.max(flatW, flatH) <= BED_X_MM && Math.min(flatW, flatH) <= BED_Y_MM) && thick <= BED_Z_MM;
  checks.push({
    id: "rt-bed-size",
    label: "Router Bed Size",
    pass: fitsBed,
    severity: fitsBed ? "pass" : "fail",
    detail: fitsBed
      ? `Part footprint ${flatW.toFixed(0)} × ${flatH.toFixed(0)} mm fits the 59" × 96" bed`
      : `Part footprint ${flatW.toFixed(0)} × ${flatH.toFixed(0)} mm exceeds the 59" × 96" (1499 × 2438 mm) bed — split the part or send it as an RFQ`,
  });

  // 2. Is this a sheet/plate part?
  const isSheetPart = thick > 0 && thick <= SHEET_PLATE_LIMIT_MM && mid >= thick * 2;
  checks.push({
    id: "rt-sheet-geometry",
    label: "Sheet / Plate Geometry",
    pass: isSheetPart,
    severity: isSheetPart ? "pass" : "warn",
    detail: isSheetPart
      ? `Thickness ${thick.toFixed(1)} mm with a ${mid.toFixed(0)} × ${long.toFixed(0)} mm footprint — good router part`
      : thick > SHEET_PLATE_LIMIT_MM
        ? `Smallest dimension is ${thick.toFixed(1)} mm (over 1"). This is a milling job — select CNC Machining for a better price and finish`
        : `Part is not clearly flat (${thick.toFixed(1)} × ${mid.toFixed(1)} × ${long.toFixed(1)} mm). Routing works for 2.5D parts; 3D surfaces should go to CNC Machining`,
  });

  // 3. Selected thickness vs. model thickness
  if (selectedThickness > 0 && thick > 0) {
    const delta = Math.abs(selectedThickness - thick);
    const ok = delta <= Math.max(0.6, thick * 0.12);
    checks.push({
      id: "rt-thickness-match",
      label: "Stock Thickness Match",
      pass: ok,
      severity: ok ? "pass" : "warn",
      detail: ok
        ? `Selected ${selectedThickness.toFixed(2)} mm stock matches the model (${thick.toFixed(2)} mm)`
        : `Model is ${thick.toFixed(2)} mm thick but ${selectedThickness.toFixed(2)} mm stock is selected. Pockets or a facing pass may be needed — pick the closest stock or confirm in the notes`,
    });
  }

  // 4. Inside-corner radius from tool diameter
  checks.push({
    id: "rt-corner-radius",
    label: "Inside Corner Radius",
    pass: true,
    severity: "info",
    detail: `Inside corners carry the tool radius: ${(STD_TOOL_DIA_MM / 2).toFixed(2)} mm with the standard 1/4" tool, ${(SMALL_TOOL_DIA_MM / 2).toFixed(2)} mm with 1/8", ${(MIN_TOOL_DIA_MM / 2).toFixed(1)} mm with 1/16" on thin stock. Square inside corners need a dog-bone or overcut`,
  });

  // 5. Narrow slots / small features
  const slots = geometry.estimatedSlots || 0;
  if (slots > 0) {
    checks.push({
      id: "rt-slot-width",
      label: "Slot Width",
      pass: true,
      severity: "info",
      detail: `${slots} slot(s) detected. Slots narrower than ${STD_TOOL_DIA_MM.toFixed(2)} mm (1/4") are cut with a smaller tool at lower feed — small cost adder`,
    });
  }

  // 6. Thin webs — plastics flex and chatter below ~2.5 mm web width
  const minWeb = 2.5;
  const estWall = geometry.estimatedThickness || 0;
  if (estWall > 0 && estWall < thick) {
    const ok = estWall >= minWeb;
    checks.push({
      id: "rt-thin-web",
      label: "Thin Webs",
      pass: ok,
      severity: ok ? "pass" : "warn",
      detail: ok
        ? `Smallest web ≈ ${estWall.toFixed(2)} mm — rigid enough to cut cleanly`
        : `Smallest web ≈ ${estWall.toFixed(2)} mm. Webs under ${minWeb} mm in plastic flex and tear out; expect a note from us or widen the feature`,
    });
  }

  // 7. Small-part retention
  const footprint = Math.max(flatW, flatH);
  if (footprint > 0 && footprint < 40) {
    checks.push({
      id: "rt-small-part",
      label: "Small Part Retention",
      pass: true,
      severity: "info",
      detail: `Footprint under 40 mm — parts are held with tabs or an onion-skin and de-tabbed by hand. Expect a small witness mark on one edge; tell us if a face must be mark-free`,
    });
  }

  // 8. Holes
  const holes = geometry.estimatedHoles || 0;
  if (holes > 0) {
    checks.push({
      id: "rt-holes",
      label: "Holes",
      pass: true,
      severity: "info",
      detail: `${holes} hole(s) detected. Holes ≥ ${STD_TOOL_DIA_MM.toFixed(2)} mm are interpolated to size; smaller holes are drilled. Tapped holes are done offline — note the thread size`,
    });
  }

  // 9. Tolerance capability
  checks.push({
    id: "rt-tolerance",
    label: "Tolerance Capability",
    pass: true,
    severity: "info",
    detail: `Profile tolerance ±0.13 mm (±0.005") typical. Large HDPE/UHMW parts move with temperature — call out critical dimensions on the drawing and we hold them at 68 °F`,
  });

  // 10. Nesting
  const kerf = 6;
  const pw = flatW + kerf, ph = flatH + kerf;
  const perSheet = pw > 0 && ph > 0
    ? Math.max(Math.floor(1219 / pw) * Math.floor(2438 / ph), Math.floor(1219 / ph) * Math.floor(2438 / pw))
    : 0;
  checks.push({
    id: "rt-nesting",
    label: "Nesting",
    pass: true,
    severity: "info",
    detail: perSheet > 0
      ? `About ${perSheet} part(s) per 48" × 96" sheet. Quantities that fill whole sheets price best`
      : `Part is larger than a single 48" × 96" sheet footprint — oversize stock or a split is needed`,
  });

  return { checks, summary: summarizeChecks(checks) };
}

module.exports = { run };
