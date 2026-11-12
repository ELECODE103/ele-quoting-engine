/**
 * Outline of the part's projection along an axis.
 *
 * Method (exact for CAD meshes, no rasterising):
 *   1. project every triangle onto the plane perpendicular to the axis;
 *   2. candidate outline segments are the edges of edge-on (vertical)
 *      triangles, edges shared by an up-facing and a down-facing triangle, and
 *      open mesh edges; duplicates and collinear overlaps are merged;
 *   3. a candidate is an outline segment iff exactly one side of it is covered
 *      by the projection (point-in-projection test on a uniform grid of the
 *      projected triangles); the covered side fixes the orientation so that
 *      material is on the left;
 *   4. segments are chained into loops: counter-clockwise loops are outer
 *      outlines, clockwise loops are cutouts.
 *
 * From the loops: outer/inner perimeter, area, bbox, smallest concave
 * (material-side) corner radius, narrowest gap (slot width).
 */
const { v } = require("./vec");

/**
 * Insertion-ordered index of number pairs: add(a, b) returns the id of the
 * pair (its position in order of first appearance), find(a, b) its id or -1.
 * Replaces Map keys built by joining the two numbers into a string. Callers
 * pass finite numbers only (a string key treats NaN as equal to itself, `===`
 * does not), and keep a text-keyed path for anything else.
 */
class PairIndex {
  constructor(expected = 64) {
    let cap = 64;
    while (cap < expected * 2) cap *= 2;
    this.slots = new Int32Array(cap).fill(-1);
    this.a = new Float64Array(Math.max(32, expected));
    this.b = new Float64Array(Math.max(32, expected));
    this.count = 0;
  }
  static hash(a, b) {
    let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((a / 4294967296) | 0, 0x85ebca6b);
    h = Math.imul((h << 15) | (h >>> 17), 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2f) ^ Math.imul((b / 4294967296) | 0, 0x165667b1);
    return h ^ (h >>> 15);
  }
  find(a, b) {
    const slots = this.slots, mask = slots.length - 1, A = this.a, B = this.b;
    for (let h = PairIndex.hash(a, b) & mask; ; h = (h + 1) & mask) {
      const id = slots[h];
      if (id < 0) return -1;
      if (A[id] === a && B[id] === b) return id;
    }
  }
  /** Id of the pair; `this.added` says whether this call created it. */
  add(a, b) {
    let slots = this.slots, mask = slots.length - 1;
    let h = PairIndex.hash(a, b) & mask;
    for (; ; h = (h + 1) & mask) {
      const id = slots[h];
      if (id < 0) break;
      if (this.a[id] === a && this.b[id] === b) { this.added = false; return id; }
    }
    const id = this.count++;
    if (id === this.a.length) {
      const a2 = new Float64Array(id * 2); a2.set(this.a); this.a = a2;
      const b2 = new Float64Array(id * 2); b2.set(this.b); this.b = b2;
    }
    this.a[id] = a; this.b[id] = b;
    slots[h] = id;
    this.added = true;
    if (this.count * 2 > slots.length) { // grow and re-seat
      slots = this.slots = new Int32Array(slots.length * 2).fill(-1);
      mask = slots.length - 1;
      for (let i = 0; i < this.count; i++) {
        let g = PairIndex.hash(this.a[i], this.b[i]) & mask;
        while (slots[g] >= 0) g = (g + 1) & mask;
        slots[g] = i;
      }
    }
    return id;
  }
}

function projectionFrame(axis) {
  const a = v.norm(axis);
  const [u, w] = v.basis(a);
  return { a, u, w };
}

/**
 * @param {object} mesh
 * @param {number[]} axis
 * @returns {object} outline result
 */
function computeOutline(mesh, axis) {
  const { a, u, w } = projectionFrame(axis);
  const n = mesh.n;
  const nv = mesh.nv;
  // 2D vertex coordinates
  const px = new Float64Array(nv), py = new Float64Array(nv);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = mesh.verts[i * 3], y = mesh.verts[i * 3 + 1], z = mesh.verts[i * 3 + 2];
    px[i] = x * u[0] + y * u[1] + z * u[2];
    py[i] = x * w[0] + y * w[1] + z * w[2];
    if (px[i] < minx) minx = px[i]; if (px[i] > maxx) maxx = px[i];
    if (py[i] < miny) miny = py[i]; if (py[i] > maxy) maxy = py[i];
  }
  const size = Math.max(maxx - minx, maxy - miny) || 1;
  const eps2 = 1e-9 * size * size; // 2D area threshold for "vertical"

  // Classify triangles: +1 up (CCW in 2D), -1 down, 0 vertical
  const facing = new Int8Array(n);
  const area2 = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const i0 = mesh.vidx[t * 3], i1 = mesh.vidx[t * 3 + 1], i2 = mesh.vidx[t * 3 + 2];
    const ar = 0.5 * ((px[i1] - px[i0]) * (py[i2] - py[i0]) - (py[i1] - py[i0]) * (px[i2] - px[i0]));
    area2[t] = ar;
    const nd = mesh.normal[t * 3] * a[0] + mesh.normal[t * 3 + 1] * a[1] + mesh.normal[t * 3 + 2] * a[2];
    facing[t] = Math.abs(ar) <= eps2 || Math.abs(nd) < 1e-6 ? 0 : (nd > 0 ? 1 : -1);
  }

  // Candidate segments keyed by quantised 2D endpoints (an unordered pair), kept in order of
  // first appearance: four numbers per segment in `cand`, from the endpoint with the lower key.
  const q = 1e6 / size;
  const seen = new PairIndex(1024);
  let textSeen = null; // keys with a non-finite number (NaN coordinates) keep their string form
  let cand = new Float64Array(4096), candCount = 0;
  const addSeg = (ia, ib) => {
    const ax = px[ia], ay = py[ia], bx = px[ib], by = py[ib];
    const ka = Math.round((ax - minx) * q) * 4194304 + Math.round((ay - miny) * q);
    const kb = Math.round((bx - minx) * q) * 4194304 + Math.round((by - miny) * q);
    if (ka === kb) return;
    if (ka - ka === 0 && kb - kb === 0) {
      if (ka < kb) seen.add(ka, kb); else seen.add(kb, ka);
      if (!seen.added) return;
    } else {
      const key = ka < kb ? ka + ":" + kb : kb + ":" + ka;
      if (!textSeen) textSeen = new Set();
      if (textSeen.has(key)) return;
      textSeen.add(key);
    }
    if (candCount * 4 === cand.length) { const bigger = new Float64Array(cand.length * 2); bigger.set(cand); cand = bigger; }
    const o = candCount++ * 4;
    if (ka < kb) { cand[o] = ax; cand[o + 1] = ay; cand[o + 2] = bx; cand[o + 3] = by; }
    else { cand[o] = bx; cand[o + 1] = by; cand[o + 2] = ax; cand[o + 3] = ay; }
  };
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const o = mesh.adj[t * 3 + e];
      const ia = mesh.vidx[t * 3 + e], ib = mesh.vidx[t * 3 + ((e + 1) % 3)];
      if (facing[t] === 0) { addSeg(ia, ib); continue; }
      if (o < 0) { addSeg(ia, ib); continue; }
      if (o < t) continue; // handled from the other side
      if (facing[o] === 0 || facing[o] !== facing[t]) addSeg(ia, ib);
    }
  }
  const merged = mergeCollinear(cand, candCount, size);
  cand = null;

  // Coverage grid of non-vertical triangles
  const grid = buildGrid(mesh, px, py, facing, minx, miny, maxx, maxy);
  // Probe distance from the segment: far smaller than the sagitta of any
  // tessellation chord (which is what separates a real outline edge from a
  // chord that merely skips a vertex of a staggered band), yet far above
  // double-precision noise on coordinates of this magnitude.
  const delta = Math.max(1e-8 * size, 1e-6);
  const oriented = [];
  for (let i = 0, end = merged.count * 4; i < end; i += 4) {
    const s0 = merged.xy[i], s1 = merged.xy[i + 1], s2 = merged.xy[i + 2], s3 = merged.xy[i + 3];
    const dx = s2 - s0, dy = s3 - s1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len, ny = dx / len; // left normal
    const mx = (s0 + s2) / 2, my = (s1 + s3) / 2;
    const leftIn = grid.covered(mx + nx * delta, my + ny * delta);
    const rightIn = grid.covered(mx - nx * delta, my - ny * delta);
    if (leftIn === rightIn) continue;
    // material on the left
    if (leftIn) oriented.push([s0, s1, s2, s3]);
    else oriented.push([s2, s3, s0, s1]);
  }

  let loops = chainLoops(oriented, size);
  // Open fragments much shorter than the main outline are tessellation noise
  // (chords of staggered bands), not geometry.
  const longestClosed = loops.reduce((m, L) => (L.closed && L.length > m ? L.length : m), 0);
  const dropped = new Set(loops.filter((L) => !L.closed && L.length < 0.01 * longestClosed));
  loops = loops.filter((L) => !dropped.has(L));
  let outerPerimeter = 0, innerPerimeter = 0, areaSum = 0;
  const outer = [], inner = [];
  for (const L of loops) {
    const A = polyArea(L.pts);
    areaSum += A;
    if (L.closed && A < 0) { inner.push(L); innerPerimeter += L.length; }
    else { outer.push(L); outerPerimeter += L.length; }
  }
  // If chaining failed badly, fall back to raw segment sums (area from grid estimate)
  const closedAll = loops.every((L) => L.closed);
  let minInternalRadius = null, minSlotWidth = null;
  for (const L of loops) {
    if (!L.closed) continue;
    // Round holes are reported in `holes` with their diameters; they are not
    // outline corner radii or slot widths.
    const A = Math.abs(polyArea(L.pts));
    if (polyArea(L.pts) < 0 && L.length > 0 && (4 * Math.PI * A) / (L.length * L.length) >= 0.95) continue;
    const r = loopMinConcaveRadius(L.pts);
    if (r !== null) minInternalRadius = minInternalRadius === null ? r : Math.min(minInternalRadius, r);
    const g = loopMinGap(L.pts, size);
    if (g !== null) minSlotWidth = minSlotWidth === null ? g : Math.min(minSlotWidth, g);
  }

  return {
    axis: a, u, w,
    area: Math.max(0, areaSum),
    perimeter: outerPerimeter,
    innerPerimeter,
    bboxW: maxx - minx, bboxH: maxy - miny,
    minInternalRadius, minSlotWidth,
    loops: loops.map((L) => ({ pts: L.pts, closed: L.closed, length: L.length, area: polyArea(L.pts), outer: polyArea(L.pts) >= 0 })),
    outerCount: outer.length, innerCount: inner.length,
    closed: closedAll,
    segmentCount: oriented.length,
    droppedFragments: dropped.size,
  };
}

/**
 * Merge collinear overlapping segments (same line, overlapping parameter ranges).
 *
 * @param {Float64Array} xy four numbers per segment @param {number} count
 * @returns {{xy: Float64Array, count: number}} merged segments, groups in order of first
 *          appearance and each group's runs in ascending order along the line
 *
 * Lines are grouped by (angle bucket, offset bucket). The two integers are
 * packed into one number as the map key (a string when they do not fit), and
 * the members of a group are kept in flat arrays instead of an array of
 * [lo, hi] pairs per group.
 */
function mergeCollinear(xy, count, size) {
  const groupOfKey = new Map();
  const angQ = 1e4, offQ = 1e5 / size;
  const gDx = [], gDy = [], gOff = [], gSize = [];
  const segGroup = new Int32Array(count).fill(-1), lo = new Float64Array(count), hi = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const s0 = xy[i * 4], s1 = xy[i * 4 + 1], s2 = xy[i * 4 + 2], s3 = xy[i * 4 + 3];
    let dx = s2 - s0, dy = s3 - s1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;
    dx /= len; dy /= len;
    if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
    const ang = Math.atan2(dy, dx);
    const off = -dy * s0 + dx * s1; // perpendicular offset of the line
    const ka = Math.round(ang * angQ), kb = Math.round(off * offQ);
    const key = ka - ka === 0 && kb - kb === 0 && Math.abs(ka) < 1048576 && Math.abs(kb) < 2147483648
      ? (ka + 1048576) * 4294967296 + (kb + 2147483648)
      : ka + ":" + kb;
    const t0 = dx * s0 + dy * s1, t1 = dx * s2 + dy * s3;
    let g = groupOfKey.get(key);
    if (g === undefined) { g = gDx.length; groupOfKey.set(key, g); gDx.push(dx); gDy.push(dy); gOff.push(off); gSize.push(0); }
    gSize[g]++;
    segGroup[i] = g; lo[i] = Math.min(t0, t1); hi[i] = Math.max(t0, t1);
  }
  // members of each group, in order of appearance
  const G = gDx.length;
  const start = new Int32Array(G + 1);
  for (let g = 0; g < G; g++) start[g + 1] = start[g] + gSize[g];
  const fill = start.slice(0, G), member = new Int32Array(start[G]);
  for (let i = 0; i < count; i++) if (segGroup[i] >= 0) member[fill[segGroup[i]]++] = i;

  let out = new Float64Array(Math.max(16, start[G] * 4)), outCount = 0;
  for (let g = 0; g < G; g++) {
    const dx = gDx[g], dy = gDy[g], off = gOff[g];
    const nx = -dy, ny = dx; // p = t * d + off * n
    const emit = (a, b) => {
      const o = outCount++ * 4;
      out[o] = a * dx + off * nx; out[o + 1] = a * dy + off * ny; out[o + 2] = b * dx + off * nx; out[o + 3] = b * dy + off * ny;
    };
    const from = start[g], to = start[g + 1];
    if (to - from === 1) { const i = member[from]; emit(lo[i], hi[i]); continue; }
    // ascending by lo; equal ones keep their order of appearance (the sort is stable)
    const items = Array.from(member.subarray(from, to)).sort((p, q) => lo[p] - lo[q]);
    let curLo = lo[items[0]], curHi = hi[items[0]];
    for (let k = 1; k < items.length; k++) {
      const i = items[k];
      if (lo[i] <= curHi + 1e-7 * size) curHi = Math.max(curHi, hi[i]);
      else { emit(curLo, curHi); curLo = lo[i]; curHi = hi[i]; }
    }
    emit(curLo, curHi);
  }
  return { xy: out, count: outCount };
}

/**
 * Uniform grid over projected non-vertical triangles for point coverage tests.
 *
 * covered(x, y) is true when some triangle whose bounding box spans the
 * point's cell contains the point. A triangle used to be listed in every cell
 * its box spans; the long faces of a lattice span hundreds of cells each and
 * made that hundreds of megabytes. Now a triangle is listed where that takes
 * at most LIST_MAX entries:
 *   - in the cells themselves when it spans few of them;
 *   - in the blocks of a coarser level (4, 16, 64 … cells on a side) when it is large both ways;
 *   - once per row, or per column, when it is long and thin.
 * Its span in cells is kept and checked when a coarser list is read, so the
 * triangles tried for a cell are exactly those that span it, as before (the
 * answer is "any of them", so their order does not matter).
 */
function buildGrid(mesh, px, py, facing, minx, miny, maxx, maxy) {
  const n = mesh.n, vidx = mesh.vidx;
  let count = 0;
  for (let t = 0; t < n; t++) if (facing[t] !== 0) count++;
  const cells = Math.max(8, Math.min(1024, Math.ceil(Math.sqrt(count / 2))));
  const W = (maxx - minx) || 1, H = (maxy - miny) || 1;
  const cellW = W / cells, cellH = H / cells;
  const LIST_MAX = 16, THIN = 2;
  // levels: level k has blocks of 4^k cells on a side
  const shift = [0], side = [cells];
  while (side[side.length - 1] > 1) { shift.push(shift.length * 2); side.push(Math.ceil(cells / (1 << (shift.length - 1) * 2))); }
  const LEVELS = shift.length;
  // span of every triangle in cells: x0, x1, y0, y1 (-1 = not in the grid)
  const span = new Int16Array(n * 4).fill(-1);
  const where = new Int8Array(n); // 0..LEVELS-1 = that level, 100 = row lists, 101 = column lists, -1 = nowhere
  const levelStart = [], rowStart = new Int32Array(cells + 1), colStart = new Int32Array(cells + 1);
  for (let k = 0; k < LEVELS; k++) levelStart.push(new Int32Array(side[k] * side[k] + 1));
  for (let t = 0; t < n; t++) {
    where[t] = -1;
    if (facing[t] === 0) continue;
    const i0 = vidx[t * 3], i1 = vidx[t * 3 + 1], i2 = vidx[t * 3 + 2];
    const x0 = Math.min(px[i0], px[i1], px[i2]), x1 = Math.max(px[i0], px[i1], px[i2]);
    const y0 = Math.min(py[i0], py[i1], py[i2]), y1 = Math.max(py[i0], py[i1], py[i2]);
    const cx0 = clampCell((x0 - minx) / cellW, cells), cx1 = clampCell((x1 - minx) / cellW, cells);
    const cy0 = clampCell((y0 - miny) / cellH, cells), cy1 = clampCell((y1 - miny) / cellH, cells);
    if (!(cx0 <= cx1 && cy0 <= cy1)) continue; // a NaN coordinate: the triangle was in no cell before either
    span[t * 4] = cx0; span[t * 4 + 1] = cx1; span[t * 4 + 2] = cy0; span[t * 4 + 3] = cy1;
    const nx = cx1 - cx0 + 1, ny = cy1 - cy0 + 1;
    if (nx * ny > LIST_MAX && Math.min(nx, ny) <= THIN) {
      if (ny <= nx) { where[t] = 100; for (let cy = cy0; cy <= cy1; cy++) rowStart[cy + 1]++; }
      else { where[t] = 101; for (let cx = cx0; cx <= cx1; cx++) colStart[cx + 1]++; }
      continue;
    }
    let k = 0;
    while (((cx1 >> shift[k]) - (cx0 >> shift[k]) + 1) * ((cy1 >> shift[k]) - (cy0 >> shift[k]) + 1) > LIST_MAX) k++;
    where[t] = k;
    const st = levelStart[k], sd = side[k], sh = shift[k];
    for (let by = cy0 >> sh; by <= cy1 >> sh; by++) for (let bx = cx0 >> sh; bx <= cx1 >> sh; bx++) st[by * sd + bx + 1]++;
  }
  const levelTris = [], levelFill = [];
  for (let k = 0; k < LEVELS; k++) {
    const st = levelStart[k], m = side[k] * side[k];
    for (let i = 0; i < m; i++) st[i + 1] += st[i];
    levelTris.push(new Int32Array(st[m])); levelFill.push(st.slice(0, m));
  }
  for (let i = 0; i < cells; i++) { rowStart[i + 1] += rowStart[i]; colStart[i + 1] += colStart[i]; }
  const rowTris = new Int32Array(rowStart[cells]), colTris = new Int32Array(colStart[cells]);
  const rowFill = rowStart.slice(0, cells), colFill = colStart.slice(0, cells);
  for (let t = 0; t < n; t++) {
    const k = where[t];
    if (k < 0) continue;
    const cx0 = span[t * 4], cx1 = span[t * 4 + 1], cy0 = span[t * 4 + 2], cy1 = span[t * 4 + 3];
    if (k === 100) { for (let cy = cy0; cy <= cy1; cy++) rowTris[rowFill[cy]++] = t; continue; }
    if (k === 101) { for (let cx = cx0; cx <= cx1; cx++) colTris[colFill[cx]++] = t; continue; }
    const fill = levelFill[k], tris = levelTris[k], sd = side[k], sh = shift[k];
    for (let by = cy0 >> sh; by <= cy1 >> sh; by++) for (let bx = cx0 >> sh; bx <= cx1 >> sh; bx++) tris[fill[by * sd + bx]++] = t;
  }
  const inside = (t, x, y) => {
    const i0 = vidx[t * 3], i1 = vidx[t * 3 + 1], i2 = vidx[t * 3 + 2];
    return pointInTri(x, y, px[i0], py[i0], px[i1], py[i1], px[i2], py[i2]);
  };
  const spans = (t, cx, cy) => span[t * 4] <= cx && cx <= span[t * 4 + 1] && span[t * 4 + 2] <= cy && cy <= span[t * 4 + 3];
  const fineStart = levelStart[0], fineTris = levelTris[0];
  const covered = (x, y) => {
    if (x < minx || x > maxx || y < miny || y > maxy) return false;
    const cx = clampCell((x - minx) / cellW, cells), cy = clampCell((y - miny) / cellH, cells);
    const c = cy * cells + cx;
    for (let m = fineStart[c], e = fineStart[c + 1]; m < e; m++) if (inside(fineTris[m], x, y)) return true;
    for (let k = 1; k < LEVELS; k++) {
      const st = levelStart[k], tris = levelTris[k], b = (cy >> shift[k]) * side[k] + (cx >> shift[k]);
      for (let m = st[b], e = st[b + 1]; m < e; m++) { const t = tris[m]; if (spans(t, cx, cy) && inside(t, x, y)) return true; }
    }
    for (let m = rowStart[cy], e = rowStart[cy + 1]; m < e; m++) { const t = rowTris[m]; if (spans(t, cx, cy) && inside(t, x, y)) return true; }
    for (let m = colStart[cx], e = colStart[cx + 1]; m < e; m++) { const t = colTris[m]; if (spans(t, cx, cy) && inside(t, x, y)) return true; }
    return false;
  };
  return { covered };
}

function clampCell(f, cells) { return Math.max(0, Math.min(cells - 1, Math.floor(f))); }

function pointInTri(x, y, x0, y0, x1, y1, x2, y2) {
  const d0 = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
  const d1 = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  const d2 = (x0 - x2) * (y - y2) - (y0 - y2) * (x - x2);
  const neg = d0 < 0 || d1 < 0 || d2 < 0;
  const pos = d0 > 0 || d1 > 0 || d2 > 0;
  return !(neg && pos);
}

/**
 * Chain oriented segments into loops by endpoint matching.
 *
 * End points are matched on a grid of 1e-6 × size. Each distinct start point
 * is a node (PairIndex of its two grid numbers) with its outgoing segments in
 * index order; the walk and its choice at a junction are those of
 * chainLoopsText(), which builds the same keys as strings.
 */
function chainLoops(segs, size) {
  const q = 1e6 / size;
  const n = segs.length;
  const kx0 = new Float64Array(n), ky0 = new Float64Array(n), kx1 = new Float64Array(n), ky1 = new Float64Array(n);
  let finite = true;
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    kx0[i] = Math.round(s[0] * q); ky0[i] = Math.round(s[1] * q); kx1[i] = Math.round(s[2] * q); ky1[i] = Math.round(s[3] * q);
    if (!(kx0[i] - kx0[i] === 0 && ky0[i] - ky0[i] === 0 && kx1[i] - kx1[i] === 0 && ky1[i] - ky1[i] === 0)) { finite = false; break; }
  }
  if (!finite) return chainLoopsText(segs, size);

  // nodes = distinct start points; outgoing segments per node, ascending
  const nodes = new PairIndex(n);
  const nodeOf = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeOf[i] = nodes.add(kx0[i], ky0[i]);
  const outStart = new Int32Array(nodes.count + 1);
  for (let i = 0; i < n; i++) outStart[nodeOf[i] + 1]++;
  for (let k = 0; k < nodes.count; k++) outStart[k + 1] += outStart[k];
  const outFill = outStart.slice(0, nodes.count), outSeg = new Int32Array(n);
  for (let i = 0; i < n; i++) outSeg[outFill[nodeOf[i]]++] = i;

  const used = new Uint8Array(n);
  const loops = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const pts = [[segs[i][0], segs[i][1]]];
    let cur = i, length = 0, closed = false;
    const sx = kx0[i], sy = ky0[i];
    for (let guard = 0; guard < n + 1; guard++) {
      used[cur] = 1;
      const s = segs[cur];
      length += Math.hypot(s[2] - s[0], s[3] - s[1]);
      if (kx1[cur] === sx && ky1[cur] === sy) { closed = true; break; }
      pts.push([s[2], s[3]]);
      const node = nodes.find(kx1[cur], ky1[cur]);
      if (node < 0) break;
      // unused segments leaving this point: the first one, or at a junction the sharpest right
      // turn (keeps material on the left), the earliest on a tie
      let next = -1, free = 0, best = -Infinity, first = -1;
      const dx = s[2] - s[0], dy = s[3] - s[1];
      for (let m = outStart[node], e = outStart[node + 1]; m < e; m++) {
        const j = outSeg[m];
        if (used[j]) continue;
        if (free++ === 0) { first = j; continue; }
        if (free === 2) { // a second candidate: now the turns matter, starting with the first one's
          const fx = segs[first][2] - segs[first][0], fy = segs[first][3] - segs[first][1];
          const turn = Math.atan2(dx * fy - dy * fx, dx * fx + dy * fy);
          if (-turn > best) { best = -turn; next = first; }
        }
        const ex = segs[j][2] - segs[j][0], ey = segs[j][3] - segs[j][1];
        const turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
        if (-turn > best) { best = -turn; next = j; }
      }
      if (free === 0) break;
      cur = free === 1 || next < 0 ? first : next;
    }
    loops.push({ pts, closed, length });
  }
  return loops;
}

/** chainLoops() with text keys: used when a coordinate is not finite ("NaN" must match "NaN"). */
function chainLoopsText(segs, size) {
  const q = 1e6 / size;
  const key = (x, y) => Math.round(x * q) + ":" + Math.round(y * q);
  const outgoing = new Map();
  segs.forEach((s, i) => {
    const k = key(s[0], s[1]);
    if (!outgoing.has(k)) outgoing.set(k, []);
    outgoing.get(k).push(i);
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const pts = [[segs[i][0], segs[i][1]]];
    let cur = i, length = 0, closed = false;
    const startKey = key(segs[i][0], segs[i][1]);
    for (let guard = 0; guard < segs.length + 1; guard++) {
      used[cur] = 1;
      const s = segs[cur];
      length += Math.hypot(s[2] - s[0], s[3] - s[1]);
      const k = key(s[2], s[3]);
      if (k === startKey) { closed = true; break; }
      pts.push([s[2], s[3]]);
      const cands = (outgoing.get(k) || []).filter((j) => !used[j]);
      if (cands.length === 0) break;
      let next = cands[0];
      if (cands.length > 1) {
        // prefer the sharpest right turn (keeps material on the left at junctions)
        const dx = s[2] - s[0], dy = s[3] - s[1];
        let best = -Infinity;
        for (const j of cands) {
          const ex = segs[j][2] - segs[j][0], ey = segs[j][3] - segs[j][1];
          const turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
          if (-turn > best) { best = -turn; next = j; }
        }
      }
      cur = next;
    }
    loops.push({ pts, closed, length });
  }
  return loops;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Smallest concave (material-side) corner radius of a loop oriented with
 * material on the left: right turns are concave corners. A single right turn
 * sharper than 30 deg is a sharp corner (radius 0); runs of gentle right turns
 * are arcs whose radius is chord / (2 sin(theta/2)).
 */
function loopMinConcaveRadius(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let minR = null;
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const ax = c[0] - p[0], ay = c[1] - p[1], bx = q[0] - c[0], by = q[1] - c[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-12 || lb < 1e-12) continue;
    const cross = ax * by - ay * bx, dot = ax * bx + ay * by;
    const turn = Math.atan2(cross, dot); // >0 left, <0 right
    if (turn >= -1e-6) continue;
    const theta = -turn;
    let r;
    if (theta > 30 * Math.PI / 180) r = 0;
    else r = ((la + lb) / 2) / (2 * Math.sin(theta / 2));
    if (minR === null || r < minR) minR = r;
  }
  return minR;
}

/**
 * Narrowest gap across the non-material side of a loop: from each vertex cast
 * a ray to the right (away from material) and find the nearest crossing with
 * the same loop (ignoring the two edges at the vertex).
 */
function loopMinGap(pts, size) {
  const n = pts.length;
  if (n < 4) return null;
  let best = null;
  const step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    // outward (right) normal of the average direction at the vertex
    let dx = (c[0] - p[0]) + (q[0] - c[0]), dy = (c[1] - p[1]) + (q[1] - c[1]);
    const l = Math.hypot(dx, dy);
    if (l < 1e-12) continue;
    dx /= l; dy /= l;
    const rx = dy, ry = -dx; // right normal
    let tBest = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || j === (i - 1 + n) % n) continue;
      const a = pts[j], b = pts[(j + 1) % n];
      const t = raySegment(c[0], c[1], rx, ry, a[0], a[1], b[0], b[1]);
      if (t !== null && t > 1e-6 * size && t < tBest) tBest = t;
    }
    if (tBest < Infinity && (best === null || tBest < best)) best = tBest;
  }
  return best;
}

function raySegment(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
  const s = ((ax - ox) * dy - (ay - oy) * dx) / den;
  if (t < 0 || s < 0 || s > 1) return null;
  return t;
}

module.exports = { computeOutline, projectionFrame, loopMinConcaveRadius, loopMinGap, polyArea, chainLoops };
