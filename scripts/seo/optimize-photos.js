#!/usr/bin/env node
/**
 * One-off / on-demand: makes WebP derivatives of client/public/photos/*.jpg at
 * 640 and 1200 px wide and writes client/src/data/photos.generated.json with
 * intrinsic sizes (used by <Photo> for width/height and srcset).
 *
 * Needs ImageMagick (`convert`, `identify`) on PATH. It is NOT part of
 * `npm run build` - the derivatives are committed, so the Railway build has no
 * image tooling requirement. Re-run after adding or replacing a photo:
 *   node scripts/seo/optimize-photos.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "client", "public", "photos");
const OUT = path.join(__dirname, "..", "..", "client", "src", "data", "photos.generated.json");
const WIDTHS = [640, 1200];

const manifest = {};
for (const f of fs.readdirSync(DIR).filter((n) => /\.jpe?g$/i.test(n)).sort()) {
  const src = path.join(DIR, f);
  const [w, h] = execFileSync("identify", ["-format", "%w %h", src]).toString().trim().split(" ").map(Number);
  const base = f.replace(/\.jpe?g$/i, "");
  const webp = [];
  for (const tw of WIDTHS) {
    if (tw > w) continue;
    const out = path.join(DIR, `${base}-${tw}.webp`);
    execFileSync("convert", [src, "-auto-orient", "-resize", `${tw}x`, "-strip", "-quality", "72", "-define", "webp:method=6", out]);
    webp.push({ w: tw, src: `/photos/${base}-${tw}.webp`, bytes: fs.statSync(out).size });
  }
  manifest[`/photos/${f}`] = { w, h, bytes: fs.statSync(src).size, webp };
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(`photos: ${Object.keys(manifest).length} sources -> ${OUT}`);
