// Shared helpers for the launch brand kit (kit.js, post.js): the decided mark (E3 · The Kerf,
// light under the edge), the Ink & Brass palette, outlined lettering, and Playwright rendering.
// Nothing here touches the network: lettering is outlined with opentype.js from the OFL fonts in
// node_modules/@fontsource, and HTML sheets embed the same fonts as base64.
const fs = require('fs');
const path = require('path');
const { text, FONTS } = require('./outline');
const G = require('./geom3');
const { r, poly } = G;

const INK = '#101C33', BRASS = '#A8834E', BONE = '#F4F1EA';
const MUTED = '#B9B3A6';   // secondary type on ink
const GRAY = '#6E7480';    // secondary type on bone / white
const GHOST = '#17264A';   // the mark as a tone-on-tone watermark on ink

// ─── The mark ───────────────────────────────────────────────────────────────
const E_CUT = { angle: 20, kerf: 6.5 };
const stepped = G.kerfLight(100, { ...E_CUT, steps: 6 });
const solidP = G.kerfPieces(100, E_CUT);
const MARK = {
  stepped: { polys: [stepped.upper, stepped.lower], d: poly(stepped.upper) + poly(stepped.lower) },
  solid: { polys: [solidP.upper, solidP.lower], d: poly(solidP.upper) + poly(solidP.lower) },
};
// Rule from RATIONALE.md: the stair needs 32 px / 8.5 mm; below that use the solid kerf square.
const kindFor = (px) => (px >= 32 ? 'stepped' : 'solid');
function mark(x, y, S, fill, kind) {
  const k = kind || kindFor(S);
  return `<path fill="${fill}" transform="translate(${r(x)} ${r(y)}) scale(${r(S / 100, 4)})" d="${MARK[k].d}"/>`;
}

// ─── Lettering (outlined) ───────────────────────────────────────────────────
const capEm = (font, cap) => (100 * cap) / text(font, 'H', 100).capHeight;
/** Outlined text. opts: x, y (baseline), fill, tracking (em), anchor start|middle|end, maxWidth (shrinks to fit). */
function txt(font, str, size, opts = {}) {
  const { x = 0, y = 0, fill = INK, tracking = 0, anchor = 'start', maxWidth, opacity } = opts;
  let t = text(font, str, size, tracking), s = size;
  if (maxWidth && t.width > maxWidth) { s = (size * maxWidth) / t.width; t = text(font, str, s, tracking); }
  const ox = anchor === 'end' ? x - t.width : anchor === 'middle' ? x - t.width / 2 : x;
  const op = opacity != null ? ` opacity="${opacity}"` : '';
  return { markup: `<path fill="${fill}"${op} transform="translate(${r(ox)} ${r(y)})" d="${t.d}"/>`, width: t.width, size: s, x: ox };
}
const WORD_FONT = 'archivo-700', WORD_TR = 0.03;
const wordWidth = (cap) => text(WORD_FONT, 'STRAIGHTEDGE', capEm(WORD_FONT, cap), WORD_TR).width;
function wordmark(x, baseline, cap, fill, anchor) {
  return txt(WORD_FONT, 'STRAIGHTEDGE', capEm(WORD_FONT, cap), { x, y: baseline, fill, tracking: WORD_TR, anchor });
}
// Compact lockup, the grammar from build3.js: square S, gap 32/118 S, cap S/1.18, name centred on the square.
function lockup(x, y, S, { markFill = BRASS, wordFill = INK, kind } = {}) {
  const cap = S / 1.18, gap = (S * 32) / 118;
  const w = wordmark(x + S + gap, y + (S + cap) / 2, cap, wordFill);
  return { markup: mark(x, y, S, markFill, kind) + '\n' + w.markup, width: S + gap + w.width, height: S };
}
const lockupWidth = (S) => S + (S * 32) / 118 + wordWidth(S / 1.18);
// Stacked lockup: mark 2.6 × cap over the name, MANUFACTURING justified beneath.
function stacked(cx, y, cap, { markFill = BRASS, wordFill = INK, subFill = GRAY } = {}) {
  const S = cap * 2.6, gap = cap * 0.44, W = wordWidth(cap);
  const w = wordmark(cx - W / 2, y + S + gap + cap, cap, wordFill);
  const subCap = cap * 0.2, em = capEm('archivo-600', subCap);
  const raw = text('archivo-600', 'MANUFACTURING', em, 0).width;
  const tr = (W - raw) / (12 * em);
  const sub = txt('archivo-600', 'MANUFACTURING', em, { x: cx - W / 2, y: y + S + gap + cap + cap * 0.28 + subCap, fill: subFill, tracking: tr });
  return { markup: [mark(cx - S / 2, y, S, markFill), w.markup, sub.markup].join('\n'), width: W, height: S + gap + cap + cap * 0.28 + subCap };
}

// The light under the edge, alone: the gap between the true edge and the printed stair of a
// (virtual) kerf square of side S centred on (cx, cy). Used tone-on-tone as the one graphic
// device on ink panels — it bleeds off the panel, so only the band is ever seen.
function lightBand(cx, cy, S, fill = GHOST, steps = 6) {
  const p = G.kerfPieces(100, E_CUT);
  const xs = Array.from({ length: steps + 1 }, (_, i) => (100 * i) / steps);
  const pts = [[0, p.yUp(0)], [100, p.yUp(100)]];
  for (let i = steps - 1; i >= 0; i--) pts.push([xs[i + 1], p.yLow(xs[i])], [xs[i], p.yLow(xs[i])]);
  return `<path fill="${fill}" transform="translate(${r(cx - S / 2)} ${r(cy - S / 2)}) scale(${r(S / 100, 4)})" d="${poly(pts)}"/>`;
}

function svgDoc(w, h, body, title = 'Straightedge', extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t"${extra}>
<title id="t">${title}</title>
${body}
</svg>
`;
}

// ─── Fonts for HTML sheets (embedded, no network) ───────────────────────────
function fontFaceCss() {
  const faces = [['Inter', 400, 'inter-400'], ['Inter', 500, 'inter-500'], ['Inter', 600, 'inter-600'], ['Inter', 700, 'inter-700'], ['Archivo', 600, 'archivo-600'], ['Archivo', 700, 'archivo-700']];
  return faces.map(([fam, wt, key]) => {
    const file = require.resolve(FONTS[key].replace(/\.woff$/, '.woff2'));
    return `@font-face{font-family:"${fam}";font-weight:${wt};font-style:normal;src:url(data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}) format("woff2");}`;
  }).join('\n');
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function loadPlaywright() {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(p); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found (npm i -D playwright, or run where it is installed globally)');
}
async function withBrowser(fn) {
  const browser = await loadPlaywright().chromium.launch();
  try { return await fn(browser); } finally { await browser.close(); }
}
/** Render an SVG string (or full HTML when job.html) to a PNG of exactly w × h CSS px × scale. */
async function renderPng(browser, { svg, html, w, h, out, transparent = false, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width: Math.ceil(w), height: Math.ceil(h) }, deviceScaleFactor: scale });
  await page.setContent(html || `<!doctype html><html><body style="margin:0;background:${transparent ? 'transparent' : '#fff'}">${svg.replace('<svg ', '<svg style="display:block" ')}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf); }
  return buf;
}
// A Windows .ico that wraps PNG images (supported since Vista, by every current browser).
function ico(pngs) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = [], off0 = 6 + 16 * pngs.length; let off = off0;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(off, 12); off += buf.length; dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.buf)]);
}

module.exports = { INK, BRASS, BONE, MUTED, GRAY, GHOST, MARK, E_CUT, kindFor, mark, lightBand, txt, capEm, wordmark, wordWidth, lockup, lockupWidth, stacked, svgDoc, fontFaceCss, withBrowser, renderPng, ico, r, poly };
