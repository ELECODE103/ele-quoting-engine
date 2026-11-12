#!/usr/bin/env node
/**
 * RR-02 (second half): once the database is held at its "visitors paused" line, the pressure pass
 * removes the WRONG rows: a real visitor's quote that has sat for five minutes, and a customer's
 * uploaded part that is not on a quote yet, while the flood's own drafts (re-priced every two
 * minutes, which nothing limits) are never old enough to go.
 * A passing fix: victimQuoteAfter is 200 and customerPartAfter prices, or the flood's drafts are the ones removed.
 *
 *   node tools/security/rereview-availability/eviction-collateral.js [minutes=6.5]
 *
 * Every age and limit is the default (5 minutes untouched once visitors are being refused) except
 * DB_MAX_MB, 4 instead of 64, so two addresses fill it in seconds instead of twenty-five in an hour.
 * Takes about seven minutes.
 */
const c = require("./common");

(async () => {
  const minutes = Number(process.argv[2]) || 6.5;
  const s = await c.startServer({ stubs: true, env: { DB_MAX_MB: "4" } });
  try {
    // ── Real people, before anything happens ──
    const V = "203.0.113.41";
    const vPart = await c.uploadOne(s, "bracket.stl", c.g.stlCube(25), { ip: V });
    const { line: cnc } = await c.lineFor(s, vPart.partId, "cnc", V);
    const vLine = { ...cnc, subProcess: "milling" };
    const vQuote = await s.post("/api/quote", { parts: [vLine], leadTimeSlug: "standard" }, { ip: V });
    // A customer with a confirmed email uploads a DXF and has not picked a thickness yet (nothing can be priced until they do).
    const C = "203.0.113.42";
    const cTok = await s.register("customer@example.test", { ip: C });
    const cPart = await c.uploadOne(s, "panel.dxf", c.g.dxfPlate(6), { ip: C, token: cTok, fields: { process: "routing" } });
    const { line: cLine } = await c.lineFor(s, cPart.partId, "routing", C);
    // The same customer's saved quote (control: must survive).
    const cPart2 = await c.uploadOne(s, "block.stl", c.g.stlCube(40), { ip: C, token: cTok });
    const cQuote = await s.post("/api/quote", { parts: [{ ...vLine, partId: cPart2.partId }], leadTimeSlug: "standard" }, { ip: C, token: cTok });
    const t0 = Date.now();

    // ── The flood: drafts of 25 different lines, 30 per address, until new quotes pause ──
    const aPart = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip: "192.0.2.200" });
    const body = (id) => ({ parts: c.distinctLines({ ...vLine, partId: aPart.partId }, 25), leadTimeSlug: "standard", ...(id ? { quoteId: id } : {}) });
    const drafts = []; let addresses = 0; let paused = false;
    for (let a = 0; a < 30 && !paused; a++) {
      const ip = `192.0.2.${201 + a}`; addresses++;
      for (let i = 0; i < 30; i++) {
        const r = await s.post("/api/quote", body(), { ip });
        if (r.status === 200) { drafts.push({ id: r.body.quoteId, ip }); continue; }
        if (r.status === 429 && r.body && r.body.code !== "quote-limit") { await c.sleep(1500); i--; continue; }
        if (r.body && r.body.code === "quotes-paused") paused = true;
        break;
      }
    }
    c.log(`flood: ${drafts.length} drafts from ${addresses} addresses, database ${(c.dbBytes(s) / c.MB).toFixed(1)} MB of 4 MB, new quotes paused: ${paused}`);

    // ── Hold it: re-price every draft every two minutes, and knock every 25 s so the pressure pass runs ──
    let rounds = 0; let rePrices = 0;
    const until = t0 + minutes * 60000;
    let nextRefresh = Date.now() + 120000;
    while (Date.now() < until) {
      // A refused UPLOAD makes the server run its clean-up at once (at most every 20 s); a refused new quote does not,
      // so without this the pass runs only on its five-minute timer.
      await s.upload([{ name: "knock.stl", data: c.g.stlCube(10) }], { ip: "192.0.2.250" });
      if (Date.now() >= nextRefresh) {
        for (const d of drafts) { const r = await s.post("/api/quote", body(d.id), { ip: d.ip }); if (r.status === 200) rePrices++; else if (r.status === 429) await c.sleep(1200); await c.sleep(250); }
        rounds++; nextRefresh = Date.now() + 120000;
      }
      await c.sleep(25000);
    }
    await c.sleep(3000);

    // ── What the real people find ──
    const vGet = await s.get(`/api/quote/${vQuote.body.quoteId}`, { ip: V });
    const vAgain = await s.post("/api/quote", { parts: [{ ...vLine, quantity: 2 }], leadTimeSlug: "standard", quoteId: vQuote.body.quoteId }, { ip: V });
    const cPrice = await s.post("/api/quote", { parts: [cLine], leadTimeSlug: "standard" }, { ip: C, token: cTok });
    const cGet = await s.get(`/api/quote/${cQuote.body.quoteId}`, { ip: C, token: cTok });
    const alive = [];
    for (const d of drafts.slice(0, 10)) alive.push((await s.get(`/api/quote/${d.id}`, { ip: d.ip })).status);
    const relief = (s.log().match(/Database at \d+% of its ceiling: removed[^\n]*/g) || []);
    c.result({
      test: "eviction-collateral", minutesHeld: minutes, dbMaxMb: 4,
      flood: { addresses, drafts: drafts.length, rePriceRounds: rounds, rePrices, databaseMbNow: Number((c.dbBytes(s) / c.MB).toFixed(2)), firstTenDraftsStillThere: alive.filter((x) => x === 200).length },
      visitorWithoutAccount: { quoteBefore: vQuote.status, quoteAfter: vGet.status, changingTheQuantityNow: { status: vAgain.status, code: (vAgain.body && vAgain.body.code) || "", error: vAgain.status === 200 ? "" : String(vAgain.body && vAgain.body.error).slice(0, 90) } },
      confirmedCustomer: { partUploadedButNotYetPriced: { status: cPrice.status, error: cPrice.status === 200 ? "" : String(cPrice.body && cPrice.body.error).slice(0, 90) }, savedQuoteAfter: cGet.status },
      pressurePassLog: relief,
    });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
