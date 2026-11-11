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
 * Secrets: JWT_SECRET and the Stripe key are random throwaway strings made
 * here at run time; nothing real is ever used and nothing is written down.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

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
    ADMIN_EMAIL: adminEmail,
    FRONTEND_URL: `http://127.0.0.1:${port}`,
    ...env,
  };
  for (const k of ["EMAIL_API_KEY", "EMAIL_FROM", "STRIPE_WEBHOOK_SECRET", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) if (!(k in env)) delete childEnv[k];
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
      const headers = { ...(o.headers || {}) };
      if (o.ip) headers["X-Forwarded-For"] = o.ip;
      if (o.token) headers.Authorization = `Bearer ${o.token}`;
      let body = o.body;
      if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(body.length); }
      return request(port, { method: o.method || (body ? "POST" : "GET"), url: o.url, headers, body, timeoutMs: o.timeoutMs });
    },
    get: (url, o = {}) => s.req({ ...o, url, method: "GET" }),
    post: (url, json, o = {}) => s.req({ ...o, url, method: "POST", json }),
    /** POST multipart to `url` (default the CAD upload). files: [{ name, data, field }] */
    upload(files, o = {}) {
      const m = multipart(o.fields || {}, files);
      return s.req({ ...o, url: o.url || "/api/upload", method: "POST", body: m.body, headers: { ...m.headers, ...(o.headers || {}) } });
    },
    async register(email, o = {}) {
      const r = await s.post("/api/auth/register", { email, password: `Aa1${crypto.randomBytes(9).toString("hex")}`, name: "Test Buyer" }, o);
      if (r.status !== 201) throw new Error(`register failed (${r.status}): ${r.text}`);
      return r.body.token;
    },
    admin: (o = {}) => s.register(adminEmail, o),
    async stop({ keep = false } = {}) {
      if (!exited) {
        child.kill("SIGTERM");
        await new Promise((resolve) => { const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
      }
      if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  if (exited) { const log = output; await s.stop(); throw Object.assign(new Error(`server exited at startup (${exited.code}):\n${log}`), { exitCode: exited.code, output: log }); }
  return s;
}

module.exports = { start, request, multipart, freePort, ROOT };
