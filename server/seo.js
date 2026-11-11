/**
 * Serves the built client with correct HTTP semantics for crawlers:
 *
 *   - 301 to the canonical host (www -> apex) and from legacy / non-canonical paths
 *   - per-route static HTML for public pages (client/dist/_prerender, written at
 *     build time by scripts/seo/prerender.mjs)
 *   - if a route's prerendered file is missing, the SPA shell with that route's
 *     own <title>/description/canonical/OG/JSON-LD injected from seo-manifest.json
 *   - the SPA shell with `noindex` for app routes (/quote, /login, /admin, ...)
 *   - a real 404 status for everything else (the SPA shows its not-found page)
 *   - long-lived caching for content-hashed assets, short for the rest, none for HTML
 *
 * If the manifest is absent (prerender step failed or was skipped) it degrades
 * to the old behaviour: the shell for every non-file URL, status 200.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const brand = require("../shared/brand.json");

const CANONICAL_HOST = brand.domain; // straightedgemfg.com

// Old or guessable URLs -> where they live now. Add to this as old links turn up
// in Search Console. (No previous public URL scheme was found in the repo history,
// so these are aliases, not known inbound links.)
const LEGACY_REDIRECTS = {
  "/index.html": "/",
  "/home": "/",
  "/cnc": "/machining",
  "/cnc-machining": "/machining",
  "/services": "/machining",
  "/cnc-routing": "/routing",
  "/printing": "/3d-printing",
  "/3d-print": "/3d-printing",
  "/material": "/materials",
  "/materials/delrin": "/materials/acetal-delrin",
  "/materials/acetal": "/materials/acetal-delrin",
  "/materials/uhmw-pe": "/materials/uhmw",
  "/materials/ultem": "/materials/ultem-pei",
  "/materials/pei": "/materials/ultem-pei",
  "/materials/teflon": "/materials/ptfe",
  "/materials/pmma": "/materials/acrylic",
  "/contact": "/about",
  "/instant-quote": "/quote",
  "/quote-builder": "/quote",
  "/request-quote": "/rfq",
};

const HEAD_RE = /<!--seo:head-->[\s\S]*?<!--\/seo:head-->/;

/**
 * Files under client/public/brand that are working material, not the site:
 * the brand guide, the kit and review sheets (HTML, their PDF and their page
 * renderings), the notes beside them, and the sample customer documents. They
 * ship in the build because the brand scripts write them there, but the live
 * site does not serve them: these answer 404.
 *
 * Everything else under /brand stays public, because pages use it: the logo
 * SVGs, the icons the web manifest names, the Open Graph images (/brand/og,
 * og-default.png) and the social and machine artwork.
 */
const INTERNAL_BRAND_PAGE_IMAGES = /^(brand-guide|kit-sheet|review-sheet(-\d+)?)\.png$/;
function isInternalBrandPath(urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath || "")); } catch { return false; } // malformed encoding: not a file we serve anyway
  p = path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase();
  if (!p.startsWith("/brand/")) return false;
  const rest = p.slice("/brand/".length).replace(/\/+$/, "");
  if (rest === "documents" || rest.startsWith("documents/")) return true;        // sample quote, order confirmation, packing slip, CoC, FAI
  if (/\.(html?|md|pdf)$/.test(rest)) return true;                                // the internal pages, their notes and PDFs, at any depth
  return INTERNAL_BRAND_PAGE_IMAGES.test(rest);                                   // pictures of those pages
}

function loadManifest(distDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(distDir, "seo-manifest.json"), "utf8"));
    m.appRoutes = (m.appRoutes || []).map((src) => ({ src, re: new RegExp(src) }));
    return m;
  } catch {
    return null;
  }
}

function normalize(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : "/";
}

/**
 * @param {string} distDir absolute path to client/dist
 * @returns {import("express").Router}
 */
function createSeoRouter(distDir) {
  const router = express.Router();
  const shellPath = path.join(distDir, "index.html");
  const shell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, "utf8") : null;
  const manifest = loadManifest(distDir);

  if (!shell) console.warn("[seo] client/dist/index.html not found - run `npm run build`");
  else if (!manifest) console.warn("[seo] seo-manifest.json not found - serving the client-rendered shell for every URL (no per-route HTML, no 404s)");
  else {
    const n = Object.values(manifest.routes).filter((r) => r.file).length;
    console.log(`[seo] ${n}/${Object.keys(manifest.routes).length} public routes prerendered; canonical host ${CANONICAL_HOST}`);
  }

  const withHead = (head) => shell.replace(HEAD_RE, () => `<!--seo:head-->\n    ${head}\n    <!--/seo:head-->`);
  const sendHtml = (res, status, html, { noindex } = {}) => {
    res.status(status);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-cache"); // always revalidate HTML so a deploy is picked up at once
    if (noindex) res.set("X-Robots-Tag", "noindex");
    res.send(html);
  };

  // 1. Canonical host: www.straightedgemfg.com/* -> https://straightedgemfg.com/*
  router.use((req, res, next) => {
    const host = (req.hostname || "").toLowerCase();
    if (host === `www.${CANONICAL_HOST}`) return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    next();
  });

  // 2. Legacy paths, trailing slashes and mixed case -> one URL per page
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/assets/")) return next();
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    const clean = normalize(req.path);
    const lower = clean.toLowerCase();
    const target = LEGACY_REDIRECTS[lower];
    if (target) return res.redirect(301, target + qs);
    // Public pages are lower-case; /Materials/PEEK -> /materials/peek. App routes carry case-sensitive ids, leave them.
    if (manifest && lower !== clean && manifest.routes[lower]) return res.redirect(301, lower + qs);
    if (clean !== req.path) return res.redirect(301, clean + qs);
    next();
  });

  // 3. Static files. `index: false` so "/" goes through the route handler below,
  //    `redirect: false` so a directory name never turns into a 301 to "dir/".
  router.use("/_prerender", (req, res) => res.status(404).type("text/plain").send("Not found"));
  // Internal brand pages and the sample documents are not part of the live site.
  router.use((req, res, next) => {
    if (isInternalBrandPath(req.path)) return res.status(404).set("X-Robots-Tag", "noindex").type("text/plain").send("Not found");
    next();
  });
  router.use(express.static(distDir, {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      const rel = path.relative(distDir, filePath).split(path.sep).join("/");
      if (rel.startsWith("assets/")) {
        // Vite puts a content hash in every file name under /assets: safe to cache forever.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.(html|xml|txt|json)$/.test(rel)) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        // Photos, brand SVGs, favicon: not hashed, so a week plus revalidation.
        res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
      }
    },
  }));

  // 4. Pages
  router.get("*", (req, res, next) => {
    if (!shell) return next();
    if (req.path.startsWith("/api/")) return next();

    // A missing file (has an extension) is a plain 404, never the HTML shell.
    if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).type("text/plain").send("Not found");

    if (!manifest) return sendHtml(res, 200, shell);

    const p = normalize(req.path);

    const pub = manifest.routes[p];
    if (pub) {
      if (pub.file) {
        res.set("Cache-Control", "no-cache");
        return res.sendFile(path.join(distDir, pub.file), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return sendHtml(res, 200, withHead(pub.head)); // prerender missing for this route: head only
    }

    const appRoute = manifest.appRoutes.find((r) => r.re.test(p));
    if (appRoute) return sendHtml(res, 200, withHead(manifest.appHead[appRoute.src] || ""), { noindex: true });

    if (manifest.notFound.file) {
      res.status(404).set("X-Robots-Tag", "noindex").set("Cache-Control", "no-cache");
      return res.sendFile(path.join(distDir, manifest.notFound.file), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return sendHtml(res, 404, withHead(manifest.notFound.head), { noindex: true });
  });

  return router;
}

module.exports = { createSeoRouter, LEGACY_REDIRECTS, CANONICAL_HOST, isInternalBrandPath };
