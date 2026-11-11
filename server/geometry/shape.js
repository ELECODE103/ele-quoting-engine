/**
 * Shape classification: oriented bounding box, primary axis, 2.5D test,
 * revolved test, kind (flat / prismatic / revolved / freeform), stock models.
 */
const { v, symEig3 } = require("./vec");
const { DEG } = require("./fit");

const AXIS_X = [1, 0, 0], AXIS_Y = [0, 1, 0], AXIS_Z = [0, 0, 1];

/** Up to `max` evenly strided welded vertices as [x,y,z]. */
function sampleVertices(mesh, max = 20000) {
  const stride = Math.max(1, Math.ceil(mesh.nv / max));
  const out = [];
  for (let i = 0; i < mesh.nv; i += stride) out.push([mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]]);
  return out;
}

function extentsAlong(points, axes) {
  const m = axes.length;
  const lo = new Array(m).fill(Infinity), hi = new Array(m).fill(-Infinity);
  for (const p of points) {
    for (let k = 0; k < m; k++) {
      const t = p[0] * axes[k][0] + p[1] * axes[k][1] + p[2] * axes[k][2];
      if (t < lo[k]) lo[k] = t; if (t > hi[k]) hi[k] = t;
    }
  }
  return { lo, hi, size: lo.map((l, k) => hi[k] - l) };
}

function rotateAbout(axis, vec, ang) {
  // Rodrigues
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = axis;
  const kxv = v.cross(k, vec);
  const kdv = v.dot(k, vec);
  return [
    vec[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    vec[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    vec[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

/** Best in-plane rotation for a given first axis: min-area rectangle of the projection. */
function bestInPlane(points, n, coarse = 1, fine = 0.1) {
  const [u0, w0] = v.basis(n);
  const evalAng = (deg) => {
    const u = rotateAbout(n, u0, deg * DEG), w = rotateAbout(n, w0, deg * DEG);
    const e = extentsAlong(points, [n, u, w]);
    return { area: e.size[1] * e.size[2], axes: [n, u, w], size: e.size };
  };
  let best = null;
  for (let d = 0; d < 90; d += coarse) { const r = evalAng(d); if (!best || r.area < best.area) { best = r; best.deg = d; } }
  const c = best.deg;
  for (let d = c - coarse; d <= c + coarse; d += fine) { const r = evalAng(d); if (r.area < best.area) { best = r; best.deg = d; } }
  return best;
}

/**
 * Oriented bounding box: candidates from AABB, PCA and the largest planar
 * patch normals, each refined by an in-plane rotation search, plus a small
 * rotation search around the winner's axes.
 */
function computeOBB(mesh, patches) {
  const pts = sampleVertices(mesh);
  const cands = [];
  const consider = (axes, label) => {
    const e = extentsAlong(pts, axes);
    cands.push({ axes, size: e.size, lo: e.lo, hi: e.hi, volume: e.size[0] * e.size[1] * e.size[2], label });
  };
  consider([AXIS_X, AXIS_Y, AXIS_Z], "aabb");
  // PCA of area-weighted centroids
  const c = [0, 0, 0];
  let A = 0;
  for (let t = 0; t < mesh.n; t++) { const a = mesh.area[t]; A += a; for (let k = 0; k < 3; k++) c[k] += a * mesh.centroid[t * 3 + k]; }
  if (A > 0) {
    for (let k = 0; k < 3; k++) c[k] /= A;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const stride = Math.max(1, Math.ceil(mesh.n / 50000));
    for (let t = 0; t < mesh.n; t += stride) {
      const a = mesh.area[t];
      const d = [mesh.centroid[t * 3] - c[0], mesh.centroid[t * 3 + 1] - c[1], mesh.centroid[t * 3 + 2] - c[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += a * d[i] * d[j];
    }
    const eig = symEig3(C);
    for (const n of eig.vectors) { const b = bestInPlane(pts, n, 3, 0.5); cands.push({ axes: b.axes, label: "pca" }); }
  }
  const planes = patches.filter((p) => p.kind === "plane").sort((a, b) => b.area - a.area).slice(0, 3);
  for (const p of planes) {
    const b = bestInPlane(pts, v.canon(p.normal), 1, 0.1);
    cands.push({ axes: b.axes, label: "plane" });
  }
  for (const cnd of cands) { const e = extentsAlong(pts, cnd.axes); cnd.size = e.size; cnd.lo = e.lo; cnd.hi = e.hi; cnd.volume = e.size[0] * e.size[1] * e.size[2]; }
  cands.sort((a, b) => a.volume - b.volume);
  let best = cands[0];
  const aabb = cands.find((x) => x.label === "aabb");
  if (aabb && aabb.volume <= best.volume * 1.005) best = aabb; // prefer the modelled orientation on a near-tie
  // Local refinement around each axis
  for (let iter = 0; iter < 2; iter++) {
    for (let k = 0; k < 3; k++) {
      for (const deg of [-5, -2, -1, -0.5, 0.5, 1, 2, 5]) {
        const ax = best.axes[k];
        const axes = best.axes.map((a, i) => (i === k ? a : rotateAbout(ax, a, deg * DEG)));
        const e = extentsAlong(pts, axes);
        const vol = e.size[0] * e.size[1] * e.size[2];
        if (vol < best.volume * 0.999) best = { axes, size: e.size, lo: e.lo, hi: e.hi, volume: vol, label: "refined" };
      }
    }
  }
  // Sort axes by extent descending, canonical signs
  const order = [0, 1, 2].sort((i, j) => best.size[j] - best.size[i]);
  const axes = order.map((i) => v.canon(best.axes[i]));
  const size = order.map((i) => best.size[i]);
  const center = [0, 1, 2].map((i) => (best.lo[i] + best.hi[i]) / 2);
  const centerXYZ = v.add(v.add(v.scale(best.axes[0], center[0]), v.scale(best.axes[1], center[1])), v.scale(best.axes[2], center[2]));
  return { w: size[0], h: size[1], d: size[2], axes, volume: best.volume, center: centerXYZ, label: best.label };
}

/** Fraction of area whose normal is parallel or perpendicular to axis a. */
function score25D(mesh, a, tolDeg = 1.5) {
  const cPar = Math.cos(tolDeg * DEG), sPerp = Math.sin(tolDeg * DEG);
  let ok = 0, total = 0;
  for (let t = 0; t < mesh.n; t++) {
    const ar = mesh.area[t];
    const d = Math.abs(mesh.normal[t * 3] * a[0] + mesh.normal[t * 3 + 1] * a[1] + mesh.normal[t * 3 + 2] * a[2]);
    total += ar;
    if (d > cPar || d < sPerp) ok += ar;
  }
  return total > 0 ? ok / total : 0;
}

/** Fraction of lateral (non-cap) area consistent with a surface of revolution about the axis through c0. */
function scoreRevolved(mesh, a, c0, tolDeg = 4) {
  const sTol = Math.sin(tolDeg * DEG);
  let ok = 0, lateral = 0, total = 0;
  for (let t = 0; t < mesh.n; t++) {
    const ar = mesh.area[t];
    total += ar;
    const n = [mesh.normal[t * 3], mesh.normal[t * 3 + 1], mesh.normal[t * 3 + 2]];
    const nd = Math.abs(v.dot(n, a));
    if (nd > 0.995) { ok += ar; continue; }
    lateral += ar;
    const p = [mesh.centroid[t * 3] - c0[0], mesh.centroid[t * 3 + 1] - c0[1], mesh.centroid[t * 3 + 2] - c0[2]];
    const tt = v.dot(p, a);
    const r = [p[0] - a[0] * tt, p[1] - a[1] * tt, p[2] - a[2] * tt];
    const rl = v.len(r);
    if (rl < 1e-9) { ok += ar; continue; }
    const tang = v.cross(a, [r[0] / rl, r[1] / rl, r[2] / rl]);
    if (Math.abs(v.dot(n, tang)) < sTol) ok += ar;
  }
  return { lateralScore: lateral > 0 ? (ok - (total - lateral)) / lateral : 0, score: total > 0 ? ok / total : 0, lateralFraction: total > 0 ? lateral / total : 0 };
}

function uniqueAxes(list, tolDeg = 2) {
  const out = [];
  const c = Math.cos(tolDeg * DEG);
  for (const a of list) {
    if (!a || !Number.isFinite(a[0])) continue;
    const u = v.canon(v.norm(a));
    if (!out.some((b) => Math.abs(v.dot(u, b)) > c)) out.push(u);
  }
  return out;
}

/**
 * Classify the shape.
 * @returns {object} { kind, primaryAxis, is25D, score25D, revolved, obb, extentAlongPrimary, notes }
 */
function classifyShape(mesh, patches, obb) {
  const notes = [];
  const planes = patches.filter((p) => p.kind === "plane").sort((a, b) => b.area - a.area);
  const cyls = patches.filter((p) => p.kind === "cylinder").sort((a, b) => b.area - a.area);
  const candidates = uniqueAxes([
    AXIS_X, AXIS_Y, AXIS_Z, ...obb.axes,
    ...planes.slice(0, 6).map((p) => p.normal),
    ...cyls.slice(0, 4).map((p) => p.axis),
  ]);
  const pts = sampleVertices(mesh, 5000);

  // ── 2.5D axis ──
  let best = null;
  const scored = candidates.map((a) => ({ a, s: score25D(mesh, a), ext: extentsAlong(pts, [a]).size[0] }));
  scored.sort((x, y) => y.s - x.s);
  const top = scored[0];
  const near = scored.filter((x) => x.s >= top.s - 0.003);
  near.sort((x, y) => x.ext - y.ext);
  best = near[0];
  const is25D = best.s >= 0.98;

  // ── Revolved ──
  let revolved = null;
  const revCands = [];
  for (const c of cyls.slice(0, 5)) revCands.push({ a: v.canon(c.axis), c0: c.center });
  for (const a of obb.axes) revCands.push({ a, c0: obb.center });
  let bestRev = null;
  for (const rc of revCands) {
    const r = scoreRevolved(mesh, rc.a, rc.c0);
    if (!bestRev || r.score > bestRev.score) bestRev = { ...r, ...rc };
  }
  if (bestRev && bestRev.score >= 0.95 && bestRev.lateralScore >= 0.9) {
    const a = bestRev.a, c0 = bestRev.c0;
    let rMax = 0, tmin = Infinity, tmax = -Infinity;
    const bins = 48;
    for (const p of pts) {
      const d = v.sub(p, c0);
      const t = v.dot(d, a);
      const rl = v.len(v.sub(d, v.scale(a, t)));
      if (rl > rMax) rMax = rl;
      if (t < tmin) tmin = t; if (t > tmax) tmax = t;
    }
    const binMax = new Float64Array(bins).fill(0);
    const len = tmax - tmin || 1;
    for (const p of pts) {
      const d = v.sub(p, c0);
      const t = v.dot(d, a);
      const rl = v.len(v.sub(d, v.scale(a, t)));
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((t - tmin) / len) * bins)));
      if (rl > binMax[b]) binMax[b] = rl;
    }
    let minOD = Infinity;
    for (let b = 1; b < bins - 1; b++) if (binMax[b] > 0 && binMax[b] < minOD) minOD = binMax[b];
    if (!Number.isFinite(minOD)) minOD = rMax;
    const coaxial = (p) => Math.abs(v.dot(v.canon(p.axis), a)) > Math.cos(1 * DEG) && axisDistance(p.center, p.axis, c0, a) < Math.max(0.05, 0.02 * rMax);
    const bores = cyls.filter((p) => p.concave && p.coverageDeg >= 300 && coaxial(p));
    const bore = bores.length ? Math.max(...bores.map((p) => p.diameter)) : null;
    const lateralSegs = patches.filter((p) => (p.kind === "cylinder" || p.kind === "cone") && coaxial(p)).length;
    const shoulders = planes.filter((p) => Math.abs(v.dot(p.normal, a)) > Math.cos(1 * DEG)).filter((p) => {
      const t = v.dot(v.sub(v.scale(p.normal, p.offset), c0), a);
      return t > tmin + 0.05 && t < tmax - 0.05;
    }).length;
    revolved = {
      axis: a, maxDiameter: 2 * rMax, minDiameter: 2 * minOD, length: tmax - tmin,
      boreDiameter: bore, segments: lateralSegs + shoulders, score: bestRev.score,
    };
  }

  // ── Primary axis & kind ──
  let primaryAxis, kind;
  const extentAlong = (a) => extentsAlong(pts, [a]).size[0];
  if (revolved) {
    primaryAxis = revolved.axis;
    kind = "revolved";
  } else if (is25D) {
    primaryAxis = best.a;
    const t = best.ext;
    const minPlan = Math.min(...planDims(pts, primaryAxis));
    // "flat": a sheet/plate part — thickness is plate stock (≤ 1") and well
    // under the plan size, or thin relative to the plan at any thickness.
    kind = (t <= 25.4 && t <= 0.75 * minPlan) || t <= 0.3 * minPlan ? "flat" : "prismatic";
  } else {
    primaryAxis = planes.length ? v.canon(planes[0].normal) : obb.axes[2];
    const planarFraction = planes.reduce((s, p) => s + p.area, 0) / (mesh.surfaceArea || 1);
    kind = best.s >= 0.85 || planarFraction >= 0.6 ? "prismatic" : "freeform";
    if (best.s < 0.98) notes.push(`Not 2.5D: ${((1 - best.s) * 100).toFixed(1)}% of surface area is neither parallel nor perpendicular to the best axis.`);
  }
  if (is25D && best.s < 0.995) notes.push(`2.5D except ${((1 - best.s) * 100).toFixed(1)}% of area (chamfers, countersinks or drafts).`);

  return {
    kind, primaryAxis, is25D, score25D: best.s, revolved,
    extentAlongPrimary: extentAlong(primaryAxis),
    notes,
  };
}

/** Plan dimensions (min-area rectangle) of the projection perpendicular to axis. */
function planDims(pts, axis) {
  const b = bestInPlane(pts, axis, 3, 1);
  return [b.size[1], b.size[2]];
}

function axisDistance(p1, a1, p2, a2) {
  // distance from point p1 to the line (p2, a2) — assumes axes parallel
  const d = v.sub(p1, p2);
  const t = v.dot(d, a2);
  return v.len(v.sub(d, v.scale(a2, t)));
}

function stockModels(shape, obb, profile, volume, padMm = 3) {
  const block = { w: obb.w + 2 * padMm, h: obb.h + 2 * padMm, d: obb.d + 2 * padMm };
  block.volume = block.w * block.h * block.d;
  let bar = null, sheet = null;
  if (shape.revolved) {
    bar = { diameter: shape.revolved.maxDiameter + 2 * padMm, length: shape.revolved.length + 2 * padMm };
    bar.volume = Math.PI * (bar.diameter / 2) ** 2 * bar.length;
  }
  if (shape.kind === "flat" && profile) {
    sheet = { thickness: shape.extentAlongPrimary, blankW: profile.bboxW + 2 * padMm, blankH: profile.bboxH + 2 * padMm };
    sheet.area = sheet.blankW * sheet.blankH;
  }
  return {
    block, bar, sheet,
    removalVolumeBlock: Math.max(0, block.volume - volume),
    removalRatioBlock: block.volume > 0 ? Math.max(0, block.volume - volume) / block.volume : 0,
  };
}

module.exports = { computeOBB, classifyShape, stockModels, score25D, planDims, sampleVertices, extentsAlong, axisDistance };
