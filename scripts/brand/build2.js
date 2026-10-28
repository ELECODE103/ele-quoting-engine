// Round 2: three gesture-led directions (D, E, F) for STRAIGHTEDGE.
// Geometry is authored here in a cap-height = 100 unit space. Lettering for D and E is
// outlined from OFL fonts; F's wordmark is custom-drawn (straight strokes, 45° chamfers).
const fs = require('fs');
const path = require('path');
const { text } = require('./outline');

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node build2.js <outdir>');
fs.mkdirSync(OUT, { recursive: true });

// ─── Palettes ───────────────────────────────────────────────────────────────
const PALETTES = {
  p1: { name: 'Ink & Brass', ink: '#101C33', accent: '#A8834E', paper: '#F4F1EA', gray: '#6E7480', dark: '#101C33' },
  p2: { name: 'Charcoal & Layout Blue', ink: '#25282D', accent: '#1F418F', paper: '#FFFFFF', gray: '#70757D', dark: '#25282D' },
  p3: { name: 'Machine Green & Bone', ink: '#15171A', accent: '#2F4A3C', paper: '#EDE7D6', gray: '#6B6F6A', dark: '#1E2A24' },
};

const r = (n) => Math.round(n * 100) / 100;
const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)} ${r(y)}`).join('') + 'Z';
const rot = (pts, deg, cx, cy) => { const a = (deg * Math.PI) / 180; return pts.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]); };
const tx = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
const scale = (pts, k) => pts.map(([x, y]) => [x * k, y * k]);
const bbox = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };

function svg(w, h, body, title = 'Straightedge') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}" role="img" aria-labelledby="t">
  <title id="t">${title}</title>
${body}
</svg>
`;
}
function word(font, str, cap, x, y, fill, tracking = 0.02) {
  const probe = text(font, 'H', 100);
  const size = (100 * cap) / probe.capHeight;
  const t = text(font, str, size, tracking);
  return { markup: `  <path transform="translate(${r(x)} ${r(y)})" fill="${fill}" d="${t.d}"/>`, width: t.width };
}
function measure(font, str, cap, tracking = 0.02) {
  const probe = text(font, 'H', 100);
  return text(font, str, (100 * cap) / probe.capHeight, tracking).width;
}
function fit(font, str, cap, W, minTracking = 0.04) {
  const probe = text(font, 'H', 100);
  let c = cap;
  for (;;) {
    const em = (100 * c) / probe.capHeight;
    const tr = (W - measure(font, str, c, 0)) / ((str.length - 1) * em);
    if (tr >= minTracking || c < cap * 0.5) return { cap: c, tracking: tr };
    c -= 1;
  }
}

// ─── Direction D · KNIFE EDGE ───────────────────────────────────────────────
// The straightedge as one stroke: a bar whose top is the true edge (dead horizontal), whose
// heel is cut square and whose far end is ground to a knife point. Sits under the name the
// way a swoosh does — the name rests on the edge.
const D_RAW = [[0, 0], [100, 0], [50, 9], [0, 9]];        // 100 × 9, ground to a point over the last 50
function knife(x, y, w, fill) {
  const k = w / 100;
  return { markup: `  <path fill="${fill}" d="${poly(tx(scale(D_RAW, k), x, y))}"/>`, w, h: 9 * k };
}
function buildD(pal, mode) {
  const fillMark = mode === 'color' ? pal.accent : 'currentColor';
  const fillWord = mode === 'color' ? pal.ink : 'currentColor';
  const fillSub = mode === 'color' ? pal.gray : 'currentColor';
  const FONT = 'oswald-600', SUB = 'archivo-600';
  const CAP = 100, SUBCAP = 26, TR = 0.05;
  const out = {};
  // mark: in color, the stroke on its ground (an ink tile) so it has something to sit on at icon
  // size; in one color, the bare blade — a knocked-out blade would vanish on a stamp.
  if (mode === 'color') {
    const k = knife(6, 45.5, 88, pal.accent);
    out.mark = svg(100, 100, `  <rect width="100" height="100" fill="${pal.ink}"/>\n${k.markup}`, 'Straightedge mark');
  } else {
    out.mark = svg(100, 9, knife(0, 0, 100, 'currentColor').markup, 'Straightedge mark');
  }
  // horizontal: STRAIGHTEDGE over the knife (full word width), shop line right-aligned under it
  {
    const W = measure(FONT, 'STRAIGHTEDGE', CAP, TR);
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, 0, CAP, fillWord, TR);
    const k = knife(0, CAP + 18, W, fillMark);
    const f = fit(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', SUBCAP, W, 0.06);
    const ySub = CAP + 18 + k.h + 26 + f.cap;
    const sub = word(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', f.cap, 0, ySub, fillSub, f.tracking);
    out.horizontal = svg(W, ySub, [w1.markup, k.markup, sub.markup].join('\n'));
    out['horizontal-compact'] = svg(W, CAP + 18 + k.h, [w1.markup, k.markup].join('\n'));
  }
  // stacked: the knife large, name under it (the name rests on nothing; the edge is above, as a sign)
  {
    const KW = 300;
    const k = knife(0, 0, KW, fillMark);
    const w1w = measure(FONT, 'STRAIGHTEDGE', 72, TR);
    const W = Math.max(KW, w1w);
    const y1 = k.h + 30 + 72;
    const w1 = word(FONT, 'STRAIGHTEDGE', 72, (W - w1w) / 2, y1, fillWord, TR);
    const f = fit(SUB, 'MANUFACTURING', 22, w1w, 0.1);
    const ySub = y1 + 24 + f.cap;
    const sub = word(SUB, 'MANUFACTURING', f.cap, (W - w1w) / 2, ySub, fillSub, f.tracking);
    out.stacked = svg(W, ySub, [`  <path fill="${fillMark}" d="${poly(tx(scale(D_RAW, KW / 100), (W - KW) / 2, 0))}"/>`, w1.markup, sub.markup].join('\n'));
  }
  return out;
}

// ─── Direction E · THE KERF ─────────────────────────────────────────────────
// A square of stock parted by one dead-straight cut. Nothing moved: the two halves still
// make a square. Square = square deal; the cut = the work.
function kerfSquare(x, y, s, angle = -22, kerf = 6.5) {
  const cx = 50, cy = 50; const a = (angle * Math.PI) / 180;
  const nx = -Math.sin(a), ny = Math.cos(a);
  function clip(sign) {
    const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const out = [];
    const f = ([px, py]) => sign * ((px - cx) * nx + (py - cy) * ny) - kerf / 2;
    for (let i = 0; i < 4; i++) {
      const A = sq[i], B = sq[(i + 1) % 4], fa = f(A), fb = f(B);
      if (fa >= 0) out.push(A);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
    }
    return out;
  }
  const k = s / 100;
  return poly(tx(scale(clip(-1), k), x, y)) + poly(tx(scale(clip(1), k), x, y));
}
function buildE(pal, mode) {
  const fillMark = mode === 'color' ? pal.accent : 'currentColor';
  const fillWord = mode === 'color' ? pal.ink : 'currentColor';
  const fillSub = mode === 'color' ? pal.gray : 'currentColor';
  const FONT = 'archivo-700', SUB = 'archivo-600';
  const CAP = 100, SUBCAP = 26;
  const out = {};
  const mark = (x, y, s) => `  <path fill="${fillMark}" d="${kerfSquare(x, y, s)}"/>`;
  out.mark = svg(100, 100, mark(0, 0, 100), 'Straightedge mark');
  {
    const G = 150, gap = 40;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, G + gap, CAP + 4, fillWord, 0.06);
    const f = fit(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', SUBCAP, w1.width, 0.06);
    const sub = word(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', f.cap, G + gap, G, fillSub, f.tracking);
    out.horizontal = svg(G + gap + w1.width, G, [mark(0, 0, G), w1.markup, sub.markup].join('\n'));
    const c = word(FONT, 'STRAIGHTEDGE', CAP, 120 + 36, (120 + CAP) / 2, fillWord, 0.06);
    out['horizontal-compact'] = svg(120 + 36 + c.width, 120, [mark(0, 0, 120), c.markup].join('\n'));
  }
  {
    const G = 230, gap = 44;
    const w1w = measure(FONT, 'STRAIGHTEDGE', CAP, -0.005);
    const W = Math.max(w1w, G);
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, (W - w1w) / 2, G + gap + CAP, fillWord, -0.005);
    const f = fit(SUB, 'MANUFACTURING', SUBCAP, w1w, 0.1);
    const ySub = G + gap + CAP + 30 + f.cap;
    const sub = word(SUB, 'MANUFACTURING', f.cap, (W - w1w) / 2, ySub, fillSub, f.tracking);
    out.stacked = svg(W, ySub, [mark((W - G) / 2, 0, G), w1.markup, sub.markup].join('\n'));
  }
  return out;
}

// ─── Direction F · ON THE PLATE ─────────────────────────────────────────────
// The straightedge standing dead square on the surface plate (the GD&T perpendicularity
// sign, to an engineer). The wordmark is custom-drawn: every letter built from straight
// strokes with 45° machined chamfers where a curve would be — the name drawn straight.
function plinth(x, y, s, fill) {
  const pts = [[39, 0], [61, 0], [61, 78], [100, 78], [100, 100], [0, 100], [0, 78], [39, 78]];
  return `  <path fill="${fill}" d="${poly(tx(scale(pts, s / 100), x, y))}"/>`;
}
// Custom alphabet: cap 100, stem 20, letter box 72 (I = 20), chamfer 22 outer / 10.3 inner.
const S_ = 20, C_ = 22, CI = C_ - 0.586 * S_, W_ = 72;
const GLYPHS = {
  S: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 29], [52, 29], [52, 20 + CI], [52 - CI, 20], [20 + CI, 20], [20, 20 + CI], [20, 40], [W_, 40], [W_, 100 - C_], [W_ - C_, 100], [C_, 100], [0, 100 - C_], [0, 71], [20, 71], [20, 80 - CI], [20 + CI, 80], [52 - CI, 80], [52, 80 - CI], [52, 60], [0, 60], [0, C_]]) },
  T: { w: W_, d: poly([[0, 0], [W_, 0], [W_, 20], [46, 20], [46, 100], [26, 100], [26, 20], [0, 20]]) },
  R: { w: W_, d: poly([[0, 0], [W_ - C_, 0], [W_, C_], [W_, 56 - C_], [W_ - C_, 56], [56, 56], [W_, 100], [52, 100], [36, 56], [20, 56], [20, 100], [0, 100]]) + poly([[20, 20], [52 - CI, 20], [52, 20 + CI], [52, 36 - CI], [52 - CI, 36], [20, 36]]) },
  A: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 100], [52, 100], [52, 70], [20, 70], [20, 100], [0, 100], [0, C_]]) + poly([[20 + CI, 20], [52 - CI, 20], [52, 20 + CI], [52, 50], [20, 50], [20, 20 + CI]]) },
  I: { w: 20, d: poly([[0, 0], [20, 0], [20, 100], [0, 100]]) },
  G: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 32], [52, 32], [52, 20 + CI], [52 - CI, 20], [20 + CI, 20], [20, 20 + CI], [20, 80 - CI], [20 + CI, 80], [52 - CI, 80], [52, 80 - CI], [52, 66], [38, 66], [38, 48], [W_, 48], [W_, 100 - C_], [W_ - C_, 100], [C_, 100], [0, 100 - C_], [0, C_]]) },
  H: { w: W_, d: poly([[0, 0], [20, 0], [20, 40], [52, 40], [52, 0], [W_, 0], [W_, 100], [52, 100], [52, 60], [20, 60], [20, 100], [0, 100]]) },
  E: { w: W_ - 6, d: poly([[0, 0], [66, 0], [66, 20], [20, 20], [20, 40], [60, 40], [60, 60], [20, 60], [20, 80], [66, 80], [66, 100], [0, 100]]) },
  D: { w: W_, d: poly([[0, 0], [W_ - C_, 0], [W_, C_], [W_, 100 - C_], [W_ - C_, 100], [0, 100]]) + poly([[20, 20], [52 - CI, 20], [52, 20 + CI], [52, 80 - CI], [52 - CI, 80], [20, 80]]) },
};
function customWord(str, cap, x, y, fill, gap = 14) {
  // y is the baseline; glyphs are drawn top-down from 0..100 so translate by y - cap
  const k = cap / 100;
  let cx = 0; const parts = [];
  for (const ch of str) {
    const g = GLYPHS[ch];
    parts.push(`  <path transform="translate(${r(x + cx * k)} ${r(y - cap)}) scale(${r(k)})" fill="${fill}" fill-rule="evenodd" d="${g.d}"/>`);
    cx += g.w + gap;
  }
  return { markup: parts.join('\n'), width: (cx - gap) * k };
}
function buildF(pal, mode) {
  const fillMark = mode === 'color' ? pal.accent : 'currentColor';
  const fillWord = mode === 'color' ? pal.ink : 'currentColor';
  const fillSub = mode === 'color' ? pal.gray : 'currentColor';
  const SUB = 'archivo-600';
  const CAP = 100, SUBCAP = 26;
  const out = {};
  out.mark = svg(100, 100, plinth(0, 0, 100, fillMark), 'Straightedge mark');
  {
    const G = 150, gap = 40;
    const w1 = customWord('STRAIGHTEDGE', CAP, G + gap, CAP + 4, fillWord);
    const f = fit(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', SUBCAP, w1.width, 0.06);
    const sub = word(SUB, 'MANUFACTURING · WAUCONDA, ILLINOIS', f.cap, G + gap, G, fillSub, f.tracking);
    out.horizontal = svg(G + gap + w1.width, G, [plinth(0, 0, G, fillMark), w1.markup, sub.markup].join('\n'));
    const c = customWord('STRAIGHTEDGE', CAP, 120 + 36, (120 + CAP) / 2, fillWord);
    out['horizontal-compact'] = svg(120 + 36 + c.width, 120, [plinth(0, 0, 120, fillMark), c.markup].join('\n'));
  }
  {
    const G = 230, gap = 44;
    const probe = customWord('STRAIGHTEDGE', CAP, 0, 0, fillWord);
    const W = Math.max(probe.width, G);
    const w1 = customWord('STRAIGHTEDGE', CAP, (W - probe.width) / 2, G + gap + CAP, fillWord);
    const f = fit(SUB, 'MANUFACTURING', SUBCAP, probe.width, 0.1);
    const ySub = G + gap + CAP + 30 + f.cap;
    const sub = word(SUB, 'MANUFACTURING', f.cap, (W - probe.width) / 2, ySub, fillSub, f.tracking);
    out.stacked = svg(W, ySub, [plinth((W - G) / 2, 0, G, fillMark), w1.markup, sub.markup].join('\n'));
  }
  return out;
}

// ─── Write files (recommended palette p1) + palette comparison set ──────────
const dirs = { d: buildD, e: buildE, f: buildF };
const names = { d: 'knife', e: 'kerf', f: 'plate' };
const REC = 'p1';
for (const [k, fn] of Object.entries(dirs)) {
  for (const mode of ['color', 'mono']) {
    const set = fn(PALETTES[REC], mode);
    for (const [variant, markup] of Object.entries(set)) {
      fs.writeFileSync(path.join(OUT, `${k}-${names[k]}-${variant}${mode === 'mono' ? '-1c' : ''}.svg`), markup);
    }
  }
}
// palette comparison (not written as brand files; consumed by the review sheet)
const cmp = {};
for (const [pk, pal] of Object.entries(PALETTES)) {
  cmp[pk] = { palette: pal };
  for (const [k, fn] of Object.entries(dirs)) cmp[pk][k] = fn(pal, 'color');
}
fs.writeFileSync(path.join(OUT, '.palettes.json'), JSON.stringify(cmp));
console.log('round 2 built');
