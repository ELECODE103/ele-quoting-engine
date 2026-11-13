/**
 * Row retention: abandoned uploads and lapsed draft quotes leave the database;
 * anything behind an order, an open RFQ or a live quote stays.
 * Run: `node server/services/rowRetention.test.js`
 */
const assert = require("assert");
const { plan, sweepRows, references, unpaidOrderIsPayable, ORDER_OVER, ORDER_UNPAID, ORDER_HELD, AFTER_SESSION_MS, PAGE_OPENING_MS } = require("./rowRetention");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };
const NOW = Date.parse("2026-11-11T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();
const inDays = (n) => new Date(NOW + n * 864e5).toISOString();
const table = (rows) => ({ rows, getAll: () => rows, getById: (id) => rows.find((r) => r.id === id) || null, delete: (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); } });

function fixture() {
  return {
    partsDB: table([
      { id: "p-ordered", createdAt: daysAgo(200) },
      { id: "p-cancelled", createdAt: daysAgo(200) },
      { id: "p-rfq-open", createdAt: daysAgo(90) },
      { id: "p-rfq-lost", createdAt: daysAgo(90) },
      { id: "p-live-quote", createdAt: daysAgo(20) },
      { id: "p-live-quote-config", createdAt: daysAgo(20) },
      { id: "p-expired-quote", createdAt: daysAgo(60) },
      { id: "p-abandoned", createdAt: daysAgo(30) },
      { id: "p-today", createdAt: daysAgo(0.1) },
      { id: "p-no-date" },
      { id: "p-anon-today", createdAt: daysAgo(1) },
      { id: "p-anon-abandoned", createdAt: daysAgo(12) },
      { id: "p-anon-reopened", createdAt: daysAgo(12) },
      { id: "p-packed", createdAt: daysAgo(15) },
    ]),
    ordersDB: table([{ id: "o1", status: "paid", quoteId: "q-ordered" }, { id: "o2", status: "cancelled", quoteId: "q-cancelled" }]),
    orderItemsDB: table([{ id: "i1", orderId: "o1", partId: "p-ordered" }, { id: "i2", orderId: "o2", partId: "p-cancelled" }]),
    rfqsDB: table([
      { id: "r1", status: "quoted", quoteId: "q-rfq", parts: [{ partId: "p-rfq-open" }] },
      { id: "r2", status: "lost", parts: [{ partId: "p-rfq-lost" }] },
    ]),
    quotesDB: table([
      { id: "q-ordered", status: "ordered", createdAt: daysAgo(200), lineItems: [{ partId: "p-ordered" }] },
      { id: "q-cancelled", status: "draft", createdAt: daysAgo(200), expiresAt: daysAgo(170), lineItems: [{ partId: "p-cancelled" }] },
      { id: "q-rfq", status: "draft", createdAt: daysAgo(90), expiresAt: daysAgo(60), lineItems: [{ partId: "p-rfq-open" }] },
      // A signed-in customer's draft keeps its whole price hold.
      { id: "q-live", status: "draft", userId: "u1", createdAt: daysAgo(20), expiresAt: inDays(10), lineItems: [{ partId: "p-live-quote" }], config: { parts: [{ partId: "p-live-quote-config" }] } },
      { id: "q-expired", status: "draft", createdAt: daysAgo(60), expiresAt: daysAgo(30), lineItems: [{ partId: "p-expired-quote" }] },
      { id: "q-old-no-expiry", status: "draft", createdAt: daysAgo(45), lineItems: [{ partId: "p-abandoned" }] },
      { id: "q-recent-no-expiry", status: "draft", userId: "u1", createdAt: daysAgo(3), lineItems: [] },
      { id: "q-no-dates", status: "draft", lineItems: [] },
      // Drafts of visitors without an account (independent review 2026-11-11, H3):
      { id: "q-anon-today", status: "draft", createdAt: daysAgo(1), expiresAt: inDays(29), lineItems: [{ partId: "p-anon-today" }] },
      { id: "q-anon-abandoned", status: "draft", createdAt: daysAgo(3), expiresAt: inDays(27), lineItems: [{ partId: "p-anon-abandoned" }] },
      { id: "q-anon-repriced", status: "draft", createdAt: daysAgo(9), updatedAt: daysAgo(1), expiresAt: inDays(29), lineItems: [] },
      { id: "q-anon-reopened", status: "draft", createdAt: daysAgo(12), lastOpenedAt: daysAgo(10), expiresAt: inDays(18), lineItems: [{ partId: "p-anon-reopened" }] },
      // the lines stored compactly (models/quotesStore.js): the part ids are still found
      { id: "q-packed", status: "draft", userId: "u2", createdAt: daysAgo(15), expiresAt: inDays(15), lineItems: { $lines: 1, pool: [{ partId: "p-packed" }], use: [0, 0, 0] } },
    ]),
  };
}

console.log("Row retention");

test("lapsed draft quotes go; ordered, RFQ, live and undated quotes stay", () => {
  const { expiredQuotes } = plan(fixture(), { now: NOW });
  assert.deepStrictEqual(expiredQuotes.sort(), ["q-anon-abandoned", "q-expired", "q-old-no-expiry"]);
});

test("a no-account draft nobody opened again lapses 48 hours after it was last priced; one that was reopened, or belongs to an account, keeps its hold", () => {
  const { expiredQuotes, staleParts } = plan(fixture(), { now: NOW });
  assert.ok(expiredQuotes.includes("q-anon-abandoned"), "three days old, never reopened");
  for (const id of ["q-anon-today", "q-anon-repriced", "q-anon-reopened", "q-live", "q-recent-no-expiry", "q-packed"]) assert.ok(!expiredQuotes.includes(id), id);
  // the abandoned draft's part goes with the upload window; the reopened one's stays, and so does a part named only in packed lines
  assert.ok(staleParts.includes("p-anon-abandoned"));
  for (const id of ["p-anon-today", "p-anon-reopened", "p-packed"]) assert.ok(!staleParts.includes(id), id);
  // the window is a setting
  const strict = plan(fixture(), { now: NOW, anonDraftHours: 12 });
  assert.ok(strict.expiredQuotes.includes("q-anon-today"));
});

test("parts behind an order, an open RFQ or a live quote stay whatever their age", () => {
  const { staleParts } = plan(fixture(), { now: NOW });
  for (const id of ["p-ordered", "p-rfq-open", "p-live-quote", "p-live-quote-config"]) assert.ok(!staleParts.includes(id), id);
});

test("abandoned parts past the upload window go; recent and undated parts stay", () => {
  const { staleParts } = plan(fixture(), { now: NOW });
  assert.deepStrictEqual(staleParts.sort(), ["p-abandoned", "p-anon-abandoned", "p-expired-quote", "p-rfq-lost"]);
});

test("a cancelled order's quote is kept as the order's record, and its part too", () => {
  const { expiredQuotes, staleParts } = plan(fixture(), { now: NOW });
  assert.ok(!expiredQuotes.includes("q-cancelled"));
  assert.ok(!staleParts.includes("p-cancelled"));
});

test("sweepRows deletes exactly the plan, in one batch, then compacts", () => {
  const m = fixture();
  const calls = [];
  const database = { batch: (fn) => { calls.push("batch"); return fn(); }, compact: () => calls.push("compact"), fileSize: () => 1000 };
  const r = sweepRows(m, { now: NOW, database });
  assert.deepStrictEqual({ quotes: r.quotes, parts: r.parts }, { quotes: 3, parts: 4 });
  assert.deepStrictEqual(calls, ["batch", "compact"]);
  assert.strictEqual(m.quotesDB.rows.length, 10);
  assert.strictEqual(m.partsDB.rows.length, 10);
  // nothing left to do the second time: no batch, no compact
  const again = sweepRows(m, { now: NOW, database });
  assert.deepStrictEqual({ quotes: again.quotes, parts: again.parts }, { quotes: 0, parts: 0 });
  assert.deepStrictEqual(calls, ["batch", "compact"]);
});

// ─── Orders: every state the state machine can set, and an unpaid order for as long as it can be paid ───
// (second integration pass, 2026-11-12: availability-fixes' retention meets order-lifecycle's states)
const orderState = require("./orderState");
const HOUR = 3600e3;
const MINUTE = 60e3;
const at = (ms) => new Date(NOW + ms).toISOString();

test("every order state the state machine can set is decided here: over, unpaid, or held outright", () => {
  const decided = [...ORDER_OVER, ...ORDER_UNPAID, ...ORDER_HELD];
  assert.deepStrictEqual([...decided].sort(), [...orderState.STATES].sort(), "a state added to services/orderState.js must be placed in rowRetention.js too");
  assert.strictEqual(new Set(decided).size, decided.length, "and in one list only");
  assert.deepStrictEqual(ORDER_OVER, ["cancelled", "expired"]);
  assert.deepStrictEqual(ORDER_UNPAID, ["pending_payment"]);
  // What each state does to an order's part, with nothing else referring to it.
  for (const status of orderState.STATES) {
    const m = { partsDB: table([{ id: "p", createdAt: daysAgo(400) }]), ordersDB: table([{ id: "o", status, createdAt: daysAgo(400), stripeSessionId: "cs_1", sessionExpiresAt: daysAgo(399) }]), orderItemsDB: table([{ id: "i", orderId: "o", partId: "p" }]), rfqsDB: table([]), quotesDB: table([]) };
    const refs = references(m, { now: NOW });
    const held = refs.partsHard.has("p") ? "hard" : refs.partsProtected.has("p") ? "soft" : "none";
    const expected = ORDER_HELD.includes(status) ? "hard" : status === "pending_payment" ? "soft" : "none";
    assert.strictEqual(held, expected, `${status}, a year old with a payment page long gone: ${held}`);
  }
  // A state this file has never heard of is held outright, never dropped.
  const unknown = { partsDB: table([{ id: "p", createdAt: daysAgo(400) }]), ordersDB: table([{ id: "o", status: "some_new_state", createdAt: daysAgo(400) }]), orderItemsDB: table([{ id: "i", orderId: "o", partId: "p" }]), rfqsDB: table([]), quotesDB: table([]) };
  assert.ok(references(unknown, { now: NOW }).partsHard.has("p"));
});

// (2026-11-13, re-review F-12.) This case used to assert "never less than 48 hours from creation, whatever the
// payment page says" and "an order with no payment page holds its files for good". Those two rules were the
// finding: thirteen accounts that pressed pay and never paid held the whole file store. An unpaid order now
// holds its files outright only while it can really still be paid, on the same clock as its payment page.
test("an unpaid order holds its files outright only while it can still be paid: its payment page, a resumed page, a phone order, a flagged payment", () => {
  const o = (over) => ({ created_at: at(-72 * HOUR), stripe_session_id: "cs_1", payment_method: "card", ...over });
  // The page is still open, although the order is three days old (the buyer keeps coming back to the same order).
  assert.strictEqual(unpaidOrderIsPayable(o({ session_expires_at: at(90 * MINUTE) }), NOW), true, "a page that is still payable");
  assert.strictEqual(unpaidOrderIsPayable(o({ session_expires_at: at(-1 * MINUTE) }), NOW), true, "a page that ran out a minute ago: the payment may still be arriving");
  assert.strictEqual(unpaidOrderIsPayable(o({ session_expires_at: at(-AFTER_SESSION_MS + MINUTE) }), NOW), true);
  assert.strictEqual(unpaidOrderIsPayable(o({ session_expires_at: at(-AFTER_SESSION_MS - MINUTE) }), NOW), false, "past the page and the time the server takes to close the order");
  // No floor of 48 hours any more: an order made three hours ago whose page closed two hours ago is past paying.
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-3 * HOUR), stripe_session_id: "cs_1", payment_method: "card", session_expires_at: at(-2 * HOUR) }, NOW), false, "the same clock as an order that has expired");
  // A long payment page (CHECKOUT_SESSION_MINUTES can be 24 h) is honoured for as long as it is open.
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-3 * HOUR), stripe_session_id: "cs_1", payment_method: "card", session_expires_at: at(21 * HOUR) }, NOW), true);
  // A page made before expiries were recorded: Stripe's own 24 hours.
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-23 * HOUR), stripe_session_id: "cs_old" }, NOW), true);
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-25 * HOUR - AFTER_SESSION_MS), stripe_session_id: "cs_old" }, NOW), false);
  // No payment page and not a card checkout: an order the owner took by phone, paid by cheque or wire when it arrives. Held until the owner settles it.
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-90 * 24 * HOUR) }, NOW), true, "a phone order, ninety days old");
  // A CARD checkout that never got a payment page: for the few minutes one may still be on its way, and no longer.
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-2 * MINUTE), payment_method: "card" }, NOW), true, "its page is being opened");
  assert.strictEqual(unpaidOrderIsPayable({ created_at: at(-PAGE_OPENING_MS - MINUTE), payment_method: "card" }, NOW), false, "a card checkout with no page is not a way to hold files");
  // A payment the owner has to look at (late, duplicate, mismatched): held until it is resolved.
  assert.strictEqual(unpaidOrderIsPayable(o({ session_expires_at: at(-60 * HOUR), attention: "late-payment" }), NOW), true);
  // No usable date: left alone.
  assert.strictEqual(unpaidOrderIsPayable({ stripe_session_id: "cs_1" }, NOW), true);

  // And through references(): the same order, hard while payable and soft after.
  const model = (order) => ({ partsDB: table([{ id: "p", createdAt: daysAgo(5) }]), ordersDB: table([{ id: "o", status: "pending_payment", paymentMethod: "card", ...order }]), orderItemsDB: table([{ id: "i", orderId: "o", partId: "p" }]), rfqsDB: table([]), quotesDB: table([]) });
  const open = references(model({ createdAt: at(-72 * HOUR), stripeSessionId: "cs_1", sessionExpiresAt: at(30 * MINUTE) }), { now: NOW });
  assert.ok(open.partsHard.has("p"), "resumed: three days old, page open");
  const lapsed = references(model({ createdAt: at(-3 * HOUR), stripeSessionId: "cs_1", sessionExpiresAt: at(-2 * HOUR) }), { now: NOW });
  assert.ok(!lapsed.partsHard.has("p") && lapsed.partsProtected.has("p"), "abandoned three hours ago: held softly, so a scheduled sweep keeps it and only pressure beyond the holder's share clears it");
  const phone = references(model({ createdAt: at(-90 * 24 * HOUR), paymentMethod: "" }), { now: NOW });
  assert.ok(phone.partsHard.has("p"), "a phone order awaiting its cheque");
  const pageless = references(model({ createdAt: at(-1 * HOUR) }), { now: NOW });
  assert.ok(!pageless.partsHard.has("p") && pageless.partsProtected.has("p"), "a card checkout that never got a payment page: softly, like the quote it came from");
  // What a pressure pass asks before it closes anything: "if these unpaid orders were closed, what would still be held outright?"
  const asked = references(model({ createdAt: at(-72 * HOUR), stripeSessionId: "cs_1", sessionExpiresAt: at(30 * MINUTE) }), { now: NOW, treatAsSoft: new Set(["o"]) });
  assert.ok(!asked.partsHard.has("p") && asked.partsProtected.has("p"));
});

console.log(`\n${passed} checks passed`);
