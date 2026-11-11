/**
 * Row retention: abandoned uploads and lapsed draft quotes leave the database;
 * anything behind an order, an open RFQ or a live quote stays.
 * Run: `node server/services/rowRetention.test.js`
 */
const assert = require("assert");
const { plan, sweepRows } = require("./rowRetention");

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
      { id: "q-live", status: "draft", createdAt: daysAgo(20), expiresAt: inDays(10), lineItems: [{ partId: "p-live-quote" }], config: { parts: [{ partId: "p-live-quote-config" }] } },
      { id: "q-expired", status: "draft", createdAt: daysAgo(60), expiresAt: daysAgo(30), lineItems: [{ partId: "p-expired-quote" }] },
      { id: "q-old-no-expiry", status: "draft", createdAt: daysAgo(45), lineItems: [{ partId: "p-abandoned" }] },
      { id: "q-recent-no-expiry", status: "draft", createdAt: daysAgo(3), lineItems: [] },
      { id: "q-no-dates", status: "draft", lineItems: [] },
    ]),
  };
}

console.log("Row retention");

test("lapsed draft quotes go; ordered, RFQ, live and undated quotes stay", () => {
  const { expiredQuotes } = plan(fixture(), { now: NOW });
  assert.deepStrictEqual(expiredQuotes.sort(), ["q-expired", "q-old-no-expiry"]);
});

test("parts behind an order, an open RFQ or a live quote stay whatever their age", () => {
  const { staleParts } = plan(fixture(), { now: NOW });
  for (const id of ["p-ordered", "p-rfq-open", "p-live-quote", "p-live-quote-config"]) assert.ok(!staleParts.includes(id), id);
});

test("abandoned parts past the upload window go; recent and undated parts stay", () => {
  const { staleParts } = plan(fixture(), { now: NOW });
  assert.deepStrictEqual(staleParts.sort(), ["p-abandoned", "p-expired-quote", "p-rfq-lost"]);
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
  assert.deepStrictEqual({ quotes: r.quotes, parts: r.parts }, { quotes: 2, parts: 3 });
  assert.deepStrictEqual(calls, ["batch", "compact"]);
  assert.strictEqual(m.quotesDB.rows.length, 6);
  assert.strictEqual(m.partsDB.rows.length, 7);
  // nothing left to do the second time: no batch, no compact
  const again = sweepRows(m, { now: NOW, database });
  assert.deepStrictEqual({ quotes: again.quotes, parts: again.parts }, { quotes: 0, parts: 0 });
  assert.deepStrictEqual(calls, ["batch", "compact"]);
});

console.log(`\n${passed} checks passed`);
