/**
 * Limits that hold whoever the sender is (independent review 2026-11-11, M1, M2, M3, L1, I1, I2).
 *
 *   M1  the verified-human token belongs to the client that passed the check, and has a use ceiling
 *   M2  firm-quote requests from senders who cannot be verified share one hourly allowance site-wide
 *   M3  mail to unconfirmed addresses and request notices to the shop have site-wide hourly caps,
 *       with one notice to the owner
 *   L1  the daily byte budget counts what was actually received: chunked bodies and over-size refusals too
 *   I1  a file name is read as UTF-8     I2  an address with a port is one client
 * Run: node server/security/siteCaps.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { start, runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");

const { test, run } = runner("Site-wide caps, the human token, byte counting");
const cube = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
const MB = 1024 * 1024;

/** POST multipart without a Content-Length (chunked), the way a script that wants to dodge a size check sends it. */
function chunkedUpload(port, url, ip, files, { fields = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    const boundary = `----sc${crypto.randomBytes(8).toString("hex")}`;
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: url, agent: false, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "X-Forwarded-For": ip, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ } resolve({ status: res.statusCode, body }); });
      res.on("error", () => resolve({ status: res.statusCode, body: null }));
    });
    let answered = false;
    req.on("response", () => { answered = true; });
    req.on("error", () => { setTimeout(() => { if (!answered) resolve({ status: 0, body: { code: "connection-closed" } }); }, 300); });
    (async () => {
      for (const [k, v] of Object.entries(fields)) req.write(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      for (const f of files) {
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field || "files"}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        // in pieces, with a pause, so the server sees it arrive over time
        for (let o = 0; o < f.data.length; o += 128 * 1024) {
          if (req.destroyed) return;
          req.write(f.data.subarray(o, o + 128 * 1024));
          await new Promise((r) => setTimeout(r, 15));
        }
        req.write("\r\n");
      }
      req.end(`--${boundary}--\r\n`);
    })().catch(() => {});
  });
}

/** POST a multipart body WITH a Content-Length: the answer may come while the body is still being sent. */
function declaredUpload(port, url, ip, file) {
  return new Promise((resolve) => {
    const boundary = `----sl${crypto.randomBytes(8).toString("hex")}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: url, agent: false, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(head.length + file.data.length + tail.length), "X-Forwarded-For": ip } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ } resolve({ status: res.statusCode, body }); });
      res.on("error", () => resolve({ status: res.statusCode, body: null }));
    });
    let answered = false;
    req.on("response", () => { answered = true; });
    req.on("error", () => { setTimeout(() => { if (!answered) resolve({ status: 0, body: { code: "connection-closed" } }); }, 300); });
    // as fast as the connection takes it, the way a browser on a good line does
    (async () => {
      for (const piece of [head, file.data, tail]) {
        if (req.destroyed) return;
        if (!req.write(piece)) await new Promise((r) => { req.once("drain", r); req.once("error", r); req.once("close", r); });
      }
      req.end();
    })().catch(() => {});
  });
}

// ─── M1: the verified-human token (bot check on) ─────────────
let h;
test("M1: a verified-human token works only from the client it was issued to", async () => {
  h = await start();
  const fd = () => { const f = new FormData(); f.append("files", new Blob([cube]), "cube.stl"); return f; };
  const verify = await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" }, ip: "203.0.113.1" });
  assert.strictEqual(verify.status, 200);
  const token = verify.body.humanToken;
  const from = (ip) => h.raw("POST", "/api/upload", { body: fd(), ip, headers: { "X-Human-Token": token } });
  assert.strictEqual((await from("203.0.113.1")).status, 200, "the client that passed the check");
  const other = await from("203.0.113.99");
  assert.strictEqual(other.status, 403, "the same token from another address");
  assert.strictEqual(other.body.code, "human-check-required");
  // an IPv6 client is its /64: another address in it is the same client, another /64 is not
  const v6 = (await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" }, ip: "2001:db8:1:2::10" })).body.humanToken;
  assert.strictEqual((await h.raw("POST", "/api/upload", { body: fd(), ip: "2001:db8:1:2:aaaa::7", headers: { "X-Human-Token": v6 } })).status, 200);
  assert.strictEqual((await h.raw("POST", "/api/upload", { body: fd(), ip: "2001:db8:1:3::10", headers: { "X-Human-Token": v6 } })).status, 403);
  // a token with no client in it (what was issued before) is not accepted
  const tokens = require("./tokens");
  assert.strictEqual((await h.raw("POST", "/api/upload", { body: fd(), ip: "203.0.113.1", headers: { "X-Human-Token": tokens.sign("human", {}) } })).status, 403);
});

test("M1: the token has a use ceiling, and reopening a quote or fetching a preview needs it too", async () => {
  const saved = process.env.HUMAN_TOKEN_MAX_USES;
  process.env.HUMAN_TOKEN_MAX_USES = "10";
  try {
    const ip = "203.0.113.2";
    const token = (await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" }, ip })).body.humanToken;
    const partId = await h.uploadCube();
    const body = { parts: [h.cncConfig(partId, 1)] };
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await h.raw("POST", "/api/quote", { json: body, ip, headers: { "X-Human-Token": token } })).status);
    assert.deepStrictEqual(statuses, [...Array(10).fill(200), 403, 403], "ten uses, then the check is asked for again");
    // a fresh check gives a fresh token
    const again = (await h.raw("POST", "/api/human/verify", { json: { turnstileToken: "pass-quote" }, ip })).body.humanToken;
    const q = await h.raw("POST", "/api/quote", { json: body, ip, headers: { "X-Human-Token": again } });
    assert.strictEqual(q.status, 200);
    // the quote-session route and the preview route are behind the same check
    assert.strictEqual((await h.raw("GET", `/api/quote/${q.body.quoteId}/session`, { ip })).status, 403);
    assert.strictEqual((await h.raw("GET", `/api/parts/${partId}/mesh`, { ip })).status, 403);
    const s = await h.raw("GET", `/api/quote/${q.body.quoteId}/session`, { ip, headers: { "X-Human-Token": again } });
    assert.strictEqual(s.status, 200);
    assert.strictEqual((await h.raw("GET", `/api/parts/${partId}/mesh`, { ip, headers: { "X-Human-Token": again, "X-Part-Key": s.body.partsById[partId].editKey } })).status, 200);
  } finally { if (saved === undefined) delete process.env.HUMAN_TOKEN_MAX_USES; else process.env.HUMAN_TOKEN_MAX_USES = saved; }
});

// ─── I2 and the caps as units ────────────────────────────────
test("I2: an address reported with its port is one client, whatever the port", () => {
  const { keyForAddress } = require("./clientKey");
  assert.strictEqual(keyForAddress("203.0.113.9:51234"), "203.0.113.9");
  assert.strictEqual(keyForAddress("203.0.113.9:1"), keyForAddress("203.0.113.9"));
  assert.strictEqual(keyForAddress("[2001:db8:1:2::5]:443"), keyForAddress("2001:db8:1:2::9"));
  assert.strictEqual(keyForAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.strictEqual(keyForAddress("2001:db8:1:2::5"), "2001:db8:1:2::/64");
});

test("M3: the mail caps count only the mail a stranger can cause; one owner notice per hour per cap; counters for the status page", () => {
  const caps = require("../services/mailCaps");
  const saved = { ...process.env };
  process.env.MAIL_UNCONFIRMED_PER_HOUR_SITE = "2";
  process.env.MAIL_SHOP_REQUESTS_PER_HOUR_SITE = "1";
  caps.resetForTests();
  try {
    const t0 = Date.parse("2026-11-11T10:00:00Z");
    assert.deepStrictEqual(caps.admit("verifyEmail", t0), { allowed: true, hold: false, kind: "unconfirmed", notify: false });
    assert.strictEqual(caps.admit("rfqReceivedBuyer", t0).allowed, true);
    // Over the cap a message is HELD, to be sent when the hour turns; it used to be dropped (re-review RR-04).
    assert.deepStrictEqual(caps.admit("partRequestBuyer", t0), { allowed: false, hold: true, kind: "unconfirmed", notify: true }, "the third is held and the owner is told");
    assert.deepStrictEqual(caps.admit("verifyEmail", t0 + 1000), { allowed: false, hold: true, kind: "unconfirmed", notify: false }, "told once, not for every message");
    // RR-04: a client's own first two in the hour go out whatever the site-wide count is…
    assert.strictEqual(caps.admit("verifyEmail", t0 + 2000, { clientKey: "203.0.113.9" }).allowed, true, "a new customer's confirmation email is not behind the flood");
    assert.strictEqual(caps.admit("verifyEmail", t0 + 2000, { clientKey: "203.0.113.9" }).allowed, true);
    assert.deepStrictEqual(caps.admit("verifyEmail", t0 + 2000, { clientKey: "203.0.113.9" }), { allowed: false, hold: true, kind: "unconfirmed", notify: false }, "…its third waits like anyone's");
    // …up to the hard ceiling, which holds even a first message (it protects the mail account from hundreds of addresses).
    process.env.MAIL_UNCONFIRMED_HARD_PER_HOUR_SITE = "4";
    assert.strictEqual(caps.admit("verifyEmail", t0 + 3000, { clientKey: "203.0.113.10" }).hold, true);
    delete process.env.MAIL_UNCONFIRMED_HARD_PER_HOUR_SITE;
    // What is held: one per recipient (the newest link), a few per client, given back when the hour turns —
    // each client's first before anyone's second.
    const msg = (to, n) => ({ template: "verifyEmail", to, text: `link ${n}` });
    for (const k of ["flood", "flood", "someone", "someone"]) caps.admit("verifyEmail", t0, { clientKey: k }); // each has had its own first two this hour
    assert.strictEqual(caps.hold(msg("a1@x.test", 1), { clientKey: "flood" }), true);
    assert.strictEqual(caps.hold(msg("a1@x.test", 2), { clientKey: "flood" }), true, "the same recipient again replaces what was waiting");
    assert.strictEqual(caps.hold(msg("a2@x.test", 3), { clientKey: "flood" }), true);
    assert.strictEqual(caps.hold(msg("a3@x.test", 4), { clientKey: "flood" }), true);
    assert.strictEqual(caps.hold(msg("a4@x.test", 5), { clientKey: "flood" }), false, "a sender with MAIL_HELD_PER_CLIENT (3) waiting has the next turned away");
    assert.strictEqual(caps.hold(msg("real@customer.test", 6), { clientKey: "someone" }), true);
    assert.deepStrictEqual(caps.due(t0 + 5000), [], "nothing goes while the hour's cap is still reached");
    const later = caps.due(t0 + 61 * 60 * 1000);
    assert.deepStrictEqual(later.map((m) => [m.to, m.text]), [["a1@x.test", "link 2"], ["real@customer.test", "link 6"], ["a2@x.test", "link 3"], ["a3@x.test", "link 4"]], "the next hour: the flood's first, the customer's, then the flood's others (their first two are outside the cap of 2)");
    assert.strictEqual(caps.heldQueue.length, 0);
    caps.resetForTests();
    for (const t of ["verifyEmail", "rfqReceivedBuyer", "partRequestBuyer", "verifyEmail"]) caps.admit(t, t0);
    assert.strictEqual(caps.admit("rfqReceivedShop", t0).allowed, true);
    assert.deepStrictEqual(caps.admit("rfqReceivedShop", t0), { allowed: false, hold: false, kind: "shop", notify: true }, "a notice to the shop is not held: the request is in the admin panel");
    // never capped: orders, payments, accounts, the firm quote itself, the notice
    for (const t of ["orderConfirmation", "newOrderShop", "orderShipped", "rfqQuoted", "rfqAcceptedShop", "passwordResetRequested", "passwordChanged", "accountLocked", "twoFactorChanged", "mailCapReached"]) {
      for (let i = 0; i < 50; i++) assert.strictEqual(caps.admit(t, t0).allowed, true, t);
    }
    const c = caps.counters(t0 + 2000);
    assert.deepStrictEqual([c.unconfirmed.sentThisHour, c.unconfirmed.heldThisHour, c.unconfirmed.capPerHour, c.unconfirmed.capReached], [2, 2, 2, true]);
    assert.deepStrictEqual([c.shop.sentThisHour, c.shop.heldThisHour, c.shop.capReached], [1, 1, true]);
    // an hour later the window is new
    assert.strictEqual(caps.admit("verifyEmail", t0 + 61 * 60 * 1000).allowed, true);
    const notice = caps.ownerNotice("unconfirmed", t0);
    assert.ok(/hourly limit/i.test(notice.subject) && /TURNSTILE_SITE_KEY/.test(notice.text) && /not affected/.test(notice.text));
    assert.ok(/admin panel/.test(caps.ownerNotice("shop", t0).text));
    assert.strictEqual(typeof require("../services/mailer").capCounters, "function", "the mailer exposes the counters");
  } finally {
    for (const k of ["MAIL_UNCONFIRMED_PER_HOUR_SITE", "MAIL_SHOP_REQUESTS_PER_HOUR_SITE"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    caps.resetForTests();
  }
});

// ─── Against the real server (bot check off, as before the owner sets keys) ──
let s;
test("I1: a file name with non-ASCII characters is kept as typed (it used to arrive garbled)", async () => {
  s = await live.start({ env: { UPLOAD_DAILY_MB_PER_IP: "3", UPLOAD_MAX_FILE_MB: "1", RFQ_UNVERIFIED_PER_HOUR_SITE: "4", MAIL_SHOP_REQUESTS_PER_HOUR_SITE: "2", MAIL_UNCONFIRMED_PER_HOUR_SITE: "3" } });
  const r = await s.upload([{ name: "Gehäuse.stl", data: cube }, { name: "支架.stl", data: cube }], { ip: "203.0.113.5" });
  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  assert.deepStrictEqual(r.body.parts.map((p) => p.fileName), ["Gehäuse.stl", "支架.stl"]);
  for (const f of s.files("uploads")) assert.ok(/^[0-9a-f-]{36}\.stl$/.test(f), "the name on disk is still ours, never the customer's");
});

test("L1: an over-size file is charged to the sender's daily budget even though it is refused", async () => {
  const ip = "203.0.113.6";
  const tooBig = Buffer.concat([cube, Buffer.alloc(1.3 * MB, 0x20)]); // over the 1 MB file limit set for this server
  const codes = [];
  for (let i = 0; i < 2; i++) { const r = await chunkedUpload(s.port, "/api/upload", ip, [{ name: "big.stl", data: tooBig }]); codes.push(r.status); }
  assert.deepStrictEqual(codes, [413, 413]);
  // 2.6 MB of the 3 MB budget went on files that were refused: a third over-size file is cut off, and nothing is left on disk
  const third = await chunkedUpload(s.port, "/api/upload", ip, [{ name: "big.stl", data: tooBig }]);
  assert.ok([413, 429, 0].includes(third.status), `third: ${third.status}`);
  const after = await s.upload([{ name: "cube.stl", data: cube }], { ip });
  assert.strictEqual(after.status, 429, "the budget is spent: refused bytes counted");
  assert.strictEqual(after.body.code, "daily-upload-limit");
  assert.strictEqual((await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.7" })).status, 200, "another client is unaffected");
  assert.strictEqual(s.files("uploads").filter((f) => !/^[0-9a-f-]{36}\.stl$/.test(f)).length, 0);
});

test("a refusal at the door reaches a sender who is still sending: they read our message, not a dropped connection", async () => {
  // 203.0.113.6 has spent its budget (above). A browser keeps sending the file while the answer comes back;
  // closing the connection under it used to turn the answer into a network error about one time in four.
  const before = new Set(s.files("uploads"));
  const seen = [];
  const big = Buffer.concat([cube, Buffer.alloc(12 * MB, 0x20)]);
  for (let i = 0; i < 12; i++) { const r = await declaredUpload(s.port, "/api/upload", "203.0.113.6", { name: "part.stl", data: big }); seen.push(`${r.status}:${r.body && r.body.code}`); }
  assert.deepStrictEqual(seen, Array(12).fill(seen[0]), seen.join(" "));
  assert.ok(/^4(13|29):/.test(seen[0]) && !/undefined|null/.test(seen[0]), seen[0]);
  assert.deepStrictEqual(s.files("uploads").filter((f) => !before.has(f)), [], "nothing of a refused upload is kept");
});

test("L1: a body sent without a Content-Length is counted as it arrives and cut off at the budget", async () => {
  const ip = "203.0.113.8";
  const q = await s.post("/api/quote", { parts: [{ partId: (await s.upload([{ name: "c.stl", data: cube }], { ip: "203.0.113.9" })).body.parts[0].partId, materialSlug: (await s.get("/api/materials?process=cnc")).body[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }] }, { ip: "203.0.113.9" });
  assert.strictEqual(q.status, 200, q.text.slice(0, 200));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(0.9 * MB, 0x20), Buffer.from("\n%%EOF\n")]);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await chunkedUpload(s.port, `/api/quote/${q.body.quoteId}/drawing`, ip, [{ field: "drawing", name: "print.pdf", data: pdf }])).status);
  // 0.9 MB each against 3 MB: three fit, then the sender is over
  assert.deepStrictEqual(statuses.slice(0, 3), [200, 200, 200], statuses.join(" "));
  assert.ok(statuses.slice(3).every((c) => c === 429 || c === 0), `after the budget: ${statuses.join(" ")} (they were 200 before: a chunked body was charged nothing)`);
  // The cut-off request is closed a moment after its answer; its partial file goes with it.
  for (let i = 0; i < 40 && s.files("quote-drawings").length > 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(s.files("quote-drawings").length, 1, "one drawing kept for the quote; the cut-off ones left nothing");
});

test("M2 / RR-03: three addresses flooding the request form use up the site-wide allowance for themselves only; a visitor's own first requests always pass", async () => {
  // This server: 4 an hour site-wide from senders who cannot be verified, after each address's own first 2.
  const send = (ip, i, files = []) => s.rfq({ contactName: `Lead ${i}`, email: `lead${ip.split(".").pop()}-${i}@example.test`, notes: `request ${i}` }, files, { ip });
  // The reviewer's attack: ten from each of three addresses at the start of the hour.
  const flood = {};
  for (const ip of ["198.51.100.10", "198.51.100.11", "198.51.100.12"]) { flood[ip] = []; for (let i = 0; i < 10; i++) flood[ip].push((await send(ip, i)).status); }
  assert.deepStrictEqual(flood["198.51.100.10"], [201, 201, 201, 201, 201, 201, 429, 429, 429, 429], "the first address: its own two, then the site's four, then refused");
  assert.deepStrictEqual(flood["198.51.100.11"], [201, 201, ...Array(8).fill(429)], "the second and third: their own two, and the allowance is gone");
  assert.deepStrictEqual(flood["198.51.100.12"], [201, 201, ...Array(8).fill(429)]);
  const refused = await send("198.51.100.10", 99);
  assert.strictEqual(refused.body.code, "requests-paused");
  assert.ok(/call|email/i.test(refused.body.error), refused.body.error);
  // A real visitor, now, with a drawing: accepted (this used to be 429 for the rest of the hour).
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const visitor = await send("203.0.113.150", 0, [{ name: "d.pdf", data: pdf }]);
  assert.strictEqual(visitor.status, 201, visitor.text.slice(0, 200));
  assert.strictEqual(s.files("rfq-drawings").length, 1);
  assert.strictEqual((await send("203.0.113.150", 1)).status, 201, "and their second");
  assert.strictEqual((await send("203.0.113.150", 2)).status, 429, "a third in the hour waits for the site's allowance like anyone's");
  // A flooding address with an attachment: refused before the file is read, nothing written.
  const withFile = await send("198.51.100.11", 50, [{ name: "d.pdf", data: pdf }]);
  assert.strictEqual(withFile.status, 429);
  assert.strictEqual(s.files("rfq-drawings").length, 1);
  // a signed-in customer with a confirmed email, writing from their own address, is a verified sender
  const token = await s.register("customer@example.test", { ip: "198.51.100.91" });
  const mine = await s.rfq({ contactName: "Customer", email: "customer@example.test", notes: "a real request" }, [], { ip: "198.51.100.91", token });
  assert.strictEqual(mine.status, 201, mine.text);
});

test("M3: the shop's inbox gets request notices up to the hourly cap, then one 'cap reached' notice; the requests are all stored", async () => {
  const toShop = s.mail(s.adminEmail);
  const notices = toShop.filter((m) => !/hourly limit/i.test(m.subject) && !/confirm your email/i.test(m.subject));
  const capNotices = toShop.filter((m) => /hourly limit reached for new-request emails/i.test(m.subject));
  assert.strictEqual(notices.length, 2, `request notices to the shop: ${toShop.map((m) => m.subject).join(" | ")}`);
  assert.strictEqual(capNotices.length, 1, "one notice, not one per held message");
  assert.ok(/admin panel/.test(capNotices[0].text) && !/lead\d@example\.test/.test(capNotices[0].text), "it says where the requests are and names no customer");
});

test("M3 / RR-04: one address registering accounts and asking again and again reaches the cap for itself; a new customer's confirmation email still goes out, and what is over the cap is held, not dropped", async () => {
  // This server: 3 an hour site-wide to unconfirmed addresses, after each address's own first 2.
  const A = "198.51.100.120";
  const register = (email, ip) => s.post("/api/auth/register", { email, password: `Aa1-${crypto.randomBytes(9).toString("base64url")}`, name: "Someone" }, { ip, headers: { "X-Form-Token": s.formToken("register") } });
  const got = (email) => s.mail(email, /confirm your email/i).length;
  // The reviewer's worst case: ONE address, account after account.
  const made = [];
  for (let i = 0; i < 7; i++) { const r = await register(`typed${i}@elsewhere.test`, A); assert.strictEqual(r.status, 201, r.text.slice(0, 200)); made.push(r.body); }
  // (This server has no mail provider configured: what "sent" means here is that the message reached the outbox folder.)
  assert.deepStrictEqual(made.map((b, i) => got(`typed${i}@elsewhere.test`) > 0), [true, true, true, true, true, false, false], "its own two, the site's three, then no more this hour");
  assert.deepStrictEqual(made.slice(5).map((b) => [b.verificationQueued, /within the hour/.test(b.verificationMessage || "")]), [[true, true], [true, true]], "the ones over the cap are in line, and the answer says so");
  assert.strictEqual(got("typed5@elsewhere.test"), 0);
  assert.strictEqual(s.mail(s.adminEmail, /hourly limit reached for confirmation emails/i).length, 1, "the owner is told once");
  // "Send it again", from that address: an honest answer while it is held, and a limit per address (five an hour) as well as per account.
  const again = await s.post("/api/auth/verify-email/resend", {}, { ip: A, token: made[5].token });
  assert.deepStrictEqual([again.status, again.body.sent, again.body.queued], [200, false, true], again.text.slice(0, 200));
  assert.ok(/within the hour/.test(again.body.message));
  const more = [];
  for (let i = 0; i < 6; i++) more.push((await s.post("/api/auth/verify-email/resend", {}, { ip: A, token: made[i].token })).status);
  assert.deepStrictEqual(more, [200, 200, 200, 200, 429, 429], `one address asked for ${more.length + 1} resends on different accounts: ${more.join(" ")}`);
  // A real new customer, at that moment, from their own address:
  const customer = await register("new-customer@somewhere.test", "203.0.113.160");
  assert.deepStrictEqual([customer.status, customer.body.verificationQueued], [201, false], customer.text.slice(0, 200));
  assert.strictEqual(got("new-customer@somewhere.test"), 1, "their confirmation email is sent at once (it used to be dropped until the hour ended, and they could not check out)");
});

test("RR-04: a held confirmation email is sent when the hour turns", async () => {
  const caps = require("../services/mailCaps");
  // The suite's harness replaces mailer.send with a recorder; this test needs the real one, so it loads its own copy of the module.
  const mailerPath = require.resolve("../services/mailer");
  const recorded = require.cache[mailerPath];
  delete require.cache[mailerPath];
  const mailer = require("../services/mailer");
  const saved = process.env.MAIL_UNCONFIRMED_PER_HOUR_SITE;
  process.env.MAIL_UNCONFIRMED_PER_HOUR_SITE = "1";
  caps.resetForTests();
  const realNow = Date.now;
  try {
    const message = (to) => ({ to, template: "verifyEmail", subject: "Straightedge: confirm your email address", text: "link" });
    await mailer.send(message("first@x.test"));                       // uses the hour's one
    const held = await mailer.send(message("second@x.test"));
    assert.strictEqual(held, mailer.HELD, `over the cap: the mailer answers 'held', not false (${JSON.stringify(caps.counters().unconfirmed)})`);
    assert.strictEqual(caps.heldQueue.length, 1);
    assert.strictEqual(caps.recentlyDropped("second@x.test", "verifyEmail"), false, "held is not turned away");
    // One address may have three waiting; its fourth is turned away, and that is recorded as the cap's doing
    // (the resend route does not charge the customer's day for it).
    for (const to of ["free1@y.test", "free2@y.test"]) await mailer.send({ ...message(to), clientKey: "198.51.100.77" }); // its first two of the hour are outside the cap
    for (const to of ["a@y.test", "b@y.test", "c@y.test"]) assert.strictEqual(await mailer.send({ ...message(to), clientKey: "198.51.100.77" }), mailer.HELD);
    assert.strictEqual(await mailer.send({ ...message("d@y.test"), clientKey: "198.51.100.77" }), false, "the fourth from one address is not kept");
    assert.strictEqual(caps.recentlyDropped("d@y.test", "verifyEmail"), true);
    assert.strictEqual(caps.heldQueue.length, 4);
    caps.heldQueue.splice(1); // back to the one this test follows
    await mailer.flushHeld();
    assert.strictEqual(caps.heldQueue.length, 1, "still this hour: it waits");
    Date.now = () => realNow() + 61 * 60 * 1000;
    await mailer.flushHeld();
    assert.strictEqual(caps.heldQueue.length, 0, "the hour turned: it went");
    assert.strictEqual(caps.counters().unconfirmed.sentLaterSinceStart, 1);
  } finally {
    Date.now = realNow;
    require.cache[mailerPath] = recorded;
    if (saved === undefined) delete process.env.MAIL_UNCONFIRMED_PER_HOUR_SITE; else process.env.MAIL_UNCONFIRMED_PER_HOUR_SITE = saved;
    caps.resetForTests();
  }
});

run(async () => { if (h) await h.stop(); if (s) await s.stop(); process.exit(process.exitCode || 0); });
