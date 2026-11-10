/**
 * Ship-by date tests. Run: `node server/services/shipBy.test.js`
 */
const assert = require("assert");
const s = require("./shipBy");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
// A moment on the shop's clock (Central time). 2026-11 is CST (UTC-6), 2026-07 is CDT (UTC-5).
const cst = (date, hour = 9) => new Date(`${date}T${String(hour + 6).padStart(2, "0")}:00:00Z`);

console.log("Ship-by dates");

test("2026 federal holidays, observed dates", () => {
  const h = s.federalHolidays(2026);
  for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"]) {
    assert.ok(h.has(d), `${d} should be a holiday`);
  }
  assert.strictEqual(h.size, 11);
});

test("New Year's Day on a Saturday is observed the Friday before (Dec 31, 2021)", () => {
  assert.ok(s.federalHolidays(2021).has("2021-12-31"));
  assert.ok(!s.isBusinessDay("2021-12-31"));
});

test("a holiday on Sunday is observed Monday (July 4, 2027 → July 5)", () => {
  assert.ok(!s.isBusinessDay("2027-07-05"));
  assert.ok(s.isBusinessDay("2027-07-06"));
});

test("weekends are not business days", () => {
  assert.ok(!s.isBusinessDay("2026-11-14"));
  assert.ok(!s.isBusinessDay("2026-11-15"));
  assert.ok(s.isBusinessDay("2026-11-16"));
});

test("business days skip weekends", () => {
  // Mon Nov 16 + 5 → Mon Nov 23
  assert.strictEqual(s.addBusinessDays("2026-11-16", 5), "2026-11-23");
});

test("business days skip Veterans Day and Thanksgiving", () => {
  // Mon Nov 9 + 3: Tue 10, (Wed 11 holiday), Thu 12, Fri 13
  assert.strictEqual(s.addBusinessDays("2026-11-09", 3), "2026-11-13");
  // Wed Nov 25 + 1: (Thu 26 Thanksgiving) → Fri 27
  assert.strictEqual(s.addBusinessDays("2026-11-25", 1), "2026-11-27");
});

test("a weekend order starts counting on Monday", () => {
  assert.strictEqual(s.shipByDate(2, cst("2026-11-14")), "2026-11-17");
});

test("day count comes from the lead time's text, largest number wins", () => {
  assert.strictEqual(s.leadDays({ days: "7-10 business days" }), 10);
  assert.strictEqual(s.leadDays({ days: "3-5 business days" }), 5);
  assert.strictEqual(s.leadDays({ days: "Ships today (order by 10am)" }), 0);
  assert.strictEqual(s.leadDays({ days: "7-10 business days", daysMax: 8 }), 8);
  assert.strictEqual(s.leadDays(15), 15);
});

test("standard lead time from Mon Nov 9, 2026 lands on Tue Nov 24", () => {
  // 10 business days, Veterans Day skipped
  assert.strictEqual(s.shipByDate({ days: "7-10 business days" }, cst("2026-11-09")), "2026-11-24");
});

test("same-day ships today before the cutoff, next business day after it", () => {
  const lt = { days: "Ships today (order by 10am)" };
  assert.strictEqual(s.shipByDate(lt, cst("2026-11-09", 9)), "2026-11-09");
  assert.strictEqual(s.shipByDate(lt, cst("2026-11-09", 10)), "2026-11-10");
  assert.strictEqual(s.shipByDate(lt, cst("2026-11-13", 15)), "2026-11-16");
});

test("the shop's date is Central, not UTC", () => {
  // 03:00 UTC on Nov 10 is still 9 pm Nov 9 in Wauconda
  assert.strictEqual(s.shopNow(new Date("2026-11-10T03:00:00Z")).date, "2026-11-09");
  // Daylight time: 04:30 UTC July 2 is 11:30 pm July 1
  assert.strictEqual(s.shopNow(new Date("2026-07-02T04:30:00Z")).date, "2026-07-01");
});

test("ship-by never lands on a weekend or holiday across a year of order days", () => {
  let d = "2026-01-01";
  for (let i = 0; i < 365; i++) {
    for (const n of [0, 1, 2, 5, 10]) {
      const out = s.addBusinessDays(d, n);
      assert.ok(s.isBusinessDay(out), `${d} + ${n} → ${out}`);
    }
    d = s.addDays(d, 1);
  }
});

test("formats as a date a buyer can read", () => {
  assert.strictEqual(s.formatShipBy("2026-11-24"), "Tue, Nov 24, 2026");
});

console.log(`\n${passed} passed`);
