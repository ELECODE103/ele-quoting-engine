/**
 * Uniform grids for the 2D profile analysis (analyze.js).
 *
 * They exist only to shorten searches. Every caller still applies its own
 * original test to each candidate, in its original order; a grid may hand
 * back too many candidates but never too few. Where that "never" depends on
 * floating-point rounding staying far below a margin, the margin and the
 * condition under which it holds are stated at the function, and the caller
 * falls back to its exhaustive loop when the condition is not met
 * (`usable()`).
 */

/** Largest drawing extent (mm) for which the margins below are far above rounding error. */
const MAX_EXTENT_MM = 1e6;

/** True when every number is finite and the drawing is at most MAX_EXTENT_MM across. */
function usable(bbox) {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  return Number.isFinite(bbox[0]) && Number.isFinite(bbox[1]) && Number.isFinite(w) && Number.isFinite(h)
    && w >= 0 && h >= 0 && w <= MAX_EXTENT_MM && h <= MAX_EXTENT_MM
    && Math.abs(bbox[0]) <= 1e9 && Math.abs(bbox[1]) <= 1e9 && Math.abs(bbox[2]) <= 1e9 && Math.abs(bbox[3]) <= 1e9;
}

/**
 * Square-celled grid over a bounding box, with conservative covers of
 * segments and of infinite lines.
 *
 * "Conservative": the cover of a segment contains every cell that holds a
 * point of the segment, and the cover of a line contains every cell within
 * `margin` of the line — both widened by `margin` (1e-6 × the extent, at
 * least 1e-6 mm), which is ten orders of magnitude above the rounding error
 * of the coordinates involved when the extent is within MAX_EXTENT_MM.
 */
class CoverGrid {
  /**
   * @param {number[]} bbox [minx, miny, maxx, maxy]
   * @param {number} cellsAcross cells along the longer side
   */
  constructor(bbox, cellsAcross) {
    const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
    const extent = Math.max(w, h, 1e-9);
    this.margin = 1e-6 * Math.max(extent, 1);
    this.cell = (extent + 4 * this.margin) / Math.max(1, cellsAcross);
    this.x0 = bbox[0] - 2 * this.margin;
    this.y0 = bbox[1] - 2 * this.margin;
    this.nx = Math.max(1, Math.ceil((w + 4 * this.margin) / this.cell) + 1);
    this.ny = Math.max(1, Math.ceil((h + 4 * this.margin) / this.cell) + 1);
    this.size = this.nx * this.ny;
  }

  /** Call visit(cellIndex) for every cell of the cover of segment a→b. */
  coverSegment(ax, ay, bx, by, visit) {
    const { cell, x0, y0, nx, ny, margin } = this;
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) >= Math.abs(dy)) {
      // walk the columns; the slope is at most 1, so each column needs a short run of rows
      const lo = Math.min(ax, bx) - margin, hi = Math.max(ax, bx) + margin;
      let c0 = Math.floor((lo - x0) / cell), c1 = Math.floor((hi - x0) / cell);
      if (c0 < 0) c0 = 0; if (c1 > nx - 1) c1 = nx - 1;
      const k = dx === 0 ? 0 : dy / dx;
      for (let c = c0; c <= c1; c++) {
        let xa = x0 + c * cell, xb = xa + cell;
        if (xa < lo) xa = lo; if (xb > hi) xb = hi;
        const ya = ay + (xa - ax) * k, yb = ay + (xb - ax) * k;
        let r0 = Math.floor((Math.min(ya, yb) - 2 * margin - y0) / cell), r1 = Math.floor((Math.max(ya, yb) + 2 * margin - y0) / cell);
        if (r0 < 0) r0 = 0; if (r1 > ny - 1) r1 = ny - 1;
        for (let r = r0; r <= r1; r++) visit(r * nx + c);
      }
    } else {
      const lo = Math.min(ay, by) - margin, hi = Math.max(ay, by) + margin;
      let r0 = Math.floor((lo - y0) / cell), r1 = Math.floor((hi - y0) / cell);
      if (r0 < 0) r0 = 0; if (r1 > ny - 1) r1 = ny - 1;
      const k = dx / dy;
      for (let r = r0; r <= r1; r++) {
        let ya = y0 + r * cell, yb = ya + cell;
        if (ya < lo) ya = lo; if (yb > hi) yb = hi;
        const xa = ax + (ya - ay) * k, xb = ax + (yb - ay) * k;
        let c0 = Math.floor((Math.min(xa, xb) - 2 * margin - x0) / cell), c1 = Math.floor((Math.max(xa, xb) + 2 * margin - x0) / cell);
        if (c0 < 0) c0 = 0; if (c1 > nx - 1) c1 = nx - 1;
        for (let c = c0; c <= c1; c++) visit(r * nx + c);
      }
    }
  }

  /** Number of cells coverSegment() would visit (for sizing). */
  countSegment(ax, ay, bx, by) {
    let n = 0;
    this.coverSegment(ax, ay, bx, by, () => { n++; });
    return n;
  }

  /** Call visit(cellIndex) for every cell within `margin` of the infinite line through (px, py) along (dx, dy). */
  coverLine(px, py, dx, dy, visit) {
    const { cell, x0, y0, nx, ny, margin } = this;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const k = dx === 0 ? 0 : dy / dx;
      for (let c = 0; c < nx; c++) {
        const xa = x0 + c * cell, xb = xa + cell;
        const ya = py + (xa - px) * k, yb = py + (xb - px) * k;
        let r0 = Math.floor((Math.min(ya, yb) - 3 * margin - y0) / cell), r1 = Math.floor((Math.max(ya, yb) + 3 * margin - y0) / cell);
        if (r0 < 0) r0 = 0; if (r1 > ny - 1) r1 = ny - 1;
        for (let r = r0; r <= r1; r++) visit(r * nx + c);
      }
    } else {
      const k = dx / dy;
      for (let r = 0; r < ny; r++) {
        const ya = y0 + r * cell, yb = ya + cell;
        const xa = px + (ya - py) * k, xb = px + (yb - py) * k;
        let c0 = Math.floor((Math.min(xa, xb) - 3 * margin - x0) / cell), c1 = Math.floor((Math.max(xa, xb) + 3 * margin - x0) / cell);
        if (c0 < 0) c0 = 0; if (c1 > nx - 1) c1 = nx - 1;
        for (let c = c0; c <= c1; c++) visit(r * nx + c);
      }
    }
  }
}

/**
 * Segments of a set of polylines, indexed by cell, for ray queries.
 *
 *   const index = new SegmentIndex(loops, bbox);    // loops[i].pts, closed rings
 *   index.alongLine(px, py, dx, dy);                // then read index.loops / head / next / found
 *
 * alongLine() returns every segment that has a point within `margin` of the
 * line (and some that do not). A segment it leaves out lies entirely on one
 * side of the line, at least `margin` away — and for such a segment the ray
 * test in analyze.js (raySeg) returns null, because its parameter `s` is then
 * outside [0, 1] by far more than its 1e-9 tolerance and the rounding error.
 */
class SegmentIndex {
  constructor(loops, bbox) {
    let total = 0;
    for (const L of loops) total += L.pts.length;
    this.total = total;
    this.loopOf = new Int32Array(total);
    this.segOf = new Int32Array(total);
    this.first = new Int32Array(loops.length + 1); // id of each loop's segment 0
    const cellsAcross = Math.max(8, Math.min(1024, Math.ceil(Math.sqrt(total))));
    const grid = this.grid = new CoverGrid(bbox, cellsAcross);
    const counts = new Int32Array(grid.size + 1);
    let id = 0;
    for (let li = 0; li < loops.length; li++) {
      const pts = loops[li].pts, n = pts.length;
      this.first[li] = id;
      for (let j = 0; j < n; j++, id++) {
        this.loopOf[id] = li; this.segOf[id] = j;
        const a = pts[j], b = pts[(j + 1) % n];
        grid.coverSegment(a[0], a[1], b[0], b[1], (c) => { counts[c + 1]++; });
      }
    }
    this.first[loops.length] = id;
    for (let c = 0; c < grid.size; c++) counts[c + 1] += counts[c];
    // Many long segments on a fine grid would make the index larger than the search it saves.
    this.ok = counts[grid.size] <= SegmentIndex.MAX_ITEMS;
    if (!this.ok) return;
    this.start = counts;
    const fill = counts.slice(0, grid.size);
    this.items = new Int32Array(counts[grid.size]);
    id = 0;
    for (let li = 0; li < loops.length; li++) {
      const pts = loops[li].pts, n = pts.length;
      for (let j = 0; j < n; j++, id++) {
        const a = pts[j], b = pts[(j + 1) % n];
        const sid = id;
        grid.coverSegment(a[0], a[1], b[0], b[1], (c) => { this.items[fill[c]++] = sid; });
      }
    }
    this.stamp = new Int32Array(total);
    this.query = 0;
    this.found = new Int32Array(Math.max(16, Math.min(total, 1024)));
    this.next = new Int32Array(this.found.length);
    this.head = new Int32Array(loops.length);
    this.loopStamp = new Int32Array(loops.length);
    this.loops = new Int32Array(loops.length);
    this.loopCount = 0;
  }

  /**
   * Segments near the line, grouped by loop in ascending loop order.
   *
   * After the call: `this.loopCount` loops are in `this.loops[0 .. loopCount)`
   * (ascending), and the segments of loop `li` are the chain
   * `for (let m = this.head[li]; m >= 0; m = this.next[m]) this.segOf[this.found[m]]`
   * (in no particular order — the caller takes a minimum over them).
   * The arrays are reused by the next call.
   */
  alongLine(px, py, dx, dy) {
    const { start, items, stamp, loopOf, grid } = this;
    const { cell, x0, y0, nx, ny, margin } = grid;
    const q = ++this.query;
    let n = 0, nl = 0;
    let found = this.found, next = this.next;
    const head = this.head, loopStamp = this.loopStamp, loops = this.loops;
    // the cover of the line, as CoverGrid.coverLine() walks it
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const k = alongX ? (dx === 0 ? 0 : dy / dx) : dx / dy;
    const outer = alongX ? nx : ny, inner = alongX ? ny : nx;
    const o0 = alongX ? x0 : y0, i0 = alongX ? y0 : x0, po = alongX ? px : py, pi = alongX ? py : px;
    for (let a = 0; a < outer; a++) {
      const ua = o0 + a * cell, ub = ua + cell;
      const va = pi + (ua - po) * k, vb = pi + (ub - po) * k;
      let b0 = Math.floor((Math.min(va, vb) - 3 * margin - i0) / cell), b1 = Math.floor((Math.max(va, vb) + 3 * margin - i0) / cell);
      if (b0 < 0) b0 = 0; if (b1 > inner - 1) b1 = inner - 1;
      for (let b = b0; b <= b1; b++) {
        const c = alongX ? b * nx + a : a * nx + b;
        for (let m = start[c], e = start[c + 1]; m < e; m++) {
          const id = items[m];
          if (stamp[id] === q) continue;
          stamp[id] = q;
          if (n === found.length) {
            const f2 = new Int32Array(found.length * 2); f2.set(found); found = this.found = f2;
            const n2 = new Int32Array(next.length * 2); n2.set(next); next = this.next = n2;
          }
          const li = loopOf[id];
          if (loopStamp[li] !== q) { loopStamp[li] = q; head[li] = -1; loops[nl++] = li; }
          found[n] = id; next[n] = head[li]; head[li] = n; n++;
        }
      }
    }
    this.loopCount = nl;
    if (nl > 1) loops.subarray(0, nl).sort();
  }
}

/**
 * Loops indexed by bounding box, for ray queries: which loops could a ray's line touch?
 *
 *   const index = new LoopIndex(loops, bbox);       // loops[i].bbox
 *   index.alongLine(px, py, dx, dy);                // index.near[0 .. index.count) ascending
 *
 * A loop left out has its whole bounding box (and so every one of its
 * segments) on one side of the line, more than `margin` away; raySeg() in
 * analyze.js returns null for every such segment.
 */
class LoopIndex {
  constructor(loops, bbox) {
    const n = loops.length;
    const grid = this.grid = new CoverGrid(bbox, Math.max(4, Math.min(512, Math.ceil(Math.sqrt(n)))));
    const { cell, x0, y0, nx, ny, margin } = grid;
    const col = (x) => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cell)));
    const row = (y) => Math.max(0, Math.min(ny - 1, Math.floor((y - y0) / cell)));
    const WIDE = 64; // a loop over more cells than this is kept on a list every query takes whole
    const wide = [];
    const counts = new Int32Array(grid.size + 1);
    const range = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const b = loops[i].bbox;
      const c0 = col(b[0] - 2 * margin), c1 = col(b[2] + 2 * margin), r0 = row(b[1] - 2 * margin), r1 = row(b[3] + 2 * margin);
      range[i * 4] = c0; range[i * 4 + 1] = c1; range[i * 4 + 2] = r0; range[i * 4 + 3] = r1;
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > WIDE) { wide.push(i); range[i * 4] = -1; continue; }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * nx + c + 1]++;
    }
    for (let c = 0; c < grid.size; c++) counts[c + 1] += counts[c];
    this.start = counts;
    const fill = counts.slice(0, grid.size);
    this.items = new Int32Array(counts[grid.size]);
    for (let i = 0; i < n; i++) {
      if (range[i * 4] < 0) continue;
      for (let r = range[i * 4 + 2]; r <= range[i * 4 + 3]; r++) for (let c = range[i * 4]; c <= range[i * 4 + 1]; c++) this.items[fill[r * nx + c]++] = i;
    }
    this.wide = Int32Array.from(wide);
    this.stamp = new Int32Array(n);
    this.query = 0;
    this.near = new Int32Array(n);
    this.count = 0;
  }

  /** Loops whose bounding box comes within the margin of the line: this.near[0 .. this.count), ascending. */
  alongLine(px, py, dx, dy) {
    const { start, items, stamp, near, wide, grid } = this;
    const { cell, x0, y0, nx, ny, margin } = grid;
    const q = ++this.query;
    let n = 0;
    for (let i = 0; i < wide.length; i++) near[n++] = wide[i];
    // the cover of the line, as CoverGrid.coverLine() walks it
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const k = alongX ? (dx === 0 ? 0 : dy / dx) : dx / dy;
    const outer = alongX ? nx : ny, inner = alongX ? ny : nx;
    const o0 = alongX ? x0 : y0, i0 = alongX ? y0 : x0, po = alongX ? px : py, pi = alongX ? py : px;
    for (let a = 0; a < outer; a++) {
      const ua = o0 + a * cell, ub = ua + cell;
      const va = pi + (ua - po) * k, vb = pi + (ub - po) * k;
      let b0 = Math.floor((Math.min(va, vb) - 3 * margin - i0) / cell), b1 = Math.floor((Math.max(va, vb) + 3 * margin - i0) / cell);
      if (b0 < 0) b0 = 0; if (b1 > inner - 1) b1 = inner - 1;
      for (let b = b0; b <= b1; b++) {
        const c = alongX ? b * nx + a : a * nx + b;
        for (let m = start[c], e = start[c + 1]; m < e; m++) {
          const id = items[m];
          if (stamp[id] !== q) { stamp[id] = q; near[n++] = id; }
        }
      }
    }
    this.count = n;
    if (n > 1) near.subarray(0, n).sort();
  }
}

/**
 * Points (or small boxes) bucketed on a square grid, for "what is near here"
 * and "which boxes contain this point" queries. Numeric cell keys; cells are
 * created as needed, so the extent of the data does not matter.
 */
class Buckets {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(cx, cy) { return (cx + 33554432) * 67108864 + (cy + 33554432); } // |cx|, |cy| < 2^25
  cellOf(v) { return Math.floor(v / this.cell); }
  add(cx, cy, item) {
    const k = this.key(cx, cy);
    const b = this.map.get(k);
    if (b) b.push(item); else this.map.set(k, [item]);
  }
  get(cx, cy) { return this.map.get(this.key(cx, cy)); }
  /** Are cell indices for coordinates up to `maxAbs` representable by key()? */
  static fits(maxAbs, cell) { return cell > 0 && Number.isFinite(maxAbs / cell) && maxAbs / cell < 3e7; }
}

SegmentIndex.MAX_ITEMS = 12000000;

module.exports = { CoverGrid, SegmentIndex, LoopIndex, Buckets, usable, MAX_EXTENT_MM };
