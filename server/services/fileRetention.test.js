/**
 * Upload retention: old files go, except the CAD behind an order or an open RFQ.
 * Run: `node server/services/fileRetention.test.js`
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sweepOnce, neededUploads } = require("./fileRetention");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-retention-"));
const old = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, "x"); const t = new Date(Date.now() - 10 * 864e5); fs.utimesSync(p, t, t); };
const fresh = (name) => fs.writeFileSync(path.join(dir, name), "x");
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok   ${name}`); };

console.log("Upload retention");
const table = (rows) => ({ getAll: () => rows, getById: (id) => rows.find((r) => r.id === id) || null });
const models = {
  partsDB: table([
    { id: "p-ordered", storedName: "ordered.step" }, { id: "p-rfq", storedName: "rfq.stl.enc" }, { id: "p-quoted-only", storedName: "abandoned.step" },
    { id: "p-cancelled", storedName: "cancelled.step" }, { id: "p-lost", storedName: "lost.step" },
  ]),
  ordersDB: table([{ id: "o1", status: "paid" }, { id: "o2", status: "cancelled" }]),
  orderItemsDB: table([{ id: "i1", orderId: "o1", partId: "p-ordered" }, { id: "i2", orderId: "o2", partId: "p-cancelled" }]),
  rfqsDB: table([{ id: "r1", status: "quoted", parts: [{ partId: "p-rfq" }] }, { id: "r2", status: "lost", parts: [{ partId: "p-lost" }] }]),
};

test("the files behind a live order and an open RFQ are the ones to keep", () => {
  assert.deepStrictEqual([...neededUploads(models)].sort(), ["ordered.step", "rfq.stl.enc"]);
});

test("the sweep removes old files nobody ordered and leaves ordered, RFQ and recent files", () => {
  for (const n of ["ordered.step", "rfq.stl.enc", "abandoned.step", "cancelled.step", "lost.step"]) old(n);
  fresh("today.step");
  const removed = sweepOnce(dir, 7 * 864e5, neededUploads(models));
  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["ordered.step", "rfq.stl.enc", "today.step"]);
});

test("without a keep list it behaves as before (age only)", () => {
  assert.strictEqual(sweepOnce(dir, 7 * 864e5), 2);
  assert.deepStrictEqual(fs.readdirSync(dir), ["today.step"]);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
