/**
 * The message catalogue: what a buyer reads for each refusal.
 * Run: `node client/src/utils/messageCatalogue.test.js`
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalogue } from './messageCatalogue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'brand.json'), 'utf8'));
const cat = createCatalogue(brand, { quoteTurnaround: '24 hours' });

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log('Message catalogue');

// Words a customer should never be shown (the brief), and the developer phrases they come with.
const NEVER = /\b(bot|robot|token|csrf|rate.?limit(ed)?|payload|invalid|json|jwt|http|401|403|429|500|null|undefined|exception|stack)\b/i;

test('no message uses developer language, blames the buyer, or ends without a full stop', () => {
  for (const row of cat.table()) {
    assert.ok(!NEVER.test(row.text), `${row.code} (${row.where}): "${row.text}"`);
    assert.ok(!/\byou (failed|must|entered (an? )?(wrong|bad)|did not|didn't)\b/i.test(row.text), `${row.code} blames the buyer: "${row.text}"`);
    assert.ok(/[.?"]$/.test(row.text), `${row.code} (${row.where}) ends mid-sentence: "${row.text}"`);
    assert.ok(row.text.length >= 30 && row.text.length <= 420, `${row.code} (${row.where}) is ${row.text.length} characters`);
  }
});

test('where the automated path is closed, the message gives a person to reach', () => {
  const closed = ['human-check-unavailable', 'storage-full', 'daily-upload-limit', 'form-token-missing', 'not-open'];
  const reach = (t) => t.includes(brand.phone) || t.includes(brand.email);
  for (const code of closed) assert.ok(reach(cat.describe({ status: 400, code }).message), code);
  for (const context of ['login', 'register', 'reset', 'form', 'upload', 'drawing']) assert.ok(reach(cat.describe({ status: 429, code: 'rate-limited', context }).message), `rate-limited in ${context}`);
  for (const status of [500, 503]) for (const context of ['*', 'checkout', 'upload']) assert.ok(reach(cat.describe({ status, context }).message), `HTTP ${status} in ${context}`);
});

test('a code is worded for the place it happened', () => {
  const login = cat.describe({ status: 429, code: 'rate-limited', context: 'login' }).message;
  const form = cat.describe({ status: 429, code: 'rate-limited', context: 'rfq' }).message;
  assert.ok(/sign-in/.test(login) && !/sign-in/.test(form) && /not sent/.test(form));
  assert.ok(/recovery code/.test(cat.describe({ status: 401, code: 'two-factor-invalid', context: 'recovery-code' }).message));
  assert.ok(/30 seconds/.test(cat.describe({ status: 401, code: 'two-factor-invalid', context: 'login' }).message));
  assert.strictEqual(cat.contextFor('/auth/login', 'POST'), 'login');
  assert.strictEqual(cat.contextFor('/rfq', 'POST'), 'rfq');
  assert.strictEqual(cat.contextFor('/rfq/quote/abc/accept', 'POST'), 'firm-quote');
  assert.strictEqual(cat.contextFor('/orders/checkout-session', 'POST'), 'checkout');
  assert.strictEqual(cat.contextFor('/quote/abc/drawing', 'POST'), 'drawing');
  assert.strictEqual(cat.contextFor('/quote', 'POST'), 'quote');
  assert.strictEqual(cat.contextFor('/upload', 'POST'), 'upload');
  assert.strictEqual(cat.contextFor('/auth/verify-email/resend', 'POST'), 'resend');
});

test('a pause says how long, from the server\'s own number', () => {
  const m = cat.describe({ status: 429, code: 'account-locked', data: { retryAfterSeconds: 15 * 60 } });
  assert.ok(m.message.includes('paused for 15 minutes'), m.message);
  assert.strictEqual(m.action, 'reset');
  assert.ok(cat.describe({ status: 429, code: 'account-locked', data: { retryAfterSeconds: 50 } }).message.includes('paused for 1 minute,'));
  assert.ok(cat.describe({ status: 429, code: 'account-locked', data: {} }).message.includes('a few minutes'));
});

test('a server sentence that names a count, a size or a date is kept; a developer sentence never is', () => {
  const dense = 'This model has 612,000 triangles, more than the instant quote reads (500,000). Export it at a coarser resolution and upload again, or send it to us for a firm quote.';
  const kept = cat.describe({ status: 200, code: 'model-too-large', serverMessage: dense, context: 'upload' });
  assert.strictEqual(kept.message, dense);
  assert.strictEqual(kept.action, 'rfq');
  assert.ok(cat.describe({ status: 413, code: 'file-too-large', serverMessage: 'That file is over 50 MB, the most the instant quote reads.', context: 'upload' }).message.includes('over 50 MB'));
  assert.ok(cat.describe({ status: 400, code: 'too-many-files', serverMessage: 'Upload up to 10 part files at a time.', context: 'upload' }).message.includes('up to 10 at a time'));
  for (const dev of ['Authentication required', 'Invalid or expired token', 'Access denied', 'Quote not found', 'Failed to create checkout session', 'Internal server error', 'Too many requests, please try again later.', 'Upload limit reached. Please try again later.', 'Registration failed', 'Payment processing is not configured', 'The request body isn\'t valid JSON.', 'Send this request as JSON.', 'Request failed: 502']) {
    assert.ok(cat.isDeveloperText(dev), `"${dev}" is developer text`);
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const said = cat.describe({ status, serverMessage: dev, context: 'checkout' }).message;
      assert.ok(said !== dev && !NEVER.test(said), `${status} "${dev}" → "${said}"`);
    }
  }
  const human = 'Add the full ship-to address';
  assert.strictEqual(cat.describe({ status: 400, serverMessage: human, context: 'firm-quote' }).message, human, 'a sentence already written for the buyer passes through');
});

test('a refused field is named in the buyer\'s words; an unknown field still reads as a sentence', () => {
  assert.ok(cat.describe({ status: 400, code: 'field-single-line', data: { field: 'poNumber' } }).message.startsWith('The purchase order number has to be one line.'));
  assert.ok(cat.describe({ status: 400, code: 'field-too-long', data: { field: 'notes', max: 2000 } }).message.includes('(2000 characters at most)'));
  assert.ok(cat.describe({ status: 400, code: 'field-required', data: { field: 'shippingZip' } }).message.startsWith('The ZIP code is needed.'));
  assert.ok(cat.describe({ status: 400, code: 'field-invalid', data: { field: 'somethingNew' } }).message.startsWith('One of the fields can\'t be used as typed.'));
  assert.ok(cat.describe({ status: 400, code: 'field-invalid' }).message.startsWith('One of the fields'));
});

test('a changed quote says nothing was accepted or charged, and gives the new price when the server sends it', () => {
  const m = cat.describe({ status: 409, code: 'quote-changed', data: { quotedTotal: 4250 }, context: 'firm-quote' });
  assert.ok(m.message.includes('nothing was accepted and nothing was charged') && m.message.includes('The price is now $4,250.00.'), m.message);
  assert.strictEqual(m.action, 'reload');
  assert.ok(!cat.describe({ status: 409, code: 'quote-changed', context: 'firm-quote' }).message.includes('The price is now'));
});

test('a code this file has never heard of still reads well: the server\'s sentence if it is a buyer\'s sentence, else the plain one for the status', () => {
  const said = 'Upload this part again: we no longer hold its measurements.';
  assert.strictEqual(cat.describe({ status: 409, code: 'something-new', serverMessage: said, context: 'quote' }).message, said);
  for (const [status, context] of [[400, 'quote'], [409, 'checkout'], [413, 'upload'], [422, 'quote'], [429, 'upload'], [500, 'checkout'], [502, 'order'], [503, 'upload'], [504, 'quote']]) {
    for (const serverMessage of ['', 'Invalid configuration payload', 'Request failed: 503']) {
      const m = cat.describe({ status, code: 'something-new', serverMessage, context }).message;
      assert.ok(m.length > 40 && /[.?]$/.test(m) && !NEVER.test(m), `${status} ${context}: "${m}"`);
    }
  }
});

test('order states are worded once: under review, refunded, partly refunded, disputed, expired, cancelled', () => {
  const rows = cat.orderStateTable();
  assert.deepStrictEqual(rows.map((r) => r.state), ['payment-under-review', 'expired', 'refunded', 'partially-refunded', 'disputed', 'cancelled']);
  for (const r of rows) assert.ok(!NEVER.test(r.text) && /[.]$/.test(r.text), `${r.state}: ${r.text}`);
  assert.ok(cat.orderState('refunded', { amount: 414.22 }).includes('$414.22 went back to the card'));
  assert.ok(cat.orderState('partially-refunded', { amount: 60 }).startsWith('We refunded $60.00 of this order'));
  assert.ok(cat.orderState('payment-under-review', { email: 'dana@buyer.test' }).includes('write to dana@buyer.test'));
  assert.strictEqual(cat.orderState('paid'), '', 'a state that needs no explaining has no sentence');
});

test('no answer from the server (offline) reads as that, and keeps the buyer\'s work', () => {
  const m = cat.describe({ status: 0, context: 'rfq' }).message;
  assert.ok(/couldn't reach/.test(m) && /still here/.test(m), m);
});

test('the admin screens keep the server\'s own sentence', () => {
  assert.strictEqual(cat.describe({ status: 400, serverMessage: 'slug may only contain lowercase letters, digits and dashes', context: 'admin' }).message, 'slug may only contain lowercase letters, digits and dashes');
});

// Not a failure: a note for whoever adds a code on the server. A code with no entry keeps the server's sentence.
const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'testSupport' || e.name === 'fixtures') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) sources.push(p);
  }
}(path.join(root, 'server', 'routes')));
for (const f of ['security', 'parsers', 'middleware'].map((d) => path.join(root, 'server', d))) {
  for (const e of fs.readdirSync(f)) if (e.endsWith('.js') && !e.endsWith('.test.js')) sources.push(path.join(f, e));
}
const sent = new Set();
for (const f of sources) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bcode:\s*"([a-z0-9-]+)"/g)) sent.add(m[1]);
const unlisted = [...sent].filter((c) => !cat.codes.includes(c)).sort();
console.log(`  note ${sent.size} refusal codes found in server/routes, security, parsers and middleware; ${unlisted.length} have no entry and show the server's sentence: ${unlisted.join(', ') || 'none'}`);

console.log(`\n${passed} passed`);
