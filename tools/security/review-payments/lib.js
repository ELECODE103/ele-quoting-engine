/**
 * Shared helpers for the payment-path proofs of concept.
 *
 * start() runs the real server (server/index.js) in production mode on a free
 * local port with a throwaway database, random secrets made at run time, and
 * the Stripe SDK replaced at the boundary (stripe-stub-preload.js), so nothing
 * here can reach a live site or the Stripe API.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..");
const live = require(path.join(ROOT, "server", "testSupport", "liveServer"));
const PARTS = path.join(ROOT, "tools", "vet-quotes", "parts");

let ipSeq = 0;
const nextIp = () => { ipSeq++; return `198.51.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`; };

async function start({ env = {}, webhookSecret } = {}) {
  const whsec = webhookSecret === undefined ? `whsec_${crypto.randomBytes(24).toString("hex")}` : webhookSecret;
  const stripeDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "se-review-stripe-"));
  const s = await live.start({
    env: {
      NODE_OPTIONS: `--require ${path.join(__dirname, "stripe-stub-preload.js")}`,
      SE_REVIEW_STRIPE_DIR: stripeDir,
      // No secret is passed as an empty one: production now refuses to start without it (F-18),
      // and the helper that starts the server would otherwise supply a throwaway secret of its own.
      STRIPE_WEBHOOK_SECRET: whsec || "",
      ...env,
    },
  });
  const sdk = require(path.join(ROOT, "node_modules", "stripe"))("sk_test_review_stub_not_a_key");
  const h = {
    s, whsec, stripeDir, base: s.base,
    log: () => s.log(),
    call: (method, url, json, token, headers = {}) => s.req({ method, url, json, token, ip: nextIp(), headers }),
    get: (url, token) => h.call("GET", url, undefined, token),
    post: (url, json, token, headers) => h.call("POST", url, json === undefined ? {} : json, token, headers),
    put: (url, json, token) => h.call("PUT", url, json, token),
    register: (email) => s.register(email, { ip: nextIp() }),
    admin: () => s.admin({ ip: nextIp() }),
    async upload(fileName, { as, process: proc } = {}) {
      const data = fs.readFileSync(path.isAbsolute(fileName) ? fileName : path.join(PARTS, fileName));
      const r = await s.upload([{ name: as || path.basename(fileName), data }], { ip: nextIp(), fields: proc ? { process: proc } : {} });
      if (r.status !== 200 || !r.body.parts.length) throw new Error(`upload failed (${r.status}): ${r.text.slice(0, 400)}`);
      return r.body.parts[0];
    },
    uploadData(name, data) {
      return s.upload([{ name, data }], { ip: nextIp() }).then((r) => { if (r.status !== 200 || !r.body.parts.length) throw new Error(`upload failed (${r.status}): ${r.text.slice(0, 400)}`); return r.body.parts[0]; });
    },
    session(id) { return JSON.parse(fs.readFileSync(path.join(stripeDir, `${id}.json`), "utf8")); },
    sessions() { return fs.readdirSync(stripeDir).map((f) => JSON.parse(fs.readFileSync(path.join(stripeDir, f), "utf8"))).sort((a, b) => Number(a.id.split("_").pop()) - Number(b.id.split("_").pop())); },
    lastSession() { return h.sessions().pop(); },
    /** Mark a stub session paid, as Stripe would report it (optionally with different amounts). */
    pay(id, over = {}) { const f = path.join(stripeDir, `${id}.json`); const v = { ...JSON.parse(fs.readFileSync(f, "utf8")), payment_status: "paid", status: "complete", payment_intent: `pi_review_${id.split("_").pop()}`, ...over }; fs.writeFileSync(f, JSON.stringify(v)); return v; },
    /** POST a webhook. sign: true (server's secret), false (no header), or a secret string. */
    webhook(event, { sign = true, timestamp, header, contentType = "application/json", rawBody } = {}) {
      const payload = rawBody !== undefined ? rawBody : JSON.stringify(event);
      const headers = { "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(payload)) };
      if (header !== undefined) headers["Stripe-Signature"] = header;
      else if (sign) headers["Stripe-Signature"] = sdk.webhooks.generateTestHeaderString({ payload, secret: sign === true ? whsec : sign, ...(timestamp ? { timestamp } : {}) });
      return s.req({ method: "POST", url: "/api/stripe/webhook", body: Buffer.from(payload), headers, ip: nextIp() });
    },
    completed(session, over = {}) { return { id: `evt_${crypto.randomBytes(8).toString("hex")}`, type: "checkout.session.completed", data: { object: { ...session, payment_status: "paid", ...over } } }; },
    stop: async () => { await s.stop(); fs.rmSync(stripeDir, { recursive: true, force: true }); },
  };
  return h;
}

/** Tiny reporter: prints each observation and keeps a verdict list. */
function report(title) {
  console.log(`\n=== ${title} ===`);
  const findings = [];
  return {
    note: (...a) => console.log("   ", ...a),
    finding(vulnerable, text) { findings.push({ vulnerable, text }); console.log(`${vulnerable ? "  [VULNERABLE]" : "  [held]      "} ${text}`); },
    done() { const n = findings.filter((f) => f.vulnerable).length; console.log(`--- ${title}: ${n} of ${findings.length} checks show the weakness ---`); return findings; },
  };
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const SHIP = { shippingName: "Review Buyer", shippingAddress: "1 Test St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };

module.exports = { start, report, money, SHIP, PARTS, ROOT, nextIp };
