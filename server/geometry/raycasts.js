/**
 * Ray-cast derived metrics: wall thickness, tool access / undercuts,
 * printing overhang and bridging. All sample triangle centroids; meshes above
 * MAX_SAMPLES triangles are downsampled (area-weighted) and say so.
 */
const { raycast, pointInside } = require("./bvh");
const { weightedPercentile, v } = require("./vec");
const { DEG } = require("./fit");

const MAX_SAMPLES = 30000;

/** Deterministic area-weighted triangle sample (plus every triangle when small). */
function sampleTriangles(mesh, max = MAX_SAMPLES) {
  const n = mesh.n;
  if (n <= max) {
    const all = new Int32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return { tris: all, downsampled: false };
  }
  // Systematic sampling on the cumulative area (deterministic)
  const total = mesh.surfaceArea;
  const out = new Int32Array(max);
  let acc = 0, k = 0, next = total / max / 2;
  for (let t = 0; t < n && k < max; t++) {
    acc += mesh.area[t];
    while (acc >= next && k < max) { out[k++] = t; next += total / max; }
  }
  return { tris: out.subarray(0, k), downsampled: true };
}

/**
 * Wall thickness by casting from each sampled centroid along the inward
 * normal to the first back-facing hit.
 * @returns {{ minThickness, p05Thickness, thinAreaFraction, perTri: Float64Array (NaN when no hit), samples, downsampled }}
 */
function wallThickness(mesh, bvh, sample, thinMm = 1.0) {
  const { tris, downsampled } = sample;
  const vals = [], weights = [];
  const perTri = new Float64Array(mesh.n).fill(NaN);
  const eps = 1e-6 * mesh.diag;
  let thinArea = 0, totalArea = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const nx = mesh.normal[t * 3], ny = mesh.normal[t * 3 + 1], nz = mesh.normal[t * 3 + 2];
    const ox = mesh.centroid[t * 3] - nx * eps, oy = mesh.centroid[t * 3 + 1] - ny * eps, oz = mesh.centroid[t * 3 + 2] - nz * eps;
    const h = raycast(bvh, ox, oy, oz, -nx, -ny, -nz, eps, Infinity, t);
    const a = mesh.area[t];
    totalArea += a;
    if (!h) continue;
    // the hit must be a back face (exiting the solid)
    const hd = mesh.normal[h.tri * 3] * nx + mesh.normal[h.tri * 3 + 1] * ny + mesh.normal[h.tri * 3 + 2] * nz;
    if (hd > -0.05) continue; // front face or grazing: not a wall measurement
    const th = h.t + eps;
    perTri[t] = th;
    vals.push(th); weights.push(a);
    if (th < thinMm) thinArea += a;
  }
  if (vals.length === 0) return { minThickness: null, p05Thickness: null, thinAreaFraction: null, perTri, samples: 0, downsampled };
  let min = Infinity;
  for (const x of vals) if (x < min) min = x;
  return {
    minThickness: min,
    p05Thickness: weightedPercentile(vals, weights, 0.05),
    thinAreaFraction: totalArea > 0 ? thinArea / totalArea : 0,
    perTri, samples: vals.length, downsampled,
  };
}

/**
 * Tall-thin wall aspect: for each planar patch, median thickness of its
 * samples vs its smallest in-plane extent. Walls thicker than maxWallMm are
 * not "thin walls" and are ignored.
 */
function tallThinAspect(mesh, patches, perTri, maxWallMm = 6) {
  let worst = null;
  for (const p of patches) {
    if (p.kind !== "plane" || p.tris.length === 0) continue;
    const ths = [];
    for (const t of p.tris) { const x = perTri[t]; if (Number.isFinite(x)) ths.push(x); }
    if (ths.length < 3) continue;
    ths.sort((a, b) => a - b);
    const med = ths[Math.floor(ths.length / 2)];
    if (med > maxWallMm || med <= 0) continue;
    const [u, w] = v.basis(p.normal);
    let ulo = Infinity, uhi = -Infinity, wlo = Infinity, whi = -Infinity;
    const seen = new Set();
    for (const t of p.tris) for (let c = 0; c < 3; c++) {
      const id = mesh.vidx[t * 3 + c];
      if (seen.has(id)) continue; seen.add(id);
      const x = mesh.verts[id * 3], y = mesh.verts[id * 3 + 1], z = mesh.verts[id * 3 + 2];
      const a = x * u[0] + y * u[1] + z * u[2], b = x * w[0] + y * w[1] + z * w[2];
      if (a < ulo) ulo = a; if (a > uhi) uhi = a; if (b < wlo) wlo = b; if (b > whi) whi = b;
    }
    const height = Math.min(uhi - ulo, whi - wlo);
    const aspect = height / med;
    if (worst === null || aspect > worst.aspect) worst = { aspect, height, thickness: med, patch: p.id };
  }
  return worst;
}

const AXIS_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Per-axis visibility: a face is reachable from direction d if it faces d and
 * nothing is in the way. Returns the greedy minimal set of directions that
 * reach every reachable face, and the area fraction reachable from none.
 */
function accessAnalysis(mesh, bvh, sample, extraDirs = [], preferAxis = null) {
  const dirs = AXIS_DIRS.concat(extraDirs.map((d) => v.norm(d)));
  // preference on near-ties: directions along the primary axis first, then other axis directions
  const pref = dirs.map((d, k) => (preferAxis && Math.abs(v.dot(d, preferAxis)) > 0.99 ? 2 : (k < 6 ? 1 : 0)));
  const { tris } = sample;
  const eps = 1e-6 * mesh.diag;
  const sideTol = Math.sin(1.5 * DEG);
  const sideOffset = Math.max(1e-3, 1e-4 * mesh.diag); // a hair outside a wall
  const visible = dirs.map(() => new Uint8Array(tris.length)); // 2 = head-on, 1 = flank (parallel)
  const covered = new Uint8Array(tris.length);
  let total = 0, undercut = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const a = mesh.area[t];
    total += a;
    const nx = mesh.normal[t * 3], ny = mesh.normal[t * 3 + 1], nz = mesh.normal[t * 3 + 2];
    let any = false;
    for (let k = 0; k < dirs.length; k++) {
      const d = dirs[k];
      const nd = nx * d[0] + ny * d[1] + nz * d[2];
      // A face is reachable from d when it faces d (end of the tool) or is
      // parallel to d (flank of the tool) and nothing is in the way of the
      // point just outside it.
      const parallel = Math.abs(nd) < sideTol;
      if (nd <= 0.01 && !parallel) continue;
      const off = parallel ? sideOffset : eps;
      const ox = mesh.centroid[t * 3] + nx * off, oy = mesh.centroid[t * 3 + 1] + ny * off, oz = mesh.centroid[t * 3 + 2] + nz * off;
      const h = raycast(bvh, ox, oy, oz, d[0], d[1], d[2], eps, Infinity, t);
      if (!h) { visible[k][i] = parallel ? 1 : 2; any = true; }
    }
    if (any) covered[i] = 1; else undercut += a;
  }
  // Greedy set cover by area
  const chosen = [];
  const done = new Uint8Array(tris.length);
  let remaining = total - undercut;
  for (let round = 0; round < dirs.length && remaining > 1e-6 * total; round++) {
    const gains = dirs.map((d, k) => {
      if (chosen.includes(k)) return -1;
      // head-on faces count fully, flank-cut (parallel) faces half: a direction
      // that looks straight at a face is the natural setup for it
      let gain = 0;
      for (let i = 0; i < tris.length; i++) if (visible[k][i] && !done[i]) gain += mesh.area[tris[i]] * (visible[k][i] === 2 ? 1 : 0.5);
      return gain;
    });
    const bestGain = Math.max(...gains);
    let bestK = -1;
    for (let k = 0; k < dirs.length; k++) {
      if (gains[k] < 0.9 * bestGain) continue;
      if (bestK < 0 || pref[k] > pref[bestK] || (pref[k] === pref[bestK] && gains[k] > gains[bestK])) bestK = k;
    }
    if (bestK < 0 || bestGain < 0.001 * total) break;
    chosen.push(bestK);
    for (let i = 0; i < tris.length; i++) if (visible[bestK][i]) { if (!done[i]) remaining -= mesh.area[tris[i]]; done[i] = 1; }
  }
  const axisChosen = chosen.filter((k) => k < 6);
  return {
    directions: chosen.map((k) => dirs[k]),
    minSetups3Axis: Math.max(1, Math.min(6, axisChosen.length || chosen.length || 1)),
    undercutAreaFraction: total > 0 ? undercut / total : 0,
    perDirectionFraction: dirs.map((d, k) => { let s = 0; for (let i = 0; i < tris.length; i++) if (visible[k][i]) s += mesh.area[tris[i]]; return total > 0 ? s / total : 0; }),
  };
}

/**
 * FDM/SLA overhang in the modelled orientation (+Z up). Faces lying on the
 * build plate are excluded. Support volume = overhang footprint x drop to the
 * surface below (or the bed).
 */
function overhangAnalysis(mesh, bvh, sample, patches) {
  const { tris } = sample;
  const minZ = mesh.bbox.min[2];
  const sin45 = Math.SQRT1_2;
  let total = 0, over = 0, maxAngle = 0, supportVol = 0;
  const eps = 1e-6 * mesh.diag;
  const bedTol = Math.max(1e-4, 1e-6 * mesh.diag);
  let sampledArea = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const a = mesh.area[t];
    sampledArea += a;
    total += a;
    const nz = mesh.normal[t * 3 + 2];
    if (nz >= 0) continue;
    const cz = mesh.centroid[t * 3 + 2];
    const onBed = Math.abs(cz - minZ) < bedTol && nz < -0.999;
    if (onBed) continue;
    const ang = Math.asin(Math.min(1, -nz)) / DEG; // angle of the face from vertical
    if (ang > maxAngle) maxAngle = ang;
    if (-nz <= sin45) continue;
    over += a;
    const footprint = a * (-nz);
    const h = raycast(bvh, mesh.centroid[t * 3], mesh.centroid[t * 3 + 1], cz - eps, 0, 0, -1, eps, Infinity, t);
    const drop = h ? h.t : cz - minZ;
    supportVol += footprint * Math.max(0, drop);
  }
  // scale support/overhang to the full area when downsampled
  const areaScale = sampledArea > 0 ? mesh.surfaceArea / sampledArea : 1;
  // Bridging: horizontal down-facing planar patches not on the bed → shortest in-plane span
  let maxSpan = null;
  for (const p of patches) {
    if (p.kind !== "plane" || p.normal[2] > -0.999) continue;
    const z = -p.offset; // plane z (normal is -z, offset = n·p = -z)
    if (Math.abs(z - minZ) < bedTol) continue; // resting on the bed
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (const t of p.tris) for (let c = 0; c < 3; c++) {
      const x = mesh.pos[t * 9 + c * 3], y = mesh.pos[t * 9 + c * 3 + 1];
      if (x < xlo) xlo = x; if (x > xhi) xhi = x; if (y < ylo) ylo = y; if (y > yhi) yhi = y;
    }
    const span = Math.min(xhi - xlo, yhi - ylo);
    if (maxSpan === null || span > maxSpan) maxSpan = span;
  }
  return {
    areaFraction45: total > 0 ? over / total : 0,
    maxAngleFromVertical: maxAngle,
    supportVolumeEstimate: supportVol * areaScale,
    bridging: maxSpan === null ? null : { maxSpan },
  };
}

/** Sampled self-intersection test: does any triangle edge pierce a non-adjacent triangle? */
function selfIntersections(mesh, bvh, maxTris = 60000) {
  const { queryBox } = require("./bvh");
  const n = mesh.n;
  const stride = Math.max(1, Math.ceil(n / maxTris));
  const out = [];
  const eps = 1e-7 * mesh.diag;
  for (let t = 0; t < n; t += stride) {
    const o = t * 9;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const x = mesh.pos[o + c * 3], y = mesh.pos[o + c * 3 + 1], z = mesh.pos[o + c * 3 + 2];
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
    }
    out.length = 0;
    queryBox(bvh, bx0 - eps, by0 - eps, bz0 - eps, bx1 + eps, by1 + eps, bz1 + eps, out);
    const va = mesh.vidx[t * 3], vb = mesh.vidx[t * 3 + 1], vc = mesh.vidx[t * 3 + 2];
    for (const s of out) {
      if (s === t) continue;
      const sa = mesh.vidx[s * 3], sb = mesh.vidx[s * 3 + 1], sc = mesh.vidx[s * 3 + 2];
      if (sa === va || sa === vb || sa === vc || sb === va || sb === vb || sb === vc || sc === va || sc === vb || sc === vc) continue;
      // edges of t against triangle s
      for (let e = 0; e < 3; e++) {
        const p = o + e * 3, q = o + ((e + 1) % 3) * 3;
        const dx = mesh.pos[q] - mesh.pos[p], dy = mesh.pos[q + 1] - mesh.pos[p + 1], dz = mesh.pos[q + 2] - mesh.pos[p + 2];
        const h = raySingle(mesh, s, mesh.pos[p], mesh.pos[p + 1], mesh.pos[p + 2], dx, dy, dz);
        if (h !== null && h > 1e-6 && h < 1 - 1e-6) return { found: true, sampled: stride > 1, tri: t, other: s };
      }
    }
  }
  return { found: false, sampled: stride > 1 };
}

function raySingle(mesh, tri, ox, oy, oz, dx, dy, dz) {
  const pos = mesh.pos, o = tri * 9;
  const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
  const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const tx = ox - pos[o], ty = oy - pos[o + 1], tz = oz - pos[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 1e-6 || u > 1 - 1e-6) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w < 1e-6 || u + w > 1 - 1e-6) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

module.exports = { sampleTriangles, wallThickness, tallThinAspect, accessAnalysis, overhangAnalysis, selfIntersections, pointInside };
