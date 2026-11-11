# Hardening integration — 2026-11-11

Branch `hardening-2026-11-11`: `hardening-accounts` with `hardening-server` merged in. Not pushed
from this work, not merged to `master`. The two branch reports are
[`hardening-2026-11-11-accounts.md`](hardening-2026-11-11-accounts.md) and
[`hardening-2026-11-11-server.md`](hardening-2026-11-11-server.md); this one covers what happened
when they met, the findings each left for the other, the owner's decisions, and the database change.

Nothing in pricing rules, seeded prices, DFM rules or geometry results was changed. The quote
vetting run gives the same 300 quotes before and after (section 5).

## 1. Summary

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Five server-branch suites failed against the account gates (34/39) | — | Fixed: 41/41. Two real bugs, the rest test ports (section 2) |
| 2 | `SqliteDB.delete()` always answered "nothing deleted" (admin material delete: removed it, then 404) | Low | Fixed |
| 3 | Two different refusals for a DXF units change on a locked part (`part-locked` / `part-on-order`) | Low | Fixed: one answer |
| 4 | Migration SQL outside `server/models` | Low | Fixed: moved, identifiers vetted |
| A2 | `isValidEmail` accepted NUL and other control characters | High | Fixed |
| A4 | `jwt.verify` without `algorithms` (firm-quote links); sessions signed without naming it | Medium | Fixed |
| A5 | Auth and form limiters keyed on the raw address (IPv6 rotation) | Medium | Fixed |
| A7 | Fixed development secret in the source when `JWT_SECRET` is unset | Low | Fixed |
| — | CORS for cookie sessions: reflected origin outside production, app headers not listed | Medium | Fixed; cross-site attempt tested twice (HTTP and browser) |
| R1 | A refused request left its attachment on disk | Medium | Fixed |
| R2 | Request attachments accepted on extension alone | Medium | Fixed |
| R3 | Anonymous request readable by id | Low | Confirmed: status only |
| M1 | Mailer logged recipient addresses and subjects | Low | Fixed: template name and a count |
| — | Global `express.urlencoded` | Low | Removed |
| W1 | Unsigned Stripe webhook accepted whenever `NODE_ENV` was not `production` | Low | Fixed: explicit test switch, never in production |
| — | `sanitizeString` mangled ordinary text | Medium (function) | Fixed: stored as typed, escaped where shown |
| — | `data/quote-drawings`, `data/rfq-drawings`: encryption and retention after the merge | Medium | Confirmed, with a live test |
| — | Stale "Railway storage is ephemeral" comment | Info | Corrected |
| F2 | Five internal `/brand/*.html` pages and the sample documents public | Low | Fixed: 404; assets stay public |
| F1 | Admin finish-price edits silently dropped | Medium (function) | Fixed |
| D1 | Admin two-step sign-in required, not advised | Owner decision | Implemented |
| D2 | Public copy true with and without Turnstile keys | Owner decision | Implemented; `claims-check` enforces it |
| O1 | Part geometry and preview mesh in the database (rewritten whole on every save) | High | Fixed: payloads in files (section 5) |
| — | Open items | see section 7 | Open |

## 2. What broke when the branches met

Start: `npm test` 34/39. All five failing suites were the server branch's, written against the old
bearer-only API.

| Suite | Failure | Cause | Kind |
|---|---|---|---|
| `access.test.js` | register → 400 `form-token-missing`; admin routes "401 where 403 expected" | The helpers registered without a form token, so there was no admin and no buyer token; every later assertion ran without a session | Test port. With real sessions a buyer gets 403 on every admin route, by bearer token and by cookie |
| `fileEncryption.test.js` | "Part not found" on a DXF units change | The accounts gate asks for the part's edit key (`X-Part-Key`); the test did not send it | Test port. The encrypted file re-reads correctly with the key |
| `dataLayer.test.js` | "before an order: allowed" → 404 | Same edit key | Test port |
| `dataLayer.test.js` | raw SQL outside `server/models` | `server/security/accountMigration.js` | Real: moved to `server/models/accountMigration.js`; table, column and type names are checked against an identifier pattern before use |
| `requestLimits.test.js`, `uploads.test.js` | request form → 400 | No form token | Test port |

Real problems found while porting:

- **Two answers for one refusal.** Both branches had closed "change a DXF's units after it is on an
  order" independently: the accounts gate answered 409 `part-locked` (order or request), the route
  409 `part-on-order`. The gate runs first, so the route's answer was unreachable and the server
  suite asserted a code no client would see. Now one constant (`PART_LOCKED`), used by both; the
  route keeps its check for any mount without the gate (tested on a bare router).
- **`delete()` lied.** `SqliteDB._run` read the changed-row count after the save, and a save
  (`export()`) resets it. Every delete outside a batch returned `false`; the admin "delete material"
  route deleted the row and answered 404. On `master` too. Fixed and tested.
- **Order traveler** checked the role inline; it now uses the shared admin check.
- **The drawing sweep took its folders by position** (`STORAGE_DIRS.slice(1)`). Harmless until a
  fourth folder is added to the storage ceiling, at which point it would have swept that folder as
  orphan drawings after 24 hours. Replaced by a named list before the part-payload folder was added.
- **Lockfile.** `qrcode`'s dependencies were marked dev after the merge. That fix was committed on
  the branch during this work by someone else (3dc1a74, "Lockfile after merging the two hardening
  branches"); it is the same change `npm install` had produced here.

How the suites were ported: `server/testSupport/liveServer.js` and `harness.js` now set accounts up
the way a person does — a form token a few seconds old, the emailed confirmation link opened (read
from the outbox), and for the owner, two-step enrolment — and `s.browser(token)` gives the cookie
and CSRF token a page would send. No assertion was dropped. These were changed, each because the
behaviour it pinned was changed on purpose:

- "an admin refusal body has only `error`" (`access.test.js`): a missing session now also carries
  `code: auth-required`, which the page reads. The assertion is now the exact body.
- "markup is stripped from a stored name / note" (`dataLayer.test.js`, two places): text is stored
  as typed (section 3).
- "a 200 kB form-encoded body is 413" (`requestLimits.test.js`): there is no urlencoded parser any
  more; the account routes answer 415 and other routes ignore the body.
- "the unsent-mail log line contains the recipient" (`templates.test.js`): it must not (M1).
- "the confirmed owner account opens the admin routes" (`accountSecurity.test.js`, and the same in
  the browser run): it gets the enrolment refusal until two-step sign-in is on (section 4).
- A request-form test attached "fake heic bytes" as a photo (`rfqQuote.test.js`): the fixture is now
  a real HEIC header, and the fake is asserted refused (R2).

Two suites were added (`server/security/crossBranch.test.js`, `server/models/partPayloads.test.js`):
39 → 41.

Added in the ported suites: every admin route as a buyer by cookie with and without the CSRF
token; every admin route as an admin who has not enrolled; the admin's own cookie without the CSRF
token changing nothing.

## 3. Cross-branch findings

**A2 — control characters in an email address.** `server/middleware/validate.js`: `isValidEmail`
refuses C0/C1 controls (NUL first), line and paragraph separators, zero-width and bidirectional
characters and the byte-order mark. Addresses are no longer fully trimmed before validation (only
spaces and tabs), so a trailing line break or NUL is seen and refused. Sign-in validates the address
before any counter or lookup. *Test:* `crossBranch.test.js` — twelve hostile addresses against
registration, sign-in, reset and both request forms: 400 each, no account, no request, no email.

**A4 — algorithms.** `rfqToken.js` signs and verifies as HS256 by name; `session.js` names it on
signing (it already did on verifying; `tokens.js` did both). *Test:* a source scan for any
`jwt.verify` without `algorithms`, `jwt.sign` without `algorithm`, or `jwt.decode`; and tokens signed
with the correct key under HS384 / HS512 and `alg: none` refused as sessions, quote links,
confirmation links, reset links, form tokens and verified-human tokens.

**A7 — development secret.** With no `JWT_SECRET` the key is 48 random bytes per process, not a
string in the source (`keys.js`; `rfqToken.js` now uses the same function). Production still
refuses to start without one.

**A5 — limiter keys.** Sign-in failure counters, form limits, the reset limit, confirmation-email
caps and the three `express-rate-limit` instances in `auth.js` use `clientKey` (IPv4-mapped folded,
IPv6 by /64, `TRUST_PROXY_HOPS`). The raw address is kept only as Turnstile's `remoteip`. *Test:*
three failures from three addresses in one /64 challenge a fourth; twenty block the /64 and not its
neighbour; ten requests and ten registrations from ten addresses in a /64, the eleventh refused.

**CORS and cross-site requests.** `server/security/cors.js`: the site's own origin (scheme, host
and port), `FRONTEND_URL`, and the dev servers outside production. No origin is reflected in any
environment (non-production used `origin: true`). `allowedHeaders` lists `Content-Type`,
`Authorization`, `X-CSRF-Token`, `X-Human-Token`, `X-Form-Token`, `X-Turnstile-Token`, `X-Part-Key`.
*Tests:* `headers.test.js` — a signed-in visitor's cookie sent with `Origin: https://evil.example`
on eight state-changing requests (form-encoded, text/plain, JSON; with and without a guessed CSRF
header): each refused, profile and orders unchanged, sessions intact, no CORS grant on any answer;
the cookie is `__Host-se_session; HttpOnly; SameSite=Strict; Secure`. Browser run, scenario I — a
page on another origin in the visitor's own browser: CORS-mode requests fail, the three requests
that need no preflight reach the server without the cookie and are refused there, the page sees no
answer, nothing changed.

**R1 — attachments of refused requests.** `rfq.js`: every way out that does not store the request
awaits deletion of the attachment, including its encrypted copy (the old code unlinked the plain
name after encryption had renamed it). *Test:* `uploads.test.js` — nine refusals (no name, bad
address, control character, unknown quote, no token, too fast, another form's token, honeypot,
duplicate), folder unchanged after each.

**R2 — content checks.** `fileValidator.js`: PDF, PNG, JPEG, WebP, HEIC/HEIF, DXF and DWG are
checked by their first bytes. A mismatch is deleted and answered 400 `content-mismatch`. The
multipart parser is bounded (one file, forty fields). *Test:* ten disguised files refused, eight
genuine ones accepted.

**R3 — anonymous requests by id.** Confirmed: status, reference, type and date only (asserted on
the live server and in `authorization.test.js`).

**M1 — mailer log.** `mailer.js` logs `template <name>, <n> recipient(s)`; no address, subject or
provider error body. Every template stamps its name. `EMAIL_OUTBOX_DIR` is ignored without the test
switch. *Tests:* `templates.test.js`, and `access.test.js` on a live server (no customer address in
the log).

**urlencoded.** Removed from `index.js`. Nothing read it.

**W1 — webhook.** `server/security/testHooks.js`: `SE_TEST_HOOKS=1` is the one test switch. An
unsigned event is refused (503) unless it is set, and in production even then. *Test:* refused
under `NODE_ENV` test, development, staging and unset; refused in production with the switch;
accepted only with the switch outside production.

**Text stored as typed.** `sanitizeString` removes control characters and bidirectional overrides,
trims and cuts to length. It no longer deletes `<…>`, `on…=` or `javascript:`. *Tests:* "tone = 5",
"5 < 10 > 3" and a note made of markup round-trip unchanged through quote notes, order notes,
request fields, the firm-quote note and the profile; in every email the value is escaped in the
HTML part, plain in the text part, absent from the subject, and no tag or `href` comes from it;
four PDFs print it as text and contain no script, action or foreign link; the client has no raw-HTML
sink (source scan); in the browser run the admin queue shows the note as typed, no element is
created and nothing runs.

**Drawings.** Both folders are encrypted when a key is set and swept at startup and every six
hours. *Test:* `uploads.test.js` on a live server with a key — referenced files kept at any age,
old strays removed, an hour-old stray left.

**Brand pages.** `server/seo.js` answers 404 for `/brand/*.html`, their PDFs, notes and page
renderings, and `/brand/documents/*` (20 files). Logos, icons and Open Graph images stay public. No
`/brand/` URL is in the sitemap. With no static page served, the policy no longer carries `<style>`
hashes or `data:` fonts: `style-src-elem 'self'`. *Test:* `headers.test.js`.

**F1 — finish prices.** The admin panel sends `pricePerPart`; the server listed `costPerSqMm`,
`costFlat`. The list is now the columns pricing reads (`pricePerPart`, `pricePerSqIn`, `costPerDm2`,
`minCost`); the two names that were never stored are refused instead of dropped. *Test:* an edit is
saved, read back and prices the next quote; bad values refused; restored, the quote returns to its
first total and every finish equals its seeded price.

## 4. Owner decisions

**Two-step sign-in is required for the admin.** `session.js`: an admin account that has not
enrolled carries the customer role on every request, so every role check in every route fails
closed; `requireAdmin` answers 403 `two-factor-enrolment-required`. Only the five `2fa` endpoints,
the session check and sign-out are reachable (`requireAdminAccount`). The admin page shows the
enrolment screen and nothing else, and stays there until the recovery codes are saved; any 403
with that code sends the browser there. Switching it off returns to the same screen.
`ADMIN_RECOVERY=reset-2fa` still works: password sign-in, then enrolment only. *Tests:* all admin
routes in the inventory as an unenrolled admin (403 with the code, nothing changed), the enrolment
endpoints answering, both states on a live server and in the browser, recovery followed by
re-enrolment.

After deploy the owner's existing account is the admin and is asked to enrol at the first sign-in.

**Everything else as the accounts report describes.** Unchanged.

**Copy.** The server's answer now says why no confirmation went out (`noEmailReason`). The
confirmation screen mentions an email only when one was sent and shows the address only when it is
in the answer. Text shown before sending (replacement-parts page, request form) says a reference is
given and "we send you the address to ship to", which is true in both states.
`scripts/claims-check.js` refuses a prerendered page that promises a confirmation email or an
on-screen address: exit 0.

## 5. Database growth (O1)

**Change.** A part's preview mesh, and geometry detail too large for a row, are files under
`data/part-payloads` (`server/models/partPayloads.js`, `partsStore.js`):

- `<partId>.mesh.json[.enc]` when the mesh is over 16 kB; `<partId>.geometry.json[.enc]` when the
  rest is over 64 kB (a plate with thousands of holes, a dense DXF). Both limits are settings.
- Written to a temporary name, fsynced, renamed; mode 0600. Encrypted in memory with the
  file-encryption key and format when one is set.
- Counted against the storage ceiling and the sender's daily budget. Deleted with the part row;
  a startup sweep removes files with no row.
- Pricing gets the same geometry as before, in the same key order, without the vertex list. The
  mesh is read only when a quote is reopened. If a geometry file cannot be read the part is refused
  (409 `part-data-unavailable`), not priced from a summary.
- Migration (`partPayloadMigration.js`): two additive columns; existing rows move at startup in one
  in-memory batch, then `VACUUM` and a single save. Repeatable. A row whose file cannot be written
  is left as it was.

**Sizes.**

| Case | Before | After |
|---|---|---|
| 30 dense STLs (14,160 triangles each), stored | 72.0 MB | 0.31 MB (5.2 kB a part) |
| The same 72.0 MB database, migrated at startup | 72.0 MB | 0.34 MB; 30 files, 71.6 MB |
| Vetting run (27 parts, 300 quotes) | 4.39 MB | 1.74 MB |
| Database made by `master` code (4 parts) | 3.49 MB | 0.22 MB; 3 files, 3.3 MB |

Uploading the 30 dense parts took 53.1 s before and 45.8 s after.

**Vetting.** `tools/vet-quotes/run_vetting.js` against a production-mode server before and after:
300 quotes, 0 fails, 63 warnings both times; the two `results.csv` files differ only in the random
quote-id column. `partPayloads.test.js` also prices a dense STL, a STEP plate and a 1,600-hole DXF
from files and from the row: identical quotes.

**3D preview.** In Chromium: upload, reload the page, the quote reopens with 17,856 vertices read
from the mesh file and the canvas drawn.

## 6. Verification

| Check | Result |
|---|---|
| `npm test`, Node 22 | 41/41 suites, 637 cases |
| `npm test`, Node 20.20.2 (production runtime) | 41/41 suites, 637 cases |
| `NODE_ENV=production npm run build` | 22/22 routes prerendered |
| `node scripts/claims-check.js` | exit 0 |
| `npm audit --omit=dev`, server and client | 0 vulnerabilities each |
| `tools/security/csp-browser-check.js` | 66 steps, 66 clean, 0 violations, policy proof passed |
| `scripts/e2e/hardening-accounts.mjs`, no `bypassCSP` | 96/96 checks |
| Database from `master` code | 28/28 checks |
| Ship-to street address | not in `client/dist` (153 text files), not in any server log, masked in the one screenshot that would show it |

The CSP check now starts its own production-mode server and covers registration with the widget
container, email confirmation, checkout to the paid order, password reset, both request forms,
two-step enrolment and sign-in, every admin tab, and the reopened quote.

The `master` database was made by running `origin/master` from a temporary worktree (owner,
customer, four parts, three quotes, an order, a request). On this branch it starts with no error;
both passwords still sign in; the owner is the admin and is sent to enrolment; quotes keep their
totals; every preview mesh is byte-identical; three meshes moved to files; a second start changes
nothing.

**Not verified.**

- Cloudflare's real widget script. The sandbox proxy refuses `challenges.cloudflare.com` (403 on
  CONNECT), so the browser runs use a stand-in served for that URL. It runs only because the
  policy allows that host for scripts and frames; it does not exercise Cloudflare's own code.
- Stripe and Resend: stubbed at the boundary, as in both branch reports.
- That the Railway volume is mounted at `/app/data`: taken as given.
- `TRUST_PROXY_HOPS` on the live site (server report O4).

## 7. Open items

| Item | Severity | Notes |
|---|---|---|
| Turnstile keys not set | High until done | Owner. Until then: no challenge, no automatic confirmation, no address on screen. Then check the widget on the live site: the real script has not been run under this policy |
| `TRUST_PROXY_HOPS` with Cloudflare proxying | Medium, verify before launch | Server report O4. Now also governs sign-in and form limits |
| File encryption off in production | Medium | Owner: `file-encryption.md`. Payload files written before the key is set stay plain, like the other folders |
| Feature recognition slow on dense curved meshes | Medium (product) | Server report O2, untouched |
| Storage ceiling under abuse | Medium | Server report O6. Payload files count toward it and toward the sender's daily budget; they leave with their part row |
| `JWT_SECRET` strength unknown | Medium | Startup warns under 32 characters |
| Backups no longer hold preview meshes | Low | The `.db` and JSON downloads have no part-payload files. A restore from the database alone gives quotes and orders intact, parts without previews, and very detailed parts that must be uploaded again to re-price. Back up the volume |
| Reopening a quote reads each mesh on the main thread | Low | About 0.1 s per dense part (ten parts: 1 s). Rate limited at 60 per 15 minutes |
| Honeypot false positive | Low | A visitor whose browser fills the hidden field is told the request went in; nothing is stored |
| Registration says an address has an account | Low | By decision |
| A blocked widget means calling or emailing | Low | By decision |
| An attacker can keep one address's sign-in paused | Low | Accounts report |
| Throttles, budgets and the parse queue are in memory | Low | One instance |
| Verified-human token replayable for its hour | Low | Accounts report |
| Session token also returned in JSON | Low | For API clients and the suites |
| Database download includes password hashes | Low | Admin only, now behind two-step sign-in |
| General API limit shared by an office (200 / 15 min) | Low | Accounts report |
| Order answers include each part's stored file name | Low | Server report F3 |
| Vite / esbuild advisories (dev server only) | Low | Server report O8 |
| `style-src-attr 'unsafe-inline'` | Low | Server report O9 |
| `three` is a server dependency nothing uses | Info | Server report F4 |

## 8. New settings

| Variable | Effect | Default |
|---|---|---|
| `PART_INLINE_MESH_KB` | A preview mesh larger than this is a file, not a row | 16 |
| `PART_INLINE_GEOMETRY_KB` | The same for geometry detail | 64 |
| `SE_TEST_HOOKS` | `1` switches test-only behaviour on (email outbox; unsigned webhooks outside production). Never on the live site; the startup log warns if it is | unset |

`UPLOAD_DIR_MAX_MB` now also covers `data/part-payloads`.

## 9. How to re-run

```sh
npm install && npm test
NODE_ENV=production npm run build && node scripts/claims-check.js
npm audit --omit=dev && (cd client && npm audit --omit=dev)
# browser checks: each starts its own production-mode server
NODE_PATH=<dir holding playwright> env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost \
  node scripts/e2e/hardening-accounts.mjs --scratch <dir>
PLAYWRIGHT=<playwright> env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost \
  node tools/security/csp-browser-check.js --scratch <dir>
```
