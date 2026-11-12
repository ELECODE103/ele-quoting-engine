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

// (merge 2026-11-12) The server no longer sends `account-locked` (the per-address lock is gone; review F4). The pause a
// buyer can meet now is `try-later` (this connection, after several wrong passwords) and it carries the same number.
test('a pause says how long, from the server\'s own number', () => {
  const m = cat.describe({ status: 429, code: 'try-later', data: { retryAfterSeconds: 15 * 60 } });
  assert.ok(m.message.includes('paused for 15 minutes'), m.message);
  assert.strictEqual(m.action, 'reset');
  assert.ok(cat.describe({ status: 429, code: 'try-later', data: { retryAfterSeconds: 50 } }).message.includes('paused for 1 minute,'));
  assert.ok(cat.describe({ status: 429, code: 'try-later', data: {} }).message.includes('a few minutes'));
  assert.ok(cat.describe({ status: 429, code: 'two-factor-paused', data: { retryAfterSeconds: 4 * 60 } }).message.includes('paused for 4 minutes'));
  assert.ok(!cat.codes.includes('account-locked'), 'the lock that no longer exists has no entry');
  // Nothing an outsider does locks the owner out: the message for a busy address says how the owner still gets in.
  const busy = cat.describe({ status: 429, code: 'account-busy', data: { retryAfterSeconds: 600 } });
  assert.ok(/a browser you have used before/.test(busy.message) && /Nobody got in/.test(busy.message) && busy.action === 'reset', busy.message);
});

test('the price-integrity refusals: each says what was not priced and what to change, and never charges in silence', () => {
  const selectors = ['process-not-offered', 'material-not-offered', 'material-process-mismatch', 'grade-not-offered', 'sub-process-not-offered', 'thickness-required', 'thickness-not-offered',
    'finish-not-offered', 'finish-not-for-material', 'layer-height-not-offered', 'infill-out-of-range', 'quantity-invalid', 'lead-time-not-offered'];
  for (const code of selectors) {
    const m = cat.describe({ status: 400, code, context: 'quote' });
    assert.strictEqual(m.source, 'catalogue', code);
    assert.ok(/\b(pick|choose|change|correct)\b/i.test(m.message), `${code} says what to change: "${m.message}"`);
  }
  // A developer's sentence from the server never shows ("Invalid lead time").
  assert.ok(!/invalid/i.test(cat.describe({ status: 400, code: 'lead-time-not-offered', serverMessage: 'Invalid lead time', context: 'quote' }).message));
  // Where the server names the finish and the material, or the range, its sentence is the one shown.
  assert.strictEqual(cat.describe({ status: 400, code: 'finish-not-for-material', serverMessage: 'Polished edges isn\'t done on UHMW. Pick another finish.', context: 'quote' }).message, 'Polished edges isn\'t done on UHMW. Pick another finish.');
  assert.ok(cat.describe({ status: 400, code: 'quantity-invalid', serverMessage: 'Enter a whole number of pieces, from 1 to 1,000,000.', context: 'quote' }).message.includes('1,000,000'));
  // Faults on our side say so, and give the firm-quote route and the phone.
  for (const code of ['material-unavailable', 'pricing-unavailable', 'price-check-failed']) {
    const m = cat.describe({ status: 409, code, context: 'quote' });
    assert.ok(m.action === 'rfq' && m.message.includes(brand.phone), `${code}: "${m.message}"`);
  }
  assert.ok(/not charged/.test(cat.describe({ status: 409, code: 'price-check-failed', context: 'checkout' }).message));
});

test('checkout refusals from the fixes: changed price, quote used, quote out of date, too many tries — each says nothing was charged and where to go', () => {
  const changed = cat.describe({ status: 409, code: 'quote-changed', data: { previousTotal: 706.78, newTotal: 2162.21, reopen: true }, context: 'checkout' });
  assert.ok(changed.message.includes('It was $706.78 and is now $2,162.21.') && /not charged/.test(changed.message), changed.message);
  assert.strictEqual(changed.action, 'reopen-quote');
  assert.ok(!cat.describe({ status: 409, code: 'quote-changed', data: {}, context: 'checkout' }).message.includes('It was'));
  // The firm-quote page keeps its own wording for the same code.
  assert.strictEqual(cat.describe({ status: 409, code: 'quote-changed', context: 'firm-quote' }).action, 'reload');
  const used = cat.describe({ status: 409, code: 'quote-already-ordered', data: { orderId: 'o1' }, context: 'checkout' });
  assert.ok(used.action === 'open-order' && /Nothing was charged/.test(used.message) && /Reorder/.test(used.message), used.message);
  const stale = cat.describe({ status: 409, code: 'quote-needs-update', context: 'checkout' });
  assert.ok(stale.action === 'reopen-quote' && /not charged/.test(stale.message));
  const many = cat.describe({ status: 429, code: 'checkout-rate-limited', context: 'checkout' });
  assert.ok(/Nothing was charged/.test(many.message) && many.message.includes(brand.phone), many.message);
  for (const code of ['payments-unavailable', 'card-unavailable', 'payment-session-busy']) assert.ok(/[Nn]othing was charged/.test(cat.describe({ status: 503, code, context: 'checkout' }).message), code);
});

test('no new message promises when: no reply time, no "today", no bank timing in days', () => {
  const fromTheFixes = ['try-later', 'account-busy', 'two-factor-paused', 'setup-refused', 'process-not-offered', 'material-not-offered', 'material-process-mismatch', 'grade-not-offered',
    'sub-process-not-offered', 'thickness-required', 'thickness-not-offered', 'finish-not-offered', 'finish-not-for-material', 'layer-height-not-offered', 'infill-out-of-range', 'quantity-invalid',
    'lead-time-not-offered', 'part-not-found', 'material-unavailable', 'pricing-unavailable', 'price-check-failed', 'quote-needs-update', 'quote-already-ordered', 'checkout-rate-limited',
    'price-required', 'quoted-total-invalid', 'config-invalid', 'payment-session-busy', 'order-not-payable', 'payments-unavailable', 'card-unavailable', 'method-required', 'address-required',
    'quote-changed', 'quote-not-payable', 'quote-accepted', 'po-number-required', 'po-number-invalid', 'return-link-invalid', 'confirm-failed', 'order-not-found', 'transition-not-allowed',
    'reason-required', 'status-unknown', 'field-single-line', 'field-too-long', 'field-invalid', 'field-required'];
  // ("today's price" is the price as of now, not a promise of when; "today" on its own is.)
  const PROMISE = /\b(today(?!'s)|tomorrow|within \d|within (an?|one|two|24)\b|business days?|\d+ (hours?|days?)|same day|right away|straight away|immediately)\b/i;
  const SHOP = /\b(one[- ]person|small shop|our team of|ISO ?\d|AS9100|CMM)\b/i;
  for (const code of fromTheFixes) {
    assert.ok(cat.codes.includes(code), `${code} has an entry`);
    for (const row of cat.table().filter((r) => r.code === code)) {
      assert.ok(!PROMISE.test(row.text), `${code} (${row.where}) promises a time: "${row.text}"`);
      assert.ok(!SHOP.test(row.text), `${code} (${row.where}): "${row.text}"`);
    }
  }
  for (const r of [...cat.orderStateTable(), ...cat.gateReasonTable()]) {
    assert.ok(!PROMISE.test(r.text) && !SHOP.test(r.text), `${r.state || r.code}: "${r.text}"`);
    assert.ok(!NEVER.test(r.text) && /[.]$/.test(r.text), `${r.state || r.code}: "${r.text}"`);
  }
});

test('why a quote goes to a person: the server\'s sentence (it has the numbers), or the catalogue\'s when there is none', () => {
  const said = '620 pieces in one order is over our 500-piece instant-order limit — production runs are quoted by a person';
  assert.strictEqual(cat.gateReason({ code: 'order-quantity', message: said }), said);
  for (const code of ['order-quantity', 'big-ticket-order', 'stock-thinner-than-model']) {
    assert.ok(cat.gateReasonCodes.includes(code));
    assert.ok(/firm quote/.test(cat.gateReason({ code })), code);
  }
  assert.ok(cat.gateReason({ code: 'something-new' }).length > 30);
  assert.ok(cat.gateReason(null).length > 30);
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
  // Relaunch merge: after the order-lifecycle fixes a link whose quote was edited and not sent again opens nothing
  // (server/routes/rfq.js answers `linkReplaced`). The page shows no quote then, so the wording must not point at
  // "the details below": it says the link is dead, that nothing was accepted or charged, and where the new one is.
  const dead = cat.describe({ status: 409, code: 'quote-changed', data: { linkReplaced: true }, context: 'firm-quote' }).message;
  assert.ok(/changed after this link was sent/.test(dead) && dead.includes('Nothing was accepted and nothing was charged') && /newest email/.test(dead) && dead.includes('224-213-6727'), dead);
  assert.ok(!/below|accept again|Reload/.test(dead), dead);
  // A stale page (the total on screen is no longer the quote's) is sent back to the page itself, not to "details below".
  const stale = cat.describe({ status: 409, code: 'quote-changed', context: 'firm-quote' }).message;
  assert.ok(/Reload this page/.test(stale) && !/details below/.test(stale), stale);
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
  assert.deepStrictEqual(rows.map((r) => r.state), ['payment-under-review', 'expired', 'awaiting-po', 'refunded', 'partially-refunded', 'disputed', 'cancelled']); // + awaiting-po (merge 2026-11-12)
  assert.ok(cat.orderState('awaiting-po', { poNumber: 'PO-3310' }).includes('PO-3310') && /Nothing has been charged/.test(cat.orderState('awaiting-po')));
  assert.ok(/quote email/.test(cat.orderState('expired', { firmQuote: true })) && /Your quote is still there/.test(cat.orderState('expired')));
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

// Every refusal code the server can send has an entry here. (This was a note printed at the end; since the merge of
// the two fix branches it is a test, so the next branch that adds a code adds its words in the same change.)
// Codes that are not refusals a buyer reads are named below, with what they are.
const NOT_REFUSALS = {
  // why a quote goes to a person (gate.reasons[].code): worded by the server with its numbers; see gateReason
  quantity: 'gate reason', 'big-ticket': 'gate reason', 'dfm-fail': 'gate reason', envelope: 'gate reason', 'turning-review': 'gate reason',
  'complex-geometry': 'gate reason', 'legacy-features': 'gate reason', 'thin-wall': 'gate reason',
  'shipping-freight': 'gate reason (the order has no parcel price: worded by the server with the weight or size)',
  'order-quantity': 'gate reason (catalogue: gateReason)', 'big-ticket-order': 'gate reason (catalogue: gateReason)', 'stock-thinner-than-model': 'gate reason (catalogue: gateReason)',
  // Stripe webhook answers and the admin's payment flags: never shown to a buyer
  'no-order-id': 'webhook answer', 'late-payment': 'payment flag (admin)', 'payment-mismatch': 'payment flag (admin)', 'zero-payment': 'payment flag (admin)',
  'dispute-opened': 'payment event (admin)', 'dispute-closed': 'payment event (admin)',
  // why no automatic email went out for a request (`noEmailReason`): the page has its own words for these two
  'account-unconfirmed': 'noEmailReason', 'daily-limit': 'noEmailReason',
  // the owner's clean-up actions (routes/adminStorage.js): admin screens show the server's own sentence
  'not-found': 'admin (delete a request)', 'request-has-order': 'admin (delete a request)',
  // start-up log lines about the owner's one-time setup code (security/adminAccount.js): never an answer to a request
  'code-too-short': 'start-up log (operator)', 'code-too-simple': 'start-up log (operator)',
  // inside the server: logged, or turned into one of the codes above before it is answered
  'process-unknown': 'internal (answered as process-not-offered)', 'pricing-input-missing': 'internal (answered as material-unavailable or pricing-unavailable)',
  'parts-or-setup-changed': 'internal (why a quote was re-priced; logged)', 'price-moved-too-far': 'internal (why a quote was re-priced; logged)',
};
test('every refusal code the server can send is worded here, or is named as something a buyer never reads', () => {
  const sources = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'testSupport', 'fixtures', 'geometry', 'emails', 'ops'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) sources.push(p);
    }
  }(path.join(root, 'server')));
  // (second integration pass) plus the ways the availability work writes a code: poolError("parse-memory", 422, …),
  // refusal("geometry-out-of-range"), fail("geometry-not-measurable"), unavailable("preview-unavailable"), and the keys
  // of a MESSAGES map ("too-thin-to-print": `…`).
  const patterns = [/\b(?:poolError|refusal|fail|unavailable)\(\s*"([a-z0-9]+-[a-z0-9-]+)"/g, /^\s*"([a-z0-9]+-[a-z0-9-]+)":\s*`/gm, /\bcode:\s*"([a-z0-9][a-z0-9-]+)"/g, /\b(?:Refusal|refusal|fail|refuse)\(\s*\d+,\s*"([a-z0-9-]+)"/g, /\bbad\(\s*"([a-z0-9-]+)"/g,
    /code:[^,\n]*\?\s*"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"/g, /code\s*=\s*"([a-z0-9]+-[a-z0-9-]+)"/g, /\?\s*"([a-z0-9]+-[a-z0-9-]+)"\s*:\s*"([a-z0-9]+-[a-z0-9-]+)"/g];
  const sent = new Map();
  for (const f of sources) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) for (const c of m.slice(1)) if (c) sent.set(c, path.relative(root, f));
  }
  assert.ok(sent.size >= 90, `found ${sent.size} codes: the scan is reading the server`);
  const unlisted = [...sent.keys()].filter((c) => !cat.codes.includes(c) && !Object.prototype.hasOwnProperty.call(NOT_REFUSALS, c)).sort();
  assert.deepStrictEqual(unlisted, [], `codes with no words in the catalogue: ${unlisted.map((c) => `${c} (${sent.get(c)})`).join(', ')}`);
  for (const c of Object.keys(NOT_REFUSALS)) assert.ok(!cat.codes.includes(c), `${c} is listed as "not a refusal" and also has an entry`);
  for (const c of ['order-quantity', 'big-ticket-order', 'stock-thinner-than-model']) assert.ok(cat.gateReasonCodes.includes(c));
  console.log(`       (${sent.size} codes found in the server; ${cat.codes.length} worded here; ${Object.keys(NOT_REFUSALS).length} named as not buyer refusals)`);
});

// ─── The refusals the availability work added (second integration pass, 2026-11-12) ───
// Each is worded for every place it can arrive: the quote tool (pricing, upload), the order page (Reorder), checkout,
// the account pages. The answers below are the server's own, as it sends them.
test('every refusal the availability work added reads as a sentence with a way on, wherever it arrives', () => {
  const say = (code, context, data = {}, status = 429) => cat.describe({ status, code, context, data: { code, ...data }, serverMessage: data.error || '' });
  const places = { quote: 'quote', upload: 'upload', reorder: cat.contextFor('/orders/abc/reorder', 'POST'), checkout: cat.contextFor('/orders/checkout-session', 'POST') };
  assert.deepStrictEqual([places.reorder, places.checkout], ['order', 'checkout']);
  const cases = [
    // code, where it can arrive, the server's extra fields, something the sentence must say
    ['pricing-budget', ['quote', 'reorder', 'checkout'], { retryAfterSeconds: 1500, offerRfq: true }, /about 25 minutes/],
    ['pricing-busy', ['quote', 'reorder'], { retryAfterSeconds: 5 }, /few seconds/],
    ['pricing-in-progress', ['quote', 'reorder'], { retryAfterSeconds: 3 }, /few seconds/],
    ['quote-too-slow', ['quote', 'reorder'], { offerRfq: true }, /person prices it/],
    ['reprice-limit', ['quote'], { retryAfterSeconds: 240 }, /about 4 minutes/],
    ['quote-limit', ['quote', 'reorder'], { retryAfterSeconds: 3000 }, /about 50 minutes/],
    ['drafts-full', ['quote'], { scope: 'network', retryAfterSeconds: 600 }, /sign in to save more/],
    ['drafts-full', ['quote', 'reorder'], { scope: 'account' }, /Your account holds as many saved quotes/],
    ['quotes-paused', ['quote'], {}, /Sign in, or create an account/],
    ['uploads-paused', ['upload'], {}, /Sign in, or create an account/],
    ['stored-limit', ['upload'], { scope: 'network', error: "You've reached what we keep for one network at a time (150 MB of files). Files…" }, /one network at a time \(150 MB of files\)/],
    ['stored-limit', ['upload'], { scope: 'account', error: 'Your account has reached what we keep for one account at a time (150 MB of files). Files…' }, /Your account has reached .* \(150 MB of files\)/],
    ['parse-budget', ['upload'], { offerRfq: true }, /person quotes them/],
    ['parse-memory', ['upload'], { offerRfq: true }, /coarser resolution/],
    ['not-read', ['upload'], {}, /upload it by itself/],
    ['file-padded', ['upload'], { offerRfq: true }, /Export it again/],
    ['nested-shells', ['upload'], { offerRfq: true }, /one closed shape inside another/],
    ['too-thin-to-print', ['quote'], { offerRfq: true }, /Thicken it/],
    ['geometry-not-measurable', ['upload', 'quote'], { offerRfq: true }, /couldn't measure this model/],
    ['geometry-out-of-range', ['upload', 'quote'], { offerRfq: true }, /export units/],
    ['geometry-too-small', ['upload', 'quote'], { offerRfq: true }, /export units/],
    ['busy', ['upload'], { retryAfterSeconds: 60 }, /give it a minute and try again/],
    ['part-file-missing', ['checkout'], {}, /have not charged you/],
    ['requests-paused', ['rfq'], {}, /this one was not sent/],
  ];
  for (const [code, where, data, must] of cases) {
    assert.ok(cat.codes.includes(code), `${code} has an entry`);
    for (const place of where) {
      const said = say(code, places[place] || place, data);
      assert.strictEqual(said.source, 'catalogue', `${code} at ${place}: the words are the catalogue's`);
      assert.ok(must.test(said.message), `${code} at ${place}: "${said.message}"`);
      assert.ok(!NEVER.test(said.message) && /[.]$/.test(said.message) && said.message.length > 60, `${code} at ${place}: "${said.message}"`);
      assert.ok(!said.message.includes(code) && !/something went wrong/i.test(said.message), `${code} at ${place} never shows its code or a shrug`);
      // Copy rules: nothing about how many people work here, and no certification line.
      assert.ok(!/one[- ]person|one[- ]man|just me|sole|\bISO\b/i.test(said.message), `${code} at ${place}: "${said.message}"`);
    }
  }
  // A refusal that goes to a person offers the firm quote; one that passes by itself offers a retry.
  for (const code of ['pricing-budget', 'quote-too-slow', 'reprice-limit', 'nested-shells', 'too-thin-to-print', 'geometry-not-measurable', 'stored-limit', 'parse-budget']) assert.strictEqual(say(code, 'quote').action, 'rfq', code);
  for (const code of ['pricing-busy', 'pricing-in-progress']) assert.strictEqual(say(code, 'quote').action, 'retry', code);
  // At checkout nothing was charged, and the order page says nothing was changed.
  assert.ok(/have not charged you/.test(say('pricing-budget', 'checkout', { retryAfterSeconds: 600 }).message));
  for (const code of ['pricing-budget', 'pricing-busy', 'quote-too-slow', 'quote-limit', 'drafts-full']) assert.ok(/nothing was changed/.test(say(code, 'order', { scope: 'account' }).message), `${code} on the order page`);
  // "Send it again" refused per network keeps the server's sentence (it says which of three limits it was)…
  const resend = cat.describe({ status: 429, code: 'rate-limited', context: cat.contextFor('/auth/verify-email/resend', 'POST'), serverMessage: "We've sent several confirmation emails from this network in the last hour. Check the spam folder, and try again later; if it isn't arriving, call 224-213-6727." });
  assert.ok(/from this network in the last hour/.test(resend.message) && resend.source === 'server');
  // …and a confirmation email that is held, not refused, has a sentence of its own.
  assert.deepStrictEqual(cat.noticeKeys, ['verification-queued']);
  const held = cat.notice('verification-queued');
  assert.ok(/within the hour/.test(held) && /don't need to ask again/.test(held) && !NEVER.test(held), held);
  assert.strictEqual(cat.notice('no-such-notice'), '');
});

console.log(`\n${passed} passed`);
