// Joins the editable copy (materialPages.js) with the generated catalog so a
// page only exists for a material the shop actually quotes. No React here:
// this module is also used to build page metadata, JSON-LD and the sitemap.
import catalog from './catalog.generated.json';
import brand from '../../../shared/brand.json';
import { MATERIAL_PAGES, FOOD_CONTACT_GENERAL } from './materialPages';
import { when, MILLING } from '../facts';

export { catalog };

const cncBySlug = Object.fromEntries(catalog.cnc.map((m) => [m.slug, m]));
const routingBySlug = Object.fromEntries(catalog.routing.map((m) => [m.slug, m]));

const PAGES = MATERIAL_PAGES
  .map((p) => ({ ...p, cnc: cncBySlug[p.cncSlug] || null, routing: routingBySlug[p.routingSlug] || null }))
  .filter((p) => p.cnc || p.routing);

export function getMaterialPages() {
  return PAGES;
}

export function getMaterialPage(slug) {
  return PAGES.find((p) => p.slug === slug) || null;
}

/** Page slug for a catalog material slug (cnc-delrin, rt-hdpe, ...), or null. */
export function pageSlugForCatalogSlug(catalogSlug) {
  const hit = PAGES.find((p) => p.cncSlug === catalogSlug || p.routingSlug === catalogSlug);
  return hit ? hit.slug : null;
}

/** Deep link into the quote builder with process + material preselected. */
export function quoteHref(process, materialSlug) {
  return `/quote?process=${encodeURIComponent(process)}&material=${encodeURIComponent(materialSlug)}`;
}

export function thicknessRange(routingMat) {
  const t = routingMat?.thicknesses || [];
  if (t.length === 0) return '';
  return t.length === 1 ? t[0].label : `${t[0].label} to ${t[t.length - 1].label}`;
}

const STOCK_FORM_LABEL = { plate: 'plate', rod: 'rod', sheet: 'sheet', bar: 'bar', tube: 'tube' };

export function processSentence(page) {
  const parts = [];
  if (page.cnc) {
    const forms = (page.cnc.stockForms || []).map((f) => STOCK_FORM_LABEL[f] || f).join(' and ');
    parts.push(`CNC ${MILLING}${forms ? ` from ${forms}` : ''}`);
  }
  if (page.routing) parts.push(`CNC routing from sheet ${thicknessRange(page.routing)} thick`);
  return parts.join(', and ');
}

/**
 * The FAQ shown on the page and emitted as FAQPage JSON-LD. Both read this
 * one function, so the structured data can never say something the page
 * does not. Answers are plain strings (no markup).
 */
export function buildFaqs(page) {
  const faqs = [];
  faqs.push({
    q: `What forms of ${page.shortName} do you quote online?`,
    a: `${processSentence(page)}. ${page.routing ? `Sheet thicknesses quoted online: ${page.routing.thicknesses.map((t) => t.label).join(', ')}. ` : ''}Other sizes and grades can be requested on a firm quote.`,
  });
  faqs.push({ q: `What tolerance is realistic on ${page.shortName}?`, a: page.toleranceAnswer });
  faqs.push({ q: `Is ${page.shortName} suitable for food contact?`, a: `${page.foodContact} ${FOOD_CONTACT_GENERAL}` });
  faqs.push({
    q: `How do I get a price for a part in ${page.shortName}?`,
    a: `Upload a STEP or STL file to the quote builder and choose ${page.name}. Quantities up to ${brand.rfqQuantityThreshold} pieces are priced online; larger quantities and parts that need review get a firm quote from a person${when('quote-turnaround', (v) => ` within ${v}`)}.`,
  });
  return faqs;
}
