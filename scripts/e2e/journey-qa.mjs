#!/usr/bin/env node
/**
 * The buyer-journey walk (2026-11-11): every screen and state a buyer or the
 * owner can meet, in a real Chromium against a production-mode server this
 * script starts itself, at phone, tablet and desktop widths.
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
 *   node scripts/e2e/journey-qa.mjs --scratch <dir> --shots <dir> \
 *        [--widths 390,768,1360] [--only a,c,u] [--axe <path to axe.min.js>] [--label after]
 *
 * It is a recorder, not a pass/fail suite: for every screen it saves a
 * screenshot, the messages on it (alerts and status lines, as the buyer reads
 * them), whether the page scrolls sideways, any console error, and, with
 * --axe, the accessibility violations. The results land in
 * <scratch>/<label>-report.json; docs/qa/journey-qa-2026-11-11.md is written
 * from two runs of it (before and after the fixes).
 *
 * Journeys (letters match the report):
 *   a  first visit → upload a STEP → configure → price → register → confirm
 *      email → checkout → card hand-off → order page; and what survives the
 *      detours (another device, an expired session, the way back from the card page)
 *   b  the same start from a material page and from the home page hero
 *   c  a part that trips the quote gate → firm-quote request → received
 *   d  replacement part, no drawing → request → received (with the check, and
 *      on a server with no keys)
 *   e  forgot password, end to end
 *   f  wrong password until sign-in is paused, then unlocked
 *   g  every form refusal (check blocked / failed / not answering, form
 *      expired, sent too fast, sent twice, too many, attachment refused)
 *   h  admin: forced two-step enrolment, sign-in with a code and with a
 *      recovery code, every admin tab
 *   u  every upload refusal (too many files, file too large, model too dense,
 *      daily limit, wrong type, damaged, parse timed out, server busy, storage full)
 *   k  keyboard only: tab order and visible focus on the account screens
 *
 * Outside calls are stubbed as in hardening-accounts.mjs (journey-stubs.cjs);
 * every secret is made at run time; emails are read from EMAIL_OUTBOX_DIR.
 * The ship-to street address is masked in every screenshot that would show it.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const totp = require(path.join(ROOT, 'server', 'security', 'totp.js'));
const { TURNSTILE_STUB } = require(path.join(ROOT, 'scripts', 'e2e', 'turnstile-standin.cjs'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!arg('scratch', '') || !arg('shots', '')) { console.error('--scratch <dir> and --shots <dir> are required'); process.exit(2); }
const SCRATCH = path.resolve(arg('scratch'));
const SHOTS = path.resolve(arg('shots'));
const LABEL = arg('label', 'run');
const WIDTHS = arg('widths', '390,768,1360').split(',').map(Number).filter(Boolean);
const KEEP = new Set(arg('keep', '390,1360').split(',').map(Number)); // widths whose screenshots are kept in --shots
const ONLY = arg('only', '') ? new Set(arg('only').split(',')) : null;
const AXE = arg('axe', '') ? fs.readFileSync(path.resolve(arg('axe')), 'utf8') : '';
const PORT = Number(arg('port', 3641));
const BASE = `http://localhost:${PORT}`;
const OUTBOX = path.join(SCRATCH, 'outbox');
const FILES = path.join(SCRATCH, 'files');
const OWNER = 'owner@straightedge.test';
const PARTS = path.join(ROOT, 'tools', 'vet-quotes', 'parts');
const STEP = path.join(PARTS, 'dxf_plate_holes.step');
const CUBE = path.join(PARTS, 'cube_20mm.stl');
const OVERSIZE = path.join(PARTS, 'oversize_panel.stl');
const newPassword = () => `Qz8-${crypto.randomBytes(9).toString('base64url')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEIGHT = { 390: 844, 768: 1024, 1360: 900 };

for (const d of [SHOTS, SCRATCH, FILES, path.join(SCRATCH, 'shots-all')]) fs.mkdirSync(d, { recursive: true });

// ─── Test files ───────────────────────────────────────────────
/** A binary STL of `n` triangles (a lumpy fan: valid arithmetic, not a pretty part). */
function stl(name, n) {
  const file = path.join(FILES, name);
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('journey-qa test solid', 0);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const a = (i / n) * Math.PI * 2; const b = ((i + 1) / n) * Math.PI * 2;
    const r = 20 + (i % 7);
    const v = [[0, 0, i % 5], [Math.cos(a) * r, Math.sin(a) * r, 0], [Math.cos(b) * r, Math.sin(b) * r, 0]];
    buf.writeFloatLE(0, o); buf.writeFloatLE(0, o + 4); buf.writeFloatLE(1, o + 8);
    v.forEach((p, k) => p.forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4)));
  }
  fs.writeFileSync(file, buf);
  return file;
}
function textFile(name, body) { const f = path.join(FILES, name); fs.writeFileSync(f, body); return f; }
function slowStep() {
  const f = path.join(FILES, 'plate_400_holes.step');
  if (!fs.existsSync(f)) fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'server', 'security', 'fixtures', 'plate_400_holes.step.gz'))));
  return f;
}

// ─── Report ───────────────────────────────────────────────────
const report = { label: LABEL, started: new Date().toISOString(), screens: [], probes: [], problems: [], keyboard: [] };
const saveReport = () => fs.writeFileSync(path.join(SCRATCH, `${LABEL}-report.json`), JSON.stringify(report, null, 1));
function probe(name, value, detail = '') {
  report.probes.push({ name, value, detail });
  console.log(`    probe ${name}: ${JSON.stringify(value)}${detail ? ` — ${detail}` : ''}`);
}

// ─── Server ───────────────────────────────────────────────────
let server = null;
async function startServer({ turnstile = true, env: extra = {} } = {}) {
  await stopServer();
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  fs.rmSync(OUTBOX, { recursive: true, force: true });
  const env = {
    ...process.env,
    ADMIN_EMAIL: OWNER,
    EMAIL_OUTBOX_DIR: OUTBOX,
    EMAIL_API_KEY: 'test-not-a-key',
    EMAIL_FROM: 'Straightedge <quotes@straightedge.test>',
    FRONTEND_URL: BASE,
    NODE_ENV: 'production',
    PORT: String(PORT),
    USE_SQLITE: 'true',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(16).toString('hex')}`,
    E2E_STUBS: '1',
    SE_TEST_HOOKS: '1',
    ...extra,
  };
  for (const k of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'ADMIN_RECOVERY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete env[k];
  if (turnstile) {
    env.TURNSTILE_SITE_KEY = `e2e-site-${crypto.randomBytes(6).toString('hex')}`;
    env.TURNSTILE_SECRET_KEY = `e2e-secret-${crypto.randomBytes(12).toString('hex')}`;
  }
  const logFile = path.join(SCRATCH, `${LABEL}-server.log`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'scripts', 'e2e', 'journey-stubs.cjs'), path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  server = { child, env };
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return server; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not start; see ${logFile}`);
}
async function stopServer() {
  if (!server) return;
  const { child } = server;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); });
  server = null;
}
/** A form token signed by the running server's key, dated `agoMs` in the past (to show the "form expired" state). */
function agedFormToken(form, agoMs) {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = server.env.JWT_SECRET;
  for (const m of ['tokens.js', 'keys.js']) delete require.cache[require.resolve(path.join(ROOT, 'server', 'security', m))];
  const tokens = require(path.join(ROOT, 'server', 'security', 'tokens.js'));
  const t = tokens.sign('form', { form }, { now: Date.now() - agoMs });
  if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
  return t;
}

// ─── Outbox ───────────────────────────────────────────────────
function mails() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).sort().map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')));
}
const mailsTo = (to, re) => mails().filter((m) => (Array.isArray(m.to) ? m.to.includes(to) : m.to === to) && (!re || re.test(m.subject)));
async function waitMail(to, re, { after = 0, timeout = 8000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const list = mailsTo(to, re);
    if (list.length > after) return list[list.length - 1];
    await sleep(150);
  }
  throw new Error(`no email to ${to} matching ${re}`);
}
const linkIn = (mail, page) => (mail.text.match(new RegExp(`${BASE}/${page}#token=\\S+`)) || [])[0];

// ─── Browser ──────────────────────────────────────────────────
let browser;
let visitor = 0;
let width = 1360;
/**
 * A new visitor at the current width. `check`: how Cloudflare's widget script behaves:
 *   'pass' (stand-in issues good tokens) · 'fail' (tokens the server rejects) · 'down' (the server
 *   cannot reach Cloudflare) · 'blocked' (the script never loads) · 'slow' (passes after 1.5 s)
 */
async function newVisitor({ check = 'pass' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT[width] || 900 },
    isMobile: width < 500, hasTouch: width < 500, deviceScaleFactor: 1,
    extraHTTPHeaders: { 'X-Forwarded-For': `203.0.113.${(++visitor % 250) + 1}` },
    acceptDownloads: true,
  });
  if (check === 'blocked') {
    await context.route('https://challenges.cloudflare.com/**', (route) => route.abort('blockedbyclient'));
  } else {
    const body = check === 'fail' ? TURNSTILE_STUB.replace("'e2e-pass-'", "'e2e-fail-'") : check === 'down' ? TURNSTILE_STUB.replace("'e2e-pass-'", "'e2e-down-'") : TURNSTILE_STUB;
    if (check === 'slow') await context.addInitScript(() => { window.__turnstileDelay = 1500; });
    await context.route('https://challenges.cloudflare.com/**', (route) => (route.request().resourceType() === 'script'
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stand-in</title>' })));
  }
  context.on('page', (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && !/challenges\.cloudflare\.com|Failed to load resource/.test(m.text())) report.problems.push({ width, url: page.url().replace(BASE, ''), console: m.text().slice(0, 300) });
    });
    page.on('pageerror', (e) => report.problems.push({ width, url: page.url().replace(BASE, ''), pageerror: e.message.slice(0, 300) }));
  });
  return context;
}

/** What the buyer is told on this screen: alerts, status lines and the notice boxes, in reading order. */
const readMessages = (page) => page.evaluate(() => {
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('[role="alert"], [role="status"], [role="alertdialog"], .auth-error, .auth-ok, .verify-box, .gate-box, .human-check-problem, .notice')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const text = el.innerText.replace(/\s+/g, ' ').trim();
    if (text && !seen.has(text) && ![...seen].some((s) => s.includes(text))) { seen.add(text); out.push(text); }
  }
  return out;
});

async function runAxe(page) {
  if (!AXE) return null;
  try {
    await page.evaluate(AXE);
    return await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 260) })) }));
    });
  } catch (err) { return [{ id: 'axe-run-failed', impact: 'unknown', help: err.message.slice(0, 200), nodes: [] }]; }
}

/** Record a screen: screenshot, messages, sideways scroll, small touch targets (phone), axe. */
async function shot(page, name, { mask = [], note = '', fullPage = true, settle = 250 } = {}) {
  try {
    await page.waitForTimeout(settle);
    const file = `${name}-${width}.jpg`;
    const opts = { fullPage, type: 'jpeg', quality: 72, mask, maskColor: '#101C33', animations: 'disabled' };
    await page.screenshot({ ...opts, path: path.join(SCRATCH, 'shots-all', `${LABEL}-${file}`) });
    if (KEEP.has(width)) fs.copyFileSync(path.join(SCRATCH, 'shots-all', `${LABEL}-${file}`), path.join(SHOTS, file));
    const layout = await page.evaluate((expected) => {
      const de = document.documentElement;
      const wide = [];
      if (Math.max(de.scrollWidth, document.body.scrollWidth) > expected + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > expected + 1 && !el.closest('.hp-field') && wide.length < 5) wide.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} → ${Math.round(r.right)}px`);
        }
      }
      const small = [];
      if (window.innerWidth < 500) {
        for (const el of document.querySelectorAll('a, button, input:not([type=hidden]), select, textarea, [role=button], label.lead-option, label.check-row')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !el.offsetParent || el.closest('.hp-field') || el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
          // WCAG 2.2 AA 2.5.8: 24 × 24 CSS px, links inside a sentence excepted.
          const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && el.parentElement.innerText.trim().length > el.innerText.trim().length + 12;
          const inlineButton = el.classList.contains('linklike-inline');
          if ((r.width < 24 || r.height < 24) && !inline && !inlineButton) small.push(`${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || el.name || el.type || '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      return { scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), innerWidth: Math.min(window.innerWidth, expected), wide, small: small.slice(0, 12), title: document.title, focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? `#${document.activeElement.id}` : ''}${document.activeElement.className && typeof document.activeElement.className === 'string' ? `.${document.activeElement.className.split(' ')[0]}` : ''}` : '' };
    }, width);
    const messages = await readMessages(page);
    const axe = await runAxe(page);
    report.screens.push({ name, width, url: page.url().replace(BASE, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), note, title: layout.title, focus: layout.focus, messages, sideways: layout.scrollWidth > layout.innerWidth + 1 ? layout.wide : [], small: layout.small, axe });
    const flags = [layout.scrollWidth > layout.innerWidth + 1 ? 'SIDEWAYS-SCROLL' : '', axe && axe.some((v) => ['serious', 'critical'].includes(v.impact)) ? `AXE:${axe.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id).join(',')}` : ''].filter(Boolean).join(' ');
    console.log(`  [${width}] ${name}${flags ? `  ${flags}` : ''}${messages.length ? `\n         ↳ ${messages.map((m) => m.slice(0, 170)).join('\n         ↳ ')}` : ''}`);
  } catch (err) {
    report.problems.push({ width, screen: name, error: err.message.slice(0, 300) });
    console.log(`  [${width}] ${name}  (not captured: ${err.message.split('\n')[0]})`);
  }
  saveReport();
}

async function step(title, fn) {
  try { await fn(); } catch (err) {
    report.problems.push({ width, step: title, error: (err.stack || err.message).slice(0, 700) });
    console.log(`  [${width}] !! ${title}: ${err.message.split('\n')[0]}`);
  }
  saveReport();
}

// ─── Building blocks ──────────────────────────────────────────
const fileInput = (page) => page.locator('main input[type="file"][multiple]').first();
async function upload(page, files, { waitPrice = true } = {}) {
  await fileInput(page).setInputFiles(files);
  if (waitPrice) await page.locator('aside').getByText(/Total|Budgetary/).first().waitFor({ timeout: 45000 });
}
async function fillRegister(page, { name, email, password }) {
  await page.locator('#reg-name').fill(name);
  await page.locator('#reg-email').fill(email);
  await page.locator('#reg-password').fill(password);
}
async function register(page, account, { next } = {}) {
  await page.goto(`${BASE}/register${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await fillRegister(page, account);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/register'), { timeout: 20000 });
}
async function signIn(page, email, password, { next } = {}) {
  await page.goto(`${BASE}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('form button[type="submit"]').click();
}
async function confirmedAccount(context, tag) {
  const account = { name: 'Dana Whitfield', email: `${tag}-${width}@buyer.test`, password: newPassword() };
  const page = await context.newPage();
  await register(page, account);
  const mail = await waitMail(account.email, /confirm/i);
  await page.goto(linkIn(mail, 'verify-email'));
  await page.getByText(/is confirmed|email is confirmed/i).first().waitFor({ timeout: 10000 });
  await page.close();
  return account;
}
const rfq = {
  name: (page) => page.locator('#request input[autocomplete="name"]'),
  email: (page) => page.locator('#request input[type="email"]'),
  notes: (page) => page.locator('#request textarea').first(),
  send: (page) => page.locator('#request button[type="submit"]'),
};
async function fillRfq(page, { name = 'Dana Whitfield', email, notes = 'Carton guide on the sealer infeed. Rides on a stainless rail; worn on the leading edge.' }) {
  await rfq.name(page).fill(name);
  await rfq.email(page).fill(email);
  await rfq.notes(page).fill(notes);
}
const received = (page) => page.getByText(/Request received/i).first();
const fillCheckout = async (page) => {
  await page.locator('#co-name').fill('Dana Whitfield');
  await page.locator('#co-street').fill('410 Industrial Dr');
  await page.locator('#co-city').fill('Rockford');
  await page.locator('#co-state').fill('IL');
  await page.locator('#co-zip').fill('61109');
};

// ══════════════════════════════════════════════════════════════
// Journeys on the server with the bot check switched on
// ══════════════════════════════════════════════════════════════
const state = {};

async function journeyA() {
  const context = await newVisitor({ check: 'slow' });
  const page = await context.newPage();
  const account = { name: 'Dana Whitfield', email: `dana-${width}@buyer.test`, password: newPassword() };
  let quoteId = '';

  await step('a: home → quote → upload', async () => {
    await page.goto(BASE);
    await shot(page, 'a01-home', { fullPage: false });
    await page.getByRole('link', { name: 'Get an instant quote' }).first().click();
    await page.waitForURL(/\/quote/);
    await page.locator('.dropzone').first().waitFor();
    await shot(page, 'a02-quote-empty');
    await fileInput(page).setInputFiles(STEP);
    await page.getByRole('dialog').waitFor({ timeout: 10000 });
    await shot(page, 'a03-quote-first-upload-check', { fullPage: false, settle: 400 });
    await page.locator('aside').getByText(/Total|Budgetary/).first().waitFor({ timeout: 45000 });
    await shot(page, 'a04-quote-priced');
    await shot(page, 'a04b-quote-priced-first-screen', { fullPage: false, note: 'what a phone shows without scrolling' });
  });

  await step('a: configure (quantity, paperwork, sent-out finish)', async () => {
    await page.locator('input[type="number"]').first().fill('5');
    await page.locator('input[name="paperwork"]').check();
    await page.waitForTimeout(1200);
    await shot(page, 'a05-quote-paperwork-ticked');
    const finish = page.locator('select').filter({ has: page.locator('option[value="cnc-anodize-clear"]') });
    if (await finish.count()) {
      await page.locator('label.lead-option').nth(1).click().catch(() => {});
      await page.waitForTimeout(700);
      await finish.selectOption('cnc-anodize-clear');
      await page.waitForTimeout(1500);
      await shot(page, 'a06-quote-sent-out-finish', { note: 'anodize: Standard lead time only' });
      await finish.selectOption({ index: 0 });
      await page.waitForTimeout(1200);
    } else probe('sent-out finish offered on this material', false);
    quoteId = await page.evaluate(() => sessionStorage.getItem('straightedge.quoteId'));
  });

  await step('a: check out as a guest → sign in → create an account', async () => {
    await page.locator('aside').getByRole('button', { name: /Check out/ }).click();
    await page.waitForURL(/\/login\?next=/);
    await shot(page, 'a07-login-from-checkout');
    await page.getByRole('link', { name: 'Create one' }).click();
    await page.waitForURL(/\/register\?next=/);
    await page.locator('#reg-name').waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'a08-register');
    await fillRegister(page, { ...account, password: 'password123' });
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(4500);
    await shot(page, 'a09-register-password-refused', { note: 'a common password, typed by a real buyer' });
    probe('register: typed name/email kept after a refusal', await page.locator('#reg-name').inputValue() === account.name && await page.locator('#reg-email').inputValue() === account.email);
    await page.locator('#reg-password').fill(account.password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/checkout\//, { timeout: 20000 });
    await page.getByText(/Confirm your email/i).first().waitFor();
    probe('quote survives registration', await page.getByText('dxf_plate_holes.step').first().waitFor({ timeout: 8000 }).then(() => true, () => false), 'the checkout page lists the uploaded part');
    await shot(page, 'a10-checkout-confirm-email');
    await shot(page, 'a10b-checkout-confirm-email-first-screen', { fullPage: false });
  });

  await step('a: resend, confirm in another tab, pay', async () => {
    await fillCheckout(page);
    await page.getByRole('button', { name: /Send the link again/i }).click();
    await page.waitForTimeout(900);
    await shot(page, 'a11-checkout-resend-too-soon', { fullPage: false, note: 'resend pressed seconds after registering' });
    const mail = await waitMail(account.email, /confirm/i);
    state.verifyMail = mail;
    const link = linkIn(mail, 'verify-email');
    const tab = await context.newPage();
    await tab.goto(link);
    await tab.getByText(/is confirmed|email is confirmed/i).first().waitFor({ timeout: 10000 });
    await shot(tab, 'a12-verify-confirmed-same-browser');
    probe('after confirming: a way back to the quote/checkout is offered', await tab.getByRole('link', { name: /checkout/i }).count() > 0);
    await tab.goto('about:blank');
    await tab.goto(link);
    await tab.waitForTimeout(1500);
    await shot(tab, 'a13-verify-link-used-twice');
    await tab.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('form button[type="submit"]:not([disabled])').waitFor({ timeout: 20000 });
    probe('checkout: address typed before confirming is still there', await page.locator('#co-street').inputValue() === '410 Industrial Dr');
    await shot(page, 'a14-checkout-ready');
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/orders\/.+paid=true/, { timeout: 20000 });
    await page.getByText(/Payment received/i).waitFor({ timeout: 20000 });
    await shot(page, 'a15-order-paid');
    await page.goto(`${BASE}/dashboard`);
    await page.locator('h1').first().waitFor();
    await page.waitForTimeout(800);
    await shot(page, 'a16-dashboard');
    const orderMail = await waitMail(account.email, /order .* confirmed/i).catch(() => null);
    probe('order confirmation email sent', Boolean(orderMail));
  });
  state.buyer = account;

  // ── What survives the detours ──
  await step('a: confirm on another device', async () => {
    const c1 = await newVisitor();
    const p1 = await c1.newPage();
    const acc = { name: 'Lee Park', email: `lee-${width}@buyer.test`, password: newPassword() };
    await p1.goto(`${BASE}/quote`);
    await upload(p1, CUBE);
    const qid = await p1.evaluate(() => sessionStorage.getItem('straightedge.quoteId'));
    await register(p1, acc, { next: `/checkout/${qid}` });
    const mail = await waitMail(acc.email, /confirm/i);
    const c2 = await newVisitor();
    const p2 = await c2.newPage();
    await p2.goto(linkIn(mail, 'verify-email'));
    await p2.getByRole('button', { name: /Confirm my email/i }).waitFor({ timeout: 10000 });
    await shot(p2, 'a17-verify-other-device');
    await p2.getByRole('button', { name: /Confirm my email/i }).click();
    await p2.getByText(/is confirmed/i).first().waitFor();
    await shot(p2, 'a18-verify-other-device-done');
    await p1.bringToFront();
    await p1.evaluate(() => window.dispatchEvent(new Event('focus')));
    const enabled = await p1.locator('form button[type="submit"]:not([disabled])').waitFor({ timeout: 20000 }).then(() => true, () => false);
    probe('confirming on another device releases the first device\'s checkout', enabled);

    // Session ends while the buyer is on the checkout page (cookie gone), then they press pay.
    await fillCheckout(p1);
    await c1.clearCookies();
    await p1.locator('form button[type="submit"]').click();
    await p1.waitForTimeout(2500);
    await shot(p1, 'a19-checkout-session-ended', { note: 'session cookie removed, then Pay pressed' });
    probe('session ended at checkout: where the buyer is', p1.url().replace(BASE, '').replace(qid, ':id'));
    probe('session ended at checkout: quote id still in this tab', await p1.evaluate(() => sessionStorage.getItem('straightedge.quoteId')) === qid);
    if (/\/login/.test(p1.url())) {
      await p1.locator('#login-email').fill(acc.email);
      await p1.locator('#login-password').fill(acc.password);
      await p1.locator('form button[type="submit"]').click();
      await p1.waitForTimeout(2500);
      probe('session ended at checkout: after signing in again', p1.url().replace(BASE, '').replace(qid, ':id'));
    }
    // The way back from the card page.
    if (!await p1.evaluate(() => fetch('/api/auth/session').then((r) => r.json()).then((j) => Boolean(j.user)))) {
      await signIn(p1, acc.email, acc.password);
      await p1.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).catch(() => {});
    }
    await p1.goto(`${BASE}/checkout/${qid}?cancelled=true`);
    await p1.locator('#co-name').waitFor({ timeout: 10000 });
    await shot(p1, 'a20-checkout-back-from-card');
    probe('back from the card page: address still filled in', await p1.locator('#co-street').inputValue() !== '');
    // Reload on the quote page: parts come back?
    await p1.goto(`${BASE}/quote`);
    const back = await p1.getByText('cube_20mm.stl').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    probe('quote survives a reload of /quote', back);
    await c1.close(); await c2.close();
  });
  await context.close();
  return quoteId;
}

async function journeyB() {
  const context = await newVisitor();
  const page = await context.newPage();
  await step('b: material page → quote', async () => {
    await page.goto(`${BASE}/materials`);
    const href = await page.locator('a[href^="/materials/"]').first().getAttribute('href');
    await page.goto(`${BASE}${href}`);
    await shot(page, 'b01-material-page', { fullPage: false });
    await page.getByRole('link', { name: /Price this part/i }).first().click();
    await page.waitForURL(/\/quote\?/);
    await page.locator('.dropzone').first().waitFor();
    await shot(page, 'b02-quote-from-material');
    probe('material page → quote: material preselected', await page.locator('[data-testid="preselected-material"]').count() > 0, page.url().replace(BASE, ''));
    await upload(page, STEP);
    await shot(page, 'b03-quote-from-material-priced', { fullPage: false });
  });
  await step('b: home hero → quote', async () => {
    await page.goto(BASE);
    await page.locator('.btn-primary.btn-lg').first().click();
    await page.waitForURL(/\/quote/);
    probe('home hero → quote: the earlier quote is reopened', await page.getByText('dxf_plate_holes.step').first().waitFor({ timeout: 15000 }).then(() => true, () => false));
  });
  await context.close();
}

async function journeyC() {
  const context = await newVisitor();
  const page = await context.newPage();
  await step('c: gated part → firm quote', async () => {
    await page.goto(`${BASE}/quote`);
    await upload(page, OVERSIZE);
    await page.getByText(/needs a person/i).first().waitFor({ timeout: 20000 });
    await shot(page, 'c01-quote-gated');
    await shot(page, 'c01b-quote-gated-first-screen', { fullPage: false });
    await page.locator('main').getByRole('button', { name: /Request a firm quote/ }).first().click();
    await page.waitForURL(/\/rfq\//);
    await page.getByText(/Parts from your online quote/i).waitFor();
    await shot(page, 'c02-rfq-from-quote');
    await rfq.send(page).click();
    await page.waitForTimeout(600);
    await shot(page, 'c03-rfq-missing-name', { fullPage: false, note: 'sent with nothing filled in' });
    probe('rfq: where focus is after a refused send', await page.evaluate(() => `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? `#${document.activeElement.id}` : ''}`));
    await rfq.name(page).fill('Dana Whitfield');
    await rfq.email(page).fill(`gated-${width}@buyer.test`);
    await rfq.send(page).click();
    await received(page).waitFor({ timeout: 20000 });
    await shot(page, 'c04-rfq-received');
  });
  await context.close();
}

async function journeyD() {
  const context = await newVisitor();
  const page = await context.newPage();
  await step('d: replacement part, bot check on', async () => {
    await page.goto(`${BASE}/replacement-parts`);
    await shot(page, 'd01-replacement-parts', { fullPage: false });
    await page.getByRole('link', { name: 'Send us the part' }).first().click();
    await page.waitForURL(/nocad=1/);
    await page.waitForTimeout(700);
    await shot(page, 'd02-part-request-form');
    await fillRfq(page, { email: `part-${width}@buyer.test` });
    await rfq.send(page).click();
    await received(page).waitFor({ timeout: 20000 });
    await shot(page, 'd03-part-request-received', { mask: [page.locator('.ship-part dd').nth(1)], note: 'address masked' });
  });
  await context.close();
}

async function journeyE() {
  const context = await newVisitor();
  const account = await confirmedAccount(context, 'reset');
  const page = await context.newPage();
  await step('e: forgot password', async () => {
    await context.clearCookies();
    await page.goto(`${BASE}/login`);
    await shot(page, 'e01-login');
    await page.getByRole('link', { name: /Forgot/i }).click();
    await page.locator('#forgot-email').waitFor();
    await page.waitForTimeout(500);
    await shot(page, 'e02-forgot-password');
    await page.locator('#forgot-email').fill(account.email);
    await page.locator('form button[type="submit"]').click();
    await page.getByText(/on its way/i).waitFor({ timeout: 15000 });
    await shot(page, 'e03-forgot-password-sent');
    const mail = await waitMail(account.email, /reset/i);
    state.resetMail = mail;
    const link = linkIn(mail, 'reset-password');
    await page.goto(link);
    await page.locator('#reset-password').waitFor({ timeout: 10000 });
    await shot(page, 'e04-reset-password');
    await page.locator('#reset-password').fill('Mismatch-One-123');
    await page.locator('#reset-again').fill('Mismatch-Two-123');
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(500);
    await shot(page, 'e05-reset-password-mismatch', { fullPage: false });
    await page.locator('#reset-password').fill('straightedge2026A');
    await page.locator('#reset-again').fill('straightedge2026A').catch(() => {});
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(900);
    await shot(page, 'e06-reset-password-refused', { fullPage: false, note: 'a password built from our name' });
    account.password = newPassword();
    await page.locator('#reset-password').fill(account.password);
    await page.locator('#reset-again').fill(account.password).catch(() => {});
    await page.locator('form button[type="submit"]').click();
    await page.getByText(/password is changed/i).waitFor({ timeout: 10000 });
    await shot(page, 'e07-reset-password-done');
    await page.goto('about:blank');
    await page.goto(link);
    await page.waitForTimeout(1500);
    await shot(page, 'e08-reset-link-used');
    await signIn(page, account.email, account.password);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
    probe('reset: signing in with the new password lands on', page.url().replace(BASE, ''));
    state.changedMail = await waitMail(account.email, /password was changed/i).catch(() => null);
  });
  await context.close();
}

async function journeyF() {
  const context = await newVisitor();
  const account = await confirmedAccount(context, 'lock');
  const page = await context.newPage();
  await step('f: wrong password until paused, then unlock', async () => {
    await context.clearCookies();
    await page.goto(`${BASE}/login`);
    await page.locator('#login-email').fill(account.email);
    for (let i = 1; i <= 6; i++) {
      await page.locator('#login-password').fill(`Wrong-password-${i}`);
      if (await page.locator('.human-check:not([hidden])').count()) await page.getByText(/Check passed|Success/i).first().waitFor({ timeout: 6000 }).catch(() => {});
      await page.locator('form button[type="submit"]').click();
      await page.waitForTimeout(1300);
      if (i === 1) await shot(page, 'f01-login-wrong-password');
      if (i === 3) await shot(page, 'f02-login-check-appears', { note: 'third wrong password' });
      if (i === 4) await shot(page, 'f03-login-wrong-with-check');
      if (i === 5) await shot(page, 'f04-login-fifth-wrong');
      if (i === 6) await shot(page, 'f05-login-paused');
    }
    await page.locator('#login-password').fill(account.password);
    if (await page.locator('.human-check:not([hidden])').count()) await page.waitForTimeout(900);
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(1300);
    await shot(page, 'f06-login-paused-right-password', { note: 'the right password while paused' });
    probe('paused: email typed is kept', await page.locator('#login-email').inputValue() === account.email);
    const mail = await waitMail(account.email, /paused/i);
    state.lockMail = mail;
    const way = (mail.text.match(new RegExp(`${BASE}/(forgot-password|reset-password)\\S*`)) || [])[0];
    probe('pause email: where its button leads', way ? way.replace(BASE, '').split('#')[0] : 'no link');
    await page.goto(way);
    if (/forgot-password/.test(way)) {
      await page.locator('#forgot-email').fill(account.email);
      await page.waitForTimeout(3300);
      await page.locator('form button[type="submit"]').click();
      await page.getByText(/on its way/i).waitFor({ timeout: 15000 });
      const reset = await waitMail(account.email, /reset your password/i);
      await page.goto(linkIn(reset, 'reset-password'));
    }
    await page.locator('#reset-password').waitFor({ timeout: 10000 });
    account.password = newPassword();
    await page.locator('#reset-password').fill(account.password);
    await page.locator('#reset-again').fill(account.password).catch(() => {});
    await page.locator('form button[type="submit"]').click();
    await page.getByText(/password is changed/i).waitFor({ timeout: 10000 });
    await signIn(page, account.email, account.password);
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) {
      await shot(page, 'f07-login-after-unlock-needs-check', { note: 'right password straight after the reset' });
      await page.getByText(/Check passed|Success/i).first().waitFor({ timeout: 6000 }).catch(() => {});
      await page.locator('form button[type="submit"]').click();
      await page.waitForTimeout(1500);
    }
    probe('unlock by reset: signed in', !/\/login/.test(page.url()), page.url().replace(BASE, ''));
  });
  await context.close();
}

async function journeyG() {
  // Check script blocked (content blocker, firewall).
  await step('g: check blocked', async () => {
    const c = await newVisitor({ check: 'blocked' });
    const p = await c.newPage();
    await p.goto(`${BASE}/rfq`);
    await p.locator('.human-check-problem').waitFor({ timeout: 20000 });
    await shot(p, 'g01-rfq-check-blocked');
    await fillRfq(p, { email: `blocked-${width}@buyer.test` });
    await rfq.send(p).click();
    await p.waitForTimeout(700);
    await shot(p, 'g02-rfq-check-blocked-send', { fullPage: false });
    probe('check blocked: what was typed is kept', await rfq.name(p).inputValue() === 'Dana Whitfield');
    await p.goto(`${BASE}/register`);
    await p.locator('.human-check-problem').waitFor({ timeout: 20000 });
    await shot(p, 'g03-register-check-blocked');
    await p.goto(`${BASE}/quote`);
    await fileInput(p).setInputFiles(CUBE);
    await p.getByRole('dialog').waitFor({ timeout: 10000 });
    await p.locator('.human-check-problem').waitFor({ timeout: 20000 });
    await shot(p, 'g04-quote-check-blocked', { fullPage: false });
    await p.getByRole('button', { name: /Cancel|Close/ }).click();
    await p.waitForTimeout(600);
    await shot(p, 'g05-quote-check-blocked-after-cancel', { fullPage: false });
    await c.close();
  });
  // Check failed (Cloudflare says no) and not answering.
  for (const [kind, n] of [['fail', 'g06-rfq-check-failed'], ['down', 'g07-rfq-check-not-answering']]) {
    await step(`g: check ${kind}`, async () => {
      const c = await newVisitor({ check: kind });
      const p = await c.newPage();
      await p.goto(`${BASE}/rfq`);
      await fillRfq(p, { email: `${kind}-${width}@buyer.test` });
      await p.waitForTimeout(3300);
      await rfq.send(p).click();
      if (kind === 'down') {
        await received(p).waitFor({ timeout: 20000 });
        await shot(p, n, { note: 'Cloudflare not answering: the request is taken, as an unverified sender' });
        await p.goto(`${BASE}/register`);
        await fillRegister(p, { name: 'Dana Whitfield', email: `down-${width}@buyer.test`, password: newPassword() });
        await p.waitForTimeout(3300);
        await p.locator('form button[type="submit"]').click();
        await p.locator('[role="alert"]').first().waitFor({ timeout: 15000 });
        await shot(p, 'g07b-register-check-not-answering');
        probe('check not answering: what was typed is kept', await p.locator('#reg-name').inputValue() === 'Dana Whitfield');
        await c.close();
        return;
      }
      await p.locator('#request [role="alert"]').first().waitFor({ timeout: 15000 });
      await shot(p, n);
      probe(`check ${kind}: what was typed is kept`, await rfq.notes(p).inputValue() !== '');
      if (kind === 'fail') {
        await p.goto(`${BASE}/quote`);
        await fileInput(p).setInputFiles(CUBE);
        await p.getByRole('dialog').waitFor({ timeout: 10000 });
        await p.waitForTimeout(1500);
        await shot(p, 'g08-quote-check-failed', { fullPage: false });
      }
      await c.close();
    });
  }
  // Form token problems: expired (left open overnight), garbled, sent too fast.
  await step('g: form expired / not loaded / too fast', async () => {
    for (const [mode, n] of [['expired', 'g09-rfq-form-expired'], ['garbled', 'g10-rfq-form-not-loaded'], ['fast', 'g11-rfq-sent-too-fast']]) {
      const c = await newVisitor();
      const p = await c.newPage();
      if (mode === 'fast') {
        await c.route('**/api/public/form-token**', async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          await route.fulfill({ response: res, json: { ...body, minSeconds: 0.01 } });
        });
      } else {
        await c.route('**/api/rfq', async (route) => {
          const headers = { ...route.request().headers(), 'x-form-token': mode === 'expired' ? agedFormToken('rfq', 13 * 3600 * 1000) : 'not-a-token' };
          await route.continue({ headers });
        });
      }
      await p.goto(`${BASE}/rfq`);
      await fillRfq(p, { email: `${mode}-${width}@buyer.test` });
      if (mode !== 'fast') await p.waitForTimeout(3300);
      await p.getByText(/Check passed|Success/i).first().waitFor({ timeout: 6000 }).catch(() => {});
      await rfq.send(p).click();
      await p.locator('#request [role="alert"]').first().waitFor({ timeout: 20000 });
      await shot(p, n, { fullPage: false });
      await c.close();
    }
  });
  // Sent twice; too many from one address; attachment refused.
  await step('g: duplicate, too many, attachment', async () => {
    const c = await newVisitor();
    const p = await c.newPage();
    const email = `repeat-${width}@buyer.test`;
    await p.goto(`${BASE}/rfq`);
    // The same request posted twice (a double click, a retry on a bad connection): one request, one answer.
    const twice = await p.evaluate(async (email) => {
      const send = async () => {
        const ft = await fetch('/api/public/form-token?form=rfq').then((r) => r.json());
        await new Promise((r) => setTimeout(r, 3300));
        const form = new FormData();
        Object.entries({ contactName: 'Dana Whitfield', email, notes: 'Same request, sent twice.' }).forEach(([k, v]) => form.append(k, v));
        const res = await fetch('/api/rfq', { method: 'POST', body: form, headers: { 'X-Form-Token': ft.formToken, 'X-Turnstile-Token': `e2e-pass-dup-${Math.random()}` } });
        return { status: res.status, body: await res.json() };
      };
      const a = await send(); const b = await send();
      return { a: a.status, b: b.status, same: a.body.rfqId === b.body.rfqId, replayed: b.body.duplicate === true || b.body.replayed === true };
    }, email);
    probe('the same request sent twice', twice, 'one request stored; the buyer sees the same reference both times');
    // Six an hour per address: the seventh is refused.
    const statuses = await p.evaluate(async (email) => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const ft = await fetch('/api/public/form-token?form=rfq').then((r) => r.json());
        await new Promise((r) => setTimeout(r, 3200));
        const form = new FormData();
        Object.entries({ contactName: 'Dana Whitfield', email, notes: `Request number ${i + 2}.` }).forEach(([k, v]) => form.append(k, v));
        const res = await fetch('/api/rfq', { method: 'POST', body: form, headers: { 'X-Form-Token': ft.formToken, 'X-Turnstile-Token': `e2e-pass-many-${i}-${Math.random()}` } });
        out.push(res.status);
      }
      return out;
    }, email);
    probe('requests from one address in an hour', statuses);
    await p.reload();
    await fillRfq(p, { email, notes: 'One more request from the same address.' });
    await p.waitForTimeout(3300);
    await rfq.send(p).click();
    await p.locator('#request [role="alert"]').first().waitFor({ timeout: 15000 });
    await shot(p, 'g12-rfq-too-many', { fullPage: false });
    await c.close();

    const c2 = await newVisitor();
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/rfq`);
    const drawing = p2.locator('#request input[type="file"]');
    await drawing.setInputFiles(textFile('notes.docx', 'not a drawing'));
    await p2.waitForTimeout(300);
    await shot(p2, 'g13-rfq-attachment-wrong-type', { fullPage: false });
    await drawing.setInputFiles(textFile('drawing.pdf', 'This is a text file with a PDF name.'));
    await fillRfq(p2, { email: `attach-${width}@buyer.test` });
    await p2.waitForTimeout(3300);
    await rfq.send(p2).click();
    await p2.locator('#request [role="alert"]').first().waitFor({ timeout: 15000 });
    await shot(p2, 'g14-rfq-attachment-not-what-it-says', { fullPage: false });
    await c2.close();
  });
  // Registration with an address that already has an account.
  await step('g: account exists', async () => {
    if (!state.buyer) return;
    const c = await newVisitor();
    const p = await c.newPage();
    await p.goto(`${BASE}/register`);
    await fillRegister(p, { name: 'Dana Whitfield', email: state.buyer.email, password: newPassword() });
    await p.locator('form button[type="submit"]').click();
    await p.locator('[role="alert"]').first().waitFor({ timeout: 15000 });
    await shot(p, 'g15-register-account-exists', { fullPage: false });
    await c.close();
  });
}

async function journeyH() {
  const context = await newVisitor();
  const page = await context.newPage();
  const owner = { name: 'Shop Owner', email: OWNER, password: newPassword() };
  let secret = '';
  let codes = [];
  let usedStep = 0;
  /** The current code, never one from a 30-second step already spent (the server takes each step once). */
  const code = async () => { while (totp.stepAt() <= usedStep) await sleep(500); usedStep = totp.stepAt(); return totp.codeAt(secret); };
  await step('h: owner account → forced enrolment', async () => {
    await register(page, owner);
    const mail = await waitMail(OWNER, /confirm/i);
    await page.goto(linkIn(mail, 'verify-email'));
    await page.getByText(/is confirmed/i).first().waitFor({ timeout: 10000 });
    await shot(page, 'h01-verify-confirmed-owner');
    await page.goto(`${BASE}/admin`);
    await page.locator('[data-testid="enrolment-gate"]').waitFor({ timeout: 15000 });
    await shot(page, 'h02-admin-enrolment-required');
    await page.locator('#tf-password').fill('Not-the-password-1');
    await page.locator('#tf-password').press('Enter');
    await page.waitForTimeout(900);
    await shot(page, 'h03-admin-enrolment-wrong-password', { fullPage: false });
    await page.locator('#tf-password').fill(owner.password);
    await page.locator('#tf-password').press('Enter');
    await page.locator('[data-testid="twofactor-setup"]').waitFor({ timeout: 10000 });
    await shot(page, 'h04-admin-enrolment-qr');
    secret = (await page.locator('[data-testid="setup-key"]').innerText()).replace(/\s+/g, '');
    await page.locator('#tf-code').fill('000000');
    await page.locator('#tf-code').press('Enter');
    await page.waitForTimeout(900);
    await shot(page, 'h05-admin-enrolment-wrong-code', { fullPage: false });
    await page.locator('#tf-code').fill(await code());
    await page.locator('#tf-code').press('Enter');
    await page.locator('[data-testid="recovery-codes"]').waitFor({ timeout: 10000 });
    codes = await page.locator('.recovery-codes li').allInnerTexts();
    await shot(page, 'h06-admin-recovery-codes', { mask: [page.locator('.recovery-codes')] });
    probe('recovery codes screen: actions offered', await page.locator('[data-testid="recovery-codes"] button').allInnerTexts());
    await page.getByRole('button', { name: /saved/i }).click();
    await page.getByRole('button', { name: 'Orders', exact: true }).waitFor({ timeout: 10000 });
  });
  await step('h: admin tabs', async () => {
    for (const tab of ['Orders', 'RFQs', 'Parts', 'Materials', 'Finishes', 'Lead Times', 'Pricing', 'Calibration', 'Quotes', 'Security']) {
      const b = page.getByRole('button', { name: tab, exact: true }).or(page.getByRole('tab', { name: tab, exact: true }));
      if (!await b.count()) { probe(`admin tab ${tab}`, 'not found'); continue; }
      await b.first().click();
      await page.waitForTimeout(700);
      await shot(page, `h07-admin-${tab.toLowerCase().replace(/\s+/g, '-')}`, { fullPage: width > 500 ? false : true });
    }
  });
  await step('h: sign in with a code, then with a recovery code', async () => {
    await context.clearCookies();
    await signIn(page, OWNER, owner.password);
    await page.locator('#login-code').waitFor({ timeout: 10000 });
    await shot(page, 'h08-login-code');
    probe('one-time code field', await page.locator('#login-code').evaluate((el) => ({ inputmode: el.getAttribute('inputmode'), autocomplete: el.getAttribute('autocomplete'), focused: document.activeElement === el })));
    await page.locator('#login-code').fill('000000');
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(1300);
    await shot(page, 'h09-login-code-wrong', { fullPage: false });
    probe('wrong code: password field still filled', await page.locator('#login-password').inputValue() !== '');
    await page.locator('#login-code').fill(await code());
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).catch(() => {});
    probe('sign in with a code', !/\/login/.test(page.url()));
    await context.clearCookies();
    await signIn(page, OWNER, owner.password);
    await page.locator('#login-code').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /recovery code/i }).click();
    await page.waitForTimeout(300);
    await shot(page, 'h10-login-recovery-code');
    await page.locator('#login-code').fill(codes[0] || '');
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).catch(() => {});
    probe('sign in with a recovery code', !/\/login/.test(page.url()));
    state.recoveryMail = await waitMail(OWNER, /recovery code/i).catch(() => null);
    await page.goto(`${BASE}/admin`);
    await page.getByRole('button', { name: 'Security', exact: true }).or(page.getByRole('tab', { name: 'Security', exact: true })).first().click();
    await page.waitForTimeout(700);
    await shot(page, 'h11-admin-security-on');
  });
  await context.close();
}

// Keyboard only: what Tab reaches, in what order, and whether the focus can be seen.
async function journeyK() {
  if (width !== 1360) return;
  const context = await newVisitor();
  const page = await context.newPage();
  const walk = async (name, url, max = 22) => {
    await page.goto(`${BASE}${url}`);
    await page.waitForTimeout(1200);
    const stops = [];
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      const s = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1) || (cs.boxShadow && cs.boxShadow !== 'none');
        const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.name || el.type || '';
        return { el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`, label: label.replace(/\s+/g, ' ').trim().slice(0, 40), ring: Boolean(ring), hiddenTrap: Boolean(el.closest('.hp-field')), inFrame: el.tagName === 'IFRAME' };
      });
      if (!s) break;
      stops.push(s);
    }
    report.keyboard.push({ name, url, stops, noRing: stops.filter((s) => !s.ring && !s.inFrame).map((s) => `${s.el} "${s.label}"`), trapReached: stops.some((s) => s.hiddenTrap) });
    console.log(`  [kbd] ${name}: ${stops.length} stops; no visible focus on ${stops.filter((s) => !s.ring && !s.inFrame).length}; honeypot reached: ${stops.some((s) => s.hiddenTrap)}`);
  };
  await step('k: keyboard', async () => {
    await walk('sign in', '/login', 10);
    await walk('create an account', '/register', 14);
    await walk('forgot password', '/forgot-password', 8);
    await walk('firm-quote form', '/rfq', 40);
    await walk('quote tool, empty', '/quote', 24);
    // Sign in by keyboard alone.
    const acc = await confirmedAccount(context, 'kbd');
    await context.clearCookies();
    await page.goto(`${BASE}/login`);
    await page.locator('#login-email').waitFor();
    await page.keyboard.press('Tab');
    let guard = 0;
    while (await page.evaluate(() => document.activeElement?.id) !== 'login-email' && guard++ < 12) await page.keyboard.press('Tab');
    await page.keyboard.type(acc.email);
    await page.keyboard.press('Tab');
    guard = 0;
    while (await page.evaluate(() => document.activeElement?.id) !== 'login-password' && guard++ < 4) await page.keyboard.press('Tab');
    await page.keyboard.type(acc.password);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }).catch(() => {});
    probe('keyboard only: sign in', !/\/login/.test(page.url()));
    // Upload by keyboard: the drop zone is a button.
    await page.goto(`${BASE}/quote`);
    await page.locator('.dropzone').first().waitFor();
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await page.locator('.dropzone').first().focus();
    await page.keyboard.press('Enter');
    const fc = await chooser;
    probe('keyboard only: Enter on the drop zone opens the file picker', Boolean(fc));
    if (fc) {
      await fc.setFiles(CUBE);
      await page.locator('aside').getByText(/Total|Budgetary/).first().waitFor({ timeout: 45000 });
      await walk('quote tool, priced', '/quote', 45);
    }
  });
  await context.close();
}

// ══════════════════════════════════════════════════════════════
// A server with no Turnstile keys (the state until the owner sets them)
// ══════════════════════════════════════════════════════════════
async function journeyNoKeys() {
  const context = await newVisitor();
  const page = await context.newPage();
  await step('d: replacement part, no bot check configured', async () => {
    await page.goto(`${BASE}/rfq?nocad=1`);
    await page.waitForTimeout(700);
    await fillRfq(page, { email: `part-nokeys-${width}@buyer.test` });
    await page.waitForTimeout(3300);
    await rfq.send(page).click();
    await received(page).waitFor({ timeout: 20000 });
    await shot(page, 'd04-part-request-received-no-check', { mask: [page.locator('.ship-part dd').nth(1).locator('xpath=self::*[not(@data-testid)]')] });
    await page.goto(`${BASE}/rfq`);
    await fillRfq(page, { email: `rfq-nokeys-${width}@buyer.test` });
    await page.waitForTimeout(3300);
    await rfq.send(page).click();
    await received(page).waitFor({ timeout: 20000 });
    await shot(page, 'd05-rfq-received-no-check');
    await page.goto(`${BASE}/register`);
    await page.locator('#reg-name').waitFor();
    await shot(page, 'd06-register-no-check');
    // A signed-in account that has not confirmed its email sends a request.
    const acc = { name: 'Sam Ortiz', email: `sam-${width}@buyer.test`, password: newPassword() };
    await register(page, acc);
    await page.goto(`${BASE}/rfq`);
    await rfq.notes(page).fill('Two guide rails, UHMW, drawing to follow.');
    await page.waitForTimeout(3300);
    await rfq.send(page).click();
    await received(page).waitFor({ timeout: 20000 });
    await shot(page, 'd07-rfq-received-unconfirmed-account');
  });
  await context.close();
}

// ══════════════════════════════════════════════════════════════
// Upload refusals (each on a server whose limits make it easy to reach)
// ══════════════════════════════════════════════════════════════
async function uploadRefusal(name, files, { process: proc } = {}) {
  const c = await newVisitor();
  const p = await c.newPage();
  await p.goto(`${BASE}/quote${proc ? `?process=${proc}` : ''}`);
  await p.locator('.dropzone').first().waitFor();
  await fileInput(p).setInputFiles(files);
  await p.locator('main [role="alert"]').first().waitFor({ timeout: 60000 });
  await shot(p, name, { fullPage: false });
  probe(`${name}: a way to a person is on the screen`, await p.locator('main [role="alert"]').first().evaluate((el) => /firm quote|email|call|\(\d{3}\)/i.test(el.innerText) || Boolean(el.querySelector('a, button'))));
  return { c, p };
}
async function journeyUploadLimits() {
  const small = stl('small-fan.stl', 200);
  await step('u: too many files', async () => { const { c } = await uploadRefusal('u01-upload-too-many-files', [CUBE, small, path.join(PARTS, 'spacer.stl')]); await c.close(); });
  await step('u: file too large', async () => { const { c } = await uploadRefusal('u02-upload-file-too-large', stl('big-scan.stl', 30000)); await c.close(); });
  await step('u: model too dense', async () => { const { c } = await uploadRefusal('u03-upload-model-too-dense', stl('dense-scan.stl', 4000)); await c.close(); });
  await step('u: daily limit', async () => {
    const { c, p } = await uploadRefusal('u03b-upload-dense-again', stl('dense-a.stl', 12000));
    await fileInput(p).setInputFiles(stl('dense-b.stl', 12000));
    await p.waitForTimeout(2500);
    await shot(p, 'u04-upload-daily-limit', { fullPage: false });
    await c.close();
  });
  await step('u: wrong type, damaged, renamed', async () => {
    let r = await uploadRefusal('u05-upload-wrong-type', textFile('part.pdf', '%PDF-1.4 not a model')); await r.c.close();
    r = await uploadRefusal('u06-upload-content-mismatch', textFile('photo.stl', `\x89PNG\r\n\x1a\n${'x'.repeat(400)}`)); await r.c.close();
    const cut = path.join(FILES, 'cut-short.stl'); fs.writeFileSync(cut, fs.readFileSync(stl('whole.stl', 300)).subarray(0, 2000));
    r = await uploadRefusal('u07-upload-damaged', cut); await r.c.close();
    r = await uploadRefusal('u08-upload-one-good-one-bad', [CUBE, cut]); await r.c.close();
  });
}
async function journeyUploadBusy() {
  await step('u: parse timed out, server busy, storage full', async () => {
    const slow = slowStep();
    const c1 = await newVisitor();
    const p1 = await c1.newPage();
    await p1.goto(`${BASE}/quote`);
    await p1.locator('.dropzone').first().waitFor();
    const c2 = await newVisitor();
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/quote`);
    await p2.locator('.dropzone').first().waitFor();
    await fileInput(p1).setInputFiles(slow);
    await p1.waitForTimeout(700);
    await shot(p1, 'u09-upload-reading', { fullPage: false, note: 'while a large STEP is being read' });
    await fileInput(p2).setInputFiles(CUBE);
    await p2.locator('main [role="alert"]').first().waitFor({ timeout: 30000 });
    await shot(p2, 'u10-upload-server-busy', { fullPage: false });
    await p1.locator('main [role="alert"]').first().waitFor({ timeout: 60000 });
    await shot(p1, 'u11-upload-parse-timed-out', { fullPage: false });
    await c1.close(); await c2.close();
    const r = await uploadRefusal('u12-upload-storage-full', stl('huge.stl', 240000)); await r.c.close();
  });
}

// ══════════════════════════════════════════════════════════════
const want = (k) => !ONLY || ONLY.has(k);
(async () => {
  browser = await chromium.launch();
  try {
    for (width of WIDTHS) {
      console.log(`\n══ ${width} px ══`);
      if (['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'k'].some(want)) {
        await startServer({ turnstile: true });
        if (want('a')) await journeyA();
        if (want('b')) await journeyB();
        if (want('c')) await journeyC();
        if (want('d')) await journeyD();
        if (want('e')) await journeyE();
        if (want('f')) await journeyF();
        if (want('h')) await journeyH();
        if (want('k')) await journeyK();
        if (want('g')) await journeyG();
        if (width === WIDTHS[WIDTHS.length - 1]) {
          const box = path.join(SCRATCH, `${LABEL}-outbox`);
          fs.rmSync(box, { recursive: true, force: true });
          if (fs.existsSync(OUTBOX)) fs.cpSync(OUTBOX, box, { recursive: true });
        }
      }
      if (want('d')) { await startServer({ turnstile: false }); await journeyNoKeys(); }
      if (want('u')) {
        await startServer({ turnstile: false, env: { UPLOAD_MAX_FILE_MB: '1', UPLOAD_MAX_FILES: '2', MESH_MAX_TRIANGLES: '1000', UPLOAD_DAILY_MB_PER_IP: '1' } });
        await journeyUploadLimits();
        await startServer({ turnstile: false, env: { PARSE_CONCURRENCY: '1', PARSE_QUEUE_MAX: '0', PARSE_TIMEOUT_MS: '3500', UPLOAD_DIR_MAX_MB: '10' } });
        await journeyUploadBusy();
      }
    }
  } finally {
    await browser.close();
    await stopServer();
    report.finished = new Date().toISOString();
    saveReport();
  }
  const serious = report.screens.filter((s) => (s.axe || []).some((v) => ['serious', 'critical'].includes(v.impact)));
  console.log(`\n${report.screens.length} screens recorded, ${report.screens.filter((s) => s.sideways.length).length} scroll sideways, ${serious.length} with serious/critical axe violations, ${report.problems.length} problems noted.`);
  console.log(`Report: ${path.join(SCRATCH, `${LABEL}-report.json`)}`);
})();
