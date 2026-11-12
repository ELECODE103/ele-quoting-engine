#!/usr/bin/env node
/**
 * Renders every transactional email (server/emails/samples.js) for review:
 *
 *   NODE_PATH=<dir holding playwright> node scripts/qa/render-emails.mjs [outDir]
 *   (default outDir: docs/screenshots/journey-qa-2026-11-11/emails)
 *
 * For each template: <name>-light.jpg (640 px, as a desktop mail client shows
 * it), <name>-dark-phone.jpg (390 px with the reader's dark mode on) and
 * <name>.txt (the plain-text part, with its subject and preheader). The shop's
 * street address is masked in all three: these files are in the repository,
 * the address is on documents only.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const samples = require(path.join(ROOT, 'server', 'emails', 'samples.js'));
const shipFrom = require(path.join(ROOT, 'server', 'config', 'shipFrom.json'));
const out = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots', 'journey-qa-2026-11-11', 'emails'));
fs.mkdirSync(out, { recursive: true });

const mask = (s) => String(s).split(shipFrom.address).join('[street address]').split(String(shipFrom.zip)).join('[ZIP]');
const preheaderOf = (html) => ((html.match(/<div style="display:none[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '').replace(/&#847;|&zwnj;|&nbsp;/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

const browser = await chromium.launch();
const index = [];
for (const [name, build] of Object.entries(samples)) {
  const m = build();
  const html = mask(m.html);
  const pre = preheaderOf(m.html);
  fs.writeFileSync(path.join(out, `${name}.txt`), `Subject: ${m.subject}\nPreheader: ${pre}\n\n${mask(m.text)}\n`);
  for (const [suffix, width, colorScheme] of [['light', 640, 'light'], ['dark-phone', 390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(out, `${name}-${suffix}.jpg`), fullPage: true, type: 'jpeg', quality: 78 });
    await context.close();
  }
  index.push({ name, subject: m.subject, preheader: pre, words: m.text.split(/\s+/).length, action: (m.text.match(/^(.+):\nhttps?:\/\/\S+$/m) || [])[1] || '' });
  console.log(`${name}: "${m.subject}" | ${pre}`);
}
await browser.close();
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n${index.length} templates rendered to ${out}`);
