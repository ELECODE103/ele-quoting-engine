/**
 * Shop-facts rules the server enforces. Run: `node server/shopFacts.test.js`
 */
const assert = require("assert");
const shopFacts = require("./shopFacts");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log("Shop facts");

test("anodize and powder coat are sent out; bead blast and as-machined are done here", () => {
  for (const slug of ["cnc-anodize-clear", "cnc-anodize-black", "cnc-powder-coat"]) assert.ok(shopFacts.finishSentOut(slug), slug);
  for (const slug of ["cnc-bead-blast", "cnc-as-machined", "cnc-deburr", "", undefined]) assert.ok(!shopFacts.finishSentOut(slug), String(slug));
});

test("a sent-out finish ships on Standard only", () => {
  const standard = { slug: "standard" }, expedited = { slug: "expedited" }, rush = { slug: "rush" };
  assert.strictEqual(shopFacts.leadTimeAllowsFinishes(standard, ["cnc-anodize-black"]), true);
  assert.strictEqual(shopFacts.leadTimeAllowsFinishes(expedited, ["cnc-anodize-black"]), false);
  assert.strictEqual(shopFacts.leadTimeAllowsFinishes(rush, ["cnc-as-machined", "cnc-powder-coat"]), false);
  assert.strictEqual(shopFacts.leadTimeAllowsFinishes(expedited, ["cnc-bead-blast", "cnc-as-machined"]), true);
  assert.strictEqual(shopFacts.leadTimeAllowsFinishes(expedited, []), true);
});

test("the client and server lists of sent-out finishes agree", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../client/src/facts.js"), "utf8");
  const m = src.match(/SENT_OUT_FINISHES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "client list found");
  const client = m[1].split(",").map((x) => x.trim().replace(/['"]/g, "")).filter(Boolean).sort();
  assert.deepStrictEqual(client, [...shopFacts.SENT_OUT_FINISHES].sort());
});

console.log(`\n${passed} checks passed`);
