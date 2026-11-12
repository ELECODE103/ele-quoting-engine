/**
 * Mesh generators for the geometry benchmark corpus.
 *
 * Everything here is deterministic (a seeded generator, no Date, no
 * Math.random) so a case produces the same bytes on every run: the corpus is
 * generated at run time and only its results are stored.
 *
 * A mesh is a `Soup`: a flat array of numbers, 9 per triangle. Writers for
 * binary STL, ASCII STL and 3MF are in ./formats.js.
 */
const path = require("path");
const testMesh = require(path.join(__dirname, "..", "..", "..", "server", "geometry", "testMesh"));

/** mulberry32: small seeded generator, returns numbers in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Soup {
  constructor() { this.a = []; }
  get count() { return this.a.length / 9; }
  tri(p, q, r) { this.a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); return this; }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); return this; }
  /** Append another soup, optionally transformed by fn([x,y,z]) → [x,y,z]. */
  add(other, fn) {
    const src = other.a || other;
    if (!fn) { for (let i = 0; i < src.length; i++) this.a.push(src[i]); return this; }
    for (let i = 0; i < src.length; i += 3) { const p = fn([src[i], src[i + 1], src[i + 2]]); this.a.push(p[0], p[1], p[2]); }
    return this;
  }
  map(fn) { const out = new Soup(); out.add(this, fn); return out; }
  /** Reverse the winding of every triangle (inside-out). */
  flipped() {
    const out = new Soup();
    for (let i = 0; i < this.a.length; i += 9) {
      const s = this.a;
      out.a.push(s[i], s[i + 1], s[i + 2], s[i + 6], s[i + 7], s[i + 8], s[i + 3], s[i + 4], s[i + 5]);
    }
    return out;
  }
  signedVolume() {
    let v = 0;
    const s = this.a;
    for (let o = 0; o < s.length; o += 9) {
      v += s[o] * (s[o + 4] * s[o + 8] - s[o + 7] * s[o + 5]) + s[o + 3] * (s[o + 7] * s[o + 2] - s[o + 1] * s[o + 8]) + s[o + 6] * (s[o + 1] * s[o + 5] - s[o + 4] * s[o + 2]);
    }
    return v / 6;
  }
  /** Make the winding outward (positive volume). */
  outward() { return this.signedVolume() < 0 ? this.flipped() : this; }
}
const fromPositions = (positions) => { const s = new Soup(); for (let i = 0; i < positions.length; i++) s.a.push(positions[i]); return s; };

// ── transforms ───────────────────────────────────────────────────────────────
const translate = (dx, dy, dz) => (p) => [p[0] + dx, p[1] + dy, p[2] + dz];
function rotation(ax, ay, az) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  return (p) => {
    let [x, y, z] = p;
    let t = y * cx - z * sx; z = y * sx + z * cx; y = t;
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;
    return [x, y, z];
  };
}
const compose = (...fns) => (p) => fns.reduce((q, f) => f(q), p);

// ── spheres, blobs, tori ─────────────────────────────────────────────────────
/**
 * UV sphere of about `n` triangles. `radiusAt(nx, ny, nz)` (default 1) scales
 * the radius per direction: a smooth function gives an organic blob.
 * opts.skipBand = [lo, hi] leaves out the stacks in that range (an open mesh).
 */
function uvSphere(n, r = 25, radiusAt = null, opts = {}) {
  const stacks = Math.max(3, Math.round(Math.sqrt(n / 4)));
  const slices = 2 * stacks;
  const s = new Soup();
  const pt = (i, j) => {
    const th = (Math.PI * i) / stacks, ph = (2 * Math.PI * (j % slices)) / slices;
    const nx = Math.sin(th) * Math.cos(ph), ny = Math.sin(th) * Math.sin(ph), nz = Math.cos(th);
    const rr = r * (radiusAt ? radiusAt(nx, ny, nz) : 1);
    return [nx * rr, ny * rr, nz * rr];
  };
  const north = pt(0, 0), south = pt(stacks, 0);
  for (let i = 0; i < stacks; i++) {
    if (opts.skipBand && i >= opts.skipBand[0] && i < opts.skipBand[1]) continue;
    for (let j = 0; j < slices; j++) {
      if (i === 0) s.tri(north, pt(1, j), pt(1, j + 1));
      else if (i === stacks - 1) s.tri(pt(i, j), south, pt(i, j + 1));
      else s.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1));
    }
  }
  return s;
}

/** Smooth organic displacement: a few low-frequency lobes (amplitude ~ ±amp). */
function lobes(seed, amp = 0.18, count = 5, freq = 3) {
  const R = rng(seed);
  const terms = [];
  for (let k = 0; k < count; k++) terms.push([R() * 2 - 1, R() * 2 - 1, R() * 2 - 1, 1 + R() * freq, R() * 6.283]);
  return (x, y, z) => {
    let d = 0;
    for (const [a, b, c, f, ph] of terms) d += Math.sin(f * (a * x + b * y + c * z) * 2 + ph);
    return 1 + (amp * d) / count;
  };
}
/** Lobes plus fine surface texture (a scanned / sculpted part). */
function roughLobes(seed, amp = 0.15, fine = 0.01) {
  const base = lobes(seed, amp), tex = lobes(seed + 77, 1, 6, 40);
  return (x, y, z) => base(x, y, z) + fine * (tex(x, y, z) - 1);
}

function torus(n, R = 30, r = 9) {
  const sides = Math.max(3, Math.round(Math.sqrt(n / 4)));
  const rings = 2 * sides;
  const s = new Soup();
  const pt = (i, j) => {
    const u = (2 * Math.PI * (i % rings)) / rings, w = (2 * Math.PI * (j % sides)) / sides;
    const c = R + r * Math.cos(w);
    return [c * Math.cos(u), c * Math.sin(u), r * Math.sin(w)];
  };
  for (let i = 0; i < rings; i++) for (let j = 0; j < sides; j++) s.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1));
  return s.outward();
}

/** Subdivided icosahedron projected on a sphere: 20·4^level triangles, no poles. */
function icosphere(level, r = 25) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const unit = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
  verts = verts.map(unit);
  for (let l = 0; l < level; l++) {
    const mid = new Map(), next = [];
    const m = (a, b) => {
      const k = a < b ? a * 4194304 + b : b * 4194304 + a;
      if (!mid.has(k)) { mid.set(k, verts.length); verts.push(unit([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2])); }
      return mid.get(k);
    };
    for (const [a, b, c] of faces) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  const s = new Soup();
  for (const [a, b, c] of faces) s.tri(verts[a].map((x) => x * r), verts[b].map((x) => x * r), verts[c].map((x) => x * r));
  return s.outward();
}

// ── solids of revolution ─────────────────────────────────────────────────────
/**
 * Revolve a closed (r, z) polygon about Z. Points with r = 0 collapse onto the
 * axis. `edgeSub` splits every profile edge so the triangle count can be set.
 */
function lathe(profile, slices, edgeSub = 1) {
  const pts = [];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i], b = profile[(i + 1) % profile.length];
    for (let k = 0; k < edgeSub; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / edgeSub, a[1] + ((b[1] - a[1]) * k) / edgeSub]);
  }
  const s = new Soup();
  const P = (i, j) => { const p = pts[i % pts.length], ph = (2 * Math.PI * (j % slices)) / slices; return [p[0] * Math.cos(ph), p[0] * Math.sin(ph), p[1]]; };
  for (let i = 0; i < pts.length; i++) {
    const r0 = pts[i][0], r1 = pts[(i + 1) % pts.length][0];
    for (let j = 0; j < slices; j++) {
      if (r0 === 0 && r1 === 0) continue;
      if (r0 === 0) s.tri(P(i, j), P(i + 1, j + 1), P(i + 1, j));
      else if (r1 === 0) s.tri(P(i, j), P(i, j + 1), P(i + 1, j));
      else s.quad(P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j));
    }
  }
  return s.outward();
}
/** Thin-walled cup (open top): radius R, height H, wall and floor t. */
function cup(n, R = 30, H = 60, t = 1.6) {
  const profile = [[0, 0], [R, 0], [R, H], [R - t, H], [R - t, t], [0, t]];
  const slices = Math.max(8, Math.round(Math.sqrt(n / 3)));
  const edgeSub = Math.max(1, Math.round(n / (2 * slices * 6)));
  return lathe(profile, slices, edgeSub);
}
/** Stepped shaft with a centre bore (a turned part). */
function shaft(n) {
  const profile = [[4, 0], [12, 0], [12, 20], [18, 20], [18, 28], [10, 28], [10, 70], [7, 76], [4, 76]];
  const slices = Math.max(8, Math.round(n / (2 * profile.length)));
  return lathe(profile, slices, 1);
}
/** Bottle-like curved shell of revolution (thin wall, smooth profile). */
function vase(n, t = 1.2) {
  const m = Math.max(6, Math.round(Math.sqrt(n / 8)));
  const outer = [], inner = [];
  for (let k = 0; k <= m; k++) {
    const z = (90 * k) / m, r = 22 + 9 * Math.sin((z / 90) * Math.PI * 1.6) - 6 * (z / 90);
    outer.push([r, z]); if (k > 0) inner.push([r - t, z]);
  }
  const profile = [[0, 0], ...outer, ...inner.reverse(), [0, (90 / m)]];
  // the inner floor sits one step up; close it to the axis
  const slices = Math.max(8, Math.round(n / (2 * profile.length)));
  return lathe(profile, slices, 1);
}

// ── boxes and plates ─────────────────────────────────────────────────────────
function box(w, d, h, x = 0, y = 0, z = 0) {
  const s = new Soup();
  const p = (i, j, k) => [x + i * w, y + j * d, z + k * h];
  s.quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0));
  s.quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1));
  s.quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1));
  s.quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1));
  s.quad(p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1));
  s.quad(p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1));
  return s;
}
/** Prism with a regular k-gon cross-section along an axis (0 = x, 1 = y, 2 = z). */
function prism(k, radius, length, axis = 2, cx = 0, cy = 0, cz = 0) {
  const s = new Soup();
  const ring = (t) => { const out = []; for (let i = 0; i < k; i++) { const a = (2 * Math.PI * i) / k; out.push([radius * Math.cos(a), radius * Math.sin(a), t]); } return out; };
  const lo = ring(0), hi = ring(length);
  for (let i = 0; i < k; i++) { const j = (i + 1) % k; s.quad(lo[i], lo[j], hi[j], hi[i]); s.tri([0, 0, 0], lo[j], lo[i]); s.tri([0, 0, length], hi[i], hi[j]); }
  const turn = axis === 2 ? (p) => p : axis === 0 ? (p) => [p[2], p[0], p[1]] : (p) => [p[1], p[2], p[0]];
  return s.map((p) => { const q = turn(p); return [q[0] + cx, q[1] + cy, q[2] + cz]; });
}

/**
 * Plate with a grid of features (through holes, slots, pockets, countersinks,
 * counterbores, blind holes) built with the repo's cell-based plate builder.
 * `cells` × `cells` cells; `segs` facets per circle.
 */
function featurePlate(cells, segs, opts = {}) {
  const pitch = opts.pitch || 24, T = opts.thickness || 10;
  const W = cells * pitch, H = cells * pitch;
  const cuts = []; for (let i = 0; i <= cells; i++) cuts.push(i * pitch);
  const kinds = opts.kinds || ["hole", "pocket", "slot", "csk", "cbore", "blind", null, "hole"];
  const features = {};
  let k = 0;
  for (let ix = 0; ix < cells; ix++) for (let iy = 0; iy < cells; iy++) {
    const kind = kinds[(k++ * 7 + ix * 3 + iy) % kinds.length];
    if (!kind) continue;
    const cx = (ix + 0.5) * pitch, cy = (iy + 0.5) * pitch;
    const rr = 2.5 + ((ix * 5 + iy * 3) % 5) * 0.7;
    if (kind === "hole") features[ix + "," + iy] = { kind, loop: testMesh.circle(rr, segs, cx, cy) };
    else if (kind === "slot") features[ix + "," + iy] = { kind, loop: testMesh.stadium(14, 5, Math.max(3, segs >> 2), cx, cy) };
    else if (kind === "pocket") features[ix + "," + iy] = { kind, loop: testMesh.roundedRect(16, 12, 3, Math.max(2, segs >> 3), cx, cy), depth: 4 };
    else if (kind === "csk") features[ix + "," + iy] = { kind, loop: testMesh.circle(3.3, segs, cx, cy), loopTop: testMesh.circle(6.5, segs, cx, cy), depth: 3.2 };
    else if (kind === "cbore") features[ix + "," + iy] = { kind, loop: testMesh.circle(3.3, segs, cx, cy), loopTop: testMesh.circle(5.5, segs, cx, cy), depth: 4 };
    else if (kind === "blind") features[ix + "," + iy] = { kind, loop: testMesh.circle(rr, segs, cx, cy), depth: 6 };
  }
  return fromPositions(testMesh.buildPlate(W, H, T, cuts, cuts, features).positions);
}
/** Choose cells / segs for a feature plate of about n triangles: few big cells or many. */
function featurePlateFor(n, style = "many") {
  if (style === "dense") { // 3 × 3 features, very finely faceted cylinders
    const segs = Math.max(8, Math.round(n / (9 * 7)));
    return featurePlate(3, segs);
  }
  const segs = n <= 3000 ? 12 : n <= 30000 ? 24 : 32;
  const cells = Math.max(2, Math.round(Math.sqrt(n / (segs * 5.5))));
  return featurePlate(cells, segs);
}

// ── height-map solids (embossed text, waffle plates, pocket grids) ───────────
/**
 * Watertight solid from a grid of per-cell heights (0 = no material is not
 * supported: every cell has height > 0). Walls between cells of different
 * height are split at every level that meets their vertical edges, so the mesh
 * has no T-junctions.
 */
function heightGrid(h, nx, ny, cell = 1) {
  const s = new Soup();
  const H = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : h[j * nx + i]);
  const levelsAt = (i, j) => { // distinct heights of the (up to) four cells around grid corner (i, j), plus 0 on the rim
    const set = new Set([H(i - 1, j - 1), H(i, j - 1), H(i - 1, j), H(i, j)]);
    return Array.from(set).sort((a, b) => a - b);
  };
  const wall = (x0, y0, x1, y1, lo, hi, c0, c1) => {
    // vertical polygon from (x0,y0) to (x1,y1) between lo and hi; the material is on the left of the direction of travel
    const left = c0.filter((z) => z > lo && z < hi), right = c1.filter((z) => z > lo && z < hi);
    const poly = [[x0, y0, lo], [x1, y1, lo], ...right.map((z) => [x1, y1, z]), [x1, y1, hi], [x0, y0, hi], ...left.reverse().map((z) => [x0, y0, z])];
    for (let k = 1; k + 1 < poly.length; k++) s.tri(poly[0], poly[k], poly[k + 1]);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const z = H(i, j), x0 = i * cell, x1 = (i + 1) * cell, y0 = j * cell, y1 = (j + 1) * cell;
    s.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
    s.quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]);
    // walls where this cell is the higher one (outward faces away from it)
    const nb = [[i, j - 1, x1, y0, x0, y0, i + 1, j, i, j], [i + 1, j, x1, y1, x1, y0, i + 1, j + 1, i + 1, j], [i, j + 1, x0, y1, x1, y1, i, j + 1, i + 1, j + 1], [i - 1, j, x0, y0, x0, y1, i, j, i, j + 1]];
    for (const [ni, nj, ax, ay, bx, by, ci, cj, di, dj] of nb) {
      const zn = H(ni, nj);
      if (zn >= z) continue;
      wall(bx, by, ax, ay, zn, z, levelsAt(di, dj), levelsAt(ci, cj));
    }
  }
  return s.outward();
}
// 5 × 7 pixel font, enough for a part number
const FONT = {
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"], A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"], G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"], E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], 0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"], 2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], 7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"], " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
/**
 * Plate with pixel-font text raised (or engraved when emboss < 0). `scale`
 * cells per font pixel sets the triangle count; lines of text are stacked.
 */
function textPlate(lines, scale, emboss = 0.8, base = 4, cellMm = 0.5) {
  const cols = Math.max(...lines.map((l) => l.length)) * 6 + 3, rows = lines.length * 9 + 3;
  const nx = cols * scale, ny = rows * scale;
  const h = new Float64Array(nx * ny).fill(base);
  lines.forEach((text, li) => {
    for (let c = 0; c < text.length; c++) {
      const g = FONT[text[c]] || FONT[" "];
      for (let py = 0; py < 7; py++) for (let px = 0; px < 5; px++) {
        if (g[py][px] !== "1") continue;
        const gx = 2 + c * 6 + px, gy = rows - 3 - li * 9 - py - 1;
        for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) h[(gy * scale + b) * nx + gx * scale + a] = base + emboss;
      }
    }
  });
  return heightGrid(h, nx, ny, cellMm / scale * 4);
}
function textPlateFor(n, emboss = 0.8) {
  const lines = ["STRAIGHTEDGE", "ID-2047-A"];
  // triangles ≈ 4 per cell + walls; cells = (12*6+3)*(2*9+3)*scale² = 1575·scale²
  const scale = Math.max(1, Math.round(Math.sqrt(n / (1575 * 4.3))));
  return textPlate(lines, scale, emboss);
}
/** Waffle / pocket-grid plate: a regular grid of square pockets (a 2.5D lattice). */
function waffle(n, depth = 6, base = 2) {
  const reps = Math.max(2, Math.round(Math.sqrt(n / 400)));
  const period = 8, nx = reps * period + 2, ny = nx;
  const h = new Float64Array(nx * ny).fill(base + depth);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = (i - 1) % period, b = (j - 1) % period;
    if (i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && a >= 1 && a <= 6 && b >= 1 && b <= 6) h[j * nx + i] = base;
  }
  return heightGrid(h, nx, ny, 1.5);
}
/** Smooth terrain on a flat base: a relief / topographic model (shared vertices, watertight). */
function relief(n, seed = 5) {
  const m = Math.max(4, Math.round(Math.sqrt(n / 2.2)));
  const f = lobes(seed, 1, 6, 2.5);
  const size = 80, z = (i, j) => 6 + 4 * (f((i / m) * 2 - 1, (j / m) * 2 - 1, 0.3) - 1) * 3;
  const s = new Soup();
  const P = (i, j) => [(size * i) / m, (size * j) / m, z(i, j)], B = (i, j) => [(size * i) / m, (size * j) / m, 0];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    s.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
    s.quad(B(i, j), B(i, j + 1), B(i + 1, j + 1), B(i + 1, j));
  }
  for (let i = 0; i < m; i++) {
    s.quad(B(i, 0), B(i + 1, 0), P(i + 1, 0), P(i, 0));
    s.quad(B(i + 1, m), B(i, m), P(i, m), P(i + 1, m));
    s.quad(B(0, i + 1), B(0, i), P(0, i), P(0, i + 1));
    s.quad(B(m, i), B(m, i + 1), P(m, i + 1), P(m, i));
  }
  return s.outward();
}
/** The top surface of a relief only: a single-sided sheet (nothing closed). */
function openSheet(n, seed = 9) {
  const m = Math.max(4, Math.round(Math.sqrt(n / 2)));
  const f = lobes(seed, 1, 5, 2);
  const s = new Soup();
  const P = (i, j) => [(60 * i) / m, (60 * j) / m, 5 * (f((i / m) * 2 - 1, (j / m) * 2 - 1, 0.1) - 1) * 2];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) s.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
  return s;
}

// ── lattices, multi-body, defective meshes ───────────────────────────────────
/** 3D grid of bars (separate overlapping bodies): k-sided struts along X, Y and Z. */
function lattice(n, sides = 4) {
  const perBar = sides === 4 ? 12 : 4 * sides;
  const g = Math.max(2, Math.round(Math.sqrt(n / (3 * perBar)))); // 3·g² bars in all
  const pitch = 10, L = (g - 1) * pitch + 4, w = 1.6;
  const s = new Soup();
  for (let a = 0; a < g; a++) for (let b = 0; b < g; b++) {
    const u = a * pitch, v2 = b * pitch;
    if (sides === 4) {
      s.add(box(L, w, w, -2, u - w / 2, v2 - w / 2));
      s.add(box(w, L, w, u - w / 2, -2, v2 - w / 2));
      s.add(box(w, w, L, u - w / 2, v2 - w / 2, -2));
    } else {
      s.add(prism(sides, w / 2, L, 0, -2, u, v2));
      s.add(prism(sides, w / 2, L, 1, u, -2, v2));
      s.add(prism(sides, w / 2, L, 2, u, v2, -2));
    }
  }
  return s;
}
/** Several separate bodies in one file: spheres, a torus, boxes and a prism. */
function multiBody(n) {
  const s = new Soup(), each = Math.max(60, Math.floor(n / 5));
  s.add(uvSphere(each, 12), translate(0, 0, 12));
  s.add(uvSphere(each, 8, lobes(3, 0.2)), translate(40, 0, 10));
  s.add(torus(each, 14, 4), translate(0, 45, 4));
  s.add(featurePlateFor(each), compose((p) => [p[0] * 0.3, p[1] * 0.3, p[2] * 0.5], translate(30, 30, 0)));
  s.add(box(10, 14, 6, 70, 0, 0));
  s.add(prism(Math.max(6, Math.round(each / 4)), 6, 20, 2, 75, 40, 0));
  return s;
}
/** Hollow sphere: an outer shell and an inverted inner shell (a closed internal void). */
function hollowSphere(n, R = 25, t = 1.5) {
  const s = new Soup();
  s.add(uvSphere(n / 2, R));
  s.add(uvSphere(n / 2, R - t).flipped());
  return s;
}
/** Two boxes sharing one edge, plus a fin: edges used by more than two triangles. */
function nonManifold() {
  const s = new Soup();
  s.add(box(10, 10, 10, 0, 0, 0));
  s.add(box(10, 10, 10, 10, 10, 0));
  s.tri([0, 0, 10], [10, 0, 10], [5, 0, 18]); // fin standing on a top edge
  return s;
}
/** Sphere with every k-th triangle given the wrong winding. */
function mixedWinding(n, every = 7) {
  const base = uvSphere(n, 20), s = new Soup();
  for (let t = 0; t < base.count; t++) {
    const a = base.a.slice(t * 9, t * 9 + 9);
    if (t % every === 3) s.a.push(a[0], a[1], a[2], a[6], a[7], a[8], a[3], a[4], a[5]); else s.a.push(...a);
  }
  return s;
}
/** A good mesh with zero-area and duplicate triangles mixed in. */
function withDefects(base) {
  const s = new Soup();
  for (let t = 0; t < base.count; t++) {
    const a = base.a.slice(t * 9, t * 9 + 9);
    s.a.push(...a);
    if (t % 97 === 5) s.a.push(a[0], a[1], a[2], a[0], a[1], a[2], a[3], a[4], a[5]); // zero area
    if (t % 131 === 9) s.a.push(...a);                                                   // exact duplicate
  }
  return s;
}
/** Unwelded soup: every triangle's corners nudged so no two triangles share an edge. */
function shattered(n, seed = 21) {
  const base = uvSphere(n, 20), R = rng(seed), s = new Soup();
  for (let i = 0; i < base.a.length; i++) s.a.push(base.a[i] + (R() - 0.5) * 0.02);
  return s;
}
/**
 * Random triangle soup: `n` unrelated triangles in a 100 mm cube. `reach` is the size of a
 * triangle: small (2 mm) for local slivers, or the whole cube when every corner is anywhere.
 * Nothing is connected to anything — no adjacency, no inside or outside.
 */
function randomSoup(n, reach = 2, seed = 31) {
  const R = rng(seed), s = new Soup();
  for (let t = 0; t < n; t++) {
    if (reach >= 100) { for (let k = 0; k < 9; k++) s.a.push(R() * 100); continue; }
    const cx = R() * 100, cy = R() * 100, cz = R() * 100;
    for (let k = 0; k < 3; k++) s.a.push(cx + (R() - 0.5) * reach, cy + (R() - 0.5) * reach, cz + (R() - 0.5) * reach);
  }
  return s;
}
/** Box whose top face is finely subdivided while its neighbours are not (T-junctions, open edges). */
function tJunctionBox(m = 20) {
  const s = new Soup(), W = 40, D = 30, Hh = 12;
  const p = (i, j, k) => [i * W, j * D, k * Hh];
  s.quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0));
  s.quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1));
  s.quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1));
  s.quad(p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1));
  s.quad(p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1));
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) s.quad(p(i / m, j / m, 1), p((i + 1) / m, j / m, 1), p((i + 1) / m, (j + 1) / m, 1), p(i / m, (j + 1) / m, 1));
  return s;
}
/** Two bodies that pass through each other (a real self-intersection). */
function intersecting(n) {
  const s = new Soup();
  s.add(uvSphere(n / 2, 15));
  s.add(uvSphere(n / 2, 15), translate(18, 0, 0));
  return s;
}
/** L-bracket with a gusset, extruded and tilted off the axes. */
function bracket(tilt = true) {
  const profile = [[0, 0], [60, 0], [60, 8], [8, 8], [8, 50], [0, 50]];
  const s = fromPositions(testMesh.extrudeProfileY(profile, 40));
  return tilt ? s.map(rotation(0.31, -0.52, 0.17)) : s;
}

module.exports = {
  rng, Soup, fromPositions, translate, rotation, compose,
  uvSphere, lobes, roughLobes, torus, icosphere, lathe, cup, shaft, vase, box, prism,
  featurePlate, featurePlateFor, heightGrid, textPlate, textPlateFor, waffle, relief, openSheet,
  lattice, multiBody, hollowSphere, nonManifold, mixedWinding, withDefects, shattered, randomSoup, tJunctionBox, intersecting, bracket,
  testMesh,
};
