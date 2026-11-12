#!/usr/bin/env node
/**
 * csp-browser-check.js — load the built site in a real browser (Chromium via
 * Playwright) and fail if the Content-Security-Policy blocks anything.
 *
 * It walks every public page (from client/dist/seo-manifest.json); the app
 * pages signed out; the quote tool with the one-time bot check, a 3D preview,
 * the same quote reopened (the preview read back from its file) and a DXF
 * preview; an account from registration (with the bot-check widget) through
 * the emailed confirmation link to checkout and the paid order page; password
 * reset end to end; both request forms through to their confirmation screens;
 * and the admin area: the two-step enrolment screen (QR code drawn in the
 * page), the recovery codes, every tab, the pricing console, then sign-out and
 * sign-in with a code. A step fails on any of:
 *   - a `securitypolicyviolation` event (caught by a listener injected before
 *     the page's own scripts)
 *   - a console message that mentions the Content-Security-Policy
 *   - an uncaught page error, or a same-origin request that failed
 * It then proves the detector and the policy both work: an injected inline
 * script, eval, an inline handler, a <style> block, a third-party script, a
 * cross-origin fetch and a frame must each be blocked, and each reported.
 *
 * It starts the server itself, in production mode, on a throwaway database
 * and data folder under --scratch, with the outside calls stubbed in the
 * server process the way the browser run does (scripts/e2e/stub-network.cjs:
 * Turnstile siteverify, Resend, Stripe). Every key and password is made at run
 * time. Cloudflare's widget script cannot be fetched from a sandbox, so the
 * browser is handed a stand-in for that exact URL
 * (scripts/e2e/turnstile-standin.cjs): it runs only because the policy allows
 * that host for scripts, and opens a frame on that host as the real widget
 * does. What that does not prove is Cloudflare's own script; run this once
 * against real keys before relying on it.
 *
 *   npm run build
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
 *     node tools/security/csp-browser-check.js --scratch <dir> [--port 3092] [--shots <dir>]
 *
 * Playwright is not a dependency of this repo. Point PLAYWRIGHT at an install
 * (default: require("playwright")):  PLAYWRIGHT=/opt/npm-tools/node_modules/playwright
 * Exit code 0 = clean.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const PORT = Number(arg("port", "3092"));
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = "owner@csp-check.test";
const SHOTS = arg("shots", "");
const SCRATCH = arg("scratch", "");
if (!SCRATCH) { console.error("--scratch <dir> is required (database, data folder, outbox, server log)"); process.exit(2); }
const ROOT = path.join(__dirname, "..", "..");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const totp = require(path.join(ROOT, "server", "security", "totp.js"));
const { routeStandIn } = require(path.join(ROOT, "scripts", "e2e", "turnstile-standin.cjs"));

const CSP_TEXT = /content security policy|content-security-policy|refused to (load|execute|apply|connect|frame|create|run)|violates the following/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newPassword = () => `Qz8-${crypto.randomBytes(9).toString("base64url")}`; // throwaway, never stored

// ─── The server: production mode, its own database and files, outside calls stubbed ───
const OUTBOX = path.join(SCRATCH, "outbox");
let server = null;
async function startServer() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(SCRATCH, "data"), { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    USE_SQLITE: "true",
    QUOTING_DB_PATH: path.join(SCRATCH, "data", "quoting.db"),
    QUOTING_DATA_DIR: path.join(SCRATCH, "data"),
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(16).toString("hex")}`,
    ADMIN_EMAIL,
    FRONTEND_URL: BASE,
    EMAIL_API_KEY: "test-not-a-key",
    EMAIL_FROM: "Straightedge <quotes@csp-check.test>",
    EMAIL_OUTBOX_DIR: OUTBOX,
    SE_TEST_HOOKS: "1",
    E2E_STUBS: "1",
    TURNSTILE_SITE_KEY: `e2e-site-${crypto.randomBytes(6).toString("hex")}`,
    TURNSTILE_SECRET_KEY: `e2e-secret-${crypto.randomBytes(12).toString("hex")}`,
  };
  for (const k of ["ADMIN_RECOVERY", "NORD_FILE_ENC_KEY", "NORD_FILE_ENC_KEY_PREVIOUS", "CSP_REPORT_ONLY"]) delete env[k];
  const log = fs.createWriteStream(path.join(SCRATCH, "server.log"));
  const child = spawn(process.execPath, ["-r", path.join(ROOT, "scripts", "e2e", "stub-network.cjs"), path.join(ROOT, "server", "index.js")], { cwd: SCRATCH, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  server = child;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not start; see ${path.join(SCRATCH, "server.log")}`);
}
async function stopServer() {
  if (!server) return;
  const child = server; server = null;
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); });
}
const mails = () => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).sort().map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8"))) : []);
async function mailTo(to, re) {
  for (let i = 0; i < 60; i++) {
    const hit = mails().filter((m) => (Array.isArray(m.to) ? m.to.includes(to) : m.to === to) && re.test(m.subject)).pop();
    if (hit) return hit;
    await sleep(150);
  }
  throw new Error(`no email to ${to} matching ${re}`);
}
const linkIn = (mail, page) => (mail.text.match(new RegExp(`${BASE}/${page}#token=\\S+`)) || [])[0];

(async () => {
  await startServer();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "client", "dist", "seo-manifest.json"), "utf8"));
  const publicPages = Object.keys(manifest.routes);
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await routeStandIn(context); // Cloudflare's script URL answers with the stand-in; the policy still decides whether it may run

  const steps = [];      // { name, url, violations, consoleCsp, pageErrors, failed }
  let current = null;
  await context.exposeBinding("__cspReport", (source, v) => { if (current) current.violations.push(v); });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspReport({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile || "", line: e.lineNumber || 0, sample: e.sample || "", page: location.pathname });
    });
  });
  let page = await context.newPage();
  const watch = (p) => {
    p.on("console", (m) => { if (current && CSP_TEXT.test(m.text())) current.consoleCsp.push(`[${m.type()}] ${m.text().slice(0, 300)}`); else if (current && m.type() === "error") current.consoleErrors.push(m.text().slice(0, 200)); });
    p.on("pageerror", (e) => { if (current) current.pageErrors.push(String(e.message || e).slice(0, 300)); });
    p.on("requestfailed", (r) => {
      const f = r.failure();
      if (!current || !r.url().startsWith(BASE)) return;
      if (f && /ERR_ABORTED/.test(f.errorText)) return; // navigation moved on
      current.failed.push(`${r.method()} ${r.url().replace(BASE, "")} — ${f ? f.errorText : "failed"}`);
    });
  };
  watch(page);

  async function step(name, fn) {
    current = { name, url: "", violations: [], consoleCsp: [], consoleErrors: [], pageErrors: [], failed: [], note: "" };
    steps.push(current);
    try {
      await fn(current);
    } catch (err) {
      current.pageErrors.push(`step failed: ${String(err.message || err).split("\n")[0]}`);
    }
    current.url = page.url().replace(BASE, "");
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${String(steps.length).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`) }).catch(() => {}); }
    const s = current;
    const bad = s.violations.length + s.consoleCsp.length + s.pageErrors.length + s.failed.length;
    console.log(`${bad ? "FAIL" : " ok "}  ${name}${s.note ? `  (${s.note})` : ""}`);
    for (const v of s.violations) console.log(`        CSP violation: ${v.directive} blocked ${v.blocked || "inline"} ${v.source ? `at ${v.source}:${v.line}` : ""} ${v.sample ? `sample: ${v.sample}` : ""}`);
    for (const c of s.consoleCsp) console.log(`        console: ${c}`);
    for (const e of s.pageErrors) console.log(`        page error: ${e}`);
    for (const f of s.failed) console.log(`        request failed: ${f}`);
    return s;
  }
  const settle = async (ms = 400) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(ms); };
  const visit = async (url) => { const r = await page.goto(BASE + url, { waitUntil: "domcontentloaded" }); await settle(); return r; };
  const rendered = async () => (await page.locator("#root").innerText()).trim().length;

  // ── 1. Every public page ────────────────────────────────────
  for (const url of publicPages) {
    await step(`public ${url}`, async (s) => {
      const r = await visit(url);
      const csp = r.headers()["content-security-policy"] || "";
      if (!csp) throw new Error("no Content-Security-Policy header");
      if (/unsafe-eval/.test(csp) || /script-src[^;]*unsafe-inline/.test(csp)) throw new Error(`script policy is not strict: ${csp}`);
      if (r.status() !== 200) throw new Error(`status ${r.status()}`);
      const n = await rendered();
      if (n < 200) throw new Error(`page rendered only ${n} characters`);
      // scroll through so lazy images and below-the-fold components load
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r2) => setTimeout(r2, 40)); } window.scrollTo(0, 0); });
      await settle(200);
      const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").length);
      s.note = `${n} chars, ${fonts} fonts loaded`;
      if (fonts === 0) throw new Error("no web font loaded (font-src too strict?)");
    });
  }
  // Hand-written pages and sample documents under /brand are internal: the live site answers 404 for
  // them. The brand assets the pages use (logos, icons, Open Graph images) are still served.
  const dist = path.join(ROOT, "client", "dist");
  await step("internal brand pages and sample documents are not served; brand assets are", async (s) => {
    const internal = [...fs.readdirSync(path.join(dist, "brand")).filter((f) => /\.(html|md|pdf)$/.test(f)).map((f) => `/brand/${f}`),
      ...fs.readdirSync(path.join(dist, "brand", "documents")).map((f) => `/brand/documents/${f}`)];
    for (const url of internal) {
      const r = await page.request.get(BASE + url);
      if (r.status() !== 404) throw new Error(`${url} answered ${r.status()}`);
    }
    const r = await visit("/brand/brand-guide.html");
    if (r.status() !== 404) throw new Error(`/brand/brand-guide.html opened in the browser with status ${r.status()}`);
    const assets = ["/brand/og-default.png", "/brand/icon-192.png", ...fs.readdirSync(path.join(dist, "brand")).filter((f) => f.endsWith(".svg")).slice(0, 4).map((f) => `/brand/${f}`)];
    for (const url of assets) {
      const a = await page.request.get(BASE + url);
      if (a.status() !== 200) throw new Error(`${url} answered ${a.status()}`);
    }
    s.note = `${internal.length} internal files → 404, ${assets.length} assets → 200`;
  });
  await step("public 404 page", async () => { const r = await visit("/no-such-page"); if (r.status() !== 404) throw new Error(`status ${r.status()}`); if ((await rendered()) < 50) throw new Error("empty"); });

  // ── 2. App pages, signed out ────────────────────────────────
  for (const url of ["/login", "/forgot-password", "/reset-password", "/verify-email", "/rfq", "/rfq?nocad=1", "/quote", "/firm-quote/not-a-real-token", "/dashboard", "/admin"]) {
    await step(`app ${url} (signed out)`, async (s) => { await visit(url); const n = await rendered(); s.note = `${n} chars → ${page.url().replace(BASE, "")}`; if (n < 20) throw new Error("empty page"); });
  }
  const checkPassed = (p = page) => p.getByRole("group", { name: "Spam check" }).getByText("Check passed.").waitFor({ timeout: 20000 });
  await step("register page: the bot-check widget container, its script and its frame", async (s) => {
    const asked = [];
    const onRequest = (r) => { if (r.url().includes("challenges.cloudflare.com")) asked.push(r.resourceType()); };
    page.on("request", onRequest);
    await visit("/register");
    await checkPassed();
    page.off("request", onRequest);
    const frames = await page.locator('iframe[src^="https://challenges.cloudflare.com/"]').count();
    s.note = `widget ran (${asked.join(", ")}), ${frames} frame on Cloudflare's host`;
    if (!asked.includes("script")) throw new Error("the widget script was never requested");
    if (frames < 1) throw new Error("the widget's frame is missing");
  });

  // ── 3. Quote tool: bot check → upload → 3D preview → price; reopened; DXF → 2D preview ──
  let quoteId = null;
  const canvasInfo = () => page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    return { w: c.width, h: c.height, webgl: Boolean(gl) };
  });
  await step("quote tool: one-time bot check, STL upload, 3D preview (three.js / WebGL), live price", async (s) => {
    await visit("/quote?process=cnc");
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "tools", "vet-quotes", "parts", "star_wheel.stl"));
    const dialog = page.getByRole("dialog", { name: "One quick check" });
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    await dialog.waitFor({ state: "hidden", timeout: 20000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await settle(1500);
    const canvas = await canvasInfo();
    if (!(canvas.w > 50 && canvas.h > 50)) throw new Error(`canvas is ${canvas.w}×${canvas.h}`);
    await page.waitForFunction(() => /\$\s?\d/.test(document.querySelector("#root").innerText), null, { timeout: 20000 });
    quoteId = await page.evaluate(() => { for (let i = 0; i < sessionStorage.length; i++) { const v = sessionStorage.getItem(sessionStorage.key(i)); if (/^[0-9a-f-]{36}$/.test(v || "")) return v; } return null; });
    // rotate the model: pointer events drive the viewer's own controls
    const box = await page.locator("canvas").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    await settle(300);
    s.note = `canvas ${canvas.w}×${canvas.h}, WebGL ${canvas.webgl ? "on" : "context not readable (already in use)"}, quote ${quoteId ? quoteId.slice(0, 8) : "?"}`;
    if (!quoteId) throw new Error("no quote id in sessionStorage");
  });
  await step("quote tool: the page reloaded — the quote reopens and the 3D preview is read back from the part's file", async (s) => {
    const [session] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/quote/${quoteId}/session`), { timeout: 20000 }),
      page.reload({ waitUntil: "domcontentloaded" }),
    ]);
    const body = await session.json();
    const vertices = body.parts[0].meshPreview.positions.length / 3;
    await page.waitForSelector("canvas", { timeout: 30000 });
    await settle(1200);
    const canvas = await canvasInfo();
    const onDisk = fs.readdirSync(path.join(SCRATCH, "data", "part-payloads")).filter((f) => f.endsWith(".mesh.json"));
    s.note = `${vertices} vertices from ${onDisk.length} mesh file(s), canvas ${canvas.w}×${canvas.h}`;
    if (session.status() !== 200 || !(vertices > 1000)) throw new Error(`the session answer carried ${vertices} vertices (status ${session.status()})`);
    if (body.parts[0].previewUnavailable) throw new Error("the preview was reported unavailable");
    if (!(canvas && canvas.w > 50 && canvas.h > 50)) throw new Error("no canvas after the reload");
    if (onDisk.length < 1) throw new Error("no mesh file under data/part-payloads");
    if (!/star_wheel/i.test(await page.locator("#root").innerText())) throw new Error("the part did not come back");
  });
  await step("quote tool: STEP upload (second part)", async () => {
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "server", "geometry", "fixtures", "plate_holes.step"));
    await settle(3500);
    if (!/plate_holes/i.test(await page.locator("#root").innerText())) throw new Error("the STEP part did not appear");
  });
  await step("quote tool: DXF upload for routing, 2D preview (SVG)", async (s) => {
    const keep = quoteId;
    await page.evaluate(() => { for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i); if (!/human/.test(k)) sessionStorage.removeItem(k); } });
    await visit("/quote?process=routing");
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "tools", "vet-quotes", "parts", "dxf_plate_holes.dxf"));
    await settle(2500);
    const svgs = await page.locator("svg path, svg circle, svg polyline, svg polygon").count();
    s.note = `${svgs} SVG shapes`;
    if (!/dxf_plate_holes/i.test(await page.locator("#root").innerText())) throw new Error("the DXF part did not appear");
    quoteId = keep;
  });

  // ── 4. An account: register → confirm by emailed link → checkout → paid order ──
  const buyerEmail = `buyer-${crypto.randomBytes(4).toString("hex")}@csp-check.test`;
  let buyerPassword = newPassword();
  await step("register: account created through the form, with the bot check", async (s) => {
    await visit(`/register?next=${encodeURIComponent(`/checkout/${quoteId}`)}`);
    await page.getByLabel("Name").fill("Browser Check");
    await page.getByLabel("Email").fill(buyerEmail);
    await page.getByLabel("Password").fill(buyerPassword);
    await checkPassed();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/checkout\//, { timeout: 20000 });
    await settle();
    s.note = `signed in, at ${page.url().replace(BASE, "")}`;
  });
  await step("checkout page: held until the email is confirmed", async (s) => {
    await page.getByRole("region", { name: "Confirm your email address" }).waitFor({ timeout: 15000 });
    s.note = `${await rendered()} chars`;
  });
  await step("email confirmation: the emailed link opened in a new tab", async (s) => {
    const mail = await mailTo(buyerEmail, /confirm your email/i);
    const tab = await context.newPage();
    watch(tab);
    await tab.goto(linkIn(mail, "verify-email"), { waitUntil: "domcontentloaded" });
    await tab.getByText("is confirmed").waitFor({ timeout: 15000 });
    s.note = `${(await tab.locator("#root").innerText()).trim().length} chars, token removed from the address bar: ${!tab.url().includes("token=")}`;
    await tab.close();
  });
  let orderUrl = "";
  await step("checkout: shipping form, pay, back from the payment page to the paid order", async (s) => {
    const pay = page.getByRole("button", { name: /Pay and place order/ }); // button wording changed in the journey pass
    await page.getByLabel("Full Name").fill("Browser Check");
    await page.getByLabel("Street Address").fill("1 Test Street");
    await page.getByLabel("City").fill("Elgin");
    await page.getByLabel("State").fill("IL");
    await page.getByLabel("ZIP Code").fill("60120");
    await page.getByRole("region", { name: "Confirm your email address" }).waitFor({ state: "hidden", timeout: 30000 });
    // Stripe is stubbed in the server: its "hosted page" is the order's own return URL, already paid.
    await Promise.all([page.waitForURL(/\/orders\/[0-9a-f-]+\?paid=true/, { timeout: 20000 }), pay.click()]);
    await page.getByRole("heading", { name: /^Order [0-9A-F]{8}$/ }).waitFor({ timeout: 15000 });
    await settle();
    orderUrl = page.url().replace(BASE, "").split("?")[0];
    s.note = `order page ${orderUrl.slice(0, 16)}…, ${await rendered()} chars`;
  });
  await step("customer dashboard (signed in)", async () => { await visit("/dashboard"); if ((await rendered()) < 50) throw new Error("empty"); });
  await step("sign out", async () => {
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    await settle();
  });

  // ── 5. Password reset, end to end ───────────────────────────
  await step("password reset: request form with the bot check", async (s) => {
    await visit("/forgot-password");
    await page.getByLabel("Email").fill(buyerEmail);
    await checkPassed();
    await page.getByRole("button", { name: "Send the reset link" }).click();
    await page.getByText("is on its way").waitFor({ timeout: 15000 });
    s.note = `${await rendered()} chars`;
  });
  await step("password reset: the emailed link, a new password", async (s) => {
    const mail = await mailTo(buyerEmail, /reset your password/i);
    await page.goto(linkIn(mail, "reset-password"), { waitUntil: "domcontentloaded" });
    await page.getByLabel("New password", { exact: true }).waitFor({ timeout: 15000 });
    buyerPassword = newPassword();
    await page.getByLabel("New password", { exact: true }).fill(buyerPassword);
    await page.getByLabel("New password, again").fill(buyerPassword);
    await page.getByRole("button", { name: "Save the new password" }).click();
    await page.getByText("Your password is changed").waitFor({ timeout: 15000 });
    s.note = `token removed from the address bar: ${!page.url().includes("token=")}`;
  });
  await step("sign in with the new password", async () => {
    await visit("/login");
    await page.getByLabel("Email").fill(buyerEmail);
    await page.getByLabel("Password").fill(buyerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    await settle();
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
  });

  // ── 6. Both request forms, through to their confirmation screens ──
  await step("firm-quote request form: filled, bot check, sent, confirmation screen", async (s) => {
    await visit("/rfq");
    await page.getByLabel(/^Name/).fill("Pat Purchasing");
    await page.getByLabel(/^Email/).fill("pat@csp-check.test");
    await page.getByLabel("Quantities to quote").fill("250 / 500");
    await page.getByRole("textbox", { name: "Anything else" }).fill("Runs on a stainless rail. tone = 5; 5 < 10 > 3");
    await page.setInputFiles('input[type="file"]', { name: "print.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% browser check\n%%EOF\n") });
    await checkPassed();
    await page.getByRole("button", { name: "Send for a firm quote" }).click();
    await page.getByRole("heading", { name: "It's in the queue." }).waitFor({ timeout: 15000 });
    await settle();
    const text = await page.locator("#root").innerText();
    s.note = /A confirmation email is on its way/.test(text) ? "sender verified: the page says a confirmation email is on its way" : "no confirmation email claimed";
  });
  await step("send-the-part request form: filled, bot check, sent, confirmation screen", async (s) => {
    await visit("/rfq?nocad=1");
    await page.getByLabel(/^Name/).fill("Sam Maint");
    await page.getByLabel(/^Email/).fill("sam@csp-check.test");
    await page.getByLabel(/What the part is and what it does/).fill("Carton guide on the sealer infeed. Worn on the leading edge.");
    await checkPassed();
    await page.getByRole("button", { name: "Send the request" }).click();
    await page.getByRole("heading", { name: "Now send us the part." }).waitFor({ timeout: 15000 });
    await settle();
    s.note = `${await rendered()} chars`;
  });

  // ── 7. Admin: enrolment is required, then the panel and the pricing console ──
  const ownerPassword = newPassword();
  let setupKey = "";
  await step("admin account: registered, email confirmed, and held at the two-step enrolment screen", async (s) => {
    await visit("/register");
    await page.getByLabel("Name").fill("Owner");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ownerPassword);
    await checkPassed();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/quote/, { timeout: 20000 });
    await page.goto(linkIn(await mailTo(ADMIN_EMAIL, /confirm your email/i), "verify-email"), { waitUntil: "domcontentloaded" });
    await page.getByText("is confirmed").waitFor({ timeout: 15000 });
    await visit("/admin");
    await page.getByTestId("enrolment-gate").waitFor({ timeout: 15000 });
    const tabs = await page.getByRole("button", { name: "RFQs" }).count();
    const stats = await page.evaluate(() => fetch("/api/admin/stats").then(async (r) => ({ status: r.status, body: await r.json() })));
    s.note = `enrolment screen only (admin tabs: ${tabs}); /api/admin/stats → ${stats.status} ${stats.body.code || ""}`;
    if (tabs !== 0) throw new Error("the admin tabs are showing before enrolment");
    if (stats.status !== 403 || stats.body.code !== "two-factor-enrolment-required") throw new Error(`an admin route answered ${stats.status} before enrolment`);
  });
  await step("two-step enrolment: password, QR code drawn in the page, setup key", async (s) => {
    await page.getByLabel("Your password, to start").fill(ownerPassword);
    await page.getByRole("button", { name: "Set up two-step sign-in" }).click();
    await page.getByTestId("twofactor-setup").waitFor({ timeout: 15000 });
    setupKey = (await page.getByTestId("setup-key").textContent()).replace(/\s/g, "");
    const qr = await page.getByRole("img", { name: "QR code for your authenticator app" }).evaluate((el) => ({ tag: el.tagName, paths: el.querySelectorAll("path").length, external: [...el.querySelectorAll("*")].some((n) => n.getAttribute("href") || n.getAttribute("src")) }));
    s.note = `QR is an inline <${qr.tag}> with ${qr.paths} path, nothing fetched: ${!qr.external}`;
    if (qr.tag.toLowerCase() !== "svg" || qr.external) throw new Error("the QR code is not an inline SVG");
  });
  await step("two-step enrolment: code accepted, recovery codes shown, admin pages open", async (s) => {
    await page.getByLabel("6-digit code from the app").fill(totp.codeAt(setupKey));
    await page.getByRole("button", { name: "Switch it on" }).click();
    await page.getByTestId("recovery-codes").waitFor({ timeout: 15000 });
    const codes = await page.getByTestId("recovery-codes").locator("li").count();
    await page.getByRole("button", { name: "I have saved them" }).click();
    await page.getByRole("button", { name: "Security" }).waitFor({ timeout: 15000 });
    await settle(800);
    const text = await page.locator("#root").innerText();
    if (!/Total Orders|Paid Revenue/i.test(text)) throw new Error(`the admin panel did not open after enrolment: ${text.slice(0, 120)}`);
    s.note = `${codes} recovery codes, panel ${text.length} chars`;
  });
  // the tab bar's buttons (the header's menu button shares the class but has no letters in its label)
  const TAB_LABELS = ["Orders", "RFQs", "Parts", "Materials", "Finishes", "Lead Times", "Pricing", "Calibration", "Quotes", "Security"];
  const tabs = (await page.locator("button.btn.btn-ghost").allInnerTexts().catch(() => [])).map((t) => t.trim()).filter((t) => TAB_LABELS.includes(t));
  if (tabs.length !== TAB_LABELS.length) console.log(`        (expected ${TAB_LABELS.length} admin tabs, found ${tabs.length}: ${tabs.join(", ")})`);
  for (const label of tabs) {
    await step(`admin tab: ${label.trim()}`, async (s) => {
      await page.getByRole("button", { name: label, exact: true }).first().click();
      await settle(700);
      s.note = `${await rendered()} chars`;
    });
  }
  await step("admin: request queue — a request opened, the buyer's note shown as text", async (s) => {
    await page.locator("button.btn.btn-ghost", { hasText: /^RFQs$/ }).first().click();
    await settle(600);
    const row = page.locator("tr", { hasText: "Pat Purchasing" }).first();
    await row.getByRole("button", { name: "Detail" }).click();
    await page.getByText("tone = 5; 5 < 10 > 3").first().waitFor({ timeout: 10000 });
    s.note = "note reads as typed";
  });
  await step("admin: pricing console — change a rate, live preview, history", async (s) => {
    await page.locator("button.btn.btn-ghost", { hasText: /pricing/i }).first().click();
    await settle(800);
    const before = await rendered();
    // switch between the console's views, open its history, and edit the first number so the preview re-prices
    for (const name of [/advanced|all rules|detailed/i, /simple/i, /history/i]) {
      const b = page.getByRole("button", { name }).first();
      if (await b.count()) { await b.click().catch(() => {}); await settle(400); }
    }
    const num = page.locator('input[type="number"]').first();
    if (await num.count()) {
      const v = await num.inputValue();
      await num.fill(String((Number(v) || 1) + 1));
      await settle(1500); // debounced POST /api/admin/pricing/preview
      await num.fill(v);
      await settle(800);
    }
    s.note = `${before} chars, ${await page.locator('input[type="number"]').count()} rate fields`;
    if (before < 300) throw new Error("pricing console did not render");
  });
  await step("admin: sign out, then sign in with the password and a code from the app", async (s) => {
    await visit("/admin"); // a fresh view of the panel: nothing the pricing console opened is in the way
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(`${BASE}/`, { timeout: 10000 });
    await visit("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Code from your authenticator app").waitFor({ timeout: 10000 });
    // A code works once: wait for the step after the one used at enrolment.
    const used = totp.stepAt();
    while (totp.stepAt() <= used) await sleep(500);
    await page.getByLabel("Code from your authenticator app").fill(totp.codeAt(setupKey));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    await visit("/admin");
    await page.getByRole("button", { name: "Security" }).waitFor({ timeout: 15000 });
    s.note = "second step asked for and accepted";
  });

  // ── 8. The policy really blocks, and the detector really sees it ──
  let proof = null;
  await visit("/about");
  current = { name: "proof", violations: [], consoleCsp: [], consoleErrors: [], pageErrors: [], failed: [] };
  proof = await page.evaluate(async () => {
    const out = {};
    const s = document.createElement("script"); s.textContent = "window.__inlineRan = true"; document.head.appendChild(s);
    out.inlineRan = window.__inlineRan === true;
    // eval is tried from a timer callback: code run directly by the DevTools protocol (this
    // function) is exempt from the eval check, a page's own code is not.
    await new Promise((resolve) => setTimeout(() => {
      try { out.evalResult = (0, eval)("1 + 1"); } catch (e) { out.evalBlocked = e.name; }
      try { out.fnResult = new Function("return 2")(); } catch (e) { out.functionBlocked = e.name; }
      try { out.timerString = setTimeout("window.__timerStringRan = true", 0); } catch (e) { out.timerStringBlocked = e.name; }
      resolve();
    }, 0));
    const d = document.createElement("div"); d.innerHTML = '<a id="__h" onclick="window.__handlerRan = true">x</a>'; document.body.appendChild(d); document.getElementById("__h").click();
    out.handlerRan = window.__handlerRan === true;
    const st = document.createElement("style"); st.textContent = "body{outline:3px solid red}"; document.head.appendChild(st);
    out.styleApplied = getComputedStyle(document.body).outlineStyle === "solid";
    out.external = await new Promise((resolve) => { const x = document.createElement("script"); x.src = "https://example.com/x.js"; x.onload = () => resolve("loaded"); x.onerror = () => resolve("blocked"); document.head.appendChild(x); });
    out.fetchElsewhere = await fetch("https://example.com/", { mode: "no-cors" }).then(() => "sent", () => "blocked");
    const f = document.createElement("iframe"); f.src = "https://example.com/"; document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 500));
    return out;
  });
  await page.waitForTimeout(300);
  const seen = new Set(current.violations.map((v) => v.directive));
  proof.timerStringRan = await page.evaluate(() => window.__timerStringRan === true);
  const proofOk = !proof.inlineRan && proof.evalBlocked === "EvalError" && proof.functionBlocked === "EvalError" && !proof.timerStringRan && !proof.handlerRan && !proof.styleApplied
    && proof.external === "blocked" && proof.fetchElsewhere === "blocked"
    && ["script-src-elem", "script-src", "script-src-attr", "style-src-elem", "connect-src", "frame-src"].every((d) => seen.has(d));
  console.log(`${proofOk ? " ok " : "FAIL"}  the policy blocks inline script, eval, new Function, inline handlers, <style>, third-party script, fetch and frames — and each is reported (${[...seen].sort().join(", ")})`);
  if (!proofOk) console.log(`        ${JSON.stringify(proof)}`);
  current = null;

  await browser.close();
  await stopServer();
  const failed = steps.filter((s) => s.violations.length + s.consoleCsp.length + s.pageErrors.length + s.failed.length > 0);
  const totalViolations = steps.reduce((n, s) => n + s.violations.length + s.consoleCsp.length, 0);
  console.log(`\n${steps.length} steps, ${steps.length - failed.length} clean, ${totalViolations} CSP violations, ${steps.reduce((n, s) => n + s.pageErrors.length, 0)} page errors, ${steps.reduce((n, s) => n + s.failed.length, 0)} failed requests; policy proof ${proofOk ? "passed" : "FAILED"}`);
  const otherErrors = [...new Set(steps.flatMap((s) => s.consoleErrors))];
  if (otherErrors.length) console.log(`Console errors that are not CSP (for information): ${otherErrors.length}\n  ${otherErrors.slice(0, 8).join("\n  ")}`);
  process.exit(failed.length || !proofOk ? 1 : 0);
})().catch(async (err) => { console.error(err); await stopServer().catch(() => {}); process.exit(2); });
