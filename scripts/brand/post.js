#!/usr/bin/env node
// Part-photo posts for LinkedIn: a photo with a bone caption bar carrying the mark.
//
//   node post.js <photo> --title "UHMW gear rack, routed" [--detail "Cut from 1 in. plate"]
//                [--ratio square|4x5] [--position "50% 40%"] [--out file.png]
//
// <photo> is a path, or a bare file name in client/public/photos. Output defaults to
// client/public/brand/social/post-<photo>-<ratio>.png. The caption is outlined (Inter), so the
// result does not depend on installed fonts.
const fs = require('fs');
const path = require('path');
const L = require('./kit-lib');
const { INK, BRASS, BONE, GRAY, mark, txt, svgDoc } = L;

const POST_SIZES = { square: [1080, 1080], '4x5': [1080, 1350] };
const BAR = 200;

// The caption bar: a brass hairline on its top edge, the mark at the left, the caption in ink.
function barMarkup(w, y, { title, detail, domain }) {
  const pad = 56, S = 96, x = pad + S + 34, right = w - pad;
  const out = [
    `<rect x="0" y="${y}" width="${w}" height="${BAR}" fill="${BONE}"/>`,
    `<rect x="0" y="${y}" width="${w}" height="3" fill="${BRASS}"/>`,
    mark(pad, y + (BAR - S) / 2 + 1, S, BRASS, 'stepped'),
    txt('inter-600', title || '', 40, { x, y: y + 90, fill: INK, maxWidth: right - x }).markup,
  ];
  const d = txt('inter-600', domain || '', 24, { x: right, y: y + 142, fill: INK, anchor: 'end' });
  if (domain) out.push(d.markup);
  if (detail) out.push(txt('inter-400', detail, 26, { x, y: y + 142, fill: GRAY, maxWidth: right - x - (domain ? d.width + 36 : 0) }).markup);
  return out.join('\n');
}
/** The whole post as SVG. `photoHref` (data URI or path) fills the photo area; `template` draws a placeholder instead. */
function postSvg({ ratio = 'square', title, detail, domain, photoHref, template = false }) {
  const [w, h] = POST_SIZES[ratio];
  const ph = h - BAR;
  const photo = template
    ? `<rect id="photo" width="${w}" height="${ph}" fill="#D9D6CE"/>\n<path d="M0 0L${w} ${ph}M${w} 0L0 ${ph}" stroke="#C4C0B6" stroke-width="2"/>\n${txt('inter-600', `PHOTO  ${w} × ${ph}`, 30, { x: w / 2, y: ph / 2 + 80, fill: '#8C887E', anchor: 'middle' }).markup}`
    : `<image id="photo" href="${photoHref}" x="0" y="0" width="${w}" height="${ph}" preserveAspectRatio="xMidYMid slice"/>`;
  return svgDoc(w, h, `${photo}\n${barMarkup(w, ph, { title, detail, domain })}`, title || 'Straightedge part photo');
}
// Composite with the browser so the crop can be steered (CSS object-position) for off-centre parts.
async function compositePost(browser, { photo, ratio = 'square', title, detail, domain, position = '50% 50%', out }) {
  const [w, h] = POST_SIZES[ratio];
  const ph = h - BAR;
  const ext = path.extname(photo).slice(1).toLowerCase();
  const uri = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(photo).toString('base64')}`;
  const bar = svgDoc(w, BAR, barMarkup(w, 0, { title, detail, domain })).replace('<svg ', '<svg style="display:block" ');
  const html = `<!doctype html><html><body style="margin:0;background:${BONE}"><img src="${uri}" style="display:block;width:${w}px;height:${ph}px;object-fit:cover;object-position:${position}">${bar}</body></html>`;
  return L.renderPng(browser, { html, w, h, out });
}

module.exports = { POST_SIZES, postSvg, compositePost };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { ratio: 'square' };
  let photo;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i]; else photo = args[i];
  }
  const root = path.resolve(__dirname, '..', '..');
  if (!photo || !opt.title || !POST_SIZES[opt.ratio]) {
    console.error('usage: node post.js <photo> --title "…" [--detail "…"] [--ratio square|4x5] [--position "50% 40%"] [--out file.png]');
    process.exit(1);
  }
  if (!fs.existsSync(photo)) photo = path.join(root, 'client', 'public', 'photos', photo);
  const brand = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'brand.json'), 'utf8'));
  const out = opt.out || path.join(root, 'client', 'public', 'brand', 'social', `post-${path.basename(photo, path.extname(photo))}-${opt.ratio}.png`);
  L.withBrowser((b) => compositePost(b, { photo, ratio: opt.ratio, title: opt.title, detail: opt.detail, position: opt.position, domain: brand.domain, out }))
    .then(() => console.log(out)).catch((e) => { console.error(e); process.exit(1); });
}
