/**
 * The email check: what it says with nothing set, with a half-set
 * configuration, and with keys present — and that a test message can only
 * ever go to the shop's own notification address.
 *
 * Resend and DNS are stand-ins here; no network is used and nothing is sent.
 * Run: node server/ops/emailCheck.test.js
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { runner } = require("../testSupport/harness");
const emailCheck = require("./emailCheck");
const brand = require("../../shared/brand.json");

// Addresses on the site's own domain are put together here from shared/brand.json, so that none is written out in this file.
const DOMAIN = brand.domain;
const SEND_DOMAIN = `mail.${DOMAIN}`;
const SENDER = ["sender", SEND_DOMAIN].join("@");

const { test, run } = runner("Email check");

// Made for this run. The key has Resend's shape so the shape check passes; it is not a key.
const KEY = `re_${crypto.randomBytes(16).toString("hex")}`;
const FULL = {
  EMAIL_API_KEY: KEY,
  EMAIL_FROM: `Straightedge <${SENDER}>`,
  RFQ_NOTIFY_TO: "shop-inbox@shop.test",
  FRONTEND_URL: "https://straightedgemfg.com",
};

function fakeResend({ domains = { status: 200, body: { data: [{ name: "mail.straightedgemfg.com", status: "verified" }] } }, send = { status: 200, body: { id: "msg_1" } }, throwOn = null } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (throwOn && url.endsWith(throwOn)) throw Object.assign(new Error("network down"), { name: "TypeError" });
    const r = url.endsWith("/domains") ? domains : send;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetch, calls };
}
function fakeDns(records = {}) {
  return {
    resolveTxt: async (name) => { if (!records[`TXT ${name}`]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return records[`TXT ${name}`].map((r) => [r]); },
    resolveMx: async (name) => { if (!records[`MX ${name}`]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return records[`MX ${name}`]; },
  };
}
const GOOD_DNS = {
  "TXT resend._domainkey.mail.straightedgemfg.com": ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0000000000000000000"],
  "TXT send.mail.straightedgemfg.com": ["v=spf1 include:amazonses.com ~all"],
  "MX send.mail.straightedgemfg.com": [{ exchange: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }],
  "TXT _dmarc.straightedgemfg.com": ["v=DMARC1; p=none;"],
};
const levels = (r, level) => r.lines.filter((l) => l.level === level).map((l) => l.text);
const dump = (r) => JSON.stringify(r);

test("nothing set: says exactly which variables are missing, touches neither DNS nor Resend, sends nothing", async () => {
  const resend = fakeResend();
  let dnsCalls = 0;
  const resolver = { resolveTxt: async () => { dnsCalls++; return []; }, resolveMx: async () => { dnsCalls++; return []; } };
  const r = await emailCheck.run({ env: {}, fetch: resend.fetch, resolver });
  assert.deepStrictEqual({ ok: r.ok, configured: r.configured, sent: r.sent }, { ok: false, configured: false, sent: false });
  const fails = levels(r, "fail");
  assert.ok(fails.some((t) => t.startsWith("EMAIL_API_KEY is not set")) && fails.some((t) => t.startsWith("EMAIL_FROM is not set")), fails.join("\n"));
  assert.ok(levels(r, "warn").some((t) => /neither RFQ_NOTIFY_TO nor ADMIN_EMAIL is set/.test(t)));
  assert.ok(levels(r, "warn").some((t) => /FRONTEND_URL is not set/.test(t)));
  assert.ok(levels(r, "info").some((t) => /Email is OFF/.test(t) && /Nothing was sent/.test(t)));
  assert.strictEqual(resend.calls.length, 0);
  assert.strictEqual(dnsCalls, 0);
});

test("half set: a key without a from-address, a from-address that cannot be read, a key of the wrong shape", async () => {
  let r = await emailCheck.run({ env: { EMAIL_API_KEY: KEY }, fetch: fakeResend().fetch, resolver: fakeDns() });
  assert.strictEqual(r.configured, false);
  assert.deepStrictEqual(levels(r, "fail").map((t) => t.split(" ")[0]), ["EMAIL_FROM"]);
  assert.ok(levels(r, "ok").includes("EMAIL_API_KEY is set."));

  for (const bad of ["Straightedge", "Straightedge <quotes>", "<a@b>", `"Straightedge" <${SENDER}`, "a@b.test, c@d.test"]) {
    r = await emailCheck.run({ env: { ...FULL, EMAIL_FROM: bad }, fetch: fakeResend().fetch, resolver: fakeDns() });
    assert.strictEqual(r.configured, false, bad);
    assert.ok(levels(r, "fail").some((t) => /EMAIL_FROM is set but cannot be read/.test(t)), bad);
  }
  assert.deepStrictEqual(emailCheck.parseFrom(`Straightedge <${SENDER}>`), { name: "Straightedge", address: SENDER, domain: SEND_DOMAIN });
  assert.strictEqual(emailCheck.parseFrom(["sender", DOMAIN].join("@")).domain, DOMAIN);

  r = await emailCheck.run({ env: { ...FULL, EMAIL_API_KEY: "\"pasted with quotes\"" }, fetch: fakeResend().fetch, resolver: fakeDns(GOOD_DNS), send: false });
  assert.ok(levels(r, "warn").some((t) => /does not look like a Resend key/.test(t)));
  assert.ok(!dump(r).includes("pasted with quotes"), "the value typed as a key is never echoed");
});

test("keys present, everything right: DNS and Resend agree, and one message goes to the shop's notification address only", async () => {
  const resend = fakeResend();
  const r = await emailCheck.run({ env: FULL, fetch: resend.fetch, resolver: fakeDns(GOOD_DNS) });
  assert.deepStrictEqual({ ok: r.ok, configured: r.configured, sent: r.sent }, { ok: true, configured: true, sent: true });
  assert.deepStrictEqual(levels(r, "fail"), []);
  assert.deepStrictEqual(levels(r, "warn"), []);
  const oks = levels(r, "ok").join("\n");
  for (const want of ["EMAIL_API_KEY is set", "mail is sent from the domain mail.straightedgemfg.com", "DKIM: a key is published", "SPF: send.mail.straightedgemfg.com has its TXT and MX", "DMARC: a policy record is published", "Resend reports mail.straightedgemfg.com as verified", "Test message accepted by Resend for 1 address"]) assert.ok(oks.includes(want), `${want}\n--\n${oks}`);
  // Exactly two calls: the domain question and one send.
  assert.deepStrictEqual(resend.calls.map((c) => `${c.method} ${c.url}`), ["GET https://api.resend.com/domains", "POST https://api.resend.com/emails"]);
  const sent = resend.calls[1];
  assert.strictEqual(sent.auth, `Bearer ${KEY}`);
  assert.deepStrictEqual(sent.body.to, ["shop-inbox@shop.test"], "the shop's own address and no other");
  assert.strictEqual(sent.body.from, FULL.EMAIL_FROM);
  assert.strictEqual(sent.body.subject, "Straightedge email check");
  assert.ok(!("cc" in sent.body) && !("bcc" in sent.body) && !("reply_to" in sent.body));
  assert.ok(/sent to the shop's notification address only/.test(sent.body.text));
  // The report itself: no key, and addresses masked.
  assert.ok(!dump(r).includes(KEY) && !dump(r).includes("shop-inbox@") && !dump(r).includes("sender@"));
  assert.ok(oks.includes("s…@shop.test"));
});

test("who gets the test message: RFQ_NOTIFY_TO, else ADMIN_EMAIL, else the site's own address; several are allowed; junk is skipped; nothing can be added", async () => {
  const to = async (env) => {
    const resend = fakeResend();
    const r = await emailCheck.run({ env: { ...FULL, ...env }, fetch: resend.fetch, resolver: fakeDns(GOOD_DNS), dns: false, api: false });
    const post = resend.calls.find((c) => c.method === "POST");
    return { r, to: post ? post.body.to : null };
  };
  assert.deepStrictEqual((await to({ RFQ_NOTIFY_TO: "a@shop.test, b@shop.test" })).to, ["a@shop.test", "b@shop.test"]);
  const fallback = await to({ RFQ_NOTIFY_TO: undefined, ADMIN_EMAIL: "owner@shop.test" });
  assert.deepStrictEqual(fallback.to, ["owner@shop.test"]);
  assert.ok(levels(fallback.r, "warn").some((t) => /from ADMIN_EMAIL \(RFQ_NOTIFY_TO is not set\)/.test(t)));
  assert.deepStrictEqual((await to({ RFQ_NOTIFY_TO: undefined, ADMIN_EMAIL: undefined })).to, [brand.email]);
  // An entry that is not one plain address is skipped and said to be; a header cannot be smuggled in.
  const mixed = await to({ RFQ_NOTIFY_TO: "a@shop.test, Bob <bob@elsewhere.test>, not-an-address, c@shop.test\r\nBcc: x@evil.test" });
  assert.deepStrictEqual(mixed.to, ["a@shop.test"]);
  assert.ok(levels(mixed.r, "warn").some((t) => /3 entries in that setting could not be read/.test(t)));
  const none = await to({ RFQ_NOTIFY_TO: "nobody" });
  assert.strictEqual(none.to, null, "no usable address: nothing is sent");
  assert.ok(levels(none.r, "fail").some((t) => /nothing usable is there/.test(t)));
  assert.strictEqual(none.r.ok, false);
  // The function takes no recipient argument at all: an extra option is ignored.
  const resend = fakeResend();
  await emailCheck.run({ env: FULL, fetch: resend.fetch, dns: false, api: false, to: "customer@elsewhere.test", recipient: "customer@elsewhere.test" });
  assert.deepStrictEqual(resend.calls[0].body.to, ["shop-inbox@shop.test"]);
});

test("what Resend says is passed on in words: sending-only key, unverified domain, unknown domain, rejected key, limits, unreachable", async () => {
  const go = (o) => emailCheck.run({ env: FULL, resolver: fakeDns(GOOD_DNS), ...o });
  // A sending-only key cannot list domains: that is fine, and the send is the check.
  let resend = fakeResend({ domains: { status: 401, body: { name: "restricted_api_key", message: "This API key is restricted to only send emails" } } });
  let r = await go({ fetch: resend.fetch });
  assert.strictEqual(r.ok, true);
  assert.ok(levels(r, "info").some((t) => /sending-only key/.test(t)));
  assert.strictEqual(r.sent, true);

  resend = fakeResend({ domains: { status: 200, body: { data: [{ name: "mail.straightedgemfg.com", status: "pending" }] } }, send: { status: 403, body: { name: "validation_error", message: "The mail.straightedgemfg.com domain is not verified. shop-inbox@shop.test" } } });
  r = await go({ fetch: resend.fetch });
  assert.strictEqual(r.ok, false);
  assert.ok(levels(r, "fail").some((t) => /as “pending”, not verified/.test(t)));
  assert.ok(levels(r, "fail").some((t) => /refused the test message \(403 validation_error\)/.test(t)));
  assert.ok(!dump(r).includes("shop-inbox@"), "the provider's own message, which can repeat an address, is not passed on");

  r = await go({ fetch: fakeResend({ domains: { status: 200, body: { data: [{ name: "other.example", status: "verified" }] } } }).fetch, send: false });
  assert.ok(levels(r, "fail").some((t) => /does not list mail\.straightedgemfg\.com/.test(t)));

  r = await go({ fetch: fakeResend({ domains: { status: 403, body: { name: "restricted_api_key" } }, send: { status: 401, body: { name: "validation_error" } } }).fetch });
  assert.ok(levels(r, "fail").some((t) => /refused the key \(403 restricted_api_key\)/.test(t)));
  assert.strictEqual(r.sent, false);

  r = await go({ fetch: fakeResend({ send: { status: 429, body: { name: "daily_quota_exceeded" } } }).fetch });
  assert.ok(levels(r, "fail").some((t) => /429 daily_quota_exceeded/.test(t) && /sending limit/.test(t)));

  r = await go({ fetch: fakeResend({ throwOn: "/emails" }).fetch });
  assert.ok(levels(r, "fail").some((t) => /Resend was not reachable/.test(t)));
  r = await go({ fetch: fakeResend({ throwOn: "/domains" }).fetch, send: false });
  assert.ok(levels(r, "warn").some((t) => /Could not reach Resend/.test(t)));
  assert.strictEqual(r.ok, true, "an unreachable status question is a warning, not a failure");

  // An odd error name from the provider is not echoed.
  r = await go({ fetch: fakeResend({ send: { status: 500, body: { name: "<script>x</script>" } } }).fetch });
  assert.ok(!dump(r).includes("script"));
});

test("DNS: each missing record is named with where it belongs; a sending domain off the brand's domain is called out; --no-send sends nothing", async () => {
  const resend = fakeResend();
  let r = await emailCheck.run({ env: FULL, fetch: resend.fetch, resolver: fakeDns({}), send: false });
  const warns = levels(r, "warn").join("\n");
  assert.ok(/DKIM: no key found at resend\._domainkey\.mail\.straightedgemfg\.com/.test(warns));
  assert.ok(/SPF: send\.mail\.straightedgemfg\.com is missing its TXT and MX records/.test(warns));
  assert.ok(/DMARC: no record at _dmarc\.straightedgemfg\.com/.test(warns));
  assert.strictEqual(r.ok, true, "missing DNS is a warning here: Resend's own answer and the send decide");
  assert.strictEqual(r.sent, false);
  assert.ok(!resend.calls.some((c) => c.method === "POST"));
  assert.ok(levels(r, "info").some((t) => /No test message was sent/.test(t)));

  r = await emailCheck.run({ env: FULL, fetch: resend.fetch, resolver: fakeDns({ ...GOOD_DNS, "MX send.mail.straightedgemfg.com": undefined }), send: false, api: false });
  assert.ok(levels(r, "warn").some((t) => /missing its MX record/.test(t)));

  // DMARC on the sending subdomain itself also counts.
  const sub = { ...GOOD_DNS, "TXT _dmarc.straightedgemfg.com": undefined, "TXT _dmarc.mail.straightedgemfg.com": ["v=DMARC1; p=quarantine"] };
  r = await emailCheck.run({ env: FULL, fetch: resend.fetch, resolver: fakeDns(sub), send: false, api: false });
  assert.ok(levels(r, "ok").some((t) => /DMARC/.test(t)));

  r = await emailCheck.run({ env: { ...FULL, EMAIL_FROM: "Straightedge <quotes@some-other-domain.example>" }, fetch: resend.fetch, send: false, dns: false, api: false });
  assert.ok(levels(r, "warn").some((t) => /is not straightedgemfg\.com or one of its subdomains/.test(t)));
  assert.strictEqual(emailCheck.organisationalDomain("mail.straightedgemfg.com"), "straightedgemfg.com");
  assert.strictEqual(emailCheck.mask(["Sender", DOMAIN.toUpperCase()].join("@")), `S…@${DOMAIN}`);
});

test("npm run email:check with keys absent: exit code 1, the missing variables by name, no address in full, nothing sent", async () => {
  const env = { ...process.env, DOTENV_CONFIG_PATH: path.join(__dirname, "no-such.env") };
  for (const k of ["EMAIL_API_KEY", "EMAIL_FROM", "RFQ_NOTIFY_TO", "ADMIN_EMAIL", "FRONTEND_URL"]) delete env[k];
  env.ADMIN_EMAIL = "owner-marker@shop.test";
  const cwd = require("os").tmpdir(); // no .env file here
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "ops", "email-check.js")], { env, cwd, encoding: "utf8" });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(/FAIL\s+EMAIL_API_KEY is not set/.test(r.stdout) && /FAIL\s+EMAIL_FROM is not set/.test(r.stdout), r.stdout);
  assert.ok(/Result: email is OFF/.test(r.stdout));
  assert.ok(!r.stdout.includes("owner-marker@") && r.stdout.includes("o…@shop.test"), r.stdout);
  const help = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "ops", "email-check.js"), "--help"], { env, cwd, encoding: "utf8" });
  assert.strictEqual(help.status, 0);
  assert.ok(/--no-send/.test(help.stdout));
});

run();
