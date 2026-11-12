/**
 * Admin tables that scroll sideways on a narrow screen can be reached from the keyboard
 * (WCAG 2.1.1; axe: scrollable-region-focusable, serious).
 *
 * Under 1100 px every admin card scrolls sideways when its table is wider than the screen
 * (global.css: `.admin-page .card { overflow-x: auto }`). A region that scrolls and holds nothing
 * focusable cannot be scrolled without a pointer, so each card that holds a wide table is a
 * focusable, named region: `className="card table-scroll" tabIndex={0} role="region" aria-label=…`.
 * The Change log tab arrived on another branch without it and was the one serious finding of the
 * accessibility scan on the merged build (scripts/e2e/journey-qa.mjs, 390 px). The scan is the proof
 * on the rendered page; this holds the markup in place without a browser.
 * Run: `node client/src/components/admin/tableRegions.test.js`
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log('Admin tables: scrollable regions are focusable and named');

const TABLES = [
  ['pages/AdminPanel.jsx', 'Orders table'],
  ['components/RfqQueue.jsx', 'Quote requests table'],
  ['components/admin/MaterialsEditor.jsx', 'Materials table'],
  ['components/admin/CalibrationTab.jsx', 'Calibration table'],
  ['components/admin/ChangeLogTab.jsx', 'Change log table'],
];

for (const [file, label] of TABLES) {
  test(`${file}: the card that holds the table is a focusable region named "${label}"`, () => {
    const text = read(file);
    const m = new RegExp(`<div className="card table-scroll" tabIndex=\\{0\\} role="region" aria-label="${label}"[^>]*>`).exec(text);
    assert.ok(m, 'className="card table-scroll" tabIndex={0} role="region" aria-label');
    assert.ok(text.indexOf('<table', m.index) > m.index, 'and the table is inside it');
  });
}

test('the price preview: the focusable aside is the region that scrolls, not the card inside it', () => {
  // Seen once in three walks of the merged build (390 px, Admin → Pricing): when the preview's table was wider
  // than the screen, the card inside the aside became a second scrolling region that the keyboard could not reach.
  assert.ok(/<aside className="pc-preview" tabIndex=\{0\} aria-label="Price preview">/.test(read('components/admin/PricingConsole.jsx')));
  assert.ok(/\.pc-preview\s*\{[^}]*overflow:\s*auto/.test(read('styles/admin.css')), 'the aside scrolls');
  const css = read('styles/global.css');
  const narrow = css.slice(css.indexOf('.admin-page .card, .admin-page .table-scroll { overflow-x: auto !important; }'));
  assert.ok(/\.admin-page \.pc-preview \.card\s*\{\s*overflow-x:\s*visible\s*!important;\s*\}/.test(narrow.slice(0, 600)), 'the card inside it does not, at the widths where admin cards scroll');
});

test('the focus ring for those regions is in the stylesheet', () => {
  assert.ok(/\.table-scroll:focus-visible\s*\{[^}]*outline:/.test(read('styles/global.css')));
});

console.log(`\n${passed} passed`);
