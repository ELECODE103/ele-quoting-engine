#!/usr/bin/env node
/**
 * csp-browser-check.js — load the built site in a real browser (Chromium via
 * Playwright) and fail if the Content-Security-Policy blocks anything.
 *
 * It walks every public page (from client/dist/seo-manifest.json), the app
 * pages, the quote tool with a 3D preview and a DXF preview, checkout up to
 * the redirect to Stripe, and the admin panel tab by tab including the pricing
 * console. A page fails on any of:
 *   - a `securitypolicyviolation` event (caught by a listener injected before
 *     the page's own scripts)
 *   - a console message that mentions the Content-Security-Policy
 *   - an uncaught page error, or a same-origin request that failed
 * It then proves the detector and the policy both work: an injected inline
 * script and an eval() must be blocked, and must be reported.
 *
 * Starts nothing. Run it against a local production-mode server:
 *
 *   npm run build
 *   rm -rf data; NODE_ENV=production PORT=3090 USE_SQLITE=true JWT_SECRET=<any> \
 *     STRIPE_SECRET_KEY=sk_test_dummy ADMIN_EMAIL=owner@shop.test node server/index.js &
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
 *     node tools/security/csp-browser-check.js --base http://localhost:3090 --admin owner@shop.test
 *
 * Playwright is not a dependency of this repo. Point PLAYWRIGHT at an install
 * (default: require("playwright")):  PLAYWRIGHT=/opt/npm-tools/node_modules/playwright
 *
 * Never point this at production: it registers accounts and uploads files.
 * Options: --shots <dir> saves a screenshot per step. Exit code 0 = clean.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const BASE = arg("base", "http://localhost:3090").replace(/\/$/, "");
const ADMIN_EMAIL = arg("admin", "owner@shop.test");
const SHOTS = arg("shots", "");
const ROOT = path.join(__dirname, "..", "..");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const CSP_TEXT = /content security policy|content-security-policy|refused to (load|execute|apply|connect|frame|create|run)|violates the following/i;

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "client", "dist", "seo-manifest.json"), "utf8"));
  const publicPages = Object.keys(manifest.routes);
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const password = `Aa1${crypto.randomBytes(9).toString("hex")}`; // throwaway, never stored

  const steps = [];      // { name, url, violations, consoleCsp, pageErrors, failed }
  let current = null;
  await context.exposeBinding("__cspReport", (source, v) => { if (current) current.violations.push(v); });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspReport({ directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile || "", line: e.lineNumber || 0, sample: e.sample || "", page: location.pathname });
    });
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (current && CSP_TEXT.test(m.text())) current.consoleCsp.push(`[${m.type()}] ${m.text().slice(0, 300)}`); else if (current && m.type() === "error") current.consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => { if (current) current.pageErrors.push(String(e.message || e).slice(0, 300)); });
  page.on("requestfailed", (r) => {
    const f = r.failure();
    if (!current || !r.url().startsWith(BASE)) return;
    if (f && /ERR_ABORTED/.test(f.errorText)) return; // navigation moved on
    current.failed.push(`${r.method()} ${r.url().replace(BASE, "")} — ${f ? f.errorText : "failed"}`);
  });

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
  // Hand-written static pages shipped from client/public (the brand guide and its sheets).
  const dist = path.join(ROOT, "client", "dist");
  const staticPages = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === "_prerender" || e.name === "assets") continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".html") && p !== path.join(dist, "index.html")) staticPages.push(`/${path.relative(dist, p).split(path.sep).join("/")}`); } })(dist);
  for (const url of staticPages) {
    await step(`static ${url}`, async (s) => {
      const r = await visit(url);
      if (r.status() !== 200) throw new Error(`status ${r.status()}`);
      const n = (await page.locator("body").innerText()).trim().length;
      // the page's own <style> block must have applied (allowed by hash): its body is not the browser default
      const styled = await page.evaluate(() => { const b = getComputedStyle(document.body); return b.fontFamily !== "Times New Roman" && document.styleSheets.length > 0 && [...document.styleSheets].some((sh) => { try { return sh.cssRules.length > 0; } catch { return false; } }); });
      s.note = `${n} chars, styles ${styled ? "applied" : "NOT applied"}`;
      if (!styled) throw new Error("the page's styles did not apply");
    });
  }
  await step("public 404 page", async () => { const r = await visit("/no-such-page"); if (r.status() !== 404) throw new Error(`status ${r.status()}`); if ((await rendered()) < 50) throw new Error("empty"); });

  // ── 2. App pages, signed out ────────────────────────────────
  for (const url of ["/login", "/register", "/rfq", "/quote", "/firm-quote/not-a-real-token", "/dashboard", "/admin"]) {
    await step(`app ${url} (signed out)`, async (s) => { await visit(url); const n = await rendered(); s.note = `${n} chars → ${page.url().replace(BASE, "")}`; if (n < 20) throw new Error("empty page"); });
  }

  // ── 3. Quote tool: upload → 3D preview → price; DXF → 2D preview ──
  let quoteId = null;
  await step("quote tool: STL upload, 3D preview (three.js / WebGL), live price", async (s) => {
    await visit("/quote?process=cnc");
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "tools", "vet-quotes", "parts", "pocketed_tray.stl"));
    await page.waitForSelector("canvas", { timeout: 30000 });
    await settle(1500);
    const canvas = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return { w: c.width, h: c.height, webgl: Boolean(gl) };
    });
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
  await step("quote tool: STEP upload (second part)", async () => {
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "server", "geometry", "fixtures", "plate_holes.step"));
    await settle(2500);
    if (!/plate_holes/i.test(await page.locator("#root").innerText())) throw new Error("the STEP part did not appear");
  });
  await step("quote tool: DXF upload for routing, 2D preview (SVG)", async (s) => {
    await page.evaluate(() => sessionStorage.clear());
    await visit("/quote?process=routing");
    await page.setInputFiles('input[type="file"][multiple]', path.join(ROOT, "tools", "vet-quotes", "parts", "dxf_plate_holes.dxf"));
    await settle(2500);
    const svgs = await page.locator("svg path, svg circle, svg polyline, svg polygon").count();
    s.note = `${svgs} SVG shapes`;
    if (!/dxf_plate_holes/i.test(await page.locator("#root").innerText())) throw new Error("the DXF part did not appear");
  });

  // ── 4. Checkout up to the Stripe redirect ───────────────────
  const signIn = async (email) => {
    const token = await page.evaluate(async ({ email: e, password: p }) => {
      let r = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: e, password: p, name: "Browser Check" }) });
      if (r.status === 409) r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: e, password: p }) });
      const j = await r.json();
      if (j.token) localStorage.setItem("authToken", j.token);
      return j.token || null;
    }, { email, password });
    if (!token) throw new Error(`could not sign in as ${email}`);
  };
  await step("checkout page: signed in, shipping form", async (s) => {
    await visit("/login");
    await signIn(`buyer-${crypto.randomBytes(4).toString("hex")}@example.com`);
    await visit(`/checkout/${quoteId}`);
    const n = await rendered(); s.note = `${n} chars`;
    if (!/ship|checkout|order/i.test(await page.locator("#root").innerText())) throw new Error("checkout did not render");
  });
  await step("checkout: submit → redirect to Stripe's hosted page", async (s) => {
    // The test key cannot create a real session, so the session answer is supplied here; the
    // browser then does what it does in production: leave for checkout.stripe.com.
    const fakeSession = "https://checkout.stripe.com/c/pay/cs_test_browser_check";
    await page.route("**/api/orders/checkout-session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionUrl: fakeSession, sessionId: "cs_test_browser_check", orderId: "00000000-0000-4000-8000-000000000000" }) }));
    await context.route("https://checkout.stripe.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Stripe Checkout (stub)</title><h1>stub</h1>" }));
    const fill = async (ph, v) => { const el = page.getByPlaceholder(ph).first(); if (await el.count()) await el.fill(v); };
    await fill("John Smith", "Browser Check"); await fill("123 Main St", "1 Test Street"); await fill("New York", "Wauconda"); await fill("NY", "IL"); await fill("10001", "60084");
    await Promise.all([page.waitForURL(/checkout\.stripe\.com/, { timeout: 15000 }), page.locator('button[type="submit"]').first().click()]);
    s.note = `left for ${new URL(page.url()).host}`;
    await page.unroute("**/api/orders/checkout-session");
  });
  await step("customer dashboard (signed in)", async () => { await visit("/dashboard"); if ((await rendered()) < 50) throw new Error("empty"); });

  // ── 5. Admin panel and pricing console ──────────────────────
  await step("admin: sign in, panel loads", async (s) => {
    await visit("/login");
    await page.evaluate(() => localStorage.clear());
    await signIn(ADMIN_EMAIL);
    await visit("/admin");
    const text = await page.locator("#root").innerText();
    if (!/Total Orders|Paid Revenue/i.test(text)) throw new Error(`admin panel did not render (is --admin the server's ADMIN_EMAIL, and is this a fresh database?): ${text.slice(0, 120)}`);
    s.note = `${text.length} chars`;
  });
  // the tab bar's buttons (the header's menu button shares the class but has no letters in its label)
  const tabs = (await page.locator("button.btn.btn-ghost").allInnerTexts().catch(() => [])).filter((t) => /[a-z]/i.test(t));
  for (const label of tabs) {
    await step(`admin tab: ${label.trim()}`, async (s) => {
      await page.locator("button.btn.btn-ghost", { hasText: label.trim() }).first().click();
      await settle(700);
      s.note = `${await rendered()} chars`;
    });
  }
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

  // ── 6. The policy really blocks, and the detector really sees it ──
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
  const failed = steps.filter((s) => s.violations.length + s.consoleCsp.length + s.pageErrors.length + s.failed.length > 0);
  const totalViolations = steps.reduce((n, s) => n + s.violations.length + s.consoleCsp.length, 0);
  console.log(`\n${steps.length} steps, ${steps.length - failed.length} clean, ${totalViolations} CSP violations, ${steps.reduce((n, s) => n + s.pageErrors.length, 0)} page errors, ${steps.reduce((n, s) => n + s.failed.length, 0)} failed requests; policy proof ${proofOk ? "passed" : "FAILED"}`);
  const otherErrors = [...new Set(steps.flatMap((s) => s.consoleErrors))];
  if (otherErrors.length) console.log(`Console errors that are not CSP (for information): ${otherErrors.length}\n  ${otherErrors.slice(0, 8).join("\n  ")}`);
  process.exit(failed.length || !proofOk ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
