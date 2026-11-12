/**
 * The full description of an order line, for the admin's order screen: process ·
 * material · grade · stock thickness · size · finish · tolerance · layer
 * height · quantity.
 *
 * The same rules as the job traveler (server/services/documents.js, specOf),
 * reading the same stored fields: `config` is the quote line's detail, with
 * the buyer's own choices under `config.input`. A value the line does not
 * carry and the job cannot be made without is shown as "NOT RECORDED — confirm
 * with customer", never left out: a DXF has no thickness of its own, so a
 * routed line with no thickness must say so.
 *
 * @returns {{parts: Array<{text: string, missing: boolean}>, missing: string[]}}
 */
// No imports: the labels and the grade wording are passed in (utils/orderLine.js does that for
// the app), so this file also runs under plain `node` for its test.

const num = (...vals) => { for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; } return 0; };
const trim = (n, places) => String(Number(Number(n).toFixed(places)));
const mmIn = (mm) => `${trim(mm, 2)} mm (${(Number(mm) / 25.4).toFixed(3)} in)`;
const sizeText = (dims) => `${dims.map((d) => trim(d, 1)).join(' × ')} mm (${dims.map((d) => (Number(d) / 25.4).toFixed(2)).join(' × ')} in)`;
const titleFromSlug = (s) => { const t = String(s || '').replace(/^(cnc|rt|fdm|sla|sm)-/, '').replace(/[-_]+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

export function specFor(item = {}, { labels = {}, gradeLabel = (g) => String(g || '') } = {}) {
  const meta = item.config || item.meta || {};
  const input = meta.input || {};
  // What was priced and charged for this line, kept with the order since 2026-11-11 (`config.priced`).
  // Read first for every value it carries; an older order has none and falls through to the older
  // fields, and from there to NOT RECORDED. (Same rule as the server's specOf.)
  const priced = meta.priced && typeof meta.priced === 'object' ? meta.priced : {};
  const g = item.geometry || {};
  const gs = meta.geometrySummary || {};
  const p = priced.process || item.process || meta.process || '';
  const parts = [];
  const missing = [];
  const add = (text) => parts.push({ text, missing: false });
  const miss = (what, todo = 'confirm with customer') => { missing.push(what); parts.push({ text: `${what}: NOT RECORDED — ${todo}`, missing: true }); };

  const sub = priced.subProcess || meta.subProcess || input.subProcess || '';
  const proc = (p === 'cnc' && sub === 'turning' ? 'CNC turning' : p === 'cnc' && sub === 'milling' ? 'CNC milling' : labels[p]) || p;
  if (proc) add(p === '3d-printing' && ['fdm', 'sla', 'sls'].includes(sub) ? `${proc} (${sub.toUpperCase()})` : proc); else miss('process');

  const material = priced.materialName || item.materialName || meta.materialName || titleFromSlug(priced.materialSlug || item.materialSlug || meta.materialSlug);
  if (material) add(material); else miss('material');

  const machined = p === 'cnc' || p === 'routing' || p === 'sheetmetal';
  const grade = gradeLabel(priced.grade || item.grade || meta.grade || input.grade);
  if (grade) add(`grade ${grade}`); else if (machined) miss('grade');

  const is2D = priced.is2D === true || g.is2D === true;
  const flat = p === 'routing' || p === 'sheetmetal' || is2D;
  const thick = num(priced.thicknessMm, item.thicknessMm, meta.thicknessMm, input.thicknessMm, gs.blankMm?.t);
  if (thick) add(`${flat ? 'stock thickness' : 'thickness'} ${mmIn(thick)}`); else if (flat) miss('thickness');

  // The size that was priced, else the part as measured from the file, else what pricing worked from.
  const pd = priced.dimsMm || {};
  const asPriced = (is2D ? [num(pd.x), num(pd.y)] : [num(pd.x), num(pd.y), num(pd.z)]).filter((n) => n > 0);
  const bb = g.boundingBox || {};
  const measured = [num(bb.width, bb.x, g.flatWidth), num(bb.height, bb.y, g.flatHeight), num(bb.depth, bb.z)].filter((n) => n > 0);
  const worked = (gs.blankMm ? [num(gs.blankMm.w), num(gs.blankMm.h)] : gs.stockMm ? [num(gs.stockMm.w), num(gs.stockMm.h), num(gs.stockMm.d)] : []).filter((n) => n > 0);
  if (asPriced.length >= 2) add(`size ${sizeText(asPriced)}`);
  else if (measured.length >= 2) add(`size ${sizeText(g.is2D ? measured.slice(0, 2) : measured)}`);
  else if (worked.length >= 2) add(`${gs.blankMm ? 'blank' : 'stock'} ${sizeText(worked)}`);
  else miss('size', 'measure from the file');
  const unit = priced.sourceUnit || g.profile2d?.units?.unit || g.sourceUnit || '';
  // A drawing's units, when the order line or the part says them (the printed traveler also calls out a DXF with none).
  if (unit && (is2D || /\.dxf$/i.test(item.fileName || ''))) add(`drawing units ${unit === 'in' ? 'inches' : unit === 'mm' ? 'millimetres' : unit}${g.profile2d?.units?.source === 'customer' ? ' (chosen by the customer)' : ''}`);
  // The part on file is no longer the part that was priced (the server compares; it should never happen).
  if (item.matchesPriced === false) { missing.push('part file'); parts.push({ text: 'PART FILE CHANGED SINCE IT WAS PRICED — do not cut from it; confirm with customer', missing: true }); }

  const finishSlug = priced.finishSlug || item.finishSlug || meta.finishSlug || input.finishSlug || '';
  const finish = priced.finishName || item.finishName || meta.finishName || titleFromSlug(finishSlug);
  if (finish) add(`finish ${finish}`); else miss('finish');

  const tolerance = meta.tolerance || input.tolerance || item.tolerance;
  add(tolerance ? `tolerance ${String(tolerance).replace(/\s+/g, ' ').slice(0, 120)}` : 'tolerance: no option ordered');

  if (p === '3d-printing') {
    const layer = num(priced.layerHeight, meta.layerHeightMm, input.layerHeight, meta.layerHeight);
    if (layer) add(`layer height ${trim(layer, 3)} mm`); else miss('layer height');
    const infill = num(priced.infill, input.infill, meta.infill);
    if (infill && sub !== 'sla') add(`infill ${Math.round(infill <= 1 ? infill * 100 : infill)}%`);
  }

  const qty = num(item.quantity, priced.quantity);
  if (qty) add(`qty ${qty}`); else miss('quantity');
  return { parts, missing };
}
