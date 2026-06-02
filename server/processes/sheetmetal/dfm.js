/**
 * Sheet metal DFM. Moved verbatim from fileParser.runSheetMetalDFM.
 * Signature kept as run(geometry, materialThicknessMm).
 */
const { summarizeChecks } = require("../shared");

function run(geometry, materialThicknessMm) {
  const checks = [];
  const thickness = materialThicknessMm || geometry.estimatedThickness;

  // 1. Minimum feature size
  const minDim = Math.min(geometry.flatWidth, geometry.flatHeight);
  checks.push({
    id: "min-feature-size",
    label: "Minimum Part Dimension",
    pass: minDim >= 3.0, // 3mm minimum
    // Warn (not block): minDim is an overall bounding-box dimension, not a feature.
    severity: minDim >= 3.0 ? "pass" : "warn",
    detail: minDim >= 3.0
      ? `Smallest dimension is ${minDim.toFixed(1)}mm â above 3mm minimum`
      : `Smallest dimension is ${minDim.toFixed(1)}mm â below 3mm minimum. Part may be too fragile.`,
  });

  // 2. Maximum part size (typical laser bed: 3000x1500mm)
  const maxDim = Math.max(geometry.flatWidth, geometry.flatHeight);
  checks.push({
    id: "max-part-size",
    label: "Maximum Part Size",
    pass: maxDim <= 3000,
    severity: maxDim <= 3000 ? "pass" : maxDim <= 4000 ? "warn" : "fail",
    detail: maxDim <= 3000
      ? `Largest dimension ${maxDim.toFixed(0)}mm fits standard sheet (3000Ã1500mm)`
      : `Largest dimension ${maxDim.toFixed(0)}mm may exceed standard sheet size`,
  });

  // 3. Hole-to-edge distance
  if (geometry.estimatedHoles > 0) {
    const minHoleEdge = thickness * 2;
    checks.push({
      id: "hole-edge-distance",
      label: "Hole-to-Edge Distance",
      pass: true, // Heuristic â can't measure exactly from mesh alone
      severity: "pass",
      detail: `${geometry.estimatedHoles} hole(s) detected. Minimum recommended distance from edge: ${minHoleEdge.toFixed(1)}mm (2Ã thickness)`,
    });
  }

  // 4. Bend feasibility
  if (geometry.estimatedBends > 0) {
    const minBendRadius = thickness; // Minimum inside bend radius = material thickness
    const bendFeasible = thickness <= 12.7; // Max 1/2" for most press brakes
    checks.push({
      id: "bend-feasibility",
      label: "Bend Feasibility",
      pass: bendFeasible,
      severity: bendFeasible ? "pass" : "fail",
      detail: bendFeasible
        ? `${geometry.estimatedBends} bend(s) detected. Min inside radius: ${minBendRadius.toFixed(1)}mm`
        : `Material too thick for standard CNC bending (${thickness.toFixed(1)}mm). Max recommended: 12.7mm`,
    });

    // Bend relief
    checks.push({
      id: "bend-relief",
      label: "Bend Relief Clearance",
      pass: null,
      severity: "info",
      detail: `Verify bend relief width â¥ ${thickness.toFixed(1)}mm and depth â¥ ${(thickness + 0.5).toFixed(1)}mm at all bend intersections`,
    });
  }

  // 5. Minimum hole diameter
  if (geometry.estimatedHoles > 0) {
    checks.push({
      id: "min-hole-diameter",
      label: "Minimum Hole Diameter",
      pass: true,
      severity: thickness <= 3.0 ? "pass" : "info",
      detail: thickness <= 3.0
        ? `Recommended min hole Ã: ${thickness.toFixed(1)}mm (= material thickness)`
        : `Thick material (${thickness.toFixed(1)}mm) â verify holes Ã â¥ ${thickness.toFixed(1)}mm for clean cuts`,
    });
  }

  // 6. Nesting clearance
  checks.push({
    id: "nesting-clearance",
    label: "Nesting Compatibility",
    pass: true,
    severity: "pass",
    detail: `Part can be nested. Estimated flat area: ${geometry.flatArea.toFixed(0)}mmÂ² (${(geometry.flatArea / 645.16).toFixed(1)} inÂ²)`,
  });

  // 7. Aspect ratio check
  const aspectRatio = maxDim / Math.max(minDim, 0.1);
  if (aspectRatio > 20) {
    checks.push({
      id: "aspect-ratio",
      label: "Aspect Ratio",
      pass: false,
      severity: "warn",
      detail: `High aspect ratio (${aspectRatio.toFixed(0)}:1). Long thin parts may warp or distort during cutting.`,
    });
  }

  return {
    checks,
    summary: summarizeChecks(checks),
  };
}

module.exports = { run };
