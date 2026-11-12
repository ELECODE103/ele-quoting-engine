#!/usr/bin/env node
/**
 * Step 2 of the upgrade check: this version, in production mode, on a database made by the
 * previous version's own code (step 1: scripts/e2e/tax-shipping-upgrade-make-db.js).
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 \
 *   node scripts/e2e/tax-shipping-upgrade.mjs --db /tmp/base-live [--shots docs/screenshots/tax-shipping-2026-11-11]
 *
 * Checks: the server starts on the old file and adds the columns; the old paid order and the old
 * purchase-order order read as they did (same totals, a Shipping line, no tax, no new words); the
 * old order's page renders in a browser; Reorder rebuilds a quote and it checks out; the old
 * draft quote checks out at the total it held. Stripe is stubbed in the server process.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const live = require(path.join(ROOT, 'server', 'testSupport', 'liveServer.js'));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const DB = path.resolve(arg('db', ''));
if (!arg('db', '') || !fs.existsSync(path.join(DB, 'ids.json'))) { console.error('--db <folder written by tax-shipping-upgrade-make-db.js> is required'); process.exit(2); }
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/screenshots/tax-shipping-2026-11-11'));
const ids = JSON.parse(fs.readFileSync(path.join(DB, 'ids.json'), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); };
const columns = (file) => {
  const out = require('node:child_process').spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(ROOT, 'node_modules', 'sql.js'))})().then((SQL) => {
      const db = new SQL.Database(require('fs').readFileSync(${JSON.stringify(file)}));
      const st = db.prepare('PRAGMA table_info(orders)'); const a = []; while (st.step()) a.push(st.getAsObject().name); console.log(JSON.stringify(a));
    });`], { encoding: 'utf8' });
  return JSON.parse(out.stdout.trim());
};

const dbFile = path.join(DB, 'data', 'quoting.db');
const before = columns(dbFile);
console.log('This version on a database made by the previous version');
check('before: the file has the previous version\'s orders table (no shipping_mode, no tax_mode)', !before.includes('shipping_mode') && !before.includes('tax_mode') && before.includes('shipping_cost'));

// The harness that made the database signs with this throwaway secret; reusing it keeps the old sessions' accounts and the firm-quote link valid.
const s = await live.start({ tmpDir: DB, env: { JWT_SECRET: 'test-secret', NODE_OPTIONS: `-r ${path.join(ROOT, 'scripts', 'e2e', 'stub-tax-shipping.cjs')}`, E2E_STUBS: '1' } });
const browser = await chromium.launch();
try {
  check('the server starts on the old file without an error', !/Failed to initialize|SQLITE_ERROR|no such column/i.test(s.log()), s.log().slice(-400));
  const after = columns(dbFile);
  check('the columns were added; the earlier ones are untouched', ['shipping_mode', 'tax_mode', 'ship_account_enc', 'tax_cert_path'].every((c) => after.includes(c)) && JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before));

  let ip = 0;
  const call = (method, url, json, token) => s.req({ method, url, json, token, ip: `198.51.100.${++ip}` });
  const login = await call('POST', '/api/auth/login', { email: 'dana@buyer.test', password: ids.buyerPassword });
  check('the buyer from before can sign in', login.status === 200, login.text);
  const buyer = login.body.token;

  const old = (await call('GET', `/api/orders/${ids.orderId}`, undefined, buyer)).body;
  check('the old paid order: same total and shipping, no tax line, shipped by us', old.status === 'paid' && old.total === ids.paidTotal && old.shippingCost === ids.paidShipping && old.taxLine === null && old.deliveryLine === '' && (old.shippingMethod || 'standard') === 'standard', JSON.stringify([old.status, old.total, old.shippingCost, old.taxLine]));
  check('its lines still add up', Math.abs(old.subtotal + old.leadTimeSurcharge + old.paperworkFee + old.shippingCost - old.total) < 0.01);

  const firm = (await call('GET', `/api/rfq/quote/${ids.firmToken}`)).body;
  check('the old purchase-order order (original part going back) reads as before: $4,250.00, awaiting PO, no tax line', firm.order && firm.order.total === 4250 && firm.order.status === 'pending_po' && firm.order.taxLine === null && firm.returnPart === true, JSON.stringify(firm.order));

  // In a browser: the old order's page, then Reorder.
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${s.base}/login`);
  await page.getByLabel('Email').fill('dana@buyer.test');
  await page.getByLabel('Password').fill(ids.buyerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await page.goto(`${s.base}/orders/${ids.orderId}`);
  await page.getByRole('heading', { name: /^Order [0-9A-F]{8}$/ }).waitFor({ timeout: 20000 });
  const body = await page.textContent('body');
  check('the old order\'s page renders: Shipping line, total, no tax, no pickup', /Shipping/.test(body) && body.includes(`$${ids.paidTotal.toFixed(2)}`) && !/Sales tax|Pickup|carrier account/i.test(body) && problems.length === 0, problems.join(' | '));
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, '29-order-from-before-the-upgrade.png'), fullPage: true });
  const reordered = page.waitForResponse((r) => r.url().endsWith(`/api/orders/${ids.orderId}/reorder`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Reorder' }).click();
  const quoteId = (await (await reordered).json()).quoteId;
  await page.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 30000 });
  check('Reorder opens the same part as a new quote, priced under today\'s (default) settings', Boolean(quoteId) && /Shipping estimate/.test(await page.getByRole('complementary', { name: 'Order summary' }).textContent()));
  await page.getByText('Shipping estimate').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, '30-reorder-of-an-order-from-before.png'), fullPage: false });
  const re = await call('POST', '/api/orders/checkout-session', { quoteId, shippingName: 'Dana Buyer', shippingAddress: '100 Main St', shippingCity: 'Elgin', shippingState: 'IL', shippingZip: '60120' }, buyer);
  const reOrder = re.status === 200 ? (await call('POST', `/api/orders/${re.body.orderId}/confirm-payment`, {}, buyer)).body : null;
  check('the reordered quote checks out and is paid', re.status === 200 && reOrder && reOrder.status === 'paid', re.text);

  const draft = (await call('GET', `/api/quote/${ids.draftId}`, undefined, buyer)).body;
  check('the old draft quote: same total, one delivery choice at that total, no tax note', draft.orderTotal === ids.draftTotal && draft.checkout.showOptions === false && draft.checkout.options[0].total === ids.draftTotal && draft.checkout.tax.mode === 'off');
  const co = await call('POST', '/api/orders/checkout-session', { quoteId: ids.draftId, shippingName: 'Dana Buyer', shippingAddress: '100 Main St', shippingCity: 'Elgin', shippingState: 'IL', shippingZip: '60120' }, buyer);
  const paid = co.status === 200 ? (await call('GET', `/api/orders/${co.body.orderId}`, undefined, buyer)).body : {};
  check('the old draft quote checks out at the total and shipping it held, paperwork line included', co.status === 200 && paid.total === ids.draftTotal && Math.abs(paid.shippingCost - Math.round(ids.draftShipping * 100) / 100) < 0.001 && paid.paperwork === true, co.text);
  await context.close();
} finally {
  await browser.close();
  await s.stop({ keep: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
