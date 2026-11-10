/**
 * Route -> metadata map for every URL the site answers.
 *
 * One source of truth for <title>, meta description, canonical, robots,
 * Open Graph / Twitter tags and JSON-LD. It is read in three places:
 *   - at build time by scripts/seo/prerender.mjs (static HTML per public route,
 *     sitemap.xml, and dist/seo-manifest.json for the Express fallback),
 *   - in the browser by components/PublicLayout.jsx to keep the head in sync
 *     on client-side navigation,
 *   - indirectly by server/seo.js, which only string-replaces the head block
 *     using the manifest.
 *
 * No React and no DOM in this file.
 */
import brand from '../../../shared/brand.json';
import { SERVICES } from '../data/services';
import { getMaterialPages, getMaterialPage, buildFaqs, processSentence } from '../data/materials';

export const SITE_URL = brand.url.replace(/\/$/, ''); // https://straightedgemfg.com - the canonical host
export const DEFAULT_OG_IMAGE = '/brand/og-default.png'; // 1200x630, supplied by the brand work
export const HOME_TITLE = `${brand.name} — Machined Plastics, CNC Routing & 3D Printing · ${brand.region}`;

const abs = (path) => `${SITE_URL}${path === '/' ? '/' : path}`;
const pageTitle = (t) => `${t} · ${brand.name}`;

const ORG_ID = `${SITE_URL}/#organization`;
const BUSINESS_ID = `${SITE_URL}/#business`;
const WEBSITE_ID = `${SITE_URL}/#website`;

// Midwestern states the site sells into. TODO(owner): confirm the list (it is published as areaServed).
const AREA_SERVED = ['Illinois', 'Wisconsin', 'Indiana', 'Iowa', 'Michigan', 'Minnesota', 'Missouri', 'Ohio']
  .map((name) => ({ '@type': 'State', name }));

const SERVICE_NAMES = {
  machining: 'CNC machining of plastics',
  routing: 'CNC routing of plastic sheet and plate',
  '3d-printing': '3D printing (FDM and SLA)',
};

/** Organization + LocalBusiness. Only facts present in shared/brand.json. */
export function businessGraph() {
  const telephone = brand.phoneHref.replace(/^tel:/, '');
  const address = {
    '@type': 'PostalAddress',
    addressLocality: brand.city,
    addressRegion: brand.state,
    addressCountry: 'US',
    // TODO(owner): streetAddress and postalCode are not in shared/brand.json, so they are not published.
  };
  const organization = {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: brand.name,
    legalName: brand.legalName,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/brand/e3-light-mark.svg`,
    email: brand.email,
    telephone,
    foundingDate: String(brand.foundedYear),
    address,
    parentOrganization: { '@type': 'Organization', name: brand.parentName, url: brand.parentUrl },
  };
  const business = {
    '@type': 'LocalBusiness',
    '@id': BUSINESS_ID,
    name: brand.name,
    description: 'CNC machining and routing of engineering plastics (Delrin, UHMW, HDPE, nylon, PEEK), plus FDM and SLA 3D printing. Instant online quoting.',
    url: `${SITE_URL}/`,
    image: abs('/photos/tray-stack-edge.jpg'),
    telephone,
    email: brand.email,
    address,
    // TODO(owner): geo coordinates and opening hours are not in shared/brand.json; add them there to publish them.
    areaServed: AREA_SERVED,
    parentOrganization: { '@id': ORG_ID },
    makesOffer: Object.keys(SERVICE_NAMES).map((slug) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', '@id': `${SITE_URL}/${slug}#service`, name: SERVICE_NAMES[slug], url: abs(`/${slug}`) },
    })),
  };
  return [organization, business];
}

function websiteNode() {
  return { '@type': 'WebSite', '@id': WEBSITE_ID, url: `${SITE_URL}/`, name: brand.name, publisher: { '@id': ORG_ID } };
}

function breadcrumb(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(path) })),
  };
}

function webPage(path, title, description) {
  return { '@type': 'WebPage', '@id': `${abs(path)}#webpage`, url: abs(path), name: title, description, isPartOf: { '@id': WEBSITE_ID }, about: { '@id': BUSINESS_ID } };
}

function serviceNode(slug) {
  const s = SERVICES[slug];
  return {
    '@type': 'Service',
    '@id': `${SITE_URL}/${slug}#service`,
    name: SERVICE_NAMES[slug],
    serviceType: SERVICE_NAMES[slug],
    description: s.description,
    url: abs(`/${slug}`),
    provider: { '@id': BUSINESS_ID },
    areaServed: AREA_SERVED,
  };
}

const graph = (nodes) => [{ '@context': 'https://schema.org', '@graph': nodes }];

// ─── Static public pages ───────────────────────────────────────────────────
// `sources` are the files whose last commit date becomes <lastmod> in the sitemap.
const STATIC = {
  '/': {
    fullTitle: HOME_TITLE,
    ogTitle: `${brand.name} — Machined plastic parts, one to a few thousand`,
    description: `Machined plastic parts from ${brand.city}, Illinois. CNC milling, turning and routing in Delrin, UHMW, HDPE, nylon, PEEK and 6061, plus FDM and SLA printing. Instant online pricing; firm quotes in ${brand.quoteTurnaroundHours} hours.`,
    priority: 1.0,
    sources: ['client/src/pages/LandingPage.jsx'],
    jsonLd: (m) => graph([...businessGraph(), websiteNode(), webPage('/', m.title, m.description)]),
  },
  '/materials': {
    title: 'Plastic Materials for CNC Machining & Routing',
    description: `Engineering plastics we machine and route in ${brand.city}, Illinois: Delrin, UHMW, HDPE, nylon, PEEK, Ultem, PTFE, polycarbonate, acrylic, PVC, polypropylene, G-10 and phenolic, plus 6061 and brass.`,
    priority: 0.8,
    sources: ['client/src/pages/MaterialsPage.jsx', 'server/config/defaults.js'],
    jsonLd: (m) => graph([...businessGraph(), webPage('/materials', m.title, m.description), breadcrumb([['Home', '/'], ['Materials', '/materials']])]),
  },
  '/quality': {
    title: 'Quality & Inspection',
    description: `How ${brand.name} inspects machined plastic parts: first-article reports, certificates of conformance, material certs, traceability, and a documented path to ISO 9001.`,
    priority: 0.7,
    sources: ['client/src/pages/QualityPage.jsx'],
    jsonLd: (m) => graph([...businessGraph(), webPage('/quality', m.title, m.description), breadcrumb([['Home', '/'], ['Quality', '/quality']])]),
  },
  '/about': {
    title: `About ${brand.name}`,
    fullTitle: `About ${brand.name} · Plastics Machining in ${brand.city}, ${brand.state}`,
    description: `${brand.name} is the plastics machining division of ${brand.parentName}, a fabrication and engineering shop in ${brand.city}, Illinois, running since ${brand.foundedYear}.`,
    priority: 0.6,
    sources: ['client/src/pages/AboutPage.jsx', 'shared/brand.json'],
    jsonLd: (m) => graph([...businessGraph(), { ...webPage('/about', m.title, m.description), '@type': 'AboutPage' }, breadcrumb([['Home', '/'], ['About', '/about']])]),
  },
  '/rfq': {
    title: 'Request a Firm Quote',
    description: `Request a firm quote from ${brand.name} for production quantities of machined plastic parts. Quotes within ${brand.quoteTurnaroundHours} hours.`,
    priority: 0.5,
    sources: ['client/src/pages/RfqPage.jsx'],
    jsonLd: (m) => graph([...businessGraph(), webPage('/rfq', m.title, m.description), breadcrumb([['Home', '/'], ['Request a firm quote', '/rfq']])]),
  },
};

for (const slug of Object.keys(SERVICES)) {
  const s = SERVICES[slug];
  STATIC[`/${slug}`] = {
    title: s.metaTitle,
    description: s.description,
    priority: slug === '3d-printing' ? 0.8 : 0.9,
    sources: ['client/src/data/services.js', 'client/src/pages/ServicePage.jsx'],
    jsonLd: (m) => graph([...businessGraph(), serviceNode(slug), webPage(`/${slug}`, m.title, m.description), breadcrumb([['Home', '/'], [s.title, `/${slug}`]])]),
  };
}

function materialMeta(page) {
  const path = `/materials/${page.slug}`;
  const faqs = buildFaqs(page);
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    priority: 0.7,
    sources: ['client/src/data/materialPages.js', 'client/src/pages/MaterialPage.jsx', 'server/config/defaults.js'],
    jsonLd: (m) => graph([
      ...businessGraph(),
      {
        ...webPage(path, m.title, m.description),
        mainEntity: {
          '@type': 'Service',
          name: `${page.name} machining`,
          serviceType: `Custom machined ${page.shortName} parts`,
          description: `${processSentence(page)}.`,
          provider: { '@id': BUSINESS_ID },
          areaServed: AREA_SERVED,
        },
      },
      breadcrumb([['Home', '/'], ['Materials', '/materials'], [page.name, path]]),
      // FAQPage mirrors the visible "Common questions" section on the page (same buildFaqs()).
      { '@type': 'FAQPage', '@id': `${abs(path)}#faq`, mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ]),
  };
}

// ─── App routes: client-rendered, never indexed ────────────────────────────
// Patterns are also exported to the server (via the manifest) so Express can
// tell a deep link into the app from a URL that does not exist.
export const APP_ROUTES = [
  { pattern: '^/quote$', title: 'Instant Quote' },
  { pattern: '^/login$', title: 'Sign In' },
  { pattern: '^/register$', title: 'Create Account' },
  { pattern: '^/admin$', title: 'Admin' },
  { pattern: '^/dashboard$', title: 'My Orders' },
  { pattern: '^/checkout/[^/]+$', title: 'Checkout' },
  { pattern: '^/orders/[^/]+$', title: 'Order' },
  { pattern: '^/orders/[^/]+/traveler$', title: 'Job Traveler' },
  { pattern: '^/rfq/[^/]+$', title: 'Request a Firm Quote' },
];

export function normalizePath(pathname) {
  const p = (pathname || '/').split('?')[0].split('#')[0];
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
}

function finish(path, def, { ogImage } = {}) {
  const title = def.fullTitle || pageTitle(def.title);
  const m = {
    path,
    status: 200,
    indexable: true,
    title,
    description: def.description,
    canonical: abs(path),
    robots: 'index, follow',
    ogTitle: def.ogTitle || title,
    ogImage: abs(ogImage || DEFAULT_OG_IMAGE),
    priority: def.priority,
    sources: def.sources || [],
  };
  m.jsonLd = def.jsonLd ? def.jsonLd(m) : [];
  return m;
}

/**
 * Metadata for any pathname. Always returns an object:
 *   status 200 + indexable      -> public page
 *   status 200 + !indexable     -> app route (noindex shell)
 *   status 404                  -> unknown URL
 */
export function getRouteMeta(pathname, opts = {}) {
  const path = normalizePath(pathname);

  if (STATIC[path]) return finish(path, STATIC[path], opts);

  const mat = path.match(/^\/materials\/([^/]+)$/);
  if (mat) {
    const page = getMaterialPage(mat[1]);
    if (page) return finish(path, materialMeta(page), opts);
  }

  const app = APP_ROUTES.find((r) => new RegExp(r.pattern).test(path));
  if (app) {
    return {
      path, status: 200, indexable: false,
      title: pageTitle(app.title),
      description: '',
      canonical: null,
      robots: 'noindex, follow',
      ogTitle: pageTitle(app.title),
      ogImage: abs(opts.ogImage || DEFAULT_OG_IMAGE),
      jsonLd: [],
    };
  }

  return {
    path, status: 404, indexable: false,
    title: pageTitle('Page not found'),
    description: '',
    canonical: null,
    robots: 'noindex, follow',
    ogTitle: pageTitle('Page not found'),
    ogImage: abs(opts.ogImage || DEFAULT_OG_IMAGE),
    jsonLd: [],
  };
}

/** Every indexable URL, in sitemap order. */
export function listPublicPaths() {
  return [
    '/', '/machining', '/routing', '/3d-printing', '/materials',
    ...getMaterialPages().map((p) => `/materials/${p.slug}`),
    '/quality', '/about', '/rfq',
  ];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The replaceable block of <head>: everything that differs per URL. */
export function renderHeadTags(m) {
  const out = [];
  out.push(`<title>${esc(m.title)}</title>`);
  if (m.description) out.push(`<meta name="description" content="${esc(m.description)}" />`);
  out.push(`<meta name="robots" content="${esc(m.robots)}" />`);
  if (m.canonical) out.push(`<link rel="canonical" href="${esc(m.canonical)}" />`);
  out.push('<meta property="og:type" content="website" />');
  out.push(`<meta property="og:site_name" content="${esc(brand.name)}" />`);
  out.push('<meta property="og:locale" content="en_US" />');
  out.push(`<meta property="og:title" content="${esc(m.ogTitle || m.title)}" />`);
  if (m.description) out.push(`<meta property="og:description" content="${esc(m.description)}" />`);
  if (m.canonical) out.push(`<meta property="og:url" content="${esc(m.canonical)}" />`);
  if (m.ogImage) {
    out.push(`<meta property="og:image" content="${esc(m.ogImage)}" />`);
    if (m.ogImageWidth) out.push(`<meta property="og:image:width" content="${m.ogImageWidth}" />`);
    if (m.ogImageHeight) out.push(`<meta property="og:image:height" content="${m.ogImageHeight}" />`);
  }
  out.push('<meta name="twitter:card" content="summary_large_image" />');
  out.push(`<meta name="twitter:title" content="${esc(m.ogTitle || m.title)}" />`);
  if (m.description) out.push(`<meta name="twitter:description" content="${esc(m.description)}" />`);
  if (m.ogImage) out.push(`<meta name="twitter:image" content="${esc(m.ogImage)}" />`);
  for (const block of m.jsonLd || []) {
    // "<" is escaped so the JSON can never close the script element.
    out.push(`<script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>`);
  }
  return out.join('\n    ');
}
