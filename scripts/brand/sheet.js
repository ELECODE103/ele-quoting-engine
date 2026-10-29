// Builds client/public/brand/review-sheet.html — self-contained, SVGs inlined.
const fs = require('fs');
const path = require('path');
const DIR = process.argv[2];
const names = { A: 'a-dead-square', B: 'b-ruled', C: 'c-bar' };
const titles = { A: 'A · Dead Square', B: 'B · Ruled', C: 'C · The Bar' };
const blurbs = {
  A: 'A capital S drawn with straight strokes only, set in a dead-square field. Straight + square.',
  B: 'Type-led. The name is checked between a hairline and a heavy rule — a sign-painter’s layout.',
  C: 'STRAIGHT and EDGE separated by the straightedge itself, a ground bar standing proud of the letters.',
};

function load(name) {
  // strip the xml title id so repeated inlines don't share ids
  return fs.readFileSync(path.join(DIR, name + '.svg'), 'utf8').replace(/ aria-labelledby="t"/, '').replace(/<title id="t">.*?<\/title>\n?/, '');
}
function at(name, { width, height, style = '' }) {
  const s = load(name);
  const dim = width ? `width="${width}"` : `height="${height}"`;
  return s.replace('<svg ', `<svg ${dim} style="display:block;${style}" `);
}

let sections = '';
for (const k of ['A', 'B', 'C']) {
  const n = names[k];
  sections += `
<section class="dir">
  <header><h2>${titles[k]}</h2><p>${blurbs[k]}</p></header>

  <div class="row big">
    <figure><figcaption>Horizontal · color</figcaption>${at(n + '-horizontal', { width: 500 })}
      <figcaption style="margin-top:22px">Horizontal compact (under 40 mm)</figcaption>${at(n + '-horizontal-compact', { width: 360 })}</figure>
    <figure><figcaption>Stacked · color</figcaption>${at(n + '-stacked', { height: 190 })}</figure>
    <figure><figcaption>Mark · color</figcaption>${at(n + '-mark', { height: 150 })}</figure>
  </div>

  <div class="row">
    <figure class="dark"><figcaption>On dark · one color (white)</figcaption>
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
    <figure class="small"><figcaption>Favicon · 32 px and 16 px${k === 'A' ? ' (favicon.svg, then mark)' : ''}</figcaption>
      ${k === 'A' ? `<div class="fav">${at('favicon', { width: 32 })}</div><div class="fav">${at('favicon', { width: 16 })}</div>` : ''}
      <div class="fav">${at(n + '-mark', { width: 32 })}</div>
      <div class="fav">${at(n + '-mark', { width: 16 })}</div>
      <div class="fav bg">${at(n + '-mark-1c', { width: 32, style: 'color:#fff' })}</div>
      <div class="fav bg">${at(n + '-mark-1c', { width: 16, style: 'color:#fff' })}</div>
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
    <figure class="hat"><figcaption>Embroidered patch · one color thread on navy twill</figcaption>
      <div class="twill"><div class="thread">${at(n + '-mark-1c', { height: 64, style: 'color:#F5F1E8' })}</div></div>
      <div class="twill tan"><div class="thread">${at(n + '-stacked-1c', { height: 84, style: 'color:#1F2A44' })}</div></div>
    </figure>
  </div>
</section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Straightedge — logo review sheet</title>
<style>
  :root{--ink:#0F172A;--blue:#1F418F;--gray:#6B7280}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 48px 80px;background:#fff;color:var(--ink);font:14px/1.5 Inter,system-ui,sans-serif}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:.01em}
  .sub{color:var(--gray);margin:0 0 28px}
  .swatches{display:flex;gap:10px;margin:0 0 36px}
  .sw{width:150px;padding:10px;border:1px solid #E5E7EB;font:12px/1.3 ui-monospace,monospace}
  .sw i{display:block;height:40px;margin-bottom:8px}
  section.dir{border-top:2px solid var(--ink);padding:24px 0 36px}
  section.dir header{display:flex;gap:24px;align-items:baseline;margin-bottom:18px}
  section.dir h2{margin:0;font-size:20px;white-space:nowrap}
  section.dir header p{margin:0;color:var(--gray);max-width:720px}
  .row{display:flex;gap:28px;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap}
  figure{margin:0;border:1px solid #E5E7EB;padding:18px}
  figcaption{font:11px/1.2 ui-monospace,monospace;color:var(--gray);margin-bottom:14px;letter-spacing:.04em;text-transform:uppercase}
  .big figure{display:flex;flex-direction:column;justify-content:flex-start}
  figure.dark{background:#0F172A;color:#fff;border-color:#0F172A}
  figure.dark figcaption{color:#94A3B8}
  .pad{margin:6px 0 18px}
  figure.small{min-width:300px}
  .mm{margin:0 0 14px}
  .fav{display:inline-block;padding:10px;margin-right:6px;border:1px dashed #E5E7EB;vertical-align:middle}
  .fav.bg{background:#0F172A;border-color:#0F172A}
  .paper{width:420px;background:#fff;border:1px solid #D1D5DB;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:16px 18px;color:#000}
  .slip-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.5px solid #000;padding-bottom:12px;margin-bottom:10px}
  .slip-meta{text-align:right;font:10px/1.4 Inter,system-ui,sans-serif}
  .slip-meta b{font-size:12px;letter-spacing:.08em}
  table{width:100%;border-collapse:collapse;font:10px/1.5 Inter,system-ui,sans-serif}
  th{text-align:left;border-bottom:1px solid #000;font-weight:600}
  td{border-bottom:1px solid #E5E7EB;padding:3px 0}
  .twill{display:inline-block;width:210px;height:140px;margin-right:8px;border-radius:6px;background:
    repeating-linear-gradient(45deg,#1A2744 0 2px,#22325A 2px 4px);display:inline-flex;align-items:center;justify-content:center}
  .twill.tan{background:repeating-linear-gradient(45deg,#C9B890 0 2px,#D6C7A2 2px 4px)}
  .thread{filter:drop-shadow(0 0.6px 0 rgba(0,0,0,.35))}
</style></head><body>
<h1>STRAIGHTEDGE — logo directions for review</h1>
<p class="sub">Straightedge Manufacturing LLC · Wauconda, Illinois · Three directions, each shown large, one-color, on dark, at 20 mm, as a favicon, on a packing slip and as a one-color embroidered patch.</p>
<div class="swatches">
  <div class="sw"><i style="background:#0F172A"></i>Ink<br>#0F172A</div>
  <div class="sw"><i style="background:#1F418F"></i>Layout Blue<br>#1F418F</div>
  <div class="sw"><i style="background:#6B7280"></i>Plate Gray<br>#6B7280</div>
  <div class="sw"><i style="background:#fff;border:1px solid #E5E7EB"></i>White<br>#FFFFFF</div>
</div>
${sections}
</body></html>`;
fs.writeFileSync(path.join(DIR, 'review-sheet.html'), html);
console.log('wrote review-sheet.html');
