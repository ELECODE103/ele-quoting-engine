# Account and bot hardening — 2026-11-11

Branch `hardening-accounts`, cut from `revisions-2026-11-11`. Not pushed.

Scope: bot checks, the two request forms and their emails, accounts (registration, email confirmation, sign-in, password reset), the admin account, sessions, and who may reach which record. Upload and parsing internals, CSP, body limits, dependency upgrades and file encryption belong to the other hardening branch and were not touched (section 12 lists what was noticed there).

## 1. Summary

| # | Issue | Severity before | Now |
|---|---|---|---|
| 1 | No bot check on registration, either request form, or anonymous upload and pricing | High | Fixed. Turnstile is off until two keys are set (section 9) |
| 2 | Request forms email a confirmation, and the ship-to address, to any typed address | High | Fixed |
| 2a | Typed name, company and PO number in email subjects; a typed line break reached the subject | Medium | Fixed |
| 3 | No email confirmation: an account with someone else's address can order | Medium | Fixed |
| 4 | No password reset; a password change did not end existing sessions | Medium | Fixed |
| 5 | Sign-in: five failures from one IP lock that IP out even with the right password; nothing slows a spread-out attack on one account | High | Fixed |
| 5a | Password rules: 8 characters, no common-password check, over 72 bytes silently cut | Medium | Fixed |
| 5b | Registration tells a visitor that an address already has an account | Low | Open by decision (section 13) |
| 6 | Whoever registers the `ADMIN_EMAIL` address first is the admin | Critical on a new database | Fixed here in part; closed by the review fixes (F3): the address cannot be registered at all and the admin account is made by a one-time setup |
| 6a | Admin protected by one password | High | Fixed in code; the owner must enrol (section 9) |
| 6b | Admin role read from the token, not the database | Medium | Fixed |
| 7 | Session token in browser storage for 24 h, no way to end it | Medium | Fixed: httpOnly cookie, CSRF token, server-side sign-out |
| 8 | A request sent without an account is readable in full by anyone holding its id | Medium | Fixed |
| 8a | DXF units endpoint open to anyone holding a part id | Low | Fixed |
| 8b | Firm-quote links and Stripe return URLs built from the request's Host header when `FRONTEND_URL` is unset | Medium | Fixed |
| 8c | Quote-drawing upload (25 MB per call) not behind any check | Low | Fixed |

Everything else in the authorisation sweep was already correct and is now pinned by tests (section 8).

Verification: `npm test` 29 suites green (25 before; 4 new, 115 tests). `npm run build` prerenders 22 routes. `node scripts/claims-check.js` exits 0. Browser run: 75 checks green against a production-mode server (section 10).

## 2. Item 1 — bot check

**What was wrong.** `POST /api/auth/register`, `POST /api/rfq` (both forms) and `POST /api/upload` / `POST /api/quote` had only per-IP rate limits.

**Fix.** Two layers.

Always on, no keys needed (`server/security/botGuard.js`):

- A honeypot field (`website`) on the register, reset and request forms. Off screen, out of the tab order, hidden from screen readers. A submission that fills it gets an answer shaped like success and nothing happens; one log line records it.
- A form token issued when a form is shown (`GET /api/public/form-token`). It must be at least 3 seconds old when the form comes back, is good for 12 hours, and can be spent once.
- Request forms: 10 an hour and 30 a day per IP; 6 an hour and 20 a day per email address.
- The same request again inside 30 minutes (double click, retry) returns the first answer: one row, one set of emails.
- Sign-in: per-account pause (section 6).

Cloudflare Turnstile, when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set (`server/security/turnstile.js`):

- Every token is posted to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 5-second timeout. A missing, oversized or rejected token, an HTTP error, an unreadable answer, a network error and a timeout all count as not verified.
- Required on: registration, both request forms, the password-reset request, and sign-in after three failures (per IP or per address).
- Quote tool: the first upload opens a small dialog with the check. A pass is traded (`POST /api/human/verify`) for a signed one-hour "verified human" token, which the browser sends with uploads, pricing, DXF-unit changes and drawing uploads. It is not a login: it has its own key and audience and is refused everywhere a session is expected. A signed-in account with a confirmed email skips the check.
- The site key reaches the browser through `GET /api/public/config`. No key is in the bundle, the repo, a test, or a log.
- Cloudflare's published dummy keys count as "not configured" when `NODE_ENV=production`, because the always-pass secret would let every bot through. They are recognised by their shape; the keys themselves appear only in the test file.

With keys missing in production, the startup log prints a boxed warning naming each check that is off and what still runs.

The widget (`client/src/components/security/HumanCheck.jsx`):

- Renders an empty hidden box on the server and on the first client render, then loads Cloudflare's script in an effect. The prerendered `/rfq` page hydrates with no console error (checked in the browser run).
- The script is requested only by a page that mounts the widget and only when the server says the check is on. Home, materials, about, sign-in (before any failure), the quote page (before an upload) and replacement parts never request it.
- Labelled group, live status text, and an alert with the phone number and email when the script is blocked, with a "Try it again" control.

**Tests.** `server/security/security.test.js` (verification, fail-closed cases, timeout, dummy keys, startup warning, form token, honeypot, limits, duplicate replay), `server/routes/botCheck.test.js` (config endpoint, human token, upload and pricing gates, both forms in every state), `server/routes/accountSecurity.test.js` (registration and reset need the check).

## 3. Item 2 — confirmation emails as an abuse vector

**Evidence, before the change** (the unmodified routes, driven by the existing harness):

```
POST /api/rfq  contactName="Free Bitcoin at evil.example\r\nBcc: x@y.z"  email=stranger@elsewhere.test  requestType=part
→ 201, shipTo returned: true
→ mail to owner:     subject "RFQ: Free Bitcoin at evil.example\r\nBcc: x@y.z — part being shipped in (D6FC308D)"
→ mail to stranger@elsewhere.test: "Straightedge: send us the part (reference D6FC308D)"  (contains the ship-to address)
```

**Fix** (`server/routes/rfq.js`). Three decisions per request:

| | Sender verified? | Buyer confirmation | Ship-to address (part form) | Shop notice |
|---|---|---|---|---|
| Turnstile passed | yes | sent, within the caps | on screen and in the email | normal, reply-to = buyer |
| Signed-in account, confirmed email, request for that account's own address | yes | sent, within the caps | given | normal |
| Signed-in account, email not confirmed (mailer configured) | as above for the check | withheld; the page shows the confirm-your-email notice | given only if Turnstile passed | says no confirmation was sent |
| Keys set, token missing or rejected | — | request refused with 403; nothing stored, attachment deleted | — | none |
| No keys, or Cloudflare unreachable | no | withheld | withheld; the page says a person replies with it | subject ends `[unverified sender]`, body opens with `UNVERIFIED SENDER`, no reply-to |

Caps on confirmations to a typed address: 4 a day per recipient, 8 a day per IP. Past the cap the request is still taken and the shop is told no confirmation went out.

Email content:

- No subject carries typed text. Shop subjects are now `RFQ: 1A2B3C4D — 2 part(s)`, `Quote 1A2B3C4D accepted on a purchase order — $4,250.00`, `New order 1A2B3C4D — $908.75 (purchase order)`. Name, company and PO number stay in the body.
- `server/services/mailer.js` cleans every message at the last step: a recipient or reply-to must be exactly one plain address (no list, no display name, no angle brackets, no line breaks) or the message is refused; control characters in a subject become spaces. `RFQ_NOTIFY_TO` may still hold several addresses separated by commas.
- `server/emails/templates.js`: `esc()` now also escapes single quotes; button links must be http(s), mailto or tel; the buyer greeting uses the first word of the typed name only when it is letters, so a web address or slogan typed as a name is not repeated to the address it was sent to.
- The new account emails (confirm, reset, changed, paused, two-step) contain no typed text at all.

**Tests.** `botCheck.test.js` covers each row of the table, the caps, the honeypot, and header and HTML injection in every field. `security.test.js` feeds hostile values through every template and checks each subject.

**Changed existing assertion.** `rfqQuote.test.js` asserted that the shop subject contains the PO number. That is typed text, so the assertion now checks it is in the body and not in the subject.

## 4. Item 3 — email confirmation

- Registration sends a link (`/verify-email#token=…`): signed, 24 hours, single use. The token is in the URL fragment, which is not sent to servers or logged, and the page removes it from the address bar.
- Opened in the browser that registered, the link confirms at once. Opened anywhere else it shows a "Confirm my email" button, so a mail scanner that follows links cannot confirm an address its owner never saw.
- Resend: signed-in account only, once a minute, five a day.
- Unconfirmed accounts can upload, price and save quotes. `POST /api/orders/checkout-session` answers 403 `email-unverified`; the checkout page shows the reason, the address, a resend button, and switches the pay button on by itself once the address is confirmed (typed shipping details are kept).
- Mailer not configured: confirmation cannot work, so checkout is not held back, and the startup warning says so.
- A password reset proves the same mailbox, so it also confirms the address.

**Migration.** `server/security/accountMigration.js` adds the columns and, at the moment `email_verified_at` is first added, marks every existing account confirmed. Proven on a database created by `master` code (owner, a customer with an 8-character password, a part, a quote, an order, a request):

```
first start on the master database:
  new user columns 5/5, new rfq columns 2/2, revoked_sessions table present
  owner@…  role admin     verified true  (verified-at = created-at)
  old@…    role customer  verified true
  owner sign-in 200, role admin · customer sign-in with the 8-character password 200
  customer sees 1 order · admin stats 200 · old request senderCheck null · existing account can check out 200
second start on the same file:
  an account registered under the new code is still unverified
```

**Tests.** `accountSecurity.test.js` (link forged, wrong kind, wrong address, expired, used twice; resend limits; checkout held and released; no-mailer case), `security.test.js` (migration additive, idempotent, backfill once).

## 5. Item 4 — password reset

- `POST /api/auth/password-reset/request` answers the same 200 body for every address and does the lookup and the send after responding. Needs the form token and, with keys, Turnstile. 5 requests an hour per IP; 3 emails an hour per address.
- The link (`/reset-password#token=…`) is signed, good for one hour, and bound to the current password hash and token version, so it dies when used and when any other reset completes.
- `POST /api/auth/password-reset/confirm` applies the password rules, bumps the account's token version (every earlier session stops working), lifts any sign-in pause, and sends a "password was changed" email. It does not sign anyone in.
- Two-step sign-in is not switched off by a reset.

**Tests.** `accountSecurity.test.js`: identical answers and body length for known and unknown addresses, limits, forged / expired / wrong-kind links, weak password refused, old password and old sessions dead, link spent, second link dead, pause lifted.

## 6. Item 5 — sign-in protection

**Evidence, before.** Three correct sign-ins, then five wrong ones, then the right password from the same IP:

```
200 200 200 401 401 401 401 401 → 429 "Too many login attempts. Please try again in 15 minutes."
```

Correct sign-ins were not counted (the limiter had `skipSuccessfulRequests`), so that part of the review finding does not reproduce. What does: after five failures from an IP the right password is refused for everyone behind that IP (one office, one address), and an attacker using many IPs is never slowed per account.

**Fix** (`server/security/loginGuard.js`, `server/routes/auth.js`). Failures only, two counters over 15 minutes:

- Per IP: after 3 failures the bot check is required (with keys); after 20 the IP is refused.
- Per address: **no longer a pause.** (It was "5 failures pause sign-in to that address for 15 minutes from every connection", which let anyone who knew an address keep its owner out: review finding F4.) Now: a browser that has signed in to the account before holds a signed device proof and is counted on its own; any other browser gets the bot check after 3 failures for the address, each guessing connection waits 1, 2, 4, 8 then 15 minutes from its fifth wrong password, the owner is emailed once a day at 20 failures an hour, and browsers the account has never used are refused at 100 failures an hour. A completed password reset makes that browser a known device. Guess rates: 11 in the first hour then 4 an hour from one address; 100 an hour from any number of addresses. See `server/security/loginGuard.js` and `docs/security/review-fixes-2026-11-11.md`.
- The per-address counter is keyed on the address as typed whether or not an account exists, and unknown addresses are paused the same way with the same words.
- One bcrypt comparison always runs (against a throwaway hash for an unknown address). Measured over 15 attempts each: wrong password median 369 ms, unknown address median 368 ms. The pause is written to the account and the email sent after the response has gone.

Password rules for new passwords (`server/security/passwords.js`): at least 10 characters; the existing three classes (upper, lower, digit) and nothing added; refused if on the bundled list of 9,113 most-used passwords of 10+ characters (NCSC / Have I Been Pwned top 100k, via SecLists, MIT), if one repeated character, or if built from the account's address or our name; over 72 bytes refused instead of silently cut. Existing passwords keep working.

**Enumeration check.** Sign-in: none. Reset: none. Registration: still answers 409 for an existing address (section 13).

**Tests.** `accountSecurity.test.js` (ten correct sign-ins in a row from one IP, challenge after three, pause at five identical for a ghost address, email to the owner only, pause expiry, 20-failure IP cap, bcrypt called for unknown addresses), `security.test.js` (counter arithmetic, password rules).

## 7. Items 6 and 7 — admin account and sessions

**Evidence, before.**

```
POST /api/auth/register  email=owner@shop.test (= ADMIN_EMAIL), fresh database → 201, role "admin"
role changed to "customer" in the database → GET /api/admin/stats with the old token → 200
```

**Admin role.**

- Every new account is a customer and stays one: no public route gives the admin role. The `ADMIN_EMAIL` address cannot be registered, confirmed or reset from the public pages (it is answered like any address that already has an account). The admin account is made by the one-time setup below ("First admin account"). An admin that already exists in the database is not touched at startup. *(This replaces the earlier rule, "promoted when its email is confirmed", which the independent review showed could promote an account someone else had registered: F3.)*
- `authenticate` loads the account from the database on every request. Role, email-confirmed flag and token version come from the row; the role inside the token is ignored.
- Admin sessions last 4 hours (`ADMIN_SESSION_HOURS`), customers 24. An account that became admin after sign-in is held to the 4 hours.
- The startup log names any admin account whose address is not `ADMIN_EMAIL`.

**Two-step sign-in** (`server/security/totp.js`, RFC 6238 on Node's crypto, checked against the RFC 6238 and RFC 4226 vectors):

- Admin → Security. Enter the password; the server makes a 160-bit secret and returns the setup key and the QR code as a grid of cells that the page draws as SVG. No image service, no markup or data URI on the wire.
- Entering a code from the app switches it on, ends the account's other sessions, and shows ten recovery codes once. Recovery codes are stored as keyed hashes.
- The secret is stored as AES-256-GCM ciphertext under a key derived from `JWT_SECRET`, bound to the account id. It is not logged and no endpoint returns it after setup. Starting setup again makes a new secret.
- Sign-in with the right password and no code answers `two-factor-required` and creates no session. A code is accepted one 30-second step either side and never twice. Wrong codes count toward the pause. A used recovery code is spent and the owner is emailed.
- A red banner sits on every admin page until enrolment is done.
- `ADMIN_RECOVERY=reset-2fa` (lost phone and codes) acts on the `ADMIN_EMAIL` account at startup; `ADMIN_RECOVERY=setup-code` (lost password and no working mailbox) re-opens the one-time setup for it with a new `ADMIN_SETUP_CODE`. Both print a warning until removed. `ADMIN_RECOVERY=verify-email` no longer exists.

**Sessions** (`server/security/session.js`).

- The session JWT carries a token version and a session id. A password change, switching two-step on or off, or "sign out everywhere" bumps the version. Sign-out writes the session id to `revoked_sessions` until it would have expired.
- The browser holds the session in a cookie: `HttpOnly; SameSite=Strict; Path=/`, and in production `Secure` with the `__Host-` prefix. Nothing about the session is in localStorage or sessionStorage; the page asks `GET /api/auth/session` who is signed in.
- Cookie requests that are not GET need `X-CSRF-Token`, an HMAC of the session id handed out by the session endpoint. Where sign-in is optional (pricing, request form) a cookie without the token is treated as a guest.
- Auth endpoints accept JSON only, so a form posted from another site is refused before it is read.
- Checked for breakage: the return from Stripe (a cross-site navigation, simulated in the browser run from another host), firm-quote links (no session involved), and every API call from the app.
- `Authorization: Bearer` is still accepted for API clients and the suites. Sessions issued before this deploy have no session id and stop working: everyone signs in once more.

**Tests.** `accountSecurity.test.js` (promotion only after confirmation, demotion effective on the next request, forged role claims, session lengths, sign-out, sign-out everywhere, nine kinds of non-session token refused, cookie flags in both modes, CSRF, the whole two-step life cycle, both recovery actions, and a final check that no password, token, emailed link, setup key or recovery code appeared in any log line).

## 8. Item 8 — authorisation sweep

`server/routes/authorization.test.js` has two parts.

1. An inventory of all 79 routes in the five routers, each marked open (24), sign-in (10) or admin (45). A route added later without an entry fails the suite. All 45 admin routes are called as a guest (401), as another customer and as the order's own customer (403), with real ids, and a before/after snapshot shows nothing changed. All sign-in routes are called as a guest (401).
2. Object checks: another customer and a guest against one customer's quote, quote session, quote drawing, order, order drawing, reorder, payment confirmation, traveler, PDFs, part download and request.

Findings:

| Route | Before | Now |
|---|---|---|
| `GET /api/rfq/:id` for a request sent without an account | whole row to anyone with the id: name, email, phone, notes, quoted price | status, reference and date only; owner and admin see the request |
| `POST /api/parts/:partId/units` | anyone with the part id could re-read the file and replace the stored geometry | needs the edit key returned to the uploader, the human gate, and the part must not be on an order or request |
| `GET /api/orders/:id/traveler` | 404 or 403 depending on whether the order exists | admin check first |
| `POST /api/quote/:id/drawing` | ungated 25 MB write | behind the human gate |
| Firm-quote link and Stripe return URL host | request Host header when `FRONTEND_URL` unset | `FRONTEND_URL`, else one of our hosts, else the brand URL |

Confirmed correct, now under test:

- Orders, order drawings, reorder, payment confirmation: owner or admin only. A guest's PO order (no account) is not readable by any customer.
- Quotes bound to an account: 404 to everyone else. Re-pricing with someone else's quote id creates a new quote and carries nothing over.
- Firm-quote links: tampered payload, `alg: none`, cut signature, a session token, a human token, a reset link, and a token signed with the session key are all refused. Expired and superseded links answer 410. A link is not accepted as a login anywhere.
- PO acceptance: only an RFQ in `quoted` status accepts. `new`, `in-review`, `declined` and `lost` answer 409 and create no order. A link cannot be made without the key, so a bot cannot create `pending_po` orders; the holder of a live link can accept once, at the owner's price.

## 9. Environment variables and switching each protection on

| Variable | Effect | Default |
|---|---|---|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | switch the Turnstile check on (both needed) | off |
| `EMAIL_API_KEY`, `EMAIL_FROM` | existing; now also required for email confirmation, reset and pause emails | off |
| `ADMIN_SESSION_HOURS` | admin session length, 0.25 to 24 | 4 |
| `ADMIN_RECOVERY` | `setup-code` (re-open the one-time admin setup; needs a new `ADMIN_SETUP_CODE`) or `reset-2fa`; acts on the `ADMIN_EMAIL` account; remove after use | unset |
| `ADMIN_SETUP_CODE` | a code the owner invents (20 characters or more) to open the one-time admin setup at `/admin/setup`; works once, only while there is no admin; remove after use | unset |
| `JWT_SECRET` | existing; a warning now prints if shorter than 32 characters | — |
| `FRONTEND_URL` | existing; now the only source of the host in emailed links apart from our own hostnames | — |
| `RAILWAY_PUBLIC_DOMAIN` | set by Railway; that host is accepted for links when `FRONTEND_URL` is unset | — |

**Turnstile (owner).**

1. Wait until the other hardening branch is deployed: the page's Content-Security-Policy must allow `https://challenges.cloudflare.com` for scripts and frames. With keys set and that not yet live, the widget is blocked and the forms tell visitors to call.
2. Cloudflare dashboard → Turnstile → Add widget. Name it. Under hostname management add `nordmfg.com`, `straightedgemfg.com`, `www.straightedgemfg.com` and the Railway host (the `….up.railway.app` name on the service's Settings → Networking). Widget mode: Managed. Create.
3. Copy the two values into Railway → the service → Variables: `TURNSTILE_SITE_KEY` (the site key) and `TURNSTILE_SECRET_KEY` (the secret key). Railway redeploys.
4. Check the deploy log: the `BOT CHECK IS OFF` box is gone. Open `/rfq` in a private window: a small Cloudflare box appears above the send button.

**Email confirmation and reset.** Nothing to do beyond `EMAIL_API_KEY` and `EMAIL_FROM`. Set `FRONTEND_URL=https://straightedgemfg.com`.

**First admin account (owner).** The admin account is not made by registering. Do this once, on a new database (an admin account that already exists is left exactly as it is, and none of this is needed):

1. Make sure `ADMIN_EMAIL` is set in Railway → the service → Variables to the address the admin account will use.
2. Invent a setup code: 20 characters or more, not a word or a repeated letter. Nobody gives it to you and the site never shows it. Add it in the same place as a new variable named `ADMIN_SETUP_CODE`. Railway redeploys.
3. In the deploy log, find the line "there is no admin account yet. The one-time admin setup is OPEN at /admin/setup".
4. Open `https://straightedgemfg.com/admin/setup` (it is not linked from anywhere). Enter the setup code and choose the password you will sign in with.
5. You are taken to the admin pages, which ask you to set up two-step sign-in before anything else opens (next paragraph). Do it now.
6. Go back to Railway and delete the `ADMIN_SETUP_CODE` variable. The code has stopped working (setup closes the moment the account exists, and a code is accepted once), and the deploy log reminds you to remove it until you do.

If someone had already registered the admin address as an ordinary account, step 4 takes that account over: its password, sessions and emailed links stop working and it becomes your admin account. The deploy log and the admin Change log record that this happened.

Locked out later, with no working mailbox to reset the password: set `ADMIN_RECOVERY=setup-code` and a *new* `ADMIN_SETUP_CODE`, redeploy, open `/admin/setup` again, then remove both variables. Lost only the phone and the recovery codes: `ADMIN_RECOVERY=reset-2fa`, redeploy, sign in, enrol again, remove the variable. Five wrong setup codes from one connection stop that connection for 15 minutes; twenty from anywhere lock setup until the next deploy.

**Admin two-step sign-in (owner).** Sign in → Admin → the red banner → "Set it up now" → password → scan the QR code with an authenticator app → enter the 6-digit code → save the ten recovery codes somewhere that is not the phone.

**JWT_SECRET.** Use a long random value before enrolling. Changing it later signs everyone out and makes the stored two-step secret unreadable; use `ADMIN_RECOVERY=reset-2fa` and enrol again.

## 10. Browser run

`scripts/e2e/hardening-accounts.mjs` starts the production-mode server itself (the command from the brief, plus throwaway Turnstile keys), with Turnstile siteverify, Resend and Stripe replaced in the server process by `scripts/e2e/stub-network.cjs` and Cloudflare's widget script replaced in the browser by a stand-in. 75 checks, all passing:

- A. Register → checkout held → confirm by link → pay → order paid. Cookie flags, nothing in storage, cross-site return.
- B. Both request forms with the check passed: both emails sent, address shown.
- C. Widget script blocked: message with phone and email, nothing sent; six pages that never request the script.
- D. Password reset end to end; same answer for an unknown address; old session and old password dead.
- E. Pause after five wrong passwords, same for a ghost address, owner emailed, lifted by reset.
- F. Admin: no role before confirmation, banner, enrolment, sign-in with a code, sign-in with a recovery code, sign-out dead on the server, 4-hour session.
- G. A guest and a second customer refused on 30 account-scoped routes each, with no order data in any answer.
- H. A second server with no keys: startup warning, both forms taken as unverified senders with no buyer email and no address, honeypot and minimum time still working, the admin queue's "Unverified sender" mark.

Two notes on the run. Browser contexts used `bypassCSP` because this branch's CSP does not yet list `challenges.cloudflare.com`; scenario C ran without the bypass. The stand-in widget proves the wiring, not Cloudflare's own behaviour, which needs the real keys.

Screenshots at 1360 px are in `docs/screenshots/hardening-2026-11-11/` (27 files). The ship-to address is masked in `part-request-verified.png`.

## 11. What changes for a real customer

| Step | Change | Added friction |
|---|---|---|
| Reading the site | none | none |
| First upload in the quote tool | a small "One quick check" dialog; usually closes by itself | a second or two, once an hour; none for a signed-in confirmed account |
| Pricing, changing options | none after the check | none |
| Creating an account | password needs 10 characters and must not be a common one; the Cloudflare box above the button; one confirmation email | a longer password; a 3-second minimum before the form can be sent |
| Checkout, first time | the pay button is off until the emailed link is opened; the page says so and carries on by itself | one email round trip per account, once |
| Checkout, existing accounts | none (existing accounts are treated as confirmed) | none |
| Firm-quote or send-the-part request | the Cloudflare box; a visitor whose browser blocks it is told to call or email | none when it passes |
| Send-the-part request with no keys set | accepted, but the address comes in a reply from a person, not on the screen | the buyer waits for a reply. This is the state until the keys are set |
| Wrong password | after three, the Cloudflare box; from the fifth, that connection waits (1, 2, 4, 8, 15 minutes); the account is not paused | by design (changed by the review fixes, F4) |
| Forgotten password | new: a reset link by email | — |
| Signing out | ends the session everywhere it was copied | none |
| After deploy | everyone signs in again once | one sign-in |
| Owner | sign in again every 4 hours; a 6-digit code once enrolled | by design |

## 12. Noticed outside this scope (for the other branch)

- CSP must allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`. Nothing else is needed: the QR code is inline SVG and the session needs no new source.
- `cors.allowedHeaders` lists only `Content-Type` and `Authorization`. The app now also sends `X-CSRF-Token`, `X-Human-Token`, `X-Form-Token`, `X-Turnstile-Token` and `X-Part-Key`. Same-origin requests are unaffected; a split front end would need them listed.
- `express.urlencoded` is mounted globally with a 50 MB limit and no route reads form-encoded bodies. It lets a plain cross-site form reach JSON routes without a preflight.
- `data/quote-drawings` and `data/rfq-drawings` are outside the retention sweep and the at-rest encryption, and a replaced quote drawing is left on disk.
- A comment above `/admin/backup/db` says Railway storage is ephemeral and the database resets on every deploy. If that is still true, accounts, orders and two-step enrolment are lost at each deploy.
- `/admin/backup/db` downloads the whole database, including password hashes and the encrypted two-step secret.
- The Stripe webhook accepts unsigned events whenever `NODE_ENV` is not `production`.
- `sanitizeString` removes text by pattern: `on\w+\s*=` deletes "one =" out of "tone = 5", and anything between `<` and `>` is dropped ("5 < 10 > 3"). Output is already escaped by React and the email templates.
- The global API limit is 200 requests per 15 minutes per IP, shared by everyone behind one office address.

## 13. Open items

| Item | Severity | Notes |
|---|---|---|
| Turnstile keys not yet set | High until done | Without them: no challenge anywhere, and anonymous request-form senders get no confirmation and no address (the replacement-parts page says they get both) |
| CSP does not yet allow the widget | High if keys are set first | Merge and deploy the CSP change before setting the keys |
| Owner not yet enrolled in two-step sign-in | High until done | Banner shows until it is. Enrolment is not forced |
| Database persistence on Railway unconfirmed | High if ephemeral | See section 12 |
| `JWT_SECRET` strength unknown | Medium | Startup warns under 32 characters |
| Registration reveals that an address has an account | Low | Bot-checked and limited to 10 an hour per IP. Removing it means a new account is not signed in until the emailed link is opened |
| A visitor whose browser blocks Cloudflare cannot send a form | Low | Told to call or email. Alternative: accept as an unverified sender |
| An attacker who knows an address can keep its sign-in paused | Closed by the review fixes (F4) | the address is no longer paused; a browser the owner has used before is never affected, and a password reset makes any browser one |
| Throttles and the duplicate cache are in memory | Low | Reset on restart; correct for one process |
| The verified-human token can be replayed for its hour | Low | Not accepted by the forms or registration; the global API limit still applies |
| Sign-in and registration responses still include the token in JSON | Low | For API clients and the suites; the browser app ignores it |
| Two-step sign-in is admin-only; no change-password or change-email screen | Low | Reset covers a forgotten or exposed password |
| Honeypot false positive | Low | A browser that auto-fills the hidden field would have its request dropped; a log line records each drop |
