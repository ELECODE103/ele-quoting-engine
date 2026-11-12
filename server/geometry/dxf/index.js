/**
 * DXF → geometry for the routing process.
 *
 *   const geometry = parseDXF(buffer, { units: "in" });   // upload time (thickness unknown)
 *   const priced   = materialize(geometry, 6.35);         // quote time (customer's stock thickness)
 *
 * A DXF is a flat drawing: it has a profile but no thickness. `parseDXF`
 * therefore stores the thickness-independent analysis in `geometry.profile2d`
 * (see SCHEMA.md §2D input) and `materialize` extrudes it to the selected
 * stock thickness, producing exactly the `features` object the routing pricing
 * and DFM already consume for a STEP plate — so neither had to change.
 *
 * Until a thickness is chosen the features are built at a provisional
 * thickness and flagged `provisionalThickness: true`; nothing is priced from
 * them (the quote route requires a thickness for a DXF part).
 */
const { readDxf, resolveUnits, normalise, FLATTEN_TOL_MM } = require("./parse");
const { analyseCurves, WELD_TOL_MM } = require("./analyze");

const SCHEMA_VERSION = 1;
const PAD_MM = 3;
const PROVISIONAL_THICKNESS_MM = 6.35;
const MAX_CONTOURS = 5000;
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

function is2D(geometry) {
  return !!(geometry && geometry.profile2d && geometry.sourceFormat === "dxf");
}

/**
 * Parse an ASCII DXF buffer.
 * @param {Buffer|string} input
 * @param {{units?: "mm"|"in"}} [opts]  customer's units choice (overrides the file)
 * @throws Error with a customer-safe message when the file cannot be quoted
 *         (binary DXF, no cut geometry, 3D only, several separate parts, a part inside a cutout)
 */
function parseDXF(input, opts = {}) {
  const doc = readDxf(input);
  const units = resolveUnits(doc.header, opts.units);
  const { curves, ignored, usedLayers, approxCount } = normalise(doc, units.scale);

  if (!curves.length) {
    if (ignored.layers.length) {
      const names = ignored.layers.map((l) => `"${l.name}"`).slice(0, 6).join(", ");
      throw new Error(`No cut geometry found in this DXF. Everything is on layers we treat as annotation or construction (${names}). Put the part outline on its own layer (for example "0" or "CUT") with a continuous linetype and upload again.`);
    }
    if (ignored.solids) throw new Error("This DXF contains 3D solids or surfaces, not a flat profile. Upload the model as STEP instead, or export a 2D outline of the part as DXF.");
    if (ignored.paperSpace) throw new Error("This DXF only has geometry in paper space (a drawing sheet). Export the part outline from model space and upload again.");
    throw new Error("No cut geometry found in this DXF. It needs lines, arcs, circles, polylines, ellipses or splines that outline the part.");
  }

  // Past MAX_CONTOURS the drawing is refused below; analyseCurves stops at the count in that case.
  const profile = analyseCurves(curves, { maxLoops: MAX_CONTOURS });
  if (!profile) throw new Error("No cut geometry found in this DXF.");

  const contours = profile.tooManyLoops ? profile.loopCount : profile.loops.length;
  if (contours > MAX_CONTOURS) {
    throw new Error(`This DXF has ${contours.toLocaleString()} contours — more than the instant quote reads (${MAX_CONTOURS.toLocaleString()}). Perforated panels and nested sheets like this are quoted by a person: send it to us as an RFQ.`);
  }
  if (profile.outerCount > 1) {
    throw new Error(`This DXF contains ${profile.outerCount} separate parts (outlines that are not inside one another). Upload one part per file so each gets its own material, thickness and quantity — set the quantity in the quote instead of drawing copies. If one of the outlines is a note, border or bend line, move it to an annotation layer or delete it.`);
  }
  if (profile.nestedCount > 0) {
    throw new Error(`This DXF has a closed shape inside a cutout (${profile.nestedCount} found) — a part within a part. Upload each part as its own file. If the outermost rectangle is a drawing border or the sheet outline, delete it and upload again.`);
  }

  const w = profile.bbox.w, h = profile.bbox.h;
  const long = Math.max(w, h), short = Math.min(w, h);
  // Footprint in mm under each reading of the drawing units, so the customer can sanity-check the choice.
  const sizeFor = (mmPerUnit) => ({ w: r3((w / units.scale) * mmPerUnit), h: r3((h / units.scale) * mmPerUnit) });
  profile.units = {
    unit: units.unit, source: units.source, needsConfirmation: units.needsConfirmation, reason: units.reason,
    declared: units.declared, insunits: units.insunits, measurement: units.measurement,
    sizeIfMm: sizeFor(1),
    sizeIfInch: sizeFor(25.4),
  };
  profile.ignored = {
    total: ignored.total, entityTypes: ignored.entityTypes, layers: ignored.layers,
    solids: ignored.solids, nonPlanar: ignored.nonPlanar, paperSpace: ignored.paperSpace, unknownBlocks: ignored.unknownBlocks,
  };
  profile.layers = usedLayers;
  profile.approxCurves = approxCount;
  profile.tolerances = { weldMm: WELD_TOL_MM, flattenMm: FLATTEN_TOL_MM };

  const totalCut = profile.perimeter + profile.innerPerimeter;
  const geometry = {
    sourceFormat: "dxf",
    is2D: true,
    units: "mm",
    sourceUnit: units.unit,
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: h, z: 0 }, width: w, height: h, depth: 0 },
    surfaceArea: 0,
    volume: 0,
    overhangFraction: 0,
    triangleCount: 0,
    vertexCount: 0,
    estimatedThickness: null,
    flatWidth: long,
    flatHeight: short,
    flatArea: long * short,
    estimatedPerimeter: totalCut,
    estimatedHoles: profile.holes.length,
    estimatedBends: 0,
    estimatedSlots: profile.slots.length,
    profile2d: profile,
    meshData: { positions: [], triangleCount: 0 },
  };
  geometry.features = featuresFromProfile(profile, null);
  return geometry;
}

/**
 * Extrude a 2D profile to a stock thickness → features (SCHEMA.md).
 * @param {object} p            geometry.profile2d
 * @param {number|null} thicknessMm  null → provisional thickness, flagged
 */
function featuresFromProfile(p, thicknessMm) {
  const provisional = !(Number(thicknessMm) > 0);
  const t = provisional ? PROVISIONAL_THICKNESS_MM : Number(thicknessMm);
  const w = p.bbox.w, h = p.bbox.h;
  const area = p.area > 0 ? p.area : w * h; // an open outline has no area: fall back to its bounding rectangle
  const perimeter = p.perimeter > 0 ? p.perimeter : p.loops.reduce((s, L) => s + (L.role === "open" ? L.perimeter : 0), 0) || 2 * (w + h);
  const volume = area * t;
  const surfaceArea = 2 * area + (perimeter + p.innerPerimeter) * t;
  const sorted = [w, h, t].sort((a, b) => b - a);
  const block = { w: sorted[0] + 2 * PAD_MM, h: sorted[1] + 2 * PAD_MM, d: sorted[2] + 2 * PAD_MM };
  block.volume = block.w * block.h * block.d;
  const clean = p.openCount === 0 && !p.problems.some((x) => x.code === "self-intersection" || x.code === "crossing" || x.code === "junction");
  const notes = [
    `2D drawing (DXF, ${p.units.unit}${p.units.source === "file" ? "" : `, units ${p.units.reason}`}): thickness ${provisional ? "not selected yet" : `${t} mm from the selected stock`}; every contour is a through cut.`,
  ];
  if (p.approxCurves) notes.push(`${p.approxCurves} spline/ellipse curve(s) flattened to ±${FLATTEN_TOL_MM} mm.`);
  if (p.ignored.total) notes.push(`${p.ignored.total} entit${p.ignored.total === 1 ? "y" : "ies"} not cut (annotation, construction or unsupported).`);
  if (!clean) notes.push("The outline is open or crosses itself: area and perimeter are estimates.");

  return {
    schemaVersion: SCHEMA_VERSION,
    source: "dxf",
    ...(provisional ? { provisionalThickness: true } : {}),
    mesh: { triangles: 0, watertight: null, manifold: null, selfIntersections: null },
    aabb: { w: r3(w), h: r3(h), d: r3(t) },
    obb: { w: r3(sorted[0]), h: r3(sorted[1]), d: r3(sorted[2]), axes: null },
    volume: r3(volume),
    surfaceArea: r3(surfaceArea),
    shape: {
      kind: "flat",
      primaryAxis: [0, 0, 1],
      is25D: true,
      stockThickness: r3(t),
      profile: {
        area: r3(area), perimeter: r3(perimeter), innerPerimeter: r3(p.innerPerimeter),
        bboxW: r3(w), bboxH: r3(h),
        minInternalRadius: p.minInternalRadius, minSlotWidth: p.minSlotWidth,
        cutoutCount: p.cutoutCount,
      },
      revolved: null,
    },
    holes: p.holes.map((hole) => ({
      diameter: hole.diameter, depth: r3(t), through: true, axis: [0, 0, 1],
      center: [hole.center[0], hole.center[1], r3(t / 2)], blind: false, kind: "round",
      depthToDiaRatio: r3(t / hole.diameter),
    })),
    holeCount: p.holes.length,
    pockets: [],
    slots: p.slots.map((s) => ({ width: s.width, length: s.length, depth: r3(t), through: true, shape: s.shape })),
    bosses: [],
    fillets: null,
    chamfers: null,
    text: null,
    // In-plane: the narrowest strip of material between two cuts or between a cut and the edge.
    walls: { minThickness: p.minWeb, p05Thickness: null, thinAreaFraction: null, tallThinMaxAspect: null },
    access: { directions: [[0, 0, 1]], minSetups3Axis: 1, undercutAreaFraction: 0 },
    cornerRadii: { minInternalVertical: p.minInternalRadius, minInternalFloor: null },
    overhang: { areaFraction45: 0, maxAngleFromVertical: 0, supportVolumeEstimate: 0 },
    bridging: null,
    stock: {
      block,
      bar: null,
      sheet: { thickness: r3(t), blankW: r3(w + 2 * PAD_MM), blankH: r3(h + 2 * PAD_MM), area: r3((w + 2 * PAD_MM) * (h + 2 * PAD_MM)) },
      removalVolumeBlock: r3(Math.max(block.volume - volume, 0)),
      removalRatioBlock: r3(Math.min(Math.max(1 - volume / block.volume, 0), 1)),
    },
    // Exact entities: a drawn circle is a hole, a drawn loop is the profile. Lower only when the drawing is broken.
    confidence: { holes: 1, pockets: 1, walls: clean ? 0.95 : 0.5, shape: clean ? 1 : 0.5, overall: clean ? 0.99 : 0.6, source: "dxf" },
    notes,
  };
}

/**
 * Give a 2D geometry the selected stock thickness. Returns a new geometry
 * object (the stored one is not mutated) whose legacy scalars and `features`
 * describe the extruded plate. A 3D geometry is returned unchanged.
 */
function materialize(geometry, thicknessMm) {
  if (!is2D(geometry)) return geometry;
  const features = featuresFromProfile(geometry.profile2d, thicknessMm);
  const t = features.shape.stockThickness;
  return {
    ...geometry,
    boundingBox: { ...geometry.boundingBox, max: { ...geometry.boundingBox.max, z: t }, depth: t },
    volume: features.volume,
    surfaceArea: features.surfaceArea,
    estimatedThickness: t,
    features,
  };
}

module.exports = { parseDXF, featuresFromProfile, materialize, is2D, PROVISIONAL_THICKNESS_MM };
