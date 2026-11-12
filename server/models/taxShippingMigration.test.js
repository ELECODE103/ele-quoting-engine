/**
 * The shipping and tax columns on a database made by the previous version.
 * Run: `node server/models/taxShippingMigration.test.js`
 *
 * Three processes, one database file:
 *   1. "before": the tables as the previous version left them (the new columns are dropped from
 *      a fresh database, which leaves exactly the earlier shape), holding a quote, a paid order
 *      with its line and a quoted firm-quote request written with the earlier fields only;
 *   2. "open": this version starts on that file. The columns are added, nothing else moves, and
 *      the old quote, order and request read, display, document and check out as before;
 *   3. "open" again: the migration is a no-op the second time.
 *
 * (The same was done by hand with a database produced by the base branch's own code: see
 * docs/launch/tax-and-shipping.md, "How it is tested".)
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const migration = require("./taxShippingMigration");

const mode = process.argv[2];
const NEW = { quotes: migration.QUOTE_COLUMNS, orders: migration.ORDER_COLUMNS, rfqs: migration.RFQ_COLUMNS };
const columnsOf = (db, table) => { const out = []; const st = db.prepare(`PRAGMA table_info(${table})`); while (st.step()) out.push(st.getAsObject().name); st.free(); return out; };

// ─── child: write the "before" database ─────────────────────────────────────
async function makeBefore() {
  const database = require("./database");
  await database.ready;
  require("../config/seed").seedDatabase();
  const { quotesDB, ordersDB, orderItemsDB, rfqsDB } = require("./index");
  const quote = quotesDB.insert({ lineItems: [{ partId: "p1", fileName: "bracket.step", quantity: 4, lineTotal: 180, perUnit: { final: 45 }, weight: { perUnit: 0.23478, total: 0.93912, units: "kg" }, meta: { process: "cnc", materialSlug: "cnc-delrin" } }], subtotal: 180, leadTimeSlug: "standard", leadTimeMultiplier: 1, leadTimeSurcharge: 0, shippingEstimate: 14.3478, orderTotal: 194.35, status: "ordered", paperwork: false, paperworkFee: 0, expiresAt: new Date(Date.now() + 20 * 864e5).toISOString() });
  const draft = quotesDB.insert({ lineItems: quote.lineItems, subtotal: 180, leadTimeSlug: "standard", leadTimeMultiplier: 1, leadTimeSurcharge: 0, shippingEstimate: 14.3478, orderTotal: 194.35, status: "draft", expiresAt: new Date(Date.now() + 20 * 864e5).toISOString() });
  const order = ordersDB.insert({ quoteId: quote.id, status: "paid", shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120", shippingCountry: "US", shippingMethod: "standard", shippingCost: 14.35, subtotal: 180, leadTimeSurcharge: 0, paperwork: false, paperworkFee: 0, tax: 0, total: 194.35, paymentMethod: "card", customerEmail: "dana@buyer.test", customerName: "Dana Buyer", leadTimeName: "Standard", leadDays: 10, shipBy: "2026-11-25", paidAt: new Date().toISOString() });
  orderItemsDB.insert({ orderId: order.id, partId: "p1", fileName: "bracket.step", process: "cnc", materialSlug: "cnc-delrin", materialName: "Delrin / Acetal (POM)", quantity: 4, unitPrice: 45, lineTotal: 180, config: {} });
  const rfq = rfqsDB.insert({ status: "quoted", contactName: "Pat Purchasing", email: "pat@oem.test", quotedTotal: 4250, quotedLeadDays: 15, parts: [], requestType: "part", returnPart: true, paperwork: false });
  // Take the new columns away again: what is left is the table as the previous version made it.
  const db = database.getDatabase();
  for (const [table, cols] of Object.entries(NEW)) for (const [name] of cols) db.run(`ALTER TABLE ${table} DROP COLUMN ${name}`);
  database.saveToDisk();
  process.stdout.write(JSON.stringify({ quoteId: quote.id, draftId: draft.id, orderId: order.id, rfqId: rfq.id, orders: columnsOf(db, "orders"), quotes: columnsOf(db, "quotes"), rfqs: columnsOf(db, "rfqs") }));
}

// ─── child: open the file with this version and report ──────────────────────
async function open(ids) {
  const database = require("./database");
  await database.ready;
  const db = database.getDatabase();
  const { quotesDB, ordersDB, orderItemsDB, rfqsDB } = require("./index");
  const checkout = require("../services/checkout");
  const templates = require("../emails/templates");
  const order = ordersDB.getById(ids.orderId);
  const items = orderItemsDB.query((i) => i.orderId === order.id);
  const quote = quotesDB.getById(ids.quoteId);
  const draft = quotesDB.getById(ids.draftId);
  const pdf = await require("../services/documents").buildOrderConfirmationPdf({ order, items });
  const resolved = checkout.resolve(draft, { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" });
  // A new-style order written to the upgraded tables comes back whole: no field is dropped on the way in.
  const written = ordersDB.insert({ status: "pending_payment", total: 10, shippingMethod: "carrier-account", shippingMode: "table", packedWeightLb: 3.25, shipCarrier: "UPS", shipAccountEnc: "v1.sealed", shipAccountLast4: "C3D4", shipService: "Ground", taxMode: "stripe", taxExempt: true, taxExemptReason: "resale", taxExemptStatus: "taxed", taxCertFileName: "cert.pdf", taxCertPath: "/data/quote-drawings/x.pdf", customerTaxIds: "ca_gst_hst 1" });
  const readBack = ordersDB.getById(written.id);
  quotesDB.update(draft.id, { shipping: { mode: "table", manual: false }, taxCertFileName: "c.pdf", taxCertPath: "/x/c.pdf" });
  rfqsDB.update(ids.rfqId, { taxCertFileName: "r.pdf", taxCertPath: "/x/r.pdf" });
  ordersDB.delete(written.id);
  process.stdout.write(JSON.stringify({
    columns: { orders: columnsOf(db, "orders"), quotes: columnsOf(db, "quotes"), rfqs: columnsOf(db, "rfqs") },
    counts: { orders: ordersDB.getAll().length, quotes: quotesDB.getAll().length, rfqs: rfqsDB.getAll().length, items: orderItemsDB.getAll().length },
    order, quote,
    view: checkout.orderView(order),
    adminView: checkout.orderView(order, { admin: true }),
    quoteView: checkout.viewFor(draft),
    resolved,
    mail: templates.orderConfirmation({ order, items, orderUrl: "https://shop.test/o" }).text,
    pdfBytes: pdf.length,
    pdfText: require("../testSupport/pdfText").pdfText(pdf),
    readBack,
    draftAfter: quotesDB.getById(draft.id),
    rfqAfter: rfqsDB.getById(ids.rfqId),
  }));
}

if (mode === "before") { makeBefore().catch((e) => { console.error(e); process.exit(1); }); return; }
if (mode === "open") { open(JSON.parse(process.argv[3])).catch((e) => { console.error(e); process.exit(1); }); return; }

// ─── parent ─────────────────────────────────────────────────────────────────
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); process.exitCode = 1; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-migrate-"));
const env = { ...process.env, QUOTING_DB_PATH: path.join(tmp, "quoting.db"), QUOTING_DATA_DIR: path.join(tmp, "data"), JWT_SECRET: require("crypto").randomBytes(24).toString("hex"), NODE_ENV: "test", USE_SQLITE: "true" };
delete env.ADMIN_EMAIL;
function child(...args) {
  const r = spawnSync(process.execPath, [__filename, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`child ${args[0]} failed:\n${r.stderr}\n${r.stdout.slice(-2000)}`);
  // The seed prints progress lines first; the report is the last line.
  return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("\n") + 1).trim() || r.stdout.slice(r.stdout.indexOf("{")));
}

console.log("Shipping and tax columns: upgrading a database from the previous version");
let before, first, second;

test("every new column has a field name the data layer knows (nothing is dropped without a word)", () => {
  const { SqliteDB } = (process.env.QUOTING_DB_PATH = env.QUOTING_DB_PATH, require("./SqliteDB"));
  void SqliteDB;
  const mapped = new Set([...Object.values(migration.FIELD_MAP), ...Object.values(migration.JSON_FIELDS.quotes)]);
  for (const [table, cols] of Object.entries(NEW)) for (const [name] of cols) assert.ok(mapped.has(name), `${table}.${name} has no field mapping`);
  for (const col of Object.values(migration.FIELD_MAP)) assert.ok(Object.values(NEW).some((cols) => cols.some(([name]) => name === col)), `${col} is mapped but is not a column`);
});

test("before: the database has the previous version's tables, with a quote, a paid order and a quoted request", () => {
  before = child("before");
  for (const [table, cols] of Object.entries(NEW)) for (const [name] of cols) assert.ok(!before[table].includes(name), `${table}.${name} is not there yet`);
  assert.ok(before.orders.includes("shipping_method") && before.orders.includes("tax") && before.quotes.includes("shipping_estimate"));
});

test("opening it with this version adds the columns and changes nothing else", () => {
  first = child("open", JSON.stringify(before));
  for (const [table, cols] of Object.entries(NEW)) for (const [name] of cols) assert.ok(first.columns[table].includes(name), `${table}.${name} was added`);
  for (const table of ["orders", "quotes", "rfqs"]) assert.deepStrictEqual(first.columns[table].filter((c) => !NEW[table].some(([n]) => n === c)), before[table], `${table}: the earlier columns are untouched, in order`);
  assert.deepStrictEqual(first.counts, { orders: 1, quotes: 2, rfqs: 1, items: 1 });
  const o = first.order;
  assert.deepStrictEqual([o.status, o.total, o.shippingCost, o.subtotal, o.tax, o.shippingMethod, o.shippingAddress, o.customerEmail, o.shipBy], ["paid", 194.35, 14.35, 180, 0, "standard", "100 Main St", "dana@buyer.test", "2026-11-25"]);
  assert.deepStrictEqual([o.shippingMode, o.taxMode, o.taxExempt, o.shipCarrier, o.shipAccountEnc, o.taxCertPath], [null, null, false, null, null, null], "the new fields read as empty");
  assert.strictEqual(first.quote.shipping, null);
  assert.strictEqual(first.quote.shippingEstimate, 14.3478);
});

test("the old order displays, emails and prints as it did: a Shipping line, no tax, no pickup, no carrier", () => {
  assert.deepStrictEqual([first.view.taxLine, first.view.deliveryLine, first.view.shipAccountMasked, first.view.hasTaxCertificate, first.view.pickupAddress], [null, "", "", false, undefined]);
  assert.deepStrictEqual([first.adminView.shipAccountNumber, first.adminView.taxExemptionLine], [null, ""]);
  assert.ok(/Shipping\s+\$14\.35/.test(first.mail) && /Total paid: \$194\.35/.test(first.mail) && /Ship to: Dana Buyer, 100 Main St, Elgin, IL 60120/.test(first.mail));
  assert.ok(!/tax|pickup|carrier account|exempt/i.test(first.mail));
  assert.ok(first.pdfBytes > 2000 && /Shipping/.test(first.pdfText) && /194\.35/.test(first.pdfText) && !/Sales tax|Pickup|Per invoice/.test(first.pdfText));
});

// Shipping is never read back from a quote: it is worked out at checkout from the quote's lines
// (the weight formula over the line weights, here). For an old quote that comes to what it showed.
test("the old draft quote checks out at its own total: shipping worked out now from its lines is what it showed", () => {
  const view = first.quoteView;
  assert.deepStrictEqual([view.showOptions, view.options.length, view.options[0].total, view.shipping.mode, view.tax.mode], [false, 1, 194.35, "formula", "off"]);
  const r = first.resolved;
  assert.deepStrictEqual([r.ok, r.method, r.total, r.shippingCost, r.subtotal, r.shippingMode, r.taxMode], [true, "ship", 194.35, 14.35, 180, "formula", "off"]);
});

test("rows written with the new fields come back whole from the upgraded tables", () => {
  const b = first.readBack;
  assert.deepStrictEqual([b.shippingMethod, b.shippingMode, b.packedWeightLb, b.shipCarrier, b.shipAccountEnc, b.shipAccountLast4, b.shipService, b.taxMode, b.taxExempt, b.taxExemptReason, b.taxExemptStatus, b.taxCertFileName, b.taxCertPath, b.customerTaxIds],
    ["carrier-account", "table", 3.25, "UPS", "v1.sealed", "C3D4", "Ground", "stripe", true, "resale", "taxed", "cert.pdf", "/data/quote-drawings/x.pdf", "ca_gst_hst 1"]);
  assert.deepStrictEqual([first.draftAfter.shipping, first.draftAfter.taxCertFileName, first.draftAfter.taxCertPath], [{ mode: "table", manual: false }, "c.pdf", "/x/c.pdf"]);
  assert.deepStrictEqual([first.rfqAfter.taxCertFileName, first.rfqAfter.taxCertPath, first.rfqAfter.returnPart, first.rfqAfter.quotedTotal], ["r.pdf", "/x/r.pdf", true, 4250]);
});

test("starting a second time is a no-op: same columns, same rows", () => {
  second = child("open", JSON.stringify(before));
  assert.deepStrictEqual(second.columns, first.columns);
  assert.deepStrictEqual(second.counts, first.counts);
  assert.deepStrictEqual([second.order.total, second.order.status], [194.35, "paid"]);
});

test("the migration refuses anything that is not a plain column name or type", () => {
  const fake = { prepare: () => ({ step: () => false, getAsObject: () => ({}), free() {} }), run() { throw new Error("should not run"); } };
  assert.throws(() => migration.apply(fake, { quotes: [], rfqs: [], orders: [["x; DROP TABLE orders", "TEXT"]] }), /not a plain identifier/);
  assert.throws(() => migration.apply(fake, { quotes: [], rfqs: [], orders: [["fine_name", "TEXT; DROP TABLE orders"]] }), /not a plain identifier/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
