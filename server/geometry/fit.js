/**
 * Surface fitting for a group of triangles: plane / cylinder / cone / other.
 *
 * The axis of a cylinder or cone is found from the normals (cross products of
 * adjacent facet normals are parallel to a cylinder axis; the normals of a cone
 * or cylinder lie in one plane whose normal is the axis). Radius and centre
 * come from a least-squares circle fit of the points projected along the axis.
 */
const { v, symEig3, fitCircle2D, fitLine } = require("./vec");

const DEG = Math.PI / 180;

/**
 * @param {object} s
 * @param {number[][]} s.normals  per sample unit normal
 * @param {number[][]} s.points   per sample position (where the normal applies)
 * @param {number[]}   s.weights  per sample weight (area)
 * @param {number[][]} s.vertices unique boundary/interior vertices of the group
 * @param {number[][]} s.pairs    optional [i,j] indices of adjacent samples
 * @returns {object} fit description with kind: "cylinder"|"cone"|"unknown"
 */
function fitCurved(s) {
  const { normals, points, weights, vertices } = s;
  const n = normals.length;
  if (n < 2) return { kind: "unknown" };
  let W = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) { W += weights[i]; mean[0] += normals[i][0] * weights[i]; mean[1] += normals[i][1] * weights[i]; mean[2] += normals[i][2] * weights[i]; }
  if (W <= 0) return { kind: "unknown" };
  mean[0] /= W; mean[1] /= W; mean[2] /= W;

  // Centered covariance of normals
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const d = v.sub(normals[i], mean), w = weights[i] / W;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += w * d[a] * d[b];
  }
  const eig = symEig3(C);
  const [l0, l1, l2] = eig.values;
  if (l2 < 1e-8) return { kind: "unknown" }; // all normals identical: planar

  let axis;
  const normalsCoplanar = l0 < 0.02 * l2;
  if (!normalsCoplanar) return { kind: "unknown" }; // sphere / torus / freeform
  if (l1 > 0.02 * l2) {
    axis = eig.vectors[0];
  } else {
    // Short arc: covariance is rank-1. Use cross products of neighbouring normals.
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const pairs = s.pairs && s.pairs.length ? s.pairs : consecutivePairs(n);
    let any = false;
    for (const [i, j] of pairs) {
      const c = v.cross(normals[i], normals[j]);
      const m2 = v.dot(c, c);
      if (m2 < 1e-12) continue;
      any = true;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += c[a] * c[b];
    }
    if (!any) return { kind: "unknown" };
    axis = symEig3(M).vectors[2];
  }
  axis = v.canon(axis);

  // Cylinder vs cone: mean of n·axis
  let cAx = 0;
  for (let i = 0; i < n; i++) cAx += weights[i] * v.dot(normals[i], axis);
  cAx /= W;
  const [u, w] = v.basis(axis);
  const pts = vertices && vertices.length >= 3 ? vertices : points;

  if (Math.abs(cAx) < Math.sin(3 * DEG)) {
    // ── Cylinder ──
    const xs = [], ys = [];
    for (const p of pts) { xs.push(v.dot(p, u)); ys.push(v.dot(p, w)); }
    const circ = fitCircle2D(xs, ys);
    if (!circ || !(circ.r > 0)) return { kind: "unknown" };
    const rel = circ.rms / circ.r;
    if (rel > 0.03 && circ.rms > 0.02) return { kind: "unknown", why: "circle residual", rms: circ.rms, r: circ.r };
    const c0 = v.add(v.scale(u, circ.cx), v.scale(w, circ.cy)); // point on axis at axial coordinate 0
    const ext = axialExtent(pts, axis);
    const center = v.add(c0, v.scale(axis, (ext.tmin + ext.tmax) / 2));
    const concave = concavity(normals, points, weights, axis, c0) < 0;
    const cov = coverageDeg(pts, axis, c0, u, w);
    return {
      kind: "cylinder", axis, center, axisPoint: c0, radius: circ.r, diameter: 2 * circ.r,
      tmin: ext.tmin, tmax: ext.tmax, length: ext.tmax - ext.tmin,
      concave, coverageDeg: cov.coverage, arcStart: cov.start, arcEnd: cov.end, rms: circ.rms, relRms: rel,
    };
  }

  // ── Cone ── apex from tangent planes: n·(apex − p) = 0
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const nn = normals[i], wi = weights[i];
    const d = v.dot(nn, points[i]);
    for (let a = 0; a < 3; a++) { b[a] += wi * nn[a] * d; for (let c = 0; c < 3; c++) A[a][c] += wi * nn[a] * nn[c]; }
  }
  const apex = require("./vec").solve3(A, b);
  if (!apex) return { kind: "unknown" };
  const halfAngle = Math.acos(Math.min(1, Math.abs(cAx))) ; // angle between normal and axis -> cone half angle = 90 - that
  const coneHalf = 90 - halfAngle / DEG;
  const ext = axialExtent(pts, axis, apex);
  // radius grows linearly with distance from apex
  const ts = [], rs = [];
  for (const p of pts) {
    const d = v.sub(p, apex);
    const t = v.dot(d, axis);
    const radial = v.sub(d, v.scale(axis, t));
    ts.push(t); rs.push(v.len(radial));
  }
  const lf = fitLine(ts, rs);
  let se = 0;
  for (let i = 0; i < ts.length; i++) { const e = rs[i] - (lf.a + lf.b * ts[i]); se += e * e; }
  const rms = Math.sqrt(se / ts.length);
  const rAtMin = Math.abs(lf.a + lf.b * ext.tmin), rAtMax = Math.abs(lf.a + lf.b * ext.tmax);
  if (rms > 0.03 * Math.max(rAtMin, rAtMax) && rms > 0.02) return { kind: "unknown", why: "cone residual" };
  const c0 = apex;
  const concave = concavity(normals, points, weights, axis, c0) < 0;
  const cov = coverageDeg(pts, axis, c0, u, w);
  const center = v.add(apex, v.scale(axis, (ext.tmin + ext.tmax) / 2));
  return {
    kind: "cone", axis, apex, axisPoint: apex, center, halfAngleDeg: coneHalf,
    tmin: ext.tmin, tmax: ext.tmax, length: ext.tmax - ext.tmin,
    rMin: Math.min(rAtMin, rAtMax), rMax: Math.max(rAtMin, rAtMax),
    rAtTmin: rAtMin, rAtTmax: rAtMax,
    concave, coverageDeg: cov.coverage, arcStart: cov.start, arcEnd: cov.end, rms,
  };
}

function consecutivePairs(n) {
  const p = [];
  for (let i = 0; i + 1 < n; i++) p.push([i, i + 1]);
  return p;
}

function axialExtent(pts, axis, origin = [0, 0, 0]) {
  let tmin = Infinity, tmax = -Infinity;
  for (const p of pts) {
    const t = v.dot(v.sub(p, origin), axis);
    if (t < tmin) tmin = t; if (t > tmax) tmax = t;
  }
  return { tmin, tmax };
}

/** Weighted mean of the radial component of the normals (negative = normals point at the axis = concave). */
function concavity(normals, points, weights, axis, c0) {
  let s = 0;
  for (let i = 0; i < normals.length; i++) {
    const d = v.sub(points[i], c0);
    const radial = v.sub(d, v.scale(axis, v.dot(d, axis)));
    const rl = v.len(radial);
    if (rl < 1e-9) continue;
    s += weights[i] * v.dot(normals[i], radial) / rl;
  }
  return s;
}

/** Angular coverage (degrees) of points about an axis: 360 minus the largest empty gap. */
function coverageDeg(pts, axis, c0, u, w) {
  const angs = [];
  for (const p of pts) {
    const d = v.sub(p, c0);
    const x = v.dot(d, u), y = v.dot(d, w);
    if (x * x + y * y < 1e-12) continue;
    angs.push(Math.atan2(y, x));
  }
  if (angs.length < 2) return { coverage: 0, start: 0, end: 0 };
  angs.sort((a, b) => a - b);
  let maxGap = angs[0] + 2 * Math.PI - angs[angs.length - 1], gapAt = angs.length - 1;
  for (let i = 0; i + 1 < angs.length; i++) {
    const g = angs[i + 1] - angs[i];
    if (g > maxGap) { maxGap = g; gapAt = i; }
  }
  const start = angs[(gapAt + 1) % angs.length];
  const end = angs[gapAt];
  return { coverage: (2 * Math.PI - maxGap) / DEG, start, end };
}

/** Area-weighted plane fit for a set of triangle samples (normals assumed near-parallel). */
function fitPlane(normals, points, weights) {
  const nn = [0, 0, 0];
  let W = 0;
  for (let i = 0; i < normals.length; i++) { W += weights[i]; for (let k = 0; k < 3; k++) nn[k] += normals[i][k] * weights[i]; }
  const normal = v.norm(nn);
  let off = 0;
  for (let i = 0; i < points.length; i++) off += weights[i] * v.dot(points[i], normal);
  return { normal, offset: off / (W || 1) };
}

module.exports = { fitCurved, fitPlane, coverageDeg, axialExtent, DEG };
