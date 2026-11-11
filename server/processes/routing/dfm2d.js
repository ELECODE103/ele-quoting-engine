/**
 * Routing DFM for 2D input (DXF). Called from ./dfm.js when the features came
 * from a drawing rather than a solid.
 *
 * The shared routing rules already cover everything that depends on the tool
 * and the stock — inside-corner radius, slot width, hole size vs thickness,
 * thin webs, bed size, small-part retention — because the DXF is extruded to
 * the selected thickness into the same `features` object (geometry/dxf).
 * This module adds what only a drawing can get wrong, and tells the preview
 * where each problem is:
 *
 *   rt-dxf-contours      open contours / gaps, branching lines          FAIL (with gap + location)
 *   rt-dxf-intersections a contour crossing itself or another contour   FAIL
 *   rt-dxf-duplicates    duplicate / overlapping entities               WARN minor (removed for pricing)
 *   rt-dxf-slivers       closed loops with no area                      WARN minor (ignored for pricing)
 *   rt-dxf-units         drawing units and resulting size               INFO (WARN until confirmed)
 *   rt-dxf-scope         what a 2D file cannot say + what was skipped   INFO
 *
 * Severity follows shared.js: only what cannot be cut as drawn fails. An open
 * or self-crossing contour has no inside, so there is no toolpath — that
 * blocks; a duplicate line is something we remove, so it warns.
 *
 * `locations` on a check ([{ x, y, note }], mm from the lower-left of the
 * drawing) is an optional field the 2D preview uses to mark the spot.
 */
const { check, COST, mm } = require("../dfmKit");

const at = (p) => (p ? `X ${p[0].toFixed(1)}, Y ${p[1].toFixed(1)} mm` : "an unknown position");
const loc = (p, note) => ({ x: p[0], y: p[1], note });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const inch = (v) => (v / 25.4).toFixed(2);

function run2d(geometry, ctx = {}) {
  const p = geometry && geometry.profile2d;
  if (!p) return [];
  const checks = [];
  const withLoc = (rec, locations) => { if (locations && locations.length) rec.locations = locations.slice(0, 40); return rec; };

  // 1. Closed contours
  const open = p.problems.filter((x) => x.code === "open-contour");
  const junctions = p.problems.filter((x) => x.code === "junction");
  if (open.length || junctions.length) {
    const gaps = open.filter((x) => x.gap != null).sort((a, b) => b.gap - a.gap);
    const first = gaps[0] || open[0] || junctions[0];
    const parts = [];
    if (gaps.length) parts.push(`${plural(gaps.length, "gap", "gaps")} — the largest is ${mm(gaps[0].gap, 2)} at ${at(gaps[0].at)}`);
    const loose = open.length - gaps.length;
    if (loose > 0) parts.push(`${plural(loose, "loose end", "loose ends")} that meet nothing (first at ${at(open.find((x) => x.gap == null).at)})`);
    if (junctions.length) parts.push(`${plural(junctions.length, "point", "points")} where three or more lines meet (first at ${at(junctions[0].at)})`);
    checks.push(withLoc(check({
      id: "rt-dxf-contours", label: "Closed Contours", severity: "fail", cost: COST.MAJOR, confidence: 1, measured: gaps[0] ? gaps[0].gap : null, threshold: p.tolerances.weldMm, unit: "mm",
      detail: `The drawing is not a set of closed loops: ${parts.join("; ")}. Positions are measured from the lower-left corner of the drawing. The router needs every contour closed to know which side of the line is the part. Join the endpoints in CAD (AutoCAD: PEDIT → Join or OVERKILL; Fusion: fix the open sketch profile before exporting) and upload again — the price shown is an estimate from the outline's bounding size`,
    }), [...open.map((x) => loc(x.at, x.gap != null ? `gap ${x.gap.toFixed(2)} mm` : "loose end")), ...junctions.map((x) => loc(x.at, "3+ lines meet"))]));
    void first;
  } else {
    checks.push(check({ id: "rt-dxf-contours", label: "Closed Contours", severity: "pass", confidence: 1, measured: p.closedCount,
      detail: `${plural(p.closedCount, "contour", "contours")}, all closed (endpoints within ${p.tolerances.weldMm} mm are joined): 1 outer profile, ${plural(p.holes.length, "round hole", "round holes")}, ${plural(p.cutoutCount - p.holes.length, "other cutout", "other cutouts")}` }));
  }

  // 2. Crossings
  const selfX = p.problems.filter((x) => x.code === "self-intersection");
  const crossX = p.problems.filter((x) => x.code === "crossing");
  if (selfX.length || crossX.length) {
    const bits = [];
    if (selfX.length) bits.push(`a contour crosses itself at ${at(selfX[0].at)}${selfX.length > 1 ? ` and ${selfX.length - 1} more place(s)` : ""}`);
    if (crossX.length) bits.push(`two contours cross each other at ${at(crossX[0].at)}${crossX.length > 1 ? ` and ${crossX.length - 1} more place(s)` : ""}`);
    checks.push(withLoc(check({
      id: "rt-dxf-intersections", label: "Crossing Contours", severity: "fail", cost: COST.MAJOR, confidence: 1, measured: selfX.length + crossX.length,
      detail: `${bits.join("; ")}. Where lines cross there is no single inside and outside, so the cut side is undefined. Trim the lines at the crossing so each loop is simple (a cutout that runs off the edge should be drawn as part of the outer profile) and upload again`,
    }), [...selfX, ...crossX].map((x) => loc(x.at, x.code === "crossing" ? "contours cross" : "crosses itself"))));
  }

  // 3. Duplicates / overlaps
  const dup = p.cleaned.duplicates + p.cleaned.overlaps;
  if (dup > 0) {
    const marks = p.problems.filter((x) => x.code === "duplicate" || x.code === "overlap");
    checks.push(withLoc(check({
      id: "rt-dxf-duplicates", label: "Duplicate Geometry", severity: "warn", cost: COST.MINOR, confidence: 1, measured: dup,
      detail: `${plural(p.cleaned.duplicates, "duplicate entity", "duplicate entities")} and ${plural(p.cleaned.overlaps, "overlapping line", "overlapping lines")} (first at ${at(marks[0] && marks[0].at)}). Stacked lines would be cut twice — a burned, undersized edge — so we removed them for the price and will cut each path once. Run OVERKILL (AutoCAD) or delete the copies so the file matches what gets cut`,
    }), marks.map((x) => loc(x.at, x.code === "overlap" ? "overlapping lines" : "duplicate"))));
  }

  // 4. Zero-area loops
  if (p.cleaned.slivers > 0) {
    const marks = p.problems.filter((x) => x.code === "sliver");
    checks.push(withLoc(check({
      id: "rt-dxf-slivers", label: "Zero-Area Loops", severity: "warn", cost: COST.MINOR, confidence: 1, measured: p.cleaned.slivers,
      detail: `${plural(p.cleaned.slivers, "closed loop has", "closed loops have")} no area (first at ${at(marks[0] && marks[0].at)}) — usually a line traced back over itself. A router cannot cut a zero-width line: the narrowest cut is the cutter diameter. They are left out of the price; delete them, or if a slit is intended draw it as a slot at least ${ctx.reachTool ? `${ctx.reachTool.dia.toFixed(2)} mm` : "one cutter diameter"} wide`,
    }), marks.map((x) => loc(x.at, "zero-area loop"))));
  }

  // 5. Units
  const u = p.units;
  const size = `${p.bbox.w.toFixed(1)} × ${p.bbox.h.toFixed(1)} mm (${inch(p.bbox.w)} × ${inch(p.bbox.h)} in)`;
  const unitName = { mm: "millimetres", in: "inches", cm: "centimetres", m: "metres", ft: "feet" }[u.unit] || u.unit;
  if (u.needsConfirmation) {
    checks.push(check({ id: "rt-dxf-units", label: "Drawing Units", severity: "warn", cost: COST.MAJOR, confidence: 1,
      detail: `Units are not confirmed: ${u.reason}. Read as ${unitName} the part is ${size}; read the other way it is ${u.unit === "in" ? `${u.sizeIfMm.w.toFixed(1)} × ${u.sizeIfMm.h.toFixed(1)} mm` : `${u.sizeIfInch.w.toFixed(0)} × ${u.sizeIfInch.h.toFixed(0)} mm (${(u.sizeIfInch.w / 25.4).toFixed(2)} × ${(u.sizeIfInch.h / 25.4).toFixed(2)} in)`}. Choose inches or millimetres above the preview — there is no price until you do` }));
  } else {
    checks.push(check({ id: "rt-dxf-units", label: "Drawing Units", severity: "info", confidence: "n/a",
      detail: `Drawn in ${unitName} (${u.reason}). The part is ${size} — check that against your drawing; switch units above the preview if it is wrong` }));
  }

  // 6. What a 2D file cannot say, and what was skipped
  const skipped = [];
  for (const [type, n] of Object.entries(p.ignored.entityTypes || {})) skipped.push(`${n} ${type}`);
  for (const l of p.ignored.layers || []) skipped.push(`${plural(l.count, "entity", "entities")} on "${l.name}" (${l.reason})`);
  if (p.ignored.paperSpace) skipped.push(`${p.ignored.paperSpace} in paper space`);
  if (p.ignored.nonPlanar) skipped.push(`${p.ignored.nonPlanar} not in the XY plane`);
  if (p.ignored.unknownBlocks) skipped.push(`${p.ignored.unknownBlocks} block reference(s) we could not resolve`);
  const thicknessBit = ctx.provisional
    ? "Select a stock thickness to get a price and the tool-reach checks (corner radius, slot width, hole depth)"
    : `Thickness ${Number(ctx.thickness).toFixed(2)} mm comes from the stock you selected`;
  checks.push(check({ id: "rt-dxf-scope", label: "2D Drawing", severity: "info", confidence: "n/a", measured: p.ignored.total,
    detail: `${thicknessBit}. Every contour is cut through; a DXF cannot describe pockets, countersinks, chamfers, tapped holes or engraving — put those in the order notes or upload a STEP file`
      + (p.layers && p.layers.length ? `. Cut layers: ${p.layers.slice(0, 6).map((l) => `"${l}"`).join(", ")}` : "")
      + (skipped.length ? `. Not cut: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", …" : ""} — if any of that should be cut, move it to a cut layer with a continuous linetype` : "")
      + (p.approxCurves ? `. ${plural(p.approxCurves, "spline/ellipse is", "splines/ellipses are")} cut as short segments within ±${p.tolerances.flattenMm} mm of the curve` : "") }));

  return checks;
}

/**
 * Add `locations` to the shared routing checks so the preview can mark the
 * corner, slot, web or hole each one is talking about. Only non-clean results
 * are marked (a pass with no cost has nothing to point at).
 */
function annotate(checks, geometry, ctx = {}) {
  const p = geometry && geometry.profile2d;
  if (!p) return checks;
  const flagged = (c) => c.severity === "warn" || c.severity === "fail" || (c.cost && c.cost !== COST.NONE);
  for (const c of checks) {
    if (!flagged(c)) continue;
    let marks = null;
    if (c.id === "rt-corner-radius") {
      marks = p.minInternalRadius === 0 && p.sharpCorners.length
        ? p.sharpCorners.map((q) => loc(q, "sharp inside corner"))
        : p.minInternalRadiusAt ? [loc(p.minInternalRadiusAt, `inside corner R ${p.minInternalRadius.toFixed(2)} mm`)] : null;
    } else if (c.id === "rt-slot-width" && p.minSlotWidthAt) {
      marks = [loc(p.minSlotWidthAt, `${p.minSlotWidth.toFixed(2)} mm wide`)];
    } else if (c.id === "rt-thin-web" && p.minWebAt) {
      marks = [loc(p.minWebAt, `web ${p.minWeb.toFixed(2)} mm`)];
    } else if (c.id === "rt-holes" && c.severity === "warn") {
      const t = Number(ctx.thickness) || 0;
      marks = p.holes.filter((h) => h.diameter < 1.5875 || h.diameter < t * 0.5).map((h) => loc(h.center, `Ø${h.diameter.toFixed(2)} mm`));
    }
    if (marks && marks.length) c.locations = marks.slice(0, 40);
  }
  return checks;
}

/** DFM result for a 2D file on a process that cannot use it. */
function notRoutable(processName) {
  const c = check({ id: "dxf-2d-file", label: "2D File", severity: "fail", cost: COST.MAJOR, confidence: 1,
    detail: `A DXF is a flat outline with no thickness, so it can only be quoted for CNC routing (sheet and plate cut on the router). Switch the process to CNC routing, or upload a STEP, STL, IGES or 3MF model to quote ${processName || "this process"}` });
  return [c];
}

module.exports = { run2d, annotate, notRoutable };
