/**
 * Minimal axis-aligned BVH over mesh triangles (flat typed arrays, median split
 * on the longest centroid axis). Used for ray casting (thickness, visibility,
 * overhang support, inside/outside tests) and box queries (self-intersection).
 */

const LEAF_SIZE = 6;

function buildBVH(mesh) {
  const n = mesh.n;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Per-triangle bounds
  const tmin = new Float64Array(n * 3), tmax = new Float64Array(n * 3);
  const pos = mesh.pos;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const a = pos[o + k], b = pos[o + 3 + k], c = pos[o + 6 + k];
      tmin[t * 3 + k] = Math.min(a, b, c);
      tmax[t * 3 + k] = Math.max(a, b, c);
    }
  }
  const maxNodes = 2 * Math.ceil(n / 1) + 1;
  const nmin = new Float64Array(maxNodes * 3), nmax = new Float64Array(maxNodes * 3);
  const left = new Int32Array(maxNodes), right = new Int32Array(maxNodes);
  const start = new Int32Array(maxNodes), count = new Int32Array(maxNodes);
  let nodeCount = 0;
  const cen = mesh.centroid;

  // Iterative build with an explicit stack of (node, lo, hi)
  const stack = [[nodeCount++, 0, n]];
  while (stack.length) {
    const [node, lo, hi] = stack.pop();
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      if (tmin[t * 3] < bx0) bx0 = tmin[t * 3]; if (tmax[t * 3] > bx1) bx1 = tmax[t * 3];
      if (tmin[t * 3 + 1] < by0) by0 = tmin[t * 3 + 1]; if (tmax[t * 3 + 1] > by1) by1 = tmax[t * 3 + 1];
      if (tmin[t * 3 + 2] < bz0) bz0 = tmin[t * 3 + 2]; if (tmax[t * 3 + 2] > bz1) bz1 = tmax[t * 3 + 2];
      const cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    nmin[node * 3] = bx0; nmin[node * 3 + 1] = by0; nmin[node * 3 + 2] = bz0;
    nmax[node * 3] = bx1; nmax[node * 3 + 1] = by1; nmax[node * 3 + 2] = bz1;
    const cnt = hi - lo;
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    if (cnt <= LEAF_SIZE || (ex <= 0 && ey <= 0 && ez <= 0)) {
      left[node] = -1; right[node] = -1; start[node] = lo; count[node] = cnt;
      continue;
    }
    const axis = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2);
    const mid = (lo + hi) >> 1;
    quickSelect(order, lo, hi - 1, mid, cen, axis);
    const l = nodeCount++, r = nodeCount++;
    left[node] = l; right[node] = r; start[node] = lo; count[node] = cnt;
    stack.push([l, lo, mid], [r, mid, hi]);
  }
  return { mesh, order, nmin, nmax, left, right, start, count, nodeCount };
}

function quickSelect(order, lo, hi, k, cen, axis) {
  while (lo < hi) {
    const pivot = cen[order[(lo + hi) >> 1] * 3 + axis];
    let i = lo, j = hi;
    while (i <= j) {
      while (cen[order[i] * 3 + axis] < pivot) i++;
      while (cen[order[j] * 3 + axis] > pivot) j--;
      if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return;
  }
}

/**
 * Nearest ray hit. dir need not be unit; t is in units of |dir|.
 * @returns {{t:number, tri:number, u:number, v:number}|null}
 */
function raycast(bvh, ox, oy, oz, dx, dy, dz, tMin = 1e-7, tMax = Infinity, skipTri = -1) {
  const { nmin, nmax, left, right, start, count, order, mesh } = bvh;
  const pos = mesh.pos;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  let best = tMax, bestTri = -1, bu = 0, bv = 0;
  const stack = new Int32Array(128);
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp];
    // Slab test
    const n3 = node * 3;
    let t0 = (nmin[n3] - ox) * idx, t1 = (nmax[n3] - ox) * idx;
    let tn = Math.min(t0, t1), tf = Math.max(t0, t1);
    t0 = (nmin[n3 + 1] - oy) * idy; t1 = (nmax[n3 + 1] - oy) * idy;
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
    t0 = (nmin[n3 + 2] - oz) * idz; t1 = (nmax[n3 + 2] - oz) * idz;
    tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1));
    if (tf < tn || tf < tMin || tn > best) continue;
    if (left[node] < 0) {
      const s = start[node], e = s + count[node];
      for (let i = s; i < e; i++) {
        const tri = order[i];
        if (tri === skipTri) continue;
        const o = tri * 9;
        const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
        const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-14 && det < 1e-14) continue;
        const inv = 1 / det;
        const tx = ox - pos[o], ty = oy - pos[o + 1], tz = oz - pos[o + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (dx * qx + dy * qy + dz * qz) * inv;
        if (w < -1e-9 || u + w > 1 + 1e-9) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin && t < best) { best = t; bestTri = tri; bu = u; bv = w; }
      }
    } else {
      stack[sp++] = left[node];
      stack[sp++] = right[node];
    }
  }
  return bestTri < 0 ? null : { t: best, tri: bestTri, u: bu, v: bv };
}

/** Count all ray hits (for parity inside/outside tests). */
function countHits(bvh, ox, oy, oz, dx, dy, dz, tMin = 1e-7) {
  let c = 0;
  let t = tMin;
  for (let guard = 0; guard < 10000; guard++) {
    const h = raycast(bvh, ox, oy, oz, dx, dy, dz, t, Infinity);
    if (!h) break;
    c++;
    t = h.t + 1e-7 * (1 + Math.abs(h.t));
  }
  return c;
}

/** Parity-vote inside test with three skewed rays (robust to edge hits). */
function pointInside(bvh, p) {
  const dirs = [[0.577, 0.577, 0.577], [-0.267, 0.802, -0.535], [0.707, -0.5, 0.5]];
  let votes = 0;
  for (const d of dirs) votes += countHits(bvh, p[0], p[1], p[2], d[0], d[1], d[2]) % 2;
  return votes >= 2;
}

/** Triangles whose bounds overlap the box. */
function queryBox(bvh, bx0, by0, bz0, bx1, by1, bz1, out) {
  const { nmin, nmax, left, right, start, count, order } = bvh;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    const n3 = node * 3;
    if (nmax[n3] < bx0 || nmin[n3] > bx1 || nmax[n3 + 1] < by0 || nmin[n3 + 1] > by1 || nmax[n3 + 2] < bz0 || nmin[n3 + 2] > bz1) continue;
    if (left[node] < 0) {
      const s = start[node], e = s + count[node];
      for (let i = s; i < e; i++) out.push(order[i]);
    } else {
      stack.push(left[node], right[node]);
    }
  }
  return out;
}

module.exports = { buildBVH, raycast, countHits, pointInside, queryBox };
