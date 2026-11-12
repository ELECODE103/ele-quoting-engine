/**
 * "Did we actually measure a part?" — the one rule for it, used in two places:
 *
 *   at upload     parseFile() refuses a model whose measurements are not real
 *                 numbers in a sane range, before anything is stored;
 *   at pricing    the pricing path calls assertSaneGeometry() on the stored
 *                 geometry it is about to price, so a part stored before this
 *                 rule existed is refused too.
 *
 * Why (independent review 2026-11-11, H1 and L3): one NaN or Infinity
 * coordinate turned the bounding box, area and volume into NaN, the database
 * stored those as null, and pricing then worked from empty measurements — a
 * 400 mm block that honestly quotes $3,727 and goes to a person was quoted
 * $352.04 with checkout open. A cube scaled to 2×10⁻²⁹ mm was priced at $191.
 *
 * The rule: every measurement pricing reads must be a finite number;
 *   - no coordinate further than GEOMETRY_MAX_COORD_MM from the origin
 *   - no side of the bounding box longer than GEOMETRY_MAX_EXTENT_MM
 *   - the largest side at least GEOMETRY_MIN_PART_UM (default 1 mm: a tenth of
 *     the 10 mm "too small to hold" line in the routing DFM rules, and under
 *     the smallest cutter, 1/16 in.) — nothing that small is a part made here
 *   - for a 3D model: every side at least GEOMETRY_MIN_THICKNESS_UM (0.01 mm),
 *     a positive surface area, and a positive volume that is not vanishingly
 *     small beside its bounding box (a surface with no inside, or a solid
 *     cancelled by an inside-out copy of itself)
 *   - for a DXF outline (flat, thickness chosen later): a positive width and
 *     height and at least one closed outline
 *
 * A refusal is written for the customer and offers the manual quote; it never
 * says what number was wrong (that is in the log). Legitimate files are not
 * touched: every part in the vetting library passes unchanged.
 */
const { limits } = require("../security/limits");
const brand = require("../../shared/brand.json");

const MESSAGES = {
  "geometry-not-measurable": `We couldn't measure this model: some of its coordinates are not real numbers, or it has no solid volume. Re-export it from your CAD program as a solid and upload again, or send it to us and we'll quote it by hand (${brand.email}).`,
  "geometry-out-of-range": `This model's size doesn't come out as a real part: it is far larger than anything we make, or sits very far from the origin. Check the export units and upload again, or send it to us and we'll quote it by hand (${brand.email}).`,
  "geometry-too-small": `This model comes out smaller than anything we can hold or measure. Check the export units (millimetres or inches) and upload again, or send it to us and we'll quote it by hand (${brand.email}).`,
  "too-thin-to-print": `This part is too thin or too small for our printers to make it reliably. Thicken it, or send it to us and we'll look at how it could be made (${brand.email}).`,
};

/** An error both the upload path (worker → route) and the pricing path (route) know how to show. */
function refusal(code, extra = {}) {
  const err = new Error(MESSAGES[code]);
  // `code` / `offerRfq` / `expose` are what the upload route reads; `status` / `extra` are what the pricing route reads.
  return Object.assign(err, { name: "GeometryRefused", code, offerRfq: true, expose: true, status: 422, extra: { code, offerRfq: true, ...extra } });
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** The sane coordinate range, mm. */
function ranges() {
  return {
    maxCoord: limits.geometryMaxCoordMm,
    maxExtent: limits.geometryMaxExtentMm,
    minPart: limits.geometryMinPartUm / 1000,
    minThickness: limits.geometryMinThicknessUm / 1000,
  };
}

/** Is `v` a coordinate we accept (a finite number inside the range)? */
function coordOk(v, maxCoord = limits.geometryMaxCoordMm) {
  return typeof v === "number" && v >= -maxCoord && v <= maxCoord; // NaN fails both comparisons
}

/** Is this pricing call for 3D printing? From the line's configuration; its material decides when the line does not say. */
function printing(ctx) {
  const config = ctx && ctx.config;
  if (!config || typeof config !== "object") return false;
  let process = typeof config.process === "string" ? config.process : "";
  if (!process && typeof config.materialSlug === "string") {
    try { process = (require("../models").materialsDB.getAll().find((m) => m.slug === config.materialSlug) || {}).process || ""; } catch { process = ""; }
  }
  return process === "3d-printing";
}

/**
 * Throw unless `geometry` (what a parser returned, or what a part row holds)
 * describes a part with finite, positive, sane measurements.
 * @param {object} geometry
 * @param {{ partId?: string, fileName?: string, config?: object }} [ctx] carried on the error for the pricing route;
 *        config: the quote line being priced ({ process, materialSlug }), for the checks that depend on the process
 * @returns {object} the geometry, unchanged
 */
function assertSaneGeometry(geometry, ctx = {}) {
  const extra = ctx.partId ? { partId: ctx.partId } : {};
  const fail = (code) => { throw refusal(code, extra); };
  if (!geometry || typeof geometry !== "object") fail("geometry-not-measurable");
  const r = ranges();
  const box = geometry.boundingBox;
  if (!box || typeof box !== "object") fail("geometry-not-measurable");
  const dims = [box.width, box.height, box.depth];
  if (!dims.every(finite)) fail("geometry-not-measurable");
  for (const corner of [box.min, box.max]) {
    if (!corner || ![corner.x, corner.y, corner.z].every(finite)) fail("geometry-not-measurable");
    if (![corner.x, corner.y, corner.z].every((v) => coordOk(v, r.maxCoord))) fail("geometry-out-of-range");
  }
  if (dims.some((d) => d < 0)) fail("geometry-not-measurable");
  if (dims.some((d) => d > r.maxExtent)) fail("geometry-out-of-range");

  const is2D = Boolean(geometry.profile2d && geometry.sourceFormat === "dxf");
  if (is2D) {
    // A flat outline: width and height are the part; thickness comes from the stock the buyer picks.
    const [w, h] = [box.width, box.height];
    if (!(w > 0) || !(h > 0)) fail("geometry-not-measurable");
    if (Math.max(w, h) < r.minPart) fail("geometry-too-small");
    for (const key of ["flatWidth", "flatHeight", "flatArea"]) {
      if (geometry[key] !== undefined && !(finite(geometry[key]) && geometry[key] >= 0)) fail("geometry-not-measurable");
    }
    return geometry;
  }

  if (!finite(geometry.surfaceArea) || !finite(geometry.volume)) fail("geometry-not-measurable");
  if (Math.max(...dims) < r.minPart) fail("geometry-too-small");
  if (Math.min(...dims) < r.minThickness) fail(Math.max(...dims) < 1 ? "geometry-too-small" : "geometry-not-measurable");
  if (!(geometry.surfaceArea > 0)) fail("geometry-not-measurable");
  // A closed solid fills some of its bounding box. A millionth of it (or less than a thousandth of a cubic millimetre) is no solid.
  const boxVolume = dims[0] * dims[1] * dims[2];
  if (!(geometry.volume > 0) || geometry.volume < Math.max(1e-3, boxVolume * 1e-6)) fail("geometry-not-measurable");
  // And it cannot hold more than its bounding box does: a counted volume above the box means shells
  // counted more than once (re-review 2026-11-12, RR-09: five cubes nested in one measured 5.16 boxes).
  if (geometry.volume > boxVolume * 1.001 + 1e-6) fail("geometry-not-measurable");
  // For 3D printing, when the caller says what the part is to be made by: thinner than a printer
  // makes is not a price, it is a question for a person. The thinnest side of the box, and the
  // average wall (twice the volume over the surface: a sheet's thickness, a tube's wall, a strut's radius).
  if (printing(ctx)) {
    const minWall = limits.geometryMinPrintWallUm / 1000;
    if (Math.min(...dims) < minWall || (2 * geometry.volume) / geometry.surfaceArea < minWall) fail("too-thin-to-print");
  }
  // The other numbers pricing and DFM read straight from the geometry.
  for (const key of ["estimatedThickness", "flatWidth", "flatHeight", "flatArea", "estimatedPerimeter"]) {
    if (geometry[key] !== undefined && geometry[key] !== null && !finite(geometry[key])) fail("geometry-not-measurable");
  }
  return geometry;
}

/** The same test as a yes/no (for lists and sweeps). */
function isSaneGeometry(geometry) {
  try { assertSaneGeometry(geometry); return true; } catch { return false; }
}

module.exports = { assertSaneGeometry, isSaneGeometry, coordOk, refusal, ranges, MESSAGES };
