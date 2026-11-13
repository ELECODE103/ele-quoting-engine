#!/usr/bin/env node
/**
 * The admin panel in a real browser, on a database full of orders (re-review 2026-11-12, F-09).
 *
 *   NODE_PATH=<dir holding playwright> \
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 \
 *   node scripts/e2e/admin-panel-load.mjs --scratch <dir>
 *
 * The data is the worst case of tools/security/rereview-fixes/order-list-worst.js: one account's
 * unpaid orders of a detailed drawing (as many as the site allows), copied in the database file
 * until it is 12 MB. Before the fix the owner's order list answered 500 on four such orders and the
 * panel, which loaded its seven sections in one piece, showed nothing at all.
 *
 * Checked at 1360 px and at 390 px, signed in as the owner through the sign-in page:
 *   - every section fills: the figures, the orders (a page of 50, with the count), parts, materials,
 *     finishes, lead times, quotes
 *   - "Older" shows the next page; "Only orders that need attention" narrows the list; an order of
 *     the largest size opens in the drawer with its lines
 *   - one section's request made to fail (the order list; then the materials): that tab says so in
 *     words with "Try again", every other tab is filled as before, and "Try again" loads it
 *   - nothing scrolls sideways
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { build } = require(path.join(ROOT, 'tools', 'security', 'rereview-fixes', 'order-list-worst.js'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!arg('scratch', '')) { console.error('--scratch <dir> is required (screenshots)'); process.exit(2); }
const SHOTS = path.join(path.resolve(arg('scratch', '')), 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const built = await build({ targetMb: Number(arg('mb', 12)) });
const { s, made, lines, totp } = built;
const BASE = `http://127.0.0.1:${s.port}`;
let browser;
try {
  browser = await chromium.launch();
  for (const width of [1360, 390]) {
    console.log(`\n${width} px`);
    const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': '198.51.100.1' } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
    // Sign in as the owner, through the page. A code is good once: wait for a fresh one.
    const used = totp.stepAt();
    while (totp.stepAt() <= used) await sleep(500);
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').fill(s.adminEmail);
    await page.getByLabel('Password').fill(s.passwords[s.adminEmail]);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Code from your authenticator app').waitFor({ timeout: 10000 });
    await page.getByLabel('Code from your authenticator app').fill(totp.codeAt(s.adminSecret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });

    const sideways = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const tab = async (label) => { await page.getByRole('button', { name: label, exact: true }).click(); await sleep(150); };
    const rowsIn = (label) => page.locator(`[aria-label="${label}"] tbody tr`).count();

    const t0 = Date.now();
    await page.goto(`${BASE}/admin`);
    await page.getByTestId('orders-count').waitFor({ timeout: 20000 });
    await page.locator('[aria-label="Orders table"] tbody tr').first().waitFor({ timeout: 20000 });
    const loadMs = Date.now() - t0;
    const count = await page.getByTestId('orders-count').textContent();
    check('the Orders tab fills: a page of 50 and how many there are in all', (await rowsIn('Orders table')) === 50 && /Orders 1 to 50 of \d{3,}/.test(count), `${count} (${loadMs} ms from opening /admin)`);
    const attention = await page.getByTestId('attention-count').textContent();
    check('the count of orders that need attention is of ALL orders, not of the page', /^\d+ orders need attention$/.test(attention.trim()) && Number(attention.match(/\d+/)[0]) > 2, attention);
    const figures = await page.locator('.grid-4 .card').allTextContents();
    check('the figures at the top are filled', figures.length === 4 && figures.every((t) => !/—$/.test(t.trim())) && /Total Orders\s*\d+/.test(figures[0]), figures.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, `admin-orders-${width}.png`), fullPage: false });
    check('nothing scrolls sideways on the Orders tab', (await sideways()) <= 0, `${await sideways()} px`);

    await page.getByRole('button', { name: 'Older' }).click();
    await page.getByText(/Orders 51 to 100 of/).waitFor({ timeout: 10000 });
    check('"Older" shows the next page', (await rowsIn('Orders table')) === 50);
    await page.getByRole('button', { name: 'Only orders that need attention' }).click();
    await page.getByText(/that need attention, newest first/).waitFor({ timeout: 10000 });
    const flagged = await rowsIn('Orders table');
    check('"Only orders that need attention" narrows the list to the flagged orders', flagged > 0 && flagged < 50 && (await page.getByTestId('order-flags').count()) >= flagged, `${flagged} rows`);
    await page.getByRole('button', { name: 'Show all orders' }).click();
    await page.getByText(/Orders 1 to 50 of/).waitFor({ timeout: 10000 });

    // The largest order there is: open it from the newest page (the unpaid ones are the newest).
    await page.locator(`a[href="#order-${made[0]}"]`).click();
    await page.getByText('Order Detail').waitFor({ timeout: 10000 });
    await page.getByText(`Line Items (${lines})`).waitFor({ timeout: 10000 });
    check(`an order of ${lines} lines of the detailed drawing opens in the drawer with its lines`, true);
    await page.screenshot({ path: path.join(SHOTS, `admin-order-drawer-${width}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/admin`);
    await page.getByTestId('orders-count').waitFor({ timeout: 20000 });

    for (const [label, region, min] of [['Materials', null, 1], ['Finishes', 'Finishes table', 1], ['Lead Times', 'Lead times table', 1], ['Quotes', 'Quotes table', 1], ['Parts', 'Uploaded parts table', 1]]) {
      await tab(label);
      const n = region ? await rowsIn(region) : await page.locator('table tbody tr').count();
      check(`the ${label} tab fills`, n >= min && (await page.getByTestId('section-error').count()) === 0, `${n} rows`);
      check(`nothing scrolls sideways on the ${label} tab`, (await sideways()) <= 0, `${await sideways()} px`);
    }

    // One section's request fails: the order list answers what the old route answered.
    await page.route('**/api/orders?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'answer-too-large' }) }));
    await page.goto(`${BASE}/admin`);
    await page.getByTestId('section-error').waitFor({ timeout: 20000 });
    const said = (await page.getByTestId('section-error').textContent()).replace(/\s+/g, ' ').trim();
    check('the order list fails: its tab says so in words and offers "Try again"', /^The order list did not load\./.test(said) && /more than we can show on one page/.test(said) && /The other tabs are not affected\./.test(said) && /Try again$/.test(said), said);
    await page.screenshot({ path: path.join(SHOTS, `admin-orders-failed-${width}.png`), fullPage: false });
    check('nothing scrolls sideways with the notice showing', (await sideways()) <= 0, `${await sideways()} px`);
    const still = [];
    for (const [label, region] of [['Finishes', 'Finishes table'], ['Lead Times', 'Lead times table'], ['Quotes', 'Quotes table'], ['Parts', 'Uploaded parts table']]) { await tab(label); still.push(`${label} ${await rowsIn(region)}`); }
    await tab('Materials');
    still.push(`Materials ${await page.locator('table tbody tr').count()}`);
    const figuresNow = await page.locator('.grid-4 .card').allTextContents();
    check('every other tab is filled as before, and so are the figures', still.every((x) => Number(x.split(' ').pop()) > 0) && /Total Orders\s*\d+/.test(figuresNow[0]), still.join(', '));
    await page.unroute('**/api/orders?*');
    await tab('Orders');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('[aria-label="Orders table"] tbody tr').first().waitFor({ timeout: 10000 });
    check('"Try again" loads the list once the request works', (await rowsIn('Orders table')) === 50 && (await page.getByTestId('section-error').count()) === 0);

    // And the other way round: the materials fail, the orders are there.
    await page.route('**/api/admin/materials', (route) => route.abort());
    await page.goto(`${BASE}/admin`);
    await page.locator('[aria-label="Orders table"] tbody tr').first().waitFor({ timeout: 20000 });
    await tab('Materials');
    const said2 = (await page.getByTestId('section-error').textContent()).replace(/\s+/g, ' ').trim();
    check('the materials fail (no answer at all): the Materials tab says so, the orders are listed', /^The materials did not load\./.test(said2) && /Try again$/.test(said2), said2);
    await page.unroute('**/api/admin/materials');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.locator('table tbody tr').first().waitFor({ timeout: 10000 });
    check('"Try again" loads the materials', (await page.getByTestId('section-error').count()) === 0);
    check('no uncaught error on any admin page', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await context.close();
  }

  // The customer whose orders these are: "Your orders" a page at a time.
  console.log('\nthe customer, 390 px');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'X-Forwarded-For': built.ip } });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(built.email);
  await page.getByLabel('Password').fill(s.passwords[built.email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  await page.goto(`${BASE}/dashboard`);
  await page.getByTestId('orders-pager').waitFor({ timeout: 20000 });
  const pager = (await page.getByTestId('orders-pager').textContent()).replace(/\s+/g, ' ');
  check('"Your orders" lists a page of 50 with the count, and "Older" turns the page', (await page.locator('table tbody tr').count()) === 50 && /Orders 1 to 50 of \d+/.test(pager), pager);
  await page.getByRole('button', { name: 'Older' }).click();
  await page.getByText(/Orders 51 to 100 of/).waitFor({ timeout: 10000 });
  check('nothing scrolls sideways on "Your orders"', (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  await page.screenshot({ path: path.join(SHOTS, 'customer-orders-390.png'), fullPage: false });
  await context.close();
} catch (err) {
  check('the run completed', false, String(err && err.stack ? err.stack : err).slice(0, 600));
} finally {
  if (browser) await browser.close();
  await s.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
