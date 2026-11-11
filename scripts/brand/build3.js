// Round 3: refine the two directions the owner picked (D · Knife Edge, E · The Kerf) into
// four candidates, each carrying a nod to machining and to additive in one shape.
//   d2-knife  · the name (Oswald) rests on the blade; printed-layer heel, ground point
//   d3-cut    · the same blade under the custom straight-stroke name whose curves are 45° chamfers
//   e2-layers · the kerf square: printed layers below the cut, solid machined stock above
//   e3-light  · the kerf square: the straightedge above, a printed stair below, light between
// Lettering is outlined from OFL fonts (Oswald 600 for D2, Archivo 700 for E, Archivo 600 for
// the shop line); D3's name is drawn in glyphs.js. Run: node build3.js ../../client/public/brand
const fs = require('fs');
const path = require('path');
const { text } = require('./outline');
const G = require('./geom3');
const { customWord, customWidth } = require('./glyphs');
const { r, poly, tx } = G;

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node build3.js <outdir>');
fs.mkdirSync(OUT, { recursive: true });

const PALETTES = {
  p1: { name: 'Ink & Brass', ink: '#101C33', accent: '#A8834E', paper: '#F4F1EA', gray: '#6E7480', dark: '#101C33' },
  p2: { name: 'Charcoal & Layout Blue', ink: '#25282D', accent: '#1F418F', paper: '#FFFFFF', gray: '#70757D', dark: '#25282D' },
};

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
// shrink the cap until the string can be justified to W with at least minTracking
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
const fills = (pal, mode) => ({
  mark: mode === 'color' ? pal.accent : 'currentColor',
  word: mode === 'color' ? pal.ink : 'currentColor',
  sub: mode === 'color' ? pal.gray : 'currentColor',
});
const SHOP = 'MANUFACTURING · WAUCONDA, ILLINOIS';
const SUB = 'archivo-600';

// ─── The blade (D2 and D3 share it) ─────────────────────────────────────────
// Profile rule: taper over the last 52 % of the length to a point with a flat of 7 % T; the
// heel's lower corner broken by a 45° chamfer half the thickness, built from three printed
// layers. Under a name the thickness is 0.56 × cap; alone it is 14 % of the length.
const BLADE = { taperFrom: 0.48, steps: 3, chamfer: 0.5, tip: 0.07 };
const T_CAP = 0.56, REST = 12, ALONE = 0.14;
function bladeAt(x, y, L, T, fill) {
  return { markup: `  <path fill="${fill}" d="${poly(tx(G.blade(L, T, BLADE), x, y))}"/>`, h: T };
}
function bladeMarks(pal, mode, out) {
  const F = fills(pal, mode);
  out.mark = svg(100, 100 * ALONE, bladeAt(0, 0, 100, 100 * ALONE, F.mark).markup, 'Straightedge mark');
  // on its plate, for favicons and app icons: the blade sits a little below centre, where the
  // name's baseline would be. In one colour the blade is a hole in the plate.
  const L = 82, T = L * ALONE, bx = 9, by = (100 - T) / 2 + 6;
  if (mode === 'color') {
    out['mark-plate'] = svg(100, 100, `  <rect width="100" height="100" fill="${pal.ink}"/>\n${bladeAt(bx, by, L, T, pal.accent).markup}`, 'Straightedge mark');
  } else {
    out['mark-plate'] = svg(100, 100, `  <path fill="currentColor" fill-rule="evenodd" d="M0 0H100V100H0Z${poly(tx(G.blade(L, T, BLADE), bx, by))}"/>`, 'Straightedge mark');
  }
}
// One lockup grammar for both D candidates; `name` draws the wordmark and returns its width.
function buildDLockups(name, pal, mode) {
  const F = fills(pal, mode);
  const CAP = 100, T = CAP * T_CAP;
  const out = {};
  bladeMarks(pal, mode, out);
  {
    const w1 = name('STRAIGHTEDGE', CAP, 0, CAP, F.word);
    const b = bladeAt(0, CAP + REST, w1.width, T, F.mark);
    const f = fit(SUB, SHOP, 26, w1.width, 0.06);
    const ySub = CAP + REST + T + 26 + f.cap;
    const sub = word(SUB, SHOP, f.cap, 0, ySub, F.sub, f.tracking);
    out.horizontal = svg(w1.width, ySub, [w1.markup, b.markup, sub.markup].join('\n'));
    out['horizontal-compact'] = svg(w1.width, CAP + REST + T, [w1.markup, b.markup].join('\n'));
  }
  {
    // stacked: STRAIGHT over EDGE, both resting on one blade as wide as STRAIGHT
    const LEAD = 20;
    const l1 = name('STRAIGHT', CAP, 0, CAP, F.word);
    const l2 = name('EDGE', CAP, 0, CAP * 2 + LEAD, F.word);
    const yB = CAP * 2 + LEAD + REST;
    const b = bladeAt(0, yB, l1.width, T, F.mark);
    const f = fit(SUB, 'MANUFACTURING', 26, l1.width, 0.04);
    const ySub = yB + T + 24 + f.cap;
    const sub = word(SUB, 'MANUFACTURING', f.cap, 0, ySub, F.sub, f.tracking);
    out.stacked = svg(l1.width, ySub, [l1.markup, l2.markup, b.markup, sub.markup].join('\n'));
  }
  return out;
}
// D2 · Knife Edge — Oswald SemiBold, +6 % tracking
const buildD2 = (pal, mode) => buildDLockups((s, cap, x, y, fill) => word('oswald-600', s, cap, x, y, fill, 0.06), pal, mode);
// D3 · The Cut — the custom straight-stroke alphabet (every curve a 45° machined chamfer)
const buildD3 = (pal, mode) => buildDLockups((s, cap, x, y, fill) => customWord(s, cap, x, y, fill), pal, mode);

// ─── E · THE KERF, two ways ─────────────────────────────────────────────────
const E_CUT = { angle: 20, kerf: 6.5 };
const E2_OPT = { ...E_CUT, layer: 5, gap: 1.6 };
const E3_OPT = { ...E_CUT, steps: 6 };
function kerfMark(kind, x, y, S, fill) {
  const k = S / 100;
  let d;
  if (kind === 'solid') { const p = G.kerfPieces(100, E_CUT); d = poly(p.upper) + poly(p.lower); }
  else if (kind === 'layers') { const p = G.kerfLayers(100, E2_OPT); d = poly(p.upper) + p.strips.map(poly).join(''); }
  else { const p = G.kerfLight(100, E3_OPT); d = poly(p.upper) + poly(p.lower); }
  return `  <path fill="${fill}" transform="translate(${r(x)} ${r(y)}) scale(${r(k)})" d="${d}"/>`;
}
// Both E candidates share one lockup grammar: mark left, Archivo Bold +3 %, shop line justified.
// The textured square is used in the mark file and the two large lockups; the compact lockup
// and the `-mark-small` file use the solid square (the texture needs size to resolve — see the
// rules in RATIONALE.md).
function buildE(kind, pal, mode) {
  const F = fills(pal, mode);
  const FONT = 'archivo-700';
  const CAP = 100, TR = 0.03;
  const out = {};
  out.mark = svg(100, 100, kerfMark(kind, 0, 0, 100, F.mark), 'Straightedge mark');
  out['mark-small'] = svg(100, 100, kerfMark('solid', 0, 0, 100, F.mark), 'Straightedge mark');
  {
    const S = 150, GAP = 38;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, S + GAP, CAP + 3, F.word, TR);
    const f = fit(SUB, SHOP, 26, w1.width, 0.06);
    const sub = word(SUB, SHOP, f.cap, S + GAP, S, F.sub, f.tracking);
    out.horizontal = svg(S + GAP + w1.width, S, [kerfMark(kind, 0, 0, S, F.mark), w1.markup, sub.markup].join('\n'));
    const Sc = 118, GAPc = 32;
    const c = word(FONT, 'STRAIGHTEDGE', CAP, Sc + GAPc, (Sc + CAP) / 2, F.word, TR);
    out['horizontal-compact'] = svg(Sc + GAPc + c.width, Sc, [kerfMark('solid', 0, 0, Sc, F.mark), c.markup].join('\n'));
  }
  {
    const S = 260, GAP = 44;
    const w1w = measure(FONT, 'STRAIGHTEDGE', CAP, TR);
    const W = Math.max(w1w, S);
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, (W - w1w) / 2, S + GAP + CAP, F.word, TR);
    const f = fit(SUB, 'MANUFACTURING', 26, w1w, 0.1);
    const ySub = S + GAP + CAP + 28 + f.cap;
    const sub = word(SUB, 'MANUFACTURING', f.cap, (W - w1w) / 2, ySub, F.sub, f.tracking);
    out.stacked = svg(W, ySub, [kerfMark(kind, (W - S) / 2, 0, S, F.mark), w1.markup, sub.markup].join('\n'));
  }
  return out;
}

// ─── Write files (recommended palette p1) + palette comparison set ──────────
const dirs = {
  'd2-knife': buildD2,
  'd3-cut': buildD3,
  'e2-layers': (pal, mode) => buildE('layers', pal, mode),
  'e3-light': (pal, mode) => buildE('light', pal, mode),
};
const REC = 'p1';
for (const [k, fn] of Object.entries(dirs)) {
  for (const mode of ['color', 'mono']) {
    const set = fn(PALETTES[REC], mode);
    for (const [variant, markup] of Object.entries(set)) {
      fs.writeFileSync(path.join(OUT, `${k}-${variant}${mode === 'mono' ? '-1c' : ''}.svg`), markup);
    }
  }
}
const cmp = {};
for (const [pk, pal] of Object.entries(PALETTES)) {
  cmp[pk] = { palette: pal };
  for (const [k, fn] of Object.entries(dirs)) cmp[pk][k] = fn(pal, 'color');
}
fs.writeFileSync(path.join(OUT, '.palettes3.json'), JSON.stringify(cmp));
console.log('round 3 built');
