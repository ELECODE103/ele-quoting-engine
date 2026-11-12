/**
 * The bot check and the request forms, end to end against the real routes.
 * Run: `node server/routes/botCheck.test.js`
 *
 * Covers: the public config endpoint, the verified-human token in front of
 * upload / pricing / DXF units, both request forms with and without a passed
 * check (emails sent or withheld, the ship-to address given or not), the
 * always-on checks (honeypot, minimum time, limits, duplicates), the caps on
 * confirmation emails, and what a typed value can and cannot put in an email.
 *
 * Turnstile runs with throwaway keys and a stubbed siteverify; emails are
 * captured. Nothing leaves the machine.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Bot check and request forms");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const h = await start({ mailer: "configured" });
  const { rfqsDB, quotesDB, partsDB, orderItemsDB } = h.models;
  const botGuard = require("../security/botGuard");
  const tokens = require("../security/tokens");
  const shipFrom = require("../config/shipFrom.json");
  const dxfWriter = require("../geometry/dxf/writer");
  const cube = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const drawingDir = path.join(__dirname, "..", "..", "data", "rfq-drawings");
  h.limits = true; // this suite tests the limits, so the counters keep running; it resets them itself

  const SHOP = "owner@shop.test";
  let n = 0;
  /** A request-form post with exactly these headers. Fields are unique per call unless given. */
  function rfq(fields = {}, { headers = {}, files = {}, token, ip } = {}) {
    n++;
    const fd = new FormData();
    const all = { contactName: "Pat Purchasing", email: `pat${n}@oem.test`, notes: `request ${n}`, ...fields };
    for (const [k, v] of Object.entries(all)) fd.append(k, v);
    for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([f.data]), f.name);
    return h.raw("POST", "/api/rfq", { body: fd, headers, token, ip });
  }
  const passed = (over = {}) => ({ "X-Form-Token": h.formToken("rfq"), "X-Turnstile-Token": "pass-rfq", ...over });
  const unchecked = (over = {}) => ({ "X-Form-Token": h.formToken("rfq"), ...over });
  const toShop = () => h.sent.filter((m) => m.to === SHOP);
  const toOthers = () => h.sent.filter((m) => m.to !== SHOP);
  const fresh = () => { h.sent.length = 0; botGuard.resetForTests(); };
  const addressIn = (text) => text.includes(shipFrom.address) || text.includes(shipFrom.zip);
  function withoutTurnstile(fn) {
    const keep = { s: process.env.TURNSTILE_SITE_KEY, k: process.env.TURNSTILE_SECRET_KEY };
    delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
    return Promise.resolve().then(fn).finally(() => { process.env.TURNSTILE_SITE_KEY = keep.s; process.env.TURNSTILE_SECRET_KEY = keep.k; });
  }

  // ═══ What the browser is told ═════════════════════════════════
  test("the site key reaches the browser through /api/public/config; the secret never does", async () => {
    const on = await h.raw("GET", "/api/public/config");
    assert.strictEqual(on.status, 200);
    assert.strictEqual(on.body.turnstileSiteKey, process.env.TURNSTILE_SITE_KEY);
    assert.strictEqual(on.body.botCheck, true);
    assert.strictEqual(on.body.emailVerification, true);
    assert.strictEqual(on.headers.get("cache-control"), "no-store");
    assert.ok(!on.text.includes(process.env.TURNSTILE_SECRET_KEY) && !on.text.includes(process.env.JWT_SECRET));
    await withoutTurnstile(async () => {
      const off = await h.raw("GET", "/api/public/config");
      assert.strictEqual(off.body.turnstileSiteKey, "");
      assert.strictEqual(off.body.botCheck, false);
    });
    const ft = await h.raw("GET", "/api/public/form-token?form=rfq");
    assert.strictEqual(ft.status, 200);
    assert.strictEqual(ft.body.minSeconds, 3);
    assert.strictEqual(tokens.verify("form", ft.body.formToken).claims.form, "rfq");
  });

  // ═══ The quote tool: challenge once ═══════════════════════════
  test("one passed check is traded for a one-hour verified-human token; a failed one is not", async () => {
    const bad = await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "fail" } });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.body.humanToken, undefined);
    assert.strictEqual((await h.raw("POST", "/api/human/verify", { json: {} })).status, 403);
    h.turnstile.mode = "down";
    assert.strictEqual((await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass" } })).status, 503, "an outage is not a pass");
    h.turnstile.mode = "pass";
    const before = h.turnstile.calls.length;
    const ok = await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" }, ip: "203.0.113.77" });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.expiresIn, 3600);
    assert.strictEqual(tokens.verify("human", ok.body.humanToken).ok, true);
    const call = h.turnstile.calls[before];
    assert.deepStrictEqual({ url: call.url, token: call.token, ip: call.remoteip, secret: call.secretSent }, { url: "https://challenges.cloudflare.com/turnstile/v0/siteverify", token: "pass-quote", ip: "203.0.113.77", secret: true });
  });

  const upload = (headers = {}, token) => {
    const fd = new FormData();
    fd.append("files", new Blob([cube]), "cube_20mm.stl");
    return h.raw("POST", "/api/upload", { body: fd, headers, token });
  };
  let partId, verified, unverified;
  test("anonymous upload and pricing need the verified-human token when the check is on", async () => {
    const before = partsDB.getAll().length;
    const none = await upload();
    assert.strictEqual(none.status, 403);
    assert.strictEqual(none.body.code, "human-check-required");
    assert.strictEqual((await upload({ "X-Human-Token": "junk" })).status, 403);
    assert.strictEqual((await upload({ "X-Human-Token": tokens.sign("form", { form: "rfq" }) })).status, 403, "a form token is not a human token");
    assert.strictEqual((await upload({ "X-Human-Token": tokens.sign("human", {}, { now: Date.now() - 61 * 60e3 }) })).status, 403, "expired after an hour");
    assert.strictEqual(partsDB.getAll().length, before, "nothing was stored or parsed");
    const beforeCalls = h.turnstile.calls.length;
    const ok = await upload({ "X-Human-Token": h.humanToken });
    assert.strictEqual(ok.status, 200, ok.text);
    partId = ok.body.parts[0].partId;
    const again = await upload({ "X-Human-Token": h.humanToken });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(h.turnstile.calls.length, beforeCalls, "no new challenge per file: the token is checked locally");
    // Pricing.
    const config = { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" };
    const quotesBefore = quotesDB.getAll().length;
    assert.strictEqual((await h.raw("POST", "/api/quote", { json: config })).status, 403);
    assert.strictEqual(quotesDB.getAll().length, quotesBefore);
    assert.strictEqual((await h.raw("POST", "/api/quote", { json: config, headers: { "X-Human-Token": h.humanToken } })).status, 200);
    // A drawing attached to a quote is a file written to disk: same gate.
    const quoteId = (await h.raw("POST", "/api/quote", { json: config, headers: { "X-Human-Token": h.humanToken } })).body.quoteId;
    const drawing = (headers) => { const fd = new FormData(); fd.append("drawing", new Blob([Buffer.from("%PDF-1.4 x")]), "print.pdf"); return h.raw("POST", `/api/quote/${quoteId}/drawing`, { body: fd, headers }); };
    assert.strictEqual((await drawing({})).status, 403);
    assert.strictEqual((await drawing({ "X-Human-Token": h.humanToken })).status, 200);
    // Reading stays open: prices, materials and a saved quote need no challenge.
    assert.strictEqual((await h.raw("GET", "/api/materials")).status, 200);
    assert.strictEqual((await h.raw("GET", `/api/quote/${quoteId}`)).status, 200);
  });

  test("a signed-in account with a confirmed email skips the challenge; an unconfirmed one does not", async () => {
    verified = await h.register("vera@buyer.test", "Vera Verified");
    unverified = await h.register("ursula@buyer.test", "Ursula Unconfirmed", { verify: false });
    h.sent.length = 0;
    assert.strictEqual((await upload({}, verified)).status, 200);
    assert.strictEqual((await h.raw("POST", "/api/quote", { json: { parts: [h.cncConfig(partId, 1)] }, token: verified })).status, 200);
    assert.strictEqual((await upload({}, unverified)).status, 403);
    assert.strictEqual((await upload({ "X-Human-Token": h.humanToken }, unverified)).status, 200, "it can still build a quote after the challenge");
  });

  test("with no keys the quote tool is open (and the startup warning says so)", () => withoutTurnstile(async () => {
    assert.strictEqual((await upload()).status, 200);
    const v = await h.raw("POST", "/api/human/verify", { json: {} });
    assert.deepStrictEqual(v.body, { required: false, humanToken: "", expiresIn: 0 });
  }));

  // ═══ DXF units: the uploader only ═════════════════════════════
  test("a DXF's units can be changed only by the browser that uploaded it, and not once it is on a request", async () => {
    const fd = new FormData();
    fd.append("process", "routing");
    fd.append("files", new Blob([dxfWriter.dxf({ entities: [dxfWriter.rect(0, 0, 6, 4), dxfWriter.circle(3, 2, 0.25)] })]), "plate.dxf");
    const up = await h.raw("POST", "/api/upload", { body: fd, headers: { "X-Human-Token": h.humanToken } });
    assert.strictEqual(up.status, 200, up.text);
    const part = up.body.parts[0];
    assert.ok(part.editKey && part.editKey.length >= 32, "the upload answer carries the part's edit key");
    const url = `/api/parts/${part.partId}/units`;
    const human = { "X-Human-Token": h.humanToken };
    const before = JSON.stringify(partsDB.getById(part.partId).geometry.boundingBox);
    // A guest who only knows the part id.
    assert.strictEqual((await h.raw("POST", url, { json: { units: "in" } })).status, 403, "no human token");
    assert.strictEqual((await h.raw("POST", url, { json: { units: "in" }, headers: human })).status, 404, "no edit key");
    assert.strictEqual((await h.raw("POST", url, { json: { units: "in" }, headers: { ...human, "X-Part-Key": "0".repeat(40) } })).status, 404);
    // Another signed-in user, and another part's key.
    assert.strictEqual((await h.raw("POST", url, { json: { units: "in" }, token: verified })).status, 404);
    assert.strictEqual((await h.raw("POST", url, { json: { units: "in" }, headers: { ...human, "X-Part-Key": tokens.partEditKey(partId) } })).status, 404);
    assert.strictEqual(JSON.stringify(partsDB.getById(part.partId).geometry.boundingBox), before, "nothing was changed");
    // The uploader.
    const ok = await h.raw("POST", url, { json: { units: "in" }, headers: { ...human, "X-Part-Key": part.editKey } });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.notStrictEqual(JSON.stringify(partsDB.getById(part.partId).geometry.boundingBox), before, "re-read at the chosen scale");
    // The edit key comes back when the uploader reopens their quote.
    const routing = h.models.materialsDB.getAll().find((m) => m.process === "routing" && m.active);
    const q = await h.raw("POST", "/api/quote", { json: { parts: [{ partId: part.partId, materialSlug: routing.slug, thicknessMm: (routing.thicknesses || [])[0]?.mm || (routing.thicknesses || [])[0] || 6.35, quantity: 2, process: "routing" }], process: "routing" }, headers: human });
    assert.strictEqual(q.status, 200, q.text);
    // Reopening a quote is a quote-tool call like the others: without the verified-human token it is refused.
    assert.strictEqual((await h.raw("GET", `/api/quote/${q.body.quoteId}/session`)).status, 403);
    const s = await h.raw("GET", `/api/quote/${q.body.quoteId}/session`, { headers: human });
    assert.strictEqual(s.body.parts[0].editKey, part.editKey);
    // Once the part is on an order line, its geometry is fixed.
    const item = orderItemsDB.insert({ orderId: "some-order", partId: part.partId, fileName: "plate.dxf", quantity: 1 });
    const locked = await h.raw("POST", url, { json: { units: "mm" }, headers: { ...human, "X-Part-Key": part.editKey } });
    assert.strictEqual(locked.status, 409);
    assert.strictEqual(locked.body.code, "part-locked");
    orderItemsDB.delete(item.id);
  });

  // ═══ Request forms: a passed check ════════════════════════════
  test("firm-quote form, check passed: the request is stored as verified, the shop is told, and the buyer gets a confirmation", async () => {
    fresh();
    const r = await rfq({ email: "pat@oem.test", company: "OEM Co", quantities: "500 / 1000" }, { headers: passed() });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual({ v: r.body.senderVerified, e: r.body.confirmationEmail }, { v: true, e: true });
    assert.strictEqual(r.body.noEmailReason, undefined, "an email went out, so there is no reason for not sending one");
    const row = rfqsDB.getById(r.body.rfqId);
    assert.strictEqual(row.senderCheck, "turnstile");
    assert.strictEqual(row.buyerEmailed, true);
    assert.strictEqual(h.sent.length, 2);
    const shop = toShop()[0], buyer = toOthers()[0];
    assert.strictEqual(buyer.to, "pat@oem.test");
    assert.strictEqual(buyer.replyTo, SHOP);
    assert.strictEqual(shop.replyTo, "pat@oem.test", "a verified sender's address is the reply-to");
    assert.ok(!/unverified/i.test(shop.subject + shop.text));
    assert.strictEqual(shop.subject, `RFQ: ${r.body.rfqId.slice(0, 8).toUpperCase()} — ? part(s)`);
  });

  test("send-us-the-part form, check passed: the reference and ship-to address are on the screen and in the buyer's email", async () => {
    fresh();
    const r = await rfq({ requestType: "part", returnPart: "true", email: "sam@plant.test", contactName: "Sam Maint" }, { headers: passed() });
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(r.body.shipTo && addressIn(r.body.shipTo.lines.join(" ")));
    assert.strictEqual(r.body.shipToPending, undefined);
    assert.strictEqual(r.body.reference, r.body.rfqId.slice(0, 8).toUpperCase());
    const buyer = toOthers()[0];
    assert.strictEqual(buyer.to, "sam@plant.test");
    assert.ok(addressIn(buyer.text) && buyer.text.includes(r.body.reference));
    assert.ok(/was told to write/.test(toShop()[0].text));
  });

  // ═══ Request forms: no passed check ═══════════════════════════
  test("check on, no token or a rejected token: the request is refused, nothing is stored, nobody is emailed, the attachment is deleted", async () => {
    fresh();
    const rows = rfqsDB.getAll().length;
    const files = () => new Set(fs.readdirSync(drawingDir));
    const before = files();
    const pdf = { drawing: { name: "print.pdf", data: Buffer.from("%PDF-1.4 test") } };
    const none = await rfq({ requestType: "part" }, { headers: unchecked(), files: pdf });
    assert.strictEqual(none.status, 403);
    assert.strictEqual(none.body.code, "human-check-required");
    assert.ok(!addressIn(none.text));
    const rejected = await rfq({ requestType: "part" }, { headers: passed({ "X-Turnstile-Token": "fail-token" }), files: pdf });
    assert.strictEqual(rejected.status, 403);
    assert.ok(!addressIn(rejected.text));
    // The quote tool's token is not a pass for this form: each request needs its own fresh check.
    const reuse = await rfq({ requestType: "part" }, { headers: unchecked({ "X-Human-Token": h.humanToken }) });
    assert.strictEqual(reuse.status, 403);
    assert.strictEqual(rfqsDB.getAll().length, rows);
    assert.strictEqual(h.sent.length, 0);
    await sleep(50);
    assert.deepStrictEqual([...files()].filter((f) => !before.has(f)), [], "refused uploads are not kept");
    // The form token of a refused request can be used again once the check is done.
    const ft = h.formToken("rfq");
    assert.strictEqual((await rfq({ email: "retry@oem.test", notes: "retry" }, { headers: { "X-Form-Token": ft } })).status, 403);
    assert.strictEqual((await rfq({ email: "retry@oem.test", notes: "retry" }, { headers: { "X-Form-Token": ft, "X-Turnstile-Token": "pass" } })).status, 201);
  });

  test("Cloudflare unreachable: the request is kept as an UNVERIFIED sender. The shop is told so; the typed address gets no email and no ship-to address", async () => {
    fresh();
    h.turnstile.mode = "down";
    let r;
    try { r = await rfq({ requestType: "part", email: "stranger@elsewhere.test", contactName: "Sam Maint" }, { headers: passed() }); }
    finally { h.turnstile.mode = "pass"; }
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual({ v: r.body.senderVerified, e: r.body.confirmationEmail, pending: r.body.shipToPending }, { v: false, e: false, pending: true });
    assert.strictEqual(r.body.noEmailReason, "sender-unverified", "the page is told why, so it does not promise an email");
    assert.strictEqual(r.body.shipTo, undefined);
    assert.ok(!addressIn(r.text), "the address is nowhere in the response");
    assert.ok(r.body.reference, "the reference still is");
    assert.strictEqual(toOthers().length, 0, "nothing was emailed to the typed address");
    const shop = toShop()[0];
    assert.ok(/\[unverified sender\]$/.test(shop.subject));
    assert.ok(/UNVERIFIED SENDER/.test(shop.text) && /No confirmation was emailed/.test(shop.text));
    assert.ok(/was NOT given the ship-to address/.test(shop.text));
    assert.ok(!shop.replyTo, "no reply-to: a reply cannot be steered to an address nobody checked");
    assert.ok(shop.text.includes("stranger@elsewhere.test"), "the shop can still read the typed address");
    const row = rfqsDB.getById(r.body.rfqId);
    assert.strictEqual(row.senderCheck, "none");
    assert.strictEqual(row.buyerEmailed, false);
  });

  test("no keys configured: both forms still take requests, as unverified senders, with no buyer email and no address", () => withoutTurnstile(async () => {
    fresh();
    const quoteForm = await rfq({ email: "stranger1@elsewhere.test" }, { headers: unchecked() });
    const partForm = await rfq({ requestType: "part", email: "stranger2@elsewhere.test" }, { headers: unchecked() });
    assert.strictEqual(quoteForm.status, 201);
    assert.strictEqual(partForm.status, 201);
    assert.strictEqual(quoteForm.body.confirmationEmail, false);
    // What the page shows comes from these fields and nothing else (RfqPage.jsx): no email, the reason, no address.
    assert.deepStrictEqual([quoteForm.body.noEmailReason, partForm.body.noEmailReason, partForm.body.confirmationEmail], ["sender-unverified", "sender-unverified", false]);
    assert.ok(quoteForm.body.rfqId && partForm.body.reference, "a reference is always given");
    assert.strictEqual(partForm.body.shipTo, undefined);
    assert.strictEqual(partForm.body.shipToPending, true);
    assert.ok(!addressIn(partForm.text));
    assert.strictEqual(toOthers().length, 0);
    assert.strictEqual(toShop().length, 2);
    assert.ok(toShop().every((m) => /\[unverified sender\]$/.test(m.subject) && !m.replyTo));
    // A token typed in by hand counts for nothing when the check is off.
    const fake = await rfq({ requestType: "part", email: "stranger3@elsewhere.test" }, { headers: unchecked({ "X-Turnstile-Token": "pass-i-promise", "X-Human-Token": h.humanToken }) });
    assert.strictEqual(fake.body.senderVerified, false);
    assert.strictEqual(fake.body.shipTo, undefined);
  }));

  test("a signed-in account with a confirmed email is a verified sender for its own address, and only for that", () => withoutTurnstile(async () => {
    fresh();
    const own = await rfq({ requestType: "part", email: "vera@buyer.test" }, { headers: unchecked(), token: verified });
    assert.strictEqual(own.status, 201, own.text);
    assert.deepStrictEqual({ v: own.body.senderVerified, e: own.body.confirmationEmail }, { v: true, e: true });
    assert.ok(addressIn(own.body.shipTo.lines.join(" ")));
    assert.strictEqual(rfqsDB.getById(own.body.rfqId).senderCheck, "account");
    assert.strictEqual(toOthers().length, 1);
    assert.strictEqual(toOthers()[0].to, "vera@buyer.test");
    // The same account typing somebody else's address: no email goes to the stranger.
    h.sent.length = 0;
    const other = await rfq({ requestType: "part", email: "stranger@elsewhere.test" }, { headers: unchecked(), token: verified });
    assert.strictEqual(other.status, 201);
    assert.strictEqual(other.body.senderVerified, false);
    assert.strictEqual(other.body.shipTo, undefined);
    assert.strictEqual(toOthers().length, 0);
  }));

  test("an account that has not confirmed its email does not trigger buyer email, even with the check passed; the page is told to ask for confirmation", async () => {
    fresh();
    const r = await rfq({ email: "ursula@buyer.test" }, { headers: passed(), token: unverified });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.confirmationEmail, false);
    assert.strictEqual(r.body.needsEmailVerification, true);
    assert.strictEqual(r.body.noEmailReason, "account-unconfirmed");
    assert.strictEqual(toOthers().length, 0);
    const shop = toShop()[0];
    assert.ok(!/UNVERIFIED SENDER/.test(shop.text), "the check passed, so the sender is not flagged");
    assert.ok(/No confirmation email went to this address/.test(shop.text));
    assert.strictEqual(rfqsDB.getById(r.body.rfqId).buyerEmailed, false);
  });

  // ═══ Always-on checks ═════════════════════════════════════════
  test("honeypot: a filled hidden field gets an answer shaped like success, and nothing happens", async () => {
    fresh();
    const rows = rfqsDB.getAll().length;
    const r = await rfq({ requestType: "part", website: "https://spam.example" }, { headers: passed() });
    assert.strictEqual(r.status, 201);
    assert.ok(/^[0-9a-f-]{36}$/.test(r.body.rfqId));
    assert.strictEqual(rfqsDB.getById(r.body.rfqId), null, "no such request exists");
    assert.strictEqual(rfqsDB.getAll().length, rows);
    assert.strictEqual(h.sent.length, 0);
    assert.strictEqual(r.body.shipTo, undefined);
    assert.ok(!addressIn(r.text));
  });

  test("minimum time: a form sent back in under three seconds, or with no form token, is refused", async () => {
    fresh();
    const fast = await rfq({}, { headers: passed({ "X-Form-Token": h.formToken("rfq", 800) }) });
    assert.strictEqual(fast.status, 400);
    assert.strictEqual(fast.body.code, "too-fast");
    assert.strictEqual((await rfq({}, { headers: { "X-Turnstile-Token": "pass" } })).body.code, "form-token-missing");
    assert.strictEqual((await rfq({}, { headers: passed({ "X-Form-Token": h.formToken("register") }) })).body.code, "form-token-missing");
    assert.strictEqual((await rfq({}, { headers: passed({ "X-Form-Token": h.formToken("rfq", 13 * 3600e3) }) })).body.code, "form-expired");
    assert.strictEqual(h.sent.length, 0);
    // The real endpoint's token is too young the moment it is issued.
    const issued = (await h.raw("GET", "/api/public/form-token?form=rfq")).body.formToken;
    assert.strictEqual((await rfq({}, { headers: passed({ "X-Form-Token": issued }) })).body.code, "too-fast");
  });

  test("the same request twice (a double click, a retry) is one request and one set of emails", async () => {
    fresh();
    const fields = { email: "twice@oem.test", notes: "same words", quantities: "10" };
    const rows = rfqsDB.getAll().length;
    const first = await rfq(fields, { headers: passed() });
    const second = await rfq(fields, { headers: passed() });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.body.rfqId, first.body.rfqId);
    assert.strictEqual(second.body.duplicate, true);
    assert.strictEqual(rfqsDB.getAll().length, rows + 1);
    assert.strictEqual(h.sent.length, 2, "one to the shop, one to the buyer, once");
    // A different request from the same address is its own request.
    const third = await rfq({ ...fields, notes: "different words" }, { headers: passed() });
    assert.notStrictEqual(third.body.rfqId, first.body.rfqId);
    // A form token is spent with its request.
    const ft = h.formToken("rfq");
    assert.strictEqual((await rfq({ email: "a1@oem.test" }, { headers: passed({ "X-Form-Token": ft }) })).status, 201);
    assert.strictEqual((await rfq({ email: "a2@oem.test" }, { headers: passed({ "X-Form-Token": ft }) })).status, 409);
  });

  test("confirmation emails are capped at four a day per recipient: the fifth request is taken, the shop is told, the address gets nothing more", async () => {
    fresh();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rfq({ email: "target@victim.test", notes: `flood ${i}` }, { headers: passed() }));
    assert.deepStrictEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
    assert.deepStrictEqual(results.map((r) => r.body.confirmationEmail), [true, true, true, true, false]);
    assert.deepStrictEqual(results.map((r) => r.body.noEmailReason), [undefined, undefined, undefined, undefined, "daily-limit"]);
    assert.strictEqual(h.sent.filter((m) => m.to === "target@victim.test").length, 4);
    assert.strictEqual(toShop().length, 5);
    assert.ok(/No confirmation email went to this address/.test(toShop()[4].text));
  });

  test("confirmation emails are capped at eight a day per connection, whoever they are addressed to", async () => {
    fresh();
    const ip = "203.0.113.60";
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await rfq({ email: `victim${i}@many.test` }, { headers: passed(), ip }));
    assert.deepStrictEqual(results.map((r) => r.body.confirmationEmail), [true, true, true, true, true, true, true, true, false]);
    assert.strictEqual(toOthers().length, 8);
  });

  test("request limits: six an hour per email address and ten an hour per connection, then the phone number", async () => {
    fresh();
    for (let i = 0; i < 6; i++) assert.strictEqual((await rfq({ email: "busy@oem.test", notes: `n${i}` }, { headers: passed() })).status, 201);
    const seventh = await rfq({ email: "busy@oem.test", notes: "n7" }, { headers: passed() });
    assert.strictEqual(seventh.status, 429);
    assert.ok(/224-213-6727/.test(seventh.body.error));
    fresh();
    const ip = "203.0.113.61";
    for (let i = 0; i < 10; i++) assert.strictEqual((await rfq({}, { headers: passed(), ip })).status, 201);
    const eleventh = await rfq({}, { headers: passed(), ip });
    assert.strictEqual(eleventh.status, 429);
    assert.strictEqual((await rfq({}, { headers: passed(), ip: "203.0.113.62" })).status, 201, "another connection is unaffected");
    const rows = rfqsDB.getAll().length;
    assert.strictEqual((await rfq({}, { headers: passed(), ip })).status, 429);
    assert.strictEqual(rfqsDB.getAll().length, rows);
  });

  // ═══ What typed text can do ═══════════════════════════════════
  test("typed text cannot add a header, a recipient or markup: line breaks in a name, an address list, HTML in every field", async () => {
    fresh();
    for (const email of ["a@b.test\r\nBcc: victim@x.test", "a@b.test, victim@x.test", "\"Shop\" <victim@x.test>", "victim@x.test\nX-Header: 1"]) {
      const r = await rfq({ email }, { headers: passed() });
      assert.strictEqual(r.status, 400, JSON.stringify(email));
    }
    assert.strictEqual(h.sent.length, 0);
    const r = await rfq({
      contactName: "Dana\r\nBcc: victim@x.test",
      email: "dana@oem.test",
      company: "<script>alert(1)</script>Co\r\nSubject: hijacked",
      phone: "\"><img src=x onerror=alert(1)>",
      notes: "<a href=\"https://evil.example\">click</a>\r\nline two",
      quantities: "5 <b>bold</b>",
    }, { headers: passed() });
    assert.strictEqual(r.status, 201, r.text);
    const row = rfqsDB.getById(r.body.rfqId);
    assert.ok(!/[\r\n]/.test(row.contactName), "a name is one line");
    for (const m of h.sent) {
      assert.ok(!/[\r\n]/.test(m.subject));
      for (const typed of ["Dana", "Bcc", "victim", "hijacked", "Co", "script", "evil"]) assert.ok(!m.subject.includes(typed), `subject carries typed text: ${m.subject}`);
      for (const raw of ["<script>", "<img", "evil.example\"", "href=\"https://evil", "<b>bold"]) assert.ok(!m.html.includes(raw), `raw ${raw} in an email`);
      assert.ok(typeof m.to === "string" && !/[\r\n,<>]/.test(m.to));
      if (m.replyTo) assert.ok(!/[\r\n,<>]/.test(m.replyTo));
    }
    assert.deepStrictEqual(h.sent.map((m) => m.to).sort(), ["dana@oem.test", SHOP].sort(), "exactly the shop and the one typed address");
  });

  // ═══ What the owner sees ══════════════════════════════════════
  test("the admin queue shows how each sender was checked", async () => {
    const owner = await h.admin("Owner");
    const list = await h.get("/api/rfq/admin/list", owner);
    assert.strictEqual(list.status, 200);
    const checks = new Set(list.body.map((r) => r.senderCheck));
    assert.ok(checks.has("turnstile") && checks.has("account") && checks.has("none"));
    assert.ok(list.body.every((r) => typeof r.buyerEmailed === "boolean" && !("drawingPath" in r)));
  });

  await run(h.stop);
})();
