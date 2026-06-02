/**
 * 3D printing DFM. Moved verbatim from fileParser.runPrintingDFM.
 * Signature: run(geometry, options).
 */
const { summarizeChecks } = require("../shared");

function run(geometry, options = {}) {
  const checks = [];
  const subProcess = options.subProcess || "fdm"; // "fdm", "sla", or "sls"
  const bbox = geometry.boundingBox;
  const width = bbox.width;
  const height = bbox.height;
  const depth = bbox.depth;
  const volume = geometry.volume;
  const boundingVolume = width * height * depth;
  const volumeRatio = boundingVolume > 0 ? volume / boundingVolume : 0;

  // Process-specific thresholds
  const processThresholds = {
    fdm: { minWall: 0.8, maxX: 300, maxY: 300, maxZ: 400, tolerance: "Â±0.5mm", warping: true },
    sla: { minWall: 0.5, maxX: 145, maxY: 145, maxZ: 175, tolerance: "Â±0.1mm", warping: false },
    sls: { minWall: 0.7, maxX: 300, maxY: 300, maxZ: 300, tolerance: "Â±0.3mm", warping: false },
  };
  const thresh = processThresholds[subProcess] || processThresholds.fdm;

  // 1. Minimum wall thickness — warn (not block): estimatedThickness is a
  //    bounding-box proxy, not a true measured wall, so it must not gate ordering.
  const wallOk = geometry.estimatedThickness >= thresh.minWall;
  checks.push({
    id: "print-min-wall",
    label: "Minimum Wall Thickness",
    pass: wallOk,
    severity: wallOk ? "pass" : "warn",
    detail: wallOk
      ? `Estimated wall ${geometry.estimatedThickness.toFixed(2)}mm meets ${subProcess.toUpperCase()} minimum (${thresh.minWall}mm)`
      : `Estimated thinnest section ${geometry.estimatedThickness.toFixed(2)}mm is near/below the ${subProcess.toUpperCase()} guideline (${thresh.minWall}mm). Thin walls may print but can be fragile — verify before ordering.`,
  });

  // 2. Build volume check
  const fitsVolume = width <= thresh.maxX && height <= thresh.maxY && depth <= thresh.maxZ;
  checks.push({
    id: "print-build-volume",
    label: "Build Platform Fit",
    pass: fitsVolume,
    severity: fitsVolume ? "pass" : "fail",
    detail: fitsVolume
      ? `Part (${width.toFixed(0)}Ã${height.toFixed(0)}Ã${depth.toFixed(0)}mm) fits ${subProcess.toUpperCase()} build platform (${thresh.maxX}Ã${thresh.maxY}Ã${thresh.maxZ}mm)`
      : `Part exceeds ${subProcess.toUpperCase()} build volume. X: ${width.toFixed(0)}/${thresh.maxX}, Y: ${height.toFixed(0)}/${thresh.maxY}, Z: ${depth.toFixed(0)}/${thresh.maxZ}mm`,
  });

  // 3. Overhang detection — real, area-weighted fraction of down-facing surface
  //    >45° (computed from geometry normals). Overhangs are always makeable with
  //    support, so this warns (cost/cleanup) for FDM/SLA and is informational for
  //    SLS (self-supporting in powder). Never blocks.
  const hasOverhangMetric = Number.isFinite(geometry.overhangFraction);
  const overhangPercent = hasOverhangMetric ? geometry.overhangFraction * 100 : null;
  const needsSupports = subProcess === "fdm" || subProcess === "sla";
  let overhangCheck;
  if (!hasOverhangMetric) {
    overhangCheck = {
      severity: "info",
      detail: needsSupports
        ? `${subProcess.toUpperCase()} may need supports for steep overhangs — couldn't measure overhang area for this file.`
        : `SLS is self-supporting; overhangs are not a concern.`,
    };
  } else if (!needsSupports) {
    overhangCheck = {
      severity: "info",
      detail: `${overhangPercent.toFixed(0)}% of the surface is down-facing, but SLS is self-supporting — no support material needed.`,
    };
  } else {
    const heavy = overhangPercent > 40;
    overhangCheck = {
      severity: heavy ? "warn" : "pass",
      detail: heavy
        ? `${overhangPercent.toFixed(0)}% of the surface overhangs >45°. ${subProcess.toUpperCase()} will need significant support material — adds cost and cleanup. Consider reorienting.`
        : `${overhangPercent.toFixed(0)}% of the surface overhangs >45° — modest support needs for ${subProcess.toUpperCase()}.`,
    };
  }
  checks.push({
    id: "print-overhang",
    label: "Overhang Surfaces (>45°)",
    pass: overhangCheck.severity === "pass",
    severity: overhangCheck.severity,
    detail: overhangCheck.detail,
  });

  // 5. Small feature fidelity — advisory only (bounding-box thickness proxy,
  //    so it informs rather than warns/blocks).
  const featureSize = geometry.estimatedThickness;
  const featuresCrisp = featureSize >= 1.0;
  checks.push({
    id: "print-small-features",
    label: "Small Feature Fidelity",
    pass: featuresCrisp,
    severity: featuresCrisp ? "pass" : "info",
    detail: featureSize >= 1.0
      ? `Features â¥ ${featureSize.toFixed(2)}mm will print crisply`
      : featureSize >= 0.5
      ? `Fine features (${featureSize.toFixed(2)}mm). Consider thicker walls for strength`
      : `Features too small (${featureSize.toFixed(2)}mm) for reliable printing`,
  });

  // 6. Bridging — informational. We can't reliably measure unsupported horizontal
  //    spans from the mesh summary, so this is FDM-only guidance, not a measurement.
  if (subProcess === "fdm") {
    checks.push({
      id: "print-bridge-length",
      label: "Bridging",
      pass: true,
      severity: "info",
      detail: `If your design has unsupported horizontal spans wider than ~20mm, FDM may sag without supports. SLA/SLS are unaffected.`,
    });
  }

  // 7. Part volume efficiency (hollow vs solid) — advisory (affects cost, not makeability)
  const efficient = volumeRatio >= 0.3;
  checks.push({
    id: "print-volume-efficiency",
    label: "Volume Efficiency",
    pass: efficient,
    severity: efficient ? "pass" : "info",
    detail: efficient
      ? `Part is ${(volumeRatio * 100).toFixed(0)}% of its bounding box — efficient to print.`
      : `Part is ${(volumeRatio * 100).toFixed(0)}% of its bounding box. Lower infill or hollowing can cut material and time.`,
  });

  // 8. Dimensional accuracy — capability note (informational)
  checks.push({
    id: "print-tolerance",
    label: "Dimensional Accuracy",
    pass: true,
    severity: "info",
    detail: `${subProcess.toUpperCase()} typical tolerance: ${thresh.tolerance}. Finer tolerances available with post-processing.`,
  });

  // 9. Warping risk (FDM-specific)
  if (subProcess === "fdm") {
    const flatSurfaceRisk = width * height > 5000; // Large flat base
    checks.push({
      id: "print-fdm-warping",
      label: "Warping Risk (FDM)",
      pass: !flatSurfaceRisk,
      severity: flatSurfaceRisk ? "warn" : "pass",
      detail: flatSurfaceRisk
        ? `Large flat base (${(width * height).toFixed(0)}mmÂ²) may warp. Use brim or raft for adhesion`
        : `Warping risk is low for this geometry`,
    });
  }

  // 10. Island detection (SLA-specific)
  if (subProcess === "sla") {
    checks.push({
      id: "print-sla-islands",
      label: "Isolated Regions (SLA)",
      pass: true,
      severity: "info",
      detail: `For SLA, verify no isolated islands float in early layers. If your model is a single connected solid, this isn't a concern.`,
    });
  }

  return {
    checks,
    summary: summarizeChecks(checks),
  };
}

module.exports = { run };
