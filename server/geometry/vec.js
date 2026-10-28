/**
 * Small numeric helpers: 3-vectors as plain arrays, symmetric 3x3 eigen
 * decomposition (Jacobi), least-squares circle fit. No dependencies.
 */
const EPS = 1e-9;

const v = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
  norm: (a) => { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  neg: (a) => [-a[0], -a[1], -a[2]],
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  /** Two unit vectors orthogonal to unit vector a. */
  basis: (a) => {
    const h = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = v.norm(v.cross(a, h));
    const w = v.cross(a, u);
    return [u, w];
  },
  /** Make the sign canonical so parallel axes compare equal (largest |component| positive). */
  canon: (a) => {
    const i = Math.abs(a[0]) >= Math.abs(a[1]) && Math.abs(a[0]) >= Math.abs(a[2]) ? 0 : (Math.abs(a[1]) >= Math.abs(a[2]) ? 1 : 2);
    return a[i] < 0 ? v.neg(a) : a.slice();
  },
  round: (a, d = 4) => a.map((x) => roundTo(x, d)),
};

function roundTo(x, d = 3) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const p = Math.pow(10, d);
  const r = Math.round(x * p) / p;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Eigen-decomposition of a symmetric 3x3 matrix [[a,b,c],[b,d,e],[c,e,f]]
 * by cyclic Jacobi. Returns { values: [l0,l1,l2] ascending, vectors: [[..],[..],[..]] } (unit).
 */
function symEig3(m) {
  const a = [[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => v.norm([V[0][i], V[1][i], V[2][i]])),
  };
}

/**
 * Algebraic (Kasa) least-squares circle fit to 2D points.
 * @param {number[]} xs @param {number[]} ys @param {number[]=} w weights
 * @returns {{cx:number, cy:number, r:number, rms:number}|null}
 */
function fitCircle2D(xs, ys, w) {
  const n = xs.length;
  if (n < 3) return null;
  // Solve [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy S] [D E F]^T = -[Sxxx+Sxyy; Sxxy+Syyy; Sxx+Syy]
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxxx = 0, Syyy = 0, Sxxy = 0, Sxyy = 0, S = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], wi = w ? w[i] : 1;
    S += wi; Sx += wi * x; Sy += wi * y; Sxx += wi * x * x; Syy += wi * y * y; Sxy += wi * x * y;
    Sxxx += wi * x * x * x; Syyy += wi * y * y * y; Sxxy += wi * x * x * y; Sxyy += wi * x * y * y;
  }
  const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, S]];
  const b = [-(Sxxx + Sxyy), -(Sxxy + Syyy), -(Sxx + Syy)];
  const sol = solve3(A, b);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let se = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(xs[i] - cx, ys[i] - cy) - r;
    se += d * d;
  }
  return { cx, cy, r, rms: Math.sqrt(se / n) };
}

function solve3(A, b) {
  const m = [A[0].concat(b[0]), A[1].concat(b[1]), A[2].concat(b[2])];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-14) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Linear least squares y = a + b x. */
function fitLine(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / den;
  return { a: (sy - b * sx) / n, b };
}

/** Weighted percentile of values (0..1), weights optional. */
function weightedPercentile(values, weights, p) {
  const n = values.length;
  if (n === 0) return null;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => values[i] - values[j]);
  let total = 0;
  for (let i = 0; i < n; i++) total += weights ? weights[i] : 1;
  let acc = 0;
  for (const i of idx) {
    acc += weights ? weights[i] : 1;
    if (acc >= p * total) return values[i];
  }
  return values[idx[n - 1]];
}

module.exports = { v, EPS, roundTo, symEig3, fitCircle2D, fitLine, solve3, weightedPercentile };
