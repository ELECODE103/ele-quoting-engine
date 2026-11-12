# syntax=docker/dockerfile:1
#
# Straightedge — the production image.
#
# Railway builds this file because it is named "Dockerfile" at the root of the
# repository (its build log then says "Using detected Dockerfile!"). Nothing in
# the build depends on Nixpacks, Railpack, or on railway.toml being read.
#
# Three stages:
#   prod-deps  the server's production dependencies only (npm ci, from the lockfile)
#   build      the client: vite build + prerender of the public pages
#   runtime    Node, the server, its production dependencies and the built client
#
# The data folder (/app/data: database, uploads, drawings, part previews) is
# NOT in the image. It is the Railway volume, mounted when the container
# starts; .dockerignore keeps any local data/ out of the build altogether.
#
# Node version: 20.20.2 is the last release of the Node 20 line, the version
# the test suite is run on. Node 20 left security support on 2026-04-30; moving
# to Node 22 is a decision for the owner (docs/launch/deploy-notes-2026-11-11.md).
# To pin by digest as well, replace the tag below with
#   node:20.20.2-bookworm-slim@sha256:<digest>
# where <digest> is printed by: docker buildx imagetools inspect node:20.20.2-bookworm-slim

# ─── base ────────────────────────────────────────────────────
FROM node:20.20.2-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ─── production dependencies of the server ───────────────────
FROM base AS prod-deps
COPY package.json package-lock.json ./
# --ignore-scripts: the root "postinstall" installs the client's dev tools, which the
# runtime image must not contain. No server dependency needs an install script
# (sql.js and occt-import-js ship their .wasm files; nothing is compiled).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─── client build + prerender ────────────────────────────────
FROM base AS build
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
# The client's build tools (vite, esbuild) are devDependencies and esbuild needs its install script.
RUN cd client && npm ci --include=dev && npm cache clean --force
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
COPY client ./client
# The same two steps as `npm run build`, without its repeated client install:
#   1. the public materials catalog, from server/config/defaults.js
#   2. vite build, then scripts/seo/build-static.mjs (SSR bundle → one HTML file per public route,
#      sitemap.xml, robots.txt, seo-manifest.json)
ENV NODE_ENV=production
RUN node scripts/seo/gen-catalog.js \
 && cd client && npm run build \
 && test -f dist/index.html && test -f dist/seo-manifest.json && test -f dist/sitemap.xml

# ─── runtime ─────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY scripts/ops ./scripts/ops
# The admin pricing console prices six reference parts read from here (server/services/pricingPreview.js).
COPY tools/vet-quotes/parts ./tools/vet-quotes/parts
COPY --from=build /app/client/dist ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Fail the build, not the deploy, if a piece the server loads at run time is missing:
# the two WebAssembly modules (database, STEP/IGES reader), the parse worker, the prerendered pages.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && test -f node_modules/sql.js/dist/sql-wasm.wasm \
 && test -f node_modules/occt-import-js/dist/occt-import-js.wasm \
 && test -f server/parsers/parseWorker.js \
 && test -f client/dist/seo-manifest.json \
 && test ! -e node_modules/vite && test ! -e node_modules/concurrently && test ! -e client/node_modules \
 && mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000
# Railway uses the health check path set in the service settings (/api/health), not this line;
# this one is for `docker run` and any other host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The container starts as root only so the entrypoint can make the root-owned Railway volume
# writable; it then runs the server as the unprivileged "node" user (uid 1000) and never as root.
# No USER line on purpose: with one, Railway's documented workaround is RAILWAY_RUN_UID=0, which
# runs the server itself as root. See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
# node directly, not `npm start`: the server must be the process that receives SIGTERM (server/ops/shutdown.js).
CMD ["node", "server/index.js"]
