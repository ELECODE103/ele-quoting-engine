/**
 * Email template + mailer tests. Run: `node server/emails/templates.test.js`
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const brand = require("../../shared/brand.json");
const templates = require("./templates");
const samples = require("./samples");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Emails");
const all = Object.entries(samples).map(([name, build]) => [name, build()]);

test("every template has a subject, a plain-text body and an HTML body", () => {
  assert.ok(all.length >= 8);
  for (const [name, m] of all) {
    assert.ok(m.subject && m.subject.length < 120, `${name} subject`);
    assert.ok(m.text.length > 80, `${name} text`);
    assert.ok(m.html.startsWith("<!doctype html>"), `${name} html`);
    assert.ok(!/undefined|\bNaN\b|\[object Object\]/.test(m.text + m.html), `${name} has no leaked placeholders`);
  }
});

test("one branded layout: text wordmark, ink / bone, brass used for the hairline only", () => {
  for (const [name, m] of all) {
    assert.ok(m.html.includes(`>${brand.name.toUpperCase()}</span>`), `${name} wordmark`);
    assert.ok(m.html.includes("#101C33") && m.html.includes("#F4F1EA"), `${name} ink and bone`);
    assert.strictEqual((m.html.match(/#A8834E/gi) || []).length, 1, `${name}: brass appears once`);
    assert.ok(/height:2px[^"]*background:#A8834E/.test(m.html), `${name}: and it is the hairline`);
  }
});

test("no remote images or other remote resources", () => {
  for (const [name, m] of all) {
    assert.ok(!/<img|<link|<script|url\(|@import|src=/i.test(m.html), `${name} loads nothing remote`);
  }
});

test("brand facts come from shared/brand.json, in both bodies", () => {
  for (const [name, m] of all) {
    for (const fact of [brand.phone, brand.email, brand.legalName, brand.city]) {
      assert.ok(m.html.includes(fact), `${name} html has ${fact}`);
      assert.ok(m.text.includes(fact), `${name} text has ${fact}`);
    }
  }
});

test("the plain-text body carries the same facts and link as the HTML", () => {
  const quoted = samples["rfq-quoted"]();
  for (const s of ["$6,850.00", "15 business days", "December 9, 2026", "/firm-quote/eyJ", "Wed, Dec 2, 2026"]) {
    assert.ok(quoted.text.includes(s), `text has ${s}`);
    assert.ok(quoted.html.includes(s), `html has ${s}`);
  }
  const shipped = samples["order-shipped"]();
  assert.ok(shipped.text.includes("https://www.ups.com/track?tracknum=1Z999AA10123456784"));
  assert.ok(samples["order-confirmation"]().text.includes("Tue, Nov 24, 2026"));
});

test("customer-supplied text is escaped in HTML", () => {
  const m = templates.orderConfirmation({
    order: { id: "abc", total: 10, shippingName: `<script>alert(1)</script>`, customerNotes: `"><img src=x onerror=alert(1)>` },
    items: [{ fileName: "<b>part</b>.step", quantity: 1, lineTotal: 10 }],
  });
  assert.ok(!m.html.includes("<script>") && !m.html.includes("<img") && !m.html.includes("<b>part"));
  assert.ok(m.html.includes("&lt;b&gt;part&lt;/b&gt;.step"));
});

test("tracking links for the carriers the admin can pick; none for an unknown carrier", () => {
  assert.ok(templates.trackingUrl("UPS", "1Z 99").includes("ups.com/track?tracknum=1Z%2099"));
  assert.ok(templates.trackingUrl("FedEx", "77").includes("fedex.com"));
  assert.ok(templates.trackingUrl("USPS", "94").includes("usps.com"));
  assert.ok(templates.trackingUrl("DHL", "12").includes("dhl.com"));
  assert.strictEqual(templates.trackingUrl("Other", "12"), "");
  assert.strictEqual(templates.trackingUrl("UPS", ""), "");
});

test("without keys the mailer is a logged no-op that never prints the body", async () => {
  delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM; delete process.env.EMAIL_OUTBOX_DIR;
  delete require.cache[require.resolve("../services/mailer")];
  const mailer = require("../services/mailer");
  const logs = [];
  const realLog = console.log; console.log = (...a) => logs.push(a.join(" "));
  const realFetch = global.fetch; let fetched = 0; global.fetch = async () => { fetched++; return { ok: true }; };
  let result;
  try { result = await mailer.send({ to: "a@b.test", ...samples["rfq-quoted"]() }); }
  finally { console.log = realLog; global.fetch = realFetch; }
  assert.strictEqual(result, false);
  assert.strictEqual(fetched, 0, "nothing leaves the machine");
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].includes("a@b.test") && logs[0].includes("not sent"));
  assert.ok(!logs[0].includes("firm-quote"), "the signed link is not written to the log");
});

test("with keys it posts subject, text and HTML to Resend", async () => {
  process.env.EMAIL_API_KEY = "re_test_key"; process.env.EMAIL_FROM = "Straightedge <quotes@example.test>";
  const mailer = require("../services/mailer");
  const calls = [];
  const realFetch = global.fetch; global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  let result;
  try { result = await mailer.send({ to: "a@b.test", replyTo: "shop@b.test", ...samples["order-confirmation"]() }); }
  finally { global.fetch = realFetch; delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM; }
  assert.strictEqual(result, true);
  assert.strictEqual(calls[0].url, "https://api.resend.com/emails");
  const body = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(body.to, ["a@b.test"]);
  assert.strictEqual(body.reply_to, "shop@b.test");
  assert.ok(body.text.length > 0 && body.html.includes("STRAIGHTEDGE"));
});

test("a failed send returns false instead of throwing", async () => {
  process.env.EMAIL_API_KEY = "re_test_key"; process.env.EMAIL_FROM = "x@example.test";
  const mailer = require("../services/mailer");
  const realFetch = global.fetch; const realErr = console.error; console.error = () => {};
  try {
    global.fetch = async () => ({ ok: false, status: 422, text: async () => "bad" });
    assert.strictEqual(await mailer.send({ to: "a@b.test", subject: "s", text: "t" }), false);
    global.fetch = async () => { throw new Error("network down"); };
    assert.strictEqual(await mailer.send({ to: "a@b.test", subject: "s", text: "t" }), false);
  } finally { global.fetch = realFetch; console.error = realErr; delete process.env.EMAIL_API_KEY; delete process.env.EMAIL_FROM; }
});

test("shop notifications go to RFQ_NOTIFY_TO, then ADMIN_EMAIL, then the brand address", () => {
  const mailer = require("../services/mailer");
  const keep = { a: process.env.RFQ_NOTIFY_TO, b: process.env.ADMIN_EMAIL };
  process.env.RFQ_NOTIFY_TO = "rfq@x.test"; process.env.ADMIN_EMAIL = "admin@x.test";
  assert.strictEqual(mailer.shopNotifyAddress(), "rfq@x.test");
  delete process.env.RFQ_NOTIFY_TO;
  assert.strictEqual(mailer.shopNotifyAddress(), "admin@x.test");
  delete process.env.ADMIN_EMAIL;
  assert.strictEqual(mailer.shopNotifyAddress(), brand.email);
  if (keep.a) process.env.RFQ_NOTIFY_TO = keep.a; if (keep.b) process.env.ADMIN_EMAIL = keep.b;
});

test("scripts/preview-emails.js writes each template as .html and .txt", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "se-preview-"));
  execFileSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "preview-emails.js"), out], { stdio: "pipe" });
  for (const name of Object.keys(samples)) {
    assert.ok(fs.readFileSync(path.join(out, `${name}.html`), "utf8").includes("STRAIGHTEDGE"));
    assert.ok(fs.readFileSync(path.join(out, `${name}.txt`), "utf8").startsWith("Subject: "));
  }
  assert.ok(fs.existsSync(path.join(out, "index.html")));
  fs.rmSync(out, { recursive: true, force: true });
});

run();
