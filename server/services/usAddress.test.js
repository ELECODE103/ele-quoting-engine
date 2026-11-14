/**
 * ZIP code → state, and the ways a state is written (review of 2026-11-13, N-03).
 * Run: node server/services/usAddress.test.js
 */
const assert = require("assert");
const us = require("./usAddress");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
console.log("US addresses: ZIP code and state");

// One well-known ZIP code per state (its capital, mostly), the district, the territories and the
// three military "states". Every row of the table is hit at least once (checked below).
const KNOWN = {
  AL: ["36104", "35203", "36901"], AK: ["99801", "99501"], AZ: ["85001", "86001"], AR: ["72201", "71601"], CA: ["95814", "90012", "96161"],
  CO: ["80202", "81601"], CT: ["06103"], DE: ["19901", "19801"], DC: ["20001", "20500", "56901"], FL: ["32301", "33101", "34102", "34997"],
  GA: ["30303", "31401", "39815", "39901"], HI: ["96813", "96720"], ID: ["83702", "83814"], IL: ["62701", "60601", "62999"], IN: ["46204", "47901"],
  IA: ["50309", "52801"], KS: ["66603", "67901"], KY: ["40601", "42701"], LA: ["70802", "71101"], ME: ["04330", "03901"],
  MD: ["21401", "20601"], MA: ["02108", "01001", "05501"], MI: ["48933", "49931"], MN: ["55102", "56701"], MS: ["39201", "38601"],
  MO: ["65101", "63101"], MT: ["59601", "59901"], NE: ["68508", "69301"], NV: ["89701", "89101"], NH: ["03301", "03801"],
  NJ: ["08608", "07102"], NM: ["87501", "88001"], NY: ["12207", "10001", "00501", "14850"], NC: ["27601", "28801"], ND: ["58501", "58801"],
  OH: ["43215", "45999"], OK: ["73102", "74966", "73001"], OR: ["97301", "97914"], PA: ["17101", "19104", "15201"], RI: ["02903", "02840"],
  SC: ["29201", "29901"], SD: ["57501", "57701"], TN: ["37219", "38501"], TX: ["78701", "75201", "73301", "88510", "79901"], UT: ["84111", "84770"],
  VT: ["05602", "05001", "05901"], VA: ["23219", "20101", "24601"], WA: ["98501", "99201"], WV: ["25301", "24701", "26801"], WI: ["53703", "54990"],
  WY: ["82001", "83101"], PR: ["00901", "00601", "00950"], VI: ["00802"], GU: ["96910"], AE: ["09012", "09801"], AA: ["34002"], AP: ["96201", "96601"],
};

test("every state, DC, AK, HI, PR, VI, GU and the military prefixes: a known ZIP code is read as its state", () => {
  for (const s of us.STATES) if (!["AS", "MP"].includes(s.code)) assert.ok(KNOWN[s.code], `no test ZIP code for ${s.code}`);
  for (const [state, zips] of Object.entries(KNOWN)) {
    for (const zip of zips) assert.deepStrictEqual(us.statesOfZip(zip), [state], `${zip} should be ${state}`);
  }
  assert.deepStrictEqual(us.statesOfZip("96799"), ["AS"], "Pago Pago");
  assert.deepStrictEqual(us.statesOfZip("96950"), ["MP"], "Saipan");
});

test("every row of the prefix table is exercised by a known ZIP code, and the rows do not overlap", () => {
  const hit = new Set();
  for (const zips of Object.values(KNOWN)) for (const zip of zips) {
    const p = Number(zip.slice(0, 3));
    hit.add(us.PREFIXES.findIndex(([lo, hi]) => p >= lo && p <= hi));
  }
  us.PREFIXES.forEach((row, i) => assert.ok(hit.has(i), `no known ZIP code falls in the row ${row.join(" to ").replace(/ to (\D)/, ": $1")}`));
  for (let i = 1; i < us.PREFIXES.length; i++) assert.ok(us.PREFIXES[i][0] > us.PREFIXES[i - 1][1], `rows ${i - 1} and ${i} overlap or are out of order`);
  for (const [lo, hi, st] of us.PREFIXES) assert.ok(lo <= hi && us.STATES.some((s) => s.code === st), `${lo}-${hi} ${st}`);
});

test("59 places: 48 contiguous states and DC, and ten that are not (AK, HI, five territories, three military)", () => {
  assert.strictEqual(us.STATES.length, 59);
  assert.strictEqual(us.STATES.filter((s) => s.zone === "contiguous").length, 49);
  assert.deepStrictEqual(us.STATES.filter((s) => s.zone !== "contiguous").map((s) => s.code).sort(), ["AA", "AE", "AK", "AP", "AS", "GU", "HI", "MP", "PR", "VI"]);
  for (const code of ["AK", "HI", "PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP"]) assert.strictEqual(us.isContiguous(code), false, code);
  for (const code of ["IL", "DC", "ME", "WA", "FL", "CA"]) assert.strictEqual(us.isContiguous(code), true, code);
});

test("a ZIP code that is not one, or whose prefix nobody uses, is not read as any state", () => {
  for (const bad of ["", " ", "4321", "432155", "ABCDE", "00000", "00123", "09999", "42800", "21", "M5V 2T6", "20095 Hamburg", null, undefined, 43215.5, {}]) {
    assert.strictEqual(us.statesOfZip(bad), null, JSON.stringify(bad));
  }
  assert.deepStrictEqual(us.statesOfZip("43215-1234"), ["OH"]);
  assert.deepStrictEqual(us.statesOfZip(" 43215 "), ["OH"]);
  assert.deepStrictEqual(us.statesOfZip("432151234"), ["OH"]);
  assert.deepStrictEqual(us.statesOfZip(43215), ["OH"]);
});

test("the state as people write it: code, name, any case, padded, with full stops, the old abbreviations", () => {
  const same = { IL: ["IL", "il", " Il ", "Illinois", "ILLINOIS", "Ill.", "ill"], NY: ["NY", "N.Y.", "n.y", "New York", " new  york "], DC: ["DC", "D.C.", "d.c.", "Washington DC", "Washington, D.C.", "District of Columbia"],
    WV: ["WV", "W.Va.", "West Virginia", "W. Va."], NH: ["N.H.", "New Hampshire"], CA: ["Calif.", "CA", "California"], PA: ["Penn.", "Pennsylvania"], MA: ["Mass.", "MA"],
    HI: ["HI", "Hawaii", " hawaii "], AK: ["AK", "Alaska"], PR: ["PR", "Puerto Rico"], VI: ["VI", "U.S. Virgin Islands", "Virgin Islands"], GU: ["GU", "Guam"], AE: ["AE", "ae"], AP: ["AP"], AA: ["AA"] };
  for (const [code, ways] of Object.entries(same)) for (const w of ways) assert.strictEqual(us.stateCode(w), code, JSON.stringify(w));
  for (const not of ["", "  ", "Narnia", "HH", "ON", "XX", "Hamburg", "United States", "I L L", null, undefined, 12, {}]) assert.strictEqual(us.stateCode(not), null, JSON.stringify(not));
});

test("the six addresses the review sold at the mainland price (6 of 6) are all outside the contiguous states or refused", () => {
  const tricks = [["CA", "96813", "HI"], ["WA", "99501", "AK"], ["FL", "00901", "PR"], ["NY", "09012", "AE"], ["CA", "96910", "GU"]];
  for (const [state, zip, real] of tricks) {
    const r = us.checkUsAddress({ state, zip });
    assert.deepStrictEqual([r.ok, r.contiguous, r.state], [true, false, real], `${zip} under ${state}`);
  }
  // "Hamburg, Germany" typed into the city with state DE (Delaware) and its German postcode: 20095 is a Washington DC ZIP code.
  const hamburg = us.checkUsAddress({ state: "DE", zip: "20095" });
  assert.deepStrictEqual([hamburg.ok, hamburg.code], [false, "address-mismatch"]);
  assert.ok(/ZIP code 20095 is in District of Columbia/.test(hamburg.error) && /state chosen is Delaware/.test(hamburg.error) && /Check the address/.test(hamburg.error), hamburg.error);
});

test("a state that is not the ZIP code's state is refused in words; the same state is accepted and stored as its code", () => {
  const wrong = us.checkUsAddress({ state: "Illinois", zip: "43215" });
  assert.deepStrictEqual([wrong.ok, wrong.code, wrong.field], [false, "address-mismatch", "shippingZip"]);
  assert.strictEqual(wrong.error, "The state and the ZIP code don't match: ZIP code 43215 is in Ohio, and the state chosen is Illinois. Check the address and try again.");
  for (const [state, zip, code] of [["D.C.", "20001", "DC"], ["Washington DC", "20001", "DC"], ["Ill.", "60601", "IL"], ["N.Y.", "12207", "NY"], [" oh ", "43215-0001", "OH"]]) {
    const r = us.checkUsAddress({ state, zip });
    assert.deepStrictEqual([r.ok, r.state, r.contiguous], [true, code, true], `${state} ${zip}`);
  }
  assert.deepStrictEqual([us.checkUsAddress({ state: "Narnia", zip: "43215" }).code, us.checkUsAddress({ state: "OH", zip: "" }).code, us.checkUsAddress({ state: "OH", zip: "00000" }).code], ["ship-state", "ship-zip", "ship-zip"]);
  // A state outside the contiguous states with a mainland ZIP code is not "a mismatch": it is not given a parcel price either.
  const hi = us.checkUsAddress({ state: "HI", zip: "43215" });
  assert.deepStrictEqual([hi.ok, hi.contiguous], [true, false]);
});

test("ZIP codes known to sit in another state than their prefix's are accepted for the state they are in", () => {
  for (const [state, zip] of [["NY", "06390"], ["WY", "83414"], ["TX", "73960"], ["IL", "63673"], ["MO", "63673"]]) {
    const r = us.checkUsAddress({ state, zip });
    assert.deepStrictEqual([r.ok, r.contiguous, r.state], [true, true, state], `${state} ${zip}`);
  }
  assert.strictEqual(us.checkUsAddress({ state: "CT", zip: "06390" }).code, "address-mismatch");
});

console.log(`\n${passed} passed`);
