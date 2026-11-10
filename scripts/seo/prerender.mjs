#!/usr/bin/env node
/**
 * Post-build step: turns the client-rendered SPA into per-route static HTML.
 *
 * Why this and not a headless browser: the page components are plain React
 * with no browser-only code on the render path, so `vite build --ssr` plus
 * react-dom/server's renderToString produces the same markup a browser would,
 * in pure Node. No Chromium download, no sandbox flags, nothing that can be
 * missing in the Railway/Nixpacks build image. Playwright is not a dependency
 * of this repo and is not used here.
 *
 * Inputs
 *   client/dist/index.html             the built shell (with <!--seo:head--> markers)
 *   client/dist-ssr/entry-server.js    built from client/src/entry-server.jsx
 * Outputs (all inside client/dist)
 *   seo-manifest.json                  route -> { status, indexable, head, file } for server/seo.js
 *   _prerender/<route>.html            full static HTML per public route, plus 404.html
 *   sitemap.xml                        from the route list, with <lastmod>
 *   robots.txt                         with the canonical sitemap URL
 *
 * Failure policy: the manifest is written first, from metadata only. If
 * rendering one route's body throws, that route is skipped with a warning and
 * Express serves the shell with the correct per-route <head> injected instead
 * (still crawlable metadata, client-rendered body). The script exits non-zero
 * only if it cannot produce the manifest at all, or with --strict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'client', 'dist');
const SSR_ENTRY = path.join(ROOT, 'client', 'dist-ssr', 'entry-server.js');
const OUT_DIR = path.join(DIST, '_prerender');
const STRICT = process.argv.includes('--strict');

const HEAD_RE = /<!--seo:head-->[\s\S]*?<!--\/seo:head-->/;
const PRELOAD_MARK = '<!--seo:preload-->';
const ROOT_DIV = '<div id="root"></div>';

function fail(msg) { console.error(`prerender: ${msg}`); process.exit(1); }

if (!fs.existsSync(path.join(DIST, 'index.html'))) fail('client/dist/index.html not found - run the client build first');
if (!fs.existsSync(SSR_ENTRY)) fail('client/dist-ssr/entry-server.js not found - run `vite build --ssr src/entry-server.jsx --outDir dist-ssr` first');

const template = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
if (!HEAD_RE.test(template) || !template.includes(ROOT_DIV)) fail('index.html is missing the <!--seo:head--> markers or the empty #root div');

const ssr = await import(pathToFileURL(SSR_ENTRY).href);

// ── Open Graph image: use the brand default if it has been delivered, else a shop photo ──
function imageSize(file) {
  // PNG only (IHDR); enough for og:image:width/height on the brand file.
  try {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch { /* ignore */ }
  return null;
}
const FALLBACK_OG = '/photos/tray-stack-edge.jpg';
const hasDefaultOg = fs.existsSync(path.join(DIST, ssr.DEFAULT_OG_IMAGE));
if (!hasDefaultOg) console.warn(`prerender: ${ssr.DEFAULT_OG_IMAGE} does not exist yet - og:image falls back to ${FALLBACK_OG}`);

function ogFor(routePath) {
  // Per-page image only if the file exists: /brand/og/<name>.png, name = path with "/" -> "-" ("home" for "/").
  const name = routePath === '/' ? 'home' : routePath.replace(/^\//, '').replace(/\//g, '-');
  const perPage = `/brand/og/${name}.png`;
  const chosen = fs.existsSync(path.join(DIST, perPage)) ? perPage : hasDefaultOg ? ssr.DEFAULT_OG_IMAGE : FALLBACK_OG;
  return { ogImage: chosen, size: imageSize(path.join(DIST, chosen)) };
}

function metaFor(routePath) {
  const og = ogFor(routePath);
  const m = ssr.getRouteMeta(routePath, { ogImage: og.ogImage });
  if (og.size) { m.ogImageWidth = og.size.w; m.ogImageHeight = og.size.h; }
  return m;
}

// ── Font preloads: the Latin variable woff2 for the body and display faces ──
const assets = fs.existsSync(path.join(DIST, 'assets')) ? fs.readdirSync(path.join(DIST, 'assets')) : [];
const preloads = ['inter-latin-wght-normal', 'archivo-latin-wght-normal']
  .map((stem) => assets.find((f) => f.startsWith(stem) && f.endsWith('.woff2')))
  .filter(Boolean)
  .map((f) => `<link rel="preload" href="/assets/${f}" as="font" type="font/woff2" crossorigin />`)
  .join('\n    ');

function page(head, body) {
  let html = template.replace(HEAD_RE, () => `<!--seo:head-->\n    ${head}\n    <!--/seo:head-->`);
  html = html.replace(PRELOAD_MARK, () => preloads);
  if (body != null) html = html.replace(ROOT_DIV, () => `<div id="root">${body}</div>`);
  return html;
}

function validateJsonLd(head, routePath) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m; let n = 0;
  while ((m = re.exec(head))) {
    const data = JSON.parse(m[1]); // throws on a syntax error
    if (data['@context'] !== 'https://schema.org') throw new Error(`${routePath}: JSON-LD block without schema.org @context`);
    n += 1;
  }
  return n;
}

// ── 1. Manifest (metadata only) ─────────────────────────────────────────────
const publicPaths = ssr.listPublicPaths();
const fileFor = (p) => `_prerender/${p === '/' ? 'index' : p.replace(/^\//, '')}.html`;
const manifest = {
  generatedAt: new Date().toISOString(),
  siteUrl: ssr.SITE_URL,
  appRoutes: ssr.APP_ROUTES.map((r) => r.pattern),
  routes: {},
  appHead: {},
  notFound: { head: ssr.renderHeadTags(metaFor('/__not-found__')), file: null },
};
let jsonLdBlocks = 0;
for (const p of publicPaths) {
  const m = metaFor(p);
  if (m.status !== 200 || !m.indexable) fail(`${p} is listed as public but has no metadata`);
  const head = ssr.renderHeadTags(m);
  jsonLdBlocks += validateJsonLd(head, p);
  manifest.routes[p] = { head, file: null };
}
for (const r of ssr.APP_ROUTES) {
  // One example path per pattern is enough to get the title; the head is keyed by pattern.
  const sample = r.pattern.replace(/^\^|\$$/g, '').replace(/\[\^\/\]\+/g, 'x');
  manifest.appHead[r.pattern] = ssr.renderHeadTags(metaFor(sample));
}
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const writeManifest = () => fs.writeFileSync(path.join(DIST, 'seo-manifest.json'), JSON.stringify(manifest, null, 1));
writeManifest();

// ── 2. Static HTML per public route ─────────────────────────────────────────
let failed = 0;
for (const p of publicPaths) {
  try {
    const body = ssr.render(p);
    if (!body || body.length < 500) throw new Error(`suspiciously small render (${body ? body.length : 0} bytes)`);
    const rel = fileFor(p);
    const out = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, page(manifest.routes[p].head, body));
    manifest.routes[p].file = rel;
  } catch (err) {
    failed += 1;
    console.warn(`prerender: could not render ${p} (${err.message}) - Express will inject the head into the shell for this route`);
  }
}
try {
  fs.writeFileSync(path.join(OUT_DIR, '404.html'), page(manifest.notFound.head, ssr.render('/__not-found__')));
  manifest.notFound.file = '_prerender/404.html';
} catch (err) {
  failed += 1;
  console.warn(`prerender: could not render the 404 page (${err.message})`);
}
writeManifest();

// ── 3. sitemap.xml and robots.txt ───────────────────────────────────────────
const buildDate = new Date().toISOString().slice(0, 10);
function lastmod(sources) {
  // Last commit touching the page's source files; build date when git is not available (Railway image).
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...sources], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch { /* no git */ }
  return buildDate;
}
const urls = publicPaths.map((p) => {
  const m = ssr.getRouteMeta(p);
  return `  <url><loc>${m.canonical}</loc><lastmod>${lastmod(m.sources)}</lastmod><priority>${m.priority.toFixed(1)}</priority></url>`;
});
fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);

fs.writeFileSync(path.join(DIST, 'robots.txt'), [
  'User-agent: *',
  'Allow: /',
  // Private app areas. /quote, /login and /register are deliberately NOT disallowed:
  // they carry a noindex tag, and a crawler has to be able to fetch a page to see it.
  'Disallow: /api/',
  'Disallow: /admin',
  'Disallow: /dashboard',
  'Disallow: /checkout/',
  'Disallow: /orders/',
  '',
  `Sitemap: ${ssr.SITE_URL}/sitemap.xml`,
  '',
].join('\n'));

const done = Object.values(manifest.routes).filter((r) => r.file).length;
console.log(`prerender: ${done}/${publicPaths.length} routes rendered, ${jsonLdBlocks} JSON-LD blocks valid, sitemap.xml (${urls.length} URLs), robots.txt, seo-manifest.json`);
if (failed && STRICT) process.exit(1);
