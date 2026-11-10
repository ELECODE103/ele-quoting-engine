// Fact flags. Every owner-dependent statement on the public site hangs on an
// entry in shared/shop-facts.json and is rendered only once the owner has set
// `confirmed: true` there. Pure functions of a JSON file: same output on the
// server (prerender) and in the browser.
import data from '../../shared/shop-facts.json';

const FACTS = data.facts;

function filled(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'object') return Object.values(v).some(filled) && (v.standard === undefined || filled(v.standard));
  return true;
}

/** True when every id is confirmed and has something to say. */
export function ok(...ids) {
  return ids.flat().every((id) => {
    const f = FACTS[id];
    if (!f) throw new Error(`Unknown shop fact "${id}" (shared/shop-facts.json)`);
    return f.confirmed === true && filled(f.value);
  });
}

/** The confirmed value, or null. */
export function fact(id) {
  return ok(id) ? FACTS[id].value : null;
}

/** `yes` when the facts are confirmed (a function gets their values), else `no`. */
export function when(ids, yes, no = '') {
  const list = [].concat(ids);
  if (!ok(list)) return no;
  return typeof yes === 'function' ? yes(...list.map((id) => FACTS[id].value)) : yes;
}

/**
 * Resolve a list of copy lines. A string always ships. An object ships only
 * when its `needs` facts are confirmed: { needs, text, or }.
 *   text: string | (values...) => string | omitted (the fact's own value is the sentence)
 *   or:   wording that is true regardless (optional; without it the line is dropped)
 */
export function lines(items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'string') { out.push(it); continue; }
    if (!it) continue;
    const ids = [].concat(it.needs);
    if (ok(ids)) out.push(it.text === undefined ? String(FACTS[ids[0]].value) : (typeof it.text === 'function' ? it.text(...ids.map((id) => FACTS[id].value)) : it.text));
    else if (it.or) out.push(it.or);
  }
  return out;
}

// ─── Catalog visibility ────────────────────────────────────────────────────
// Materials the site does not offer until the owner confirms them. The server
// applies the same rule to the quote tool's lists (server/shopFacts.js).
export function materialVisible(m) {
  if (m.subProcess === 'sls' || /\bSLS\b/.test(m.name || '')) return ok('sls-offered');
  if (m.slug === 'sla-dental') return ok('dental-resin');
  return true;
}

/**
 * Grade names in the catalog carry "(FDA)". Food-contact compliance belongs to
 * a specific maker's grade and lot, so the label says that only once the owner
 * has confirmed the compliance statements are obtainable.
 */
export function gradeLabel(name) {
  const s = String(name || '');
  if (!/\(FDA\)/.test(s)) return s;
  return ok('food-docs')
    ? s.replace(/\s*\(FDA\)/, ', food-contact grade (maker\'s compliance statement on request)')
    : s.replace(/\s*\(FDA\)/, '');
}

// ─── Per-material tolerances ───────────────────────────────────────────────
export const TOLERANCE_ROWS = [
  { id: 'tol-acetal', material: 'Acetal / Delrin', match: ['delrin', 'acetal'], moves: 'Little. The plastic to pick when a dimension matters.' },
  { id: 'tol-nylon', material: 'Nylon', match: ['nylon'], moves: 'Moisture. It grows up to about 2% in length when saturated.' },
  { id: 'tol-uhmw', material: 'UHMW', match: ['uhmw'], moves: 'Temperature, and it springs away from the cutter.' },
  { id: 'tol-hdpe', material: 'HDPE', match: ['hdpe'], moves: 'Temperature. About ten times the expansion of steel.' },
  { id: 'tol-peek', material: 'PEEK', match: ['peek'], moves: 'Stress in the stock when a lot is cut from one side.' },
  { id: 'tol-ptfe', material: 'PTFE', match: ['ptfe'], moves: 'Clamping, load and temperature. It creeps.' },
  { id: 'tol-polycarbonate', material: 'Polycarbonate', match: ['polycarbonate'], moves: 'Little. Watch for stress cracking, not size.' },
  { id: 'tol-polypropylene', material: 'Polypropylene', match: ['polypropylene'], moves: 'Temperature, and stress when cut unevenly.' },
];

/** Only the rows the owner has confirmed. Empty array = no table. */
export function toleranceRows() {
  return TOLERANCE_ROWS.filter((r) => ok(r.id)).map((r) => ({ ...r, ...FACTS[r.id].value }));
}

/** Confirmed tolerance for a catalog material (slug or name), or null. */
export function toleranceFor(text) {
  const hay = String(text || '').toLowerCase();
  return toleranceRows().find((r) => r.match.some((k) => hay.includes(k))) || null;
}

/** "milled, turned and routed" / "milled and routed" */
export const MACHINED = when('turning', 'milled, turned and routed', 'milled and routed');
export const MILLING = when('turning', 'milling and turning', 'milling');
