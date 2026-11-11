/**
 * The job traveler and packing list must come back as complete PDFs — they
 * used to be read before the stream had ended and arrived as 0 bytes.
 */
const assert = require("assert");
const { generateJobTraveler, generatePackingList } = require("./pdfGenerator");

const order = { id: "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab", status: "paid", createdAt: new Date().toISOString(), total: 123.45, customerName: "Sample Buyer", shippingAddress: { line1: "1 Example Way", city: "Anytown", state: "IL", zip: "60000" } };
const items = [{ fileName: "guide-block.step", quantity: 10, process: "cnc", materialName: "Acetal", unitPrice: 12.34, lineTotal: 123.4, config: {} }];

(async () => {
  for (const [name, fn] of [["traveler", generateJobTraveler], ["packing list", generatePackingList]]) {
    const buf = await fn(order, items);
    assert.ok(Buffer.isBuffer(buf), `${name}: buffer`);
    assert.ok(buf.length > 1000, `${name}: not empty (${buf.length} bytes)`);
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-", `${name}: PDF header`);
    assert.ok(buf.subarray(-32).toString().includes("%%EOF"), `${name}: complete`);
    console.log(`  ok ${name} (${buf.length} bytes)`);
  }
  console.log("pdfGenerator: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
