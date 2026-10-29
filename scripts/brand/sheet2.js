// Builds client/public/brand/review-sheet-2.html — self-contained, SVGs inlined.
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2];
const CMP_DIR = process.argv[3] || 'e'; // direction shown in all palettes
const cmp = JSON.parse(fs.readFileSync(path.join(DIR, '.palettes.json'), 'utf8'));
const P = cmp.p1.palette;
const names = { D: 'd-knife', E: 'e-kerf', F: 'f-plate' };
const titles = { D: 'D · Knife Edge', E: 'E · The Kerf', F: 'F · On the Plate' };
const blurbs = {
  D: 'The straightedge as one stroke the name rests on — true edge dead level on top, heel cut square, far end ground to a knife point. Oswald SemiBold.',
  E: 'A square of stock parted by one dead-straight cut; nothing moved, the halves still make a square. Archivo Bold, set tight.',
  F: 'The straightedge standing dead square on the surface plate (an engineer reads ⟂). The name is custom-drawn: straight strokes only, 45° machined chamfers where a curve would be.',
};

function strip(s) { return s.replace(/ aria-labelledby="t"/, '').replace(/<title id="t">.*?<\/title>\n?/, ''); }
function load(name) { return strip(fs.readFileSync(path.join(DIR, name + '.svg'), 'utf8')); }
function at(nameOrSvg, { width, height, style = '' }) {
  const s = nameOrSvg.startsWith('<svg') ? strip(nameOrSvg) : load(nameOrSvg);
  // a very wide mark (D's bare blade, 100 × 9) is sized by width so it doesn't balloon
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(s);
  if (height && vb && Number(vb[1]) / Number(vb[2]) > 4) { width = Math.round(height * 2.6); height = undefined; }
  const dim = width ? `width="${width}"` : `height="${height}"`;
  return s.replace('<svg ', `<svg ${dim} style="display:block;${style}" `);
}

let sections = '';
for (const k of ['D', 'E', 'F']) {
  const n = names[k];
  sections += `
<section class="dir">
  <header><h2>${titles[k]}</h2><p>${blurbs[k]}</p></header>

  <div class="row big">
    <figure><figcaption>Horizontal</figcaption>${at(n + '-horizontal', { width: 500 })}
      <figcaption style="margin-top:22px">Horizontal compact (under 40 mm)</figcaption>${at(n + '-horizontal-compact', { width: 360 })}</figure>
    <figure><figcaption>Stacked</figcaption>${at(n + '-stacked', { height: 190 })}</figure>
    <figure><figcaption>Mark</figcaption>${at(n + '-mark', { height: 150 })}</figure>
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
      <div class="mm" style="width:10mm">${at(n + '-mark', { width: '100%' })}</div>
    </figure>
    <figure class="small"><figcaption>Favicon · 32 px and 16 px, light and dark</figcaption>
      <div class="fav">${at(n + '-mark', { width: 32 })}</div>
      <div class="fav">${at(n + '-mark', { width: 16 })}</div>
      <div class="fav bg">${at(n + '-mark-1c', { width: 32, style: 'color:' + P.paper })}</div>
      <div class="fav bg">${at(n + '-mark-1c', { width: 16, style: 'color:' + P.paper })}</div>
    </figure>
    <figure class="shelf"><figcaption>Shelf test · app-icon size beside three neutral competitors</figcaption>
      <div class="icons">
        <div class="icon us">${at(n + '-mark-1c', { width: 36, style: 'color:' + P.paper })}</div>
        <div class="icon"><span>Competitor A</span></div>
        <div class="icon"><span>Competitor B</span></div>
        <div class="icon"><span>Competitor C</span></div>
      </div>
      <div class="icons">
        <div class="icon light">${at(n + '-mark', { width: 36 })}</div>
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
    <figure class="stamp"><figcaption>Part stamp · 6 mm mark, one color, on black acetal</figcaption>
      <div class="acetal">${at(n + '-mark-1c', { width: 23, style: 'color:#C9CBCF' })}</div>
    </figure>
  </div>
</section>`;
}

// palette comparison: one direction in all palettes
let palRows = '';
for (const [pk, c] of Object.entries(cmp)) {
  const pal = c.palette;
  const set = c[CMP_DIR];
  palRows += `
  <div class="palrow">
    <div class="palname"><b>${pal.name}</b>
      <div class="chips"><i style="background:${pal.ink}"></i><i style="background:${pal.accent}"></i><i style="background:${pal.paper};border:1px solid #ddd"></i></div>
      <code>${pal.ink} · ${pal.accent} · ${pal.paper}</code></div>
    <div class="palcell" style="background:#fff">${at(set.horizontal, { width: 360 })}</div>
    <div class="palcell" style="background:${pal.paper}">${at(set.stacked, { height: 120 })}</div>
    <div class="palcell" style="background:${pal.dark}">${at(set['horizontal-compact'], { width: 300, style: 'filter:none' }).replace(new RegExp(pal.ink.replace('#', '#'), 'g'), pal.paper)}</div>
    <div class="palcell" style="background:${pal.dark}">${at(set.mark, { height: 64 })}</div>
  </div>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Straightedge — logo review sheet 2</title>
<style>
  :root{--ink:${P.ink};--accent:${P.accent};--gray:${P.gray}}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 48px 80px;background:#fff;color:var(--ink);font:14px/1.5 Inter,system-ui,sans-serif}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:.01em}
  .sub{color:var(--gray);margin:0 0 28px;max-width:980px}
  section.dir{border-top:2px solid var(--ink);padding:24px 0 36px}
  section.dir header{display:flex;gap:24px;align-items:baseline;margin-bottom:18px}
  section.dir h2{margin:0;font-size:20px;white-space:nowrap}
  section.dir header p{margin:0;color:var(--gray);max-width:820px}
  .row{display:flex;gap:28px;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap}
  figure{margin:0;border:1px solid #E5E7EB;padding:18px}
  figcaption{font:11px/1.2 ui-monospace,monospace;color:var(--gray);margin-bottom:14px;letter-spacing:.04em;text-transform:uppercase}
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
  .why{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:0 0 10px}
  .why div{border:1px solid #E5E7EB;padding:14px;font-size:12.5px}
  .why b{display:block;margin-bottom:4px}
</style></head><body>
<h1>STRAIGHTEDGE — round 2: three gesture-led directions</h1>
<p class="sub">Each mark is one shape that can stand alone without letters. Shown in the recommended palette (Ink &amp; Brass), one-color, on dark, at 20 mm, as a favicon, on a shelf beside neutral competitors, on a packing slip, embroidered, and as a 6 mm part stamp. The last section shows direction ${CMP_DIR.toUpperCase()} in all three palettes so color can be judged apart from form.</p>

<div class="palettes"><h2>Palettes</h2>
<div class="why">
  <div><b>1 · Ink &amp; Brass — recommended</b>Deep ink navy with a warm brass accent on bone paper. The colors of an instrument case: the gauge, the dial, the nameplate. Reads expensive and settled, and no shop in the directory owns it.<code>${cmp.p1.palette.ink} · ${cmp.p1.palette.accent} · ${cmp.p1.palette.paper}</code></div>
  <div><b>2 · Charcoal &amp; Layout Blue</b>Charcoal with the round-1 Dykem layout-fluid blue as the single signal. Cooler and more technical — reads "engineering" before "heritage". Safe, credible, slightly common.<code>${cmp.p2.palette.ink} · ${cmp.p2.palette.accent} · ${cmp.p2.palette.paper}</code></div>
  <div><b>3 · Machine Green &amp; Bone</b>The gray-green of old iron (Bridgeport, South Bend) on bone — the color of natural acetal stock. Quiet and very credible to a machinist; the least "brand-like" of the three.<code>${cmp.p3.palette.ink} · ${cmp.p3.palette.accent} · ${cmp.p3.palette.paper}</code></div>
</div>
</div>
${sections}
<div class="palettes"><h2>Direction ${CMP_DIR.toUpperCase()} in each palette</h2>${palRows}</div>
</body></html>`;
fs.writeFileSync(path.join(DIR, 'review-sheet-2.html'), html);
console.log('wrote review-sheet-2.html');
