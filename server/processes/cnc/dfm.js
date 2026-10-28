/**
 * CNC DFM — milling and turning on the Tormach 1100, CNC Bridgeport and lathes.
 * Signature: run(geometry, options).
 *   options.subProcess   "milling" | "turning"
 *   options.materialType "plastic" | "metal" (plastics get a thicker minimum wall)
 */
const { summarizeChecks } = require("../shared");

function run(geometry, options = {}) {
  const checks = [];
  const subProcess = options.subProcess || "milling"; // "milling" or "turning"
  const bbox = geometry.boundingBox;
  const width = bbox.width;
  const height = bbox.height;
  const depth = bbox.depth;
  const volume = geometry.volume;
  const boundingVolume = width * height * depth;
  const volumeRatio = boundingVolume > 0 ? volume / boundingVolume : 0;

  // 1. Minimum wall thickness
  const minWallThickness = options.materialType === "plastic" ? 1.5 : 0.8;
  const estimatedMinWall = geometry.estimatedThickness;
  checks.push({
    id: "cnc-min-wall-thickness",
    label: "Minimum Wall Thickness",
    pass: estimatedMinWall >= minWallThickness,
    severity: estimatedMinWall >= minWallThickness ? "pass" : "warn",
    detail: estimatedMinWall >= minWallThickness
      ? `Estimated wall thickness ${estimatedMinWall.toFixed(2)}mm exceeds minimum (${minWallThickness}mm)`
      : `Estimated wall thickness ${estimatedMinWall.toFixed(2)}mm below recommended minimum (${minWallThickness}mm)`,
  });

  // 2. Machine envelope — Tormach 1100 / CNC Bridgeport travel (X 457 × Y 241 × Z 300 mm);
  //    turning: Ø 250 × 600 mm between centers. Any orientation is allowed.
  const sorted = [width, height, depth].sort((a, b) => b - a); // long → short
  let fitsEnvelope, envelopeText;
  if (subProcess === "turning") {
    const latheMaxDia = 250, latheMaxLen = 600;
    fitsEnvelope = sorted[0] <= latheMaxLen && sorted[1] <= latheMaxDia;
    envelopeText = `lathe capacity (Ø${latheMaxDia} × ${latheMaxLen} mm)`;
  } else {
    const millX = 457, millY = 241, millZ = 300;
    fitsEnvelope = sorted[0] <= millX && sorted[1] <= millY && sorted[2] <= millZ;
    envelopeText = `mill travel (${millX} × ${millY} × ${millZ} mm)`;
  }
  checks.push({
    id: "cnc-max-size",
    label: "Machine Envelope",
    pass: fitsEnvelope,
    severity: fitsEnvelope ? "pass" : "warn",
    detail: fitsEnvelope
      ? `Part (${width.toFixed(0)} × ${height.toFixed(0)} × ${depth.toFixed(0)} mm) fits ${envelopeText}`
      : `Part (${width.toFixed(0)} × ${height.toFixed(0)} × ${depth.toFixed(0)} mm) exceeds ${envelopeText}. Flat parts this size route well — otherwise send it as an RFQ`,
  });

  // 3. Internal corner radius (tool access)
  const minCornerRadius = 1.0;
  checks.push({
    id: "cnc-corner-radius",
    label: "Internal Corner Radius",
    pass: true,
    severity: "info",
    detail: `Verify all internal corners have minimum radius ≥ ${minCornerRadius}mm to allow tool access`,
  });

  // 4. Deep pocket ratio (depth-to-width)
  const maxRatio = 4;
  const avgHorizontalDim = Math.max((width + height) / 2, 0.1);
  const depthToWidthRatio = depth / avgHorizontalDim;
  checks.push({
    id: "cnc-pocket-ratio",
    label: "Pocket Depth-to-Width Ratio",
    pass: depthToWidthRatio <= maxRatio,
    // Advisory: uses overall bbox proportions, not measured pockets.
    severity: depthToWidthRatio <= maxRatio ? "pass" : "info",
    detail: depthToWidthRatio <= maxRatio
      ? `Depth-to-width ratio ${depthToWidthRatio.toFixed(2)}:1 is acceptable (< ${maxRatio}:1)`
      : `High depth-to-width ratio ${depthToWidthRatio.toFixed(2)}:1. Recommend ≤ ${maxRatio}:1 to avoid tool deflection and chatter`,
  });

  // 5. Undercut detection (from normal analysis)
  // Count downward-facing triangles as potential undercut indicators
  let downwardTriangles = 0;
  // This is estimated from geometry — exact count would need normal array access
  // Using heuristic: high aspect ratio + significant volume suggest complex geometry
  const hasComplexGeometry = geometry.estimatedBends > 2 || geometry.estimatedSlots > 1;
  const estimatedUndercutRisk = hasComplexGeometry ? "high" : "low";
  checks.push({
    id: "cnc-undercut",
    label: "Undercut Detection",
    pass: !hasComplexGeometry,
    // Advisory: derived from coarse feature estimates, so it informs, not blocks/warns.
    severity: estimatedUndercutRisk === "high" ? "info" : "pass",
    detail: estimatedUndercutRisk === "high"
      ? `Complex geometry detected (${geometry.estimatedBends} bends, ${geometry.estimatedSlots} slots). Verify no undercuts block tool access`
      : `Geometry appears to have low undercut risk`,
  });

  // 6. Thin tall feature detection
  const minHorizontalDim = Math.min(width, height);
  const aspectRatio = depth / Math.max(minHorizontalDim, 0.1);
  checks.push({
    id: "cnc-thin-tall-features",
    label: "Thin Tall Features",
    pass: aspectRatio <= 5,
    severity: aspectRatio <= 5 ? "pass" : "warn",
    detail: aspectRatio <= 5
      ? `Aspect ratio ${aspectRatio.toFixed(2)}:1 acceptable for rigid machining`
      : `High aspect ratio ${aspectRatio.toFixed(2)}:1. Tall thin features may chatter or deflect. Recommend support structures`,
  });

  // 7. Material removal estimate (volume ratio)
  checks.push({
    id: "cnc-removal-efficiency",
    label: "Material Removal Efficiency",
    pass: volumeRatio >= 0.3,
    // Never blocks: volumeRatio depends on a watertight volume we can't guarantee.
    severity: volumeRatio >= 0.3 ? "pass" : "warn",
    detail: volumeRatio >= 0.3
      ? `Part volume ${(volumeRatio * 100).toFixed(1)}% of bounding box — efficient machining`
      : `Part volume ${(volumeRatio * 100).toFixed(1)}% of bounding box. Heavy stock removal may be expensive`,
  });

  // 8. Tool access for narrow features
  checks.push({
    id: "cnc-tool-access",
    label: "Tool Access",
    pass: true,
    severity: "info",
    detail: `Verify clearance for cutting tools in all cavities. Minimum feature width should allow standard endmill access`,
  });

  // 9. Tolerance specification
  checks.push({
    id: "cnc-tolerance",
    label: "Tolerance Capability",
    pass: true,
    severity: "info",
    detail: `Standard ±0.005" (±0.13 mm) on plastics, ±0.002" on metals. Call out the features that need tighter and we hold those`,
  });

  // 10. Process-specific checks
  if (subProcess === "turning") {
    const roughlyAxial = Math.abs(depth - width) < Math.max(depth, width) * 0.2 ||
                          Math.abs(depth - height) < Math.max(depth, height) * 0.2;
    checks.push({
      id: "cnc-turning-geometry",
      label: "Turning-Suitable Geometry",
      pass: roughlyAxial,
      severity: roughlyAxial ? "pass" : "warn",
      detail: roughlyAxial
        ? `Part appears suitable for turning (cylindrical-like proportions)`
        : `Part may not be ideal for turning. Recommend milling for this geometry`,
    });
  }

  return {
    checks,
    summary: summarizeChecks(checks),
  };
}

module.exports = { run };
