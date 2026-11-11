// Builds client/public/brand/review-sheet-3.html (self-contained, SVGs inlined) and, when
// Playwright can be found, screenshots it to review-sheet-3.png.
//   node sheet3.js <branddir> [--no-png]
// In a proxied container run:  env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost node sheet3.js ../../client/public/brand
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2];
const NO_PNG = process.argv.includes('--no-png');
const cmp = JSON.parse(fs.readFileSync(path.join(DIR, '.palettes3.json'), 'utf8'));
const P = cmp.p1.palette;

const DIRS = [
  { key: 'd2-knife', title: 'D2 · Knife Edge', blurb: 'The name rests on the straightedge: top edge dead flat, far end ground to a point, and the heel’s lower corner broken by a 45° chamfer built from three printed layers. Oswald SemiBold +6 %. Alone, the blade needs its plate (an ink square) to be an icon.' },
  { key: 'd3-cut', title: 'D3 · The Cut', blurb: 'The same blade under a name drawn with straight strokes only — every curve is a 45° machined chamfer (S, R, A, G, D). Machining is in the letters, the printed layers are in the heel, the ground edge is the blade. Same plate rule for icons.' },
  { key: 'e2-layers', title: 'E2 · The Kerf, layered', blurb: 'A square of stock parted by one true cut: printed in layers below the cut, machined solid above. The layers need the square to be at least 17 mm / 64 px; below that the solid square is used (`-mark-small`, and the compact lockup). Archivo Bold +3 %.' },
  { key: 'e3-light', title: 'E3 · The Kerf, light under the edge', blurb: 'A square of stock parted by one straightedge: the upper half is machined and its lower face is the true edge; the lower half is printed to the slope, so its face is a stair, and the light between them is the kerf. Below 8.5 mm / 32 px it collapses to the solid square.' },
];
const REC = ['e3-light', 'd2-knife'];   // shown in both palettes at the end

function strip(s) { return s.replace(/ aria-labelledby="t"/, '').replace(/<title id="t">.*?<\/title>\n?/, ''); }
function load(name) { return strip(fs.readFileSync(path.join(DIR, name + '.svg'), 'utf8')); }
function at(nameOrSvg, { width, height, style = '' }) {
  const s = nameOrSvg.startsWith('<svg') ? strip(nameOrSvg) : load(nameOrSvg);
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(s);
  // a very wide mark (a bare blade) is sized by width so it does not balloon
  if (height && vb && Number(vb[1]) / Number(vb[2]) > 2.4) { width = Math.round(height * 2.2); height = undefined; }
  const dim = width ? `width="${width}"` : `height="${height}"`;
  return s.replace('<svg ', `<svg ${dim} style="display:block;${style}" `);
}
const has = (n) => fs.existsSync(path.join(DIR, n + '.svg'));

let sections = '';
for (const { key: n, title, blurb } of DIRS) {
  const small = has(n + '-mark-small') ? n + '-mark-small' : n + '-mark';
  const icon = has(n + '-mark-plate') ? n + '-mark-plate' : small;
  const isE = n.startsWith('e');
  sections += `
<section class="dir">
  <header><h2>${title}</h2><p>${blurb}</p></header>

  <div class="row big">
    <figure><figcaption>Horizontal</figcaption>${at(n + '-horizontal', { width: 500 })}
      <figcaption style="margin-top:22px">Horizontal compact (under 40 mm)</figcaption>${at(n + '-horizontal-compact', { width: 360 })}</figure>
    <figure><figcaption>Stacked</figcaption>${at(n + '-stacked', { height: 190 })}</figure>
    <figure><figcaption>Mark${isE ? ' · and the small-size fallback' : (has(n + '-mark-plate') ? ' · and on its plate (icon use)' : '')}</figcaption>
      <div class="marks">${at(n + '-mark', { height: 150 })}${isE ? at(small, { height: 70 }) : (has(n + '-mark-plate') ? at(icon, { height: 70 }) : '')}</div></figure>
  </div>

  <div class="row">
    <figure class="dark"><figcaption>On dark · one color (paper)</figcaption>
      <div class="pad">${at(n + '-horizontal-1c', { width: 420 })}</div>
      <div class="pad">${at(n + '-mark-1c', { height: 96 })}</div>
    </figure>
    <figure><figcaption>One color · black</figcaption>
      <div class="pad">${at(n + '-horizontal-1c', { width: 420 })}</div>
      <div class="pad">${at(n + '-stacked-1c', { height: 140 })}</div>
    </figure>
  </div>

  <div class="row">
    <figure class="small"><figcaption>20 mm wide (75.6 px @ 96 dpi) · compact color, compact 1-color, full, stacked, mark at 10 mm</figcaption>
      <div class="mm" style="width:20mm">${at(n + '-horizontal-compact', { width: '100%' })}</div>
      <div class="mm" style="width:20mm">${at(n + '-horizontal-compact-1c', { width: '100%' })}</div>
      <div class="mm" style="width:20mm">${at(n + '-horizontal', { width: '100%' })}</div>
      <div class="mm" style="width:20mm">${at(n + '-stacked', { width: '100%' })}</div>
      <div class="mm" style="width:10mm">${at(small, { width: '100%' })}</div>
    </figure>
    <figure class="small"><figcaption>Favicon · 32 and 16 px, light and dark${isE ? '<br>then the textured mark at 32 / 16 px' : (has(n + '-mark-plate') ? '<br>on the plate; one-color on dark' : '')}</figcaption>
      <div class="fav">${at(icon, { width: 32 })}</div>
      <div class="fav">${at(icon, { width: 16 })}</div>
      <div class="fav bg">${at(icon + '-1c', { width: 32, style: 'color:' + P.paper })}</div>
      <div class="fav bg">${at(icon + '-1c', { width: 16, style: 'color:' + P.paper })}</div>
      ${isE ? `<div class="fav">${at(n + '-mark', { width: 32 })}</div><div class="fav">${at(n + '-mark', { width: 16 })}</div>` : ''}
    </figure>
    <figure class="shelf"><figcaption>Shelf test · app-icon size beside three neutral competitors</figcaption>
      <div class="icons">
        <div class="icon us">${at(small + '-1c', { width: 36, style: 'color:' + P.paper })}</div>
        <div class="icon"><span>Competitor A</span></div>
        <div class="icon"><span>Competitor B</span></div>
        <div class="icon"><span>Competitor C</span></div>
      </div>
      <div class="icons">
        <div class="icon light">${at(small, { width: 36 })}</div>
        <div class="icon g1"><span>Competitor A</span></div>
        <div class="icon g2"><span>Competitor B</span></div>
        <div class="icon g3"><span>Competitor C</span></div>
      </div>
    </figure>
  </div>

  <div class="row">
    <figure class="slip"><figcaption>Packing slip header (black laser print)</figcaption>
      <div class="paper">
        <div class="slip-head">
          <div>${at(n + '-horizontal-compact-1c', { width: 150 })}</div>
          <div class="slip-meta"><b>PACKING SLIP</b><br>Straightedge Manufacturing LLC<br>Wauconda, Illinois · 224-213-6727</div>
        </div>
        <table><tr><th>Line</th><th>Part</th><th>Material</th><th>Qty</th></tr>
        <tr><td>1</td><td>BRK-2041 Rev C</td><td>Acetal, black</td><td>40</td></tr>
        <tr><td>2</td><td>TRAY-118</td><td>HDPE 3/4"</td><td>12</td></tr></table>
      </div>
    </figure>
    <figure class="hat"><figcaption>Embroidered patch · one color thread on navy twill, and on bone</figcaption>
      <div class="twill"><div class="thread">${at(n + '-mark-1c', { height: 64, style: 'color:#E9DCC2' })}</div></div>
      <div class="twill tan"><div class="thread">${at(n + '-stacked-1c', { width: 150, style: 'color:' + P.ink })}</div></div>
    </figure>
    <figure class="stamp"><figcaption>Part stamp · 6 mm mark, one color, on black acetal${isE ? ' (solid fallback)' : ''}</figcaption>
      <div class="acetal">${at(small + '-1c', { width: 23, style: 'color:#C9CBCF' })}</div>
    </figure>
  </div>
</section>`;
}

// the recommended candidates in both palettes, so colour can be judged apart from form
let palRows = '';
for (const key of REC) {
  const title = DIRS.find((d) => d.key === key).title;
  palRows += `<h3>${title}</h3>`;
  for (const [pk, c] of Object.entries(cmp)) {
    const pal = c.palette, set = c[key];
    const markFile = set['mark-plate'] || set.mark;
    palRows += `
  <div class="palrow">
    <div class="palname"><b>${pal.name}</b>
      <div class="chips"><i style="background:${pal.ink}"></i><i style="background:${pal.accent}"></i><i style="background:${pal.paper};border:1px solid #ddd"></i></div>
      <code>${pal.ink} · ${pal.accent} · ${pal.paper}</code></div>
    <div class="palcell" style="background:#fff">${at(set.horizontal, { width: 360 })}</div>
    <div class="palcell" style="background:${pal.paper}">${at(set.stacked, { height: 120 })}</div>
    <div class="palcell" style="background:${pal.dark}">${at(set['horizontal-compact'], { width: 300 }).split(pal.ink).join(pal.paper)}</div>
    <div class="palcell" style="background:${pal.dark}">${at(markFile, { height: 64 })}</div>
  </div>`;
  }
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Straightedge — logo review sheet 3</title>
<style>
  :root{--ink:${P.ink};--accent:${P.accent};--gray:${P.gray}}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 48px 80px;background:#fff;color:var(--ink);font:14px/1.5 Inter,system-ui,sans-serif}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:.01em}
  h3{font-size:15px;margin:22px 0 4px}
  .sub{color:var(--gray);margin:0 0 28px;max-width:980px}
  section.dir{border-top:2px solid var(--ink);padding:24px 0 36px}
  section.dir header{display:flex;gap:24px;align-items:baseline;margin-bottom:18px}
  section.dir h2{margin:0;font-size:20px;white-space:nowrap}
  section.dir header p{margin:0;color:var(--gray);max-width:860px}
  .row{display:flex;gap:28px;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap}
  figure{margin:0;border:1px solid #E5E7EB;padding:18px}
  figcaption{font:11px/1.2 ui-monospace,monospace;color:var(--gray);margin-bottom:14px;letter-spacing:.04em;text-transform:uppercase}
  .marks{display:flex;gap:28px;align-items:flex-end}
  figure.dark{background:var(--ink);color:#fff;border-color:var(--ink)}
  figure.dark figcaption{color:#A3AAB8}
  .pad{margin:6px 0 18px}
  figure.small{min-width:280px}
  .mm{margin:0 0 14px}
  .fav{display:inline-block;padding:10px;margin-right:6px;border:1px dashed #E5E7EB;vertical-align:middle}
  .fav.bg{background:var(--ink);border-color:var(--ink)}
  .icons{display:flex;gap:14px;margin-bottom:14px}
  .icon{width:60px;height:60px;border-radius:13px;background:#8E9094;display:flex;align-items:center;justify-content:center;text-align:center;font:9px/1.1 Inter,system-ui,sans-serif;color:#fff;padding:4px}
  .icon.g1{background:#9A9CA0}.icon.g2{background:#7C7E82}.icon.g3{background:#B1B3B6}
  .icon.us{background:var(--ink)}.icon.light{background:#fff;border:1px solid #E5E7EB}
  .paper{width:420px;background:#fff;border:1px solid #D1D5DB;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:16px 18px;color:#000}
  .slip-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.5px solid #000;padding-bottom:12px;margin-bottom:10px}
  .slip-meta{text-align:right;font:10px/1.4 Inter,system-ui,sans-serif}
  .slip-meta b{font-size:12px;letter-spacing:.08em}
  table{width:100%;border-collapse:collapse;font:10px/1.5 Inter,system-ui,sans-serif}
  th{text-align:left;border-bottom:1px solid #000;font-weight:600}
  td{border-bottom:1px solid #E5E7EB;padding:3px 0}
  .twill{display:inline-flex;width:200px;height:136px;margin-right:8px;border-radius:6px;background:repeating-linear-gradient(45deg,#1A2744 0 2px,#22325A 2px 4px);align-items:center;justify-content:center}
  .twill.tan{background:repeating-linear-gradient(45deg,#C9B890 0 2px,#D6C7A2 2px 4px)}
  .thread{filter:drop-shadow(0 0.6px 0 rgba(0,0,0,.35))}
  .acetal{width:120px;height:90px;background:linear-gradient(160deg,#2A2B2E,#141517);border-radius:3px;display:flex;align-items:center;justify-content:center}
  .palettes{border-top:2px solid var(--ink);padding:24px 0 10px}
  .palettes h2{font-size:20px;margin:0 0 6px}
  .palrow{display:flex;gap:16px;align-items:center;margin:14px 0}
  .palname{width:230px;font-size:13px}
  .palname code{display:block;font-size:10px;color:var(--gray);margin-top:4px}
  .chips{display:flex;gap:4px;margin:6px 0}.chips i{width:28px;height:18px;display:block}
  .palcell{padding:18px 22px;border:1px solid #E5E7EB;display:flex;align-items:center;justify-content:center;min-height:100px}
  .why{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:0 0 10px;max-width:1100px}
  .why div{border:1px solid #E5E7EB;padding:14px;font-size:12.5px}
  .why b{display:block;margin-bottom:4px}
  .why code{display:block;margin-top:6px;font-size:10.5px;color:var(--gray)}
</style></head><body>
<h1>STRAIGHTEDGE — round 3: D and E refined, with a nod to machining and additive</h1>
<p class="sub">Two candidates for each of the directions the owner chose. Each is one shape, explainable in one sentence; each carries both processes the shop runs. Shown in Ink &amp; Brass, one-color, on dark, at 20 mm, as a favicon, on a shelf beside neutral competitors, on a packing slip, embroidered, and as a 6 mm part stamp. The last section shows the two recommended candidates in Ink &amp; Brass and in Charcoal &amp; Layout Blue so colour can be judged apart from form.</p>

<div class="palettes"><h2>Palettes</h2>
<div class="why">
  <div><b>1 · Ink &amp; Brass — recommended</b>Deep ink navy with a warm brass accent on bone paper: the gauge, the dial, the data plate. Reads expensive and settled; no shop in the directory owns it.<code>${cmp.p1.palette.ink} · ${cmp.p1.palette.accent} · ${cmp.p1.palette.paper}</code></div>
  <div><b>2 · Charcoal &amp; Layout Blue</b>Charcoal with Dykem layout-fluid blue as the single signal. Cooler and more technical — reads "engineering" before "heritage". Safe, credible, slightly common.<code>${cmp.p2.palette.ink} · ${cmp.p2.palette.accent} · ${cmp.p2.palette.paper}</code></div>
</div>
</div>
${sections}
<div class="palettes"><h2>The recommended candidates in each palette</h2>${palRows}</div>
</body></html>`;
fs.writeFileSync(path.join(DIR, 'review-sheet-3.html'), html);
console.log('wrote review-sheet-3.html');

if (!NO_PNG) {
  let pw = null;
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) {
    try { pw = require(p); break; } catch (e) { /* try next */ }
  }
  if (!pw) { console.log('playwright not found; skipped review-sheet-3.png'); }
  else (async () => {
    const b = await pw.chromium.launch();
    const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await page.goto('file://' + path.resolve(DIR, 'review-sheet-3.html'));
    await page.screenshot({ path: path.join(DIR, 'review-sheet-3.png'), fullPage: true });
    await b.close();
    console.log('wrote review-sheet-3.png');
  })();
}
