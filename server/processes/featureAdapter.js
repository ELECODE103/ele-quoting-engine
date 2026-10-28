/**
 * Feature adapter — gives every pricing model one view of the part.
 *
 * `parseFile()` returns legacy scalar geometry (bounding box, volume, surface
 * area, …) and, once the geometry module ships it, `geometry.features` in the
 * shape documented in server/geometry/SCHEMA.md. Pricing codes against the
 * schema. When `features` is absent (or a field in it is null) this adapter
 * derives what it honestly can from the legacy fields and marks that field's
 * confidence "legacy" so the admin view can show what the price rests on.
 *
 * What the legacy fields give exactly (verified against the vetting library):
 *   - bounding box, volume, surface area — exact on every part.
 * What they give for a flat 2.5D part (every face parallel/perpendicular to
 * the thickness axis):
 *   - top-face area        A ≈ V / t            (exact when nothing is blind)
 *   - total edge length    P ≈ (SA − 2V/t) / t  (outer + inner, exact for
 *                          through-features; inflated by blind pockets)
 * What they give for a revolved part (turning selected):
 *   - diameter and length from the two near-equal box dimensions, bore from
 *     the volume deficit against a solid cylinder — within 1 % on the library.
 * What they cannot give: hole list, pocket list, wall thickness, access
 * directions, corner radii. `estimatedHoles` / `estimatedPerimeter` from the
 * legacy parser are normal-bucket noise and are deliberately NOT used.
 *
 * Nothing here prices. It describes, and says how sure it is.
 */

const SCHEMA_VERSION = 1;
const PLATE_MAX_THICKNESS_MM = 25.4;
const FLAT_ASPECT = 0.55;         // thickness ≤ 55 % of the next dimension → flat (up to 3/4")
const THICK_PLATE_MM = 19.05;     // between 3/4" and 1" a part is flat only when it is clearly plate-like
const THICK_PLATE_ASPECT = 0.25;
const REVOLVED_DIM_TOL = 0.06;    // two box dims within 6 % → a diameter

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => (isNum(v) && v > 0 ? v : null);

function sortedDims(bb) {
  const d = [bb.w, bb.h, bb.d].map((v) => (pos(v) ?? 0)).sort((a, b) => b - a);
  return { a: d[0], b: d[1], c: d[2] };
}

function legacyBox(geometry) {
  const bb = geometry.boundingBox || {};
  return {
    w: pos(bb.width) ?? pos(geometry.flatWidth) ?? pos(geometry.width) ?? 100,
    h: pos(bb.height) ?? pos(geometry.flatHeight) ?? pos(geometry.height) ?? 100,
    d: pos(bb.depth) ?? pos(geometry.estimatedThickness) ?? pos(geometry.depth) ?? 50,
  };
}

/**
 * Derive a revolved profile from a box + volume (used when the customer chose
 * turning and the geometry module gave no `shape.revolved`).
 */
function legacyRevolved(dims, volume) {
  const { a, b, c } = dims;
  let diameter, length;
  if (Math.abs(a - b) / a <= REVOLVED_DIM_TOL) { diameter = a; length = c; }          // disc / short bushing
  else if (Math.abs(b - c) / b <= REVOLVED_DIM_TOL) { diameter = b; length = a; }     // long shaft / roller
  else { diameter = b; length = a; }                                                  // best guess: long axis is the length
  const solid = (Math.PI / 4) * diameter * diameter * length;
  let boreDiameter = null;
  if (isNum(volume) && volume > 0 && solid > volume && length > 0) {
    const boreArea = (solid - volume) / length;
    const d = Math.sqrt((4 * boreArea) / Math.PI);
    if (d >= 1.5 && d < diameter * 0.97) boreDiameter = d;
  }
  return { axis: null, maxDiameter: diameter, length, minDiameter: diameter, boreDiameter, segments: null };
}

/**
 * Build the pricing view of a part.
 *
 * @param {Object} geometry — parsed geometry (legacy fields, maybe `features`)
 * @param {Object} [opts]
 * @param {string} [opts.subProcess] — "turning" selects the revolved view when the shape is unknown
 * @param {number} [opts.thicknessMm] — stock thickness the customer chose (routing)
 * @returns {{ f: Object, derived: Object, source: "features"|"legacy"|"mixed", confidence: Object, notes: string[] }}
 */
function resolveFeatures(geometry = {}, opts = {}) {
  const feat = geometry.features && typeof geometry.features === "object" ? geometry.features : null;
  const notes = [];
  const fieldConfidence = {};   // field → number 0..1 | "legacy"
  const mark = (field, conf) => { fieldConfidence[field] = conf; };

  // ── extents ──────────────────────────────────────────────────────────────
  const aabb = feat?.aabb && pos(feat.aabb.w) && pos(feat.aabb.h) && pos(feat.aabb.d) ? { ...feat.aabb } : legacyBox(geometry);
  const obb = feat?.obb && pos(feat.obb.w) && pos(feat.obb.h) && pos(feat.obb.d)
    ? { w: feat.obb.w, h: feat.obb.h, d: feat.obb.d, axes: feat.obb.axes || null }
    : (() => { const s = sortedDims(aabb); return { w: s.a, h: s.b, d: s.c, axes: null }; })();
  mark("extents", feat?.obb ? 1 : "legacy");
  const dims = sortedDims(obb);

  let volume = pos(feat?.volume) ?? pos(geometry.volume) ?? null;
  const bboxVolume = dims.a * dims.b * dims.c;
  if (volume === null || volume > bboxVolume * 1.001) {
    volume = volume === null ? bboxVolume * 0.5 : bboxVolume;
    notes.push("Part volume missing or larger than its bounding box; using a box estimate.");
    mark("volume", 0.2);
  } else mark("volume", 1);
  let surfaceArea = pos(feat?.surfaceArea) ?? pos(geometry.surfaceArea) ?? null;
  if (surfaceArea === null) {
    surfaceArea = 2 * (dims.a * dims.b + dims.a * dims.c + dims.b * dims.c);
    notes.push("Surface area missing; using the bounding-box surface.");
    mark("surfaceArea", 0.2);
  } else mark("surfaceArea", 1);

  // ── shape ─────────────────────────────────────────────────────────────────
  const wantRevolved = String(opts.subProcess || "").toLowerCase() === "turning";
  let shape;
  if (feat?.shape?.kind) {
    shape = { ...feat.shape, profile: { ...(feat.shape.profile || {}) } };
    mark("shape", isNum(feat.confidence?.shape) ? feat.confidence.shape : 0.8);
    if (wantRevolved && !shape.revolved) {
      shape.revolved = legacyRevolved(dims, volume);
      notes.push("Turning selected but no revolved profile was recognised; diameter, length and bore derived from the bounding box and volume.");
      mark("revolved", "legacy");
    } else if (shape.revolved) mark("revolved", fieldConfidence.shape);
  } else {
    const flat = (dims.c <= THICK_PLATE_MM + 0.05 && dims.c <= FLAT_ASPECT * dims.b)
      || (dims.c <= PLATE_MAX_THICKNESS_MM && dims.c <= THICK_PLATE_ASPECT * dims.b);
    shape = {
      kind: wantRevolved ? "revolved" : flat ? "flat" : "prismatic",
      primaryAxis: null,
      is25D: null,
      stockThickness: flat ? dims.c : null,
      profile: {},
      revolved: wantRevolved ? legacyRevolved(dims, volume) : null,
    };
    mark("shape", "legacy");
    if (wantRevolved) mark("revolved", "legacy");
  }

  // ── flat-part profile: outer / inner edge length and top area ─────────────
  // Legacy derivation assumes the outline is the bounding rectangle (so a disc
  // reads 4 % long and a gear 30 % short on the outer loop) and books the rest
  // of the edge-equivalent length as inner contours.
  // The model's own thickness (thinnest box dimension) drives the edge-length
  // derivation; the stock thickness the customer picked is a pricing input.
  const thickness = pos(shape.stockThickness) ?? dims.c;
  // ── features ──────────────────────────────────────────────────────────────
  const holes = Array.isArray(feat?.holes) ? feat.holes.filter((h) => pos(h.diameter)) : null;
  const pockets = Array.isArray(feat?.pockets) ? feat.pockets.filter((pk) => pos(pk.area) && pos(pk.depth)) : null;
  const slots = Array.isArray(feat?.slots) ? feat.slots : null;
  mark("holes", holes ? (isNum(feat.confidence?.holes) ? feat.confidence.holes : 0.8) : "legacy");
  mark("pockets", pockets ? (isNum(feat.confidence?.pockets) ? feat.confidence.pockets : 0.8) : "legacy");
  if (!holes) notes.push("No hole list: holes are priced only through the surface and edge length they add (legacy parser hole counts are not trusted).");

  // ── edge length, top area and blind removal ───────────────────────────────
  // For a flat part the surface area splits into two faces plus edges:
  //   SA = 2·A_top + E·t  where E is the through-feature-equivalent edge length.
  // A blind pocket of volume x inflates E by 2x/t² (its floor and walls read
  // as extra edge). The two readings cannot be separated from scalars alone,
  // so the legacy split is: x = the pocket reading, capped by the removal the
  // part actually shows; the inner edge is whatever x does not explain. That
  // never double-counts volume; a feature list makes the split exact.
  const envelopeRemoval = Math.max(0, bboxVolume - volume);
  const derived = {};
  let blindRemoval;
  {
    const p = shape.profile;
    const rectPerimeter = 2 * (dims.a + dims.b);
    const t = thickness;
    const naiveTop = t > 0 ? Math.min(volume / t, dims.a * dims.b) : dims.a * dims.b;
    const edgeEquiv = t > 0 ? Math.max(0, (surfaceArea - 2 * naiveTop) / t) : rectPerimeter;
    const excess = Math.max(0, edgeEquiv - rectPerimeter);
    if (pockets) {
      blindRemoval = pockets.reduce((s, pk) => s + pk.area * pk.depth, 0);
      mark("blindRemoval", fieldConfidence.pockets);
    } else if (shape.kind === "flat" && t > 0) {
      blindRemoval = Math.min(envelopeRemoval, (excess * t * t) / 2);
      mark("blindRemoval", "legacy");
    } else {
      blindRemoval = null;
      mark("blindRemoval", "legacy");
    }
    const x = blindRemoval || 0;
    const innerEst = t > 0 ? Math.max(0, excess - (2 * x) / (t * t)) : 0;
    const topAreaEst = t > 0 ? Math.min((volume + x) / t, dims.a * dims.b) : dims.a * dims.b;
    // Profile fields only matter for flat parts; a block's missing outline is
    // not a legacy fallback, just unused.
    const profileConf = (filled) => (shape.kind === "flat" ? (filled ? fieldConfidence.shape : "legacy") : (filled ? fieldConfidence.shape : 1));
    if (!pos(p.perimeter)) { p.perimeter = rectPerimeter; mark("profile.perimeter", profileConf(false)); } else mark("profile.perimeter", profileConf(true));
    if (!isNum(p.innerPerimeter)) { p.innerPerimeter = innerEst; mark("profile.innerPerimeter", profileConf(false)); } else mark("profile.innerPerimeter", profileConf(true));
    if (!pos(p.area)) { p.area = topAreaEst; mark("profile.area", profileConf(false)); }
    if (!pos(p.bboxW)) p.bboxW = dims.a;
    if (!pos(p.bboxH)) p.bboxH = dims.b;
    if (!isNum(p.minInternalRadius)) p.minInternalRadius = null;
    if (!isNum(p.minSlotWidth)) p.minSlotWidth = null;
    derived.edgeEquivalentMm = edgeEquiv;
    derived.topAreaEstimateMm2 = topAreaEst;
  }
  derived.bboxVolumeMm3 = bboxVolume;
  derived.envelopeRemovalMm3 = envelopeRemoval;
  derived.blindRemovalMm3 = blindRemoval;
  derived.volumeRatio = bboxVolume > 0 ? volume / bboxVolume : 1;

  // ── walls / access / corners ──────────────────────────────────────────────
  const walls = feat?.walls && (isNum(feat.walls.minThickness) || isNum(feat.walls.tallThinMaxAspect)) ? { ...feat.walls } : null;
  mark("walls", walls ? (isNum(feat.confidence?.walls) ? feat.confidence.walls : 0.7) : "legacy");

  let access;
  if (feat?.access && isNum(feat.access.minSetups3Axis)) {
    access = { ...feat.access };
    mark("access", 0.8);
  } else {
    // Flat parts and revolved parts are one setup; a block that keeps most of
    // its envelope is one setup; a hollowed block usually needs a second.
    let minSetups3Axis = 1;
    if (shape.kind === "prismatic" || shape.kind === "freeform") minSetups3Axis = derived.volumeRatio < 0.35 ? 2 : 1;
    access = { directions: null, minSetups3Axis, undercutAreaFraction: null };
    mark("access", "legacy");
  }

  const cornerRadii = feat?.cornerRadii ? { ...feat.cornerRadii } : { minInternalVertical: null, minInternalFloor: null };

  // ── printing ──────────────────────────────────────────────────────────────
  let overhang;
  if (feat?.overhang && (isNum(feat.overhang.supportVolumeEstimate) || isNum(feat.overhang.areaFraction45))) {
    overhang = { ...feat.overhang };
    mark("overhang", 0.8);
  } else {
    const frac = isNum(geometry.overhangFraction) ? Math.min(1, Math.max(0, geometry.overhangFraction)) : 0;
    // Overhanging area × half the part height ≈ the column of support under it.
    overhang = { areaFraction45: frac, maxAngleFromVertical: null, supportVolumeEstimate: frac * surfaceArea * 0.5 * dims.c };
    mark("overhang", "legacy");
  }

  const f = {
    schemaVersion: feat?.schemaVersion ?? SCHEMA_VERSION,
    source: feat?.source ?? null,
    mesh: feat?.mesh ?? null,
    aabb, obb, volume, surfaceArea, shape,
    holes: holes || [],
    pockets: pockets || [],
    slots: slots || [],
    bosses: feat?.bosses || [],
    fillets: feat?.fillets ?? null,
    chamfers: feat?.chamfers ?? null,
    text: feat?.text ?? null,
    walls, access, cornerRadii, overhang,
    bridging: feat?.bridging ?? null,
    stock: feat?.stock ?? null,
    confidence: feat?.confidence ?? null,
    notes: [...(feat?.notes || []), ...notes],
  };

  const legacyFields = Object.entries(fieldConfidence).filter(([, c]) => c === "legacy").map(([k]) => k);
  const source = !feat ? "legacy" : legacyFields.length ? "mixed" : "features";
  const numeric = Object.values(fieldConfidence).filter(isNum);
  const overall = feat
    ? (isNum(feat.confidence?.overall) ? feat.confidence.overall : numeric.length ? numeric.reduce((s, v) => s + v, 0) / numeric.length : 0.5)
    : 0.35;

  return {
    f,
    derived,
    source,
    confidence: { source, overall: Number(overall.toFixed(2)), fields: fieldConfidence, legacyFields },
    notes: f.notes,
  };
}

/** Material class for the rate card, from the record or its category. */
function materialClassOf(material = {}) {
  if (material.materialClass) return material.materialClass;
  const cat = String(material.category || "").toLowerCase();
  if (/alumin/.test(cat)) return "aluminum";
  if (/brass|copper|bronze/.test(cat)) return "brass";
  if (/steel|stainless|iron/.test(cat)) return "steel";
  if (/composite|g-?10|phenolic|fr-?4/.test(cat)) return "composite";
  return "plastic";
}

module.exports = { resolveFeatures, materialClassOf, legacyRevolved, PLATE_MAX_THICKNESS_MM };
