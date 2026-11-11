# Server hardening before launch — 2026-11-11

Branch `hardening-server`, cut from `revisions-2026-11-11` (9ebc5c8). Scope: dependencies, uploads
and parsing, request limits and rate limits, browser policy, the data layer and the routes around
it, files at rest. Accounts, sign-in, bot checks, forms and email are the other engineer's branch;
what was found there is listed in section 9 and was not changed.

Nothing in pricing, DFM rules or geometry was changed. `tools/vet-quotes/run_vetting.js` was run
against the base commit and against this branch: 300 quotes, 0 fails, 63 warnings on both, and the
two `results.csv` files are identical except for the random quote-id column.

## 1. Summary

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | 11 npm advisories in the production tree (2 critical, 6 high); 2 high in the client | High | Fixed — 0 / 0 |
| 2 | CAD files parsed on the main thread: one file stalls the whole site (measured 10 s to over a minute) | Critical | Fixed — worker pool with time and memory limits |
| 3 | No ceiling on model size; ZIP / XML bombs in 3MF only partly guarded | High | Fixed |
| 4 | A file that failed to parse stayed on disk for a week; content checks for STL and IGES accepted almost anything | Medium | Fixed |
| 5 | Upload folders and the database could grow without limit; drawings were never cleaned up | High | Bounded (ceilings, budgets, sweep) — recovery is manual, see open item O1 |
| 6 | 50 MB JSON bodies accepted on every route | High | Fixed — 1 MB |
| 7 | Rate limits: pricing shared the general budget; IPv6 clients could rotate addresses; expensive routes had none | Medium | Fixed |
| 8 | CSP allowed inline and eval script; Google Fonts and Stripe hosts no page uses | High | Fixed — proven in a browser, 0 violations |
| 9 | SQLite text truncated at a NUL byte (an email could be stored as a different address) | High | Fixed |
| 10 | Column names fell back to "allow all" if the table could not be read; non-scalar ids reached the driver | Low | Fixed |
| 11 | Quote bodies: unbounded number of lines, untyped fields | Medium | Fixed |
| 12 | A blank lead-time multiplier in admin stored NULL and broke pricing; finishes untyped | Medium | Fixed |
| 13 | A DXF's units could be changed after the part was on an order (changes the size on the traveler) | Medium | Fixed |
| 14 | Signed firm-quote links and query strings written to the error log | Medium | Fixed |
| 15 | CORS trusted `http://localhost:3000/3001` in production | Low | Fixed |
| 16 | Hand-built `Content-Disposition` from the customer's file name on encrypted downloads | Low | Fixed |
| 17 | File encryption: quote drawings and RFQ attachments were never encrypted; a changed key gave a bare cipher error; whole file read into memory on the request path | Medium | Fixed; still **off** in production until the owner sets the key |
| O1–O9 | Open items | see section 10 | Open |

Tests: `npm test` 35 suites (25 before, all still passing; 10 added, 84 new cases), on Node 22 and
on Node 20.20 (the production runtime). `npm run build` under `NODE_ENV=production`: 22/22 routes.

## 2. Dependencies

**What was wrong.** `npm audit --omit=dev` on the base commit: 11 advisories (2 critical, 6 high,
3 moderate) for the server; 2 high for the client (react-router).

**Fix.**

| Package | Was | Now | Note |
|---|---|---|---|
| adm-zip | 0.5.18 | 0.6.1 | Breaking. Changelog read in the package source: inflation is capped at the declared size (including a declared size of 0), repeated entry names throw, async errors are routed. Behaviour proven by tests: a valid 3MF reads to the same geometry; a repeated name is refused in our words, not the library's |
| multer | 2.1.1 | 2.5.0 | Field-name and aborted-upload DoS fixes. Limits on fields, parts and header pairs added on top |
| express | 4.18 | 4.22.3 | Brings body-parser 1.20.9, qs 6.16.2, proxy-addr 2.0.8, path-to-regexp 0.1.13 |
| fast-xml-parser | 5.5.9 | 5.12.0 | fast-xml-builder 1.3.1. Entity expansion is now switched off and nesting capped in our call |
| uuid | 9.0.1 | removed | `crypto.randomUUID()` in the four files that used it (same v4 format; the server's own `isValidUUID` accepts it) |
| concurrently | dependency | devDependency | With it, lodash and shell-quote leave the production tree |
| react-router-dom (client) | 7.13 | 7.18.5 | |

The proxy-addr advisory concerns trust lists written as subnets; this app trusts by hop count
(`trust proxy` = 1), so it was probably not reachable here. It is upgraded regardless, and a test
shows that with one trusted hop a client-supplied `X-Forwarded-For` entry is never taken as the
client address. (The advisory pages could not be fetched from this environment; the judgement is
from the package's own changelog and source.)

**Railway build.** `railway.toml`: `npm install`, then `npm run build`, start `npm start`,
`.node-version` 20. Simulated from a clean tree with `NODE_ENV=production`: `npm install` skips
devDependencies (no `concurrently`), the `postinstall` runs `npm ci --include=dev` in `client/`, the
build prerenders 22/22 routes, and `npm audit --omit=dev` is clean. Nothing in the build uses
`concurrently` (only `npm run dev` and `start.bat`).

**Final audit output.**

```
$ npm audit --omit=dev            (server)
found 0 vulnerabilities
$ npm audit                       (server, including dev)
found 0 vulnerabilities
$ cd client && npm audit --omit=dev
found 0 vulnerabilities
$ cd client && npm audit          (including dev)
esbuild  <=0.24.2        Severity: moderate   GHSA-67mh-4wv8-2f99
vite  <=6.4.3            Depends on vulnerable versions of esbuild
2 vulnerabilities (1 moderate, 1 high)   fix: vite@8 (breaking)
```

**Accepted.** The two client advisories are in Vite and esbuild, which are build tools. Every
advisory in them is about the development server (`vite dev`): other sites reading its responses,
file-serving rules, the "open in editor" helper. The development server never runs in production;
`vite build` output contains none of that code. Not reachable on the live site. Upgrading Vite two
major versions the day before launch risks the build for no production gain; it is open item O8.
There are no accepted advisories in the production trees.

**Tests.** `server/security/dependencies.test.js` (6).

## 3. Uploads and parsing

### 3.1 Parsing blocked the whole server

**Evidence** (base commit, this machine, main thread):

| File | Size | Time the server answered nothing |
|---|---|---|
| STEP plate, 400 holes (`server/security/fixtures/plate_400_holes.step.gz`) | 2.0 MB | 10.3 s, process memory 529 MB |
| STL sphere, 30,000 triangles | 1.5 MB | 4.8 s |
| STL sphere, 100,000 triangles | 5.0 MB | 62.9 s |
| DXF, 5,000 crossing lines | 0.48 MB | 25.6 s |
| DXF, 2,000 crossing lines | 0.19 MB | 2.1 s |

The STEP "30-second timeout" in `parseSTEP` never fired: it races a promise against a synchronous
call. `POST /api/upload` is anonymous, so anyone could hold the site down with one small file, and
an ordinary customer with a dense STL did it by accident.

**Fix.** `server/parsers/parsePool.js` and `parseWorker.js`: every parse runs in a worker thread.

- Concurrency limit (`PARSE_CONCURRENCY`, 2) and a bounded queue (`PARSE_QUEUE_MAX`, 8;
  `PARSE_QUEUE_WAIT_MS`, 30 s). Past either, the answer is HTTP 503 with `Retry-After` and
  "We're reading a lot of files right now. Give it a minute and upload this one again."
- One running parse per client address (`PARSE_PER_CLIENT`), so one sender cannot hold every worker.
- Wall-clock timeout per file (`PARSE_TIMEOUT_MS`, 60 s): the worker is terminated and the customer
  is told the model is too slow for the instant quote and offered a firm quote.
- Memory: V8 heap limit per worker (`resourceLimits`, `PARSE_MAX_HEAP_MB`, 768) and a watchdog on
  the memory parsing adds to the process (`PARSE_RSS_LIMIT_MB`, 1024), because WASM and typed-array
  memory is outside V8's heap limit.
- If the client disconnects, its parse is cancelled and its files are deleted.
- Workers stay warm for small files (a cold STEP parse costs about a second more) and are retired
  after a large or slow file, 25 jobs, any timeout or crash, or a minute idle.

**Same results.** The parser and DFM code are pure (no database, no pricing rules). A test compares
the worker's output with the main thread's for STL, STEP, IGES, DXF and 3MF: identical apart from
the recogniser's own stopwatch fields.

**Evidence after.**

- Pool test: 2 MB STEP parsed in 7.9 s in a worker; worst main-thread timer lag 9 ms (30 ms on Node 20).
- Live server: the same upload took 8.7–11.7 s; `/api/health` polled every 50 ms throughout answered
  150–200 times, median 2–5 ms, worst 25–50 ms while parsing.
- Live server: a 480 kB crossing-lines DXF is cut off at the timeout; meanwhile health and catalog
  answer in under 300 ms and a second sender gets 503 `busy` with `Retry-After`.

**Tests.** `server/parsers/parsePool.test.js` (13), `server/security/uploads.test.js` (the two
responsiveness cases).

### 3.2 Caps

All in `server/security/limits.js`, each with an environment override (section 8).

- Per file 50 MB (was 100), 10 files per request (was 20), multipart fields / parts / header pairs
  bounded. A request whose `Content-Length` exceeds what the route could legitimately receive is
  refused without reading the body.
- Per client address: 500 MB of uploads per rolling 24 hours (CAD files, quote drawings, RFQ
  attachments together). Refused bytes count too.
- Triangle ceiling 500,000 (STL, 3MF, tessellated STEP/IGES); DXF 100,000 entities (was a fixed
  250,000; the parser's 120,000-curve and 5,000-contour limits remain). The message names the count
  and the limit and offers a firm quote (`code: "model-too-large"`, `offerRfq: true`).
- STL: the header's triangle count is checked against the ceiling and against the bytes actually
  present before anything is allocated.
- 3MF (`server/parsers/zipGuard.js`), judged from the ZIP directory before anything is unpacked:
  at most 1,000 entries, 256 MB declared in total, 64 MB for the model entry, 100:1 compression
  ratio; encrypted entries and repeated names (including names differing only in case) refused.
  The one entry that is read inflates to at most its declared size (adm-zip 0.6.1), which has
  already been held to 64 MB. ZIP64 archives are still accepted (some 3MF writers always produce
  them; both ZIP64 forms are tested).
- 3MF XML: nesting capped at 32 levels, entity expansion off, component reference loops refused,
  triangles counted in the text before the XML becomes an object tree.

**Tests.** `uploads.test.js`: a 300 MB bomb that is 300 kB on the wire is refused in under 3 s;
a directory that understates the size; declared size 0; 5,001 entries; a 200 MB side entry; a
duplicated model; billion-laughs; 500-deep nesting; a component loop; over-ceiling STL (binary and
ASCII), 3MF by instancing, and DXF. `guards.test.js`: the ZIP pre-flight by error code.

### 3.3 Content checks, names and paths

**Verified.** Stored names are server-generated (UUID plus an extension from the allow-list); the
destination folder is fixed; no client string reaches a path. `../../../evil.stl`, backslash and
absolute paths, encoded dots and a right-to-left override in the name all end up under
`data/uploads` with a UUID name; the test lists the whole data tree to prove nothing was written
elsewhere.

**Found and fixed.**

- The STL check passed any file of 84 bytes or more; it now checks binary STL arithmetic (count ×
  50 + 84 against the file size) or an ASCII `solid … facet`. The IGES check passed any text
  containing `"S "`; it now checks the 80-column record and its section letter. A PNG, a STEP, a
  DWG, a ZIP renamed to the wrong extension are refused with `code: "content-mismatch"` and deleted.
- **A file that failed to parse was left on disk** until the 7-day sweep. Now every file a request
  wrote and did not hand to a part record is deleted before the answer is sent: parse failure,
  timeout, busy, wrong process for a DXF, client gone.
- The customer's file name is kept as a label only (`safeFileName`): last path segment, no control
  or bidi characters, no quotes or angle brackets, 255 characters.
- A malformed multipart body answered 500 and logged a stack; it now answers 400.

**Quote drawing** (`POST /api/quote/:id/drawing`, in scope): who may attach was already decided
before the file is accepted, and stays so; the storage ceiling and the daily budget now apply
first; a non-PDF is deleted before the answer goes out; a replaced or removed drawing is deleted
unless an order, a request or another quote still points at it (it used to be left for ever, so
re-attaching in a loop grew the disk without limit); 20 per hour per address; stored encrypted
when a key is set.

**RFQ attachment** (`server/routes/rfq.js`, reviewed; four one-line edits made, the rest reported):

- Edited: uuid import, folder from the shared data directory, encryption on store, download through
  the shared helper.
- Reported, not fixed (more than a line): see section 9, R1–R3.

**Tests.** `uploads.test.js` (15 cases).

### 3.4 Disk and database growth

**Verified.** The upload sweep removes files older than `UPLOAD_RETENTION_HOURS` (168) unless the
part is on a live order or an open RFQ. Row retention removes lapsed draft quotes and parts nothing
refers to. Neither covered the drawing folders, and neither is a bound under abuse: files and rows
referenced by a draft quote (30-day hold) or an open RFQ stay.

**Fix.**

- Hard ceiling on `data/uploads` + `data/quote-drawings` + `data/rfq-drawings` together
  (`UPLOAD_DIR_MAX_MB`, 2048). At 80% a warning is logged. At the ceiling new files are refused
  before they are written — HTTP 503, "We can't take new files right now. Email them to … or call …"
  — and `UPLOAD STORAGE FULL: … Raise UPLOAD_DIR_MAX_MB, shorten UPLOAD_RETENTION_HOURS, or clear
  old files` is logged (at most once a minute). Applied to the CAD upload, the quote drawing and,
  from `index.js`, the RFQ form.
- Ceiling on the database file (`DB_MAX_MB`, 256) for uploads, because each upload adds a geometry
  row. Measured: one dense STL adds a 3.3 MB row; every write rewrites the whole file and blocks the
  server for about 2 ms per MB (17 ms at 10 MB, 204 ms at 100 MB, 375 ms at 200 MB); process memory
  runs at roughly five times the file. See open item O1.
- Drawing sweep: files in the two drawing folders that no quote, order or request refers to are
  removed after 24 hours (startup and every six hours). This also clears attachments left by
  refused RFQ requests.

**Tests.** `uploads.test.js` (storage ceiling on upload and RFQ, daily budget, forged
`X-Forwarded-For`), `guards.test.js` (budget arithmetic, `admit()` on Content-Length, database
ceiling, drawing sweep).

## 4. Request limits and rate limits

**Body size.** `express.json` and `urlencoded` accepted 50 MB on every route, including sign-in. The
largest JSON any route receives is a quote configuration of a few kB (files go through multer). Now
1 MB for JSON (`JSON_BODY_LIMIT_KB`), 100 kB for urlencoded with flat parsing (no route uses it). No
route needed a higher limit, so none was raised.

**Keys.** Every limiter now uses one client key (`server/security/clientKey.js`): the address
Express derives from `X-Forwarded-For` after one trusted hop, with IPv4-mapped IPv6 folded to IPv4
and IPv6 clients grouped by /64 (one IPv6 customer owns 2^64 addresses; the default key let them
rotate). `TRUST_PROXY_HOPS` (default 1) replaces the hard-coded 1 — see open item O4.

**Limiters.**

| Route | Limit per client | Override | Change |
|---|---|---|---|
| `/api/*` general | 200 / 15 min | `RATE_API_PER_15MIN` | Health check exempt; pricing no longer counted here |
| `POST /api/upload` | 50 / 15 min | `RATE_UPLOAD_PER_15MIN` | Standard headers added |
| `POST /api/quote` (pricing) | 300 / 15 min and 40 / 10 s | `RATE_QUOTE_PER_15MIN`, `RATE_QUOTE_BURST_PER_10SEC` | New, own budget |
| `GET /api/quote/:id/session` | 60 / 15 min | `RATE_QUOTE_SESSION_PER_15MIN` | New (returns every part's mesh) |
| `POST /api/parts/:id/units` | 50 / 15 min | `RATE_UPLOAD_PER_15MIN` | New (re-parses a DXF; also moved into the worker pool) |
| `POST /api/quote/:id/drawing` | 20 / hour | `RATE_DRAWING_PER_HOUR` | New |
| `/api/pdf/*`, `/api/orders/:id/traveler` | 60 / 15 min | `RATE_PDF_PER_15MIN` | New (counted before authentication) |
| `GET /api/admin/backup/*` | 12 / hour | — | New |
| `POST /api/rfq` | 20 / hour | `RATE_RFQ_PER_HOUR` | Key changed |

**Legitimate bursts.** The quote tool re-prices 400 ms after each change, so at most 2.5 pricing
calls a second (25 in ten seconds). Under the default limits a test uploads ten parts one at a
time, reads the catalog for three processes, re-prices a ten-part quote 35 times back to back and
reopens it twice: no 429, and more than 150 of the 200 general calls remain. Pricing a ten-part
quote takes about 33 ms (51 ms worst).

**Tests.** `server/security/requestLimits.test.js` (8).

## 5. Browser policy

**What was wrong.** `script-src 'self' 'unsafe-inline' 'unsafe-eval'`: an injected script would
run. Google Fonts hosts were allowed although fonts are self-hosted; four Stripe hosts were allowed
although checkout is a full-page redirect and no page loads a Stripe script, frame or request.

**The policy now** (`server/security/headers.js`, with the reason for each source in the file):

```
default-src 'self'; script-src 'self' https://challenges.cloudflare.com; script-src-attr 'none';
style-src 'self' 'unsafe-inline'; style-src-elem 'self' <hashes>; style-src-attr 'unsafe-inline';
font-src 'self'; img-src 'self' data: blob:; connect-src 'self';
frame-src https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; media-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

- No inline script, no eval, no `wasm-unsafe-eval`. Checked in the build: one external module script
  per page, lazy chunks from `/assets`, JSON-LD blocks (data, not executed); three.js needs no eval
  and the browser loads no WebAssembly.
- `style-src-attr 'unsafe-inline'` is the one concession: the prerendered pages carry `style="…"`
  attributes (React inline styles written out as HTML). An attribute styles its own element and
  cannot run script. `style-src` is only the fallback for browsers that predate the two specific
  directives. Removing it would mean moving every inline style in the client to classes.
- `<hashes>`: the five hand-written pages under `/brand/` have a `<style>` block each. They are
  allowed by the SHA-256 of each block, computed from the built files at startup; `data:` fonts are
  allowed on the two of those pages that embed their fonts, and nowhere else.
- `https://challenges.cloudflare.com` in `script-src` and `frame-src` for Turnstile.
- Also: `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin` (a firm-quote
  link carries its token in the path, so no path ever goes to another site; the origin still does,
  which Turnstile's host check can use); `Permissions-Policy` switching off camera, microphone,
  geolocation, payment, USB and others; `Cache-Control: no-store` on every API response.
- `CSP_REPORT_ONLY=true` reports instead of enforcing, for trying a change. Leave unset.

**Proof in a browser.** `tools/security/csp-browser-check.js` (Playwright, Chromium), against a
production-mode server on a fresh database:

```
52 steps, 52 clean, 0 CSP violations, 0 page errors, 0 failed requests; policy proof passed
```

The 52 steps: all 22 public pages (each scrolled to the bottom; fonts confirmed loaded), the 5
static brand pages (styles confirmed applied), the 404 page, 7 app pages signed out, the quote
tool with an STL (WebGL canvas 696 × 360, model rotated, live price), a STEP and a DXF (SVG
preview), checkout through to the browser leaving for `checkout.stripe.com` (the session answer is
supplied by the test because a dummy key cannot create a real one), the customer dashboard, the
admin panel and each of its nine tabs, and the pricing console with a rate changed, the live
preview re-priced and the history opened. A violation is caught three ways: a
`securitypolicyviolation` listener injected before the page's scripts, the console, and failed
requests. The last step proves the detector and the policy: an injected inline script, `eval`,
`new Function`, a string timer, an inline handler, a `<style>` block, a third-party script, a
cross-origin fetch and a frame are each blocked, and each is reported.

How to run it is in the script's header. Playwright is not a dependency of the repo.

**Tests.** `server/security/headers.test.js` (5): headers on pages and API, CORS, and a scan of the
built pages for anything that would need a looser policy.

## 6. Data layer and access

**SQL.** Every statement in `server/models` uses bound parameters; the only interpolated parts are
the table name (a constant) and column names. Fixed: a table name must be a known table; column
names must be real columns of that table and match an identifier pattern; if the column list
cannot be read, nothing is written (it used to write every key). No raw SQL exists outside
`server/models` (a test scans for it).

**NUL truncation (found).** SQLite text ends at the first NUL byte. `isValidEmail` accepts a NUL, so
`owner@shop.test\0.example.com` passed validation and the duplicate check and was stored as
`owner@shop.test`. Combined with the startup promotion of the `ADMIN_EMAIL` account this was a path
to the admin role (section 9, A1 is the broader problem). The data layer now removes NULs instead
of truncating at them, and an id containing one matches nothing.

**Request bodies.**

- Quote pricing: each part configuration is reduced to the ten known fields in their types; a
  wrong type is a 400. A quote holds at most 100 lines (each is priced and DFM-checked on the main
  thread; the body limit alone allowed thousands) and a quantity at most one million. Price,
  status, owner, gate, expiry and id cannot be set from the body (tested).
- Materials were already validated. Finishes and lead times were whitelisted by name only; they are
  now typed and range-checked. The admin form sends `NaN` for an emptied number field, which became
  `null` and was stored: a lead-time multiplier of NULL. Refused now (1–10 only).
- Pricing rules: schema-validated already; unknown keys and `__proto__` refused (tested).
- Order status: only status, tracking, carrier, ship date and notes; the total and owner cannot be
  set (tested). A buyer cannot mark an order paid.
- Prototype pollution: bodies are read through explicit field lists; maps keyed by file content use
  prototype-less objects (one in the 3MF reader was changed). Tested with `__proto__` and
  `constructor` at several depths.

**Access.** Every admin route (39 checked by a test, including backups, PDFs, part and drawing
downloads, the RFQ queue) answers 401 without a token and 403 with a buyer's, with no body beyond
`{error}`. Forged tokens (`alg: none`, another secret, an edited role, a stripped signature) are
refused. Path-shaped ids (`..%2F..%2Fetc%2Fpasswd`, `%00`, SQL fragments) get 404 on every route
that takes an id; static serving does not leave `client/dist`. One customer's quote, drawing and
request are not found from another account or anonymously. Backups: admin only; the JSON export has
no password hashes; the SQLite file download does (it is the whole database) — it is rate limited
and never cached.

**DXF units after an order (found).** `POST /api/parts/:id/units` rewrote the stored geometry of a
part, and the traveler reads that geometry. Reopening an ordered DXF part (reorder) and switching
inch/mm changed the size the shop would see. Now refused once the part is on an order (409).

**Errors.** In production the handler never returns a message it did not write. Sixteen hostile
requests (bad JSON, wrong types, broken multipart, malformed percent-encoding, a 3,000-character
id, TRACE) return no stack, path or library name.

**Logs.** No request logging middleware exists; bodies and headers are not logged. The error
handler logged `req.originalUrl`, which for the firm-quote routes contains the signed link. It now
logs the route with the query string dropped and tokens replaced by `[token]`. A test sends a
signed link, a marker in a query string, a body and a wrong password, then checks the log for all
of them and for anything shaped like a JWT.

**CORS.** Same-origin and `FRONTEND_URL` only in production (the two dev-server origins are now
development-only). A foreign origin and `null` get no CORS headers. Authentication is a bearer
token, not a cookie, so there is no ambient credential for a cross-site request to ride on.

**Tests.** `server/security/dataLayer.test.js` (7), `server/security/access.test.js` (8).

## 7. Files at rest

**Status.** Off in production (`NORD_FILE_ENC_KEY` is not set). No key was generated, hard-coded,
logged or written anywhere by this work. The owner's steps are in
[`file-encryption.md`](file-encryption.md).

**What was wrong.** Only CAD uploads were encrypted; quote drawings and RFQ attachments never were.
A changed key failed with a bare cipher error indistinguishable from corruption. The file was read
whole and encrypted synchronously on the request path. The startup warning said only "uploaded CAD
files are stored unencrypted".

**Fix.** (`server/services/fileCrypto.js`)

- Quote drawings and RFQ attachments are encrypted on store and decrypted for the authorised
  download, through one helper that also forces a download (`Content-Disposition: attachment`,
  `application/octet-stream`, `nosniff`) so nothing a customer sent is ever rendered in the admin's
  browser.
- New file format with a key id: a file written under another key is reported as that
  (`wrong-key`), a damaged one as `corrupt`, a missing key as `no-key`. Files in the earlier format
  still open.
- `NORD_FILE_ENC_KEY_PREVIOUS`: older keys that may still decrypt, so the key can be changed
  without losing stored files.
- Streamed encryption (constant memory, no event-loop pause); a failure leaves the plaintext in
  place and no partial output.
- A key that is set but shorter than 32 characters or a placeholder stops the deploy (`FATAL`),
  and Railway keeps the previous version running.
- The startup warning now names the three folders and what is in them, and points to the guide.

**Verified end to end** on the real server with keys generated at run time: uploads, a quote
drawing and two RFQ attachments are `.enc` on disk with no plaintext run; pricing, a DXF unit
change and admin downloads still work; a changed key refuses old files with a clear reason and
serves no bytes, while new uploads work; listing the old key as previous restores them; with no key
the ciphertext is never handed out in place of the file; no key, token or Stripe key appears in any
log.

**Not covered** (stated in the guide): the database, including each part's measured geometry and
preview mesh; files stored before the key is set.

**Tests.** `server/services/fileCryptoKeys.test.js` (9), `server/security/fileEncryption.test.js` (5).

## 8. Limits in force and their overrides

Set in Railway → Variables only to change a default. A value that is not a number or is out of
range is ignored and the default stays (a typo cannot switch a limit off).

| Limit | Default | Variable |
|---|---|---|
| Largest CAD file | 50 MB | `UPLOAD_MAX_FILE_MB` |
| Files per upload | 10 | `UPLOAD_MAX_FILES` |
| Upload bytes per address per 24 h | 500 MB | `UPLOAD_DAILY_MB_PER_IP` |
| Upload folders, total | 2,048 MB (warn at 80%) | `UPLOAD_DIR_MAX_MB`, `UPLOAD_DIR_WARN_PERCENT` |
| Database file before uploads are refused | 256 MB | `DB_MAX_MB` |
| Quote drawing | 25 MB | `DRAWING_MAX_FILE_MB` |
| RFQ attachment | 25 MB | fixed in `rfq.js` |
| Upload retention | 168 h | `UPLOAD_RETENTION_HOURS` |
| Unreferenced drawings removed after | 24 h | `DRAWING_ORPHAN_HOURS` |
| Parses at once / waiting / wait | 2 / 8 / 30 s | `PARSE_CONCURRENCY`, `PARSE_QUEUE_MAX`, `PARSE_QUEUE_WAIT_MS` |
| Parse time per file | 60 s | `PARSE_TIMEOUT_MS` |
| Parse worker heap | 768 MB | `PARSE_MAX_HEAP_MB` |
| Memory parsing may add to the process | 1,024 MB | `PARSE_RSS_LIMIT_MB` (0 = off) |
| Parses per address at once | 1 | `PARSE_PER_CLIENT` |
| Jobs per worker before it is replaced | 25 | `PARSE_WORKER_MAX_JOBS` |
| Triangles (STL, 3MF, tessellated STEP/IGES) | 500,000 | `MESH_MAX_TRIANGLES` |
| DXF entities | 100,000 | `DXF_MAX_ENTITIES` |
| 3MF entries / total / model / ratio | 1,000 / 256 MB / 64 MB / 100:1 | `ZIP_MAX_ENTRIES`, `ZIP_MAX_TOTAL_MB`, `ZIP_MAX_MODEL_MB`, `ZIP_MAX_RATIO` |
| 3MF XML nesting | 32 | `XML_MAX_DEPTH` |
| Lines per instant quote / quantity per line | 100 / 1,000,000 | fixed in `api.js` |
| JSON body | 1 MB | `JSON_BODY_LIMIT_KB` |
| Rate limits | section 4 | `RATE_*` |
| Trusted proxy hops | 1 | `TRUST_PROXY_HOPS` |

## 9. Found outside this scope (not changed)

### For the accounts / forms / email branch

- **A1 — Critical. Anyone can become admin by registering the owner's address.** `POST
  /api/auth/register` gives the admin role to whoever registers with the `ADMIN_EMAIL` address, with
  no proof of owning it (confirmed on a live server: an anonymous registration came back
  `role: admin`). It is exploitable until the owner registers, and again whenever the user table is
  empty (a database reset; `api.js` still carries a comment that Railway storage is ephemeral). The
  address is guessable — it is in `.env.example`. The admin role should require a verified email at
  least, and better an account created out of band. Check that the admin account exists in
  production before launch.
- **A2 — High.** `isValidEmail` accepts control characters, including NUL (`a@b.c\0.d`). The data
  layer no longer truncates at it, but validation should refuse it; the stored address differs
  from the one validated.
- **A3 — Medium.** The role is read from the token for 24 hours and never from the database: a
  demoted or deleted admin keeps access until the token expires. No revocation.
- **A4 — Medium.** `jwt.verify` is called without `algorithms: ["HS256"]`. Safe with a string
  secret today; pin it.
- **A5 — Medium.** The auth limiters use the default key (single IPv6 address). Use
  `require("../security/clientKey").clientKey` so they match the rest. Login is 5 per IP per 15
  minutes with no per-account lockout (in your plan).
- **A6 — Low.** Registration answers 409 "An account with this email already exists" (enumeration);
  login does no hash comparison for an unknown user (timing).
- **A7 — Low.** `rfqToken.js` and `auth.js` fall back to a fixed development secret whenever
  `NODE_ENV` is not `production`. `npm start` sets it; a start by any other command would not.
- **A8 — Low.** The token lives in `localStorage`. The stricter CSP is the mitigation; a move to an
  HttpOnly cookie would need CSRF protection.
- **R1 — Medium, `rfq.js`.** A request refused after its attachment was written (no name, bad
  email, unknown quote) leaves the file in `data/rfq-drawings`. The new drawing sweep removes it
  within 24 hours; the route should delete it before answering.
- **R2 — Medium, `rfq.js`.** Attachments are accepted on extension alone (an HTML file named `.pdf`
  is stored). They are now always served as a download, never rendered, so the risk is the owner
  opening a hostile file locally. A magic-byte check per type would close it.
- **R3 — Low, `rfq.js`.** `GET /api/rfq/:id` returns an anonymous request's contact details to
  anyone holding its id. By design (the id is a random UUID); the Turnstile work is a good moment
  to confirm that is wanted.
- **M1 — Low, `mailer.js`.** With email not configured every message is logged as `To: <address> |
  subject` — customer addresses in the deploy log. `EMAIL_OUTBOX_DIR` writes whole messages,
  signed links included, to disk: development only, never set it in production.
- **W1 — Low, `stripeWebhook.js`.** Outside production an unsigned webhook is processed. Correctly
  refused in production.
- **Merge notes.** `server/index.js`: the helmet block is replaced by one line
  (`require("./security/headers").install(app, …)`) — if you added the Turnstile host there, drop
  your edit; it is already in the policy. The two limiter blocks gained `keyGenerator` / `skip`
  lines; the body-parser lines changed; `rfq.js` has four changed lines (33, 59, 155, 277). The
  JSON body limit is now 1 MB: say so if a new route needs more. `server/testSupport/liveServer.js`
  starts the real server for a test and may be useful for yours.

### For the owner

- **F1 — Medium (function, not security).** Finish prices edited in the admin panel are not saved:
  the panel sends `pricePerPart`, the server's field list has `costPerSqMm`, `costFlat`, `minCost`,
  so the edit is dropped and the old price comes back. Not changed here (it is pricing).
- **F2 — Low.** Five internal brand pages are public: `/brand/brand-guide.html`,
  `/brand/kit-sheet.html`, `/brand/review-sheet.html`, `-2`, `-3`. Decide whether the review sheets
  should ship.
- **F3 — Low.** `GET /api/orders` and `/api/orders/:id` return each part's stored file name to the
  buyer (a random name, no path). The order traveler route answers 404 for a missing order before
  it checks for the admin role.
- **F4 — Info.** `three` is a production dependency of the server but nothing on the server uses it.

## 10. Open items

| # | Item | Severity | Detail |
|---|---|---|---|
| O1 | The database holds every part's geometry and preview mesh, and is rewritten whole on every write | **High** (availability) | A dense STL adds 3.3 MB; a write blocks the server ~2 ms per MB; memory is ~5× the file. The 256 MB ceiling turns "the site slows to a crawl, then runs out of memory" into "uploads are refused and it is logged", but it does not recover by itself: rows referenced by a draft quote stay for the 30-day price hold, so about 80 dense parts — from abuse or simply a busy month — close the upload door until quotes lapse or `DB_MAX_MB` is raised. Proper fix: keep meshes in files instead of rows, or move to a native SQLite driver with incremental writes. Interim options for the owner to decide: a shorter hold for anonymous drafts nobody reopened; an admin action to clear them. Watch the deploy log for `DATABASE FULL` and `WARNING: database file at …%` |
| O2 | Feature recognition is far slower than linear on curved meshes | **Medium** (product) | 100,000 triangles of sphere took 63 s before; now it stops at the 60 s timeout and the customer is offered a firm quote. Many 3D-print STLs are 100,000–500,000 triangles, so a share of honest uploads will take that path. Not touched (geometry results must not change). Profile: `buildMesh` and `heightRange` in `server/geometry` |
| O3 | Storing a large part still pauses the main thread 0.3–0.5 s | Low | After the worker returns: copying the result, JSON for the row and the answer, the database write. Could be moved into the worker |
| O4 | `TRUST_PROXY_HOPS` assumes one proxy (Railway's edge) | **Medium** — verify before launch | If Cloudflare proxying is switched on in front of Railway, every visitor would share one address and one set of limits until `TRUST_PROXY_HOPS=2` is set. Check on the live site that two networks get separate `RateLimit-Remaining` counts |
| O5 | Budgets, rate limits and the parse queue are per process and in memory | Low | They reset on deploy and would not be shared across instances. Fine for one instance |
| O6 | Under abuse the storage ceiling is reached and stays reached | Medium | Files pinned by an open RFQ or a live order are never swept, and RFQs stay "new" until the owner closes them. Bounded per address (20 RFQs an hour, 500 MB a day), and Turnstile raises the cost; recovery is the owner declining spam requests. No admin action deletes an RFQ or its files today |
| O7 | Encryption is off in production and does not cover the database | Medium | Owner action: [`file-encryption.md`](file-encryption.md), best done before launch so no unencrypted file exists. Files stored before the key is set are not converted |
| O8 | Vite 5 / esbuild advisories (development server only) | Low | Upgrade Vite after launch and re-run the build and the browser check |
| O9 | `style-src-attr 'unsafe-inline'` | Low | Needed by the prerendered inline styles. Cannot run script. Removing it means moving the client's inline styles to classes |

Arguable, left as is: anonymous quotes, parts and requests are readable by anyone holding their
random id (the design of the no-account quote flow); the SQLite backup download includes password
hashes (it is the database; admin only, rate limited); the triangle ceiling (500,000) and the
60-second parse budget are judgement calls and are tunable.

## 11. How to re-run

```sh
npm install && npm test          # 35 suites
NODE_ENV=production npm run build
npm audit --omit=dev && (cd client && npm audit --omit=dev)
# quote vetting and the browser check: see the headers of
#   tools/vet-quotes/run_vetting.js and tools/security/csp-browser-check.js
```

New suites: `server/security/{dependencies,guards,uploads,requestLimits,headers,dataLayer,access,fileEncryption}.test.js`,
`server/parsers/parsePool.test.js`, `server/services/fileCryptoKeys.test.js`. The live-server
suites start `server/index.js` on a free port with a throwaway database and data folder
(`QUOTING_DB_PATH`, `QUOTING_DATA_DIR`) and random throwaway secrets.
