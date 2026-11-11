/**
 * Turning DFM rules — manual lathes, Ø250 × 600 mm capacity. Called by cnc/dfm.js when
 * options.subProcess === "turning". rules(features, conf, options) → checks[].
 *
 * Sources: Protolabs CNC turning design guidelines (min diameter/length, wall 0.5 mm,
 * radial hole ≥ 2 mm plastics, OD groove ≥ 1.2 mm), 3ERP / MakerVerse (L/D ≈ 3:1 ideal,
 * thread relief where a thread meets a shoulder), Quadrant & Boedeker (plastic tubes need
 * an internal plug when chucked; light clamping; 0.1–0.2% tolerance). Shop rules are
 * tagged "shop". Full table in docs/dfm-standards.md §Turning.
 */
const { check, COST, mm, dia, ratio, num, materialProfile, isLegacy, meshIntegrity, toleranceNote } = require("../dfmKit");
const { extents } = require("../featureAdapter");

const LATHE = { maxDia: 250, maxLen: 600 };

const T = {
  ld: { ideal: 3, tailstock: 8, major: 12 },          // 3ERP/MakerVerse ideal 3:1; shop: steady rest past 8
  wall: { plastic: 1.5, soft: 2.5, metal: 0.5, zero: 0.05 },  // Protolabs 0.5 mm metal; shop plastics
  bore: { rec: 4, long: 8, extreme: 20 },             // drill depth guidance (Hubs/Fictiv) applied to bores
  minDia: { region: 1.0, part: 4.0 },                 // Protolabs: ≥0.76 mm any region, ≥4.07 mm part
  minLen: 1.3,                                        // Protolabs 1.27 mm
  neck: { ratio: 0.2, aspect: 6 },                    // thin neck: dia < 20% of max and longer than 6× its dia
  radialHole: { plastic: 2.0, metal: 1.0 },           // Protolabs
  groove: { plastic: 1.2, metal: 0.5 },               // Protolabs OD groove width
  thread: { maxDepth: 3 },
};

function rules(f, conf, options = {}) {
  const checks = [];
  const mat = materialProfile(options);
  const ext = extents(f);
  const { long, mid, thin } = ext;
  const rev = f.shape.revolved;
  const legacyShape = isLegacy(conf.revolved);

  checks.push(...meshIntegrity("cnc", f, conf));

  // 1. Lathe capacity (Ø × length). The lathe swing (Ø250) already exceeds the mill's Y travel and
  //    its 600 mm length exceeds the mill's X, so there is no larger machine to fall back to: FAIL.
  const partDia = rev && num(rev.maxDiameter) != null ? rev.maxDiameter : mid;
  const partLen = rev && num(rev.length) != null ? rev.length : long;
  const fitsLathe = partDia <= LATHE.maxDia && partLen <= LATHE.maxLen;
  const sizeTxt = `${dia(partDia, 0)} × ${partLen.toFixed(0)} mm`;
  checks.push(check({ id: "cnc-max-size", label: "Machine Envelope", severity: fitsLathe ? "pass" : "fail", cost: fitsLathe ? COST.NONE : COST.MAJOR, confidence: conf.extents, measured: { dia: partDia, length: partLen }, threshold: LATHE,
    detail: fitsLathe
      ? `Part (${sizeTxt}) fits the lathe capacity (Ø${LATHE.maxDia} × ${LATHE.maxLen} mm)`
      : `Part (${sizeTxt}) exceeds the lathe capacity (Ø${LATHE.maxDia} × ${LATHE.maxLen} mm between centres) — nothing larger in the shop turns it. Split it at a shoulder, or send an RFQ with a drawing` }));

  // 2. Is it a turned shape?
  const revolved = f.shape.kind === "revolved";
  checks.push(check({ id: "cnc-turning-geometry", label: "Turning-Suitable Geometry", severity: revolved ? "pass" : "warn", cost: revolved ? COST.NONE : COST.MINOR, confidence: conf.shape,
    detail: revolved
      ? legacyShape
        ? `Proportions look cylindrical (${dia(partDia, 0)} × ${partLen.toFixed(0)} mm) — suitable for turning (axis of revolution not yet verified)`
        : `Part is a body of revolution (${dia(partDia, 0)} × ${partLen.toFixed(0)} mm${rev && num(rev.segments) != null ? `, ${rev.segments} diameter steps` : ""}) — a natural lathe part`
      : `Part is not a body of revolution (${long.toFixed(0)} × ${mid.toFixed(0)} × ${thin.toFixed(0)} mm). Flats, cross holes or pockets need a second milling operation; select CNC Milling for a better price unless the round features dominate` }));

  if (!revolved) {
    checks.push(toleranceNote(mat, long, "cnc-tolerance"));
    return checks;
  }

  // 3. Length-to-diameter (deflection, tailstock / steady rest)
  const ld = partDia > 0 ? partLen / partDia : null;
  if (ld != null) {
    let severity = "pass", cost = COST.NONE;
    if (ld > T.ld.major) { severity = "warn"; cost = COST.MAJOR; }
    else if (ld > T.ld.tailstock) { severity = "warn"; cost = COST.MAJOR; }
    else if (ld > T.ld.ideal) { severity = "warn"; cost = COST.MINOR; }
    checks.push(check({ id: "cnc-turn-ld-ratio", label: "Length-to-Diameter", severity, cost, confidence: conf.revolved, measured: ld, threshold: T.ld.ideal, ref: "3ERP/MakerVerse; shop",
      detail: severity === "pass"
        ? `L/D ${ratio(ld)} (${dia(partDia, 0)} × ${partLen.toFixed(0)} mm) is within the 3:1 guideline — rigid in the chuck`
        : ld > T.ld.tailstock
          ? `L/D ${ratio(ld)} (${dia(partDia, 0)} × ${partLen.toFixed(0)} mm) is well past the 3:1 guideline; beyond ${T.ld.tailstock}:1 it needs a tailstock centre plus a steady rest${mat.soft ? `, and ${mat.label} whips and goes out of round` : ""}. Options: shorten, increase the diameter, split into two parts, or accept the slower supported setup (centre mark on the end face)`
          : `L/D ${ratio(ld)} (${dia(partDia, 0)} × ${partLen.toFixed(0)} mm) is past the 3:1 guideline, so it is turned between centres with tailstock support — small adder and a centre mark on the end face unless you tell us it must be clean` }));
  }

  // 4. Tube wall thickness (bore vs OD)
  const bore = rev && num(rev.boreDiameter) != null ? rev.boreDiameter : null;
  if (bore != null && partDia > 0) {
    const wall = (partDia - bore) / 2;
    const rec = mat.isMetal ? T.wall.metal : mat.soft ? T.wall.soft : T.wall.plastic;
    let severity = "pass", cost = COST.NONE;
    if (wall <= T.wall.zero) { severity = "fail"; cost = COST.MAJOR; }
    else if (wall < rec) { severity = "warn"; cost = COST.MAJOR; }
    checks.push(check({ id: "cnc-turn-min-wall", label: "Tube Wall Thickness", severity, cost, confidence: conf.revolved, measured: wall, threshold: rec, unit: "mm", ref: "Protolabs 0.5 mm; Quadrant/Boedeker",
      detail: severity === "fail"
        ? `Bore ${dia(bore, 1)} in a ${dia(partDia, 1)} body leaves ${mm(wall, 2)} of wall — zero-thickness geometry. Fix the model`
        : severity === "warn"
          ? `Bore ${dia(bore, 1)} in a ${dia(partDia, 1)} body leaves a ${mm(wall, 2)} wall; guideline ≥ ${rec} mm for ${mat.label}. Thin tubes crush in the chuck and go out of round — we plug the bore to chuck it (Quadrant) and take light cuts. Thicken the wall or accept the adder and a roundness tolerance`
          : `Bore ${dia(bore, 1)} in a ${dia(partDia, 1)} body leaves a ${mm(wall, 2)} wall — rigid enough to chuck normally` }));
    // 5. Bore depth
    const boreDepth = partLen; // through bores run the full length; blind bores come through holes[]
    const r = bore > 0 ? boreDepth / bore : null;
    if (r != null) {
      let sev = "pass", c = COST.NONE;
      if (r > T.bore.extreme) { sev = "warn"; c = COST.MAJOR; }
      else if (r > T.bore.long) { sev = "warn"; c = COST.MAJOR; }
      else if (r > T.bore.rec) { sev = "warn"; c = COST.MINOR; }
      checks.push(check({ id: "cnc-turn-bore-depth", label: "Bore Depth-to-Diameter", severity: sev, cost: c, confidence: conf.revolved, measured: r, threshold: T.bore.rec, ref: "Hubs/Fictiv drill limits",
        detail: sev === "pass"
          ? `Bore ${dia(bore, 1)} × ${mm(boreDepth, 0)} is ${ratio(r)} diameter — drilled and bored in one setup`
          : r > T.bore.long
            ? `Bore ${dia(bore, 1)} × ${mm(boreDepth, 0)} is ${ratio(r)} diameter; past ${T.bore.long}× it needs a long-series drill or gun drill and a long boring bar that chatters${r > T.bore.extreme ? ", and beyond 20× we drill from both ends and accept a mismatch at the centre" : ""}. Options: open the bore, drill from both ends (note the allowable step), or accept the slow deep-hole adder`
            : `Bore ${dia(bore, 1)} × ${mm(boreDepth, 0)} is ${ratio(r)} diameter — past the ${T.bore.rec}× guideline, so it is peck-drilled and bored with a longer bar (small adder)` }));
    }
  } else if (f.legacy && f.legacy.estimatedHoles > 0 && isLegacy(conf.revolved)) {
    checks.push(check({ id: "cnc-turn-bore-depth", label: "Bore Depth-to-Diameter", severity: "info", cost: COST.MINOR, confidence: conf.holes, ref: "Hubs/Fictiv",
      detail: `A bore is estimated but not measured. Bores up to 4× diameter deep are routine, 8× needs a long drill and boring bar, beyond 20× we drill from both ends — call out the bore size and whether a mid-length step is acceptable` }));
  }

  // 6. Minimum diameter / thin necks / tiny parts
  const minD = rev && num(rev.minDiameter) != null ? rev.minDiameter : null;
  if (minD != null) {
    if (minD < T.minDia.region) {
      checks.push(check({ id: "cnc-turn-min-diameter", label: "Minimum Diameter", severity: "warn", cost: COST.MAJOR, confidence: conf.revolved, measured: minD, threshold: T.minDia.region, unit: "mm", ref: "Protolabs 0.76 mm",
        detail: `Smallest turned diameter is ${dia(minD, 2)}; anything under ${T.minDia.region} mm snaps under tool pressure${mat.isPlastic ? " in plastic" : ""}. Increase to ≥ ${T.minDia.region} mm or we quote it by hand` }));
    } else if (partDia > 0 && minD / partDia < T.neck.ratio && partLen / minD > T.neck.aspect) {
      checks.push(check({ id: "cnc-turn-min-diameter", label: "Thin Neck", severity: "warn", cost: COST.MINOR, confidence: conf.revolved, measured: minD / partDia, threshold: T.neck.ratio, ref: "shop",
        detail: `A ${dia(minD, 1)} neck on a ${dia(partDia, 0)} part deflects while the larger diameters are cut. We rough the neck last with light passes; a larger neck or a fillet at each shoulder helps` }));
    }
  }
  if (partDia < T.minDia.part || partLen < T.minLen) {
    checks.push(check({ id: "cnc-turn-small-part", label: "Small Turned Part", severity: "warn", cost: COST.MINOR, confidence: conf.extents, measured: { dia: partDia, length: partLen }, threshold: { dia: T.minDia.part, length: T.minLen }, ref: "Protolabs min Ø4.07 × 1.27 mm",
      detail: `${dia(partDia, 1)} × ${mm(partLen, 1)} is below our ${T.minDia.part} mm diameter / ${T.minLen} mm length comfort zone. Parts this small are made as a batch from one rod and parted off — the minimum charge dominates` }));
  }

  // 7. Radial (cross) holes and grooves — second operation
  const radial = f.holes.filter((h) => rev && Array.isArray(h.axis) && Array.isArray(rev.axis) && Math.abs(dot(h.axis, rev.axis)) < 0.5);
  if (radial.length > 0) {
    const minR = mat.isMetal ? T.radialHole.metal : T.radialHole.plastic;
    const small = radial.filter((h) => num(h.diameter) != null && h.diameter < minR);
    checks.push(check({ id: "cnc-turn-radial-holes", label: "Cross Holes", severity: small.length ? "warn" : "pass", cost: COST.MINOR, confidence: conf.holes, measured: radial.length, threshold: minR, ref: "Protolabs",
      detail: small.length
        ? `${radial.length} cross hole(s); ${small.length} under ${minR} mm (${dia(small[0].diameter, 2)}) — small drills skate on a round surface and break. Open to ≥ ${minR} mm or add a spot face. Cross holes are a second operation on the mill`
        : `${radial.length} cross hole(s) — drilled in a second operation on the mill with an indexing fixture (adds a setup)` }));
  }
  const segments = rev && num(rev.segments) != null ? rev.segments : null;
  const grooveMin = mat.isMetal ? T.groove.metal : T.groove.plastic;
  checks.push(check({ id: "cnc-turn-grooves-threads", label: "Grooves, Shoulders & Threads", severity: "info", confidence: segments != null ? conf.revolved : "n/a", measured: segments, ref: "Protolabs/MakerVerse",
    detail: `${segments != null ? `${segments} diameter step(s). ` : ""}OD grooves ≥ ${grooveMin} mm wide (ID grooves by hand quote); where a thread runs to a shoulder add a relief groove or we stop ≥ 1 pitch short; thread length ≤ ${T.thread.maxDepth}× diameter; inside corners at shoulders carry the insert nose radius (R0.4–0.8 mm) unless called out${mat.brittle ? `; ${mat.label} threads should use inserts` : ""}` }));

  // 8. Material notes relevant to turning
  if (mat.soft) {
    checks.push(check({ id: "cnc-soft-material", label: `Soft Material (${mat.label})`, severity: "info", confidence: "n/a", ref: "Quadrant/Boedeker",
      detail: `${mat.label} deforms under chuck pressure and recovers after the cut: diameters come out ±0.25 mm unless we finish with light passes on soft jaws. Call out the fits that matter` }));
  }
  if (mat.hygroscopic) {
    checks.push(check({ id: "cnc-moisture", label: "Moisture (Nylon)", severity: "info", confidence: "n/a", ref: "Boedeker/Quadrant",
      detail: `${mat.label} grows with moisture; bores close up and ODs swell by up to ~1% after machining. Specify the fit (and whether the part lives wet or dry) and we machine to it` }));
  }
  if (mat.highCost) {
    checks.push(check({ id: "cnc-material-cost", label: "High-Cost Stock", severity: "info", confidence: conf.stock,
      detail: `${mat.label} rod is the dominant cost; we start from the nearest standard rod diameter above ${dia(partDia, 0)}. Thin rings and short parts price best when batched from one rod` }));
  }
  if (mat.brittle) {
    checks.push(check({ id: "cnc-brittle-material", label: `Brittle Material (${mat.label})`, severity: "info", confidence: "n/a", ref: "Boedeker",
      detail: `${mat.label} chips at parting and at sharp shoulders. Add chamfers or radii at every step and avoid cut threads` }));
  }

  checks.push(toleranceNote(mat, partLen, "cnc-tolerance"));
  return checks;
}

function dot(a, b) {
  return (a[0] || 0) * (b[0] || 0) + (a[1] || 0) * (b[1] || 0) + (a[2] || 0) * (b[2] || 0);
}

module.exports = { rules, THRESHOLDS: T, LATHE };
