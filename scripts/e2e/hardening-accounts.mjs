#!/usr/bin/env node
/**
 * Browser run for the account hardening work (2026-11-11), against a
 * production-mode server it starts itself.
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost \
 *   node scripts/e2e/hardening-accounts.mjs --scratch <dir> [--shots docs/screenshots/hardening-2026-11-11]
 *
 * What it drives, in a real Chromium at 1360 px:
 *   A  register → email confirmation required at checkout → confirm → pay
 *   B  both request forms with the bot check passed (emails sent, address shown)
 *   C  the Turnstile script blocked (clear message, nothing sent)
 *   D  password reset, end to end
 *   E  sign-in pause after five wrong passwords, and unlocking by reset
 *   F  admin: two-step sign-in is required — the enrolment screen is the only admin
 *      screen until it is on; then sign-in with a code, and with a recovery code
 *   G  a guest and a second customer refused on every account-scoped route
 *   H  a second server with NO Turnstile keys: request forms taken as
 *      unverified senders (no buyer email, no ship-to address), and the pages
 *      say exactly that
 *   I  a page on another site tries to act as a signed-in visitor, and a hostile
 *      note is opened in the admin queue: nothing happens
 *
 * Every page runs under the server's real Content-Security-Policy (no bypass),
 * and any violation fails the run.
 *
 * Outside calls are stubbed in the server process by stub-network.cjs
 * (Turnstile siteverify, Resend, Stripe) and, in the browser, Cloudflare's
 * widget script is replaced by a stand-in that issues test tokens (it is served
 * for the real URL, so the policy's allowance for that host is what lets it
 * run, and it opens a frame on that host as the real widget does). Every key,
 * secret, password and code is made at run time. Emails are read from
 * EMAIL_OUTBOX_DIR, which the server honours only with SE_TEST_HOOKS=1.
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

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SCRATCH = path.resolve(arg('scratch', ''));
if (!arg('scratch', '')) { console.error('--scratch <dir> is required (outbox, server logs)'); process.exit(2); }
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/screenshots/hardening-2026-11-11'));
const PORT = 3091;
const BASE = `http://localhost:${PORT}`;
const OUTBOX = path.join(SCRATCH, 'outbox');
const OWNER = 'owner@straightedge.test';
const CUBE = path.join(ROOT, 'tools', 'vet-quotes', 'parts', 'cube_20mm.stl');
const newPassword = () => `Qz8-${crypto.randomBytes(9).toString('base64url')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

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
async function startServer({ turnstile }) {
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
    SE_TEST_HOOKS: '1', // the outbox is written only with the explicit test switch
  };
  delete env.TURNSTILE_SITE_KEY; delete env.TURNSTILE_SECRET_KEY; delete env.ADMIN_RECOVERY;
  if (turnstile) {
    env.TURNSTILE_SITE_KEY = `e2e-site-${crypto.randomBytes(6).toString('hex')}`;
    env.TURNSTILE_SECRET_KEY = `e2e-secret-${crypto.randomBytes(12).toString('hex')}`;
  }
  const logFile = path.join(SCRATCH, `server-${turnstile ? 'keys' : 'nokeys'}.log`);
  const log = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'scripts', 'e2e', 'stub-network.cjs'), path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  server = { child, logFile, secrets: [env.TURNSTILE_SECRET_KEY, env.JWT_SECRET, env.STRIPE_WEBHOOK_SECRET].filter(Boolean) };
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
// Stand-in for Cloudflare's widget script (the sandbox cannot reach the real one): scripts/e2e/turnstile-standin.cjs
const { routeStandIn } = require(path.join(ROOT, 'scripts', 'e2e', 'turnstile-standin.cjs'));

let browser;
let visitor = 0;
const consoleProblems = [];
const cspViolations = [];
async function newContext({ turnstileScript = 'stub' } = {}) {
  // No bypassCSP: every page runs under the policy the server sends.
  // Each browser context is its own visitor, with its own address (the server trusts one proxy hop in production).
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': `203.0.113.${++visitor}` } });
  await context.exposeBinding('__cspReport', (source, v) => { cspViolations.push(v); });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspReport({ page: location.pathname, directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample || '' });
    });
  });
  if (turnstileScript === 'stub') {
    await routeStandIn(context);
  } else if (turnstileScript === 'blocked') {
    await context.route('https://challenges.cloudflare.com/**', (route) => route.abort('blockedbyclient'));
  }
  context.on('page', (page) => {
    page.on('console', (m) => {
      if (/Content Security Policy|Content-Security-Policy|violates the following/i.test(m.text())) { cspViolations.push({ page: page.url(), directive: 'console', blocked: m.text().slice(0, 200) }); return; }
      if (m.type() === 'error' && !/challenges\.cloudflare\.com|Failed to load resource/.test(m.text())) consoleProblems.push(`${page.url()} :: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleProblems.push(`${page.url()} :: pageerror ${e.message}`));
  });
  return context;
}
const shot = async (page, name, opts = {}) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: opts.fullPage !== false }); };

async function signIn(page, email, password, { next } = {}) {
  await page.goto(`${BASE}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function registerVia(page, { name, email, password, next }) {
  await page.goto(`${BASE}/register${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
}
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
    return { status: res.status, text: text.slice(0, 400) };
  }, { method, url, body });
}

// ══════════════════════════════════════════════════════════════
const state = {};

async function phaseWithKeys() {
  await startServer({ turnstile: true });
  const log = () => fs.readFileSync(server.logFile, 'utf8');
  check('server (keys set) starts with no bot-check warning', !/BOT CHECK IS OFF/.test(log()));

  // ─── A ───────────────────────────────────────────────────────
  const buyerCtx = await newContext();
  const buyer = await buyerCtx.newPage();
  const buyerEmail = 'dana@buyer.test';
  let buyerPw = newPassword();

  await step('A. Register → confirm email → quote → checkout', async () => {
    await buyer.goto(`${BASE}/quote`);
    const cfg = await buyer.evaluate(() => fetch('/api/public/config').then((r) => r.json()));
    check('the site key comes from /api/public/config, not the bundle', cfg.botCheck === true && cfg.turnstileSiteKey.startsWith('e2e-site-'));
    const scripts = await buyer.evaluate(() => [...document.scripts].map((s) => s.src));
    check('the quote page has not loaded the Turnstile script before it is needed', !scripts.some((s) => s.includes('challenges.cloudflare.com')));

    await buyer.evaluate(() => { window.__turnstileDelay = 2500; });
    await buyer.locator('input[type=file]').first().setInputFiles(CUBE);
    const dialog = buyer.getByRole('dialog', { name: 'One quick check' });
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    check('first upload opens the one-time check as a labelled dialog', await dialog.isVisible());
    await shot(buyer, 'quote-human-check', { fullPage: false });
    await dialog.waitFor({ state: 'hidden', timeout: 15000 });
    await buyer.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 30000 });
    check('after the check the part is read and priced', true);
    const human = await buyer.evaluate(() => JSON.parse(sessionStorage.getItem('straightedge.human') || 'null'));
    check('a verified-human token is held for about an hour (not a login)', Boolean(human && human.token && human.expires - Date.now() > 50 * 60e3));
    await buyer.evaluate(() => { window.__turnstileDelay = 350; });

    // Guest → checkout → sign-in page → create an account.
    await buyer.getByRole('button', { name: /Check out/ }).click();
    await buyer.waitForURL(/\/login\?next=/);
    await buyer.getByRole('link', { name: 'Create one' }).click();
    await buyer.waitForURL(/\/register\?next=/);
    await buyer.getByLabel('Name').fill('Dana Buyer');
    await buyer.getByLabel('Email').fill(buyerEmail);
    await buyer.getByLabel('Password').fill('Password12');
    await buyer.getByText('Success! (test stand-in)').waitFor();
    await shot(buyer, 'register', { fullPage: false });
    await buyer.getByRole('button', { name: 'Create account' }).click();
    await buyer.getByRole('alert').filter({ hasText: 'most-used passwords' }).waitFor();
    check('a common password is refused with a reason', true);
    await buyer.getByLabel('Password').fill(buyerPw);
    await buyer.getByText('Success! (test stand-in)').waitFor();
    await buyer.getByRole('button', { name: 'Create account' }).click();
    await buyer.waitForURL(/\/checkout\//, { timeout: 20000 });
    state.buyerQuote = buyer.url().split('/checkout/')[1].split('?')[0];

    // Session: cookie only.
    const cookies = await buyerCtx.cookies(BASE);
    const sc = cookies.find((c) => c.name.endsWith('se_session'));
    check('the session is an httpOnly, Secure, SameSite=Strict, host-locked cookie', Boolean(sc && sc.httpOnly && sc.secure && sc.sameSite === 'Strict' && sc.name === '__Host-se_session'), JSON.stringify(sc && { n: sc.name, h: sc.httpOnly, s: sc.secure, ss: sc.sameSite }));
    const storage = await buyer.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify(Object.keys(sessionStorage)));
    check('no session token in localStorage or sessionStorage', !/authToken|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}"[,}]/.test(storage.replace(/"straightedge\.human":"[^"]*(\\"[^"]*)*"/, '')) && !storage.includes('authToken'));

    // Checkout is held for the unconfirmed address.
    const notice = buyer.getByRole('region', { name: 'Confirm your email address' });
    await notice.waitFor();
    const pay = buyer.getByRole('button', { name: /Pay & Place Order/ });
    check('checkout explains that the email must be confirmed, and the pay button is off', (await notice.textContent()).includes(buyerEmail) && await pay.isDisabled());
    await buyer.getByLabel('Full Name').fill('Dana Buyer');
    await buyer.getByLabel('Street Address').fill('100 Main St');
    await buyer.getByLabel('City').fill('Elgin');
    await buyer.getByLabel('State').fill('IL');
    await buyer.getByLabel('ZIP Code').fill('60120');
    await shot(buyer, 'checkout-confirm-email', { fullPage: false });
    const direct = await apiFrom(buyer, 'POST', '/api/orders/checkout-session', { quoteId: state.buyerQuote, shippingName: 'Dana Buyer', shippingAddress: '100 Main St', shippingCity: 'Elgin', shippingState: 'IL', shippingZip: '60120' });
    check('the server refuses checkout for the unconfirmed account whatever the page does', direct.status === 403 && /email-unverified/.test(direct.text), `${direct.status} ${direct.text}`);

    const first = await waitMail(buyerEmail, /confirm your email/);
    check('a confirmation email went to the new address', Boolean(linkIn(first, 'verify-email')));
    await buyer.getByRole('button', { name: 'Send the link again' }).click();
    await buyer.getByText(/Sent again to/).waitFor();
    const second = await waitMail(buyerEmail, /confirm your email/, { after: 1 });
    check('"Send the link again" sends a second email', Boolean(second));
    await buyer.getByRole('button', { name: 'Send the link again' }).click();
    await buyer.getByText(/We just sent one/).waitFor();
    check('a second resend inside a minute is refused politely', true);

    // The link opened where nobody is signed in: a button, no automatic confirmation.
    const strangerCtx = await newContext();
    const stranger = await strangerCtx.newPage();
    await stranger.goto(linkIn(first, 'verify-email'));
    await stranger.getByRole('button', { name: 'Confirm my email' }).waitFor();
    check('the token is taken out of the address bar on arrival', !stranger.url().includes('token='));
    await shot(stranger, 'verify-email-button', { fullPage: false });
    const stillHeld = await apiFrom(buyer, 'GET', '/api/auth/session');
    check('opening the link without pressing the button confirms nothing', /"emailVerified":false/.test(stillHeld.text));
    await strangerCtx.close();

    // The link opened in the browser that registered: confirmed at once.
    const tab = await buyerCtx.newPage();
    await tab.goto(linkIn(second, 'verify-email'));
    await tab.getByText('is confirmed').waitFor({ timeout: 10000 });
    await shot(tab, 'verify-email-confirmed', { fullPage: false });
    await tab.close();

    // The checkout tab notices by itself.
    await notice.waitFor({ state: 'hidden', timeout: 15000 });
    check('the checkout page notices the confirmation without a reload, with the typed address intact', await pay.isEnabled() && (await buyer.getByLabel('Street Address').inputValue()) === '100 Main St');
    await pay.click();
    await buyer.waitForURL(/\/orders\/[0-9a-f-]+\?paid=true/, { timeout: 20000 });
    state.buyerOrder = buyer.url().match(/\/orders\/([0-9a-f-]+)/)[1];
    await buyer.getByRole('heading', { name: /^Order [0-9A-F]{8}$/ }).waitFor();
    const order = await apiFrom(buyer, 'GET', `/api/orders/${state.buyerOrder}`);
    check('the order is paid (Stripe stubbed at the boundary) and confirmed by email', /"status":"paid"/.test(order.text) && mailsTo(buyerEmail, /confirmed/).length === 1);
    await shot(buyer, 'order-paid', { fullPage: false });
    // Arriving from another site (as the return from Stripe does): with a SameSite=Strict
    // cookie the page itself loads without the session, then its own requests carry it.
    const cross = await buyerCtx.newPage();
    await cross.goto(`http://127.0.0.1:${PORT}/about`);
    await cross.evaluate((url) => { const a = document.createElement('a'); a.href = url; a.id = 'back-to-order'; a.textContent = 'Return to merchant'; document.body.prepend(a); }, `${BASE}/orders/${state.buyerOrder}?paid=true`);
    await cross.locator('#back-to-order').click();
    await cross.getByRole('heading', { name: /^Order [0-9A-F]{8}$/ }).waitFor({ timeout: 15000 });
    check('a cross-site return to the order page (the Stripe return path) still shows the signed-in order', (await cross.textContent('body')).includes('100 Main St'));
    await cross.close();
    // One link, one use.
    const again = await fetch(`${BASE}/api/auth/verify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: linkIn(second, 'verify-email').split('#token=')[1] }) }).then((r) => r.json());
    check('the confirmation link does nothing a second time', again.already === true);
  });

  // ─── B ───────────────────────────────────────────────────────
  await step('B. Request forms with the bot check passed', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/rfq`);
    check('the prerendered form carries one honeypot field', await page.locator('.hp-field input[name=website]').count() === 1);
    const hp = await page.locator('.hp-field input').evaluate((el) => ({ tab: el.tabIndex, hidden: el.closest('[aria-hidden=true]') !== null, box: el.getBoundingClientRect().left }));
    check('the honeypot is out of the tab order, hidden from screen readers and off screen', hp.tab === -1 && hp.hidden && hp.box < -1000);
    await page.getByLabel(/^Name/).fill('Pat Purchasing');
    await page.getByLabel(/^Email/).fill('pat@oem.test');
    await page.getByLabel('Company').fill('OEM Co');
    await page.getByLabel('Quantities to quote').fill('250 / 500');
    await page.getByRole('textbox', { name: 'Anything else' }).fill('Runs on a stainless rail.');
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Send for a firm quote' }).scrollIntoViewIfNeeded();
    await shot(page, 'rfq-form-with-check', { fullPage: false });
    const before = mails().length;
    await page.getByRole('button', { name: 'Send for a firm quote' }).click();
    await page.getByRole('heading', { name: "It's in the queue." }).waitFor({ timeout: 15000 });
    check('firm-quote form: accepted, and the page says a confirmation email is on its way', (await page.textContent('body')).includes('A confirmation email is on its way'));
    await waitMail('pat@oem.test', /we have your quote request/);
    const shop = await waitMail(OWNER, /^RFQ:/);
    check('firm-quote form: buyer and shop were both emailed; the shop subject carries no typed text', mails().length === before + 2 && /^RFQ: [0-9A-F]{8} — \? part\(s\)$/.test(shop.subject) && shop.replyTo === 'pat@oem.test', shop.subject);
    await shot(page, 'rfq-sent-confirmed', { fullPage: false });

    await page.goto(`${BASE}/rfq?nocad=1`);
    await page.getByLabel(/^Name/).fill('Sam Maint');
    await page.getByLabel(/^Email/).fill('sam@plant.test');
    await page.getByLabel(/What the part is and what it does/).fill('Carton guide on the sealer infeed. Worn on the leading edge.');
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Send the request' }).click();
    await page.getByRole('heading', { name: 'Now send us the part.' }).waitFor({ timeout: 15000 });
    const body = await page.textContent('body');
    const partMail = await waitMail('sam@plant.test', /send us the part/);
    const shipFrom = require(path.join(ROOT, 'server', 'config', 'shipFrom.json'));
    check('send-the-part form: the ship-to address is on the screen and in the buyer email after the check passed', body.includes(shipFrom.zip) && partMail.text.includes(shipFrom.zip));
    // The ship-to address is not for publication: it is covered in the saved image.
    await page.screenshot({ path: path.join(SHOTS, 'part-request-verified.png'), fullPage: false, mask: [page.locator('dl.ship-part dd').nth(1)], maskColor: '#101C33' });
    await ctx.close();
  });

  // ─── C ───────────────────────────────────────────────────────
  await step('C. The Turnstile script is blocked', async () => {
    const ctx = await newContext({ turnstileScript: 'blocked' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/rfq`);
    const problem = page.getByRole('group', { name: 'Spam check' }).getByRole('alert');
    await problem.waitFor({ timeout: 20000 });
    const text = await problem.textContent();
    check('a clear message says what is blocked and gives the phone and email', /didn't load/.test(text) && text.includes('224-213-6727') && text.includes('quotes@straightedgemfg.com'), text);
    await page.getByLabel(/^Name/).fill('Blocked Visitor');
    await page.getByLabel(/^Email/).fill('blocked@visitor.test');
    const before = mails().length;
    await page.getByRole('button', { name: 'Send for a firm quote' }).click();
    await page.locator('form#request > [role=alert]').filter({ hasText: "didn't load" }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Send for a firm quote' }).scrollIntoViewIfNeeded();
    await shot(page, 'rfq-check-blocked', { fullPage: false });
    await sleep(500);
    check('with the check blocked nothing is sent and nobody is emailed', mails().length === before);
    // The same on the page that needs it for registration.
    await page.goto(`${BASE}/register`);
    await page.getByRole('group', { name: 'Spam check' }).getByRole('alert').waitFor({ timeout: 20000 });
    check('the register page shows the same message', true);
    // Pages that do not need the check never ask for the script.
    const asked = [];
    page.on('request', (r) => { if (r.url().includes('challenges.cloudflare.com')) asked.push(r.url()); });
    for (const p of ['/', '/materials', '/about', '/login', '/quote', '/replacement-parts']) { await page.goto(`${BASE}${p}`); await sleep(400); }
    check('home, materials, about, sign-in, the quote page before an upload and replacement parts never request the Turnstile script', asked.length === 0, asked.join(', '));
    await ctx.close();
  });

  // ─── D ───────────────────────────────────────────────────────
  await step('D. Password reset, end to end', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForURL(/\/forgot-password/);
    await page.getByRole('heading', { name: 'Reset your password' }).waitFor();
    await page.getByLabel('Email').fill(buyerEmail);
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await shot(page, 'forgot-password', { fullPage: false });
    await page.getByRole('button', { name: 'Send the reset link' }).click();
    await page.getByText('is on its way').waitFor({ timeout: 15000 });
    await shot(page, 'forgot-password-sent', { fullPage: false });
    const known = await page.locator('.auth-ok').textContent();
    const mail = await waitMail(buyerEmail, /reset your password/);

    // The same page, an address with no account: the same words, no email.
    const count = mails().length;
    await page.goto(`${BASE}/forgot-password`);
    await page.getByLabel('Email').fill('nobody@nowhere.test');
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Send the reset link' }).click();
    await page.getByText('is on its way').waitFor({ timeout: 15000 });
    const unknown = await page.locator('.auth-ok').textContent();
    await sleep(500);
    check('an unknown address gets the same answer and no email', unknown.replace('nobody@nowhere.test', 'X') === known.replace(buyerEmail, 'X') && mails().length === count);

    await page.goto(linkIn(mail, 'reset-password'));
    await page.getByLabel('New password', { exact: true }).waitFor();
    check('the reset token is taken out of the address bar', !page.url().includes('token='));
    const next = newPassword();
    await page.getByLabel('New password', { exact: true }).fill(next);
    await page.getByLabel('New password, again').fill(next);
    await shot(page, 'reset-password', { fullPage: false });
    const stillIn = await apiFrom(buyer, 'GET', '/api/orders');
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await page.getByText('Your password is changed').waitFor({ timeout: 15000 });
    await shot(page, 'reset-password-done', { fullPage: false });
    const afterReset = await apiFrom(buyer, 'GET', '/api/orders');
    check('the browser that was signed in before the change is signed out by it', stillIn.status === 200 && afterReset.status === 401, `${stillIn.status} → ${afterReset.status}`);
    await waitMail(buyerEmail, /password was changed/);
    check('a "password was changed" email was sent', true);

    // The link is spent. (Opened afresh, as a click in the email would: a new document, not a change of #fragment.)
    await page.goto('about:blank');
    await page.goto(linkIn(mail, 'reset-password'));
    await page.getByText('has been used').waitFor({ timeout: 10000 });
    check('the reset link cannot be used twice', true);

    await signIn(page, buyerEmail, buyerPw);
    await page.getByRole('alert').filter({ hasText: "didn't match" }).waitFor();
    check('the old password no longer signs in', true);
    await signIn(page, buyerEmail, next);
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    check('the new password signs in', true);
    buyerPw = next;
    await ctx.close();
  });

  // ─── E ───────────────────────────────────────────────────────
  await step('E. Sign-in pause after five wrong passwords, and unlocking', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    const requested = [];
    page.on('request', (r) => { if (r.url().includes('challenges.cloudflare.com')) requested.push(r.url()); });
    await page.getByLabel('Email').fill(buyerEmail);
    const attempt = async () => {
      await page.getByLabel('Password').fill(`Wrong-${crypto.randomBytes(4).toString('hex')}-1A`);
      if (await page.getByRole('group', { name: 'Spam check' }).count()) await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
      await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/api/auth/login')),
        page.getByRole('button', { name: 'Sign in' }).click(),
      ]);
      await page.getByRole('button', { name: 'Sign in' }).waitFor({ state: 'visible' });
      await sleep(300);
    };
    await attempt(); await attempt();
    check('no spam check on the sign-in page for the first two wrong passwords', requested.length === 0 && await page.getByRole('group', { name: 'Spam check' }).count() === 0);
    await attempt();
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor({ timeout: 10000 });
    check('after the third wrong password the spam check appears on the sign-in page', requested.length > 0);
    await shot(page, 'login-challenge', { fullPage: false });
    await attempt(); await attempt();
    // Sixth try, with the right password: paused.
    await page.getByLabel('Password').fill(buyerPw);
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: 'paused for 15 minutes' }).waitFor({ timeout: 10000 });
    check('after five wrong passwords even the right one is refused, with the wait and the way out stated', true);
    await shot(page, 'login-paused', { fullPage: false });
    const lockMail = await waitMail(buyerEmail, /sign-in paused/);
    check('the account owner is emailed about the pause', /Nobody got in/.test(lockMail.text) && lockMail.text.includes(`${BASE}/forgot-password`));

    // An address with no account behaves the same.
    const ghost = await newContext();
    const g = await ghost.newPage();
    const answers = [];
    for (let i = 0; i < 6; i++) {
      const r = await g.request.post(`${BASE}/api/auth/login`, { data: { email: 'ghost@nowhere.test', password: 'Wrong-password-1' }, headers: { 'X-Turnstile-Token': 'e2e-pass-ghost' } });
      answers.push(r.status());
    }
    check('an address with no account is paused in exactly the same way', answers.join(',') === '401,401,401,401,401,429', answers.join(','));
    await ghost.close();

    // Unlock: the link in the email → reset → sign in at once.
    const before = mailsTo(buyerEmail, /reset your password/).length;
    await page.goto(`${BASE}/forgot-password`);
    await page.getByLabel('Email').fill(buyerEmail);
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Send the reset link' }).click();
    await page.getByText('is on its way').waitFor({ timeout: 15000 });
    const mail = await waitMail(buyerEmail, /reset your password/, { after: before });
    await page.goto(linkIn(mail, 'reset-password'));
    const next = newPassword();
    await page.getByLabel('New password', { exact: true }).fill(next);
    await page.getByLabel('New password, again').fill(next);
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await page.getByText('Your password is changed').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Sign in with the new password' }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    await page.getByLabel('Email').fill(buyerEmail);
    await page.getByLabel('Password').fill(next);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // This browser made five wrong guesses a moment ago, so the spam check is still part of signing in from it.
    await page.getByRole('status').filter({ hasText: 'One quick check first' }).waitFor({ timeout: 10000 });
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await shot(page, 'login-check-after-reset', { fullPage: false });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    check('choosing a new password lifts the pause at once (the spam check still applies to the connection that guessed)', true);
    buyerPw = next;
    state.buyerCtx = ctx; state.buyerPage = page;
  });

  // ─── F ───────────────────────────────────────────────────────
  const ownerPw = newPassword();
  await step('F. Admin: two-step enrolment, sign-in with a code, sign-in with a recovery code', async () => {
    const ctx = await newContext();
    const page = await ctx.newPage();
    await registerVia(page, { name: 'Owner', email: OWNER, password: ownerPw });
    await page.getByText('Success! (test stand-in)').waitFor();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/\/quote/, { timeout: 20000 });
    const asCustomer = await apiFrom(page, 'GET', '/api/admin/stats');
    check('registering the ADMIN_EMAIL address does not give the admin role', asCustomer.status === 403);
    await page.goto(`${BASE}/admin`);
    await page.waitForURL(/\/dashboard/);
    check('the unconfirmed owner account is sent to the customer dashboard, not the admin area', true);
    const mail = await waitMail(OWNER, /confirm your email/);
    await page.goto(linkIn(mail, 'verify-email'));
    await page.getByText('is confirmed').waitFor({ timeout: 10000 });
    await page.goto(`${BASE}/admin`);
    const gate = page.getByTestId('enrolment-gate');
    await gate.waitFor({ timeout: 15000 });
    const banner = page.getByTestId('twofactor-banner');
    const session = await page.evaluate(() => fetch('/api/auth/session').then((r) => r.json()));
    check('once its email is confirmed the account is the admin, and must set up two-step sign-in', session.user.role === 'admin' && session.user.twoFactorRequired === true && /Set up two-step sign-in to open the admin pages/.test(await banner.textContent()));
    // The enrolment screen is the only admin screen: no tabs, no numbers, nothing loaded.
    const gateText = await gate.textContent();
    check('until then the admin page shows the enrolment screen and nothing else', await page.getByRole('button', { name: 'RFQs' }).count() === 0 && await page.getByRole('button', { name: 'Pricing' }).count() === 0 && !/Total Orders|Paid Revenue/.test(gateText) && await page.getByLabel('Your password, to start').count() === 1);
    const shut = [];
    for (const [method, url, body] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/quotes'], ['GET', '/api/admin/parts'], ['GET', '/api/admin/materials'], ['GET', '/api/admin/pricing'], ['PUT', '/api/admin/pricing', { rules: {}, note: 'x' }], ['GET', '/api/admin/backup/db'], ['GET', '/api/admin/backup/json'], ['GET', '/api/rfq/admin/list'], ['GET', '/api/orders/admin/queue'], ['GET', '/api/pdf/fai']]) {
      const r = await apiFrom(page, method, url, body);
      if (r.status !== 403 || !/two-factor-enrolment-required/.test(r.text) || /SQLite format|%PDF/.test(r.text)) shut.push(`${method} ${url} → ${r.status}`);
    }
    check('every other admin route answers 403 two-factor-enrolment-required to the unenrolled admin', shut.length === 0, shut.join('; '));
    check('the enrolment endpoints do answer', (await apiFrom(page, 'GET', '/api/auth/2fa')).status === 200);
    await sleep(300);
    await shot(page, 'admin-2fa-banner', { fullPage: false });

    await page.getByLabel('Your password, to start').fill(ownerPw);
    await page.getByRole('button', { name: 'Set up two-step sign-in' }).click();
    await page.getByTestId('twofactor-setup').waitFor({ timeout: 15000 });
    const setupKey = (await page.getByTestId('setup-key').textContent()).replace(/\s/g, '');
    const qr = await page.getByRole('img', { name: 'QR code for your authenticator app' }).evaluate((el) => ({ tag: el.tagName, paths: el.querySelectorAll('path').length, external: [...el.querySelectorAll('*')].some((n) => n.getAttribute('href') || n.getAttribute('src')) }));
    check('the QR code is drawn in the page as an SVG, with no image fetched from anywhere', qr.tag === 'svg' && qr.paths === 1 && !qr.external && /^[A-Z2-7]{32}$/.test(setupKey));
    await shot(page, 'admin-2fa-setup', { fullPage: false });
    await page.getByLabel('6-digit code from the app').fill('000000');
    await page.getByRole('button', { name: 'Switch it on' }).click();
    await page.getByRole('alert').filter({ hasText: "didn't match" }).waitFor();
    check('a wrong code does not switch it on', true);
    await page.getByLabel('6-digit code from the app').fill(totp.codeAt(setupKey));
    await page.getByRole('button', { name: 'Switch it on' }).click();
    const codesBox = page.getByTestId('recovery-codes');
    await codesBox.waitFor({ timeout: 15000 });
    const codes = await codesBox.locator('li').allTextContents();
    check('ten recovery codes are shown once', codes.length === 10 && new Set(codes).size === 10 && codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)));
    await shot(page, 'admin-2fa-recovery-codes', { fullPage: false });
    check('the admin pages stay closed until the codes are saved', await page.getByRole('button', { name: 'RFQs' }).count() === 0);
    await page.getByRole('button', { name: 'I have saved them' }).click();
    // Enrolled: the admin pages open.
    await page.getByRole('button', { name: 'Security' }).waitFor({ timeout: 15000 });
    check('with two-step sign-in on, the admin pages open and the admin routes answer', await page.getByTestId('enrolment-gate').count() === 0 && (await apiFrom(page, 'GET', '/api/admin/stats')).status === 200 && /Total Orders/.test(await page.textContent('body')));
    await page.getByRole('button', { name: 'Security' }).click();
    await page.getByTestId('twofactor-status').filter({ hasText: 'On' }).waitFor();
    check('the status reads On, 10 codes left, and the banner is gone', (await page.getByTestId('codes-left').textContent()) === '10' && await page.getByTestId('twofactor-banner').count() === 0);
    await shot(page, 'admin-2fa-on', { fullPage: false });
    const status = await apiFrom(page, 'GET', '/api/auth/2fa');
    check('the server never returns the secret again', !status.text.includes(setupKey) && !/secret|otpauth/i.test(status.text));

    // Sign out (server-side), then in again with a code.
    const cookieBefore = (await ctx.cookies(BASE)).find((c) => c.name.endsWith('se_session')).value;
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.waitForURL(`${BASE}/`);
    const replay = await fetch(`${BASE}/api/admin/stats`, { headers: { Cookie: `__Host-se_session=${cookieBefore}` } });
    const replayBearer = await fetch(`${BASE}/api/admin/stats`, { headers: { Authorization: `Bearer ${cookieBefore}` } });
    check('after Sign out the old session token is dead on the server, not just gone from the browser', replay.status === 401 && replayBearer.status === 401, `${replay.status}/${replayBearer.status}`);

    await signIn(page, OWNER, ownerPw);
    await page.getByLabel('Code from your authenticator app').waitFor({ timeout: 10000 });
    check('with the right password the page asks for the code, and no session exists yet', !(await ctx.cookies(BASE)).some((c) => c.name.endsWith('se_session') && c.value));
    await shot(page, 'login-2fa-code', { fullPage: false });
    await page.getByLabel('Code from your authenticator app').fill('000000');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: "didn't match" }).waitFor();
    // The enrolment code cannot be replayed: wait for the next 30-second step.
    const enrolStep = totp.stepAt();
    while (totp.stepAt() <= enrolStep) await sleep(500);
    await page.getByLabel('Code from your authenticator app').fill(totp.codeAt(setupKey));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    await page.goto(`${BASE}/admin`);
    await page.getByRole('button', { name: 'Security' }).waitFor({ timeout: 15000 });
    const adminCookie = (await ctx.cookies(BASE)).find((c) => c.name.endsWith('se_session'));
    const hours = (adminCookie.expires - Date.now() / 1000) / 3600;
    check('signed in with password + code; the admin session lasts 4 hours (customers: 24)', (await apiFrom(page, 'GET', '/api/admin/stats')).status === 200 && hours > 3.9 && hours <= 4.01, `expires in ${hours.toFixed(2)} h`);

    // Sign out, then in again with a recovery code.
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.waitForURL(`${BASE}/`);
    await signIn(page, OWNER, ownerPw);
    await page.getByLabel('Code from your authenticator app').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'No phone? Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(codes[3]);
    await shot(page, 'login-recovery-code', { fullPage: false });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/quote/, { timeout: 15000 });
    await page.goto(`${BASE}/admin`);
    await page.getByRole('button', { name: 'Security' }).click();
    await page.getByTestId('codes-left').waitFor();
    check('a recovery code signs in, is spent (9 left), and the owner is emailed', (await page.getByTestId('codes-left').textContent()) === '9' && mailsTo(OWNER, /recovery code was used/).length === 1);
    const reuse = await page.request.post(`${BASE}/api/auth/login`, { data: { email: OWNER, password: ownerPw, recoveryCode: codes[3] } });
    check('the same recovery code does not work twice', reuse.status() === 401);
    state.ownerCtx = ctx; state.ownerPage = page; state.setupKey = setupKey;
  });

  // ─── G ───────────────────────────────────────────────────────
  await step('G. A guest and a second customer are refused on every account-scoped route', async () => {
    const owner = state.ownerPage;
    // What Dana owns: an order (with its quote), and a request made while signed in.
    const dana = state.buyerPage;
    await dana.goto(`${BASE}/rfq`);
    await dana.getByLabel('Quantities to quote').fill('40');
    await dana.getByRole('heading', { name: /Tell us what matters/ }).waitFor();
    await dana.getByRole('textbox', { name: 'Anything else' }).fill('Signed-in request.');
    await dana.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await dana.getByRole('button', { name: 'Send for a firm quote' }).click();
    await dana.getByRole('heading', { name: "It's in the queue." }).waitFor({ timeout: 15000 });
    const list = JSON.parse((await owner.evaluate(() => fetch('/api/rfq/admin/list').then((r) => r.text()))));
    const danaRfq = list.find((r) => r.email === 'dana@buyer.test').id;
    const anonRfq = list.find((r) => r.email === 'pat@oem.test').id;
    const orders = JSON.parse(await owner.evaluate(() => fetch('/api/orders').then((r) => r.text())));
    const order = orders.find((o) => o.id === state.buyerOrder);
    const partId = order.items[0].partId;
    const quoteId = order.quoteId;

    // A second customer.
    const bobCtx = await newContext();
    const bob = await bobCtx.newPage();
    const bobPw = newPassword();
    await registerVia(bob, { name: 'Bob Other', email: 'bob@other.test', password: bobPw });
    await bob.getByText('Success! (test stand-in)').waitFor();
    await bob.getByRole('button', { name: 'Create account' }).click();
    await bob.waitForURL(/\/quote/, { timeout: 20000 });
    await bob.goto(linkIn(await waitMail('bob@other.test', /confirm your email/), 'verify-email'));
    await bob.getByText('is confirmed').waitFor({ timeout: 10000 });

    const guestCtx = await newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(`${BASE}/`);

    const routes = [
      ['GET', `/api/orders/${order.id}`, [401, 403]],
      ['GET', `/api/orders/${order.id}/drawing`, [401, 403]],
      ['POST', `/api/orders/${order.id}/reorder`, [401, 403]],
      ['POST', `/api/orders/${order.id}/confirm-payment`, [401, 403]],
      ['GET', `/api/orders/${order.id}/traveler`, [401, 403]],
      ['PUT', `/api/orders/${order.id}/status`, [401, 403]],
      ['GET', `/api/quote/${quoteId}`, [404]],
      ['GET', `/api/quote/${quoteId}/session`, [404]],
      ['DELETE', `/api/quote/${quoteId}/drawing`, [404]],
      ['POST', '/api/orders/checkout-session', [401, 403], { quoteId }],
      ['GET', `/api/rfq/${danaRfq}`, [404]],
      ['GET', '/api/rfq/admin/list', [401, 403]],
      ['PUT', `/api/rfq/admin/${danaRfq}`, [401, 403], { status: 'quoted', quotedTotal: 1, quotedLeadDays: 1 }],
      ['GET', `/api/rfq/admin/${danaRfq}/drawing`, [401, 403]],
      ['GET', `/api/parts/${partId}/download`, [401, 403]],
      ['POST', `/api/parts/${partId}/units`, [403, 404], { units: 'in' }],
      ['GET', `/api/pdf/traveler/${order.id}`, [401, 403]],
      ['GET', `/api/pdf/order-confirmation/${order.id}`, [401, 403]],
      ['GET', `/api/pdf/packing-slip/${order.id}`, [401, 403]],
      ['GET', `/api/pdf/coc/${order.id}`, [401, 403]],
      ['GET', `/api/pdf/quote/${quoteId}`, [401, 403]],
      ['GET', `/api/pdf/rfq-response/${danaRfq}`, [401, 403]],
      ['GET', '/api/admin/stats', [401, 403]],
      ['GET', '/api/admin/quotes', [401, 403]],
      ['GET', '/api/admin/parts', [401, 403]],
      ['GET', '/api/admin/backup/db', [401, 403]],
      ['GET', '/api/admin/backup/json', [401, 403]],
      ['PUT', '/api/admin/pricing', [401, 403], { rules: {}, note: 'x' }],
      ['GET', '/api/auth/2fa', [401, 403]],
      ['POST', '/api/auth/2fa/setup', [401, 403], { password: bobPw }],
    ];
    for (const [who, page] of [['a guest', guest], ['a second customer', bob]]) {
      const bad = [];
      for (const [method, url, allowed, body] of routes) {
        const r = await apiFrom(page, method, url, body);
        const leak = /dana@buyer|100 Main St|Dana Buyer|%PDF|SQLite format/.test(r.text);
        if (!allowed.includes(r.status) || leak) bad.push(`${method} ${url} → ${r.status}${leak ? ' LEAK' : ''}`);
      }
      check(`${who} is refused on all ${routes.length} account-scoped routes, and nothing of Dana's is in any answer`, bad.length === 0, bad.join('; '));
    }
    const bobOrders = await apiFrom(bob, 'GET', '/api/orders');
    check("the second customer's own order list is empty", bobOrders.status === 200 && bobOrders.text === '[]');
    const anon = await apiFrom(guest, 'GET', `/api/rfq/${anonRfq}`);
    check('a request sent without an account shows a guest its status only (no name, email or notes)', anon.status === 200 && !/pat@oem|Pat|stainless/.test(anon.text) && /"status":"new"/.test(anon.text), anon.text);

    // In the browser: Dana's order page as Bob, and as a guest.
    await bob.goto(`${BASE}/orders/${order.id}`);
    await bob.waitForLoadState('networkidle');
    const bobSees = await bob.textContent('body');
    check("the second customer opening Dana's order page sees no order data", !/100 Main St|Dana Buyer|cube_20mm/.test(bobSees));
    await shot(bob, 'order-denied-second-customer', { fullPage: false });
    await guest.goto(`${BASE}/orders/${order.id}`);
    await guest.waitForURL(/\/login\?next=/, { timeout: 10000 });
    check('a guest opening an order link is sent to sign in', true);
    await guest.goto(`${BASE}/admin`);
    await guest.waitForURL(/\/login\?next=/, { timeout: 10000 });
    await bob.goto(`${BASE}/admin`);
    await bob.waitForURL(/\/dashboard/, { timeout: 10000 });
    check('the admin area redirects a guest to sign in and a customer to their dashboard', true);

    // Cross-site request forgery: Bob's cookie without the CSRF token changes nothing.
    const forged = await bob.evaluate(() => fetch('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: 'forged' }) }).then((r) => r.status));
    check('a write with the session cookie but no CSRF token is refused', forged === 403);
    await bobCtx.close(); await guestCtx.close();
  });

  // ─── I ───────────────────────────────────────────────────────
  await step('I. Another site cannot act as a signed-in visitor; a hostile note cannot run in the admin pages', async () => {
    const owner = state.ownerPage;
    const dana = state.buyerPage;
    const before = await dana.evaluate(() => fetch('/api/auth/profile').then((r) => r.json()));
    const ordersBefore = (await apiFrom(dana, 'GET', '/api/orders')).text;
    // A page on another site, open in Dana's browser while she is signed in: a second web server on
    // this machine under another host name and port (to the browser, a different origin and a
    // different site), serving a page of its own with no policy of ours.
    const http = require('node:http');
    const evilServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Win a prize</title><h1>Win a prize</h1>'); });
    await new Promise((resolve) => evilServer.listen(0, '127.0.0.1', resolve));
    const evilOrigin = `http://127.0.0.1:${evilServer.address().port}`;
    // Dana's browser, as it is outside this harness: her cookies, and no test-only request header.
    // (The other contexts send X-Forwarded-For on every request to give each visitor an address; on a
    // cross-origin request that header alone forces a preflight, which would hide what is being tested.)
    const evilCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await evilCtx.addCookies(await state.buyerCtx.cookies(BASE));
    const own = await evilCtx.newPage();
    await own.goto(`${BASE}/about`);
    const signedIn = await own.evaluate(() => fetch('/api/auth/session').then((r) => r.json()));
    check('in this browser Dana is signed in on our own site', signedIn.authenticated === true && signedIn.user.email === 'dana@buyer.test');
    await own.close();
    const evil = await evilCtx.newPage();
    evil.on('console', () => {}); // what this page tries is supposed to fail: its console errors are the browser saying so
    // What the browser did with each request that page made to our site: the ones it would not send
    // past a refused preflight, the ones our server answered but whose answer was kept from the page
    // (our Cross-Origin-Resource-Policy), and the one a plain HTML form got back.
    const seen = [];
    const note = async (r, outcome) => {
      if (!r.url().startsWith(`${BASE}/api/`)) return;
      const headers = await r.allHeaders().catch(() => ({}));
      seen.push({ method: r.method(), path: r.url().slice(BASE.length), outcome, cookie: Boolean(headers.cookie) });
    };
    evil.on('requestfailed', (r) => note(r, (r.failure() || {}).errorText || 'failed'));
    evil.on('response', (r) => note(r.request(), `answered ${r.status()}`));
    await evil.goto(`${evilOrigin}/win-a-prize`);
    const attempts = await evil.evaluate(async (base) => {
      const out = {};
      const tryFetch = (name, url, init) => fetch(base + url, init).then((r) => { out[name] = `answered ${r.type} ${r.status}`; }, (e) => { out[name] = `blocked: ${e.name}`; });
      // Needs a preflight (JSON, custom header): CORS grants this origin nothing.
      await tryFetch('json put', '/api/auth/profile', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pwned', company: 'Evil Inc' }) });
      await tryFetch('json put with a guessed csrf token', '/api/auth/profile', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'guessed' }, body: '{"name":"Pwned"}' });
      await tryFetch('read the session', '/api/auth/session', { credentials: 'include' });
      // No preflight needed ("simple" requests): they are sent, but without the SameSite=Strict cookie.
      await tryFetch('text/plain post', '/api/auth/logout-all', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      await tryFetch('form post', '/api/orders/checkout-session', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'quoteId=x&shippingName=Evil' });
      // And a real HTML form, submitted into a hidden frame.
      await new Promise((resolve) => {
        const frame = document.createElement('iframe'); frame.name = 'sink'; frame.style.display = 'none'; document.body.appendChild(frame);
        const form = document.createElement('form'); form.method = 'POST'; form.action = `${base}/api/auth/logout-all`; form.target = 'sink';
        document.body.appendChild(form); form.submit(); setTimeout(resolve, 800);
      });
      return out;
    }, BASE);
    check('requests that need a preflight are stopped by the browser: this origin is granted nothing', /^blocked/.test(attempts['json put']) && /^blocked/.test(attempts['json put with a guessed csrf token']), JSON.stringify(attempts));
    check('the other site cannot read the session answer (and so not the CSRF token)', /^blocked/.test(attempts['read the session']), attempts['read the session']);
    // Requests that need no preflight (a text/plain or form-encoded POST, an HTML form) are sent by the
    // browser and do reach our server. They arrive without the session cookie (SameSite=Strict); the
    // server refuses each one itself, and its answer is not shown to the other site.
    await sleep(300);
    const posts = seen.filter((r) => r.method === 'POST');
    const answeredAndWithheld = posts.filter((r) => /ERR_BLOCKED_BY_RESPONSE\.NotSameOrigin/.test(r.outcome));
    const formAnswer = posts.find((r) => /^answered/.test(r.outcome));
    check('requests that need no preflight reach our server, which refuses them; the answers are kept from the other site', answeredAndWithheld.length === 2 && Boolean(formAnswer) && /^answered (401|415)$/.test(formAnswer.outcome), JSON.stringify(seen));
    check('every request made in CORS mode failed in the browser: our server grants that origin nothing (the JSON writes never got past their preflight)', seen.filter((r) => r.method !== 'POST').length === 3 && seen.filter((r) => r.method !== 'POST').every((r) => /ERR_FAILED/.test(r.outcome)), JSON.stringify(seen.filter((r) => r.method !== 'POST')));
    check('none of the requests from the other site carried the session cookie', seen.length >= 5 && seen.every((r) => !r.cookie), JSON.stringify(seen.map((r) => [r.method, r.path, r.cookie])));
    check('the page itself saw none of the answers', Object.values(attempts).every((a) => /^blocked/.test(a)), JSON.stringify(attempts));
    const after = await dana.evaluate(() => fetch('/api/auth/profile').then((r) => r.json()));
    const still = await apiFrom(dana, 'GET', '/api/orders');
    check('after every attempt the account is unchanged, no order was made, and the visitor is still signed in', after.name === before.name && after.company === before.company && still.status === 200 && still.text === ordersBefore, `${after.name} / ${still.status}`);
    await evilCtx.close();
    await new Promise((resolve) => evilServer.close(resolve));

    // A request whose every field is markup, opened in the admin queue.
    const ctx = await newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/rfq`);
    const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await page.getByLabel(/^Name/).fill(`Mallory ${hostile}`);
    await page.getByLabel(/^Email/).fill('mallory@buyer.test');
    await page.getByLabel('Company').fill(`5 < 10 > 3 ${hostile}`);
    await page.getByRole('textbox', { name: 'Anything else' }).fill(`tone = 5 and 5 < 10 > 3 ${hostile}`);
    await page.getByRole('group', { name: 'Spam check' }).getByText('Check passed.').waitFor();
    await page.getByRole('button', { name: 'Send for a firm quote' }).click();
    await page.getByRole('heading', { name: "It's in the queue." }).waitFor({ timeout: 15000 });
    await ctx.close();
    await owner.goto(`${BASE}/admin`);
    await owner.getByRole('button', { name: 'RFQs' }).click();
    const row = owner.locator('tr', { hasText: 'Mallory' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.getByRole('button', { name: 'Detail' }).click();
    await owner.getByText('tone = 5 and 5 < 10 > 3', { exact: false }).first().waitFor({ timeout: 10000 });
    await sleep(500);
    const dom = await owner.evaluate(() => ({ xss: window.__xss, img: document.querySelectorAll('img[src="x"]').length, scripts: [...document.scripts].filter((x) => !x.src && x.type !== 'application/ld+json').length, text: document.querySelector('#root').innerText }));
    check('the note is shown exactly as typed, as text', dom.text.includes('tone = 5 and 5 < 10 > 3 <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>') && dom.text.includes('5 < 10 > 3 <img'), dom.text.slice(dom.text.indexOf('Mallory'), dom.text.indexOf('Mallory') + 200));
    check('nothing from it became an element or ran', dom.xss === undefined && dom.img === 0 && dom.scripts === 0, JSON.stringify({ xss: dom.xss, img: dom.img, scripts: dom.scripts }));
    const stored = JSON.parse(await owner.evaluate(() => fetch('/api/rfq/admin/list').then((r) => r.text()))).find((r) => r.email === 'mallory@buyer.test');
    check('and it is stored unchanged', stored.notes === `tone = 5 and 5 < 10 > 3 ${hostile}` && stored.company === `5 < 10 > 3 ${hostile}`, stored.notes);
    const shopMail = mailsTo(OWNER, /^RFQ:/).pop();
    check('the shop email shows it escaped, and its subject carries none of it', shopMail.html.includes('&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;') && !/<img|<script/i.test(shopMail.html) && !/Mallory|img|script/.test(shopMail.subject), shopMail.subject);
  });

  // Logs: no secrets.
  const text = log();
  const leaked = [...server.secrets, 'e2e-pass-', '#token='].filter((s) => text.includes(s));
  check('the server log (keys set) holds no Turnstile secret, no check token and no emailed link', leaked.length === 0, leaked.join(', '));
  for (const c of [state.buyerCtx, state.ownerCtx, buyerCtx]) await c?.close().catch(() => {});
  await stopServer();
}

async function phaseWithoutKeys() {
  await startServer({ turnstile: false });
  const logText = () => fs.readFileSync(server.logFile, 'utf8');
  await step('H. No Turnstile keys: the startup warning, and request forms taken as unverified senders', async () => {
    const text = logText();
    check('the startup log lists every check that is off', ['BOT CHECK IS OFF', 'registration', 'firm-quote form and send-us-the-part form', 'password-reset request', 'sign-in', 'CAD upload and pricing', 'Still running without keys'].every((s) => text.includes(s)));
    const ctx = await newContext({ turnstileScript: 'none' });
    const page = await ctx.newPage();
    const asked = [];
    page.on('request', (r) => { if (r.url().includes('challenges.cloudflare.com')) asked.push(r.url()); });
    // What the pages say before anything is sent is true with or without the bot check.
    const promises = /confirmation email|on the (next )?screen and by email|address to ship[^.?!]*(on the (next )?screen|by email)/i;
    const pre = [];
    for (const url of ['/replacement-parts', '/rfq', '/rfq?nocad=1']) {
      await page.goto(`${BASE}${url}`);
      await sleep(400);
      const t = await page.locator('main').innerText();
      if (promises.test(t)) pre.push(`${url}: ${t.match(promises)[0]}`);
      if (url !== '/rfq' && !/we send you the address to ship/i.test(t)) pre.push(`${url}: does not say we send the address`);
    }
    check('before a request is sent no page promises a confirmation email or an address on the screen', pre.length === 0, pre.join('; '));
    await page.goto(`${BASE}/rfq?nocad=1`);
    await page.getByLabel(/^Name/).fill('Sam Maint');
    await page.getByLabel(/^Email/).fill('stranger@elsewhere.test');
    await page.getByLabel(/What the part is and what it does/).fill('Lane divider, worn.');
    await page.getByRole('button', { name: 'Send the request' }).click();
    await page.getByRole('heading', { name: 'We have your request.' }).waitFor({ timeout: 15000 });
    const body = await page.textContent('body');
    const shipFrom = require(path.join(ROOT, 'server', 'config', 'shipFrom.json'));
    check('send-the-part form, no bot check: accepted, a reference is shown, the ship-to address is not', !body.includes(shipFrom.zip) && !body.includes(shipFrom.address) && /Reference to write on the box/.test(body) && /Do not send anything yet/.test(body));
    check('…and the page says what happened: the address comes in our reply, and no confirmation email is claimed', /We read the request first, then reply to/.test(body) && /It comes in our reply to stranger@elsewhere\.test/.test(body) && /No automatic confirmation email goes out for this request/.test(body) && !/confirmation email is on its way|in the confirmation email|Reply to the confirmation email/.test(body), body.slice(0, 400));
    await shot(page, 'part-request-unverified', { fullPage: false });
    await sleep(600);
    const shop = mailsTo(OWNER, /^RFQ:/).pop();
    check('the typed address got no email; the shop notice is marked "unverified sender" and has no reply-to', mailsTo('stranger@elsewhere.test').length === 0 && /\[unverified sender\]$/.test(shop.subject) && /UNVERIFIED SENDER/.test(shop.text) && /NOT given the ship-to address/.test(shop.text) && !shop.replyTo, shop.subject);
    check('the outbox on disk holds the address nowhere', !mails().some((m) => m.text.includes(shipFrom.address)));

    await page.goto(`${BASE}/rfq`);
    await page.getByLabel(/^Name/).fill('Free money at https://evil.example');
    await page.getByLabel(/^Email/).fill('victim@elsewhere.test');
    await page.getByLabel('Company').fill('<script>alert(1)</script>');
    await page.getByRole('button', { name: 'Send for a firm quote' }).click();
    await page.getByRole('heading', { name: "It's in the queue." }).waitFor({ timeout: 15000 });
    const text2 = await page.textContent('body');
    check('firm-quote form, no bot check: accepted, and the page does not promise a confirmation email', !text2.includes('A confirmation email is on its way') && /No automatic confirmation email goes out for this request/.test(text2) && /Reference: [0-9A-F]{8}/.test(text2));
    await shot(page, 'rfq-sent-unverified', { fullPage: false });
    await sleep(600);
    const shop2 = mailsTo(OWNER, /^RFQ:/).pop();
    check('nothing was mailed to the typed address, and nothing typed is in the shop subject', mailsTo('victim@elsewhere.test').length === 0 && !/evil|Free|script/.test(shop2.subject) && !shop2.html.includes('<script>alert'), shop2.subject);
    check('with no keys the Turnstile script is never requested', asked.length === 0);

    // Honeypot and minimum time still work with no keys.
    const formToken = await page.evaluate(() => fetch('/api/public/form-token?form=rfq').then((r) => r.json()));
    const fast = await page.evaluate(async (t) => { const fd = new FormData(); fd.append('contactName', 'Bot'); fd.append('email', 'bot@spam.test'); const r = await fetch('/api/rfq', { method: 'POST', body: fd, headers: { 'X-Form-Token': t } }); return { status: r.status, body: await r.json() }; }, formToken.formToken);
    check('a form posted the instant it loads is refused (minimum time to submit)', fast.status === 400 && fast.body.code === 'too-fast');
    const rowsBefore = mailsTo(OWNER, /^RFQ:/).length;
    await sleep(3300);
    const pot = await page.evaluate(async (t) => { const fd = new FormData(); fd.append('contactName', 'Bot'); fd.append('email', 'bot@spam.test'); fd.append('website', 'http://spam.example'); const r = await fetch('/api/rfq', { method: 'POST', body: fd, headers: { 'X-Form-Token': t } }); return { status: r.status, body: await r.json() }; }, formToken.formToken);
    await sleep(400);
    check('a filled honeypot gets a success-shaped answer and nothing happens', pot.status === 201 && mailsTo(OWNER, /^RFQ:/).length === rowsBefore && mailsTo('bot@spam.test').length === 0);

    // The owner's queue shows the mark.
    const ownerPw = newPassword();
    await registerVia(page, { name: 'Owner', email: OWNER, password: ownerPw });
    await sleep(3300);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/\/quote/, { timeout: 20000 });
    await page.goto(linkIn(await waitMail(OWNER, /confirm your email/), 'verify-email'));
    await page.getByText('is confirmed').waitFor({ timeout: 10000 });
    await page.goto(`${BASE}/admin`);
    // Two-step sign-in comes first here too: the queue opens only after enrolment.
    await page.getByTestId('enrolment-gate').waitFor({ timeout: 15000 });
    check('with no keys the owner still has to set up two-step sign-in before the queue opens', await page.getByRole('button', { name: 'RFQs' }).count() === 0);
    await page.getByLabel('Your password, to start').fill(ownerPw);
    await page.getByRole('button', { name: 'Set up two-step sign-in' }).click();
    await page.getByTestId('twofactor-setup').waitFor({ timeout: 15000 });
    const key = (await page.getByTestId('setup-key').textContent()).replace(/\s/g, '');
    await page.getByLabel('6-digit code from the app').fill(totp.codeAt(key));
    await page.getByRole('button', { name: 'Switch it on' }).click();
    await page.getByTestId('recovery-codes').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await page.getByRole('button', { name: 'RFQs' }).click();
    await page.getByText('Unverified sender').first().waitFor({ timeout: 15000 });
    check('the admin RFQ queue marks both requests "Unverified sender"', await page.getByText('Unverified sender').count() === 2);
    await shot(page, 'admin-rfq-unverified-sender', { fullPage: false });
    await ctx.close();
  });
  await stopServer();
}

// ══════════════════════════════════════════════════════════════
try {
  browser = await chromium.launch();
  await phaseWithKeys();
  await phaseWithoutKeys();
  check('no page raised a console error or an uncaught exception (hydration included)', consoleProblems.length === 0, consoleProblems.slice(0, 6).join(' | '));
  check('no Content-Security-Policy violation on any page of the run, under the real policy (no bypass)', cspViolations.length === 0, cspViolations.slice(0, 6).map((v) => `${v.page} ${v.directive} ${v.blocked}`).join(' | '));
} catch (err) {
  check('run completed', false, err.stack || err.message);
} finally {
  await stopServer().catch(() => {});
  await browser?.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
const summary = { ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
fs.writeFileSync(path.join(SCRATCH, 'e2e-results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
