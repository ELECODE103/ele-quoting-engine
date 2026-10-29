// Round-3 geometry for STRAIGHTEDGE: the two directions the owner picked (D · Knife Edge,
// E · The Kerf), each refined into two candidates with a nod to machining and additive.
// Everything is authored in a 100-unit space and returned as SVG path data.
const r = (n) => Math.round(n * 100) / 100;
const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)} ${r(y)}`).join('') + 'Z';
const tx = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
const scale = (pts, k) => pts.map(([x, y]) => [x * k, y * k]);

// keep the part of a convex polygon where nx*x + ny*y - c >= 0
function clipHalf(pts, nx, ny, c) {
  const f = ([x, y]) => nx * x + ny * y - c;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length], fa = f(A), fb = f(B);
    if (fa >= 0) out.push(A);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
  }
  return out;
}

// ─── D · the blade ──────────────────────────────────────────────────────────
// A straightedge blade, L long and T thick at the heel. The top is the true edge (dead flat
// over the full length). The far end is ground to a point over the last (1 - taperFrom) of
// the length; the point carries a tiny flat (`tip`) so it never frays when printed, stitched
// or stamped. The heel's lower corner is broken with a 45° chamfer that is built from
// `steps` printed layers — the stair-step an FDM part shows on any chamfer — so the one
// shape carries both processes: layered heel, ground edge.
function blade(L, T, { taperFrom = 0.48, steps = 3, chamfer = 0.58, tip = 0.07 } = {}) {
  const tipH = T * tip;
  const s = (T * chamfer) / steps;        // one layer
  const pts = [[0, 0], [L, 0], [L, tipH], [L * taperFrom, T]];
  // stair down the heel's lower corner, from (steps*s, T) to (0, T - steps*s)
  for (let i = 0; i < steps; i++) {
    const x = (steps - i) * s, y = T - i * s;
    pts.push([x, y], [x, y - s]);
  }
  pts.push([0, T - steps * s]);
  return pts;
}

// ─── D3 · the corner: two blades meeting dead square ────────────────────────
// Two knife edges sharing one heel. The inner faces are the true edges (they form the
// square corner the name sits in); each outer face runs flat and then grinds to a point.
// The upright's taper is a slanted wall, which an FDM printer builds as stair-steps — so the
// upright carries the layers and the flat blade carries the ground edge.
function corner(L1, L2, T, { taperFrom = 0.46, steps = 5, tip = 0.07, printedUpright = true } = {}) {
  const H = L2, tipH = T * tip;
  const yT = H - L2 * taperFrom;          // where the upright's outer taper starts
  const pts = [[0, H], [0, yT]];
  if (printedUpright) {
    const dx = (T - tipH) / steps, dy = yT / steps;
    for (let i = 1; i <= steps; i++) pts.push([(i - 1) * dx, yT - i * dy], [i * dx, yT - i * dy]);
  } else pts.push([T - tipH, 0]);
  pts.push([T, 0], [T, H - T], [L1, H - T], [L1, H - T + tipH], [L1 * taperFrom, H]);
  return pts;
}

// ─── E · the kerf square ────────────────────────────────────────────────────
// A square of stock parted by one dead-straight cut through its centre, rising to the right
// at `angle` degrees; `kerf` is the width of the cut. Nothing moved — the two halves still
// make the square.
function kerfPieces(S, { angle = 20, kerf = 7, chamfer = 0 } = {}) {
  const a = (-angle * Math.PI) / 180;
  const nx = -Math.sin(a), ny = Math.cos(a);
  const c = nx * (S / 2) + ny * (S / 2);
  let sq = [[0, 0], [S, 0], [S, S], [0, S]];
  if (chamfer) { const ch = S * chamfer; sq = [[ch, 0], [S - ch, 0], [S, ch], [S, S - ch], [S - ch, S], [ch, S], [0, S - ch], [0, ch]]; }
  const upper = clipHalf(sq, -nx, -ny, -c + kerf / 2);
  const lower = clipHalf(sq, nx, ny, c + kerf / 2);
  // y of the lower piece's top face at x (the lower kerf line)
  const yLow = (x) => (c + kerf / 2 - nx * x) / ny;
  const yUp = (x) => (c - kerf / 2 - nx * x) / ny;
  return { upper, lower, sq, yLow, yUp, nx, ny, c };
}

// E2 · Layers: the lower half is built of printed layers (horizontal strips), the upper half
// is solid machined stock; the one cut runs true through both.
function kerfLayers(S, { layer = 8, gap = 3.2, ...opt } = {}) {
  const { upper, lower, nx, ny, c } = kerfPieces(S, opt);
  const strips = [];
  for (let y1 = S; y1 > 0; y1 -= layer + gap) {
    const y0 = Math.max(0, y1 - layer);
    const rect = [[0, y0], [S, y0], [S, y1], [0, y1]];
    const p = clipHalf(rect, nx, ny, c + (opt.kerf || 7) / 2);
    if (p.length >= 3) strips.push(p);
  }
  return { upper, lower, strips };
}

// E3 · Light: the upper half's kerf face is the straightedge (dead straight); the lower half's
// kerf face is printed to the slope, so it is a staircase, and the light between the true edge
// and the steps is the kerf. (A straightedge laid on a printed part shows exactly this.)
function kerfLight(S, { steps = 6, ...opt } = {}) {
  const { upper, yLow } = kerfPieces(S, opt);
  const ch = (opt.chamfer || 0) * S;
  // build the lower piece: bottom edge, right edge up to the last tread, then stairs leftward
  const xs = Array.from({ length: steps + 1 }, (_, i) => (S * i) / steps);
  const lowerPts = [];
  if (ch) lowerPts.push([0, S - ch], [ch, S], [S - ch, S], [S, S - ch]); else lowerPts.push([0, S], [S, S]);
  // stairs from right to left: tread i spans [xs[i], xs[i+1]] at height yLow(xs[i])
  for (let i = steps - 1; i >= 0; i--) {
    lowerPts.push([xs[i + 1], yLow(xs[i])]);
    lowerPts.push([xs[i], yLow(xs[i])]);
  }
  return { upper, lower: lowerPts };
}

module.exports = { r, poly, tx, scale, clipHalf, blade, corner, kerfPieces, kerfLayers, kerfLight };
