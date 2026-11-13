/**
 * Start the real server (server/index.js) as a child process for a test: its
 * own port, a throwaway database and data folder, and whatever environment the
 * test needs. Unlike testSupport/harness.js (the routers on a bare Express
 * app), this is the whole thing — helmet, the body-size limits, the rate
 * limiters, the proxy setting, the error handler — so a suite can check what a
 * client really gets.
 *
 *   const s = await require("../testSupport/liveServer").start({ env: { UPLOAD_MAX_FILES: "3" } });
 *   const r = await s.upload([{ name: "part.stl", data }], { ip: "203.0.113.9" });
 *   s.log()      → everything the server printed so far
 *   await s.stop();
 *
 * The account and bot gates are all in force, so the helpers act the way a
 * person using the site does:
 *   s.register(email)        a form token a few seconds old, then the emailed
 *                            confirmation link is opened (read from the outbox)
 *   s.admin()                the same for ADMIN_EMAIL, then two-step sign-in is
 *                            switched on (required for the admin role)
 *   s.rfq(fields, files)     the request form, with its form token
 *   s.formToken("rfq")       a form token as if the form had been open ten seconds
 *   s.mail(to, /subject/)    messages the server wrote to its outbox
 * Turnstile has no keys here (the bot check is "off", as in production before
 * the owner sets them) unless a test passes its own.
 *
 * Secrets: JWT_SECRET, the Stripe key and the webhook signing secret are random
 * throwaway strings made here at run time; nothing real is ever used and nothing
 * is written down. Pass `env: { STRIPE_WEBHOOK_SECRET: "" }` to start without one
 * (production then refuses to start, which is what such a test is checking).
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const totp = require("../security/totp");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** One HTTP request on a fresh connection; never throws on a status code. */
function request(port, { method = "GET", url = "/", headers = {}, body, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json, buffer, ms: Date.now() - started });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms: ${method} ${url}`)));
    req.on("error", (err) => {
      // The server may answer and close before the body is fully sent (413 on Content-Length); that is an answer, not a failure.
      if (req._seResponse) return;
      reject(err);
    });
    req.on("response", () => { req._seResponse = true; });
    if (body) req.write(body);
    req.end();
  });
}

/** multipart/form-data body. files: [{ field, name, data, type }] */
function multipart(fields = {}, files = []) {
  const boundary = `----se${crypto.randomBytes(12).toString("hex")}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    // The file name is written exactly as given: tests use this to send hostile names.
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field || "files"}"; filename="${f.name}"\r\nContent-Type: ${f.type || "application/octet-stream"}\r\n\r\n`));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) } };
}

async function start({ env = {}, production = true, prepare, tmpDir } = {}) {
  // tmpDir: start again on the folder of a server stopped with stop({ keep: true }) — same database, same files.
  const tmp = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), "se-live-"));
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (typeof prepare === "function") await prepare(dataDir); // e.g. put files on disk before the server starts
  const port = await freePort();
  const adminEmail = "owner@shop.test";

  const childEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: production ? "production" : "test",
    USE_SQLITE: "true",
    QUOTING_DB_PATH: path.join(dataDir, "quoting.db"),
    QUOTING_DATA_DIR: dataDir,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    STRIPE_SECRET_KEY: `sk_test_${crypto.randomBytes(16).toString("hex")}`,
    // Production does not start without a webhook signing secret. A throwaway one, made here; `s.webhookSecret` signs with it.
    STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(24).toString("hex")}`,
    ADMIN_EMAIL: adminEmail,
    FRONTEND_URL: `http://127.0.0.1:${port}`,
    // Every message the server would send is also written here, so a test can open an emailed link.
    // In production mode the mailer only honours it together with the test switch.
    EMAIL_OUTBOX_DIR: path.join(tmp, "outbox"),
    SE_TEST_HOOKS: "1",
    // The admin account is made by the one-time setup with a code the owner sets himself; a throwaway one here.
    ADMIN_SETUP_CODE: `setup-${crypto.randomBytes(18).toString("base64url")}`,
    // Production refuses to start without the Turnstile keys unless this is set (security/botCheckStartup.js).
    // The suites run with the check off unless they pass keys; one of them passes "" here to see the refusal.
    ALLOW_LAUNCH_WITHOUT_BOT_CHECK: "1",
    ...env,
  };
  for (const k of ["EMAIL_API_KEY", "EMAIL_FROM", "STRIPE_PROMOTION_CODES", "CHECKOUT_SESSION_MINUTES", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "ADMIN_RECOVERY", "STRIPE_WEBHOOK_ALLOW_UNSIGNED"]) if (!(k in env)) delete childEnv[k];
  if (!("NORD_FILE_ENC_KEY" in env)) delete childEnv.NORD_FILE_ENC_KEY;
  if (!("NORD_FILE_ENC_KEY_PREVIOUS" in env)) delete childEnv.NORD_FILE_ENC_KEY_PREVIOUS;

  let output = "";
  let exited = null;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: tmp, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  // Wait until it answers the health check (or dies).
  const deadline = Date.now() + 30000;
  for (;;) {
    if (exited) break;
    try {
      const r = await request(port, { url: "/api/health", timeoutMs: 1000 });
      if (r.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`server did not start:\n${output}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  const s = {
    port, tmp, dataDir, adminEmail, child,
    setupCode: childEnv.ADMIN_SETUP_CODE,
    webhookSecret: childEnv.STRIPE_WEBHOOK_SECRET,
    base: `http://127.0.0.1:${port}`,
    exited: () => exited,
    log: () => output,
    dir: (name) => path.join(dataDir, name),
    /** Files currently in one of the data folders. */
    files: (name) => { try { return fs.readdirSync(path.join(dataDir, name)); } catch { return []; } },
    /**
     * @param {object} o  method, url, json (object → JSON body), headers, token,
     *                    ip (sent as X-Forwarded-For, the way Railway's edge reports the client)
     */
    req(o = {}) {
      // These helpers are an API client holding its own session token, so they ask for it in the answer
      // (`X-Session-Token: body`); a browser never does. `{ browser: true }` leaves the header off.
      const headers = { ...(o.browser ? {} : { "X-Session-Token": "body" }), ...(o.headers || {}) };
      if (o.ip) headers["X-Forwarded-For"] = o.ip;
      if (o.token) headers.Authorization = `Bearer ${o.token}`;
      let body = o.body;
      let json = o.json;
      // As the quote page does: each part of a quote request carries the edit key its upload answer gave
      // (security/partAccess.js). `{ partKeys: false }` sends the body exactly as written.
      if (o.partKeys !== false && json && typeof json === "object" && Array.isArray(json.parts) && String(o.url).split("?")[0] === "/api/quote") {
        json = { ...json, parts: json.parts.map((p) => (p && typeof p === "object" && !Array.isArray(p) && typeof p.partId === "string" && p.editKey === undefined && s.editKeys[p.partId] ? { ...p, editKey: s.editKeys[p.partId] } : p)) };
      }
      if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(body.length); }
      return request(port, { method: o.method || (body ? "POST" : "GET"), url: o.url, headers, body, timeoutMs: o.timeoutMs }).then((r) => {
        if (r.body && Array.isArray(r.body.parts)) for (const p of r.body.parts) if (p && p.partId && p.editKey) s.editKeys[p.partId] = p.editKey;
        return r;
      });
    },
    /** partId → edit key, for every part uploaded through this helper. */
    editKeys: {},
    get: (url, o = {}) => s.req({ ...o, url, method: "GET" }),
    post: (url, json, o = {}) => s.req({ ...o, url, method: "POST", json }),
    /** POST multipart to `url` (default the CAD upload). files: [{ name, data, field }] */
    upload(files, o = {}) {
      const m = multipart(o.fields || {}, files);
      return s.req({ ...o, url: o.url || "/api/upload", method: "POST", body: m.body, headers: { ...m.headers, ...(o.headers || {}) } });
    },
    /**
     * A form token for `form` ("register", "rfq", "password-reset") issued `agoMs` ago, as if a
     * person had had the form open that long. Signed here with the server's own throwaway secret
     * (this process made it); the server checks it exactly as it checks one it issued itself.
     */
    formToken(form, agoMs = 10000) {
      const prev = process.env.JWT_SECRET;
      process.env.JWT_SECRET = childEnv.JWT_SECRET;
      try { return require("../security/botGuard").issueFormToken(form, { now: Date.now() - agoMs }); }
      finally { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; }
    },
    /** Messages in the server's outbox, oldest first, optionally for one recipient and a subject pattern. */
    mail(to, re) {
      const dir = childEnv.EMAIL_OUTBOX_DIR;
      let names = [];
      try { names = fs.readdirSync(dir).sort(); } catch { /* nothing sent yet */ }
      // (A server killed while it was writing an outbox file leaves that file empty or cut short. Such a
      // message never went anywhere: it is not counted, and it must not stop the reader. Seen once in 30
      // kill rounds of durability-kill.js section D, 2026-11-13.)
      return names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
        .filter((m) => m && (!to || (Array.isArray(m.to) ? m.to.includes(to) : m.to === to)) && (!re || re.test(m.subject)));
    },
    /**
     * Create an account the way a person does: the form open a few seconds, then the emailed
     * confirmation link opened. Returns the session token. `{ verify: false }` leaves the address unconfirmed.
     */
    async register(email, o = {}) {
      const password = o.password || `Aa1-${crypto.randomBytes(9).toString("base64url")}`;
      const r = await s.post("/api/auth/register", { email, password, name: "Test Buyer" }, { ...o, headers: { "X-Form-Token": s.formToken("register"), ...(o.headers || {}) } });
      if (r.status !== 201) throw new Error(`register failed (${r.status}): ${r.text}`);
      s.passwords[email] = password;
      if (o.verify !== false) await s.confirmEmail(email, o);
      return r.body.token;
    },
    passwords: {},
    async confirmEmail(email, o = {}) {
      let mail;
      for (let i = 0; i < 40 && !mail; i++) { mail = s.mail(email, /confirm your email/i).pop(); if (!mail) await new Promise((r) => setTimeout(r, 50)); }
      if (!mail) throw new Error(`no confirmation email in the outbox for ${email}`);
      const token = (mail.text.match(/#token=(\S+)/) || [])[1];
      const v = await s.post("/api/auth/verify-email", { token }, { ip: o.ip });
      if (v.status !== 200) throw new Error(`verify failed (${v.status}): ${v.text}`);
      return v.body;
    },
    /**
     * The owner's account as the owner sets it up: the one-time setup with the code from the host's
     * variables (POST /api/auth/admin-setup), then two-step sign-in on (without it every admin route is 403).
     * Returns the session token issued at enrolment; `{ enrol: false }` stops before the second step.
     */
    async admin(o = {}) {
      const password = o.password || `Aa1-${crypto.randomBytes(9).toString("base64url")}`;
      const r = await s.post("/api/auth/admin-setup", { code: s.setupCode, password }, { ip: o.ip, headers: o.headers });
      if (r.status !== 201) throw new Error(`admin setup failed (${r.status}): ${r.text}`);
      s.passwords[adminEmail] = password;
      if (o.enrol === false) return r.body.token;
      return s.enrol(r.body.token, o);
    },
    /** Switch two-step sign-in on for the owner's account, as the enrolment screen does. Returns the new session token. */
    async enrol(token, o = {}) {
      const setup = await s.post("/api/auth/2fa/setup", { password: s.passwords[adminEmail] }, { ip: o.ip, token });
      if (setup.status !== 200) throw new Error(`2fa setup failed (${setup.status}): ${setup.text}`);
      s.adminSecret = setup.body.setupKey.replace(/\s/g, "");
      const enabled = await s.post("/api/auth/2fa/enable", { code: totp.codeAt(s.adminSecret) }, { ip: o.ip, token });
      if (enabled.status !== 200) throw new Error(`2fa enable failed (${enabled.status}): ${enabled.text}`);
      return enabled.body.token;
    },
    /**
     * Headers that carry a session the way the browser does: the httpOnly cookie, plus the CSRF
     * token the page gets from /api/auth/session (`{ csrf: false }` leaves it off, as another site would have to).
     */
    async browser(token, { csrf = true } = {}) {
      const cookie = `${production ? "__Host-" : ""}se_session=${token}`;
      if (!csrf) return { Cookie: cookie };
      if (!s.csrfTokens[token]) {
        const r = await s.req({ url: "/api/auth/session", headers: { Cookie: cookie } });
        if (!r.body || !r.body.authenticated) throw new Error(`no session for that cookie: ${r.text}`);
        s.csrfTokens[token] = r.body.csrfToken;
      }
      return { Cookie: cookie, "X-CSRF-Token": s.csrfTokens[token] };
    },
    csrfTokens: {},
    /** The request form as a person sends it (multipart, with its form token). files: [{ name, data, field }] */
    rfq(fields = {}, files = [], o = {}) {
      return s.upload(files.map((f) => ({ field: "drawing", ...f })), { ...o, url: "/api/rfq", fields, headers: { "X-Form-Token": s.formToken("rfq"), ...(o.headers || {}) } });
    },
    async stop({ keep = false } = {}) {
      if (!exited) {
        child.kill("SIGTERM");
        await new Promise((resolve) => { const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
      }
      if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  // (A folder the caller handed in is the caller's: it is not removed when the start fails, so a test can
  // look at what a refused start left on disk. A folder made here is removed, as before.)
  if (exited) { const log = output; await s.stop({ keep: Boolean(tmpDir) }); throw Object.assign(new Error(`server exited at startup (${exited.code}):\n${log}`), { exitCode: exited.code, output: log }); }
  return s;
}

module.exports = { start, request, multipart, freePort, ROOT };
