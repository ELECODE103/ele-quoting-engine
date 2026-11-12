#!/usr/bin/env node
/**
 * Browser run for the shipping and tax switches (2026-11-11), against a production-mode
 * server it starts itself (server/testSupport/liveServer.js: its own port, a throwaway
 * database and data folder, secrets made at run time).
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 \
 *   node scripts/e2e/tax-shipping.mjs [--shots docs/screenshots/tax-shipping-2026-11-11]
 *
 * One pass through checkout in a real Chromium at 1360 px for each shipping setting and each
 * tax mode, with a screenshot of what the buyer sees before committing and of the order after:
 *
 *   shipping   weight formula (the default) · rate table · rate table, over the parcel limit ·
 *              free over a threshold · included · the buyer's carrier account · pickup
 *   tax        off (the default) · Stripe Tax · declared exemption, not trusted (taxed, refund
 *              after review) · declared exemption, trusted (no tax) · purchase order (per invoice)
 *   admin      the settings with their preview sentence; the order view with the shipping
 *              method, shipping charged, tax charged, exemption and certificate
 *
 * Stripe is stubbed in the server process (scripts/e2e/stub-tax-shipping.cjs): no call leaves the
 * machine. The carrier account number typed here is made up. The pickup address is masked in
 * every screenshot it appears in, and the run checks it is not in the client bundle, the
 * prerendered pages or any response before payment.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const live = require(path.join(ROOT, 'server', 'testSupport', 'liveServer.js'));
const shipFrom = require(path.join(ROOT, 'server', 'config', 'shipFrom.json'));
const ruleSchema = require(path.join(ROOT, 'server', 'config', 'ruleSchema.js'));
const totp = require(path.join(ROOT, 'server', 'security', 'totp.js'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/screenshots/tax-shipping-2026-11-11'));
const CUBE = path.join(ROOT, 'tools', 'vet-quotes', 'parts', 'cube_20mm.stl');
const STREET = shipFrom.address;
const ACCOUNT = 'A1B2C3D4'; // made up: not a real carrier account
const TABLE = [{ maxLb: 1, price: 9 }, { maxLb: 5, price: 14.5 }, { maxLb: 20, price: 30 }, { maxLb: 50, price: 61 }];
const SHIP = { name: 'Dana Buyer', street: '100 Main St', city: 'Columbus', state: 'OH', zip: '43215' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const shots = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  return ok;
}
async function step(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (err) { check(`${title}: completed`, false, err.stack || err.message); }
}

const DEFAULTS = {
  shippingMethod: 'formula', shippingRateTable: ruleSchema.RULE_BY_KEY.shippingRateTable.default, shippingPackagingPercent: 0.10, shippingPackagingLb: 1,
  shippingOversizeLongestIn: 48, shippingMaxParcelLb: 50, shippingFreeOverSubtotal: 0, shippingCarrierAccount: 'off', shippingLocalPickup: 'off',
  taxMode: 'off', taxProductCode: '', taxShipping: 'goods', taxIdCollection: 'off', taxExemptDeclare: 'off', taxTrustDeclaredExemptions: 'off',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-taxship-'));
const CERT = path.join(tmp, 'resale-certificate.pdf');
fs.writeFileSync(CERT, '%PDF-1.4\n%resale certificate (test file, not a real certificate)\n');

const s = await live.start({ env: { NODE_OPTIONS: `-r ${path.join(ROOT, 'scripts', 'e2e', 'stub-tax-shipping.cjs')}`, E2E_STUBS: '1' } });
const BASE = s.base;
const browser = await chromium.launch();
const consoleProblems = [];
const cspViolations = [];
const seenBeforePayment = []; // every response body a buyer's browser received on the way to paying for a pickup order

let visitor = 0;
async function contextFor() {
  // No bypassCSP: every page runs under the policy the server sends.
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': `203.0.113.${++visitor}` } });
  await context.exposeBinding('__cspReport', (source, v) => { cspViolations.push(v); });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => { window.__cspReport({ page: location.pathname, directive: e.effectiveDirective, blocked: e.blockedURI }); });
  });
  context.on('page', (page) => {
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleProblems.push(`${page.url()} :: ${m.text()}`); });
    page.on('pageerror', (e) => consoleProblems.push(`${page.url()} :: pageerror ${e.message}`));
  });
  return context;
}
async function shot(page, name, { mask = [], fullPage = true } = {}) {
  const file = path.join(SHOTS, `${name}.png`);
  // A full-page capture is taken from the top (a field that was just filled leaves the page scrolled, and the sticky header with it).
  if (fullPage) { await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); }); await page.waitForTimeout(150); }
  await page.screenshot({ path: file, fullPage, mask, maskColor: '#101C33' });
  shots.push(`${name}.png`);
}

/** Sign in through the sign-in page, as a person does (the session is an httpOnly cookie the browser keeps). */
async function signIn(page, email, { code } = {}) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(s.passwords[email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (code) {
    await page.getByLabel('Code from your authenticator app').waitFor({ timeout: 15000 });
    await page.getByLabel('Code from your authenticator app').fill(code());
    await page.getByRole('button', { name: /Sign in|Verify|Continue/ }).first().click();
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

let buyerToken, adminToken, partId, material;
// Each call from this script arrives as its own visitor (the server trusts one proxy hop in production), as the
// account and bot-check runs do: one address would run into the per-address rate limits long before a buyer would.
let caller = 0;
const nextIp = () => { caller += 1; return `198.51.${Math.floor(caller / 250) % 250}.${(caller % 250) + 1}`; };
const api = (method, url, json, token) => s.req({ method, url, json, token, ip: nextIp() });
async function settings(over = {}) {
  const r = await api('PUT', '/api/admin/pricing', { rules: { ...DEFAULTS, ...over }, note: 'browser run: shipping and tax settings' }, adminToken);
  if (r.status !== 200) throw new Error(`settings: ${r.status} ${r.text}`);
}
async function newQuote(qty = 2, extra = {}) {
  const r = await api('POST', '/api/quote', { parts: [{ partId, materialSlug: material.slug, grade: material.grades?.[0]?.name || '', finishSlug: '', quantity: qty, process: 'cnc', subProcess: 'milling' }], leadTimeSlug: 'standard', ...extra }, buyerToken);
  if (r.status !== 200) throw new Error(`quote: ${r.status} ${r.text}`);
  return r.body;
}
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const text = (page, testId) => page.getByTestId(testId).first().textContent();

async function openCheckout(page, quoteId) {
  await page.goto(`${BASE}/checkout/${quoteId}`);
  await page.getByTestId('summary-total').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid=summary-total]').textContent.includes('...'));
}
async function fillAddress(page, { pickup = false } = {}) {
  await page.locator('#co-name').fill(SHIP.name);
  if (pickup) return;
  await page.locator('#co-street').fill(SHIP.street);
  await page.locator('#co-city').fill(SHIP.city);
  await page.locator('#co-state').fill(SHIP.state);
  await page.locator('#co-zip').fill(SHIP.zip);
}
/** Pay (the stubbed Stripe page is the return URL, already paid) and land on the paid order page. Returns the order id. */
async function pay(page) {
  await page.getByRole('button', { name: /Pay and place order/ }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}\?paid=true/, { timeout: 20000 });
  await page.getByRole('heading', { name: /^Order [0-9A-F]{8}$/ }).waitFor({ timeout: 20000 });
  await page.getByText('Payment received', { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  return page.url().match(/\/orders\/([0-9a-f-]{36})/)[1];
}
async function openAdminOrder(adminPage, orderId) {
  await adminPage.goto(`${BASE}/admin`);
  await adminPage.getByRole('link', { name: orderId.slice(0, 8) }).first().click();
  await adminPage.getByTestId('shipping-tax').waitFor({ timeout: 15000 });
}
const order = async (id, token = adminToken) => (await api('GET', `/api/orders/${id}`, undefined, token)).body;

try {
  await step('Setup: owner (two-step sign-in on), a buyer, a part', async () => {
    adminToken = await s.admin();
    buyerToken = await s.register('dana@buyer.test');
    const up = await s.upload([{ name: 'cube_20mm.stl', data: fs.readFileSync(CUBE) }], { token: buyerToken });
    partId = up.body.parts[0].partId;
    material = (await api('GET', '/api/materials?process=cnc')).body.find((m) => m.active !== false);
    check('a part is uploaded and a CNC material is on the list', Boolean(partId && material));
  });

  const buyerCtx = await contextFor();
  const buyer = await buyerCtx.newPage();
  const adminCtx = await contextFor();
  const admin = await adminCtx.newPage();
  await step('Sign in: the buyer, and the owner with a code from the authenticator', async () => {
    await signIn(buyer, 'dana@buyer.test');
    // The code used at enrolment cannot be used again: wait for the authenticator's next one.
    const enrolStep = totp.stepAt();
    while (totp.stepAt() <= enrolStep) await sleep(500);
    await signIn(admin, s.adminEmail, { code: () => totp.codeAt(s.adminSecret) });
    await admin.goto(`${BASE}/admin`);
    await admin.getByRole('button', { name: 'Pricing' }).waitFor({ timeout: 20000 });
    check('both are signed in', true);
  });
  buyer.on('response', async (res) => { if (res.url().includes('/api/') && buyer.__beforePayment) { try { seenBeforePayment.push(await res.text()); } catch { /* body gone */ } } });

  // ═══ Shipping ══════════════════════════════════════════════
  let baseline;
  await step('1. Shipping by the weight formula, tax off (the defaults): what the site did before', async () => {
    await settings();
    const q = await newQuote(2);
    baseline = q;
    await buyer.goto(`${BASE}/quote?quote=${q.quoteId}`);
    await buyer.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 30000 });
    const rail = await buyer.getByRole('complementary', { name: 'Order summary' }).textContent();
    check('quote summary: "Shipping estimate" with the formula amount, no tax line, no delivery note', rail.includes('Shipping estimate') && rail.includes(money(q.shippingEstimate)) && !/Sales tax|carrier account|pickup/i.test(rail), rail.slice(0, 300));
    await buyer.getByText('Shipping estimate').scrollIntoViewIfNeeded();
    await shot(buyer, '01-default-quote-summary', { fullPage: false });
    await openCheckout(buyer, q.quoteId);
    check('checkout: no delivery chooser, no tax line, no exemption box', await buyer.getByTestId('delivery-choice').count() === 0 && await buyer.getByTestId('summary-tax').count() === 0 && await buyer.getByTestId('tax-exemption').count() === 0);
    check('checkout: Shipping and Total are the quote\'s', (await text(buyer, 'summary-shipping')).includes(money(q.shippingEstimate)) && (await text(buyer, 'summary-total')).includes(money(q.orderTotal)));
    await fillAddress(buyer);
    await shot(buyer, '02-default-checkout');
    const id = await pay(buyer);
    const o = await order(id);
    check('order: paid for the quoted total, shipped by us, no tax', o.status === 'paid' && o.total === q.orderTotal && o.shippingMethod === 'standard' && o.tax === 0 && o.taxLine === null, JSON.stringify([o.status, o.total, o.shippingMethod, o.tax]));
    const body = await buyer.textContent('body');
    check('order page: a Shipping line, no tax line', /Shipping/.test(body) && !/Sales tax/.test(body));
    await shot(buyer, '03-default-order-paid');
  });

  await step('2. Rate table by packed weight', async () => {
    await settings({ shippingMethod: 'table', shippingRateTable: TABLE });
    const q = await newQuote(2);
    await buyer.goto(`${BASE}/quote?quote=${q.quoteId}`);
    await buyer.getByTestId('shipping-note').waitFor({ timeout: 30000 });
    const rail = await buyer.getByRole('complementary', { name: 'Order summary' }).textContent();
    check('quote summary: Shipping $14.50 with how it was arrived at', rail.includes('$14.50') && /packed weight \(about 2 lb\)/.test(rail), rail.slice(0, 400));
    await buyer.getByTestId('shipping-note').scrollIntoViewIfNeeded();
    await shot(buyer, '04-table-quote-summary', { fullPage: false });
    await openCheckout(buyer, q.quoteId);
    check('checkout: the shipping line and total come from the server', (await text(buyer, 'summary-shipping')).includes('$14.50') && (await text(buyer, 'summary-total')).includes(money(q.orderTotal)) && /packed weight/.test(await text(buyer, 'summary-shipping-note')));
    await fillAddress(buyer);
    await shot(buyer, '05-table-checkout');
    const id = await pay(buyer);
    const o = await order(id);
    check('order: shipping $14.50 charged as its own line; lines add up', o.shippingCost === 14.5 && o.shippingMode === 'table' && Math.abs(o.subtotal + o.leadTimeSurcharge + o.shippingCost - o.total) < 0.01);
    await shot(buyer, '06-table-order-paid');
  });

  await step('3. Rate table: an order over the parcel limit is not priced; it goes to a firm quote', async () => {
    await settings({ shippingMethod: 'table', shippingRateTable: TABLE, shippingMaxParcelLb: 1 });
    const q = await newQuote(2);
    await buyer.goto(`${BASE}/quote?quote=${q.quoteId}`);
    await buyer.getByRole('button', { name: /Request a firm quote/ }).first().waitFor({ timeout: 30000 });
    const rail = await buyer.getByRole('complementary', { name: 'Budgetary summary' }).textContent();
    check('quote summary: shipping "To be confirmed", the reason, and the firm-quote button instead of checkout', rail.includes('To be confirmed') && /confirm freight/.test(rail) && await buyer.getByRole('button', { name: /^Check out/ }).count() === 0, rail.slice(0, 400));
    await buyer.getByTestId('shipping-note').scrollIntoViewIfNeeded();
    await shot(buyer, '07-table-overweight-goes-to-firm-quote', { fullPage: false });
  });

  await step('4. Free shipping over a threshold', async () => {
    await settings({ shippingMethod: 'table', shippingRateTable: TABLE, shippingFreeOverSubtotal: 50 });
    const q = await newQuote(3);
    await openCheckout(buyer, q.quoteId);
    check('checkout: Shipping reads Free and says why', (await text(buyer, 'summary-shipping')).includes('Free') && /Free shipping on orders with \$50\.00 or more in parts/.test(await text(buyer, 'summary-shipping-note')));
    await fillAddress(buyer);
    await shot(buyer, '08-free-over-threshold-checkout');
    const o = await order(await pay(buyer));
    check('order: no shipping charged', o.shippingCost === 0 && o.status === 'paid');
  });

  await step('5. Shipping included in the price', async () => {
    await settings({ shippingMethod: 'included' });
    const q = await newQuote(2);
    await openCheckout(buyer, q.quoteId);
    check('checkout: Shipping reads Included', (await text(buyer, 'summary-shipping')).includes('Included') && /included in the price/.test(await text(buyer, 'summary-shipping-note')));
    await fillAddress(buyer);
    await shot(buyer, '09-included-checkout');
    const id = await pay(buyer);
    check('order page: Shipping — Included', /Shipping\s*Included/.test(await text(buyer, 'order-totals')));
    await shot(buyer, '10-included-order-paid');
    check('order: nothing charged for shipping', (await order(id)).shippingCost === 0);
  });

  let collectOrder;
  await step('6. Ship on the buyer\'s carrier account', async () => {
    await settings({ shippingMethod: 'table', shippingRateTable: TABLE, shippingCarrierAccount: 'on' });
    const q = await newQuote(2);
    await openCheckout(buyer, q.quoteId);
    await buyer.getByTestId('delivery-choice').waitFor();
    await buyer.getByText('Ship on my carrier account').click();
    await buyer.getByLabel('Carrier account number').fill(ACCOUNT);
    await buyer.getByLabel('Carrier service').fill('Ground');
    const collect = q.checkout.options.find((o) => o.method === 'carrier-account');
    check('checkout: choosing the carrier account drops the shipping line; the total is the server\'s for that choice', (await text(buyer, 'summary-shipping')).includes('On your account') && (await text(buyer, 'summary-total')).includes(money(collect.total)));
    await fillAddress(buyer);
    await shot(buyer, '11-carrier-account-checkout');
    collectOrder = await pay(buyer);
    const body = await buyer.textContent('body');
    check('order page: the account by its last four, never in full', body.includes('••••C3D4') && !body.includes(ACCOUNT));
    await shot(buyer, '12-carrier-account-order-paid');
    const mine = await api('GET', `/api/orders/${collectOrder}`, undefined, buyerToken);
    check('the buyer\'s own order data carries no full account number', !mine.text.includes(ACCOUNT));
    await openAdminOrder(admin, collectOrder);
    check('admin order view: the full account number, shipping method, no shipping charged', (await text(admin, 'carrier-account-number')).trim() === ACCOUNT && /Customer's UPS account/.test(await text(admin, 'shipping-tax')) && /Shipping charged\s*None/.test(await text(admin, 'shipping-tax')));
    await admin.getByTestId('collect-flag').scrollIntoViewIfNeeded();
    await shot(admin, '13-carrier-account-admin-order', { fullPage: false });
    check('the account number is not in the server log', !s.log().includes(ACCOUNT));
    const mails = s.mail().filter((m) => JSON.stringify(m).includes(ACCOUNT));
    check('the account number is in no email', mails.length === 0);
  });

  let pickupOrder;
  await step('7. Pickup at the shop', async () => {
    await settings({ shippingMethod: 'table', shippingRateTable: TABLE, shippingLocalPickup: 'on' });
    const q = await newQuote(2);
    buyer.__beforePayment = true;
    await buyer.goto(`${BASE}/quote?quote=${q.quoteId}`);
    await buyer.getByTestId('delivery-alternatives').waitFor({ timeout: 30000 });
    await openCheckout(buyer, q.quoteId);
    await buyer.getByText('Pick up at our shop').click();
    await buyer.locator('#co-name').fill(SHIP.name);
    check('checkout: pickup needs no address and shows no shipping charge', await buyer.locator('#co-street').count() === 0 && (await text(buyer, 'summary-shipping')).includes('Pickup'));
    check('checkout: the street address is not on the page', !(await buyer.content()).includes(STREET));
    await shot(buyer, '14-pickup-checkout');
    buyer.__beforePayment = false;
    check('nothing the browser received before payment contains the street address', seenBeforePayment.length > 3 && !seenBeforePayment.some((b) => b.includes(STREET)), `${seenBeforePayment.length} responses`);
    pickupOrder = await pay(buyer);
    await buyer.getByTestId('pickup-address').waitFor({ timeout: 15000 });
    check('order page, after payment: the pickup address is given', (await text(buyer, 'pickup-address')).includes(STREET));
    await shot(buyer, '15-pickup-order-paid', { mask: [buyer.getByTestId('pickup-address')] });
    const confirmation = s.mail('dana@buyer.test', /confirmed/).pop();
    check('the order confirmation email carries the pickup address', Boolean(confirmation && confirmation.text.includes(STREET)));
    check('the pickup address is not in the server log', !s.log().includes(STREET));
    await openAdminOrder(admin, pickupOrder);
    check('admin order view: customer pickup, do not ship', /Customer pickup/.test(await text(admin, 'shipping-tax')) && await admin.getByTestId('pickup-flag').count() === 1);
  });

  // ═══ Tax ═══════════════════════════════════════════════════
  await step('8. Tax: Stripe Tax automatic', async () => {
    await settings({ taxMode: 'stripe' });
    const q = await newQuote(2);
    await buyer.goto(`${BASE}/quote?quote=${q.quoteId}`);
    await buyer.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 30000 });
    check('quote summary: a Sales tax line that says when it is added', /Sales tax\s*Added at checkout/.test(await buyer.getByRole('complementary', { name: 'Order summary' }).textContent()));
    await openCheckout(buyer, q.quoteId);
    check('checkout: tax is said to be added at payment; the total is labelled before tax', (await text(buyer, 'summary-tax')).includes('Added at payment') && /added on the secure payment page/.test(await text(buyer, 'summary-tax-note')) && (await buyer.textContent('body')).includes('Total before tax'));
    await fillAddress(buyer);
    await shot(buyer, '16-tax-stripe-checkout');
    const id = await pay(buyer);
    const o = await order(id);
    check('order: paid (not flagged as an amount mismatch), tax stored, total includes it', o.status === 'paid' && o.tax > 0 && Math.abs(o.total - (q.orderTotal + o.tax)) < 0.01, JSON.stringify([o.status, o.tax, o.total, q.orderTotal]));
    check('order page: a Sales tax line with the amount', (await text(buyer, 'order-totals')).includes(`Sales tax${money(o.tax)}`));
    await shot(buyer, '17-tax-stripe-order-paid');
    await openAdminOrder(admin, id);
    check('admin order view: tax charged', (await text(admin, 'shipping-tax')).includes(`Tax charged${money(o.tax)}`));
    await admin.getByTestId('shipping-tax').scrollIntoViewIfNeeded();
    await shot(admin, '18-tax-stripe-admin-order', { fullPage: false });
  });

  await step('9. Tax: declared exemption, NOT trusted (charged with tax; refund after review)', async () => {
    await settings({ taxMode: 'stripe', taxExemptDeclare: 'on' });
    const q = await newQuote(2);
    await openCheckout(buyer, q.quoteId);
    await buyer.getByTestId('tax-exemption').waitFor();
    await buyer.getByText('This order is tax-exempt').click();
    await buyer.getByLabel('Exemption reason').selectOption('resale');
    await fillAddress(buyer);
    // Without a certificate the server refuses.
    await buyer.getByRole('button', { name: /Pay and place order/ }).click();
    await buyer.getByText('Attach your exemption certificate', { exact: false }).waitFor({ timeout: 10000 });
    check('ticking the box without a certificate is refused', true);
    await buyer.getByLabel('Exemption certificate').setInputFiles(CERT);
    await buyer.getByTestId('tax-cert-name').waitFor({ timeout: 10000 });
    check('checkout: the certificate is attached; the page says tax is charged today and refunded after review', (await text(buyer, 'tax-cert-name')).includes('resale-certificate.pdf') && /charged with tax today/.test(await text(buyer, 'tax-exemption')) && (await text(buyer, 'summary-tax')).includes('Added at payment'));
    await shot(buyer, '19-tax-exempt-review-checkout');
    const id = await pay(buyer);
    const o = await order(id);
    check('order: charged WITH tax, flagged for review, certificate on file', o.tax > 0 && o.taxExempt === true && o.taxExemptStatus === 'taxed' && o.hasTaxCertificate === true);
    check('order page: says the tax is refunded once the certificate has been read', /refund the tax to your card/.test(await text(buyer, 'order-exemption')));
    await shot(buyer, '20-tax-exempt-review-order-paid');
    await openAdminOrder(admin, id);
    check('admin order view: exemption flag, what to do, and the certificate to open', /charged WITH tax/.test(await text(admin, 'exemption-flag')) && /Open the certificate \(resale-certificate\.pdf\)/.test(await text(admin, 'exemption-flag')));
    await admin.getByTestId('exemption-flag').scrollIntoViewIfNeeded();
    await shot(admin, '21-tax-exempt-review-admin-order', { fullPage: false });
    const dl = await s.req({ url: `/api/orders/${id}/tax-certificate`, token: adminToken, ip: nextIp() });
    check('the admin can download the certificate; the buyer cannot', dl.status === 200 && dl.text.startsWith('%PDF') && (await s.req({ url: `/api/orders/${id}/tax-certificate`, token: buyerToken, ip: nextIp() })).status === 403);
  });

  await step('10. Tax: declared exemption, trusted (charged with no tax)', async () => {
    await settings({ taxMode: 'stripe', taxExemptDeclare: 'on', taxTrustDeclaredExemptions: 'on' });
    const q = await newQuote(2);
    await openCheckout(buyer, q.quoteId);
    await buyer.getByText('This order is tax-exempt').click();
    await buyer.getByLabel('Exemption reason').selectOption('manufacturing');
    await buyer.getByLabel('Exemption certificate').setInputFiles(CERT);
    await buyer.getByTestId('tax-cert-name').waitFor({ timeout: 10000 });
    await fillAddress(buyer);
    check('checkout: the tax line reads exempt with certificate', (await text(buyer, 'summary-tax')).includes('Exempt with certificate'));
    await shot(buyer, '22-tax-exempt-trusted-checkout');
    const id = await pay(buyer);
    const o = await order(id);
    check('order: no tax charged, total is the quoted total', o.status === 'paid' && o.tax === 0 && o.total === q.orderTotal && o.taxExemptStatus === 'untaxed');
    check('order page: Sales tax — Exempt', /Sales taxExempt/.test(await text(buyer, 'order-totals')));
    await shot(buyer, '23-tax-exempt-trusted-order-paid');
  });

  await step('11. Firm quote on a purchase order: tax is per invoice; delivery choices on the quote page', async () => {
    await settings({ taxMode: 'stripe', shippingCarrierAccount: 'on', shippingLocalPickup: 'on' });
    const big = await newQuote(500);
    const sent = await s.rfq({ quoteId: big.quoteId, contactName: 'Pat Purchasing', email: 'pat@oem.test', company: 'OEM Co' }, [], { token: buyerToken, ip: nextIp() });
    if (sent.status !== 201) throw new Error(`rfq: ${sent.status} ${sent.text}`);
    const quoted = await api('PUT', `/api/rfq/admin/${sent.body.rfqId}`, { status: 'quoted', quotedTotal: 4250, quotedLeadDays: 15 }, adminToken);
    if (quoted.status !== 200) throw new Error(`quote the rfq: ${quoted.status} ${quoted.text}`);
    const mail = s.mail('pat@oem.test', /firm quote/).pop();
    const link = mail.text.match(new RegExp(`${BASE}/firm-quote/\\S+`))[0];
    const guestCtx = await contextFor();
    const guest = await guestCtx.newPage();
    await guest.goto(link);
    await guest.getByTestId('delivery-choice').waitFor({ timeout: 20000 });
    await guest.getByText('Purchase order', { exact: false }).first().click();
    await guest.getByRole('textbox', { name: 'PO number' }).fill('PO-88213');
    await guest.locator('input[autocomplete=street-address]').fill('500 Plant Rd');
    await guest.locator('input[autocomplete=address-level2]').fill('Rockford');
    await guest.locator('input[autocomplete=address-level1]').fill('IL');
    await guest.locator('input[autocomplete=postal-code]').fill('61101');
    check('firm quote page: three delivery choices, and a PO\'s tax is said to be per invoice', await guest.getByTestId('delivery-choice').locator('label.lead-option').count() === 3 && /per invoice/.test(await text(guest, 'firm-tax-note')));
    await shot(guest, '24-firm-quote-po-per-invoice');
    await guest.getByRole('button', { name: 'Accept on this PO' }).click();
    await guest.getByTestId('order-tax').waitFor({ timeout: 15000 });
    check('accepted on the PO: nothing charged; Sales tax: Per invoice', /Sales tax: Per invoice/.test(await text(guest, 'order-tax')));
    await shot(guest, '25-firm-quote-po-accepted');
    await guestCtx.close();
  });

  // ═══ Admin ═════════════════════════════════════════════════
  await step('12. Admin: the settings, in plain words, with a preview of what a buyer would be charged', async () => {
    await settings();
    await admin.goto(`${BASE}/admin`);
    await admin.getByRole('button', { name: 'Pricing' }).click();
    await admin.getByTestId('shipping-preview-sentence').waitFor({ timeout: 20000 });
    check('Simple view: the Shipping & tax group with its switches', /How shipping is charged/.test(await admin.textContent('body')) && /Sales tax at checkout/.test(await admin.textContent('body')));
    check('preview, defaults: the formula, and tax off', /A 3 lb order .* shipped to OH would be charged \$15\.40 shipping/.test(await text(admin, 'shipping-preview-sentence')) && /Sales tax: off/.test(await text(admin, 'tax-preview-sentence')));
    await admin.locator('[data-rule=shippingMethod]').scrollIntoViewIfNeeded();
    await shot(admin, '26-admin-settings-defaults', { fullPage: false });
    // Change the settings on screen (not saved): the preview answers for what is on screen.
    await admin.getByText('Rate table by packed weight').click();
    await admin.waitForFunction(() => /rate table still holds the placeholder numbers/i.test(document.body.textContent), null, { timeout: 10000 });
    check('preview with the rate table switched on but not yet edited: the charge, and a warning that the numbers are placeholders', /would be charged \$16\.00 shipping/.test(await text(admin, 'shipping-preview-sentence')) && await admin.getByTestId('placeholder-warning').count() === 1, await text(admin, 'shipping-preview-sentence'));
    await admin.getByTestId('shipping-preview').scrollIntoViewIfNeeded();
    await shot(admin, '27-admin-settings-rate-table-preview', { fullPage: false });
    await admin.getByRole('button', { name: 'Everything' }).click();
    await admin.getByRole('navigation', { name: 'Rule groups' }).getByRole('button', { name: /Shipping & tax/ }).click();
    await admin.getByTestId('placeholder-tag').waitFor({ timeout: 10000 });
    check('Everything view: the rate table is tagged as placeholder numbers until it is edited', /Placeholder numbers: set your own/.test(await text(admin, 'placeholder-tag')));
    await admin.locator('[data-rule=shippingRateTable]').scrollIntoViewIfNeeded();
    await shot(admin, '28-admin-settings-everything');
    check('nothing was saved by previewing', (await newQuote(2)).shipping.mode === 'formula');
  });

  // ═══ The street address stays where it belongs ═════════════
  await step('13. The shop\'s street address is not in anything public', async () => {
    const dist = path.join(ROOT, 'client', 'dist');
    const hits = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|json|css|txt|xml|map|webmanifest)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(STREET)) hits.push(path.relative(dist, p)); } };
    walk(dist);
    check('not in the client bundle, the prerendered pages or their structured data', hits.length === 0, hits.join(', '));
    const pages = ['/', '/quote', '/replacement-parts', '/about', '/quality', '/rfq'];
    const guestCtx = await contextFor();
    const guest = await guestCtx.newPage();
    const bad = [];
    for (const url of pages) { await guest.goto(`${BASE}${url}`); if ((await guest.content()).includes(STREET)) bad.push(url); }
    check('not on any public page as served', bad.length === 0, bad.join(', '));
    await guestCtx.close();
    check('not in the server log', !s.log().includes(STREET));
  });

  check('no Content-Security-Policy violation on any page', cspViolations.length === 0, JSON.stringify(cspViolations.slice(0, 3)));
  check('no page errors in the browser console', consoleProblems.length === 0, consoleProblems.slice(0, 3).join(' | '));
  check('defaults restored: a fresh quote is the baseline again', (await (async () => { await settings(); return newQuote(2); })()).orderTotal === baseline.orderTotal);
} finally {
  await browser.close();
  await s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${shots.length} screenshots in ${path.relative(ROOT, SHOTS)}`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);
