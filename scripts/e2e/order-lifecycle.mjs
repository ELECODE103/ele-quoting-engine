#!/usr/bin/env node
/**
 * Browser run for the order-lifecycle fixes (2026-11-11), against a production-mode server it
 * starts itself.
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
 *   node scripts/e2e/order-lifecycle.mjs --scratch <dir> [--shots docs/screenshots/order-lifecycle-2026-11-11]
 *
 * What it drives, in a real Chromium at 1360 px, with a double click on every pay and accept button:
 *   A  instant checkout: one order and one payment page from a double click; pay; the paid order page
 *   B  the customer's order page in each new state: not paid and closed, payment being checked,
 *      refunded, partly refunded
 *   C  a firm quote accepted by card: Stripe is given no quote link; back from the card page;
 *      the same return in a browser that never saw the quote; a cancelled card payment
 *   D  a firm quote accepted on a purchase order
 *   E  a firm quote changed after it was sent: the link says so, the admin queue says so
 *   F  admin: the order list with its flags; the order drawer for a duplicate payment, a payment
 *      that does not match (marked paid by hand, with a reason), a refund, a dispute, an order
 *      that was never paid, and cancelling an unpaid order
 *   G  the same server restarted with promotion codes switched on: a discounted payment and a
 *      100% code, as the customer and the owner see them
 *
 * This script plays Stripe. The server's Stripe client is replaced in its own process
 * (stub-network.cjs + stub-stripe-hosted.cjs): a Checkout session is a file this script reads,
 * marks paid or expired, and then reports with a webhook signed with the run's throwaway
 * secret, exactly as Stripe would. The "payment page" is a stand-in served to the browser for a
 * host that does not exist. Every key, secret, password and code is made at run time; emails
 * are read from EMAIL_OUTBOX_DIR. Every page of ours runs under the server's real
 * Content-Security-Policy, and any violation fails the run.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const totp = require(path.join(ROOT, 'server', 'security', 'totp.js'));
const stripeSdk = require(path.join(ROOT, 'node_modules', 'stripe'))('sk_test_e2e_signing_only_not_a_key');
const { routeStandIn } = require(path.join(ROOT, 'scripts', 'e2e', 'turnstile-standin.cjs'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!arg('scratch', '')) { console.error('--scratch <dir> is required (database, outbox, Stripe session files, server logs)'); process.exit(2); }
const SCRATCH = path.resolve(arg('scratch', ''));
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/screenshots/order-lifecycle-2026-11-11'));
const PORT = Number(arg('port', 3893));
const BASE = `http://localhost:${PORT}`;
const OUTBOX = path.join(SCRATCH, 'outbox');
const STRIPE_DIR = path.join(SCRATCH, 'stripe');
const DATA = path.join(SCRATCH, 'data');
const OWNER = 'owner@straightedge.test';
const BUYER = 'dana@buyer.test';
const CUBE = path.join(ROOT, 'tools', 'vet-quotes', 'parts', 'cube_20mm.stl');
const SECRETS = { jwt: crypto.randomBytes(32).toString('hex'), whsec: `whsec_${crypto.randomBytes(24).toString('hex')}`, site: `e2e-site-${crypto.randomBytes(6).toString('hex')}`, turnstile: `e2e-secret-${crypto.randomBytes(12).toString('hex')}` };
const newPassword = () => `Qz8-${crypto.randomBytes(9).toString('base64url')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

for (const d of [SCRATCH, SHOTS]) fs.mkdirSync(d, { recursive: true });
for (const d of [OUTBOX, STRIPE_DIR, DATA]) fs.rmSync(d, { recursive: true, force: true });

// ─── Results ──────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  return ok;
}
async function step(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (err) { check(`${title}: completed`, false, err.stack || err.message); }
}

// ─── Server ───────────────────────────────────────────────────
let server = null;
let serverRuns = 0;
async function startServer(extra = {}) {
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
    QUOTING_DB_PATH: path.join(DATA, 'quoting.db'),
    QUOTING_DATA_DIR: DATA,
    JWT_SECRET: SECRETS.jwt,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: SECRETS.whsec,
    TURNSTILE_SITE_KEY: SECRETS.site,
    TURNSTILE_SECRET_KEY: SECRETS.turnstile,
    E2E_STUBS: '1',
    E2E_STRIPE_DIR: STRIPE_DIR,
    E2E_STRIPE_DELAY_MS: '250', // Stripe's own API call takes a moment; a double click lands inside it
    SE_TEST_HOOKS: '1',
    ...extra,
  };
  for (const k of ['ADMIN_RECOVERY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'STRIPE_PROMOTION_CODES', 'CHECKOUT_SESSION_MINUTES']) if (!(k in extra)) delete env[k];
  fs.mkdirSync(DATA, { recursive: true });
  const logFile = path.join(SCRATCH, `server-${++serverRuns}.log`);
  const log = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'scripts', 'e2e', 'stub-network.cjs'), '-r', path.join(ROOT, 'scripts', 'e2e', 'stub-stripe-hosted.cjs'), path.join(ROOT, 'server', 'index.js')], { cwd: SCRATCH, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  server = { child, logFile };
  for (let i = 0; i < 120; i++) {
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
const serverLog = () => fs.readdirSync(SCRATCH).filter((f) => /^server-\d+\.log$/.test(f)).map((f) => fs.readFileSync(path.join(SCRATCH, f), 'utf8')).join('\n');

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

// ─── Calls made the way the site's own pages make them ────────
let ipSeq = 0;
const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;
function formToken(form) {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRETS.jwt;
  try { return require(path.join(ROOT, 'server', 'security', 'botGuard.js')).issueFormToken(form, { now: Date.now() - 10000 }); }
  finally { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; }
}
async function call(method, url, { json, token, headers = {}, body } = {}) {
  const h = { 'X-Forwarded-For': nextIp(), ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${BASE}${url}`, { method, headers: h, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text };
}
async function register(email, name, password) {
  const r = await call('POST', '/api/auth/register', { json: { email, password, name }, headers: { 'X-Form-Token': formToken('register'), 'X-Turnstile-Token': 'e2e-pass-register' } });
  if (r.status !== 201) throw new Error(`register ${email}: ${r.status} ${r.text}`);
  const mail = await waitMail(email, /confirm your email/i);
  const v = await call('POST', '/api/auth/verify-email', { json: { token: (mail.text.match(/#token=(\S+)/) || [])[1] } });
  if (v.status !== 200) throw new Error(`verify ${email}: ${v.text}`);
  return r.body.token;
}
let humanToken = '';
async function human() {
  if (!humanToken) humanToken = (await call('POST', '/api/human/verify', { json: { turnstileToken: 'e2e-pass-quote' } })).body.humanToken;
  return humanToken;
}
async function uploadCube() {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(CUBE)]), 'cube_20mm.stl');
  const r = await call('POST', '/api/upload', { body: fd, headers: { 'X-Human-Token': await human() } });
  if (r.status !== 200 || !r.body.parts.length) throw new Error(`upload: ${r.status} ${r.text}`);
  return r.body.parts[0].partId;
}
async function quote(partId, quantity, token) {
  const r = await call('POST', '/api/quote', { json: { parts: [{ partId, process: 'cnc', materialSlug: 'cnc-aluminum-6061', quantity }], leadTimeSlug: 'standard' }, token, headers: { 'X-Human-Token': await human() } });
  if (r.status !== 200) throw new Error(`quote: ${r.status} ${r.text}`);
  return r.body;
}
/** A firm-quote request sent from the form and quoted by the owner. Returns { id, email, link, token }. */
let rfqSeq = 0;
async function firmQuote(owner, total, days = 10) {
  const email = `pat${++rfqSeq}@oem.test`;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ contactName: 'Pat Purchasing', email, company: 'OEM Conveyors', notes: `Guide rails, job ${rfqSeq}`, quantities: '250', process: 'cnc' })) fd.append(k, v);
  const c = await call('POST', '/api/rfq', { body: fd, headers: { 'X-Form-Token': formToken('rfq'), 'X-Turnstile-Token': 'e2e-pass-rfq' } });
  if (c.status !== 201) throw new Error(`rfq: ${c.status} ${c.text}`);
  const q = await call('PUT', `/api/rfq/admin/${c.body.rfqId}`, { json: { status: 'quoted', quotedTotal: total, quotedLeadDays: days }, token: owner });
  if (q.status !== 200 || !q.body.acceptUrl) throw new Error(`quote send: ${q.status} ${q.text}`);
  const mail = await waitMail(email, /firm quote/i);
  const link = (mail.text.match(new RegExp(`${BASE}/firm-quote/\\S+`)) || [])[0];
  return { id: c.body.rfqId, email, link, token: link.split('/firm-quote/')[1] };
}

// ─── Playing Stripe ───────────────────────────────────────────
const sessionFile = (id) => path.join(STRIPE_DIR, `${id}.json`);
const session = (id) => JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
const allSessions = () => fs.readdirSync(STRIPE_DIR).filter((f) => f.startsWith('cs_')).map((f) => JSON.parse(fs.readFileSync(path.join(STRIPE_DIR, f), 'utf8'))).sort((a, b) => Number(a.id.split('_').pop()) - Number(b.id.split('_').pop()));
const sessionsOf = (orderId) => allSessions().filter((s) => s.metadata && s.metadata.orderId === orderId);
const openSessionsOf = (orderId) => sessionsOf(orderId).filter((s) => s.status === 'open');
async function webhook(type, object) {
  const payload = JSON.stringify({ id: `evt_e2e_${crypto.randomBytes(8).toString('hex')}`, type, data: { object } });
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSdk.webhooks.generateTestHeaderString({ payload, secret: SECRETS.whsec }), 'X-Forwarded-For': nextIp() }, body: payload });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** The buyer pays on Stripe's page: the session is paid, and Stripe says so. `over` changes what Stripe reports. */
async function stripePays(id, over = {}) {
  const paid = { ...session(id), status: 'complete', payment_status: 'paid', payment_intent: `pi_e2e_${id.split('_').pop()}`, ...over };
  fs.writeFileSync(sessionFile(id), JSON.stringify(paid, null, 1));
  const { success_url, cancel_url, line_items, allow_promotion_codes, ...object } = paid; // eslint-disable-line no-unused-vars
  const r = await webhook('checkout.session.completed', object);
  if (r.status !== 200) throw new Error(`webhook ${r.status}`);
  return paid;
}
async function stripeExpires(id) {
  const expired = { ...session(id), status: 'expired' };
  fs.writeFileSync(sessionFile(id), JSON.stringify(expired, null, 1));
  return webhook('checkout.session.expired', { id, object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: expired.metadata });
}

// ─── Browser ──────────────────────────────────────────────────
let browser;
let visitor = 0;
const consoleProblems = [];
const cspViolations = [];
async function newContext() {
  // No bypassCSP: every page of ours runs under the policy the server sends.
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': `203.0.113.${++visitor}` } });
  await context.exposeBinding('__cspReport', (source, v) => { cspViolations.push(v); });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      if (location.hostname === 'localhost') window.__cspReport({ page: location.pathname, directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample || '' });
    });
  });
  await routeStandIn(context);
  // Stand-in for Stripe's hosted payment page (the host does not exist; nothing leaves the machine).
  await context.route('https://checkout.stripe.test/**', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    let s = null;
    try { s = session(id); } catch { /* unknown */ }
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const body = s
      ? `<h1>Payment page (test stand-in for Stripe)</h1>
         <p>Session <code>${esc(s.id)}</code> &middot; <b>${esc(s.status)}</b> &middot; ${esc(s.payment_status)}</p>
         <table>${s.line_items.map((li) => `<tr><td>${esc(li.name)}</td><td style="text-align:right">${money(li.amount / 100)}</td></tr>`).join('')}
         <tr><td><b>Total due</b></td><td style="text-align:right"><b>${money(s.amount_total / 100)}</b></td></tr></table>
         <p>Promotion codes: ${s.allow_promotion_codes ? 'accepted' : 'not accepted'} &middot; this page closes ${s.expires_at ? new Date(s.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}</p>
         <p>Returns to: <code>${esc(s.success_url.replace(/([?&]r=)[^&]+/, '$1<return token>'))}</code></p>`
      : '<h1>No such session</h1>';
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Stripe stand-in</title><body style="font:15px/1.5 sans-serif;max-width:760px;margin:60px auto;color:#101C33">${body}<style>table{border-collapse:collapse;width:100%;margin:16px 0}td{padding:8px 0;border-bottom:1px solid #ddd}code{font-size:12px;word-break:break-all}</style></body>` });
  });
  context.on('page', (page) => {
    page.on('console', (m) => {
      if (!page.url().startsWith(BASE)) return;
      if (/Content Security Policy|Content-Security-Policy|violates the following/i.test(m.text())) { cspViolations.push({ page: page.url(), directive: 'console', blocked: m.text().slice(0, 200) }); return; }
      if (m.type() === 'error' && !/challenges\.cloudflare\.com|Failed to load resource/.test(m.text())) consoleProblems.push(`${page.url().replace(/firm-quote\/[^?]+/, 'firm-quote/<link>')} :: ${m.text()}`);
    });
    page.on('pageerror', (e) => { if (page.url().startsWith(BASE)) consoleProblems.push(`${page.url().replace(/firm-quote\/[^?]+/, 'firm-quote/<link>')} :: pageerror ${e.message}`); });
  });
  return context;
}
const shot = async (page, name, opts = {}) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: opts.fullPage !== false }); };
/** A JSON call from inside the page (same origin, with the session cookie and its CSRF token). */
async function apiFrom(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') {
      const s = await fetch('/api/auth/session').then((r) => r.json());
      if (s.csrfToken) headers['X-CSRF-Token'] = s.csrfToken;
    }
    const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text: text.slice(0, 400) };
  }, { method, url, body });
}
/** Sign in through the sign-in page (the session is an httpOnly, host-locked cookie: only the server can set it). */
async function signIn(page, email, password, { code } = {}) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (code) {
    await page.getByLabel('Code from your authenticator app').waitFor({ timeout: 10000 });
    await page.getByLabel('Code from your authenticator app').fill(code());
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
}
const SHIP = { name: 'Dana Buyer', street: '100 Main St', city: 'Elgin', state: 'IL', zip: '60120' };
async function fillCheckout(page) {
  await page.getByLabel('Full Name').fill(SHIP.name);
  await page.getByLabel('Street Address').fill(SHIP.street);
  await page.getByLabel('City').fill(SHIP.city);
  await page.getByLabel('State').fill(SHIP.state);
  await page.getByLabel('ZIP Code').fill(SHIP.zip);
}
async function fillFirmQuote(page) {
  await page.getByLabel('Name / company').fill('OEM Conveyors, Receiving');
  await page.getByLabel('Street address').fill('500 Plant Rd');
  await page.getByLabel('City').fill('Rockford');
  await page.getByLabel('State').fill('IL');
  await page.getByLabel('ZIP').fill('61101');
}
const stripeSessionIn = (url) => (url.match(/checkout\.stripe\.test\/pay\/(cs_e2e_\d+)/) || [])[1];

// ══════════════════════════════════════════════════════════════
const state = {};

async function main() {
  await startServer();
  const log1 = fs.readFileSync(server.logFile, 'utf8');
  check('the server says at startup how long a payment page stays open and that promotion codes are off', /card checkout sessions stay open 120 minutes; promotion codes at checkout are off/.test(log1));

  // Accounts and parts, set up the way the pages do it (form token, bot check passed, emailed link opened).
  const ownerPw = newPassword();
  const buyerPw = newPassword();
  let ownerToken = await register(OWNER, 'Owner', ownerPw);
  const setup = await call('POST', '/api/auth/2fa/setup', { json: { password: ownerPw }, token: ownerToken });
  const setupKey = setup.body.setupKey.replace(/\s/g, '');
  const enrolStep = totp.stepAt();
  ownerToken = (await call('POST', '/api/auth/2fa/enable', { json: { code: totp.codeAt(setupKey) }, token: ownerToken })).body.token;
  const buyerToken = await register(BUYER, 'Dana Buyer', buyerPw);
  const partId = await uploadCube();
  const admin = (method, url, json) => call(method, url, { json, token: ownerToken });
  const orderRow = async (id) => (await admin('GET', `/api/orders/${id}`)).body;
  const ordersOfQuote = async (quoteId) => (await admin('GET', '/api/orders')).body.filter((o) => o.quoteId === quoteId);

  const buyerCtx = await newContext();
  const buyer = await buyerCtx.newPage();
  await signIn(buyer, BUYER, buyerPw);

  /** Quote → checkout page → double click on pay → the payment page. Returns { quoteId, orderId, sessionId }. */
  async function checkoutWithDoubleClick(quantity, { shots } = {}) {
    const q = await quote(partId, quantity, buyerToken);
    await buyer.goto(`${BASE}/checkout/${q.quoteId}`);
    await fillCheckout(buyer);
    const pay = buyer.getByRole('button', { name: /Pay & Place Order/ });
    await pay.waitFor();
    if (shots) await shot(buyer, shots[0], { fullPage: false });
    await pay.dblclick();
    await buyer.waitForURL(/checkout\.stripe\.test\/pay\//, { timeout: 20000 });
    const sessionId = stripeSessionIn(buyer.url());
    if (shots) await shot(buyer, shots[1], { fullPage: false });
    const orders = await ordersOfQuote(q.quoteId);
    return { quoteId: q.quoteId, total: q.orderTotal, orders, orderId: orders[0] && orders[0].id, sessionId };
  }

  // ─── A ───────────────────────────────────────────────────────
  await step('A. Instant checkout: a double click on pay', async () => {
    const a = await checkoutWithDoubleClick(3, { shots: ['instant-01-checkout', 'instant-02-payment-page-stand-in'] });
    state.a = a;
    check('a double click on "Pay & Place Order" makes one order', a.orders.length === 1, `${a.orders.length} orders`);
    check('and one open payment page for it', openSessionsOf(a.orderId).length === 1 && sessionsOf(a.orderId).length === 1, `${sessionsOf(a.orderId).length} sessions`);
    const s = session(a.sessionId);
    const minutes = (s.expires_at * 1000 - Date.now()) / 60000;
    check('the payment page has an expiry about two hours out and takes no promotion codes', minutes > 110 && minutes < 121 && s.allow_promotion_codes === false, `${minutes.toFixed(0)} min`);
    // Two requests at the very same moment, from the page itself (what a double click on a slow connection sends).
    const q2 = await quote(partId, 4, buyerToken);
    await buyer.goto(`${BASE}/checkout/${q2.quoteId}`);
    const twice = await buyer.evaluate(async ({ quoteId, ship }) => {
      const csrf = (await fetch('/api/auth/session').then((r) => r.json())).csrfToken;
      const post = () => fetch('/api/orders/checkout-session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ quoteId, shippingName: ship.name, shippingAddress: ship.street, shippingCity: ship.city, shippingState: ship.state, shippingZip: ship.zip }) }).then((r) => r.json());
      return Promise.all([post(), post()]);
    }, { quoteId: q2.quoteId, ship: SHIP });
    state.b2 = { quoteId: q2.quoteId, orderId: twice[0].orderId, sessionId: stripeSessionIn(twice[0].sessionUrl), total: q2.orderTotal };
    check('two checkout requests at the same moment get the same order and the same payment page', twice[0].orderId === twice[1].orderId && twice[0].sessionUrl === twice[1].sessionUrl && (await ordersOfQuote(q2.quoteId)).length === 1 && sessionsOf(twice[0].orderId).length === 1, JSON.stringify(twice));

    // Back from the payment page without paying, then pay again: the same page, not a second one.
    await buyer.goto(`${BASE}/checkout/${a.quoteId}?cancelled=true`);
    await fillCheckout(buyer);
    await buyer.getByRole('button', { name: /Pay & Place Order/ }).click();
    await buyer.waitForURL(/checkout\.stripe\.test\/pay\//, { timeout: 20000 });
    check('pressing pay again after coming back opens the same payment page', stripeSessionIn(buyer.url()) === a.sessionId && sessionsOf(a.orderId).length === 1);

    // The buyer pays.
    const before = mails().length;
    const paid = await stripePays(a.sessionId);
    await buyer.goto(paid.success_url);
    await buyer.getByText('Payment received. Thank you.').waitFor({ timeout: 15000 });
    await shot(buyer, 'customer-order-paid');
    const o = await orderRow(a.orderId);
    const sent = mails().slice(before);
    check('the order is paid, with the payment on record', o.status === 'paid' && o.stripePaymentId === paid.payment_intent && o.amountPaid === paid.amount_total / 100 && o.paidVia === 'card');
    check('one confirmation to the buyer and one new-order notice to the shop', sent.filter((m) => m.to === BUYER && /confirmed/.test(m.subject)).length === 1 && sent.filter((m) => m.to === OWNER && /^New order/.test(m.subject)).length === 1, sent.map((m) => m.subject).join(' | '));
  });

  // ─── B ───────────────────────────────────────────────────────
  await step('B. The customer\'s order page in each new state', async () => {
    // Not paid, closed: the payment page of the second order lapses.
    const b = state.b2;
    const ex = await stripeExpires(b.sessionId);
    check('Stripe reports the session expired: the unpaid order is closed out', ex.status === 200 && (await orderRow(b.orderId)).status === 'expired', JSON.stringify(ex.body));
    await buyer.goto(`${BASE}/orders/${b.orderId}`);
    await buyer.getByTestId('order-expired').waitFor({ timeout: 15000 });
    await shot(buyer, 'customer-order-not-paid-closed');
    check('the order page says it was not paid and has closed, in plain words, with the way back to checkout', /This order was not paid for, so it has closed\. Nothing was charged\./.test(await buyer.getByTestId('order-expired').textContent()));
    await buyer.getByRole('link', { name: 'go back to checkout' }).click();
    await buyer.waitForURL(new RegExp(`/checkout/${b.quoteId}`));
    await fillCheckout(buyer);
    await buyer.getByRole('button', { name: /Pay & Place Order/ }).dblclick();
    await buyer.waitForURL(/checkout\.stripe\.test\/pay\//, { timeout: 20000 });
    const again = (await ordersOfQuote(b.quoteId)).filter((o) => o.status === 'pending_payment');
    check('the quote can be ordered again: a new order, one payment page', again.length === 1 && again[0].id !== b.orderId && openSessionsOf(again[0].id).length === 1);
    state.c = { orderId: again[0].id, sessionId: stripeSessionIn(buyer.url()) };
    await stripePays(state.c.sessionId);
    check('and paid', (await orderRow(state.c.orderId)).status === 'paid');

    // A payment that does not match: Stripe reports $1.00 for it.
    const m = await checkoutWithDoubleClick(5);
    state.mismatch = m;
    const before = mails().length;
    await stripePays(m.sessionId, { amount_total: 100, amount_subtotal: 100 });
    const flagged = await orderRow(m.orderId);
    check('a payment for the wrong amount does not mark the order paid: it is flagged', flagged.status === 'pending_payment' && flagged.attention === 'payment-mismatch');
    const told = mails().slice(before);
    check('the shop is told once, the customer is sent nothing', told.length === 1 && told[0].to === OWNER && /needs attention: payment does not match the order/.test(told[0].subject), told.map((x) => x.subject).join(' | '));
    await buyer.goto(`${BASE}/orders/${m.orderId}?paid=true`);
    await buyer.getByTestId('payment-under-review').waitFor({ timeout: 20000 });
    await shot(buyer, 'customer-order-payment-being-checked');
    check('the customer sees that the payment is being checked, not why', /We're checking your payment/.test(await buyer.textContent('body')) && !/mismatch|attention|Stripe reports/i.test(await buyer.textContent('body')));

    // Refunds, as Stripe reports them.
    const a = await orderRow(state.a.orderId);
    const cents = Math.round(a.amountPaid * 100);
    await webhook('charge.refunded', { id: 'ch_e2e_a', object: 'charge', payment_intent: a.stripePaymentId, amount: cents, amount_captured: cents, amount_refunded: cents, refunded: true, currency: 'usd' });
    await buyer.goto(`${BASE}/orders/${state.a.orderId}`);
    await buyer.getByTestId('order-refunded').waitFor({ timeout: 15000 });
    await shot(buyer, 'customer-order-refunded');
    check('a full refund: the order reads refunded, with the amount', (await orderRow(state.a.orderId)).status === 'refunded' && (await buyer.getByTestId('order-refunded').textContent()).includes(money(cents / 100)));
    const c = await orderRow(state.c.orderId);
    const ccents = Math.round(c.amountPaid * 100);
    await webhook('charge.refunded', { id: 'ch_e2e_c', object: 'charge', payment_intent: c.stripePaymentId, amount: ccents, amount_captured: ccents, amount_refunded: 2500, refunded: false, currency: 'usd' });
    await buyer.goto(`${BASE}/orders/${state.c.orderId}`);
    await buyer.getByTestId('order-part-refunded').waitFor({ timeout: 15000 });
    await shot(buyer, 'customer-order-partly-refunded');
    const part = await orderRow(state.c.orderId);
    check('a partial refund: the order stays paid and shows $25.00 refunded', part.status === 'paid' && part.refundedAmount === 25 && /We refunded \$25\.00 of this order/.test(await buyer.textContent('body')));
    // …and then the cardholder disputes what is left.
    await webhook('charge.dispute.created', { id: 'dp_e2e_c', object: 'dispute', charge: 'ch_e2e_c', payment_intent: c.stripePaymentId, amount: ccents - 2500, currency: 'usd', reason: 'product_not_received', status: 'needs_response' });
    const disputed = await orderRow(state.c.orderId);
    check('a dispute flags the order and tells the shop at once; the order is not cancelled', disputed.status === 'paid' && disputed.attention === 'dispute' && disputed.disputeStatus === 'open' && mailsTo(OWNER, /payment disputed/).length === 1);
    await buyer.reload();
    check('the customer\'s page says nothing about the dispute', !/dispute/i.test(await buyer.textContent('body')));

    // A second payment for an order that is already paid.
    const d = await checkoutWithDoubleClick(6);
    state.dup = d;
    await stripePays(d.sessionId);
    const beforeDup = mails().length;
    const second = await webhook('checkout.session.completed', { id: 'cs_e2e_second_tab', object: 'checkout.session', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: session(d.sessionId).amount_total, total_details: { amount_discount: 0 }, payment_intent: 'pi_e2e_second_tab', metadata: { orderId: d.orderId } });
    const dup = await orderRow(d.orderId);
    check('a second payment for a paid order is recorded, flagged and reported; the order stays paid', second.status === 200 && second.body.outcome === 'duplicate-payment' && dup.status === 'paid' && dup.attention === 'duplicate-payment' && mails().slice(beforeDup).length === 1 && /needs attention: duplicate payment/.test(mails().slice(beforeDup)[0].subject));
  });

  // ─── C ───────────────────────────────────────────────────────
  await step('C. A firm quote accepted by card', async () => {
    const f = await firmQuote(ownerToken, 1500);
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(f.link);
    await page.getByRole('heading', { name: '$1,500.00, firm.' }).waitFor({ timeout: 15000 });
    await fillFirmQuote(page);
    await shot(page, 'firm-quote-01-accept-by-card');
    check('the accept page shows the amount the link was issued for', (await page.getByRole('button', { name: 'Accept and pay $1,500.00' }).count()) === 1);
    await page.getByRole('button', { name: 'Accept and pay $1,500.00' }).dblclick();
    await page.waitForURL(/checkout\.stripe\.test\/pay\//, { timeout: 20000 });
    const sid = stripeSessionIn(page.url());
    const orders = (await admin('GET', '/api/orders')).body.filter((o) => o.rfqId === f.id);
    check('a double click on accept makes one order and one payment page', orders.length === 1 && sessionsOf(orders[0].id).length === 1, `${orders.length} orders, ${orders[0] ? sessionsOf(orders[0].id).length : 0} sessions`);
    const s = session(sid);
    await shot(page, 'firm-quote-02-payment-page-stand-in', { fullPage: false });
    check('nothing sent to Stripe carries the quote link: the return address holds the order and a return token', !JSON.stringify(s).includes(f.token) && !/firm-quote\/eyJ/.test(s.success_url + s.cancel_url) && s.success_url.startsWith(`${BASE}/firm-quote/return?o=${orders[0].id}&r=`) && s.cancel_url === `${BASE}/firm-quote/return?o=${orders[0].id}&cancelled=true`, s.success_url);

    // Two accepts at the very same moment, from another quote's page.
    const g = await firmQuote(ownerToken, 2750);
    const racePage = await ctx.newPage();
    await racePage.goto(g.link);
    await racePage.getByRole('heading', { name: '$2,750.00, firm.' }).waitFor({ timeout: 15000 });
    const race = await racePage.evaluate(async (token) => {
      const body = JSON.stringify({ method: 'card', shippingName: 'OEM Conveyors', shippingAddress: '500 Plant Rd', shippingCity: 'Rockford', shippingState: 'IL', shippingZip: '61101', seenTotal: 2750 });
      const post = () => fetch(`/api/rfq/quote/${token}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(async (r) => ({ ...(await r.json()), http: r.status }));
      return Promise.all([post(), post()]);
    }, g.token);
    const raced = (await admin('GET', '/api/orders')).body.filter((o) => o.rfqId === g.id);
    check('two accepts at the same moment: one order, the same payment page for both', raced.length === 1 && race[0].sessionUrl === race[1].sessionUrl && race[0].order === race[1].order && [race[0].http, race[1].http].sort().join() === '200,201', JSON.stringify(race.map((r) => [r.http, r.order])));
    state.cancelQuote = { ...g, orderId: raced[0].id, sessionId: stripeSessionIn(race[0].sessionUrl) };
    await racePage.close();

    // Pay, and come back the way Stripe sends the browser.
    const paid = await stripePays(sid);
    await page.goto(paid.success_url);
    await page.waitForURL(/\/firm-quote\/eyJ[^?]+\?paid=true/, { timeout: 20000 });
    await page.getByRole('heading', { name: 'Order in. Thank you.' }).waitFor({ timeout: 15000 });
    await shot(page, 'firm-quote-03-paid');
    check('back from the card page the buyer is on their quote page, paid', /Payment received\. A confirmation is on its way/.test(await page.textContent('body')) && (await orderRow(orders[0].id)).status === 'paid');
    check('the buyer is emailed a confirmation with a link to their order page', mailsTo(f.email, /confirmed/).length === 1 && /firm-quote\//.test(mailsTo(f.email, /confirmed/)[0].text));

    // The same return address opened where the quote link was never seen (another browser, a new tab).
    const elsewhere = await newContext();
    const other = await elsewhere.newPage();
    await other.goto(paid.success_url);
    await other.getByRole('heading', { name: 'Payment received. Thank you.' }).waitFor({ timeout: 20000 });
    await shot(other, 'firm-quote-04-return-page-without-the-link');
    const text = await other.textContent('body');
    check('the return address alone shows where the order stands and nothing about who it is for', /Order [0-9A-F]{8}, \$1,500\.00/.test(text) && !text.includes(f.email) && !/Pat Purchasing|OEM Conveyors|500 Plant Rd/.test(text));
    const forged = await other.evaluate(async (o) => (await fetch('/api/rfq/return/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: o, token: 'not-a-token' }) })).status, orders[0].id);
    check('without the return token the same question is refused', forged === 404);
    await elsewhere.close();

    // A cancelled card payment.
    const c = state.cancelQuote;
    const cancelPage = await ctx.newPage();
    await cancelPage.goto(c.link);
    await cancelPage.getByRole('button', { name: /Pay \$2,750\.00 by card/ }).waitFor({ timeout: 15000 });
    await cancelPage.getByRole('button', { name: /Pay \$2,750\.00 by card/ }).dblclick();
    await cancelPage.waitForURL(/checkout\.stripe\.test\/pay\//, { timeout: 20000 });
    check('"pay by card" again (double click) opens the same payment page for the same order', stripeSessionIn(cancelPage.url()) === c.sessionId && sessionsOf(c.orderId).length === 1);
    await cancelPage.goto(session(c.sessionId).cancel_url);
    await cancelPage.waitForURL(/\/firm-quote\/eyJ[^?]+\?cancelled=true/, { timeout: 20000 });
    await cancelPage.getByText('The card payment was cancelled. Nothing was charged.').waitFor({ timeout: 15000 });
    await shot(cancelPage, 'firm-quote-05-card-payment-cancelled');
    check('a cancelled card payment returns to the quote page and says nothing was charged', (await orderRow(c.orderId)).status === 'pending_payment');
    await ctx.close();
  });

  // ─── D ───────────────────────────────────────────────────────
  await step('D. A firm quote accepted on a purchase order', async () => {
    const f = await firmQuote(ownerToken, 4200, 12);
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(f.link);
    await page.getByRole('heading', { name: '$4,200.00, firm.' }).waitFor({ timeout: 15000 });
    await fillFirmQuote(page);
    await page.locator('label.lead-option', { hasText: 'Purchase order' }).click();
    await page.getByRole('textbox', { name: 'PO number' }).fill('PO-778 / Rev.B');
    await shot(page, 'firm-quote-06-accept-on-a-po');
    const before = mails().length;
    await page.getByRole('button', { name: 'Accept on this PO' }).dblclick();
    await page.getByRole('heading', { name: 'Order in. Thank you.' }).waitFor({ timeout: 15000 });
    await shot(page, 'firm-quote-07-po-accepted');
    const orders = (await admin('GET', '/api/orders')).body.filter((o) => o.rfqId === f.id);
    check('a double click on "Accept on this PO" makes one order, awaiting PO confirmation, with nothing charged', orders.length === 1 && orders[0].status === 'pending_po' && orders[0].poNumber === 'PO-778 / Rev.B' && sessionsOf(orders[0].id).length === 0);
    const sent = mails().slice(before);
    check('the shop gets one "accepted on a purchase order" email; the buyer one confirmation', sent.filter((m) => m.to === OWNER && /accepted on a purchase order/.test(m.subject)).length === 1 && sent.filter((m) => m.to === f.email && /confirmed/.test(m.subject)).length === 1, sent.map((m) => m.subject).join(' | '));
    state.po = { orderId: orders[0].id };
    // A PO number with a line break cannot be typed into the field; sent straight to the server it is refused.
    const h = await firmQuote(ownerToken, 300);
    const refused = await call('POST', `/api/rfq/quote/${h.token}/accept`, { json: { method: 'po', poNumber: 'PO-778\nPAID IN FULL - SHIP TODAY', shippingName: 'x', shippingAddress: 'x', shippingCity: 'x', shippingState: 'IL', shippingZip: '60000' } });
    check('a PO number with a line break is refused with a reason, not rewritten', refused.status === 400 && refused.body.code === 'po-number-invalid');
    await ctx.close();
  });

  // ─── E ───────────────────────────────────────────────────────
  await step('E. A firm quote changed after it was sent', async () => {
    const f = await firmQuote(ownerToken, 1500);
    state.changed = f;
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(f.link);
    await page.getByRole('heading', { name: '$1,500.00, firm.' }).waitFor({ timeout: 15000 });
    await fillFirmQuote(page);
    // The owner saves a new total and does not send it.
    const edit = await admin('PUT', `/api/rfq/admin/${f.id}`, { quotedTotal: 2500 });
    check('saving a new total without sending tells the owner the link no longer works', edit.status === 200 && edit.body.linkInvalidated === true && edit.body.needsResend === true && edit.body.acceptUrl === null);
    // The buyer presses accept on the page they still have open.
    await page.getByRole('button', { name: 'Accept and pay $1,500.00' }).dblclick();
    await page.getByRole('heading', { name: 'This quote has been updated.' }).waitFor({ timeout: 15000 });
    await shot(page, 'firm-quote-08-changed-after-it-was-sent');
    check('the buyer cannot accept the old page: no order, no payment page, and the page says the quote was updated', (await admin('GET', '/api/orders')).body.filter((o) => o.rfqId === f.id).length === 0 && /changed after this link was sent/.test(await page.textContent('body')));
    await page.goto(f.link);
    await page.getByRole('heading', { name: 'This quote has been updated.' }).waitFor({ timeout: 15000 });
    check('opening the emailed link again says the same', true);
    await ctx.close();
  });

  // ─── F ───────────────────────────────────────────────────────
  const ownerCtx = await newContext();
  const ownerPage = await ownerCtx.newPage();
  // A code is good once: the one used to switch two-step sign-in on cannot be used to sign in.
  while (totp.stepAt() <= enrolStep) await sleep(500);
  await signIn(ownerPage, OWNER, ownerPw, { code: () => totp.codeAt(setupKey) });
  const dialogs = [];
  ownerPage.on('dialog', async (d) => {
    const answer = dialogs.shift();
    if (d.type() === 'prompt') await d.accept(answer === undefined ? '' : answer);
    else if (answer === false) await d.dismiss();
    else await d.accept();
  });
  const openDrawer = async (orderId) => {
    await ownerPage.goto(`${BASE}/admin`);
    await ownerPage.getByTestId('payment-status').waitFor({ timeout: 20000 });
    await ownerPage.locator(`a[href="#order-${orderId}"]`).click();
    await ownerPage.getByText('Order Detail').waitFor({ timeout: 10000 });
    await ownerPage.getByText('Fulfillment Status').waitFor({ timeout: 10000 });
  };

  await step('F. Admin: the order list and the order drawer in each new state', async () => {
    // An unpaid order to cancel, and one accepted on a card and left unpaid.
    const toCancel = await checkoutWithDoubleClick(7);
    state.toCancel = toCancel;
    await ownerPage.goto(`${BASE}/admin`);
    await ownerPage.getByTestId('payment-status').waitFor({ timeout: 20000 });
    await ownerPage.getByTestId('promo-setting').waitFor();
    await ownerPage.getByTestId('order-flags').first().waitFor({ timeout: 20000 }); // the list has loaded
    const line = await ownerPage.getByTestId('payment-status').textContent();
    check('the orders tab says how many orders need attention and that promotion codes are off', /3 orders need attention/.test(line) && /Promotion codes at checkout: Off/.test(line) && /stays open for 2 hours/.test(line), line);
    const flags = (await ownerPage.getByTestId('order-flags').allTextContents()).join(' | ');
    check('the list flags: needs attention (duplicate, mismatch, dispute), refunded, part refunded, never paid', /Needs attention: duplicate payment/.test(flags) && /Needs attention: payment does not match/.test(flags) && /Needs attention: payment disputed/.test(flags) && /Refunded \$/.test(flags) && /Part refunded \$25\.00/.test(flags) && /Never paid/.test(flags), flags);
    await shot(ownerPage, 'admin-01-orders-with-flags');

    // Duplicate payment → clear the flag with a note.
    await openDrawer(state.dup.orderId);
    await ownerPage.getByTestId('attention-banner').waitFor();
    await shot(ownerPage, 'admin-02-order-duplicate-payment', { fullPage: false });
    check('the drawer says what happened and what to do, with the payment history', /second card payment/.test(await ownerPage.getByTestId('attention-banner').textContent()) && /Refund the second payment in Stripe/.test(await ownerPage.getByTestId('attention-banner').textContent()) && /Second payment received/.test(await ownerPage.getByTestId('order-payment-panel').textContent()));
    dialogs.push('refunded in Stripe, customer told');
    await ownerPage.getByRole('button', { name: /I've dealt with it/ }).click();
    await ownerPage.getByTestId('attention-banner').waitFor({ state: 'detached', timeout: 10000 });
    check('clearing the flag takes a note and is kept', (await orderRow(state.dup.orderId)).attention === null && /Flag cleared/.test(await ownerPage.getByTestId('order-payment-panel').textContent()));

    // Payment that does not match → mark paid by hand, which asks how it was paid.
    await openDrawer(state.mismatch.orderId);
    await ownerPage.getByTestId('attention-banner').waitFor();
    await shot(ownerPage, 'admin-03-order-payment-does-not-match', { fullPage: false });
    const inProduction = ownerPage.getByRole('button', { name: 'In Production', exact: true });
    check('an unpaid order cannot be moved into production from the drawer', await inProduction.isDisabled());
    dialogs.push(''); // no reason given: nothing happens
    await ownerPage.getByTestId('mark-paid').click();
    await sleep(400);
    check('marking paid with no reason does nothing', (await orderRow(state.mismatch.orderId)).status === 'pending_payment');
    dialogs.push('balance paid by cheque 2207');
    await ownerPage.getByTestId('mark-paid').click();
    await ownerPage.getByText('Marked paid by hand', { exact: true }).first().waitFor({ timeout: 10000 });
    await shot(ownerPage, 'admin-04-order-marked-paid-by-hand', { fullPage: false });
    const byHand = await orderRow(state.mismatch.orderId);
    check('marked paid by hand, with the reason and who did it on the order; its payment page is closed at Stripe', byHand.status === 'paid' && byHand.paidVia === 'manual' && /balance paid by cheque 2207/.test(byHand.manualPaidReason) && byHand.manualPaidBy === OWNER && session(state.mismatch.sessionId).status !== 'open');

    // Refunded, partly refunded + disputed, never paid.
    await openDrawer(state.a.orderId);
    await ownerPage.getByTestId('closed-status').waitFor();
    await shot(ownerPage, 'admin-05-order-refunded', { fullPage: false });
    check('a refunded order reads Refunded, with the amount, and is out of the production queue', /Refunded/.test(await ownerPage.getByTestId('closed-status').textContent()) && !(await admin('GET', '/api/orders/admin/queue')).body.some((o) => o.id === state.a.orderId));
    await openDrawer(state.c.orderId);
    await ownerPage.getByTestId('attention-banner').waitFor();
    await shot(ownerPage, 'admin-06-order-partly-refunded-and-disputed', { fullPage: false });
    const panel = await ownerPage.getByTestId('order-payment-panel').textContent();
    check('a disputed, partly refunded order shows both, says nothing was cancelled, and stays in the queue', /Needs attention: payment disputed/.test(panel) && /Part refunded/.test(panel) && /\$25\.00/.test(panel) && /Nothing was cancelled/.test(panel) && (await admin('GET', '/api/orders/admin/queue')).body.some((o) => o.id === state.c.orderId));
    await openDrawer(state.b2.orderId);
    await ownerPage.getByTestId('closed-status').waitFor();
    await shot(ownerPage, 'admin-07-order-never-paid', { fullPage: false });
    check('an order that was never paid reads "Not paid, closed"', /Not paid, closed/.test(await ownerPage.getByTestId('closed-status').textContent()));

    // Cancel an unpaid order: confirm, give a reason.
    await openDrawer(toCancel.orderId);
    dialogs.push(true, 'customer called it off');
    await ownerPage.getByTestId('cancel-order').click();
    await ownerPage.getByTestId('closed-status').waitFor({ timeout: 10000 });
    await shot(ownerPage, 'admin-08-order-cancelled', { fullPage: false });
    check('cancelling an unpaid order closes its payment page at Stripe', (await orderRow(toCancel.orderId)).status === 'cancelled' && session(toCancel.sessionId).status === 'expired');
    const beforeLate = mails().length;
    const late = await webhook('checkout.session.completed', { id: toCancel.sessionId, object: 'checkout.session', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: session(toCancel.sessionId).amount_total, total_details: { amount_discount: 0 }, payment_intent: 'pi_e2e_late', metadata: { orderId: toCancel.orderId } });
    const lateOrder = await orderRow(toCancel.orderId);
    check('a payment that arrives for the cancelled order anyway is flagged and reported, not dropped', late.body.outcome === 'late-payment' && lateOrder.status === 'cancelled' && lateOrder.attention === 'late-payment' && mails().slice(beforeLate).length === 1);

    // The RFQ queue: the quote that was changed after it was sent.
    await ownerPage.goto(`${BASE}/admin`);
    await ownerPage.getByRole('button', { name: 'RFQs' }).click();
    const row = ownerPage.locator('tr', { hasText: state.changed.email }).first();
    await row.getByRole('button', { name: 'Detail' }).click();
    await ownerPage.getByTestId('needs-resend').waitFor({ timeout: 10000 });
    await ownerPage.getByTestId('needs-resend').scrollIntoViewIfNeeded();
    await shot(ownerPage, 'admin-09-rfq-changed-since-it-was-sent', { fullPage: false });
    check('the RFQ queue says the quote was changed since it was sent and has no link to copy', /The link the customer has no longer works/.test(await ownerPage.getByTestId('needs-resend').textContent()));

    // The audit trail of what was done by hand.
    const audit = fs.existsSync(path.join(DATA, 'quoting.db'));
    check('the database file is where the run put it', audit);
  });

  // ─── G ───────────────────────────────────────────────────────
  await step('G. Promotion codes switched on (the same data, the server restarted)', async () => {
    await stopServer();
    await startServer({ STRIPE_PROMOTION_CODES: 'on' });
    check('the startup log says promotion codes are ON', /promotion codes at checkout are ON/.test(fs.readFileSync(server.logFile, 'utf8')));
    const p = await checkoutWithDoubleClick(8, { shots: ['promo-01-checkout', 'promo-02-payment-page-stand-in'] });
    const s = session(p.sessionId);
    check('with the switch on, the payment page accepts promotion codes', s.allow_promotion_codes === true);
    const discount = Math.round(s.amount_total * 0.2);
    const before = mails().length;
    const paid = await stripePays(p.sessionId, { amount_total: s.amount_total - discount, total_details: { amount_discount: discount } });
    await buyer.goto(paid.success_url);
    await buyer.getByText('Payment received. Thank you.').waitFor({ timeout: 15000 });
    await shot(buyer, 'customer-order-paid-with-a-promotion-code');
    const o = await orderRow(p.orderId);
    check('a 20% code: the order is paid, with the discount and the amount collected on record', o.status === 'paid' && o.discountAmount === discount / 100 && o.amountPaid === (s.amount_total - discount) / 100 && o.total === s.amount_total / 100);
    const text = await buyer.textContent('body');
    check('the customer\'s page shows the total, what they paid and the discount', text.includes(money(s.amount_total / 100)) && text.includes(money((s.amount_total - discount) / 100)) && text.includes(`after ${money(discount / 100)} off with a promotion code`));
    const mail = mails().slice(before).find((m) => m.to === BUYER);
    check('the confirmation email says what was paid, not the full total', mail && mail.text.includes(`Total paid: ${money((s.amount_total - discount) / 100)}`) && mail.text.includes(`Promotion code (${money(discount / 100)} off)`));

    // A 100% code: nothing collected.
    const z = await checkoutWithDoubleClick(9);
    const zs = session(z.sessionId);
    const beforeZero = mails().length;
    fs.writeFileSync(sessionFile(z.sessionId), JSON.stringify({ ...zs, status: 'complete', payment_status: 'no_payment_required', amount_total: 0, total_details: { amount_discount: zs.amount_total } }, null, 1));
    await webhook('checkout.session.completed', { id: z.sessionId, object: 'checkout.session', status: 'complete', payment_status: 'no_payment_required', currency: 'usd', amount_total: 0, total_details: { amount_discount: zs.amount_total }, payment_intent: null, metadata: zs.metadata });
    const zero = await orderRow(z.orderId);
    const zeroMail = mails().slice(beforeZero);
    check('a 100% code does not release the order: it is flagged and the owner is told', zero.status === 'pending_payment' && zero.attention === 'zero-payment' && zeroMail.length === 1 && zeroMail[0].to === OWNER && /nothing was collected/.test(zeroMail[0].subject));

    await ownerPage.goto(`${BASE}/admin`);
    await ownerPage.getByTestId('promo-setting').waitFor({ timeout: 20000 });
    check('the orders tab now reads "Promotion codes at checkout: On"', (await ownerPage.getByTestId('promo-setting').textContent()) === 'On');
    await shot(ownerPage, 'admin-10-orders-promotion-codes-on');
    await openDrawer(p.orderId);
    await ownerPage.getByTestId('order-payment-panel').waitFor();
    await shot(ownerPage, 'admin-11-order-paid-with-a-promotion-code', { fullPage: false });
    check('the drawer shows the discount and the amount collected', new RegExp(`${money(discount / 100).replace('$', '\\$')} off`).test(await ownerPage.getByTestId('order-payment-panel').textContent()));
    await openDrawer(z.orderId);
    await ownerPage.getByTestId('attention-banner').waitFor();
    await shot(ownerPage, 'admin-12-order-nothing-collected', { fullPage: false });
    check('the drawer for the 100% code says nothing was collected and what the choices are', /Needs attention: nothing was collected/.test(await ownerPage.getByTestId('attention-banner').textContent()));
  });

  await ownerCtx.close();
  await buyerCtx.close();
}

// ══════════════════════════════════════════════════════════════
try {
  browser = await chromium.launch();
  await main();
  const log = serverLog();
  check('no secret of this run is in the server log', !Object.values(SECRETS).some((s) => log.includes(s)));
  check('no firm-quote link is in the server log', !/firm-quote\/eyJ[A-Za-z0-9_-]{20,}/.test(log));
  check('no page raised a console error or an uncaught exception', consoleProblems.length === 0, consoleProblems.slice(0, 6).join(' | '));
  check('no Content-Security-Policy violation on any page of ours, under the real policy (no bypass)', cspViolations.length === 0, cspViolations.slice(0, 6).map((v) => `${v.page} ${v.directive} ${v.blocked}`).join(' | '));
} catch (err) {
  check('run completed', false, err.stack || err.message);
} finally {
  await stopServer().catch(() => {});
  await browser?.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
const summary = { ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
fs.writeFileSync(path.join(SCRATCH, 'order-lifecycle-results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
