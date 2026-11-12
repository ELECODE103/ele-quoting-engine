/**
 * The home page's step numerals meet colour contrast (WCAG 2.2 AA 1.4.3).
 * They were Ink at 35% opacity on the white card: 2.2:1, the one serious finding the accessibility scan
 * (scripts/e2e/journey-qa.mjs, axe-core) still reported. This holds the fix in place without a browser:
 * the numeral's colour is one of the existing tokens, at full strength, and that token is at least
 * 4.5:1 on every background a card can sit on. The scan itself is the proof on the rendered page.
 * Run: `node client/src/pages/landingContrast.test.js`
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, 'LandingPage.jsx'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'styles', 'global.css'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const token = (name) => {
  const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\b`).exec(css.slice(css.indexOf(':root')));
  assert.ok(m, `${name} is a colour token in global.css`);
  return m[1];
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** A colour at an opacity over a background, as the eye gets it. */
const over = (fg, bg, alpha) => `#${[1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;

console.log('Home page step numerals: colour contrast');

test('the numeral uses an existing colour token at full strength (no opacity)', () => {
  const m = /className="step-numeral" style=\{\{([^}]*)\}\}/.exec(page);
  assert.ok(m, 'the step numeral is in LandingPage.jsx');
  assert.ok(!/opacity/.test(m[1]), `no opacity on the numeral: ${m[1]}`);
  const colour = /color:\s*'var\((--[a-z-]+)\)'/.exec(m[1]);
  assert.ok(colour, 'its colour is a token');
  assert.strictEqual(colour[1], '--text-muted');
});

test('that token is at least 4.5:1 on white, on the card, and on the Bone and alternate section backgrounds', () => {
  const fg = token('--text-muted');
  for (const bg of ['--bg-card', '--bg-primary', '--bg-secondary', '--bone']) {
    const ratio = contrast(fg, token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} ${token(bg)} is ${ratio.toFixed(2)}:1`);
  }
});

test('what it replaced really did fail: Ink at 35% on white is under 3:1 (the bound for large text)', () => {
  const was = contrast(over(token('--ink'), token('--bg-card'), 0.35), token('--bg-card'));
  assert.ok(was < 3, `${was.toFixed(2)}:1`);
  assert.ok(Math.abs(was - 2.2) < 0.15, `the scan reported 2.2:1; computed ${was.toFixed(2)}:1`);
});

test('no other text on the home page is dimmed with opacity below full strength', () => {
  // Decoration that carries no text (rules, images, icons) may be; anything with words in it may not.
  const dimmedText = [...page.matchAll(/<(div|p|span|h[1-6]|li|a)\b[^>]*opacity:\s*0?\.\d+[^>]*>\s*\{?[A-Za-z{]/g)].map((x) => x[0].slice(0, 90));
  assert.deepStrictEqual(dimmedText, []);
});

console.log(`\n${passed} passed`);
