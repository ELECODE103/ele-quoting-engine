// Outline text to an SVG path with opentype.js. Returns path data in user units
// where the baseline is y=0 and `size` is the em size.
const opentype = require('opentype.js');
const path = require('path');
const fs = require('fs');

const FONTS = {
  'barlow-700': '@fontsource/barlow/files/barlow-latin-700-normal.woff',
  'barlow-600': '@fontsource/barlow/files/barlow-latin-600-normal.woff',
  'barlowsc-700': '@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-700-normal.woff',
  'barlowc-700': '@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff',
  'archivo-700': '@fontsource/archivo/files/archivo-latin-700-normal.woff',
  'archivo-600': '@fontsource/archivo/files/archivo-latin-600-normal.woff',
  'oswald-600': '@fontsource/oswald/files/oswald-latin-600-normal.woff',
  'oswald-700': '@fontsource/oswald/files/oswald-latin-700-normal.woff',
};

const cache = {};
function load(key) {
  if (cache[key]) return cache[key];
  const file = require.resolve(FONTS[key]);
  const buf = fs.readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  cache[key] = font;
  return font;
}

function round(n, p = 2) { return Math.round(n * 10 ** p) / 10 ** p; }

/**
 * @returns {{d:string, width:number, capHeight:number, xHeight:number, ascender:number, descender:number}}
 * Path is positioned with x=0 at the left side bearing of the first glyph (trimmed), baseline y=0, y grows downward.
 */
function text(key, str, size, tracking = 0, opts = {}) {
  const font = load(key);
  const scale = size / font.unitsPerEm;
  const glyphs = Array.from(str).map((ch) => font.charToGlyph(ch));
  let x = 0;
  const cmds = [];
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const p = g.getPath(x, 0, size);
    for (const c of p.commands) cmds.push(c);
    const bb = g.getBoundingBox();
    if (bb.x1 !== bb.x2) {
      minX = Math.min(minX, x + bb.x1 * scale);
      maxX = Math.max(maxX, x + bb.x2 * scale);
    }
    let adv = g.advanceWidth * scale;
    if (i < glyphs.length - 1 && opts.kerning !== false) adv += font.getKerningValue(g, glyphs[i + 1]) * scale;
    x += adv + tracking * size;
  }
  const shift = -minX;
  const parts = [];
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') parts.push(`${c.type}${round(c.x + shift)} ${round(c.y)}`);
    else if (c.type === 'Q') parts.push(`Q${round(c.x1 + shift)} ${round(c.y1)} ${round(c.x + shift)} ${round(c.y)}`);
    else if (c.type === 'C') parts.push(`C${round(c.x1 + shift)} ${round(c.y1)} ${round(c.x2 + shift)} ${round(c.y2)} ${round(c.x + shift)} ${round(c.y)}`);
    else if (c.type === 'Z') parts.push('Z');
  }
  const os2 = font.tables.os2 || {};
  return {
    d: parts.join(''),
    width: round(maxX - minX),
    capHeight: round((os2.sCapHeight || font.ascender * 0.7) * scale),
    xHeight: round((os2.sxHeight || 0) * scale),
    ascender: round(font.ascender * scale),
    descender: round(font.descender * scale),
  };
}

module.exports = { text, FONTS };
