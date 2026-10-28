/**
 * Feature adapter — gives the DFM rules a `features` object (server/geometry/SCHEMA.md)
 * whether or not the geometry module has produced one yet.
 *
 *   getFeatures(geometry, options) → { features, conf }
 *
 * - If `geometry.features` exists (schemaVersion ≥ 1) it is normalised and returned with
 *   `conf` taken from `features.confidence` (numbers 0..1). Extents are always 1.0.
 * - Otherwise everything that can be derived from the legacy fields (boundingBox, volume,
 *   surfaceArea, overhangFraction, estimatedThickness, estimatedHoles/Slots/Bends,
 *   isAssembly) is derived and every derived field is marked confidence "legacy".
 *   Fields that cannot be derived are `null` (never guessed), so a rule that needs
 *   them is skipped or emitted as an advisory.
 *
 * `conf` is a flat map the rules read with conf.<name>:
 *   extents  — bbox/obb/volume: 1.0 even for legacy (bbox is exact)
 *   mesh     — manifold/watertight flags
 *   shape, holes, pockets, slots, bosses, walls, access, cornerRadii, overhang, bridging,
 *   text, revolved, profile
 */
const PAD_MM = 3; // schema default stock padding

function n(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function emptyFeatures() {
  return {
    schemaVersion: 1,
    source: null,
    mesh: { triangles: null, watertight: null, manifold: null, selfIntersections: null },
    aabb: { w: null, h: null, d: null },
    obb: { w: null, h: null, d: null, axes: null },
    volume: null,
    surfaceArea: null,
    shape: {
      kind: null, primaryAxis: null, is25D: null, stockThickness: null,
      profile: { area: null, perimeter: null, innerPerimeter: null, bboxW: null, bboxH: null, minInternalRadius: null, minSlotWidth: null },
      revolved: null,
    },
    holes: [], pockets: [], slots: [], bosses: [],
    fillets: null, chamfers: null, text: null,
    walls: { minThickness: null, p05Thickness: null, thinAreaFraction: null, tallThinMaxAspect: null },
    access: { directions: null, minSetups3Axis: null, undercutAreaFraction: null },
    cornerRadii: { minInternalVertical: null, minInternalFloor: null },
    overhang: { areaFraction45: null, maxAngleFromVertical: null, supportVolumeEstimate: null },
    bridging: null,
    stock: { block: null, bar: null, sheet: null, removalVolumeBlock: null, removalRatioBlock: null },
    confidence: { holes: 0, pockets: 0, walls: 0, shape: 0, overall: 0 },
    notes: [],
    // adapter extras (not in the schema; rules treat them as hints only)
    legacy: null,
  };
}

/** Deep-ish merge of a measured features object over the empty skeleton (keeps nulls honest). */
function normaliseMeasured(f) {
  const base = emptyFeatures();
  const out = { ...base, ...f };
  out.mesh = { ...base.mesh, ...(f.mesh || {}) };
  out.aabb = { ...base.aabb, ...(f.aabb || {}) };
  out.obb = { ...base.obb, ...(f.obb || {}) };
  out.shape = { ...base.shape, ...(f.shape || {}) };
  out.shape.profile = { ...base.shape.profile, ...((f.shape && f.shape.profile) || {}) };
  out.walls = { ...base.walls, ...(f.walls || {}) };
  out.access = { ...base.access, ...(f.access || {}) };
  out.cornerRadii = { ...base.cornerRadii, ...(f.cornerRadii || {}) };
  out.overhang = { ...base.overhang, ...(f.overhang || {}) };
  out.stock = { ...base.stock, ...(f.stock || {}) };
  out.confidence = { ...base.confidence, ...(f.confidence || {}) };
  for (const k of ["holes", "pockets", "slots", "bosses"]) out[k] = Array.isArray(f[k]) ? f[k] : [];
  out.notes = Array.isArray(f.notes) ? f.notes : [];
  // derived ratios the rules rely on
  for (const h of out.holes) {
    if (h.depthToDiaRatio == null && n(h.depth) != null && n(h.diameter) > 0) h.depthToDiaRatio = h.depth / h.diameter;
  }
  for (const p of out.pockets) {
    if (p.depthToWidthRatio == null && n(p.depth) != null && n(p.area) > 0) p.depthToWidthRatio = p.depth / Math.sqrt(p.area);
  }
  return out;
}

function confFromMeasured(f) {
  const c = f.confidence || {};
  const overall = n(c.overall) != null ? c.overall : 0.8;
  const pick = (k, fallback) => (n(c[k]) != null ? c[k] : fallback);
  return {
    extents: 1.0,
    mesh: f.mesh && f.mesh.manifold != null ? 1.0 : "legacy",
    shape: pick("shape", overall),
    profile: pick("shape", overall),
    revolved: pick("shape", overall),
    holes: pick("holes", overall),
    pockets: pick("pockets", overall),
    slots: pick("pockets", overall),
    bosses: pick("holes", overall),
    walls: pick("walls", overall),
    cornerRadii: pick("pockets", overall),
    access: pick("shape", overall),
    overhang: pick("shape", overall),
    bridging: pick("shape", overall),
    text: overall,
    stock: 1.0,
    source: "measured",
  };
}

/** Build features from the legacy geometry summary. Everything derived is "legacy". */
function fromLegacy(geometry = {}, options = {}) {
  const f = emptyFeatures();
  const bb = geometry.boundingBox || {};
  const w = n(bb.width) || 0, h = n(bb.height) || 0, d = n(bb.depth) || 0;
  const sorted = [w, h, d].sort((a, b) => b - a); // long → short
  const [long, mid, thin] = sorted;

  f.source = geometry.sourceFormat || null;
  f.mesh = {
    triangles: n(geometry.triangleCount),
    watertight: null, manifold: null, selfIntersections: null,
  };
  f.aabb = { w, h, d };
  f.obb = { w: long, h: mid, d: thin, axes: null };
  f.volume = n(geometry.volume);
  f.surfaceArea = n(geometry.surfaceArea);

  // Shape guess from proportions only.
  const subProcess = options.subProcess || "";
  const isFlat = thin > 0 && thin <= 25.4 && mid >= thin * 1.5;
  // Roughly axial = two of the three extents within 20% of each other (the diameter); the third is the length.
  const pairs = [[long, mid, thin], [long, thin, mid], [mid, thin, long]]
    .map(([a, b, c]) => ({ diff: Math.abs(a - b) / Math.max(a, b, 1e-9), dia: (a + b) / 2, len: c }))
    .sort((x, y) => x.diff - y.diff);
  const roughlyAxial = long > 0 && pairs[0].diff <= 0.2;
  let kind = isFlat ? "flat" : "prismatic";
  if (subProcess === "turning" && roughlyAxial) kind = "revolved";
  f.shape.kind = kind;
  f.shape.is25D = null;
  f.shape.stockThickness = isFlat ? thin : null;
  f.shape.profile = {
    area: isFlat && thin > 0 && f.volume != null ? Math.min(f.volume / thin, long * mid) : null,
    perimeter: n(geometry.estimatedPerimeter),
    innerPerimeter: null,
    bboxW: n(geometry.flatWidth) || long,
    bboxH: n(geometry.flatHeight) || mid,
    minInternalRadius: null,
    minSlotWidth: null,
  };
  f.shape.revolved = kind === "revolved"
    ? { axis: null, maxDiameter: pairs[0].dia, length: pairs[0].len, minDiameter: null, boreDiameter: null, segments: null }
    : null;

  // Walls: the legacy "estimatedThickness" is the thinnest bbox dimension — a proxy, not a wall.
  const est = n(geometry.estimatedThickness);
  f.walls = { minThickness: est, p05Thickness: null, thinAreaFraction: null, tallThinMaxAspect: null };
  if (thin > 0) f.walls.tallThinMaxAspect = Math.max(long, mid) / thin;

  f.overhang = { areaFraction45: n(geometry.overhangFraction), maxAngleFromVertical: null, supportVolumeEstimate: null };

  // Stock block (bbox + padding) and removal ratio.
  const bw = long + 2 * PAD_MM, bh = mid + 2 * PAD_MM, bd = thin + 2 * PAD_MM;
  const blockVol = bw * bh * bd;
  f.stock.block = { w: bw, h: bh, d: bd, volume: blockVol };
  if (f.volume != null && blockVol > 0) {
    f.stock.removalVolumeBlock = Math.max(blockVol - f.volume, 0);
    f.stock.removalRatioBlock = Math.min(Math.max(1 - f.volume / blockVol, 0), 1);
  }
  if (isFlat) f.stock.sheet = { thickness: thin, blankW: long + 2 * PAD_MM, blankH: mid + 2 * PAD_MM, area: (long + 2 * PAD_MM) * (mid + 2 * PAD_MM) };
  if (kind === "revolved") f.stock.bar = { diameter: pairs[0].dia + 2 * PAD_MM, length: pairs[0].len + 2 * PAD_MM, volume: Math.PI / 4 * (pairs[0].dia + 2 * PAD_MM) ** 2 * (pairs[0].len + 2 * PAD_MM) };

  f.confidence = { holes: 0, pockets: 0, walls: 0, shape: 0, overall: 0 };
  f.legacy = {
    estimatedHoles: n(geometry.estimatedHoles) || 0,
    estimatedSlots: n(geometry.estimatedSlots) || 0,
    estimatedBends: n(geometry.estimatedBends) || 0,
    estimatedThickness: est,
    bodyCount: n(geometry.bodyCount),
    isAssembly: !!geometry.isAssembly,
    bboxVolumeRatio: f.volume != null && w * h * d > 0 ? f.volume / (w * h * d) : null,
    warnings: Array.isArray(geometry.warnings) ? geometry.warnings : [],
  };
  f.notes.push("features derived from legacy geometry summary (bounding box + mesh totals); feature-level fields are not measured");

  const conf = {
    extents: 1.0,
    mesh: "legacy",
    shape: "legacy", profile: "legacy", revolved: "legacy",
    holes: "legacy", pockets: "legacy", slots: "legacy", bosses: "legacy",
    walls: "legacy", cornerRadii: "legacy", access: "legacy",
    overhang: n(geometry.overhangFraction) != null ? 0.7 : "legacy", // real area-weighted normal metric
    bridging: "legacy", text: "legacy", stock: 1.0,
    source: "legacy",
  };
  return { features: f, conf };
}

/**
 * Main entry. Accepts either the legacy geometry summary or one that already
 * carries `features`. Also accepts a bare features object (has schemaVersion).
 */
function getFeatures(geometry = {}, options = {}) {
  const measured = geometry && geometry.features && geometry.features.schemaVersion
    ? geometry.features
    : geometry && geometry.schemaVersion ? geometry : null;
  if (measured) {
    const features = normaliseMeasured(measured);
    // Fill extents from legacy bbox if the measured object omitted them.
    if (features.aabb.w == null && geometry.boundingBox) {
      features.aabb = { w: n(geometry.boundingBox.width), h: n(geometry.boundingBox.height), d: n(geometry.boundingBox.depth) };
    }
    if (features.obb.w == null && features.aabb.w != null) {
      const s = [features.aabb.w, features.aabb.h, features.aabb.d].sort((a, b) => b - a);
      features.obb = { w: s[0], h: s[1], d: s[2], axes: null };
    }
    if (features.volume == null) features.volume = n(geometry.volume);
    if (features.stock.block == null && features.obb.w != null) {
      const bw = features.obb.w + 2 * PAD_MM, bh = features.obb.h + 2 * PAD_MM, bd = features.obb.d + 2 * PAD_MM;
      features.stock.block = { w: bw, h: bh, d: bd, volume: bw * bh * bd };
      if (features.volume != null) features.stock.removalRatioBlock = Math.min(Math.max(1 - features.volume / (bw * bh * bd), 0), 1);
    }
    const legacyBits = fromLegacy(geometry, options).features.legacy;
    features.legacy = legacyBits;
    return { features, conf: confFromMeasured(features) };
  }
  return fromLegacy(geometry, options);
}

/** Longest → shortest extents (oriented box when available, else aabb). */
function extents(features) {
  const o = features.obb && features.obb.w != null ? features.obb : features.aabb;
  const s = [o.w || 0, o.h || 0, o.d || 0].sort((a, b) => b - a);
  return { long: s[0], mid: s[1], thin: s[2], asModelled: features.aabb };
}

// ═══════════════════════════════════════════════════════════════
// Pricing-side adapter: resolveFeatures() — per-field legacy fallback with
// confidence tags, used by the pricing models. (Both adapters consume
// SCHEMA.md features; DFM uses getFeatures(), pricing uses resolveFeatures().)
// ═══════════════════════════════════════════════════════════════
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

module.exports = {
  getFeatures, fromLegacy, normaliseMeasured, emptyFeatures, extents, PAD_MM,
  resolveFeatures, materialClassOf, legacyRevolved, PLATE_MAX_THICKNESS_MM,
};
