# Independent pre-launch security review — STRAIGHTEDGE — 2026-11-11

An outside reviewer's adversarial read and penetration test of `straightedgemfg.com`
(branch `security-review-2026-11-11`, cut from `hardening-2026-11-11` @ `e4881d3`). I did not write
any of this code. I built my own threat model and ran my own attacks first, against a **local**
server only, then read the three existing hardening docs and checked their claims by attack.

Method: the real `server/index.js` in production mode (`NODE_ENV=production`, sql.js), started
through the project's own `server/testSupport/liveServer.js`, with Stripe/Resend/Turnstile stubbed
on this host (`tools/security/review/lib/`). Every finding below has a reproduction script under
`tools/security/review/` or a `file:line` path. Nothing hit the live site, Stripe, Cloudflare or
Resend, and no real secret was written anywhere.

**Scope note (coordinator reassignment, mid-review).** Two other reviewers took item 3
(uploads/parsing/storage) + item 6 (abuse quantification) and the payment-amount half of item 2
(quote→checkout→Stripe→webhook→paid, firm-quote/PO/paperwork/lead-time/quantity amounts). I kept
item 1 (auth/sessions), item 2 **authorisation/IDOR/mass-assignment excluding payment amounts**,
item 4 (injection/output), item 5 (browser policy/transport) and item 7 (secrets/operations). F1–F2
below are price-integrity work I had already finished and carried to a paid order before the split;
I keep them in the record (they belong to reviewer (b) now) because they are the launch-blockers and
F2's root cause is also an authorisation/TOCTOU issue in my scope. F6's abuse table now belongs to
reviewer (a); I keep the numbers I measured. My deeper work since the split (F9, §5.1 secrets/ops,
expanded §3) is in the kept areas.

**Headline:** the account, session, CSRF, upload, parsing, header, CORS and injection work is
genuinely strong — most of what I tried there failed, as intended. The launch-blocking problems are
in **price integrity at checkout**: a buyer can pay a small fraction of the engine's price, and I
carried two different versions of that all the way to an order marked **paid**. There is also a
residual **admin-account land-grab** that the accounts branch reduced but did not close.

---

## 1. Findings, by severity

| # | Sev | Area | Where | Impact (plain words) |
|---|---|---|---|---|
| F1 | **Critical** | Price integrity | `server/routes/api.js` `priceQuote` (~L531–557) + `server/processes/registry.js` `resolveProcess` L54 | A buyer picks a process that doesn't match the material (or a made-up process word) and the part is priced as flat sheet metal — usually the $25 order minimum. Checked out and **paid** at $37 for a part the engine prices at $2085. Any part, any price, for the minimum. |
| F2 | **Critical** | Price integrity | `server/routes/orders.js` checkout-session L74–L192; `server/routes/api.js` units L398 | Checkout trusts the quote's frozen total and never re-prices against the part's current geometry. Change a DXF's units (mm→in, 25× bigger) *after* pricing but *before* checkout and the buyer pays the stale small price for a part the shop then builds 25× larger. Carried to **paid**. |
| F3 | **High** | Auth / admin | `server/security/adminAccount.js` `ensureAtStartup`; `server/routes/auth.js` `promoteIfOwner` L160, `verify-email` L387 | An attacker who registers the `ADMIN_EMAIL` address before the owner takes the account. Promotion now needs a verified email — but verification is delivered by the real owner clicking the "confirm your email" link (promotes the attacker's account, whose session is still live), or by the owner running the documented `ADMIN_RECOVERY=verify-email` on a no-mailer deploy (promotes whatever account holds that address). Also a guaranteed denial-of-registration for the owner. |
| F4 | **Medium** | Availability | `server/security/loginGuard.js`; `server/routes/auth.js` login L261 | Anyone who knows an email (the owner's included — it is guessable) can hold its sign-in in a permanent 15-minute pause by sending five wrong passwords every 15 minutes, from rotating IPs. Reset lifts it; the attacker re-locks. Existing sessions keep working. Acknowledged as "Low" in the accounts doc; I rate it Medium because it applies to the owner. |
| F5 | **Low** | Info leak / IDOR | `server/routes/api.js` quote-session L741; `server/security/index.js` `addPartEditKeys` | Any signed-in user who learns a `partId` (a random UUID) can put it in their own quote and read that part's geometry, file name and 3-D preview mesh, and — for a DXF — obtain its edit key and change its units. Gated only by the unguessability of the UUID. |
| F6 | **Low** | Abuse | `server/routes/rfq.js` create; `server/security/botGuard.js` | With Turnstile keys **not set** (the state the site launches in if the owner forgets), an anonymous script can create accounts and fill the admin RFQ queue at the per-IP limits (see §4). Mail-to-arbitrary-address is correctly blocked in that state. Acknowledged, but worth the owner seeing the numbers. |
| F7 | **Info** | Hardening | `server/routes/auth.js` login/register responses | The session token is still returned in the JSON body (not only the cookie). Harmless for the browser app, but it widens the blast radius of any future XSS and means a logged response body is a credential. |
| F8 | **Info** | Hardening | `server/routes/orders.js` `/checkout-session` | Stripe sessions are created on an authenticated route at the general 200/15-min rate; a bored account holder can mint ~200 unpaid Stripe sessions per 15 minutes. No money moves; it is dashboard noise and Stripe API volume only. |
| F9 | **Low** | Open redirect / transport | `server/seo.js` `normalize` L85 + the trailing-slash redirect L136 | On the canonical (apex) host, a path beginning with `//`, `/\` or `///` is 301-redirected to a **protocol-relative** `Location` (`//evil.example`), which a browser follows cross-origin. `https://straightedgemfg.com//evil.example/` bounces the visitor to `https://evil.example` — a phishing primitive on the real domain. Confirmed in `poc-09` and by unit-reasoning over `normalize`. (The `www→apex` redirect prepends the host and is safe; only apex-host requests reach this path.) Fix: reject or collapse leading `/`/`\` runs before emitting a `Location`, or redirect only to a path that starts with a single `/` and no `\`. |

### 1.1 Injection, output and error handling (item 4) — deeper pass

I threw 17 malformed/hostile request shapes at the API and the static layer (`poc-09`): invalid
JSON, `null`/`[]` bodies, object/array field substitution (`{"email":{"$ne":""}}` — meaningless
here, there is no NoSQL, but it confirms type handling), bad percent-encoding on both API and page
URLs, a 3,000-character id, a NUL in an id, `TRACE`, wrong content-type to the JSON-only auth
router, a 2 MB body, a 200,000-deep JSON array, and `__proto__`/`constructor` in the quote body at
two depths. **Every one returned a short written message, no stack, no filesystem path, no library
name, and left `Object.prototype` clean and the process healthy.** `X-Powered-By` is absent. The
error-handler path (`server/index.js` L144–173) and `sanitizeString`/`cleanSubject`/`cleanAddress`
hold. Prototype pollution is not reachable: bodies are read through explicit field lists and the one
content-keyed map in the 3MF reader is prototype-less.

I looked hard and found **nothing** exploitable in: SQL injection (every statement is parameterised;
table/column names are constrained — `SqliteDB.js`), stored/reflected XSS (React escapes, email
templates escape every value through `esc`/`safeHref` and send text as text — `emails/templates.js`
L84–L160, PDFs draw strings as text), header/`Content-Disposition` injection (mailer `cleanAddress`/
`cleanSubject`; downloads forced to `application/octet-stream; attachment` — `fileCrypto.sendDownload`),
SSRF (the only caller-influenced outbound fetches are Turnstile siteverify and Resend, both to fixed
hosts), open redirect (`?next=` is not used; Stripe return URLs and firm-quote links are built from
`accountLinkBase`, never the raw Host — `security/links.js`), prototype pollution (bodies read through
explicit field lists; `__proto__`/`constructor` as a process slug just fall back to sheet metal, see
F1), path traversal into any stored file name, algorithm-confusion / cross-token replay (see §3), and
direct mass-assignment of price/total/status/userId/gate (the quote body cannot set them — `poc-04`,
`poc-01` "mass assign" line). CSP, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy, CORS
and cache headers are all correct on every response kind I tested (§3).

---

## 2. Launch blockers vs. fix-soon vs. accept

### Must fix before the site takes real orders
- **F1 — process/material mismatch underpricing.** This is open season on the price. One line of
  reasoning fixes it: in `priceQuote`, reject a configuration whose `process` is not a real, active
  process *and* is not one the chosen material belongs to (a material carries `process`; routing is
  the only cross-process case, DXF-only, already special-cased). Today `resolveProcess` silently
  maps any unknown slug to sheet metal, and nothing checks material-vs-process.
- **F2 — checkout trusts a stale quote.** At `/checkout-session`, re-price the stored config from the
  part's *current* geometry and compare to `quote.orderTotal` (within a cent), or lock the part the
  moment it is priced so its geometry/units cannot change under a draft quote. The units endpoint
  already locks a part once it is on an order/RFQ; it needs to lock once a live draft quote prices it,
  or checkout needs to re-validate.
- **F3 — admin land-grab.** Refuse registration of the `ADMIN_EMAIL` address outright (provision the
  owner's admin account out of band before launch), or at minimum make promotion require that the
  account was created by the owner, not merely that it holds the address and got verified. Confirm
  the real admin account exists and is 2FA-enrolled before the DNS cutover, and confirm the Railway
  volume is persistent (if the DB resets on deploy the land-grab reopens every deploy).

### Fix soon (not a launch blocker, but before it bites)
- **F4** sign-in lockout of the owner — give the owner's address an allow-listed path or a longer
  per-address budget, or notify + auto-lift faster.
- **F5** partId-as-capability — scope quote-session/geometry reads and the DXF edit key to the part's
  uploader/owner, not to anyone who can name the UUID.
- **F9** open redirect in the SEO normalizer — collapse leading slash/backslash runs before the 301.
- **F7** stop returning the session token in JSON once the browser app no longer reads it.

### Accept (reasonable as-is, documented)
- Anonymous quotes/parts/requests readable by whoever holds their random UUID — the design of the
  no-account flow.
- The SQLite backup download containing password hashes — it is the whole database; admin-only, rate
  limited, never cached.
- Turnstile/email/encryption being *off until the owner sets keys* — correct fail-open-for-leads
  design, loudly warned at startup; see F6 for the numbers if the owner forgets.

---

## 3. Claimed fixes I verified by attack

Both hardening teams' work largely holds up. What I re-tested and confirmed:

| Claim (doc) | My attack | Result |
|---|---|---|
| CSRF on every cookie state-change (accounts §7) | 7 state-changing routes, cookie but no `X-CSRF-Token`, random IP (`poc-07`) | **Holds** — all 403 `csrf`; control with the token = 200 |
| Session cookie flags (accounts §7) | read `Set-Cookie` on register (`poc-05`) | **Holds** — `__Host-se_session … HttpOnly; SameSite=Strict; Secure` |
| Algorithm pinning / cross-token replay (accounts §7–8, server §6) | `alg:none`, wrong-key JWT, and form / email-verify / session tokens replayed as each other and as firm-quote links (`poc-05`) | **Holds** — every one refused |
| Reset link single-use, bound to old hash, kills sessions, host-safe (accounts §5) | use twice, use a sibling link, reset-as-verify, `Host: evil.example` (`poc-05`, `poc-06`) | **Holds** — reuse 400, sibling 400, old session & old password dead, emailed link stays `straightedgemfg.com` |
| Email-verify link single-use, NUL-email refused (accounts §4; server A2) | reuse link; register `owner@shop.test\0.evil.test` (`poc-05`, `poc-10`) | **Holds** — reuse idempotent; NUL email 400 |
| Admin two-step required; unenrolled admin reaches only enrolment (accounts §7) | full route matrix as an unenrolled admin (`poc-04`) | **Holds** — every admin route 403 `two-factor-enrolment-required`; only `/2fa*`, session, logout reachable |
| TOTP code single-use; wrong codes count toward the pause (accounts §7) | replay a code; burn wrong codes over rotating IPs knowing the password (`poc-06`) | **Holds** — replay 401; only ~4 wrong codes before the per-address pause stops it |
| "Price, status, owner, gate cannot be set from the body" (server §6) | quote body with `orderTotal`/`subtotal`/`status`/`userId`/`gate`/`paperworkFee` (`poc-01`) | **Holds** — all ignored; server recomputes |
| Instant-admin-on-register fixed (accounts §7; server A1) | anonymous register of `ADMIN_EMAIL` (`poc-02`) | **Partly** — no longer instant admin (role `customer`), but the *land-grab* path remains (F3) |
| CSP strict, no inline/eval, on every response (server §5) | headers on HTML / API JSON / 404 / downloads (`poc-08`) | **Holds** — identical strict CSP everywhere; HSTS, `frame-ancestors 'none'`, nosniff, `no-store` on API |
| Downloads never rendered (server §7, §6) | admin part download + DB backup content-type (`poc-08`) | **Holds** — `application/octet-stream` / `x-sqlite3`, `attachment`, nosniff |
| Street address not in bundle/JSON-LD (task §5) | grep dist + prerender for the `shipFrom` street number | **Holds** — absent; JSON-LD carries only locality/region |
| No source maps / dotfiles / data dir served (server §6) | request `.env`, `.git/config`, `/data/…`, `*.map`, `/server/…`, `/brand/documents/` | **Holds** — no map files emitted; internal brand paths 404 |
| Worker-pool parse isolation, size/zip/xml ceilings (server §3) | code-read + the project's own `parsePool`/`uploads`/`guards` suites | **Accepted on code + their tests** — see §5 for the one thing I could not independently drive |

### What I could not fully verify, and why
- **Parse-pool starvation and the ZIP/XML-bomb ceilings under real pathological CAD.** I confirmed
  the limits exist and are wired (`parsePool.js`, `zipGuard.js`, `limits.js`) and that the project's
  own `parsePool.test.js` / `uploads.test.js` exercise them, but I did not author fresh multi-megabyte
  bomb fixtures to re-drive them end-to-end in the time box. The design (per-client lane, queue cap,
  wall-clock timeout, heap limit + RSS watchdog, directory-only ZIP inspection, entity expansion off)
  is sound on reading. Treat as "reviewed, not independently re-exploited."
- **Real Turnstile and Resend behaviour** — stubbed on-host by design; I verified the *wiring* and
  fail-closed logic, not Cloudflare's/Resend's own responses.
- **Railway persistence / multi-instance** — environmental; see F3 and the docs' own O1/O4/O5.

### 3.1 Secrets and operations (item 7)

All positive — I confirmed rather than found:

- **No secret committed, now or in history.** `git log -S` (pickaxe) over the whole history for
  `sk_live_`, `sk_test_…`, `whsec_…`, `re_…` (Resend), `AKIA…` (AWS) and `-----BEGIN` returns only
  placeholders in `.env.example`, documentation, and `scripts/create-stripe-promo-codes.js` (which
  reads `process.env` and only compares the key *prefix* — it stores nothing). No private key, no
  real API key, no password in the tree or its history.
- **`.env` family is git-ignored** (`.env`, `.env.*` with `!.env.example`); `data/` and `uploads/`
  are ignored. No `.db`, `.sqlite`, `.enc`, `.pem`, `.key`, outbox or credentials file is tracked.
- **The shop's street address is server-side only.** It lives in `server/config/shipFrom.json`
  (used for documents) and nowhere under `client/dist`; only `client/dist` is served (`seo.js` L140),
  so it is absent from the public bundle, the JSON-LD (which carries locality/region/country only)
  and — per the mailer design — from logs. The history-pickaxe hit on the street *number* was a
  coincidental digit match in `tools/vet-quotes/results.json`; the full address string is not in that
  file, and `tools/` is never served. Clean.
- **Startup logging** names every protection that is off by reason (bot check, email, webhook secret,
  file key, test hooks) with no secret values — good operational signal, confirmed on a live boot.
- **The admin-email guessability behind F3**: `.env.example` ships the placeholder `owner@example.com`,
  not the real address — but the real `ADMIN_EMAIL` is trivially derivable from the public brand
  (`quotes@straightedgemfg.com` and the domain are in the shipped bundle), which is what makes the F3
  land-grab practical. Note it when deciding the F3 fix.
- **Dependencies.** `npm audit --omit=dev` is clean for both the server and the client production
  trees (0/0). The only advisories are Vite/esbuild in the client *build* tooling (dev-server only,
  not in `vite build` output) — matches the server doc's accepted O8.
- **`railway.toml`**: `npm install` → `npm run build` → `npm start`, health check `/api/health`
  (the route is unauthenticated and leaks no version — confirmed). The two operational cautions the
  docs already raise stand and I echo them: confirm the **Railway volume is persistent** (if the DB
  resets on deploy, F3 reopens and all accounts/orders vanish each deploy) and set **`TRUST_PROXY_HOPS`
  correctly** if Cloudflare is placed in front of Railway (else every visitor shares one rate-limit
  bucket). `SE_TEST_HOOKS` and `EMAIL_OUTBOX_DIR` must never be set in production; startup warns if
  they are.

### 3.2 Static exposure, redirects, transport (items 5/7)

Confirmed (`poc-09`): `/.env`, `/.git/*`, `/data/*`, `/server/*`, `/package*.json`, `/railway.toml`,
`/docs/*`, `/shared/*.json`, `*.js.map` and the internal `/brand/*.html|pdf|documents/` paths all
**404**; no source maps are emitted by the build; encoded and raw `../`, `..\`, `..%2f`, `..%5c`
traversal (both through the Node client and on a raw socket) all stay inside `client/dist` and 404.
The one open redirect is F9. HSTS (1 year, preload), `frame-ancestors 'none'` + `X-Frame-Options:
DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, the full `Permissions-Policy`, `nosniff`
and `Cache-Control: no-store` on every API response are present on HTML, API JSON, 404 and downloads
alike. CORS reflects no foreign origin and grants a foreign-origin preflight nothing, even with a
forged `Host` matching the origin (`poc-06` B).

---

## 4. Per-hour abuse numbers (Turnstile keys NOT set — the forgotten-launch state)

All per client key: Railway's single trusted hop means a real attacker needs distinct source IPs
(IPv6 clients are keyed by /64, so no free rotation). Numbers below are per source address.

| What an anonymous script can do | Per hour | Per day | Limiter / note |
|---|---|---|---|
| Create usable accounts | 10 | — | `registerLimiter` 10/h/IP; email unconfirmed but checkout-usable while mailer off |
| Fill the admin RFQ queue (rows) | 10 | 30 | `formPerIpHour`/`Day` + `rfqCreateLimiter` 20/h; each may carry a 25 MB attachment |
| Upload CAD / price (queue the parsers) | 50 uploads/15min; 1 parse at a time | 500 MB | `rateUpload`, `PARSE_PER_CLIENT=1`; can't hog workers from one IP |
| Send mail from the shop's domain to **arbitrary** addresses | **0** | **0** | Correctly blocked: unverified sender ⇒ no buyer email (verified it; `rfq.js` L238) |
| Send reset emails (only to real account holders) | 5 | — | `resetPerIp` 5/h; `resetPerAddress` 3/h |
| Lock a known customer/owner out of sign-in | indefinitely | — | F4: 5 bad passwords ⇒ 15-min pause, repeat |
| Mint Stripe checkout sessions (needs one account) | ~200/15min | — | F8; general API limit; no charge |
| Fill the 2 GB upload store / 256 MB DB from many IPs | — | 500 MB per IP | O5/O6: refused with 503 once full; recovery is manual |

With Turnstile **on** (stubbed): confirmation emails to typed addresses are capped at 4/day/recipient
and 8/day/IP (`confirmPerRecipientDay`/`confirmPerIpDay`), and registration/forms gain the challenge.
Every limiter is in-memory and **resets on restart/redeploy** (acknowledged, O5) — so a redeploy
briefly reopens all of the above, and the sign-in pause (F4) survives only because it is also written
to the account row.

---

## 5. Where I disagree with the existing reports' severities

I mostly agree with the three docs; they are unusually candid. Points of difference:

- **Server doc A1 / accounts doc item 6 ("admin land-grab") — I rate the residual higher than
  "Fixed".** The accounts branch closed *instant* admin-on-register, which is real progress, but the
  promotion rule still trusts "any account that holds `ADMIN_EMAIL` and becomes verified." Two live
  paths promote an *attacker's* account (owner clicks the confirm link; owner runs the documented
  `ADMIN_RECOVERY=verify-email`), plus a guaranteed denial-of-registration. This is **High / launch
  blocker**, not closed. (F3)
- **Accounts doc, "An attacker who knows an address can keep its sign-in paused" — rated Low; I rate
  Medium.** It applies to the owner, whose address is guessable, and the attacker can sustain it. (F4)
- **The price-integrity break (F1, F2) is in neither report's severity table.** The server team
  explicitly scoped pricing out ("Nothing in pricing… was changed") and proved only that the *body*
  can't set the total — which is true and necessary but not sufficient. The accounts team scoped
  pricing out too. So the single most serious launch issue fell in the seam between the two branches
  and is currently owned by no one. I rate both **Critical / launch blocker.**
- Everything the docs list as O1 (DB-in-rows growth — now largely addressed by the part-payload split
  on this merged branch), O4 (trust-proxy hops), O6 (storage pin under abuse), F2/F3 (internal brand
  pages, order filename leak) I agree with as rated; O4 in particular is a genuine pre-launch check.

---

## 6. Reproductions

Scripts in `tools/security/review/` (see its `README.md`); run each with the proxy unset, e.g.
`env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 node tools/security/review/poc-01-pricing-process-mismatch.js`.

- **F1:** `poc-01` (honest CNC $398/unit vs. `process:"sheetmetal"`/`"__proto__"`/`"totally-made-up"` → $5/unit = order minimum, gate not tripped) and `poc-02` (same, carried to a **paid** $37 order whose honest price is $2085).
- **F2:** `poc-03` (DXF priced at mm = $169, units swapped to inch = 25× geometry, checkout charges the stale $169, traveler shows the 1016 mm part) and `poc-10`-equivalent lines in `poc-03`.
- **F3:** `poc-02`/`poc-06` (anonymous register of `ADMIN_EMAIL` succeeds as `customer`; owner opening the confirm link flips that account to `admin` and the attacker's live session becomes admin, then downloads the DB and edits pricing).
- **F4:** `poc-05` (five wrong passwords from `203.0.113.200` ⇒ owner's correct password+code from `203.0.113.1` answered 429 `account-locked`).
- **F5:** `poc-04` tail (buyer B puts A's `partId` in B's own quote, reads the geometry + mesh + edit key, changes A's DXF units).
- **F9:** `poc-09` ("redirects" block — `GET //evil.example/` on the apex host ⇒ `301 Location: //evil.example`).
- Negative controls: `poc-04` (full authz matrix — every admin/owner-scoped route correct), `poc-07` (CSRF), `poc-08` (headers/static/downloads), `poc-09` (24 static paths 404 / traversal blocked, 17 error shapes no-leak, secrets/ops confirmations).

— End of review.
