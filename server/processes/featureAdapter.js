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

module.exports = { getFeatures, fromLegacy, normaliseMeasured, emptyFeatures, extents, PAD_MM };
