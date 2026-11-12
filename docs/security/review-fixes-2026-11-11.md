# Fixes for the independent security reviews — STRAIGHTEDGE — 2026-11-11

Branch `review-fixes`, cut from `hardening-2026-11-11` with `security-review-2026-11-11` and
`security-review-payments-2026-11-11` merged in. This document answers two reports:

- `docs/security/independent-review-2026-11-11.md` — findings **F1–F9** (scripts in `tools/security/review/`)
- `docs/security/independent-review-payments-2026-11-11.md` — findings **F-01…F-18** (scripts in `tools/security/review-payments/`)

Every finding was first reproduced on the old code with the reviewer's own script, then fixed as a
class, then turned into a permanent test in `npm test`. Nothing here touched the live site, Stripe,
Cloudflare or the mailer; every key, password and setup code in the tests is made at run time.

**No price changed for a legitimate configuration.** `tools/vet-quotes/run_vetting.js` against a
production-mode server, before and after: 300 quotes, 0 fails, 63 warnings both times, and
`results.csv` is identical in every column except the random quote id (0 of 300 rows differ). The only
change to the tool is that it sends each part's edit key with its quote requests (F5).

## 1. Summary

| Finding | Severity | Status | Permanent test |
|---|---|---|---|
| F1 / F-02 process, material, thickness, grade, finish not validated | Critical | Fixed | `server/routes/priceIntegrity.test.js` (F1 tests), `server/processes/registry.test.js` |
| F2 / F-01 checkout charges a stale quote (DXF units changed after pricing) | Critical | Fixed | `priceIntegrity.test.js` (F2 tests) |
| F3 admin account land-grab | High | Fixed | `server/routes/adminSetup.test.js`, `server/routes/adminExisting.test.js` |
| F-03 three ways round the quote gate | High | Fixed | `priceIntegrity.test.js` (F-03 test) |
| F4 sign-in lockout of any address | Medium | Fixed | `server/routes/signInThrottle.test.js` |
| F-04 saved quote charged as saved, many orders per quote | Medium | Fixed | `priceIntegrity.test.js` (F2 / F-04 tests) |
| F-05 sent-out finish on Expedited by another process's slug | Medium | Fixed | `priceIntegrity.test.js` (F1 options test), `server/routes/checkoutFunnel.test.js` |
| F-13 blank or zero material price sold at a built-in figure | Medium | Fixed | `server/routes/adminCatalog.test.js`, `priceIntegrity.test.js` (F1 / F-13 test) |
| F-14 lead-time multiplier saved and never used | Medium | Fixed | `adminCatalog.test.js` |
| F5 parts not bound to their uploader | Low | Fixed | `server/routes/partOwnership.test.js` |
| F9 open redirect from the path normaliser | Low | Fixed | `server/seoRedirect.test.js` |
| F-09b firm quote saved at 0 while it is out | Low | Fixed (admin save only) | `priceIntegrity.test.js` (firm-quote test) |
| F-12 nothing refuses to sell far under cost | Low | Fixed (floor) | `priceIntegrity.test.js` (floor test) |
| F-15 only the rate card is logged | Low | Fixed | `adminCatalog.test.js` |
| F7 session token returned in JSON | Info | Fixed | `adminSetup.test.js` (F7 test) |
| F8 unlimited Stripe sessions per account | Info | Fixed | `priceIntegrity.test.js` (F-04 test) |
| F6 abuse with no Turnstile keys | Low | Not in this branch (other reviewer's item) | — |
| F-06, F-07, F-08 (session expiry), F-09 (re-send), F-10, F-11, F-17, F-18 | — | Open here: branch `order-lifecycle-fixes` | — |
| F-16 traveler leaves out what was priced | Medium | Data provided here; layout on branch `journey-qa` | `priceIntegrity.test.js` (snapshot assertions) |

## 2. The one place a price is made

Everything below rests on one rule: **a price comes from `priceQuote` in `server/routes/api.js`
and from nowhere else**, and `priceQuote` does four things in order, each in
`server/services/quoteIntegrity.js`:

1. `resolveLine` — the whitelist. Every option of every line is looked up in the catalog; nothing is defaulted.
2. the engine (`pricingEngine.calculateOrderQuote`) on what `resolveLine` returned, never on the raw request.
3. `assertSane` — the floor. The result is checked before anyone sees it.
4. the gate (`services/quoteGate.js`) and the fingerprint (`fingerprintQuote`), saved with the quote.

Orders and Stripe sessions are made only after `verifyQuoteForOrder` has run the stored quote
through the same four steps again (section 4).

## 3. Findings

### F1 (Critical) and F-02 (High) — the request chose how the part was priced

**Reproduced.** `poc-01`, `poc-02` (review) and `poc-02` (payments) on the old code: five PEEK blocks,
honestly $2,085.04, priced at $25–$62 by sending `process: "sheetmetal"`, any made-up word, or
`__proto__`; carried to an order marked paid for $37. Aluminium ordered as a "3D print". HDPE at
0.01 mm with a free-text grade that printed on the packing slip.

**Root cause.** `priceQuote` took the process from the request. `resolveProcess` in
`server/processes/registry.js` answered an unknown name with the sheet-metal model (and found
`__proto__` on a plain object). The material was looked up by slug only and never compared with the
process; the finish likewise; thickness, grade, sub-process and layer height were used as sent; quantity
was coerced (2.7 became 2, −4 became 1). The pricing models then filled the gaps with built-in figures
(`|| 1.0` $/kg, `|| 6.0`, `|| 0.1` $/cm³), so a wrong pairing produced a small number instead of an error.

**Fix — the class, not the example.**

- `registry.js`: processes live in a `Map`; `resolveProcess` throws `UnknownProcessError` for anything
  that is not a registered process; `activeProcess(slug)` returns only a process the site offers.
  No fallback exists any more. The same default was removed from `pricingEngine.js`, from the DFM
  path in `parsers/fileParser.js`, and from the admin phone-order route (`|| "sheetmetal"`).
- `quoteIntegrity.resolveLine` checks, per line: the process is registered **and active**; the material
  exists, is listed, and belongs to that process; a DXF is routed, in a sheet material, at a stocked
  thickness (the one tie between a kind of file and a process); the grade is one of the material's
  grades; the sub-process is the material's (turning remains gated to a person); the thickness is in
  the material's stock list; the finish is listed for that process **and** goes on that material
  (anodize on aluminium, polished edges on acrylic/polycarbonate, and so on — the rules the finish
  names already state); the layer height is in the material's list; infill is 5–100 %; quantity is a
  whole number from 1 to 1,000,000; the lead time is listed and active. Numbers must be numbers (or
  the plain decimal a form field holds — not `"1e2"` or `"0x10"`). Anything else is a 400 with a
  stable `code` and the `field` to reset. Options a process does not have (infill on a machined
  part) are dropped, not priced.
- `processes/shared.js` `requiredPrice`: a model that needs a price or a density the catalog record
  does not have throws; it does not substitute a figure (also F-13).
- `quoteIntegrity.assertSane`, the floor, runs on every computed quote: each line and the total are
  finite and positive; each line was priced by the model and in the material that were asked for;
  line total = unit × quantity; the unit price is not under the engine's own cost after its
  discounts, **not under the engine's own material cost** (F-12), and not under an independent
  estimate of the raw material in the part (volume × density × catalog price, with slack); the order
  does not sit on the order minimum while its cost is far above it. A failure is a 422
  `price-check-failed`, logged with the tag `[price-integrity]` and emailed to the shop (at most five a
  day). A small part at the order minimum passes and checks out (tested).
- `GET /api/materials` and `GET /api/finishes` list only items of active processes (the public
  finish list no longer shows the sheet-metal finishes), and a finish carries the materials it goes on.

**Why the class is closed.** The engine never sees a request value: it sees catalog rows that
`resolveLine` selected. A value that is not in the catalog has no row. A future model that goes
wrong the same way is stopped by the floor, which the test proves by swapping the CNC model for the
sheet-metal one.

**What the scripts get now.** `poc-01`: every cheat is `400` — `process-not-offered` (sheetmetal,
`bogus`, `__proto__`, `constructor`), `material-process-mismatch`, `sub-process-not-offered`,
`grade-not-offered`, `finish-not-offered`, `quantity-invalid`, `infill-out-of-range`,
`config-invalid`, `lead-time-not-offered`; honest quotes are unchanged ($249.43, $411.88, $83.16).
`poc-02` (review): the cheat quote is refused, checkout has nothing to buy, 0 Stripe sessions.
`poc-02` (payments): 0 of 4 checks show the weakness (`process-not-offered`,
`material-process-mismatch`, `thickness-not-offered`, `grade-not-offered`).
`poc-05` (payments): 0 of 8, including F-05 (`finish-not-offered` for the sheet-metal slug; the
CNC anodize slug on Expedited is still `finish-lead-time`).

### F2 (Critical), F-01 (Critical), F-04 (Medium) — checkout charged what was saved

**Reproduced.** `poc-03` (review) and `poc-01` (payments) on the old code: a DXF priced as 40 × 30 mm
for $169.22, units switched to inches (1016 × 762 mm), paid $169.22 for a job the engine prices at
$6,172.77. `poc-04` (payments): a quote saved before a price rise, a tightened gate or a material
being switched off still checked out, any number of times.

**Root cause.** Checkout read `quote.orderTotal` and charged it. The quote was never priced again;
the part it pointed at could change under it; the units lock began when an order existed, not when
a price did; nothing tied a quote to one order.

**Fix.**

- **Re-pricing at checkout.** `verifyQuoteForOrder` (`routes/api.js`) prices the stored
  configuration again through `priceQuote` — current geometry, current rules and catalog, whitelist,
  floor, gate — and `quoteIntegrity.judgeCheckout` decides:
  - the gate now asks for a person → `409 rfq-required`;
  - totals and every line agree to the cent → charge;
  - they differ, but the quote is inside its 30-day hold **and** its fingerprint (each part's
    geometry hash + the normalised configuration + lead time + paperwork) is exactly what was
    priced **and** the gate result is unchanged **and** the held price is at least half of today's
    → charge the held price (this is the price hold the site promises);
  - otherwise → `409 quote-changed` with `previousTotal`, `newTotal` and the quote at today's price,
    already saved, for the buyer to confirm. The checkout page shows the new total and asks.
  - something on the quote can no longer be priced (material switched off, option retired) →
    `409 quote-needs-update`.
- **A units change re-prices at once.** `POST /api/parts/:id/units` calls `refreshDraftQuotesFor`:
  every draft quote holding the part is priced again in place (or marked stale if it cannot be).
  The size can still be corrected before ordering — a buyer fixing inches/millimetres needs that —
  but the price moves with it.
- **One quote, one order.** A quote with a paid or pending order answers `409
  quote-already-ordered`. The buyer's own unpaid order is resumed, on the Stripe session it already
  has if that is still open for the same amount (F8), and it is checked again each time (same
  re-pricing; a refusal carries `reopen: true`).
- **The owner can end every hold.** Admin → Change log → "End price hold on open quotes"
  (`POST /api/admin/quotes/void-open`): every draft quote, and every quote whose order was started
  and never paid, answers `410 quote-expired` until it is reopened and priced at today's rules.
- **The order records what was priced.** Each order line stores `config.priced`: fingerprint,
  geometry hash, units, source units, dimensions in mm, volume, process, sub-process, material,
  grade, **thickness**, finish, quantity, layer height, infill. `GET /api/orders/:id/traveler` returns
  it with `matchesPriced` (the part as it is now against the part as priced). This is the data F-16
  asks the traveler to print; the layout is on the designer's branch.
- **Reorder** and the **admin phone-order route** go through the same check (section 4).
- `server/services/expectedCharge.js` exports `expectedCharge(order)` — today the order total in
  whole cents — as the single figure the webhook and confirm-payment should compare against. The
  comparison itself stays in `orderEvents.js`, which this branch does not edit.

**What the scripts get now.** `poc-03` (review): the units switch re-prices the draft to $6,172.77
and checkout answers `409 rfq-required` (over the big-ticket limit); 0 Stripe sessions.
`poc-01` (payments): Stripe is asked for $4,666.99 for the full-size part — the honest price; 0 of 1.
`poc-04` (payments): after the price rise `409 quote-changed` (was $706.78, now $2,162.21), 0
sessions until the buyer confirms $2,162.21; a second checkout of the paid quote `409
quote-already-ordered`; the switched-off material `409`; after "end price hold" `410 quote-expired`;
0 of 6. `poc-10`, `poc-11`, `poc-12` (payments): 0 of 4, 0 of 2, 0 of 9.

**Kept by design.** A small price rise does not change a quote already given: that is the 30-day
hold. It is honoured only for exactly what was priced and never below half of today's price, and the
owner has the "end price hold" action.

### F-03 (High) — round the gate

**Reproduced** with `poc-03` (payments): 500 pieces as five lines of 100; an $11,168 order with no
line over $5,000; a CNC line that fails the envelope check paired with a routing line for the same part.

**Root cause.** Quantity and the big-ticket limit were looked at per line, and the DFM result was
stored per part, so the last line for a part overwrote the first.

**Fix** (`services/quoteGate.js`): quantity is summed per part, per identical geometry (two uploads
of the same file) and per order (`order-quantity`); the parts total of the order is held to the
existing big-ticket rule value (`big-ticket-order`); DFM is kept per line (`dfmByLine`) and each line is
judged on its own result. The order-level reasons are added only when no line is already flagged,
which is why the vetting CSV is unchanged. A refused checkout answers `409 rfq-required` with the
reasons; the page sends the buyer to the firm-quote form with the lines carried over.

**Now:** 0 of 4 checks show the weakness; each of the three returns `409 rfq-required`.

### F3 (High) — whoever registered the admin address first

**Reproduced** with `poc-02` and `poc-06` on the old code: the attacker registers the `ADMIN_EMAIL`
address; when the owner opens the confirmation link that lands in his inbox (or runs
`ADMIN_RECOVERY=verify-email`), the attacker's account becomes the admin and the database is downloaded.

**Root cause.** The admin role was a side effect of public flows: confirm the address → promoted.

**Fix** (`server/security/adminAccount.js`, `server/routes/auth.js`, `client/src/pages/AdminSetupPage.jsx`):

- No public route gives the role. `promoteIfOwner` is gone. The admin address cannot be registered,
  confirmed, re-sent a link or reset from the public pages; each of those answers exactly as for any
  address that already has an account (same status and body, and no email is sent).
- The admin account is made **out of band**, once, at `/admin/setup` (not linked from anywhere), with
  a code the owner invents and sets as `ADMIN_SETUP_CODE`. The code is never generated, logged or
  echoed. It must be at least 20 characters with at least 8 different characters, is compared in
  constant time, is limited to 5 tries per connection per 15 minutes and 20 in total (then locked
  until the next deploy), and works once: setup closes the moment an admin exists, and the startup
  log says to remove the variable.
- Setup sets the password under the existing rules and lands in the existing forced two-step
  enrolment. If an ordinary account already holds the address (a squatter), setup takes it over: new
  password, every session and emailed link dead (token version bumped), address confirmed, role set,
  an `AUDIT admin-setup` log line.
- An admin that already exists is not touched at startup. Proven twice: by hand on a database
  created by `origin/master` code (`255753c`: admin registered there, server then started on this
  branch — same role, same password hash, signs in with the old password, taken to two-step
  enrolment exactly as on the pre-fix tree, setup refuses even the right code), and permanently by
  `adminExisting.test.js`, which builds a database in master's schema and starts the real server on it.
- `ADMIN_RECOVERY=reset-2fa` is kept. `verify-email` is removed (it now logs that it did nothing);
  `ADMIN_RECOVERY=setup-code` with a **new** code re-opens setup for a locked-out owner.

**Now.** `poc-06`: registration `409 account-exists`, no mail to the owner, the attacker's sign-in
`401 invalid-credentials`, setup without the code `403 setup-refused`. `poc-02` part 2: the same,
and the old recovery value prints "no longer exists and did nothing".

### F4 (Medium) — five wrong passwords locked anyone out

**Reproduced** with `poc-05` step 8: five wrong passwords from another address, then the owner with
the right password and code gets `429 account-locked` for 15 minutes, repeatable for ever.

**Root cause.** The brake was on the address, so the account's owner paid for a stranger's guesses.

**Fix** (`server/security/loginGuard.js`, `deviceProof.js`):

- A browser that has signed in to an account holds a **device proof**: a signed, httpOnly,
  per-account cookie (180 days). Its attempts are counted per device only; nothing an outsider does
  to the address touches it. It is issued on sign-in, on admin setup and when a password reset is
  completed — so the reset path always gets the real owner back in.
- Everyone else is throttled per connection: the bot check after 3 failures; from the 5th wrong
  password for one address an escalating wait (1, 2, 4, 8, then 15 minutes); 20 failures in 15
  minutes over all addresses stops that connection for the window.
- Per address, over all unknown devices: 3 failures in an hour turn the bot check on for every
  unknown device; 20 send the owner one notice email (at most one a day per account); 100 in an hour
  refuse unknown devices until the hour moves on (`account-busy`). Known devices are not refused.
- Two-step sign-in is unchanged as the real barrier for the admin; wrong codes have their own count
  (5 in 15 minutes for unknown devices, `two-factor-paused`).

**Guess rate against one account** (measured by the test, not estimated):

| Attacker | Guesses per hour |
|---|---|
| 1 address | 11 in the first hour, then 4 an hour (5 if it goes quiet for an hour and starts again) |
| 1,000 addresses (or any number) | 100 an hour, and the bot check on every one after the third |

At 100 an hour a password that passes the site's rules is not found by guessing, and the admin
account also needs the second step. The old design allowed 20 an hour and locked the owner out.

**Now.** `poc-05` step 8: the owner signs in (`200`) after the five wrong guesses; no lock mail.

### F5 (Low) — a part id was enough

**Reproduced** with `poc-04`: account B put A's part id in its own quote, read the geometry, file
name and preview, was handed A's edit key, and changed the part's units.

**Fix** (`server/security/partAccess.js`, column `parts.user_id`): a part belongs to the account
that uploaded it, or — uploaded without an account — to whoever holds the edit key the upload
answer gave that browser. The same check (`canUse`) is on every route that takes a part id: quote,
quote session, units, preview, download. Hand-over: when a visitor registers or signs in and carries
on, pricing claims the parts for the account, and so does checkout; after that the key alone does
nothing. Admin access is unchanged. A part the caller may not use answers exactly like a part that
does not exist (`part-not-found` / 404).

**Now.** `poc-04`: B quoting A's part `400 part-not-found`; no session, no key; units `404` with no
key and with A's own key; "B reads A's mesh: REFUSED".

### F7 (Info), F8 (Info)

- **F7.** Sign-in, registration and setup no longer put the session token in the JSON. An API
  client that wants it asks with the header `X-Session-Token: body` (or already uses a bearer
  token). The test helpers send that header; the browser app never does (tested both ways).
- **F8.** `POST /api/orders/checkout-session` has a per-account limiter (12 per 15 minutes,
  `CHECKOUT_PER_ACCOUNT_15MIN`, `429 checkout-rate-limited`), and an unchanged unpaid order reuses its
  open Stripe session instead of making another.

### F9 (Low) — redirect off the site

**Reproduced** with `poc-09`: `GET //evil.example/` → `301 Location: //evil.example`.

**Fix** (`server/seo.js`, confined to the path normaliser): leading runs of `/` and `\` are collapsed
to one slash before any `Location` is built; a path whose first segment starts with an encoded slash
or backslash (`%2f`, `%5c`) is answered 404; `isLocalPath` refuses to emit anything that does not
start with exactly one `/` followed by a character that is neither `/` nor `\`. Lookups into the
route tables use own properties only.

**Now.** `//evil.example/`, `/\evil.example/`, `///evil.example//` → `Location: /evil.example` (a page
on this site, which is then a 404). With a query string the same. The canonical-host redirect
(`www` → apex) builds an absolute URL on the known host.

### F-13, F-14, F-15 (admin catalog)

- **F-13.** Every admin save of a material refuses a blank, zero, negative or non-numeric price
  (`400 price-required`), on create, on edit and when switching a material on; the built-in price
  fallbacks are gone from all four pricing models, so a record that slips through is refused at
  pricing (`409 material-unavailable`, owner told) instead of sold at a guess.
- **F-14.** One multiplier per lead time. What is charged today is the rate card's value and that
  did not change (Expedited stays ×1.35). The Lead Times tab now reads and writes that same value
  (`syncLeadTimeMultipliers` on load, write-through on save), so the number shown is the number
  charged, and an edit there changes the next quote (`poc-08`: set to 2 → quotes at ×2).
- **F-15.** `admin_audit` table (append-only: no update or delete path), written on every material,
  finish, lead-time and rate-card save, on "end price hold", and on every order status change;
  shown in Admin → Change log. It records who, when, what and the before/after of changed fields.
  It holds no secrets and no customer-typed text.

`poc-08` (payments): 0 of 5 checks show the weakness.

## 4. Every route that can create an order or a Stripe session

| Route | What it makes | Goes through the choke point? |
|---|---|---|
| `POST /api/quote` | a saved quote (no order) | `saveQuote` → `priceQuote` (whitelist, floor, gate, fingerprint) |
| `POST /api/orders/checkout-session` | order + Stripe session | `verifyQuoteForOrder` → `repriceStoredQuote` → `priceQuote` on **every** call, including the resume of an unpaid order (`orders.js`, "PRICE INTEGRITY" block). Session from `checkoutGuard.sessionFor` at `expectedCharge(order)` |
| `POST /api/orders` (admin phone order) | order, no session | `verifyQuoteForOrder` (same function) |
| `POST /api/orders/:id/reorder` | a new quote only | `saveQuote` → `priceQuote` at today's rules; buying it is a normal checkout |
| `POST /api/orders/:id/confirm-payment` | nothing new; settles an existing order | compares Stripe's amount with the order (in `orderEvents.js`) |
| `POST /api/rfq/quote/:token/accept` | order (+ session for card) at the **owner's** amount | Not `priceQuote`, by design: a firm quote is the owner's price, honoured for its stated validity. The amount is validated when the owner saves it (`firmQuoteAmount`: a finite amount of money, not zero once the quote is out, a warning when under a quarter of the estimate). The route itself belongs to `order-lifecycle-fixes` |
| `POST /api/rfq/quote/:token/confirm-payment`, `POST /api/stripe/webhook` | nothing new | settle existing orders |

Proof that the instant-path routes cannot skip the check: `priceIntegrity.test.js` "a cheat quote
saved by the old code cannot be checked out, reopened into an order, or reordered" writes cheat
rows straight into the database (as the old code would have saved them) and tries each route;
`server/routes/authorization.test.js` keeps the inventory of routes and fails if one is added
without an entry.

## 5. New refusal codes

Stable, machine-readable, each with a plain message. `field` names the selector the page resets.

| Code | HTTP | Meaning |
|---|---|---|
| `process-not-offered` | 400 | not a process the site sells (`field: process`) |
| `material-not-offered` | 400 | unknown or unlisted material (`material`) |
| `material-process-mismatch` | 400 | material belongs to another process (`material`) |
| `grade-not-offered` | 400 | not one of the material's grades (`grade`) |
| `sub-process-not-offered` | 400 | option does not go with the material (`subProcess`) |
| `thickness-required` / `thickness-not-offered` | 400 | sheet stock needs a thickness from the list (`thickness`) |
| `finish-not-offered` / `finish-not-for-material` | 400 | finish not listed for the process / not for this material (`finish`) |
| `layer-height-not-offered` | 400 | (`layerHeight`) |
| `infill-out-of-range` | 400 | 5–100 % (`infill`) |
| `quantity-invalid` | 400 | whole pieces, 1 to 1,000,000 (`quantity`) |
| `lead-time-not-offered` | 400 | (`leadTime`) |
| `config-invalid` | 400 | malformed request; nothing for the buyer to fix |
| `part-not-found` | 400 | no such part, or not the caller's |
| `material-unavailable` | 409 | the catalog record cannot be priced; owner told |
| `pricing-unavailable` | 409 / 503 | the rate card is incomplete; owner told |
| `price-check-failed` | 422 (quote) / 409 (checkout) | the floor refused the price; owner told; firm quote offered |
| `quote-changed` | 409 | price differs from what was saved; carries `previousTotal`, `newTotal`, `quote`, `reopen` |
| `quote-needs-update` | 409 | something on the quote is no longer offered; reopen it |
| `quote-already-ordered` | 409 | one quote, one order; carries the buyer's `orderId` |
| `checkout-rate-limited` | 429 | per-account checkout limiter |
| `price-required` | 400 | admin: a material needs a price above zero |
| `quoted-total-invalid` | 400 | admin: a firm-quote total must be an amount of money |
| `setup-refused` | 403 | admin setup: any refusal that is not about the new password |
| `try-later` | 429 | sign-in: this connection waits (`retryAfterSeconds`) |
| `account-busy` | 429 | sign-in: too many attempts on this address from unknown devices this hour |
| `two-factor-paused` | 429 | too many wrong codes |

Gate reasons added (inside `gate.reasons[].code` and the `rfq-required` answer):
`order-quantity`, `big-ticket-order`, `stock-thinner-than-model`. Removed: `account-locked`.

## 6. First admin account — the owner's steps

Also in `docs/security/hardening-2026-11-11-accounts.md` ("First admin account").

1. In Railway → Variables, set `ADMIN_EMAIL` to the address you will sign in with.
2. Invent a setup code: 20 characters or more, not a word or a repeated letter. Nobody gives it to
   you and the site never shows it. Add it as `ADMIN_SETUP_CODE`. Railway redeploys.
3. In the deploy log, find "there is no admin account yet. The one-time admin setup is OPEN at /admin/setup".
4. Open `https://straightedgemfg.com/admin/setup`. Enter the code and choose your password.
5. You are taken straight to two-step sign-in setup. Scan the code with your authenticator app and
   save the recovery codes.
6. Delete `ADMIN_SETUP_CODE` in Railway. The code has already stopped working; the log reminds you
   until the variable is gone.

Locked out later with no working mailbox: set `ADMIN_RECOVERY=setup-code` and a **new**
`ADMIN_SETUP_CODE`, redeploy, use `/admin/setup` again, remove both. Lost the phone and the recovery
codes only: `ADMIN_RECOVERY=reset-2fa`. If you already have an admin account, do nothing.

## 7. Found along the way (not in either report)

| # | Severity | What | Status |
|---|---|---|---|
| N1 | Medium | A 3D model routed from sheet stock **thinner than the model** was priced at the thinner stock and could be bought | Fixed: gate reason `stock-thinner-than-model`; the floor refuses the extreme cases; tested |
| N2 | Medium | The admin phone-order route trusted the stored quote like checkout did and defaulted an unknown process to sheet metal | Fixed: same `verifyQuoteForOrder` |
| N3 | Medium | An unpaid order was resumed for the life of the quote with no re-check, so a started checkout kept an old price after a rise, a retired material or a tightened gate | Fixed: resume is re-checked; "end price hold" covers it |
| N4 | Low | Routing was priced at a guessed default thickness when none was sent (the page always sends one) | Fixed: `thickness-required` |
| N5 | Low | Checkout fell back to `subtotal` when a quote had no `orderTotal` | Fixed: no fallback |
| N6 | Low | Unknown grade, sub-process or finish silently became the first listed one; DFM for a print ran as FDM when the sub-process was left out | Fixed by the whitelist |
| N7 | Info | Stored geometry carried parser stage timings, so two uploads of one file never hashed the same | Excluded from the fingerprint |
| N8 | Info | `poc-08` (review) declared a 5-byte body and sent 4, so the server waited and the script timed out — on the old tree too | Script corrected |

## 8. What remains open

- **Owned by `order-lifecycle-fixes`:** F-06 (webhook amount absent/0, currency, session id), F-07
  (refunds, disputes), F-08's session expiry (two payable pages if the first was opened before a
  change; a cancelled order's page), F-09 (a firm-quote total changed without re-sending stays live
  at the new amount), F-10 (line break in the PO number), F-11 (two accepts at once), F-17
  (promotion codes), F-18 (`STRIPE_WEBHOOK_SECRET` required at startup). `expectedCharge(order)` is
  exported for them and not yet called from `orderEvents.js`.
- **Owned by `journey-qa`:** F-16, printing thickness, grade, units and dimensions on the traveler
  from `item.config.priced`.
- **F6** (abuse with no Turnstile keys) and the abuse table: another reviewer's item.
- **Tax and shipping** are being added to the Stripe session on another branch. When they land,
  `expectedCharge` is the one place to add them, and `checkoutGuard.sessionFor` compares against it.
- **Counters are in memory.** Sign-in, setup and checkout limits reset on a restart. One process
  serves the site, so this is a known, small window; it is stated in `loginGuard.js`.
- **Geometry fallback.** `resolveFeatures` still estimates volume as half the bounding box for a
  mesh with no usable volume. It is in the geometry module (another engineer's), the gate already
  sends non-manifold parts to a person, and the floor uses the smaller of the two volumes.
- **The floor is a backstop, not a margin rule.** It stops a price under the material; it does not
  stop an owner setting labour rates at their legal minimum. The pricing console's preview is still
  the guard for that.
- **A Stripe page already open** when the owner ends price holds stays payable until Stripe expires
  it (session expiry is in the lifecycle branch's list above).

## 9. Existing tests that were changed, and why

No existing assertion was weakened. Changes are fixtures following the new rules, each with a note in the file:

- `registry.test.js`: "unknown process falls back to sheet metal" now asserts that it throws.
- `checkoutFunnel.test.js`, `paperwork.test.js`, `authorization.test.js`, `botCheck.test.js`,
  `partPayloads.test.js`, `access.test.js`, `fileEncryption.test.js`: parts are quoted by the
  identity that uploaded them (or with their edit key); the old "another caller prices it" cases now
  assert the refusal. `authorization.test.js` gained inventory entries for the three new routes.
- `accountSecurity.test.js`, `security.test.js`: the admin is made through the setup route; the
  lockout assertions are replaced by the new brake's (the old pause is asserted gone).
- `crossBranch.test.js`: four rate limiters on the shared client key in `auth.js` (setup is the fourth).
- `dataLayer.test.js`: knows the new migration and table.
- Helpers `testSupport/harness.js` and `liveServer.js`: send `X-Session-Token: body` (they are API
  clients), attach edit keys as the quote page does, and make the admin through setup with a random code.

## 10. Verification

All on the final tree of this branch, against local servers only.

| Check | Result |
|---|---|
| `npm test` | 48/48 suites passed (41 before; 7 new: `priceIntegrity`, `adminSetup`, `adminExisting`, `signInThrottle`, `partOwnership`, `adminCatalog`, `seoRedirect`), 683 individual checks |
| `NODE_ENV=production npm run build` | 22/22 routes rendered, 22 JSON-LD blocks valid |
| `node scripts/claims-check.js` | exit 0 |
| `tools/vet-quotes/run_vetting.js`, production-mode server, before and after | 300 quotes, 0 fails, 63 warnings both times; 0 of 300 rows differ outside the quote-id column |
| `scripts/e2e/hardening-accounts.mjs` (Chromium) | 121/121 checks, run twice. New sections: I (setup on a squatted database), J (a legitimate checkout paid in CNC machining, routing from a 3D model, routing from a DXF, FDM and SLA; an unoffered process refused), K (stale quote: the checkout page shows the new price, charges nothing, then charges the confirmed price). Setup on a fresh database is section F |
| `tools/security/csp-browser-check.js` (Chromium) | 67 steps, 67 clean, 0 CSP violations, 0 page errors; the admin is made on the setup screen and the Change log tab is walked |
| `tools/security/review/poc-01…09` | all nine run to the end; none exploits (answers in section 3) |
| `tools/security/review-payments/poc-01…12` | all twelve run to the end. 0 checks flagged in 01, 02, 03, 04, 05, 08, 10, 11, 12. Still flagged, all owned by other branches: 06 (F-06a, F-06b, F-06c, F-07, F-08), 07 (F-09, F-10, F-11), 09 (F-16 twice, F-17) |
| Existing admin on a database made by `origin/master` (`255753c`) | role, password hash and sign-in unchanged; forced two-step enrolment as before; setup refuses the right code. Also `adminExisting.test.js` |
| Old-code check of the new tests | `priceIntegrity.test.js` on the pre-fix tree: 17 of its then 18 tests fail |

**Not verified, and why.**

- Nothing was run against the live site, real Stripe, Cloudflare Turnstile or the real mailer; all four are stubbed locally, as in the reviews.
- The browser suites ran in Chromium only.
- The guess-rate figures are measured against the in-process throttle with simulated source addresses, not over a network.
- The proof on a master-created database used the repository's own installed dependencies for the old code (it needs one package this branch no longer uses).
- The scripts under `tools/security/review*/` were adjusted so they run to the end and print the server's answer where they used to read a price or a session that no longer exists; no attack request was changed. Three were corrected where the script, not the server, was at fault: a declared body length one byte too long (`review/poc-08`), quoting as a guest after checking out as a signed-in buyer (payments 04, 05, 08, 12), and counting any order from a firm-quote link as the $0.00 order (payments 07).

One leftover for the designer: the "sign-in paused on your account" email template is no longer sent by anything and can be removed with its sample.

## 11. How to re-run

```
npm test
NODE_ENV=production npm run build
node scripts/claims-check.js
for f in tools/security/review/poc-0*.js; do env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1 node "$f"; done
sh tools/security/review-payments/run-all.sh
NODE_PATH=/opt/npm-tools/node_modules node scripts/e2e/hardening-accounts.mjs --scratch <dir>
NODE_PATH=/opt/npm-tools/node_modules node tools/security/csp-browser-check.js --scratch <dir>
```
