// Builds the STRAIGHTEDGE logo system into client/public/brand/.
// Geometry is authored here by hand in a "cap height = 100" unit space; letterforms
// are Barlow outlines (OFL) converted to paths so the SVGs render with no font installed.
const fs = require('fs');
const path = require('path');
const { text } = require('./outline');

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node build.js <outdir>');
fs.mkdirSync(OUT, { recursive: true });

// ─── Palette ────────────────────────────────────────────────────────────────
const INK = '#0F172A';      // Ink (near-black, matches site text)
const BLUE = '#1F418F';     // Layout Blue (Dykem layout-fluid blue)
const GRAY = '#6B7280';     // Surface-plate gray (secondary text)
const WHITE = '#FFFFFF';

const r = (n) => Math.round(n * 100) / 100;

function svg(w, h, body, title = 'Straightedge') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}" role="img" aria-labelledby="t">
  <title id="t">${title}</title>
${body}
</svg>
`;
}

// Place outlined text with its baseline at (x, y). Returns {markup, width}.
function word(font, str, cap, x, y, fill, tracking = 0.02) {
  const probe = text(font, 'H', 100);
  const size = (100 * cap) / probe.capHeight; // em size that yields the requested cap height
  const t = text(font, str, size, tracking);
  return {
    markup: `  <path transform="translate(${r(x)} ${r(y)})" fill="${fill}" d="${t.d}"/>`,
    width: t.width,
  };
}
function measure(font, str, cap, tracking = 0.02) {
  const probe = text(font, 'H', 100);
  const size = (100 * cap) / probe.capHeight;
  return text(font, str, size, tracking).width;
}

// Tracking that makes `str` exactly `W` wide at cap height `cap` (justified line).
// If the string is too wide even at zero tracking, cap is reduced instead.
function fit(font, str, cap, W, minTracking = 0.04) {
  const probe = text(font, 'H', 100);
  let c = cap;
  for (;;) {
    const em = (100 * c) / probe.capHeight;
    const base = measure(font, str, c, 0);
    const tr = (W - base) / ((str.length - 1) * em);
    if (tr >= minTracking || c < cap * 0.5) return { cap: c, tracking: tr };
    c -= 1;
  }
}

// ─── Direction A · DEAD SQUARE ──────────────────────────────────────────────
// A capital S drawn with nothing but straight strokes, set in a dead-square field.
// Straight strokes = "straight"; dead square = "deals square".
// Single polygon (no overlaps) so it can be knocked out of the square with even-odd fill.
function squareS(x, y, s) {
  const k = s / 100;
  const pts = [
    [18, 16], [82, 16], [82, 36], [68, 36], [68, 30], [32, 30], [32, 43], [82, 43],
    [82, 84], [18, 84], [18, 64], [32, 64], [32, 70], [68, 70], [68, 57], [18, 57],
  ];
  return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${r(x + px * k)} ${r(y + py * k)}`).join('') + 'Z';
}
// Square with S knocked out, as ONE path (even-odd). Embroiders as a solid square.
function markA(x, y, s, fill) {
  return `  <path fill="${fill}" fill-rule="evenodd" d="M${r(x)} ${r(y)}H${r(x + s)}V${r(y + s)}H${r(x)}Z${squareS(x, y, s)}"/>`;
}

function buildA(mode) {
  // mode: 'color' | 'mono'
  const fillMark = mode === 'color' ? BLUE : 'currentColor';
  const fillWord = mode === 'color' ? INK : 'currentColor';
  const fillSub = mode === 'color' ? GRAY : 'currentColor';
  const FONT = 'barlow-700', SUB = 'barlow-600';
  const CAP = 100, SUBCAP = 30;
  const out = {};

  // glyph only
  out.mark = svg(100, 100, markA(0, 0, 100, fillMark), 'Straightedge mark');

  // horizontal: square (150) · gap · STRAIGHTEDGE over MANUFACTURING
  {
    const G = 150, gap = 44;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, G + gap, CAP, fillWord, 0.02);
    const sub = word(SUB, 'MANUFACTURING', SUBCAP, G + gap + 2, G, fillSub, 0.26);
    const W = G + gap + Math.max(w1.width, sub.width);
    out.horizontal = svg(W, G, [markA(0, 0, G, fillMark), w1.markup, sub.markup].join('\n'));
  }
  // compact horizontal: square (120) · STRAIGHTEDGE, no descriptor — for anything under 40 mm
  {
    const G = 120, gap = 36;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, G + gap, (G + CAP) / 2, fillWord, 0.02);
    out['horizontal-compact'] = svg(G + gap + w1.width, G, [markA(0, 0, G, fillMark), w1.markup].join('\n'));
  }
  // stacked: square (220) over STRAIGHTEDGE over MANUFACTURING, centered
  {
    const G = 220, gap = 48, subgap = 28;
    const w1w = measure(FONT, 'STRAIGHTEDGE', CAP, 0.02);
    const subw = measure(SUB, 'MANUFACTURING', SUBCAP, 0.26);
    const W = Math.max(w1w, G);
    const H = G + gap + CAP + subgap + SUBCAP;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, (W - w1w) / 2, G + gap + CAP, fillWord, 0.02);
    const sub = word(SUB, 'MANUFACTURING', SUBCAP, (W - subw) / 2, H, fillSub, 0.26);
    out.stacked = svg(W, H, [markA((W - G) / 2, 0, G, fillMark), w1.markup, sub.markup].join('\n'));
  }
  return out;
}

// ─── Direction B · RULED ─────────────────────────────────────────────────────
// Type-led. The name sits between a hairline and a heavy rule: every letter checked
// against the same straightedge. Stacked version is a sign-painter's justified block.
function buildB(mode) {
  const fillRule = mode === 'color' ? BLUE : 'currentColor';
  const fillWord = mode === 'color' ? INK : 'currentColor';
  const fillSub = mode === 'color' ? GRAY : 'currentColor';
  const FONT = 'barlowsc-700', SUB = 'barlow-600';
  const CAP = 100, SUBCAP = 28, HAIR = 5, HEAVY = 16;
  const out = {};

  // horizontal (the wordmark itself): hairline / STRAIGHTEDGE / heavy rule / descriptor
  {
    const w1w = measure(FONT, 'STRAIGHTEDGE', CAP, 0.04);
    const W = w1w;
    const yHair = 0, yCapTop = HAIR + 22, yBase = yCapTop + CAP, yHeavy = yBase + 22;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, 0, yBase, fillWord, 0.04);
    const subStr = 'MANUFACTURING · WAUCONDA, ILLINOIS';
    const f = fit(SUB, subStr, SUBCAP, W, 0.08);
    const ySub = yHeavy + HEAVY + 26 + f.cap;
    const sub = word(SUB, subStr, f.cap, 0, ySub, fillSub, f.tracking);
    const body = [
      `  <rect x="0" y="${yHair}" width="${r(W)}" height="${HAIR}" fill="${fillRule}"/>`,
      w1.markup,
      `  <rect x="0" y="${yHeavy}" width="${r(W)}" height="${HEAVY}" fill="${fillRule}"/>`,
      sub.markup,
    ].join('\n');
    out.horizontal = svg(W, ySub, body);
  }
  // compact horizontal: hairline / STRAIGHTEDGE / heavy rule
  {
    const W = measure(FONT, 'STRAIGHTEDGE', CAP, 0.04);
    const yBase = HAIR + 22 + CAP, yHeavy = yBase + 22;
    const w1 = word(FONT, 'STRAIGHTEDGE', CAP, 0, yBase, fillWord, 0.04);
    out['horizontal-compact'] = svg(W, yHeavy + HEAVY, [
      `  <rect x="0" y="0" width="${r(W)}" height="${HAIR}" fill="${fillRule}"/>`,
      w1.markup,
      `  <rect x="0" y="${yHeavy}" width="${r(W)}" height="${HEAVY}" fill="${fillRule}"/>`,
    ].join('\n'));
  }
  // stacked: STRAIGHT (tracked to width) over EDGE (large), rules top and bottom
  {
    const BIG = 190;
    const edgeW = measure(FONT, 'EDGE', BIG, 0.04);
    const W = edgeW;
    // fit STRAIGHT to the same width by solving tracking
    const fs1 = fit(FONT, 'STRAIGHT', CAP, W, 0.06);
    const yHair = 0, y1 = HAIR + 26 + fs1.cap, y2 = y1 + 30 + BIG, yHeavy = y2 + 24;
    const s1 = word(FONT, 'STRAIGHT', fs1.cap, 0, y1, fillWord, fs1.tracking);
    const s2 = word(FONT, 'EDGE', BIG, 0, y2, fillWord, 0.04);
    const subStr = 'MANUFACTURING';
    const f = fit(SUB, subStr, SUBCAP, W, 0.1);
    const ySub = yHeavy + HEAVY + 26 + f.cap;
    const sub = word(SUB, subStr, f.cap, 0, ySub, fillSub, f.tracking);
    const body = [
      `  <rect x="0" y="${yHair}" width="${r(W)}" height="${HAIR}" fill="${fillRule}"/>`,
      s1.markup, s2.markup,
      `  <rect x="0" y="${yHeavy}" width="${r(W)}" height="${HEAVY}" fill="${fillRule}"/>`,
      sub.markup,
    ].join('\n');
    out.stacked = svg(W, ySub, body);
  }
  // mark: S E between the two rules, squared up
  {
    const seW = measure(FONT, 'SE', 130, 0.06);
    const W = seW + 16, HAIRm = 7, HEAVYm = 22;
    const yBase = HAIRm + 24 + 130, yHeavy = yBase + 20;
    const H = yHeavy + HEAVYm;
    const se = word(FONT, 'SE', 130, 8, yBase, fillWord, 0.06);
    const body = [
      `  <rect x="0" y="0" width="${r(W)}" height="${HAIRm}" fill="${fillRule}"/>`,
      se.markup,
      `  <rect x="0" y="${yHeavy}" width="${r(W)}" height="${HEAVYm}" fill="${fillRule}"/>`,
    ].join('\n');
    out.mark = svg(W, H, body, 'Straightedge mark');
  }
  return out;
}

// ─── Direction C · THE BAR ───────────────────────────────────────────────────
// The two words are separated by the straightedge itself, standing on end: a ground
// bar that stands a little proud of the letters. The glyph is S | E.
function buildC(mode) {
  const fillBar = mode === 'color' ? BLUE : 'currentColor';
  const fillWord = mode === 'color' ? INK : 'currentColor';
  const fillSub = mode === 'color' ? GRAY : 'currentColor';
  const FONT = 'barlowc-700', SUB = 'barlow-600';
  const CAP = 100, SUBCAP = 28, BAR = 22, OVER = 14; // bar overshoots cap top & baseline by OVER
  const out = {};

  function bar(x, yTop, h, fill) {
    return `  <rect x="${r(x)}" y="${r(yTop)}" width="${BAR}" height="${r(h)}" fill="${fill}"/>`;
  }
  // horizontal: STRAIGHT ▌ EDGE  with descriptor under
  {
    const gap = 30;
    const w1w = measure(FONT, 'STRAIGHT', CAP, 0.03);
    const w2w = measure(FONT, 'EDGE', CAP, 0.03);
    const yBase = OVER + CAP;
    const xBar = w1w + gap;
    const w1 = word(FONT, 'STRAIGHT', CAP, 0, yBase, fillWord, 0.03);
    const w2 = word(FONT, 'EDGE', CAP, xBar + BAR + gap, yBase, fillWord, 0.03);
    const W = xBar + BAR + gap + w2w;
    const subStr = 'MANUFACTURING · WAUCONDA, ILLINOIS';
    const f = fit(SUB, subStr, SUBCAP, W, 0.08);
    const ySub = yBase + OVER + 30 + f.cap;
    const sub = word(SUB, subStr, f.cap, 0, ySub, fillSub, f.tracking);
    out.horizontal = svg(W, ySub, [w1.markup, bar(xBar, 0, CAP + 2 * OVER, fillBar), w2.markup, sub.markup].join('\n'));
  }
  // compact horizontal: STRAIGHT ▌ EDGE
  {
    const gap = 30;
    const w1w = measure(FONT, 'STRAIGHT', CAP, 0.03);
    const w2w = measure(FONT, 'EDGE', CAP, 0.03);
    const yBase = OVER + CAP, xBar = w1w + gap;
    const w1 = word(FONT, 'STRAIGHT', CAP, 0, yBase, fillWord, 0.03);
    const w2 = word(FONT, 'EDGE', CAP, xBar + BAR + gap, yBase, fillWord, 0.03);
    out['horizontal-compact'] = svg(xBar + BAR + gap + w2w, CAP + 2 * OVER, [w1.markup, bar(xBar, 0, CAP + 2 * OVER, fillBar), w2.markup].join('\n'));
  }
  // stacked: STRAIGHT over a horizontal bar over EDGE, justified
  {
    const W = measure(FONT, 'STRAIGHT', CAP, 0.06);
    const BIG = (W / measure(FONT, 'EDGE', 100, 0.06)) * 100; // EDGE scaled to the same width
    const y1 = CAP, yBar = y1 + 28, y2 = yBar + BAR + 28 + BIG;
    const s1 = word(FONT, 'STRAIGHT', CAP, OVER, y1, fillWord, 0.06);
    const s2 = word(FONT, 'EDGE', BIG, OVER, y2, fillWord, 0.06);
    const subStr = 'MANUFACTURING';
    const f = fit(SUB, subStr, SUBCAP, W, 0.1);
    const ySub = y2 + 34 + f.cap;
    const sub = word(SUB, subStr, f.cap, OVER, ySub, fillSub, f.tracking);
    const body = [
      s1.markup,
      `  <rect x="0" y="${yBar}" width="${r(W + 2 * OVER)}" height="${BAR}" fill="${fillBar}"/>`,
      s2.markup, sub.markup,
    ].join('\n');
    out.stacked = svg(W + 2 * OVER, ySub, body);
  }
  // mark: S ▌ E
  {
    const BIGC = 130, gapm = 22, BARm = 28, OVERm = 18;
    const sW = measure(FONT, 'S', BIGC, 0);
    const eW = measure(FONT, 'E', BIGC, 0);
    const yBase = OVERm + BIGC;
    const xBar = sW + gapm;
    const W = xBar + BARm + gapm + eW;
    const s = word(FONT, 'S', BIGC, 0, yBase, fillWord, 0);
    const e = word(FONT, 'E', BIGC, xBar + BARm + gapm, yBase, fillWord, 0);
    const body = [s.markup, `  <rect x="${r(xBar)}" y="0" width="${BARm}" height="${r(BIGC + 2 * OVERm)}" fill="${fillBar}"/>`, e.markup].join('\n');
    out.mark = svg(W, BIGC + 2 * OVERm, body, 'Straightedge mark');
  }
  return out;
}

// ─── Favicon (direction A) ───────────────────────────────────────────────────
// Same construction, counters opened a touch so the S stays clear at 16 px.
function faviconSvg() {
  const pts = [
    [16, 13], [84, 13], [84, 34], [69, 34], [69, 28], [31, 28], [31, 42.5], [84, 42.5],
    [84, 87], [16, 87], [16, 66], [31, 66], [31, 72], [69, 72], [69, 57.5], [16, 57.5],
  ];
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x * 0.32)} ${r(y * 0.32)}`).join('') + 'Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="${BLUE}" fill-rule="evenodd" d="M0 0H32V32H0Z${d}"/></svg>\n`;
}
fs.writeFileSync(path.join(OUT, 'favicon.svg'), faviconSvg());

// ─── Write files ─────────────────────────────────────────────────────────────
const dirs = { a: buildA, b: buildB, c: buildC };
const names = { a: 'dead-square', b: 'ruled', c: 'bar' };
const files = {};
for (const [k, fn] of Object.entries(dirs)) {
  for (const mode of ['color', 'mono']) {
    const set = fn(mode);
    for (const [variant, markup] of Object.entries(set)) {
      const suffix = mode === 'mono' ? '-1c' : '';
      const name = `${k}-${names[k]}-${variant}${suffix}.svg`;
      fs.writeFileSync(path.join(OUT, name), markup);
      files[name] = markup;
    }
  }
}
fs.writeFileSync(path.join(OUT, '.manifest.json'), JSON.stringify(Object.keys(files), null, 2));
console.log(Object.keys(files).join('\n'));
