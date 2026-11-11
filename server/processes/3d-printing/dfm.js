/**
 * 3D printing DFM — FDM (up to 12 × 12 × 24") and Formlabs SLA (~6 × 6 × 7") in-house; SLS
 * rules kept for the outsourced option. Signature: run(geometry, options) → { checks, summary }
 *   options.subProcess "fdm" | "sla" | "sls"
 *   options.materialSlug / materialName / material (fdm-abs, sla-standard, …)
 *
 * Rules consume `features` (server/geometry/SCHEMA.md) via the feature adapter. Only a part
 * that cannot be printed FAILS: bigger than the build volume in every orientation, a
 * non-manifold mesh, or zero-thickness geometry measured at high confidence. Thresholds and
 * sources: docs/dfm-standards.md §3D printing (Hubs design-rules table, Formlabs Form 3 design
 * specs, UZH FDM guideline, Protolabs).
 */
const { summarizeChecks } = require("../shared");
const { check, COST, mm, dia, ratio, num, materialProfile, isLegacy, meshIntegrity } = require("../dfmKit");
const { getFeatures, extents } = require("../featureAdapter");

const P = {
  fdm: {
    build: [610, 305, 305],          // 24 × 12 × 12" — sorted long → short, any orientation
    wall: { supported: 0.8, unsupported: 1.0 },   // Hubs 0.8 / UZH 1.0
    overhang: 45, bridge: 10, bridgeVisible: 5,   // Hubs
    hole: 2.0, pin: 3.0, feature: 2.0, clearance: 0.5,
    text: { stroke: 0.6, height: 2.0 },           // Hubs embossed 0.6 w × 2 h
    tolerance: "±0.5% (floor ±0.5 mm)",
    escapeHole: null,
    supportHeavy: 0.4, supportVolMajor: 0.3,
  },
  sla: {
    build: [178, 152, 152],          // ~7 × 6 × 6"
    wall: { supported: 0.5, unsupported: 1.0 },   // Hubs (Formlabs 0.2 mm floor on supported walls)
    overhang: 10, bridge: 21, bridgeVisible: 21,  // Formlabs: ≥10° from level unsupported; Hubs bridge 21 mm
    unsupportedOverhang: 5.0,                     // Formlabs 5 mm max unsupported overhang length
    hole: 0.5, pin: 0.5, feature: 0.2, clearance: 0.5,
    text: { stroke: 0.4, height: 0.4 },           // Hubs 0.4 (Formlabs 0.1 emboss / 0.15 engrave)
    tolerance: "±0.2% (floor ±0.15 mm)",
    escapeHole: 3.5,                              // Formlabs ≥2.5 mm; Hubs 4 mm — shop uses 3.5
    supportHeavy: 0.4, supportVolMajor: 0.3,
  },
  sls: {
    build: [300, 300, 300],
    wall: { supported: 0.7, unsupported: 0.7 },
    overhang: null, bridge: null, bridgeVisible: null,
    hole: 1.5, pin: 0.8, feature: 0.8, clearance: 0.3,
    text: { stroke: 1.0, height: 1.0 },
    tolerance: "±0.3% (floor ±0.3 mm)",
    escapeHole: 5.0,
    supportHeavy: null, supportVolMajor: null,
  },
};
const ZERO = 0.05;
const WARP_AREA = { prone: 5000, normal: 15000 }; // mm² of flat base

function run(geometry, options = {}) {
  const subProcess = ["fdm", "sla", "sls"].includes(options.subProcess) ? options.subProcess : "fdm";
  const p = P[subProcess];
  const PROC = subProcess.toUpperCase();
  const mat = materialProfile(options);
  const { features: f, conf } = getFeatures(geometry, { ...options, subProcess });
  const checks = [];
  const ext = extents(f);
  const { long, mid, thin } = ext;
  const vol = num(f.volume);
  const bboxVol = (f.aabb.w || 0) * (f.aabb.h || 0) * (f.aabb.d || 0);
  const volumeRatio = vol != null && bboxVol > 0 ? vol / bboxVol : 0;

  checks.push(...meshIntegrity("print", f, conf));

  // 1. Minimum wall thickness
  const minWall = num(f.walls.minThickness);
  if (minWall != null) {
    const legacy = isLegacy(conf.walls);
    const rec = p.wall.supported;
    let severity = "pass", cost = COST.NONE, detail;
    if (!legacy && minWall <= ZERO) {
      severity = "fail"; cost = COST.MAJOR;
      detail = `Thinnest wall measures ${mm(minWall, 2)} — zero-thickness geometry that the slicer drops. Fix the model so every wall is ≥ ${p.wall.unsupported} mm`;
    } else if (minWall < rec) {
      severity = "warn"; cost = mat.flexible ? COST.MINOR : COST.MINOR;
      detail = legacy
        ? `Estimated thinnest section ${mm(minWall, 2)} is near/below the ${PROC} guideline (${rec} mm). Thin walls may print but can be fragile — verify before ordering`
        : `Thinnest wall ${mm(minWall, 2)} is under the ${PROC} minimum of ${rec} mm (${p.wall.unsupported} mm for a free-standing wall). It prints as a single fragile perimeter or drops out; thicken to ≥ ${p.wall.unsupported} mm${subProcess === "fdm" ? " (a multiple of the 0.4 mm line width prints cleanest)" : ""}`;
    } else if (!legacy && minWall < p.wall.unsupported) {
      severity = "pass"; cost = COST.MINOR;
      detail = `Thinnest wall ${mm(minWall, 2)} meets the ${rec} mm supported-wall minimum; if it is free-standing use ≥ ${p.wall.unsupported} mm`;
    } else {
      detail = legacy
        ? `Estimated wall ${mm(minWall, 2)} meets ${PROC} minimum (${rec} mm)`
        : `Thinnest wall ${mm(minWall, 2)} meets the ${PROC} minimum (${rec} mm)`;
    }
    checks.push(check({ id: "print-min-wall", label: "Minimum Wall Thickness", severity, cost, detail, confidence: conf.walls, measured: minWall, threshold: rec, unit: "mm", ref: "Hubs/Formlabs/UZH" }));
  }
  const thinFrac = num(f.walls.thinAreaFraction);
  if (thinFrac != null && thinFrac > 0.2) {
    checks.push(check({ id: "print-thin-area", label: "Thin-Section Area", severity: "warn", cost: COST.MINOR, confidence: conf.walls, measured: thinFrac, threshold: 0.2,
      detail: `${(thinFrac * 100).toFixed(0)}% of the surface sits on sections under 1 mm. Expect a flexible, easily cracked part; thicken or orient the thin faces vertically` }));
  }

  // 2. Build volume (any orientation)
  const dims = [long, mid, thin];
  const fitsVolume = dims.every((d, i) => d <= p.build[i]);
  const fitsOther = subProcess === "sla" && dims.every((d, i) => d <= P.fdm.build[i]);
  checks.push(check({ id: "print-build-volume", label: "Build Platform Fit", severity: fitsVolume ? "pass" : "fail", cost: fitsVolume ? COST.NONE : COST.MAJOR, confidence: conf.extents, measured: dims, threshold: p.build,
    detail: fitsVolume
      ? `Part (${long.toFixed(0)} × ${mid.toFixed(0)} × ${thin.toFixed(0)} mm) fits the ${PROC} build volume (${p.build.join(" × ")} mm) in at least one orientation`
      : `Part (${long.toFixed(0)} × ${mid.toFixed(0)} × ${thin.toFixed(0)} mm) exceeds the ${PROC} build volume (${p.build.join(" × ")} mm) in every orientation. ${fitsOther ? "It fits the FDM printer — switch process, or " : ""}Split it with a joint (dowel or tongue) or send an RFQ` }));

  // 3. Overhangs and support
  const frac = num(f.overhang.areaFraction45);
  const maxAngle = num(f.overhang.maxAngleFromVertical);
  const supVol = num(f.overhang.supportVolumeEstimate);
  const needsSupports = subProcess === "fdm" || subProcess === "sla";
  if (frac == null) {
    checks.push(check({ id: "print-overhang", label: "Overhang Surfaces (>45°)", severity: "info", confidence: conf.overhang,
      detail: needsSupports
        ? `${PROC} may need supports for steep overhangs — couldn't measure overhang area for this file.`
        : `SLS is self-supporting; overhangs are not a concern.` }));
  } else if (!needsSupports) {
    checks.push(check({ id: "print-overhang", label: "Overhang Surfaces (>45°)", severity: "info", confidence: conf.overhang, measured: frac,
      detail: `${(frac * 100).toFixed(0)}% of the surface is down-facing, but SLS is self-supporting — no support material needed.` }));
  } else {
    const heavy = frac > p.supportHeavy;
    const supMajor = supVol != null && vol != null && vol > 0 && supVol / vol > p.supportVolMajor;
    checks.push(check({ id: "print-overhang", label: "Overhang Surfaces (>45°)", severity: heavy ? "warn" : "pass", cost: heavy || supMajor ? COST.MAJOR : frac > 0.15 ? COST.MINOR : COST.NONE, confidence: conf.overhang, measured: frac, threshold: p.supportHeavy, ref: "Hubs 45°; Formlabs",
      detail: heavy
        ? `${(frac * 100).toFixed(0)}% of the surface overhangs more than 45°${maxAngle != null ? ` (steepest ${maxAngle.toFixed(0)}° from vertical)` : ""}. ${PROC} will need significant support material${supVol != null && vol ? ` (~${(100 * supVol / vol).toFixed(0)}% of the part volume)` : ""} — adds print time, cleanup and support scars. Reorient so the largest flat face is down, chamfer overhangs to 45°, or split the part`
        : `${(frac * 100).toFixed(0)}% of the surface overhangs >45° — ${frac > 0.15 ? "modest" : "minimal"} support needs for ${PROC}${subProcess === "sla" ? " (SLA parts are always supported; surfaces facing the build plate carry support marks)" : ""}` }));
  }

  // 4. Bridging
  const span = f.bridging && num(f.bridging.maxSpan) != null ? f.bridging.maxSpan : null;
  if (subProcess !== "sls") {
    if (span == null) {
      if (subProcess === "fdm") {
        checks.push(check({ id: "print-bridge-length", label: "Bridging", severity: "info", confidence: conf.bridging, threshold: p.bridge, ref: "Hubs",
          detail: `If your design has unsupported horizontal spans wider than ~${p.bridge} mm, FDM sags without supports (visible sag starts at ~${p.bridgeVisible} mm). SLA/SLS are unaffected.` }));
      }
    } else {
      const over = span > p.bridge;
      checks.push(check({ id: "print-bridge-length", label: "Bridging", severity: over ? "warn" : "pass", cost: over ? COST.MINOR : COST.NONE, confidence: conf.bridging, measured: span, threshold: p.bridge, unit: "mm", ref: subProcess === "fdm" ? "Hubs 10 mm" : "Hubs 21 mm / Formlabs 29 mm",
        detail: over
          ? `Longest unsupported span is ${mm(span, 0)}; ${PROC} bridges cleanly to ${p.bridge} mm. Beyond that it sags or needs supports under the span (marks on the underside). Add a support rib, chamfer the span into a 45° arch, or accept supports`
          : `Longest unsupported span ${mm(span, 0)} bridges without supports (≤ ${p.bridge} mm)${subProcess === "fdm" && span > p.bridgeVisible ? ", with slight sag on the underside" : ""}` }));
    }
  }

  // 5. Holes
  if (f.holes.length > 0) {
    let tiny = null, undersize = 0;
    for (const h of f.holes) {
      const d = num(h.diameter);
      if (d == null) continue;
      if (d < p.hole && (tiny == null || d < tiny)) tiny = d;
      if (d < 10) undersize++;
    }
    checks.push(check({ id: "print-min-hole", label: "Hole Diameter", severity: tiny != null ? "warn" : "pass", cost: tiny != null ? COST.MINOR : COST.NONE, confidence: conf.holes, measured: tiny != null ? tiny : f.holes.length, threshold: p.hole, unit: "mm", ref: "Hubs/Formlabs",
      detail: tiny != null
        ? `Smallest hole ${dia(tiny, 2)} is under the ${p.hole} mm ${PROC} minimum — it closes up or prints as a blob. Open it to ≥ ${p.hole} mm, or model it as a dimple and drill after printing`
        : `${f.holes.length} hole(s), all ≥ ${p.hole} mm. ${subProcess === "fdm" ? `Vertical holes print ~0.2–0.5 mm undersize; ${undersize ? `the ${undersize} under 10 mm ` : ""}should be drilled or reamed for a fit` : subProcess === "sla" ? "Holes print within ±0.15 mm; ream for press fits" : "Holes come out slightly small from powder — drill for fits"}` }));
  }

  // 6. Pins / bosses
  if (f.bosses.length > 0) {
    let thinPin = null, lanky = null;
    for (const b of f.bosses) {
      const d = num(b.diameter), h = num(b.height);
      if (d == null) continue;
      if (d < p.pin && (thinPin == null || d < thinPin.d)) thinPin = { d, h };
      if (h != null && d > 0 && h / d > 10 && (lanky == null || h / d > lanky.r)) lanky = { d, h, r: h / d };
    }
    checks.push(check({ id: "print-pins", label: "Pins & Bosses", severity: thinPin || lanky ? "warn" : "pass", cost: thinPin || lanky ? COST.MINOR : COST.NONE, confidence: conf.bosses, measured: thinPin ? thinPin.d : f.bosses.length, threshold: p.pin, unit: "mm", ref: "Hubs/UZH 3 mm FDM; Formlabs wires",
      detail: thinPin
        ? `A ${dia(thinPin.d, 2)} pin is under the ${p.pin} mm ${PROC} minimum — it snaps off at the base or prints as a stub. Thicken to ≥ ${p.pin} mm and add a fillet at the root, or print a hole and press in a metal pin`
        : lanky
          ? `A ${dia(lanky.d, 1)} × ${mm(lanky.h, 0)} pin is ${ratio(lanky.r, 0)} its diameter tall; it wobbles while printing and bends in use. Shorten it, thicken it, or support it with a rib`
          : `${f.bosses.length} pin(s)/boss(es), all ≥ ${p.pin} mm — print reliably` }));
  }

  // 7. Small feature fidelity
  let minFeature = null;
  for (const s of f.slots) { const w = num(s.width); if (w != null && (minFeature == null || w < minFeature)) minFeature = w; }
  if (minFeature == null && isLegacy(conf.slots) && minWall != null) minFeature = minWall; // legacy proxy
  if (minFeature != null) {
    const legacy = isLegacy(conf.slots);
    const crisp = minFeature >= Math.max(p.feature, 1.0);
    checks.push(check({ id: "print-small-features", label: "Small Feature Fidelity", severity: crisp ? "pass" : legacy ? "info" : "warn", cost: crisp ? COST.NONE : COST.MINOR, confidence: conf.slots, measured: minFeature, threshold: p.feature, unit: "mm", ref: "Hubs/UZH",
      detail: crisp
        ? `Features ≥ ${mm(minFeature, 2)} will print crisply on ${PROC}`
        : minFeature >= p.feature
          ? `Fine features (${mm(minFeature, 2)}). They print on ${PROC} but are fragile — consider ≥ 1 mm`
          : `Smallest feature ${mm(minFeature, 2)} is under the ${p.feature} mm ${PROC} minimum — it will blur or break off. Enlarge it${subProcess === "fdm" ? ", or switch to SLA (0.2 mm detail)" : ""}` }));
  }

  // 8. Embossed / engraved text
  if (f.text && f.text.present) {
    const stroke = num(f.text.minStroke);
    const ok = stroke == null || stroke >= p.text.stroke;
    checks.push(check({ id: "print-text", label: "Embossed / Engraved Text", severity: ok ? "pass" : "warn", cost: COST.NONE, confidence: conf.text, measured: stroke, threshold: p.text.stroke, unit: "mm", ref: "Hubs/Formlabs",
      detail: ok
        ? `Text stroke ${stroke != null ? mm(stroke, 2) : "(not measured)"} meets the ${p.text.stroke} mm ${PROC} minimum (raise/recess it ≥ ${p.text.height} mm)`
        : `Text stroke ${mm(stroke, 2)} is under the ${p.text.stroke} mm ${PROC} minimum; it fills in. Use a bolder font with ≥ ${p.text.stroke} mm strokes and ≥ ${p.text.height} mm relief` }));
  }

  // 9. Assemblies / clearance
  const bodies = f.legacy && num(f.legacy.bodyCount);
  if (bodies != null && bodies > 1) {
    checks.push(check({ id: "print-clearance", label: "Assembly Clearance", severity: "warn", cost: COST.MINOR, confidence: 1.0, measured: bodies, threshold: p.clearance, unit: "mm", ref: "Hubs",
      detail: `File contains ${bodies} bodies. Parts printed together need ≥ ${p.clearance} mm clearance (${subProcess === "sls" ? "0.1 mm for fixed joints" : "0.5 mm for moving joints"}) or they fuse; touching bodies print as one solid. Separate them, or confirm the gaps in the notes` }));
  }

  // 10. Hollow parts / escape holes (SLA cupping, SLS powder)
  if (p.escapeHole != null && volumeRatio > 0 && volumeRatio < 0.35 && minWall != null && minWall < 6) {
    checks.push(check({ id: "print-escape-holes", label: "Hollow Sections / Drain Holes", severity: "info", cost: COST.NONE, confidence: conf.extents, threshold: p.escapeHole, unit: "mm", ref: subProcess === "sla" ? "Formlabs ≥2.5 mm; Hubs 4 mm" : "Hubs 5 mm",
      detail: `Part looks shell-like (${(volumeRatio * 100).toFixed(0)}% of its box). If any cavity is enclosed, add ≥ ${p.escapeHole} mm drain holes (two, at the lowest points) so ${subProcess === "sla" ? "resin drains and cupping does not blow out the wall" : "powder can be removed"}; otherwise we print it solid or ask` }));
  }

  // 11. Volume efficiency (cost only)
  const efficient = volumeRatio >= 0.3;
  checks.push(check({ id: "print-volume-efficiency", label: "Volume Efficiency", severity: efficient ? "pass" : "info", cost: COST.NONE, confidence: conf.extents, measured: volumeRatio, threshold: 0.3,
    detail: efficient
      ? `Part is ${(volumeRatio * 100).toFixed(0)}% of its bounding box — efficient to print.`
      : `Part is ${(volumeRatio * 100).toFixed(0)}% of its bounding box. Lower infill or hollowing can cut material and time.` }));

  // 12. Tall thin walls (wobble / peel forces)
  const aspect = num(f.walls.tallThinMaxAspect);
  if (aspect != null && !isLegacy(conf.walls) && aspect > 20 && minWall != null && minWall < 1.5) {
    checks.push(check({ id: "print-tall-thin", label: "Tall Thin Walls", severity: "warn", cost: COST.MINOR, confidence: conf.walls, measured: aspect, threshold: 20, ref: "shop",
      detail: `A wall is ${ratio(aspect, 0)} its thickness tall. On ${PROC} it ${subProcess === "sla" ? "flexes under peel forces and prints wavy" : "wobbles with the nozzle and shows layer ripple"}; add a rib or thicken it` }));
  }

  // 13. Warping (FDM, material aware)
  if (subProcess === "fdm") {
    const base = (f.aabb.w || 0) * (f.aabb.h || 0);
    const limit = mat.warpProne ? WARP_AREA.prone : WARP_AREA.normal;
    const risk = base > limit;
    checks.push(check({ id: "print-fdm-warping", label: "Warping Risk (FDM)", severity: risk ? "warn" : "pass", cost: risk ? COST.MINOR : COST.NONE, confidence: conf.extents, measured: base, threshold: limit, unit: "mm²", ref: "Hubs (ABS/nylon warp)",
      detail: risk
        ? `Large flat base (${base.toFixed(0)} mm²) in ${mat.label}${mat.warpProne ? ", which shrinks and lifts at the corners" : ""} may warp. We print with a brim/raft and an enclosure; rounded corners and a thinner base help${mat.hygroscopic ? ". Nylon is printed from dried filament" : ""}`
        : `Warping risk is low for this geometry in ${mat.label}` }));
  }

  // 14. SLA islands / orientation
  if (subProcess === "sla") {
    checks.push(check({ id: "print-sla-islands", label: "Isolated Regions (SLA)", severity: "info", confidence: "n/a", ref: "Formlabs",
      detail: `For SLA, verify no isolated islands float in early layers and no unsupported overhang runs longer than ${p.unsupportedOverhang} mm or shallower than ${p.overhang}° from level. If your model is a single connected solid, PreForm's supports handle it; we orient so cosmetic faces carry no support marks` }));
  }

  // 15. Dimensional accuracy
  checks.push(check({ id: "print-tolerance", label: "Dimensional Accuracy", severity: "info", confidence: "n/a", ref: "Hubs",
    detail: `${PROC} typical tolerance: ${p.tolerance}. Finer tolerances available with post-machining of the critical features.` }));

  return { checks, summary: summarizeChecks(checks) };
}

module.exports = { run, THRESHOLDS: P };
