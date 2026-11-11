/**
 * Geometry recognition entry point. Produces `features` per SCHEMA.md from a
 * triangle soup (STL/3MF) or B-rep tessellation with face ranges (STEP/IGES).
 *
 *   const { analyzeGeometry } = require("./geometry");
 *   const features = analyzeGeometry({ positions, source: "stl" });
 *   const features = analyzeGeometry({ positions, source: "step", brepFaces: [{first,last}], vertexNormals });
 *
 * positions: flat xyz, 9 numbers per triangle (mm). Never throws for a
 * degenerate mesh: returns a features object with nulls and a note instead.
 */
const { buildMesh } = require("./mesh");
const { buildBVH } = require("./bvh");
const { segmentMesh, segmentBrep, patchAdjacency } = require("./regions");
const { computeOBB, classifyShape, stockModels, sampleVertices, extentsAlong } = require("./shape");
const { computeOutline } = require("./outline");
const { sampleTriangles, wallThickness, tallThinAspect, accessAnalysis, overhangAnalysis, selfIntersections } = require("./raycasts");
const { detectHolesAndBosses, detectPockets, detectSlots } = require("./features");
const { roundTo, v } = require("./vec");

const SCHEMA_VERSION = 1;
const MAX_LIST = 2000;

function r3(x) { return roundTo(x, 3); }
function rv(a) { return a ? a.map((x) => roundTo(x, 4)) : a; }

/**
 * @param {object} input
 * @param {Float32Array|Float64Array|number[]} input.positions
 * @param {"step"|"stl"|"3mf"|"iges"} input.source
 * @param {{first:number,last:number}[]=} input.brepFaces
 * @param {Float32Array|number[]=} input.vertexNormals flat, 9 per triangle
 * @param {object=} input.options { stockPaddingMm }
 */
function analyzeGeometry(input) {
  const t0 = Date.now();
  const timings = {};
  const notes = [];
  const source = input.source || "stl";
  const options = Object.assign({ stockPaddingMm: 3 }, input.options || {});
  const lap = (k, start) => { timings[k] = Date.now() - start; };

  let mesh;
  try {
    mesh = buildMesh(input.positions);
  } catch (err) {
    return emptyFeatures(source, [`Mesh could not be built: ${err.message}`]);
  }
  lap("mesh", t0);
  if (mesh.inverted) notes.push("Mesh winding is inside-out (negative signed volume); normals were used as given.");

  // ── Segmentation ──
  let ts = Date.now();
  const isBrep = Array.isArray(input.brepFaces) && input.brepFaces.length > 0 && (source === "step" || source === "iges");
  let seg;
  if (isBrep) {
    seg = segmentBrep(mesh, input.brepFaces, input.vertexNormals || null);
  } else {
    seg = segmentMesh(mesh);
  }
  const { patches, patchOf } = seg;
  const adjacency = patchAdjacency(mesh, patches, patchOf);
  lap("segment", ts);

  // ── BVH ──
  ts = Date.now();
  const bvh = buildBVH(mesh);
  lap("bvh", ts);

  // ── Shape ──
  ts = Date.now();
  const obb = computeOBB(mesh, patches);
  const shape = classifyShape(mesh, patches, obb);
  shape.obbAxes = obb.axes;
  const vsample = sampleVertices(mesh, 5000);
  shape.extents = (a) => extentsAlong(vsample, [a]).size[0];
  notes.push(...shape.notes);
  lap("shape", ts);

  // ── Outline along the primary axis ──
  ts = Date.now();
  let profile = null;
  try {
    profile = computeOutline(mesh, shape.primaryAxis);
    if (!profile.closed) notes.push("Outline loops did not all close; perimeter is the sum of outline segments, area may be low.");
  } catch (err) {
    notes.push(`Outline failed: ${err.message}`);
  }
  lap("outline", ts);

  // ── Features ──
  ts = Date.now();
  const hb = detectHolesAndBosses(mesh, patches, bvh, shape);
  const pk = detectPockets(mesh, patches, patchOf, adjacency, hb.holePatchIds, hb.cylinders, bvh);
  const slots = detectSlots(profile, hb.partialCylinders, shape, shape.extentAlongPrimary, bvh);
  lap("features", ts);

  // ── Ray-cast metrics ──
  ts = Date.now();
  const sample = sampleTriangles(mesh);
  if (sample.downsampled) notes.push(`Mesh has ${mesh.n} triangles; thickness, access and overhang were sampled on ${sample.tris.length} of them.`);
  const walls = wallThickness(mesh, bvh, sample);
  const tall = tallThinAspect(mesh, patches, walls.perTri);
  lap("thickness", ts);
  ts = Date.now();
  const access = accessAnalysis(mesh, bvh, sample, shape.is25D || shape.revolved ? [] : [shape.primaryAxis, v.neg(shape.primaryAxis)], shape.primaryAxis);
  lap("access", ts);
  ts = Date.now();
  const overhang = overhangAnalysis(mesh, bvh, sample, patches);
  lap("overhang", ts);
  ts = Date.now();
  const si = mesh.n <= 400000 ? selfIntersections(bvh.mesh, bvh) : { found: null, sampled: true };
  if (si.sampled && si.found === false) notes.push("Self-intersection check was sampled, not exhaustive.");
  lap("selfIntersect", ts);

  // ── Corner radii ──
  let minInternalVertical = profile ? profile.minInternalRadius : null;
  let minInternalFloor = null;
  for (const p of pk.pockets) {
    if (p.minCornerRadius !== null) minInternalVertical = minInternalVertical === null ? p.minCornerRadius : Math.min(minInternalVertical, p.minCornerRadius);
    minInternalFloor = minInternalFloor === null ? 0 : minInternalFloor; // sharp wall/floor junction unless a floor fillet says otherwise
  }
  for (const c of hb.partialCylinders) {
    if (!c.concave) continue;
    const d = Math.abs(v.dot(v.canon(c.axis), shape.primaryAxis));
    if (d < Math.sin(5 * Math.PI / 180)) minInternalFloor = minInternalFloor === null || minInternalFloor === 0 ? c.radius : Math.min(minInternalFloor, c.radius);
  }
  // a floor fillet found means the junction is filleted; if pockets exist without fillets it stays 0
  if (pk.pockets.length && hb.fillets.concave === 0) minInternalFloor = 0;

  // ── Stock ──
  const stock = stockModels(shape, obb, profile, mesh.volume, options.stockPaddingMm);

  // ── Confidence ──
  const conf = confidence({ isBrep, mesh, hb, pk, walls, shape, profile, sample });
  notes.push(...conf.notes);

  const holes = hb.holes.slice(0, MAX_LIST).map((h) => ({
    diameter: r3(h.diameter), depth: r3(h.depth), through: h.through, axis: rv(h.axis), center: rv(h.center),
    blind: h.blind, kind: h.kind, depthToDiaRatio: r3(h.depthToDiaRatio),
    ...(h.counterbore ? { counterbore: { diameter: r3(h.counterbore.diameter), depth: r3(h.counterbore.depth) }, holeDepth: r3(h.holeDepth) } : {}),
    ...(h.countersink ? { countersink: { diameter: r3(h.countersink.diameter), angleDeg: r3(h.countersink.angleDeg) } } : {}),
    ...(h.drillPoint ? { drillPoint: true } : {}),
    ...(h.internalVoid ? { internalVoid: true } : {}),
  }));
  if (hb.holes.length > MAX_LIST) notes.push(`${hb.holes.length} holes found; list truncated to ${MAX_LIST}.`);

  const features = {
    schemaVersion: SCHEMA_VERSION,
    source,
    mesh: { triangles: mesh.n, watertight: mesh.watertight, manifold: mesh.manifold, selfIntersections: si.found },
    aabb: { w: r3(mesh.bbox.size[0]), h: r3(mesh.bbox.size[1]), d: r3(mesh.bbox.size[2]) },
    obb: { w: r3(obb.w), h: r3(obb.h), d: r3(obb.d), axes: obb.axes.map(rv) },
    volume: r3(mesh.volume),
    surfaceArea: r3(mesh.surfaceArea),
    shape: {
      kind: shape.kind,
      primaryAxis: rv(shape.primaryAxis),
      is25D: shape.is25D,
      stockThickness: shape.kind === "flat" ? r3(shape.extentAlongPrimary) : null,
      profile: profile ? {
        area: r3(profile.area), perimeter: r3(profile.perimeter), innerPerimeter: r3(profile.innerPerimeter),
        bboxW: r3(profile.bboxW), bboxH: r3(profile.bboxH),
        minInternalRadius: r3(profile.minInternalRadius), minSlotWidth: r3(profile.minSlotWidth),
        cutoutCount: profile.innerCount,
      } : null,
      revolved: shape.revolved ? {
        axis: rv(shape.revolved.axis), maxDiameter: r3(shape.revolved.maxDiameter), length: r3(shape.revolved.length),
        minDiameter: r3(shape.revolved.minDiameter), boreDiameter: r3(shape.revolved.boreDiameter), segments: shape.revolved.segments,
      } : null,
    },
    holes,
    holeCount: hb.holes.length,
    pockets: pk.pockets.slice(0, MAX_LIST).map((p) => ({
      area: r3(p.area), depth: r3(p.depth), floorArea: r3(p.floorArea), openSides: p.openSides,
      minCornerRadius: r3(p.minCornerRadius), depthToWidthRatio: r3(p.depthToWidthRatio), accessAxis: rv(p.accessAxis),
      perimeter: r3(p.perimeter), width: r3(p.width), center: rv(p.center),
    })),
    slots: slots.slice(0, MAX_LIST).map((s) => ({ width: r3(s.width), length: r3(s.length), depth: r3(s.depth), through: s.through, shape: s.shape })),
    bosses: hb.bosses.slice(0, MAX_LIST).map((b) => ({ diameter: r3(b.diameter), height: r3(b.height), axis: rv(b.axis), center: rv(b.center) })),
    fillets: hb.fillets.count ? { count: hb.fillets.count, minRadius: r3(hb.fillets.minRadius) } : { count: 0, minRadius: null },
    chamfers: { count: hb.chamfers.count },
    text: null,
    walls: {
      minThickness: r3(walls.minThickness), p05Thickness: r3(walls.p05Thickness), thinAreaFraction: r3(walls.thinAreaFraction),
      tallThinMaxAspect: tall ? r3(tall.aspect) : null,
    },
    access: {
      directions: access.directions.map(rv),
      minSetups3Axis: access.minSetups3Axis,
      undercutAreaFraction: r3(access.undercutAreaFraction),
    },
    cornerRadii: { minInternalVertical: r3(minInternalVertical), minInternalFloor: r3(minInternalFloor) },
    overhang: {
      areaFraction45: r3(overhang.areaFraction45), maxAngleFromVertical: r3(overhang.maxAngleFromVertical),
      supportVolumeEstimate: r3(overhang.supportVolumeEstimate),
    },
    bridging: overhang.bridging ? { maxSpan: r3(overhang.bridging.maxSpan) } : null,
    stock: {
      block: { w: r3(stock.block.w), h: r3(stock.block.h), d: r3(stock.block.d), volume: r3(stock.block.volume) },
      bar: stock.bar ? { diameter: r3(stock.bar.diameter), length: r3(stock.bar.length), volume: r3(stock.bar.volume) } : null,
      sheet: stock.sheet ? { thickness: r3(stock.sheet.thickness), blankW: r3(stock.sheet.blankW), blankH: r3(stock.sheet.blankH), area: r3(stock.sheet.area) } : null,
      removalVolumeBlock: r3(stock.removalVolumeBlock),
      removalRatioBlock: r3(stock.removalRatioBlock),
    },
    confidence: conf.values,
    notes: Array.from(new Set(notes)),
    timings: Object.assign(timings, { total: Date.now() - t0 }),
    patchSummary: summarizePatches(patches),
  };
  return features;
}

function summarizePatches(patches) {
  const s = { plane: 0, cylinder: 0, cone: 0, other: 0 };
  for (const p of patches) s[p.kind] = (s[p.kind] || 0) + 1;
  return s;
}

function confidence({ isBrep, mesh, hb, pk, walls, shape, profile, sample }) {
  const notes = [];
  const meshPenalty = mesh.watertight ? 1 : 0.8;
  if (!mesh.watertight) notes.push(`Mesh is not watertight (${mesh.openEdges} open edges): through/blind and thickness results are less reliable.`);

  // holes
  let holes;
  if (hb.holes.length === 0) holes = (isBrep ? 0.95 : 0.8) * meshPenalty;
  else {
    const anyUnknownEnd = hb.holes.some((h) => h.internalVoid);
    holes = (isBrep ? 1.0 : 0.8) * meshPenalty;
    if (anyUnknownEnd) { holes = Math.min(holes, 0.6); notes.push("A hole has both ends closed (internal void or end test failed)."); }
    if (!isBrep && hb.holes.some((h) => h.confidenceSource === "mesh")) holes = Math.min(holes, 0.8);
  }
  // pockets
  let pockets = (isBrep ? 0.9 : 0.7) * meshPenalty;
  if (pk.pockets.some((p) => p.openSides > 0)) { pockets = Math.min(pockets, 0.65); notes.push("A pocket is open on one or more sides (step or channel); check its depth and area."); }
  // walls
  let wallsC = 0.85;
  if (sample.downsampled) wallsC = 0.7;
  if (walls.samples === 0 || walls.minThickness === null) wallsC = 0.2;
  wallsC *= meshPenalty;
  // shape
  let shapeC;
  if (shape.revolved) shapeC = shape.revolved.score >= 0.98 ? 0.95 : 0.85;
  else if (shape.is25D) shapeC = shape.score25D >= 0.995 ? 0.95 : 0.85;
  else if (shape.kind === "prismatic") shapeC = 0.7;
  else shapeC = 0.6;
  if (profile && !profile.closed) shapeC = Math.min(shapeC, 0.6);
  if (!profile) shapeC = Math.min(shapeC, 0.4);
  const overall = (holes + pockets + wallsC + shapeC) / 4;
  const r = (x) => roundTo(x, 2);
  return { values: { holes: r(holes), pockets: r(pockets), walls: r(wallsC), shape: r(shapeC), overall: r(overall) }, notes };
}

function emptyFeatures(source, notes) {
  return {
    schemaVersion: SCHEMA_VERSION, source,
    mesh: { triangles: 0, watertight: false, manifold: false, selfIntersections: null },
    aabb: null, obb: null, volume: null, surfaceArea: null,
    shape: { kind: "freeform", primaryAxis: null, is25D: false, stockThickness: null, profile: null, revolved: null },
    holes: [], holeCount: 0, pockets: [], slots: [], bosses: [], fillets: null, chamfers: null, text: null,
    walls: { minThickness: null, p05Thickness: null, thinAreaFraction: null, tallThinMaxAspect: null },
    access: { directions: [], minSetups3Axis: null, undercutAreaFraction: null },
    cornerRadii: { minInternalVertical: null, minInternalFloor: null },
    overhang: { areaFraction45: null, maxAngleFromVertical: null, supportVolumeEstimate: null },
    bridging: null,
    stock: { block: null, bar: null, sheet: null, removalVolumeBlock: null, removalRatioBlock: null },
    confidence: { holes: 0, pockets: 0, walls: 0, shape: 0, overall: 0 },
    notes,
  };
}

/**
 * Legacy-field replacements derived from features (used by fileParser to
 * improve estimatedHoles / estimatedPerimeter / estimatedThickness).
 */
function legacyFromFeatures(features) {
  if (!features || !features.shape) return null;
  const prof = features.shape.profile;
  // Total cut path: outer outline + through cutouts (holes, slots) + pocket
  // outlines. Through slots are inner loops of the profile already.
  const pocketPerimeter = (features.pockets || []).reduce((s, p) => s + (p.perimeter || 0), 0);
  return {
    estimatedHoles: features.holeCount,
    estimatedSlots: (features.slots || []).length,
    estimatedPerimeter: prof ? prof.perimeter + prof.innerPerimeter + pocketPerimeter : null,
    estimatedThickness: features.walls && Number.isFinite(features.walls.minThickness) && features.confidence.walls >= 0.6 ? features.walls.minThickness : null,
    overhangFraction: features.overhang ? features.overhang.areaFraction45 : null,
  };
}

module.exports = { analyzeGeometry, legacyFromFeatures, SCHEMA_VERSION };
