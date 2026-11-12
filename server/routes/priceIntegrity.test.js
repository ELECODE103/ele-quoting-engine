/**
 * Price integrity (independent review 2026-11-11: F1, F2; payments review: F-01 … F-05, F-12, F-13).
 * Run: node server/routes/priceIntegrity.test.js
 *
 * Each block is one of the reviewers' attacks, made permanent. On the code before the fixes every
 * block fails: a block priced as sheet metal was sold at the order minimum, a DXF grown 25× after
 * pricing was charged the small-part price, split lines walked past the gate, and a saved quote was
 * charged as saved for thirty days.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { boxStl, rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Price integrity");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  const h = await start({ mailer: "configured" });
  const { quotesDB, ordersDB, orderItemsDB, partsDB, materialsDB, finishesDB } = h.models;
  const registry = require("../processes/registry");
  // (Loaded this way so the suite also runs — and fails, test by test — on a tree from before the fixes, where these modules do not exist.)
  const optional = (name) => { try { return require(name); } catch (err) { if (err.code === "MODULE_NOT_FOUND") return null; throw err; } };
  const quoteIntegrity = optional("../services/quoteIntegrity");
  const checkoutGuard = optional("../services/checkoutGuard") || { resetForTests() {} };

  let owner, buyer, block, panel;
  const upload = async (name, data, fields = {}, token) => {
    const r = await h.form("/api/upload", fields, { files: { name, data } }, token);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.parts.length, 1, r.text);
    return r.body.parts[0];
  };
  const quote = (parts, token = buyer, extra = {}) => h.post("/api/quote", { parts, leadTimeSlug: "standard", ...extra }, token);
  const checkout = (quoteId, token = buyer, extra = {}) => { checkoutGuard.resetForTests(); return h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...extra }, token); };
  const sessionsCreated = () => h.stripe.created.length;
  const peek = (partId, over = {}) => ({ partId, materialSlug: "cnc-peek", process: "cnc", quantity: 5, ...over });
  const refused = async (config, code, token = buyer, extra = {}) => {
    const r = await quote([config], token, extra);
    assert.strictEqual(r.status, 400, `${JSON.stringify(config)} → ${r.status} ${r.text.slice(0, 160)}`);
    assert.strictEqual(r.body.code, code, `${JSON.stringify(config)} → ${r.text.slice(0, 200)}`);
    assert.strictEqual(r.body.orderTotal, undefined, "no price comes back with a refusal");
    assert.strictEqual(r.body.quoteId, undefined, "and nothing is saved");
    return r;
  };

  // Everything the server reports to the owner while these tests run.
  const reported = [];
  const realError = console.error;
  console.error = (...args) => { const line = args.map(String).join(" "); if (line.startsWith("[price-integrity]")) reported.push(line); else realError(...args); };

  test("setup: the owner, a buyer, a 120 × 90 × 60 mm block and a 40 × 30 mm DXF panel", async () => {
    owner = await h.admin();
    buyer = await h.register("pat@buyer.test", "Pat Buyer");
    block = await upload("block.stl", boxStl([120, 90, 60]), {}, buyer);
    panel = await upload("panel.dxf", rectDxf(40, 30, 4), { process: "routing" }, buyer);
    h.sent.length = 0;
  });

  // ═══ F1 — only what the catalog offers is priced ═════════════════════════
  let honest;
  test("F1: the honest price of five PEEK blocks is in the thousands, and an unknown or inactive process is refused instead of priced as sheet metal", async () => {
    honest = await quote([peek(block.partId)]);
    assert.strictEqual(honest.status, 200, honest.text);
    assert.ok(honest.body.orderTotal > 1500, `honest total ${honest.body.orderTotal}`);
    for (const process of ["sheetmetal", "totally-made-up", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "CNC", " cnc"]) {
      await refused(peek(block.partId, { process }), "process-not-offered");
    }
    assert.strictEqual(quotesDB.getAll().filter((q) => q.orderTotal < 100).length, 0, "no quote at the order minimum was saved for this part");
    // The registry itself no longer has a fallback to hand out.
    assert.throws(() => registry.resolveProcess("totally-made-up"), /Unknown manufacturing process/);
  });

  test("F1: a material is priced only by the process it belongs to — both directions, every pairing", async () => {
    await refused(peek(block.partId, { process: "3d-printing" }), "material-process-mismatch");
    await refused(peek(block.partId, { process: "routing", thicknessMm: 25.4 }), "material-process-mismatch");
    await refused(peek(block.partId, { process: "routing", thicknessMm: 0.01 }), "material-process-mismatch");
    await refused({ partId: block.partId, materialSlug: "fdm-pla", process: "cnc", quantity: 1 }, "material-process-mismatch");
    await refused({ partId: block.partId, materialSlug: "cnc-aluminum-6061", process: "3d-printing", subProcess: "fdm", quantity: 20 }, "material-process-mismatch");
    await refused({ partId: block.partId, materialSlug: "rt-hdpe", process: "cnc", quantity: 1 }, "material-process-mismatch");
    await refused({ partId: block.partId, materialSlug: "mild-steel", process: "cnc", quantity: 1 }, "material-process-mismatch");
    await refused({ partId: block.partId, materialSlug: "mild-steel", quantity: 1 }, "process-not-offered"); // its own process is switched off
    await refused({ partId: block.partId, materialSlug: "no-such-material", process: "cnc", quantity: 1 }, "material-not-offered");
    await refused({ partId: block.partId, materialSlug: "__proto__", process: "cnc", quantity: 1 }, "material-not-offered");
    await refused({ partId: block.partId, process: "cnc", quantity: 1 }, "material-not-offered");
    // No process named: it is the material's own, and the price is the same as naming it.
    const implied = await quote([{ partId: block.partId, materialSlug: "cnc-peek", quantity: 5 }]);
    assert.strictEqual(implied.status, 200, implied.text);
    assert.strictEqual(implied.body.orderTotal, honest.body.orderTotal);
    assert.strictEqual(implied.body.lineItems[0].meta.process, "cnc");
  });

  test("F1: the one tie between a kind of file and a process — a DXF is routed, in a sheet material, at a stocked thickness", async () => {
    const ok = await quote([{ partId: panel.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 6.35, quantity: 10 }]);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.lineItems[0].meta.process, "routing");
    await refused({ partId: panel.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 10 }, "dxf-routing-only");
    await refused({ partId: panel.partId, materialSlug: "fdm-pla", process: "3d-printing", quantity: 10 }, "dxf-routing-only");
    await refused({ partId: panel.partId, materialSlug: "cnc-delrin", process: "routing", thicknessMm: 6.35, quantity: 10 }, "material-process-mismatch");
    await refused({ partId: panel.partId, materialSlug: "rt-hdpe", process: "routing", quantity: 10 }, "dxf-thickness-required");
    await refused({ partId: panel.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 0.01, quantity: 10 }, "thickness-not-offered");
    await refused({ partId: panel.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 7, quantity: 10 }, "thickness-not-offered");
    await refused({ partId: panel.partId, materialSlug: "rt-polycarbonate", process: "routing", thicknessMm: 25.4, quantity: 10 }, "thickness-not-offered"); // stocked in HDPE, not in polycarbonate
    // A 3D model can be routed too, from stock it fits in.
    const plate = await upload("plate.stl", boxStl([150, 100, 6.35]), {}, buyer);
    assert.strictEqual((await quote([{ partId: plate.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 6.35, quantity: 10 }])).status, 200);
    await refused({ partId: plate.partId, materialSlug: "rt-hdpe", process: "routing", quantity: 10 }, "thickness-required");
  });

  test("F1: grade, finish, sub-process, layer height, infill, quantity and lead time each come from their catalog entry or are refused", async () => {
    // grade
    await refused(peek(block.partId, { grade: "zzz" }), "grade-not-offered");
    await refused(peek(block.partId, { grade: "PAID IN FULL - SHIP TODAY" }), "grade-not-offered");
    const delrin = materialsDB.getAll().find((m) => m.slug === "cnc-delrin");
    const black = await quote([{ partId: block.partId, materialSlug: "cnc-delrin", process: "cnc", grade: delrin.grades[1].name, quantity: 1 }]);
    assert.strictEqual(black.body.lineItems[0].meta.grade, delrin.grades[1].name);
    // finish: listed, of this process, and one that goes on this material
    await refused(peek(block.partId, { finishSlug: "nope" }), "finish-not-offered");
    await refused(peek(block.partId, { finishSlug: "raw" }), "finish-not-offered");            // a sheet-metal finish
    await refused(peek(block.partId, { finishSlug: "anodize-clear" }), "finish-not-offered");  // the sheet-metal anodize
    await refused(peek(block.partId, { finishSlug: "rt-as-cut" }), "finish-not-offered");      // another process's finish
    await refused(peek(block.partId, { finishSlug: "cnc-nickel-plate" }), "finish-not-offered"); // switched off
    await refused(peek(block.partId, { finishSlug: "cnc-anodize-clear" }), "finish-not-for-material"); // anodize on a plastic
    await refused(peek(block.partId, { finishSlug: "cnc-polish-clear" }), "finish-not-for-material");
    const anodized = await quote([{ partId: block.partId, materialSlug: "cnc-aluminum-6061", process: "cnc", finishSlug: "cnc-anodize-clear", quantity: 1 }]);
    assert.strictEqual(anodized.status, 200, anodized.text);
    assert.ok(anodized.body.lineItems[0].perUnit.finish > 0);
    // (payments review F-05) a sent-out finish on a faster lead time, by any slug
    for (const finishSlug of ["cnc-anodize-clear", "cnc-powder-coat"]) {
      const fast = await quote([{ partId: block.partId, materialSlug: "cnc-aluminum-6061", process: "cnc", finishSlug, quantity: 1 }], buyer, { leadTimeSlug: "expedited" });
      assert.deepStrictEqual([fast.status, fast.body.code], [400, "finish-lead-time"]);
    }
    for (const finishSlug of ["anodize-clear", "powder-black", "zinc-plate"]) {
      const sneaky = await quote([{ partId: block.partId, materialSlug: "cnc-aluminum-6061", process: "cnc", finishSlug, quantity: 1 }], buyer, { leadTimeSlug: "expedited" });
      assert.deepStrictEqual([sneaky.status, sneaky.body.code], [400, "finish-not-offered"], `${finishSlug} is not a finish of this process`);
    }
    // sub-process
    await refused(peek(block.partId, { subProcess: "laser" }), "sub-process-not-offered");
    await refused({ partId: block.partId, materialSlug: "fdm-pla", process: "3d-printing", subProcess: "sla", quantity: 1 }, "sub-process-not-offered");
    await refused({ partId: block.partId, materialSlug: "sla-grey", process: "3d-printing", subProcess: "fdm", quantity: 1 }, "sub-process-not-offered");
    const turned = await quote([peek(block.partId, { subProcess: "turning" })]);
    assert.strictEqual(turned.status, 200);
    assert.ok(turned.body.gate.requiresRfq && turned.body.gate.reasons.some((r) => r.code === "turning-review"), "turning is priced for information and quoted by a person");
    // layer height and infill
    const pla = { partId: block.partId, materialSlug: "fdm-pla", process: "3d-printing", subProcess: "fdm", quantity: 1 };
    await refused({ ...pla, layerHeight: 0.07 }, "layer-height-not-offered");
    await refused({ ...pla, layerHeight: 5 }, "layer-height-not-offered");
    await refused({ partId: block.partId, materialSlug: "sla-grey", process: "3d-printing", quantity: 1, layerHeight: 0.3 }, "layer-height-not-offered");
    for (const infill of [1e9, 0.01, 1.01]) await refused({ ...pla, infill }, "infill-out-of-range");
    await refused({ ...pla, infill: -1000 }, "config-invalid");
    const solid = await quote([{ ...pla, infill: 1 }]);
    const sparse = await quote([{ ...pla, infill: 0.1 }]);
    assert.ok(solid.body.orderTotal > sparse.body.orderTotal, "infill is priced, within its range");
    assert.strictEqual((await quote([{ ...pla, layerHeight: 0.3, infill: 0.2 }])).status, 200);
    // quantity
    for (const quantity of [0, -5, 0.5, 2.7, 1e300, 1000001]) await refused(peek(block.partId, { quantity }), "quantity-invalid");
    // A form field's plain number is read ("25"); anything cleverer is not a number at all.
    assert.strictEqual((await quote([peek(block.partId, { quantity: "5" })])).status, 200);
    for (const quantity of ["1e2", "0x10", " 12 ", "5 pieces", "Infinity", [5], { valueOf: 5 }, true]) await refused(peek(block.partId, { quantity }), "config-invalid");
    const { quantity: _q, ...noQuantity } = peek(block.partId);
    await refused(noQuantity, "quantity-invalid");
    // lead time
    for (const leadTimeSlug of ["rush", "same-day", "nope", "__proto__"]) {
      const r = await quote([peek(block.partId)], buyer, { leadTimeSlug });
      assert.deepStrictEqual([r.status, r.body.code], [400, "lead-time-not-offered"], leadTimeSlug);
    }
    // an option the process does not have is not read at all (the page sends infill with every part)
    const stray = await quote([peek(block.partId, { infill: 0.2, layerHeight: 0.2, thicknessMm: 0 })]);
    assert.strictEqual(stray.body.orderTotal, honest.body.orderTotal);
  });

  test("F1: every material the catalog lists prices in its own process with its default setup (the whitelist refuses nothing that is on offer)", async () => {
    const listed = (await h.get("/api/materials")).body;
    assert.ok(listed.length >= 30, `${listed.length} materials listed`);
    assert.deepStrictEqual([...new Set(listed.map((m) => m.process))].sort(), ["3d-printing", "cnc", "routing"], "only materials of active processes are listed");
    const finishes = (await h.get("/api/finishes")).body;
    assert.deepStrictEqual([...new Set(finishes.map((f) => f.process))].sort(), ["3d-printing", "cnc", "routing"], "and only their finishes (the nine sheet-metal finishes are not public)");
    assert.strictEqual((await h.get("/api/finishes?process=sheetmetal")).body.length, 0);
    assert.strictEqual((await h.get("/api/materials?process=sheetmetal")).body.length, 0);
    const cube = await upload("cube.stl", boxStl(20), {}, buyer);
    for (const m of listed) {
      const config = { partId: cube.partId, materialSlug: m.slug, process: m.process, quantity: 2, ...(m.thicknesses?.length ? { thicknessMm: m.thicknesses[m.thicknesses.length - 1].mm } : {}) };
      const r = await quote([config]);
      assert.strictEqual(r.status, 200, `${m.slug}: ${r.text.slice(0, 200)}`);
      assert.ok(r.body.orderTotal >= 25, m.slug);
      // …and with each finish the page offers for it
      for (const f of finishes.filter((x) => x.process === m.process && (!x.materialSlugs || x.materialSlugs.includes(m.slug)))) {
        const withFinish = await quote([{ ...config, finishSlug: f.slug }]);
        assert.strictEqual(withFinish.status, 200, `${m.slug} + ${f.slug}: ${withFinish.text.slice(0, 200)}`);
      }
      for (const f of finishes.filter((x) => x.process === m.process && x.materialSlugs && !x.materialSlugs.includes(m.slug))) {
        assert.strictEqual((await quote([{ ...config, finishSlug: f.slug }])).body.code, "finish-not-for-material", `${m.slug} + ${f.slug}`);
      }
    }
  });

  test("F1 / F-13: a material record without the price or density its model reads is not priced from a built-in figure — it is refused and the owner is told", async () => {
    const mat = materialsDB.getAll().find((m) => m.slug === "cnc-uhmw");
    const cases = [{ pricePerKg: null }, { pricePerKg: 0 }, { grades: mat.grades.map((g) => ({ ...g, density: 0 })) }, { machinability: null }];
    for (const broken of cases) {
      reported.length = 0;
      materialsDB.update(mat.id, broken);
      try {
        const r = await quote([{ partId: block.partId, materialSlug: "cnc-uhmw", process: "cnc", quantity: 1 }]);
        assert.deepStrictEqual([r.status, r.body.code, r.body.offerRfq], [409, "material-unavailable", true], JSON.stringify(broken));
        assert.strictEqual(r.body.orderTotal, undefined);
        assert.ok(reported.some((l) => /material record incomplete/.test(l) && /cnc-uhmw/.test(l)), "logged for the owner");
      } finally { materialsDB.update(mat.id, { pricePerKg: mat.pricePerKg, grades: mat.grades, machinability: mat.machinability }); }
    }
    assert.strictEqual((await quote([{ partId: block.partId, materialSlug: "cnc-uhmw", process: "cnc", quantity: 1 }])).status, 200);
    // The models themselves have no stand-in price either.
    const { PricingEngine } = require("../services/pricingEngine");
    const engine = new PricingEngine(require("../config/ruleSchema").mergeRules({}));
    const geometry = partsDB.getById(block.partId).geometry;
    for (const [process, material] of [["cnc", { ...mat, pricePerKg: null }], ["routing", { ...materialsDB.getAll().find((m) => m.slug === "rt-hdpe"), pricePerKg: 0 }], ["3d-printing", { ...materialsDB.getAll().find((m) => m.slug === "fdm-pla"), pricePerCm3: undefined }], ["sheetmetal", { ...materialsDB.getAll().find((m) => m.slug === "mild-steel"), pricePerKg: "" }]]) {
      assert.throws(() => engine.calculatePartPrice({ process, geometry, material, grade: material.grades?.[0]?.name, thicknessMm: 6.35, finish: null, quantity: 1 }), /Cannot price/, process);
    }
  });

  test("F1: the floor — a price below the material in the part is refused and reported, not sold; a small part at the order minimum is fine", async () => {
    // A small part: priced, at the order minimum, and it checks out.
    const tiny = await upload("tiny.stl", boxStl(5), {}, buyer);
    assert.strictEqual((await h.put("/api/admin/pricing", { rules: { minimumOrderTotal: 60 }, note: "test: a minimum the small part sits on" }, owner)).status, 200);
    const small = await quote([{ partId: tiny.partId, materialSlug: "fdm-pla", process: "3d-printing", quantity: 1 }]);
    assert.strictEqual(small.status, 200, small.text);
    assert.ok(small.body.subtotal < 30, `the part itself is ${small.body.subtotal}`);
    assert.strictEqual(small.body.orderTotal, 60, "the order minimum");
    const paid = await checkout(small.body.quoteId);
    assert.strictEqual(paid.status, 200, paid.text);
    assert.strictEqual(h.stripe.created[sessionsCreated() - 1].line_items[0].price_data.unit_amount, 6000);
    assert.strictEqual((await h.post("/api/admin/pricing/reset", { note: "test: defaults" }, owner)).status, 200);

    // Now the engine goes wrong the way F1 did: the CNC model answers with a flat-sheet price.
    const cnc = registry.getProcess("cnc").pricing;
    const real = cnc.calculate;
    const sheet = registry.getProcess("sheetmetal").pricing.calculate;
    reported.length = 0;
    h.sent.length = 0;
    cnc.calculate = (params, rules) => { const p = sheet({ ...params, thicknessMm: 1 }, rules); return { ...p, meta: { ...p.meta, process: "cnc", materialSlug: params.material.slug } }; };
    try {
      const r = await quote([peek(block.partId)]);
      assert.deepStrictEqual([r.status, r.body.code, r.body.offerRfq], [422, "price-check-failed", true], r.text);
      assert.strictEqual(r.body.orderTotal, undefined);
      assert.ok(reported.some((l) => /below the material in the part/.test(l)), reported.join("\n"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(h.sent.some((m) => /held back for review/.test(m.subject)), "the shop is emailed");
      // A model that reports another process's name, NaN, or a negative price is stopped too.
      for (const [bad, why] of [
        [(p, rules) => ({ ...real(p, rules), meta: { ...real(p, rules).meta, process: "sheetmetal" } }), /another process's model/],
        [(p, rules) => { const x = real(p, rules); return { ...x, lineTotal: NaN, perUnit: { ...x.perUnit, final: NaN } }; }, /pricing engine error|not a positive number/],
        [(p, rules) => { const x = real(p, rules); return { ...x, lineTotal: x.lineTotal / 100 }; }, /not unit price × quantity/],
        [(p, rules) => { const x = real(p, rules); return { ...x, perUnit: { ...x.perUnit, final: x.perUnit.subtotal / 3 }, lineTotal: (x.perUnit.subtotal / 3) * x.quantity }; }, /below its computed cost/],
      ]) {
        reported.length = 0;
        cnc.calculate = bad;
        const x = await quote([peek(block.partId)]);
        assert.deepStrictEqual([x.status, x.body.code], [422, "price-check-failed"], x.text);
        assert.ok(reported.some((l) => why.test(l)), `${why}: ${reported.join(" | ")}`);
      }
    } finally { cnc.calculate = real; }
    assert.strictEqual((await quote([peek(block.partId)])).body.orderTotal, honest.body.orderTotal, "the engine is itself again");

    // F-12 (payments review): every rate-card value at its legal minimum at once — margin 0, floors 0, the lowest
    // rates and a 90% quantity break. Each is inside its own range; together they price under the material. Not sold.
    reported.length = 0;
    const low = await h.put("/api/admin/pricing", { note: "test: every floor at its legal minimum", rules: { marginPercent: 0, minimumPartPrice: 0, minimumOrderTotal: 0, shippingBaseRate: 0, shippingPerKg: 0, cncMachineRatePerHour: 20, laborRatePerHour: 10, nestingEfficiencyBonus: 0.9, volumeDiscounts: [{ minQty: 1, discount: 0.9 }] } }, owner);
    assert.strictEqual(low.status, 200, low.text);
    const under = await quote([peek(block.partId, { quantity: 25 })]);
    assert.deepStrictEqual([under.status, under.body.code, under.body.orderTotal], [422, "price-check-failed", undefined], under.text);
    assert.ok(reported.some((l) => /below its own material cost/.test(l)), reported.join("\n"));
    assert.strictEqual((await h.post("/api/admin/pricing/reset", { note: "test: defaults" }, owner)).status, 200);
    assert.strictEqual((await quote([peek(block.partId)])).body.orderTotal, honest.body.orderTotal, "and at the shipped rules the same part prices as before");
  });

  test("F1: a cheat quote saved by the old code cannot be checked out, reopened into an order, or reordered", async () => {
    // Exactly the row the reviewer's exploit left behind: PEEK, process "totally-made-up", $37.
    const cheat = quotesDB.insert({
      userId: null, status: "draft", leadTimeSlug: "standard", subtotal: 25, orderTotal: 37, leadTimeMultiplier: 1,
      lineItems: [{ partId: block.partId, fileName: "block.stl", quantity: 5, perUnit: { final: 5 }, lineTotal: 25, meta: { process: "sheetmetal", materialSlug: "cnc-peek", finishSlug: "raw" } }],
      gate: { requiresRfq: false, reasons: [] },
      config: { process: "cnc", parts: [{ partId: block.partId, materialSlug: "cnc-peek", process: "totally-made-up", quantity: 5 }] },
      expiresAt: new Date(Date.now() + 20 * 864e5).toISOString(),
    });
    const before = sessionsCreated();
    const r = await checkout(cheat.id);
    assert.deepStrictEqual([r.status, r.body.code, r.body.reason], [409, "quote-needs-update", "process-not-offered"], r.text);
    assert.strictEqual(sessionsCreated(), before, "Stripe was not asked for anything");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === cheat.id).length, 0);
    assert.strictEqual((await h.post("/api/orders", { quoteId: cheat.id }, owner)).body.code, "quote-needs-update", "nor as a phone order by the admin");
    // The same quote with a real process but the cheat's stored total: priced again, and the buyer is shown today's price.
    const stale = quotesDB.insert({ ...cheat, id: undefined, config: { process: "cnc", parts: [peek(block.partId)] } });
    const s = await checkout(stale.id);
    assert.deepStrictEqual([s.status, s.body.code, s.body.previousTotal], [409, "quote-changed", 37], s.text);
    assert.strictEqual(s.body.newTotal, honest.body.orderTotal);
    assert.strictEqual(sessionsCreated(), before);
    // And an order whose stored line names a process that is not on offer cannot be re-quoted as it was.
    const order = ordersDB.insert({ userId: h.models.usersDB.getAll().find((u) => u.email === "pat@buyer.test").id, status: "paid", total: 37, leadTimeSlug: "standard" });
    orderItemsDB.insert({ orderId: order.id, partId: block.partId, fileName: "block.stl", process: "sheetmetal", materialSlug: "cnc-peek", finishSlug: "raw", quantity: 5, unitPrice: 5, lineTotal: 25, config: {} });
    const re = await h.post(`/api/orders/${order.id}/reorder`, {}, buyer);
    assert.deepStrictEqual([re.status, re.body.code], [409, "reorder-failed"], re.text);
    for (const it of orderItemsDB.query((i) => i.orderId === order.id)) orderItemsDB.delete(it.id);
    ordersDB.delete(order.id);
  });

  // ═══ F2 — checkout prices again ══════════════════════════════════════════
  const routed = (partId, quantity = 20) => ({ partId, materialSlug: "rt-polycarbonate", process: "routing", thicknessMm: 12.7, quantity });

  test("F2: a DXF's units changed after pricing — the draft quote is priced again at once, and the buyer is shown the new price before paying", async () => {
    const part = await upload("swap.dxf", rectDxf(10, 8, 4), { process: "routing" }, buyer);
    const small = await quote([routed(part.partId, 4)]);
    assert.strictEqual(small.status, 200, small.text);
    const fingerprint = quotesDB.getById(small.body.quoteId).config.integrity.fingerprint;
    assert.ok(/^[0-9a-f]{40}$/.test(fingerprint), "the quote carries a fingerprint of what was priced");
    const sw = await h.raw("POST", `/api/parts/${part.partId}/units`, { json: { units: "in" }, token: buyer, headers: { "X-Human-Token": h.humanToken, "X-Part-Key": part.editKey } });
    assert.strictEqual(sw.status, 200, sw.text);
    assert.strictEqual(Math.round(sw.body.geometry.boundingBox.width), 254, "the part is 25.4× bigger");
    const stored = quotesDB.getById(small.body.quoteId);
    assert.ok(stored.orderTotal > small.body.orderTotal * 1.5, `the saved draft was priced again: ${small.body.orderTotal} → ${stored.orderTotal}`);
    assert.notStrictEqual(stored.config.integrity.fingerprint, fingerprint);
    // The buyer's page still shows the old total when they press pay.
    const before = sessionsCreated();
    const stalePage = await checkout(small.body.quoteId, buyer, { confirmedTotal: small.body.orderTotal });
    assert.deepStrictEqual([stalePage.status, stalePage.body.code], [409, "quote-changed"], stalePage.text);
    assert.strictEqual(stalePage.body.newTotal, stored.orderTotal);
    assert.strictEqual(stalePage.body.quote.orderTotal, stored.orderTotal, "the answer carries the quote at today's price for the page to show");
    assert.strictEqual(sessionsCreated(), before);
    // Having seen it, they confirm: charged the new price, and the order remembers exactly what was priced.
    const ok = await checkout(small.body.quoteId, buyer, { confirmedTotal: stored.orderTotal });
    assert.strictEqual(ok.status, 200, ok.text);
    const sent = h.stripe.created[sessionsCreated() - 1];
    assert.strictEqual(sent.line_items.reduce((s, li) => s + li.price_data.unit_amount, 0), Math.round(stored.orderTotal * 100));
    const item = orderItemsDB.query((i) => i.orderId === ok.body.orderId)[0];
    assert.deepStrictEqual([Math.round(item.config.priced.dimsMm.x), Math.round(item.config.priced.dimsMm.y), item.config.priced.dimsMm.z], [254, 203, 12.7]);
    assert.deepStrictEqual([item.config.priced.sourceUnit, item.config.priced.thicknessMm, item.config.priced.materialSlug, item.config.priced.quantity, item.config.priced.is2D], ["in", 12.7, "rt-polycarbonate", 4, true]);
    assert.ok(item.config.priced.grade && item.config.priced.fingerprint && item.config.priced.geometryHash);
    // Once ordered the units are locked, as before.
    const locked = await h.raw("POST", `/api/parts/${part.partId}/units`, { json: { units: "mm" }, token: buyer, headers: { "X-Human-Token": h.humanToken, "X-Part-Key": part.editKey } });
    assert.deepStrictEqual([locked.status, locked.body.code], [409, "part-locked"]);
    // The traveler can be checked against what was charged.
    const traveler = await h.get(`/api/orders/${ok.body.orderId}/traveler`, owner);
    assert.strictEqual(traveler.body.items[0].matchesPriced, true);
    assert.strictEqual(traveler.body.items[0].priced.sourceUnit, "in");
  });

  test("F2: geometry that changes behind the quote's back is caught at checkout by the fingerprint, whatever changed it", async () => {
    const part = await upload("behind.dxf", rectDxf(10, 8, 4), { process: "routing" }, buyer);
    const small = await quote([routed(part.partId, 4)]);
    // The stored part is replaced without the route (a bug, a migration, a future endpoint): 10 × 8 mm becomes 254 × 203 mm.
    const big = await upload("big.dxf", rectDxf(254, 203.2, 4), { process: "routing" }, buyer);
    partsDB.update(part.partId, { geometry: partsDB.getById(big.partId).geometry });
    assert.strictEqual(quotesDB.getById(small.body.quoteId).orderTotal, small.body.orderTotal, "the stored total is still the small one");
    const before = sessionsCreated();
    const r = await checkout(small.body.quoteId);
    assert.deepStrictEqual([r.status, r.body.code, r.body.previousTotal], [409, "quote-changed", small.body.orderTotal], r.text);
    assert.ok(r.body.newTotal > small.body.orderTotal * 1.5, `${small.body.orderTotal} → ${r.body.newTotal}`);
    assert.strictEqual(sessionsCreated(), before);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === small.body.quoteId).length, 0);
    assert.strictEqual(quotesDB.getById(small.body.quoteId).orderTotal, r.body.newTotal, "the quote now holds today's price");
    const again = await checkout(small.body.quoteId);
    assert.strictEqual(again.status, 200, again.text);
    assert.strictEqual(ordersDB.getById(again.body.orderId).total, r.body.newTotal);
    // And a part changed after it is on an order shows on the traveler.
    partsDB.update(part.partId, { geometry: partsDB.getById(panel.partId).geometry });
    const traveler = await h.get(`/api/orders/${again.body.orderId}/traveler`, owner);
    assert.strictEqual(traveler.body.items[0].matchesPriced, false, "the traveler says the stored part is not what was charged for");
  });

  test("F2 / F-04: the price hold — honoured only for exactly what was priced, inside its window, with the gate and the catalog checked again", async () => {
    const cube = await upload("hold.stl", boxStl(30), {}, buyer);
    const config = { partId: cube.partId, materialSlug: "cnc-brass-360", process: "cnc", quantity: 20 };
    const held = await quote([config]);
    const lower = await quote([{ ...config, quantity: 2 }]);   // for the "too far" case
    const gated = await quote([config]);   // for the gate case
    const gone = await quote([config]);    // for the material case
    const legacy = await quote([config]);  // a quote from before fingerprints
    quotesDB.update(legacy.body.quoteId, { config: { process: "cnc", parts: [config] } });
    const lateRow = await quote([config]); // outside its window
    // The owner raises prices.
    const up = await h.put("/api/admin/pricing", { rules: { cncMachineRatePerHour: 130, marginPercent: 0.55 }, note: "test: raise prices" }, owner);
    assert.strictEqual(up.status, 200, up.text);
    const today = await quote([config]);
    assert.ok(today.body.orderTotal > held.body.orderTotal + 1, `${held.body.orderTotal} → ${today.body.orderTotal}`);
    // Same parts, same setup, same gate answer, inside 30 days: the price the buyer was given is honoured.
    const a = await checkout(held.body.quoteId);
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(ordersDB.getById(a.body.orderId).total, held.body.orderTotal);
    assert.strictEqual(orderItemsDB.query((i) => i.orderId === a.body.orderId)[0].config.priced.basis, "held");
    // A quote from before fingerprints cannot prove it is the same thing: today's price.
    const b = await checkout(legacy.body.quoteId);
    assert.deepStrictEqual([b.status, b.body.code, b.body.newTotal], [409, "quote-changed", today.body.orderTotal], b.text);
    // Past its window: expired, as before.
    quotesDB.update(lateRow.body.quoteId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.deepStrictEqual([(await checkout(lateRow.body.quoteId)).status], [410]);
    // The material is switched off: a held price does not keep it for sale.
    const brass = materialsDB.getAll().find((m) => m.slug === "cnc-brass-360");
    assert.strictEqual((await h.put(`/api/admin/materials/${brass.id}`, { active: false }, owner)).status, 200);
    const c = await checkout(gone.body.quoteId);
    assert.deepStrictEqual([c.status, c.body.code, c.body.reason], [409, "quote-needs-update", "material-not-offered"], c.text);
    await h.put(`/api/admin/materials/${brass.id}`, { active: true }, owner);
    // The owner tightens the gate: a quote priced before is gated again at checkout.
    await h.put("/api/admin/pricing", { rules: { rfqQuantityThreshold: 10 }, note: "test: tighten the gate" }, owner);
    const d = await checkout(gated.body.quoteId);
    assert.deepStrictEqual([d.status, d.body.code], [409, "rfq-required"], d.text);
    assert.ok(d.body.reasons.some((r) => r.code === "quantity"));
    await h.put("/api/admin/pricing", { rules: { rfqQuantityThreshold: 100 }, note: "test: back" }, owner);
    // A held price that is under half of today's is not honoured without the buyer seeing today's.
    await h.put("/api/admin/pricing", { rules: { cncMachineRatePerHour: 400, marginPercent: 0.8 }, note: "test: far higher" }, owner);
    const e = await checkout(lower.body.quoteId);
    assert.deepStrictEqual([e.status, e.body.code], [409, "quote-changed"], e.text);
    assert.ok(e.body.newTotal > lower.body.orderTotal * 2);
    assert.strictEqual((await h.post("/api/admin/pricing/reset", { note: "test: defaults" }, owner)).status, 200);
  });

  test("F-04: one quote makes one order; the buyer's own unpaid order is resumed on the same Stripe session (F8); 'void open quotes' ends every price hold", async () => {
    const cube = await upload("once.stl", boxStl(25), {}, buyer);
    const q = await quote([{ partId: cube.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 3 }]);
    const first = await checkout(q.body.quoteId);
    assert.strictEqual(first.status, 200, first.text);
    const n = sessionsCreated();
    // Back from Stripe without paying: the same order, the same session.
    const back = await checkout(q.body.quoteId);
    assert.deepStrictEqual([back.status, back.body.orderId, back.body.sessionUrl], [200, first.body.orderId, first.body.sessionUrl]);
    assert.strictEqual(sessionsCreated(), n, "no second Stripe session was made");
    // Paid: the quote is used up.
    h.pay(ordersDB.getById(first.body.orderId).stripeSessionId);
    assert.strictEqual((await h.post(`/api/orders/${first.body.orderId}/confirm-payment`, {}, buyer)).body.status, "paid");
    const second = await checkout(q.body.quoteId);
    assert.deepStrictEqual([second.status, second.body.code, second.body.orderId], [409, "quote-already-ordered", first.body.orderId], second.text);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 1);
    assert.strictEqual(sessionsCreated(), n);
    // To buy again there is reorder, which prices at today's rules through the same choke point.
    const re = await h.post(`/api/orders/${first.body.orderId}/reorder`, {}, buyer);
    assert.strictEqual(re.status, 201, re.text);
    assert.ok(quotesDB.getById(re.body.quoteId).config.integrity.fingerprint);
    // The per-account limiter on asking for a checkout.
    checkoutGuard.resetForTests();
    let last;
    for (let i = 0; i < 13; i++) last = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.deepStrictEqual([last.status, last.body.code], [429, "checkout-rate-limited"]);
    checkoutGuard.resetForTests();
    // Void open quotes: every draft's hold ends now; orders and requests are untouched.
    const open = await quote([{ partId: cube.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 2 }]);
    assert.strictEqual((await h.post("/api/admin/quotes/void-open", { note: "x" }, buyer)).status, 403, "the owner's action only");
    const voided = await h.post("/api/admin/quotes/void-open", { note: "prices went up" }, owner);
    assert.strictEqual(voided.status, 200, voided.text);
    assert.ok(voided.body.voided >= 1);
    assert.strictEqual(quotesDB.query((x) => x.status === "draft" && new Date(x.expiresAt) > new Date()).length, 0);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).status, "ordered");
    const dead = await checkout(open.body.quoteId);
    assert.deepStrictEqual([dead.status, dead.body.code], [410, "quote-expired"]);
    assert.strictEqual((await h.get(`/api/quote/${open.body.quoteId}`, buyer)).body.expired, true);
    // Reopening prices it again and restarts the hold.
    const reopened = await quote([{ partId: cube.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 2 }], buyer, { quoteId: open.body.quoteId });
    assert.strictEqual(reopened.body.quoteId, open.body.quoteId);
    assert.strictEqual((await checkout(open.body.quoteId)).status, 200);
  });

  // ═══ F-03 — the gate looks at what is being bought ═══════════════════════
  test("F-03: quantity is summed per part, per identical geometry and per order; the big-ticket limit covers the order; each line is judged on its own DFM result", async () => {
    const cube = await upload("run.stl", boxStl(20), {}, buyer);
    const twin = await upload("run-copy.stl", boxStl(20), {}, buyer);
    const other = await upload("other.stl", boxStl(22), {}, buyer);
    const line = (partId, quantity) => ({ partId, materialSlug: "cnc-aluminum-6061", process: "cnc", quantity });
    const codes = (q) => q.body.gate.reasons.map((r) => r.code);
    // a. 500 pieces as five lines of 100
    const single = await quote([line(cube.partId, 500)]);
    assert.ok(codes(single).includes("quantity"));
    const split = await quote(Array.from({ length: 5 }, () => line(cube.partId, 100)));
    assert.strictEqual(split.body.gate.requiresRfq, true, JSON.stringify(split.body.gate));
    assert.ok(split.body.gate.reasons.some((r) => r.code === "quantity" && /500 pieces of this part across 5 lines/.test(r.message) && /quoted by a person/.test(r.message)));
    assert.deepStrictEqual([(await checkout(split.body.quoteId)).body.code], ["rfq-required"]);
    // …the same drawing uploaded twice is the same run
    const twins = await quote([line(cube.partId, 60), line(twin.partId, 60)]);
    assert.ok(twins.body.gate.requiresRfq && codes(twins).includes("quantity"), JSON.stringify(twins.body.gate));
    // …and so is an order of different parts that adds up to a production run
    const mixed = await quote([line(cube.partId, 60), line(other.partId, 60)]);
    assert.ok(mixed.body.gate.requiresRfq && codes(mixed).includes("order-quantity"), JSON.stringify(mixed.body.gate));
    const under = await quote([line(cube.partId, 50), line(other.partId, 50)]);
    assert.strictEqual(under.body.gate.requiresRfq, false, "a hundred pieces in all is still an instant order");
    // A single line over the limit says so once, not three times (the vetting results depend on it).
    assert.deepStrictEqual(codes(single).filter((c) => /quantity/.test(c)), ["quantity"]);
    // b. the big-ticket limit over the order
    const tray = await upload("tray.stl", boxStl([200, 150, 40]), {}, buyer);
    const t = (quantity) => ({ partId: tray.partId, materialSlug: "cnc-aluminum-6061", process: "cnc", quantity });
    const one = await quote([t(60)]);
    const three = await quote([t(20), t(20), t(20)]);
    assert.ok(one.body.lineItems[0].lineTotal > 5000 && codes(one).includes("big-ticket"), `one line: ${one.body.lineItems[0].lineTotal}`);
    assert.ok(three.body.lineItems.every((li) => li.lineTotal < 5000) && three.body.subtotal > 5000, "each line is under the limit, the order is over it");
    assert.ok(three.body.gate.requiresRfq && codes(three).includes("big-ticket-order"), JSON.stringify(three.body.gate));
    assert.deepStrictEqual([(await checkout(three.body.quoteId)).body.code], ["rfq-required"]);
    assert.ok(!codes(one).includes("big-ticket-order"), "a single line over the limit says so once");
    // c. a line the gate stops is not rescued by another line for the same part
    const bar = await upload("bar.stl", boxStl([700, 120, 25.4]), {}, buyer);
    const cncLine = { partId: bar.partId, materialSlug: "cnc-aluminum-6061", process: "cnc", quantity: 5 };
    const routedLine = { partId: bar.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 25.4, quantity: 1 };
    const alone = await quote([cncLine]);
    assert.strictEqual(alone.body.gate.requiresRfq, true, "too long for the mill on its own");
    for (const order of [[cncLine, routedLine], [routedLine, cncLine]]) {
      const both = await quote(order);
      assert.strictEqual(both.body.gate.requiresRfq, true, `gate with the lines as ${order.map((l) => l.process).join(" + ")}: ${JSON.stringify(both.body.gate.reasons.map((r) => r.code))}`);
      assert.strictEqual(both.body.dfmByLine.length, 2, "DFM is reported per line");
      assert.deepStrictEqual([(await checkout(both.body.quoteId)).body.code], ["rfq-required"]);
    }
    // The gated quote goes to the firm-quote form with its lines carried over.
    const rfq = await h.form("/api/rfq", { quoteId: split.body.quoteId, contactName: "Pat Buyer", email: "pat@buyer.test" }, {}, buyer);
    assert.strictEqual(rfq.status, 201, rfq.text);
    const stored = h.models.rfqsDB.getById(rfq.body.rfqId);
    assert.strictEqual(stored.parts.length, 5);
    assert.ok(stored.reasons.some((r) => r.code === "quantity"));
  });

  test("N1: a 3D model routed from stock thinner than the model goes to a person (it was priced at the thinner stock and sold)", async () => {
    const slab = await upload("slab.stl", boxStl([200, 150, 19]), {}, buyer);
    const fits = await quote([{ partId: slab.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 19.1, quantity: 5 }]);
    assert.strictEqual(fits.body.gate.requiresRfq, false);
    const thin = await quote([{ partId: slab.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 9.5, quantity: 5 }]);
    assert.strictEqual(thin.status, 200, thin.text);
    assert.ok(thin.body.orderTotal < fits.body.orderTotal, "the thinner stock is the cheaper price");
    assert.ok(thin.body.gate.requiresRfq && thin.body.gate.reasons.some((r) => r.code === "stock-thinner-than-model"), JSON.stringify(thin.body.gate));
    assert.deepStrictEqual([(await checkout(thin.body.quoteId)).body.code], ["rfq-required"]);
    // Far thinner than the model: the material in the part is worth more than the price, and the floor refuses it outright.
    const paper = await quote([{ partId: block.partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 1.6, quantity: 1 }]);
    assert.ok(paper.status === 422 || paper.body.gate.requiresRfq, paper.text.slice(0, 200));
  });

  // ═══ The single expected-charge function ═════════════════════════════════
  test("expectedCharge(order) is the order total in whole cents — the one number the Stripe session is built to", async () => {
    const { expectedCharge } = require("../services/expectedCharge");
    assert.deepStrictEqual(expectedCharge({ total: 169.22 }), { cents: 16922, dollars: 169.22, components: { orderTotal: 16922 } });
    assert.strictEqual(expectedCharge({ total: 0.1 + 0.2 }).cents, 30);
    for (const bad of [{}, { total: null }, { total: "abc" }, { total: NaN }, null]) assert.strictEqual(expectedCharge(bad).cents, 0);
    const cube = await upload("charge.stl", boxStl(24), {}, buyer);
    const q = await quote([{ partId: cube.partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 2 }], buyer, { paperwork: true });
    const c = await checkout(q.body.quoteId);
    const order = ordersDB.getById(c.body.orderId);
    const sent = h.stripe.created[sessionsCreated() - 1];
    assert.strictEqual(sent.line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0), expectedCharge(order).cents);
    assert.strictEqual(expectedCharge(order).cents, Math.round(q.body.orderTotal * 100));
  });

  test("the pieces: fingerprints are stable and sensitive; the firm-quote amount must be money", () => {
    const part = partsDB.getById(block.partId);
    const a = quoteIntegrity.geometryHash(part.geometry);
    assert.strictEqual(a, quoteIntegrity.geometryHash(JSON.parse(JSON.stringify(part.geometry))), "the same geometry hashes the same, whatever the key order or the round trip");
    assert.strictEqual(a, quoteIntegrity.geometryHash({ ...part.geometry, meshData: { positions: [1, 2, 3] } }), "the preview mesh is not part of a price");
    assert.strictEqual(a, quoteIntegrity.geometryHash({ ...part.geometry, features: { ...(part.geometry.features || {}), timings: { total: 999 } } }), "nor is how long the parser took");
    assert.notStrictEqual(a, quoteIntegrity.geometryHash({ ...part.geometry, volume: part.geometry.volume * 1.0001 }));
    assert.notStrictEqual(a, quoteIntegrity.geometryHash({ ...part.geometry, boundingBox: { ...part.geometry.boundingBox, width: part.geometry.boundingBox.width + 0.01 } }));
    for (const [v, want] of [[4250, 4250], ["4250.50", 4250.5], [12.345, 12.35], [0, 0]]) assert.deepStrictEqual(quoteIntegrity.firmQuoteAmount(v), { ok: true, total: want });
    for (const v of [-1, NaN, Infinity, "abc", "", null, undefined, {}, [], 1e9]) assert.strictEqual(quoteIntegrity.firmQuoteAmount(v).ok, false, String(v));
    assert.strictEqual(quoteIntegrity.firmQuoteAmount(0, { sending: true }).ok, false, "a firm quote of nothing is not sent");
  });

  test("the owner's firm-quote amount goes through the same check: NaN, negative and absurd amounts are refused, and a price far under the estimate is flagged", async () => {
    const cube = await upload("firm.stl", boxStl(40), {}, buyer);
    const q = await quote([{ partId: cube.partId, materialSlug: "cnc-peek", process: "cnc", quantity: 150 }]);
    const rfq = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Pat Buyer", email: "pat@buyer.test" }, {}, buyer);
    assert.strictEqual(rfq.status, 201, rfq.text);
    for (const quotedTotal of ["abc", -5, 1e12, null]) {
      const bad = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { quotedTotal }, owner);
      assert.deepStrictEqual([bad.status, bad.body.code], [400, "quoted-total-invalid"], String(quotedTotal));
    }
    const zero = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { status: "quoted", quotedTotal: 0, quotedLeadDays: 10 }, owner);
    assert.strictEqual(zero.status, 400, "a zero total cannot be sent");
    const slip = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { quotedTotal: 37 }, owner);
    assert.strictEqual(slip.status, 200);
    assert.ok(/less than a quarter/.test(slip.body.priceWarning), "a slipped digit is pointed out");
    const fair = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { quotedTotal: 33712.126 }, owner);
    assert.strictEqual(fair.body.quotedTotal, 33712.13, "stored in whole cents");
    assert.strictEqual(fair.body.priceWarning, undefined);
    // F-09b (payments review): once the quote is out, its link is live at whatever is saved — so not at nothing.
    const out = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { status: "quoted", quotedLeadDays: 10 }, owner);
    assert.strictEqual(out.status, 200, out.text);
    for (const quotedTotal of [0, "0", 0.004]) {
      const nothing = await h.put(`/api/rfq/admin/${rfq.body.rfqId}`, { quotedTotal }, owner);
      assert.deepStrictEqual([nothing.status, nothing.body.code], [400, "quoted-total-invalid"], `${quotedTotal}: ${nothing.text}`);
    }
    assert.strictEqual(h.models.rfqsDB.getById(rfq.body.rfqId).quotedTotal, 33712.13, "the amount that is out is unchanged");
  });

  await run(async () => { console.error = realError; await h.stop(); });
})();
