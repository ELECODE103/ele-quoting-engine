/**
 * Layer heights offered per material. Run: `node server/services/layerHeight.test.js`
 */
const assert = require("assert");
const { offeredLayerHeight } = require("./layerHeight");
const { PRINTING_MATERIALS } = require("../config/defaults");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };
console.log("Layer heights");

const sla = PRINTING_MATERIALS.filter((m) => m.subProcess === "sla");

test("the SLA catalog is the eight Formlabs resins, each at 0.05 and 0.1 mm", () => {
  assert.deepStrictEqual(sla.map((m) => m.slug).sort(), ["sla-clear", "sla-esd", "sla-grey", "sla-high-temp", "sla-rigid-10k", "sla-tough-1500", "sla-tough-2000", "sla-white"]);
  for (const m of sla) {
    assert.deepStrictEqual(m.layerHeights, [0.05, 0.1], m.slug);
    assert.ok(m.layerHeights.includes(m.defaultLayerHeight), m.slug);
    assert.ok(/^Formlabs /.test(m.name) && m.pricePerCm3 > 0 && m.active === true, m.slug);
  }
});

test("an offered layer height is kept; anything else snaps to the nearest offered one", () => {
  const grey = sla.find((m) => m.slug === "sla-grey");
  assert.strictEqual(offeredLayerHeight(grey, 0.05), 0.05);
  assert.strictEqual(offeredLayerHeight(grey, "0.1"), 0.1);
  assert.strictEqual(offeredLayerHeight(grey, 0.025), 0.05);
  assert.strictEqual(offeredLayerHeight(grey, 0.3), 0.1);
});

test("no request means the material default; a material with no list keeps the request", () => {
  assert.strictEqual(offeredLayerHeight(sla[0], undefined), undefined);
  assert.strictEqual(offeredLayerHeight(sla[0], 0), undefined);
  assert.strictEqual(offeredLayerHeight({}, 0.2), 0.2);
});

console.log(`\n${passed} checks passed`);
