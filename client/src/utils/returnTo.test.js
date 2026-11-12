/**
 * Post-login destination + session quote id. Run: `node client/src/utils/returnTo.test.js`
 */
import assert from 'node:assert';
import { safeNext, nextFrom, destinationAfterAuth, authPath, sessionQuoteId, storedQuoteId, storeQuoteId, notePendingCheckout, pendingCheckout, saveCheckoutDraft, loadCheckoutDraft, clearCheckoutDraft } from './returnTo.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

console.log('Return-to destination');

test('a checkout path is kept, query string and all', () => {
  assert.strictEqual(safeNext('/checkout/3f0c7c1e-58a4-4d0b-9b57-5f0a4e7b9a11'), '/checkout/3f0c7c1e-58a4-4d0b-9b57-5f0a4e7b9a11');
  assert.strictEqual(safeNext('/quote?quote=abc'), '/quote?quote=abc');
});

test('anything that could leave the site is refused', () => {
  for (const bad of ['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', 'checkout/1', '', null, undefined, 42, '/ok\nSet-Cookie: x', '/a\\b', '/' + 'x'.repeat(600)]) {
    assert.strictEqual(safeNext(bad), null, `refused: ${String(bad).slice(0, 30)}`);
  }
});

test('never loops back to the auth pages', () => {
  assert.strictEqual(safeNext('/login'), null);
  assert.strictEqual(safeNext('/register?next=/x'), null);
  assert.strictEqual(safeNext('/login-help'), '/login-help');
});

test('?next= wins, router state still works, default is the quote builder', () => {
  assert.strictEqual(nextFrom({ search: '?next=%2Fcheckout%2Fabc', state: { from: '/dashboard' } }), '/checkout/abc');
  assert.strictEqual(nextFrom({ search: '', state: { from: '/checkout/xyz' } }), '/checkout/xyz');
  assert.strictEqual(nextFrom({ search: '?next=https%3A%2F%2Fevil.test', state: null }), null);
  assert.strictEqual(destinationAfterAuth({ search: '?next=https%3A%2F%2Fevil.test' }), '/quote');
  assert.strictEqual(destinationAfterAuth({ search: '?next=%2Fcheckout%2Fabc' }), '/checkout/abc');
});

test('the destination survives the hop from login to register and back', () => {
  const login = authPath('/login', '/checkout/abc?cancelled=true');
  assert.strictEqual(login, '/login?next=%2Fcheckout%2Fabc%3Fcancelled%3Dtrue');
  const onLogin = { search: login.slice('/login'.length) };
  const register = authPath('/register', nextFrom(onLogin));
  const onRegister = { search: register.slice('/register'.length) };
  assert.strictEqual(destinationAfterAuth(onRegister), '/checkout/abc?cancelled=true');
  assert.strictEqual(authPath('/register', null), '/register');
  assert.strictEqual(authPath('/register', '//evil.test'), '/register');
});

test('one quote id per session: created once, then reused', () => {
  const s = memoryStorage();
  assert.strictEqual(storedQuoteId(s), null);
  const a = sessionQuoteId(s);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(sessionQuoteId(s), a);
  assert.strictEqual(storedQuoteId(s), a);
  storeQuoteId('11111111-1111-4111-8111-111111111111', s);
  assert.strictEqual(sessionQuoteId(s), '11111111-1111-4111-8111-111111111111');
  storeQuoteId(null, s);
  assert.notStrictEqual(sessionQuoteId(s), a);
});

test('storage that throws (private mode) does not break quoting', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  assert.match(sessionQuoteId(broken), /^[0-9a-f-]{36}$/);
});

test('the checkout a browser was heading for is remembered across tabs, for a week, and only as a checkout path', () => {
  const s = memoryStorage();
  const path = '/checkout/3f0c7c1e-58a4-4d0b-9b57-5f0a4e7b9a11';
  assert.strictEqual(pendingCheckout(s), null);
  notePendingCheckout(path, s, 1000);
  assert.strictEqual(pendingCheckout(s, 2000), path);
  assert.strictEqual(pendingCheckout(s, 1000 + 8 * 24 * 3600 * 1000), null, 'forgotten after a week');
  for (const bad of ['https://evil.test/checkout/abc', '//evil.test', '/admin', '/checkout/../admin', '/checkout/abc?next=//evil.test', '']) {
    notePendingCheckout(bad, s);
    assert.strictEqual(pendingCheckout(s), null, bad);
  }
  s.setItem('straightedge.checkout', '{"path":"https://evil.test","at":' + Date.now() + '}');
  assert.strictEqual(pendingCheckout(s), null, 'a tampered value is not a destination');
  s.setItem('straightedge.checkout', 'not json');
  assert.strictEqual(pendingCheckout(s), null);
});

test('ship-to details typed at checkout come back for the same quote in the same tab, and only then', () => {
  const s = memoryStorage();
  const typed = { name: 'Dana Whitfield', street: '410 Industrial Dr', city: 'Rockford', state: 'IL', zip: '61109', country: 'US', card: '4242' };
  saveCheckoutDraft('quote-a', typed, s);
  assert.deepStrictEqual(loadCheckoutDraft('quote-a', s), { name: 'Dana Whitfield', street: '410 Industrial Dr', city: 'Rockford', state: 'IL', zip: '61109', country: 'US' });
  assert.strictEqual(loadCheckoutDraft('quote-b', s), null, 'another quote starts empty');
  clearCheckoutDraft(s);
  assert.strictEqual(loadCheckoutDraft('quote-a', s), null);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  saveCheckoutDraft('quote-a', typed, broken);
  assert.strictEqual(loadCheckoutDraft('quote-a', broken), null);
  clearCheckoutDraft(broken);
});

console.log(`\n${passed} passed`);
