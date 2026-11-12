# Relaunch integration: four branches into one (2026-11-12)

Branch `relaunch-2026-11-12`, cut from `hardening-2026-11-11` (e4881d3). It merges, in this order,
`review-fixes` (8bd8776), `order-lifecycle-fixes` (5f69cc3), `journey-qa` (e8cae2d) and
`deploy-runbook` (a793582), then the report and scripts of `security-review-uploads-2026-11-11`.
Nothing was pushed. No other branch or worktree was touched.

Three more branches are still in progress (`availability-fixes`, `tax-shipping`, `geometry-speed`).
A second pass merges them. Section 8 says where each one joins.

## 1. Bottom line

- The four branches are one tree. Every order and every Stripe session passes the price check and
  is opened in one place (section 4). There is one admin change log (section 3).
- Both reviewers' attack scripts were run again on the final tree. None of the 21 scripts exploits
  anything (section 6). The two findings that were open between branches, F-16 and F-17, are closed.
- **The site is not ready to launch from this branch alone.** The uploads review's launch blockers
  are still here, as expected: they belong to `availability-fixes`. All twelve findings were
  re-run and all twelve reproduce (section 7). The one that touches money is **H1**: a model with
  an `Infinity` coordinate is priced at $352.04 instead of $3,727.15 and checkout opens for it.
- One thing the owner should know before the first deploy on the live database: the default
  catalogue is versioned, and this code replaces the materials, finishes and processes tables with
  the new defaults on its first start (section 6, upgrade proof). Any material price edited in the
  admin pages on the live site is overwritten. This predates the four branches; no report
  mentioned it.
- A fresh clone of the final code is green on Node 20.20.0, 69 of 69 suites (production is the Dockerfile's
  Node 20.20.2). Node 22.23.4 was run too. Numbers are in section 6.8.

## 2. The merges

### 2.1 `review-fixes`

Clean merge: no conflicts (it was cut from this base with both reviewers' branches merged in).

After it, two suites failed in a fresh checkout, on the base as well:

| Suite | Cause | Change |
|---|---|---|
| `server/routes/botCheck.test.js` | read `data/rfq-drawings` before anything had created it | a folder that is not there reads as empty; no assertion changed |
| `server/security/headers.test.js` | needs `client/dist` | `scripts/run-tests.js` builds the client once when `client/dist/index.html` is missing (`RUN_TESTS_NO_BUILD=1` turns that off); no assertion skipped |

### 2.2 `order-lifecycle-fixes`

Ten files conflicted.

| File | Resolution | Why |
|---|---|---|
| `server/routes/orders.js` | `POST /checkout-session` keeps review-fixes' price-integrity block (`verifyQuoteForOrder` on a first checkout and on every resume) and its per-account limiter, and gets its Stripe session only through `orderEvents.createCheckoutSession` → `orderLifecycle.checkoutSession` → `openSession`. Guard order: sign-in, confirmed email, limiter, single-line ship-to fields, handler | Both properties are needed and neither replaces the other. The lifecycle branch validated the fields before sign-in; they now run after it, so an anonymous caller learns nothing about field rules |
| `server/services/checkoutGuard.js` | `sessionFor` calls through to `createCheckoutSession` | review-fixes had its own "reuse an open session" rule; `openSession` has the complete one (reuse, replace, already paid). One rule |
| `server/services/orderState.js`, `orders.js`, `orderLifecycle.js` | new `holdsQuote(order)`: every order holds its quote except one that lapsed unpaid (`expired`, or `cancelled` with `expiredAt`). Used by the one-quote-one-order check and by `releaseSource` | The branches disagreed: review-fixes freed the quote of any cancelled order; lifecycle releases only on expiry. The stricter reading won. It does not break a buyer flow: only the shop cancels an order. If the order had been paid, the buyer has Reorder; if it never was, the order page tells the buyer to call, and a new quote can be started from the files |
| `server/models/*Migration.js`, `services/audit.js`, `services/adminAudit.js` (deleted), `lifecycleStore.js` | one `admin_audit` table and one module (section 3) | Both branches added an `admin_audit` table, with different columns, and a module each to write it (review-fixes' `adminAudit.js`, lifecycle's `audit.js`) |
| `server/routes/rfq.js` | the admin save answers both `priceWarning` (review-fixes) and `linkInvalidated` / `needsResend` (lifecycle). A total of 0 on a quote that is out with the customer is refused at the save (`quoted-total-invalid`); the accept path's own refusal (`quote-not-payable`) stays. The PO number goes through lifecycle's `checkPoNumber` | Stricter of the two at each point |
| `server/models/database.js`, `SqliteDB.js`, `server/index.js`, `client/src/pages/AdminPanel.jsx`, `server/testSupport/harness.js`, `liveServer.js` | both sides kept | Additions that did not overlap in meaning |

Tests changed, and why:

| Test | Change | Why |
|---|---|---|
| `checkoutFunnel.test.js` | none in effect | both branches had made the same assertion |
| `adminCatalog.test.js` | marking an order paid by hand now sends a reason; asserts the unified action names (`order.mark-paid`, `order.status`), the `note` field and the one `services/audit` module | lifecycle requires the reason; the row shape is the unified one |
| `orderLifecycle.test.js` | the per-account checkout limiter is raised for this suite (`CHECKOUT_PER_ACCOUNT_15MIN=1000`); parts are quoted by the identity that uploaded them; the audit row is read in the unified shape; the zero-total case is split in two | the suite makes more than 12 checkouts on one account; part ownership; see below |
| the zero-total case | was: "owner saves 0, buyer's accept is refused". Now: (1) the save itself is refused with `quoted-total-invalid`; (2) a row forced to 0 the way old code could have written it is still refused at accept | the two branches' tests contradicted. Both refusals are intended (review-fixes at the save, lifecycle at accept), so both are asserted |
| `tools/security/review-payments/poc-07` | finding F-09b is counted as a weakness only if a $0.00 order is made | the script counted "the save was accepted"; the save is now refused |
| `tools/security/review-payments/poc-10` | the cancelled-order check prices its part as the buyer who owns it | script fault after part ownership: a guest could no longer price that part, and the script read the refusal as a finding. No attack request changed |

New: `server/routes/relaunchIntegration.test.js`, 8 cases (section 4).

### 2.3 `journey-qa`

Five files conflicted.

| File | Resolution | Why |
|---|---|---|
| `client/src/pages/CheckoutPage.jsx` | review-fixes' behaviour (a changed price is shown and confirmed with the same button; refusals settled elsewhere send the buyer there) with journey's form and the catalogue's words. The page holds no sentences of its own for `quote-changed`, `quote-needs-update`, `rfq-required`, `price-check-failed`, `quote-already-ordered` | One place for wording |
| `client/src/pages/QuoteBuilder.jsx` | review-fixes' reset logic; its `console.error` dropped; gate reasons come from the catalogue | journey's rule: no console errors on a buyer's page |
| `client/src/components/OrderDetailDrawer.jsx` | both sides kept: journey's order line (`specFor`) and lifecycle's payment panel (`OrderPaymentPanel`) | Additions to different parts of the drawer |
| `server/services/documents.js`, `pdfGenerator.js` | one "one printed line" rule: journey's `oneLine` runs lifecycle's `printable` first. Journey's traveler layout and labels | Two sanitisers for the same job |

Work the merge called for:

- **Traveler and admin order line read the priced snapshot.** `documents.specOf` (server) and
  `orderLineCore.specFor` (client) read `config.priced` first: process, sub-process, material,
  grade, stock thickness, size, drawing units, finish, layer height, infill, quantity. An order
  made before the snapshot existed falls back to what its line stored, and prints
  "NOT RECORDED — confirm with customer" for anything missing. A part file that no longer matches
  what was priced is called out on the traveler ("PART FILE CHANGED SINCE IT WAS PRICED"). This
  closes F-16.
- **Message catalogue covers every server code** (section 5), with a test that fails when the
  server can send a code the catalogue does not word.
- **Order states come from the catalogue** on the order page, the firm-quote page and the return
  page. "We'll email you today" and "5 to 10 business days" are gone: `shared/shop-facts.json`
  confirms neither. Only `quote-turnaround` (24 hours) is a confirmed time.
- **The "sign-in paused" email is removed**: template, sample, renderings, assertions. Nothing
  has sent it since review-fixes replaced the 15-minute lock. The notice that replaced it
  (`signInAttempts`) is held to the same email rules, and its rendering is in
  `docs/screenshots/journey-qa-2026-11-11/emails/`.
- **Codes for states that had none**: `payments-unavailable` (checkout 503), `confirm-failed`
  (both confirm-payment 502s), `order-not-found` (order 404s).

Tests changed, and why:

| Test | Change | Why |
|---|---|---|
| `orderLifecycle.test.js` (F-10) | the PO line on the traveler is asserted as `Customer PO (as typed): …` | the traveler layout is journey's |
| `security.test.js` | the paused-email entry is replaced by the equivalent for `signInAttempts` | the email no longer exists |
| `messageCatalogue.test.js` | `account-locked` → `try-later`; new cases for the added codes; the "no promise" pattern no longer trips on "today's price" | the lock is gone; "today" as a promise is what the rule is about |
| `geometry/dxf/dxf.test.js` | the time bound is CPU time (under 1500 ms) plus a loose wall-clock ceiling (15 s) | section 6.5 |

### 2.4 `deploy-runbook`

One file conflicted (`AdminPanel.jsx`: both new tabs kept, Change log and System).

- **The two redirect layers compose.** `server/ops/redirectsCompose.test.js` follows every hop a
  browser would take for 20 hostile paths × 3 query strings on six hosts (canonical, www, both
  old-domain names, Railway's own host, a bare address): 360 walks. Every chain stays on the site
  and ends within three hops. One change came out of it: a backslash in the path of a
  canonical-host redirect is sent as `%5C`. The old form was not exploitable (the Location was
  absolute, with our host), but no Location from either layer carries a raw backslash now.
- **`server/ops` reads the real order state machine.** Known states are `orderState.STATES`;
  "needs a look" is the order's `attention` flag with its admin label, not a guessed status name;
  partly refunded orders and open disputes are counted. The digest and Admin → System use the
  state machine's names. Sign-in counters follow the new throttle codes. Admin → System gains
  "Card payments" and "setup code removed".
- **Runbook, checklist, deploy notes and `.env.example` match the merged code**:
  `ADMIN_SETUP_CODE` and the first-admin and recovery steps (`ADMIN_RECOVERY=verify-email` no
  longer exists), `STRIPE_WEBHOOK_SECRET` required, `STRIPE_PROMOTION_CODES`,
  `CHECKOUT_SESSION_MINUTES`, `CHECKOUT_PER_ACCOUNT_15MIN`, the six webhook event types, the
  first-start "Order sweep:" log line, "End price hold on open quotes", the sign-in messages.
  `MEMORY_BUDGET_MB` and the status-page getters stay marked "confirm when availability-fixes
  merges".

Tests changed: `ops/ownerNotifications.test.js` used a customer name with a line break and a PO
number with markup. Both are now refused at the door (400 `field-single-line`,
`po-number-invalid`). The test asserts the refusals, then sends the nearest text that is accepted.
`ops.test.js` follows the state-machine labels.

### 2.5 `security-review-uploads-2026-11-11`

Report and scripts only (`docs/security/independent-review-uploads-2026-11-11.md`,
`tools/security/review-uploads/`). No conflict, no application code. Section 7 has the results.

## 3. One admin change log

One table, `admin_audit`, made by `server/models/auditMigration.js`:

| Column | Holds |
|---|---|
| `id`, `created_at`, `updated_at` | |
| `user_id`, `user_email` | who |
| `area` | `material`, `finish`, `lead-time`, `pricing`, `quote`, `account`, `order`, … |
| `action` | `update`, `create`, `delete`, `duplicate`, `save`, `restore`, `reset`, `void-open`, `takeover`, `recovery`, `order.status`, `order.mark-paid`, `order.cancel`, `order.tracking`, `order.attention-resolved` |
| `target` | what a person would call it (a material's name; an order's 8-character reference) |
| `entity_id` | the row's id |
| `changes_json` | `{ field: [before, after] }` |
| `note` | the reason the owner typed |

The migration is additive on a table made by either branch alone (tested both ways in
`relaunchIntegration.test.js`). It runs after `integrityMigration` and `orderLifecycleMigration`,
neither of which creates the table any more.

One module, `server/services/audit.js`:

- `record({ actor, area | entity, action, target, entityId, changes | before/after, note })`.
  Returns null without an action; an `update` with no changes writes nothing; never throws.
- `diff(before, after, fields)` and `list({ area | entity, entityId, limit })`.

Every call site of both branches writes through it: the catalogue and pricing routes, the
admin-account takeover and recovery, `orderLifecycle.manualMove` and `resolveAttention`.
`GET /api/admin/audit` returns `{ id, createdAt, userEmail, area, action, target, changes, note }`;
the Change log tab shows the lifecycle actions by name and "Reason: …".

Choices made here: action names are lifecycle's dotted ones; change pairs are review-fixes'
`[before, after]`; review-fixes' tracking and carrier facts are kept (a save that only changes
them records `order.tracking`).

## 4. Every route that makes an order or a payment session

`stripe.checkout.sessions.create` appears once in the server: `orderLifecycle.openSession`
(`server/services/orderLifecycle.js:265`). `ordersDB.insert` appears three times: `orders.js:233`,
`orders.js:378`, `rfq.js:677`. `relaunchIntegration.test.js` fails if either count changes or if an
insert is not preceded by its check.

| Route | Who | Makes | Price check before it | Session |
|---|---|---|---|---|
| `POST /api/quote` (`api.js` `saveQuote`) | anyone, rate-limited; a part is priced only for whoever uploaded it | a saved quote; no order | `priceQuote`: `resolveLine` whitelist → engine → `assertSane` floor → gate and fingerprint | none |
| `POST /api/orders/checkout-session` (`orders.js:97`) | signed-in buyer, confirmed email, per-account limiter | first call: the order (`orders.js:233`) and a session. Again for the same quote: the same order and its session | `verifyQuoteForOrder` (`orders.js:185`) → `repriceStoredQuote` → `priceQuote` → `judgeCheckout`, on the first call and on every resume | `createCheckoutSession` (`orders.js:304`) → `checkoutSession` → `openSession` |
| `POST /api/orders` (`orders.js:331`) | admin with two-step sign-in (order taken by phone) | an order, no session | `verifyQuoteForOrder` (`orders.js:370`) | none. Marked paid by hand through `manualMove`, which needs a reason and writes the change log |
| `POST /api/orders/:id/reorder` | the order's buyer | a new saved quote; no order | `saveQuote` → `priceQuote` | none |
| `POST /api/rfq/quote/:token/accept`, card (`rfq.js:616`) | holder of the emailed link | the order (`rfq.js:677`) and a session (`rfq.js:719`). The same choice again: the same order, session through `rfq.js:632` | Not engine-priced: the amount is the owner's quoted total. Guards, in order: the link is bound to the terms and amount that were sent (`quote-changed` if edited and not sent again); the total is a positive amount of money (`quote-not-payable`; refused earlier at the owner's save as `quoted-total-invalid`); the total the buyer saw equals the total | `createCheckoutSession` → `checkoutSession` → `openSession` |
| the same, purchase order | holder of the link | an order awaiting the PO; no session | the same guards; the PO number is one printable line | none |
| `POST /api/orders/:id/confirm-payment`, `POST /api/rfq/quote/:token/confirm-payment`, `POST /api/rfq/return/confirm`, the Stripe webhook | buyer / link holder / Stripe | nothing new | the amount Stripe reports is checked against `expectedCharge(order)` in `checkSession` | read only |

The amount is defined once: `expectedCharge(order)` → `{ cents, dollars, components }`
(`server/services/expectedCharge.js`). The session's line items and the settlement check both use it.

The firm-quote row is stated exactly because the brief asked for "the pricing choke point" on
every route. A firm quote has no engine price to re-run; its choke point is the set of guards
above. The session side is the same `openSession` as everything else.

One quote makes one order: a second checkout of a quote whose order still holds it answers
409 `quote-already-ordered` with the order's id (tested across paid, refunded, cancelled and
lapsed orders, and with two checkouts at once). The admin phone-order route does not apply this
rule (section 9, item 12).

## 5. Message catalogue

`client/src/utils/messageCatalogue.js` went from 74 worded codes to 100: 27 added, `account-locked`
removed, two reworded, and `quote-changed` given a checkout wording of its own.
`messageCatalogue.test.js` reads the server's source, finds 116 codes, and fails unless each is
worded or is named in a list of 23 that a buyer never reads.

### 5.1 Added at the merge

| Code | Where | What the buyer reads |
|---|---|---|
| `try-later` | sign-in | Sign-in from this connection is paused for *N* minutes, because the wrong password was entered several times in a row. The pause is there to stop anyone guessing their way in, and nobody got in. Choose a new password to sign in now, or wait and try again. |
| `account-busy` | sign-in | There have been a lot of wrong passwords for this address, so for now we only sign it in from a browser it has used before. Nobody got in. Sign in from a browser you have used before, or choose a new password to sign in from this one. Stuck? Call 224-213-6727. |
| `two-factor-paused` | sign-in | Too many wrong codes were entered, so codes are paused for *N* minutes. Nobody got in. Wait, then enter the code your authenticator app shows at that moment. |
| `setup-refused` | admin setup | That didn't work. Check the setup code and try again. If the admin account has already been set up, sign in instead. |
| `process-not-offered` | quote | That way of making the part isn't one we sell online, so it wasn't priced. Choose one of the processes on this page, or ask for a firm quote and a person prices it. |
| `material-not-offered` | quote | That material isn't on our list any more, so it wasn't priced. Pick another material and the price updates, or ask for a firm quote if it has to be that one. |
| `material-process-mismatch` | quote | That material doesn't go with the process chosen for this part, so it wasn't priced. Pick a material from the list for this process, or change the process. |
| `grade-not-offered` | quote | That grade isn't one we offer in this material. Pick a grade from the list and the price updates. |
| `sub-process-not-offered` | quote | That option doesn't go with the material chosen, so it wasn't priced. Pick the material again and choose from the options shown, or ask for a firm quote and a person prices it. |
| `thickness-required` | quote | Choose a stock thickness for this part. We cut it from sheet, and the price depends on which sheet. |
| `thickness-not-offered` | quote | We don't stock that thickness in this material. Pick one from the list, or ask for a firm quote if you need a thickness that isn't there. |
| `finish-not-offered` | quote | That finish isn't offered for this process. Pick a finish from the list and the price updates. |
| `finish-not-for-material` | quote | That finish isn't done on this material. Pick one of the finishes listed for it and the price updates. |
| `layer-height-not-offered` | quote | We don't print this material at that layer height. Pick one from the list and the price updates. |
| `infill-out-of-range` | quote | Infill has to be between 5 and 100 percent. Change it and the price updates. |
| `quantity-invalid` | quote | The quantity has to be a whole number of pieces, 1 or more. Correct it and the price updates. |
| `lead-time-not-offered` | quote | That lead time isn't offered right now. Choose one of the lead times shown, and the price and the ship date update. |
| `part-not-found` | quote | We couldn't find that part on this quote. It may have been uploaded in another browser, or under another account. Upload the file again and it is priced as before, or call 224-213-6727 or email quotes@straightedgemfg.com. |
| `material-unavailable` | quote | We can't price that material online right now. That is a fault on our side. Pick another material, or ask for a firm quote and a person prices this one. Questions: 224-213-6727. |
| `pricing-unavailable` | quote | We can't price this online right now. That is a fault on our side, and nothing was charged. Try again in a few minutes, or ask for a firm quote and a person prices it. Questions: 224-213-6727. |
| `price-check-failed` | quote | We couldn't confirm this price automatically, so we haven't shown it. Nothing is wrong with your file. Ask for a firm quote and a person prices it, or call 224-213-6727. |
| `price-check-failed` | checkout | We couldn't confirm the price of this order automatically, so we have not charged you. Ask for a firm quote and a person prices it, or call 224-213-6727. |
| `quote-changed` | checkout | The price of this quote has changed since it was last priced, so we have not charged you. Reopen the quote to check it and carry on at today's price; your parts are still there. Questions: 224-213-6727. (When the server sends both prices: "It was $X and is now $Y.") |
| `quote-needs-update` | checkout | Something on this quote is no longer offered the way it was priced, so we have not charged you. Reopen the quote to see today's options and price; your parts are still there. |
| `quote-already-ordered` | checkout | This quote has already been ordered, so it can't be paid for a second time. Nothing was charged. Open that order to see where it stands; to order the same parts again, use Reorder on the order page. Questions: 224-213-6727. |
| `checkout-rate-limited` | checkout | That is a lot of tries at checkout in a few minutes, so checkout on this account is paused for a short while. Nothing was charged. Wait a few minutes and try again, or call 224-213-6727 and we'll take the order by phone. |
| `reorder-not-available` | order page | This order hasn't been paid for yet, so there is nothing to reorder and nothing was changed. Go back to checkout to pay for it. Questions: 224-213-6727. For an order that closed unpaid: This order was never paid for, so there is nothing to reorder and nothing was changed. Start a new quote with the same files, or call 224-213-6727 or email quotes@straightedgemfg.com. |
| `price-required` | admin | A material needs a price above zero before it can be saved or switched on. Enter the price and save again. |
| `quoted-total-invalid` | admin | The quoted total has to be an amount of money. A quote that is out with the customer can't be saved at nothing: enter the amount it should be, or withdraw the quote. |

Reworded:

| Code | Where | What the buyer reads now |
|---|---|---|
| `quote-changed` | firm quote, link replaced | This quote was changed after this link was sent, so this link no longer opens it. Nothing was accepted and nothing was charged. Use the link in our newest email about this quote, or call 224-213-6727 or email quotes@straightedgemfg.com. |
| `quote-changed` | firm quote, stale page | This quote has changed since this page was opened, so nothing was accepted and nothing was charged. Reload this page to see the quote as it is now, and accept again if it is right. Questions: 224-213-6727. |
| `config-invalid` | quote | We couldn't price this as it was sent. That is most likely a page that is out of date: reload the page and try again. If it keeps happening, ask for a firm quote and a person prices it, or call 224-213-6727. |

Gate reasons (why a quote goes to a person), three added:

| Reason | What the buyer reads |
|---|---|
| `order-quantity` | The pieces on this order add up to more than the instant order takes in one go. A run this size is priced by a person: ask for a firm quote. |
| `big-ticket-order` | The total of this order is over the amount we take online without a person confirming the price first. Ask for a firm quote and we confirm it before you pay. |
| `stock-thinner-than-model` | The stock thickness chosen is thinner than the model, so the part can't be cut from it as drawn. Pick a thicker stock, or ask for a firm quote and a person confirms the stock with you. |

Order states: `awaiting-po` added; `expired` takes a firm-quote variant. The full list is
payment under review, expired, awaiting PO, refunded, partially refunded, disputed, cancelled.

The whole table prints with `node scripts/qa/message-catalogue.mjs`.
`docs/qa/journey-qa-2026-11-11.md` is the journey branch's report as written; its table still
lists `account-locked`. It was left as the record of that pass.

### 5.2 States that still have no usable code

Numbered as in the journey report, section 6. Closed at the merge: item 13 (firm-quote accept
and pay refusals) outright, and parts of items 1, 3, 10, 15 and 16: the sign-in pauses have their
own codes and `retryAfterSeconds`; checkout has `checkout-rate-limited`, `payments-unavailable`
on its 503 and the four price-check refusals; confirm-payment's 502 is `confirm-failed`; an order
404 is `order-not-found`; the pricing configuration refusals each have a code and a `field`.
What is left of each item:

| # | State | What the page does today |
|---|---|---|
| 1 | One `rate-limited` code for many different limits | words it generally; cannot say which limit or how long |
| 2 | Three limiters in `server/index.js` answer with no code | plain sentence for a 429 |
| 3 | Sign-in and registration validation sentences (the request-form and firm-quote field refusals now carry `field`) | server's sentence shown when it reads as a buyer's sentence |
| 4 | `weak-password`: which rule failed | one sentence listing all the rules |
| 5 | Reset link: `{ valid: false }` with no reason | "used, replaced or run out" |
| 6 | Upload refusals | worded from the status and the server's sentence |
| 7 | A truncated STL answers `content-mismatch` | reads as "wrong type" |
| 8 | Numbers a buyer needs are inside sentences (size limits, counts) | pulled out of the sentence by pattern |
| 9 | `busy` in a 200 with no `retryAfter` | "try again shortly" |
| 10 | Checkout 500, 404, 403, 400 without a code | plain sentence for the status |
| 11 | Quote drawing refusals | server's sentence |
| 12 | Request-form attachment refusals | server's sentence |
| 14 | DXF units 410 / 400 | server's sentence |
| 15 | Pricing: "No parts configured", 404, 500 | plain sentence |
| 16 | Reorder 500 | plain sentence |
| 17 | Honeypot | answers as success, by design |

Owner for all of these: the security engineers (they are server answers). `availability-fixes`
is expected to add `quote-too-large` and `part-reupload-required`; the test in 5 will fail until
they are worded, which is the point of it.

## 6. Cross-cutting fixes and verification

### 6.1 The shop's street address is not in the client build

- The sample documents moved from `client/public/brand/documents/` to `docs/brand/samples/`; the
  kit sheet that showed them moved to `docs/brand/`. `scripts/preview-documents.js` refuses to
  write under `client/public` or `client/dist`.
- `scripts/dist-address-check.js` reads every file under `client/dist`, text or binary: raw bytes
  (UTF-8, UTF-16 both byte orders, any letter case, with anything between the words), decoded
  text (HTML entities, percent and unicode escapes), and PDFs both as raw bytes and after their
  streams are inflated and their drawn text extracted. It never prints the address.
- `node scripts/claims-check.js` runs it over the whole of `client/dist` and exits 1 on a finding.
  Result on the final build: 256 files, 21.3 MB, 1 PDF; the address is in none of them.
- Test: `server/security/distAddress.test.js`, 6 cases (planted in text, in a binary, in a PDF
  stream, in UTF-16; the real build; the repository's `client/public`).

Still true, and for the owner (section 10): six of the seven sample PDFs under
`docs/brand/samples/` print the address (the traveler does not), and the PNG picture of each
page shows the same thing. They are in the repository, as they were before, and are not
published. A scan of the repository finds the address only there and in
`server/config/shipFrom.json`.

### 6.2 A fresh clone is green

No suite depends on a `data/` folder or a built client being there already (2.1).

The fresh-clone run found one more dependency, on where the checkout sits.
`server/ops/entrypoint.test.js` runs `docker-entrypoint.sh` as an unprivileged user; in a clone
under a folder only its owner can enter, that user could not read the script, and one case failed
with the shell's exit 2 instead of the script's exit 1. The cases now run a byte-for-byte copy
from the world-readable temporary folder the test volumes already use, and the first case asserts
the copy equals the repository's script. No assertion changed.

### 6.3 Home page numerals

`LandingPage.jsx`: the 1-2-3 numerals were the accent colour at 35% opacity, 2.2:1. They now use
the existing `--text-muted` token at full strength. No new colour. Test:
`client/src/pages/landingContrast.test.js`, 4 cases (computes the ratio from the tokens). The
home page is clean in the accessibility scan at all three widths.

### 6.4 Browser suites and committed screenshots

`hardening-accounts.mjs` and `order-lifecycle.mjs` write screenshots under `--scratch` unless
`--shots` names a folder; `journey-qa.mjs` refuses to start without `--shots`. Test:
`server/security/e2eScreenshots.test.js`, 4 cases. All three were run without pointing at `docs/`
and `git status` stayed clean.

### 6.5 Timing assertions

What changed, so nobody has to guess:

| Assertion | Was | Is |
|---|---|---|
| `security/uploads.test.js`, health check while a file is parsed (two places) | slowest of all samples under a fixed bound; failed at 334–337 ms on this machine because the first request to a just-started server is slow | `testSupport/latency.js` `assertResponsive`: a warm-up request first; a hard ceiling of `min(1000 ms, half the parse time)` that is never relaxed; a tight bound of the original figure plus the stall an idle timer measured on the machine during the same window; and, with 20 samples or more, the 90th percentile under 100 ms |
| `parsers/parsePool.test.js`, the longest the main thread was held during a parse | under 250 ms, flat | `assertResponsive` with 250 ms as the tight bound: plus the stall an idle thread saw in the same window, never over the ceiling |
| `parsers/parsePool.test.js`, a full queue refuses at once | under 200 ms, flat | under `min(390, 200 + stall)` ms: never the 400 ms a queued job would take |
| `geometry/dxf/dxf.test.js`, hostile DXF parse time | wall clock under 1500 ms | CPU time of the process under 1500 ms, and wall clock under 15 s |

`latency.test.js` (5 cases) holds the helper itself: a quiet machine gets the original bound;
a stall the machine showed is allowed for and nothing beyond it; work on the event loop fails on
any machine, because the ceiling is not relaxed by a busy one; nine samples in ten must be quick. Other wall-clock assertions have margins of several
times and were left.

### 6.6 Database saves are flushed

`server/models/database.js` `writeDurably`: write the temporary file, `fsync` it, rename it over
the database, `fsync` the folder. A file system that cannot flush a folder is tolerated; any other
failure fails the save and leaves the old database untouched.

Cost per save, `node scripts/dev/fsync-cost.js`, on this machine's ext4 disk with a load average
between 4 and 8:

| Database | Write + rename (median) | With both flushes (median) | Added |
|---|---|---|---|
| 5 MB, 30 saves, run 1 | 7.1 ms | 23.1 ms | 16.0 ms |
| 5 MB, 30 saves, run 2 | 6.7 ms | 18.7 ms (p90 21.4, worst 22.0) | 12.0 ms |
| 50 MB, 10 saves, run 1 | 71 ms | 165 ms | 94 ms |
| 50 MB, 10 saves, run 2 | 67.5 ms | 215 ms (p90 622) | 148 ms |

Under the 20 ms bar at 5 MB, so it is always on: no environment switch. At 50 MB the flush adds
0.1 to 0.15 s to every save. The database only gets that large through H3 (section 7), which
`availability-fixes` is closing; if it could grow that large in normal use, the save itself
(67 ms before any flush) is already the problem. Railway's volume will differ: run the script
there once. Test: `server/models/databaseDurability.test.js`, 5 cases.

### 6.7 Found while verifying

| What | Fix | Test |
|---|---|---|
| Firm quote: a link whose quote was edited and not sent again told the buyer to "check the price and the details below, and accept again". The merged page shows no quote in that state (section 11, choice 11) | the server's answer carries `linkReplaced`; the catalogue words the two cases separately | `messageCatalogue.test.js`, `orderLifecycle.test.js` |
| Change log tab at 390 px: a region that scrolls sideways and could not be reached from the keyboard (axe: serious). The tab came from review-fixes; the other admin tables were fixed on journey-qa | same markup as the other admin tables | `client/src/components/admin/tableRegions.test.js` |
| Admin → Pricing at 390 px: the card inside the price preview became a scrolling region of its own that the keyboard could not reach (axe: serious). Seen in one full walk of three, when the preview's table was wider than the screen at the moment of the scan | under 1100 px the card no longer scrolls separately; the focusable aside around it does | `tableRegions.test.js` (7 cases in all) |
| `hardening-accounts.mjs`: two assertions matched the server's sentence; the page now shows the catalogue's | expected wording updated, with a note; the facts held are the same | the suite itself |

### 6.8 Verification table

Final code commit: `849b091`. This document is the only later commit.

| Check | Result |
|---|---|
| Fresh `git clone` → `npm ci` → `npm test`, Node 20.20.0, at `849b091` | **69 of 69 suites**, 871 checks reported ok, none failed. No `data/` folder and no `client/dist` in the clone beforehand. (Also 69 of 69 in a fresh clone at `4086c18`.) |
| The same in a second fresh clone, Node 22.23.4, at `8e63dbf` | 68 of 69. The one failure was `partOwnership.test.js`, whose fixture reordered an unpaid order (6.11). With the fixture commit pulled into that clone (`4086c18`, that one test file), the suite passes, 6 of 6. A full Node 22 run was not repeated after that; the commits since change one stylesheet rule and client-side source tests |
| Earlier fresh clones, for the record | 67 of 68 at `51f3988` on Node 22 (the entrypoint fixture, 6.2); 68 of 69 at `8e63dbf` on Node 20 (the same `partOwnership` fixture) |
| `NODE_ENV=production npm run build` (in the clone) | exit 0; 22 of 22 routes prerendered (every clone) |
| `node scripts/claims-check.js` (in the clone) | exit 0 (every clone). 256 files, 21.3 MB, 1 PDF read; the street address is in none of them and no sample document is in the build |
| `npm audit --omit=dev`, server and client | 0 vulnerabilities; 0 vulnerabilities |
| `tools/vet-quotes/run_vetting.js`, production-mode server | 300 quotes, 0 fails, 63 warnings (55 against the shop estimate, 8 price-per-volume outliers) |
| the same against `hardening-2026-11-11`, compared | 300 quotes, 0 fails, 63 warnings; `results.csv` is identical in every column of all 300 rows except `quoteId` |
| `tools/security/review/poc-01` … `poc-09` | all nine ran to the end; nothing exploits (6.9). Run again at the final code: every output line identical once ids, keys and times are masked |
| `tools/security/review-payments/poc-01` … `poc-12` (`run-all.sh`) | 0 of 79 checks show a weakness (per script: 0/1, 0/4, 0/4, 0/6, 0/8, 0/15, 0/15, 0/5, 0/5, 0/5, 0/2, 0/9). `poc-09` was 2 of 5 before the journey merge (both F-16). Run again at the final code: the same |
| `scripts/e2e/hardening-accounts.mjs`, at `4086c18` | 121 of 121 |
| `scripts/e2e/order-lifecycle.mjs`, at `4086c18` | 63 of 63 |
| `scripts/e2e/journey-qa.mjs`, axe-core 4.14.0, 390 / 768 / 1360 px | Full walk at `4086c18`: 306 screens (102 at each width), axe on all 306. 0 scroll sideways at any width, 390 px included. 0 problems noted. **1 serious finding**: Admin → Pricing at 390 px (6.7), fixed in `849b091`. After the fix the admin journey was walked again at the three widths: 69 screens each time, 0 serious or critical (the session stopped before the run details for this line were filled in; treat it as recorded once, not re-checked). The earlier full walk (at `bda5943`) also had exactly one, the Change log tab at 390 px, fixed in `98c1c96` and clean in the walk at `4086c18`. No full walk was run on the tree with both fixes in; every other screen was clean in both full walks |
| `tools/security/csp-browser-check.js` | 67 steps, 67 clean, 0 violations, 0 page errors |
| Upgrade proof (6.10) | 23 of 23 on a database made today with `origin/master`'s code; 21 of 21 on the committed fixture |

Checks run before the last code commit: the two vetting runs and the uploads-review scripts
(section 7) ran at `bda5943`. Six application files changed after that (`ChangeLogTab.jsx`,
`OrderTrackingPage.jsx`, `messageCatalogue.js`, `global.css`, `routes/orders.js`,
`services/orderState.js`); none is in pricing, geometry, parsing, upload handling or the database
layer. Everything else in the table ran at the commit named or later.

Suite counts by merge, for the record: 46 of 48 after review-fixes (the two fresh-clone faults,
fixed next commit); 51 of 52 after order-lifecycle-fixes (the upload latency bound, fixed next
commit); 54 of 55 after journey-qa (the DXF wall-clock bound under load, fixed in that commit);
63 of 63 after deploy-runbook.

### 6.9 The first review's scripts, read line by line

| Script | What it tried | What happened |
|---|---|---|
| `poc-01` | a mismatched or invented process, material, grade, finish, thickness, infill, quantity, lead time; a paperwork amount; mass assignment | every hostile configuration answers 400 with its code. The honest ones price as before. A million pieces prices, and is sent to a person (`quantity`, `big-ticket`) |
| `poc-02` | an honest $2,085 quote paid at $37; registering the admin address first | the cheap quote cannot be made (`process-not-offered`); 0 Stripe sessions; registration of the admin address answers 409 |
| `poc-03` | DXF units changed after pricing | the stored quote re-prices to $6,172.77 and is sent to a person; checkout answers 409; 0 sessions |
| `poc-04` | 45 routes as a guest, another buyer and an admin who has not enrolled | no cross-account read or write. The unenrolled admin gets 403 `two-factor-enrolment-required` on every admin route |
| `poc-05` | cookie flags, token replay across purposes, reset reuse, locking the owner out | all refused; after five wrong guesses from elsewhere the owner still signs in |
| `poc-06` | admin promotion, Host-header link poisoning, code reuse and guessing | refused; links are built from the configured host; a code works once; codes pause after 4 wrong |
| `poc-07` | state changes with a cookie and no CSRF token | 403 on each |
| `poc-08` | headers on every kind of answer; static exposure | all present; nothing exposed. `/brand/documents/` now answers 301 then 404 (the folder is gone) |
| `poc-09` | 24 static paths, traversal, redirects, 17 malformed requests | 404s; redirects stay on the site; no stack, path or library name in any answer |

Three lines in those outputs look like findings and are not:

1. `poc-06`: "preflight from evil origin with matching Host: 204, allow-origin evil.example". The
   request claims `Host: evil.example` and `Origin: https://evil.example`: by its own account it
   is same-origin. A browser can only send that if `evil.example` resolves to this server, and
   then the session cookie (`__Host-`, bound to our host) is not sent. With the real Host the
   answer grants nothing. The reviewer rated it "grants nothing" for the same reason; the output
   is unchanged from the base.
2. `poc-06`: "wrong codes on `/2fa/recovery-codes` with a session: 45 of 45 processed". That route
   needs a session that has already passed two-step sign-in, and is limited to 20 tries per
   15 minutes per address (the script used three). Guessing there gains nothing a signed-in admin
   does not have. Wrong codes on it do not feed the sign-in pause; listed as a Low item
   (section 9, item 13).
3. `poc-09`: `//evil.example/x` on the `www` host redirects to
   `https://straightedgemfg.com//evil.example/x`. The Location is absolute and names our host;
   the next hop reduces the path to `/evil.example/x`, which is a 404. With `CANONICAL_HOST` set
   (production), the first hop already has one slash. `redirectsCompose.test.js` walks both.

### 6.10 Upgrade proof

`node scripts/dev/upgrade-proof.js <database>` starts the real server in production mode on a
database written by `origin/master`'s own code (made with
`scripts/dev/make-origin-master-fixture.js`: the owner's admin account, a customer, a part, a
paid order, an order awaiting payment, a quoted firm quote, one accepted on a PO, one accepted by
card and unpaid, a saved quote never ordered).

| Held | Result |
|---|---|
| Starts cleanly; nothing in the log is an error | yes |
| Nothing lost: accounts, parts, quotes, orders, order lines, requests, lead times | 8 tables, 21 rows, equal value for value |
| Pricing rules | all 127 stored values kept; 2 keys added (`paperworkFeePerPart`, `paperworkFeePerOrder`) |
| Added | 4 tables (`admin_audit`, `payment_events`, `payment_sessions`, `revoked_sessions`), 43 columns |
| A second start changes nothing | 16 tables, 112 rows identical |
| Owner's account | the same row: same id, same password hash, admin. Signs in with the old password. Every admin route answers 403 `two-factor-enrolment-required` until two-step sign-in is on; after enrolling, the admin pages open |
| Customer | signs in with the old password; sees both orders, paid and awaiting payment; the paid order shows the amount that was charged |
| Old orders print | traveler, order confirmation and packing slip. The traveler prints the line from what the old order stored. A line with no stored configuration (the oldest kind; made for the test by clearing the line's configuration) prints "NOT RECORDED" for grade and finish, never a blank |
| Saved quote | went through the price check and checkout opened. Today's rules give the same price to the cent ($285.44), so it was not a case of honouring an old price against a new one. Its price hold runs 30 days from the day it was saved |
| Quoted firm quote | opens from the link `origin/master` sent, at $1,850 |

Three things the proof showed that a deploy onto the live database needs to allow for:

1. **The catalogue is replaced.** The database's catalogue version is 3 and this code's is 4, so
   `server/config/seed.js` deletes and re-inserts materials, finishes and processes from the
   defaults. In the proof: 50 materials before, 54 after; four SLA resins dropped
   (`sla-standard`, `sla-tough`, `sla-flexible`, `sla-dental`), eight added; finishes and
   processes the same. Prices edited in the admin pages are not carried over. Pricing rules are
   merged, not replaced. This is the base branch's design (commit 1dbc763), not something the
   four branches added. A saved quote that names a dropped resin will answer
   `material-not-offered` at checkout and has to be reopened. The runbook (step 1, item 5), the
   checklist and the runbook's list of first-start log lines now say so.
2. **Old unpaid orders are closed on the first start.** The sweep asks Stripe whether each
   unpaid order older than the session window was paid, and closes the ones that were not
   (lifecycle report, section 9). The proof's unpaid order was minutes old, so this did not
   trigger here; it is covered in `orderLifecycleMigration.test.js`.
3. **Old accounts have no confirmed email on record.** Once the mailer is configured, a customer
   from the old site is asked to confirm the address before the first checkout (the checkout page
   offers to send the link). With no mailer the step is skipped, which is what happened in the
   proof.

`origin/master` stored totals unrounded ($259.2436…); the charge was and is the total rounded to
the cent.

### 6.11 Two checks from the availability re-review

Added to this task while it ran. The re-review's scripts were copied in as files from
`rereview-availability-2026-11-12` (`tools/security/rereview-availability/`, 17 files); neither
that branch nor `availability-fixes` was merged. `common.js` needed no change for the two scripts
run here. The other fifteen were not run: they test modules this tree does not have yet.

**RR-10, the units switch.** `geometry-price.js units`: upload a DXF plate, price ten of them as
millimetres, switch the part to inches (25.4 times larger), check out the stored quote.

| Step | On this tree |
|---|---|
| Honest price of the inch-sized plate | $3,376.62, checkout open |
| Priced as millimetres | $149.25, checkout open |
| After the switch to inches, the stored quote says | $3,376.62: the units route re-priced the draft at once |
| Checkout of that quote | 200, order total $3,376.62 |
| Underpriced by | $0.00 |
| Units change once ordered | 409 (locked) |

It does not charge the old price. It also does not refuse: the draft was re-priced the moment the
part changed, so the stored quote already carried today's price and checkout charged that. This is
review-fixes' design ("price every draft quote that names the part again"), and
`priceIntegrity.test.js` holds it ("a DXF's units changed after pricing — the draft quote is
priced again at once, and the buyer is shown the new price before paying"). A page that still
shows the old total sends it with the checkout and gets 409 `quote-changed`
(`hardening-accounts.mjs`, section K, in a real browser). No change was needed.

**RR-14 and RR-05, reorder.** `reorder-block.js`.

| # | Finding | On this tree | Now |
|---|---|---|---|
| RR-14a | Reorder was accepted for an order that was never paid for | reproduced: 201 for an abandoned checkout | **Fixed.** 409 `reorder-not-available` unless the order was really placed: paid at some point (still paid, in work, shipped, refunded afterwards, cancelled after payment), or accepted on a PO and taken into work. The rule is `orderState.wasPlaced`. The order answer carries `canReorder`, and the order page shows the button only then. The owner can still rebuild a quote from any order. The script's reorders now answer 409 in 9 ms |
| RR-14b | Reorder kept one configuration per part: two thicknesses of one part came back as one line | **not reproduced**: two lines of one DXF in 1.6 mm and 25.4 mm sheet come back as two lines, each with its thickness and quantity, priced separately | held by a test |
| RR-05 | A reorder prices every line on the main thread: no memo, no line budget, no per-account wait | still true for an order that was paid | **Open, not mine.** It needs modules from `availability-fixes`. The call site (`server/routes/orders.js`, in the reorder handler, just above `saveQuote`) carries a note headed "NOTE FOR THE availability-fixes MERGE (re-review RR-05)", and `reorder.test.js` fails if the note is removed |

What RR-14a changes for RR-05: the stall can now only be caused from an order that was paid for,
and an instant order is capped by the gate (an order over $5,000 goes to a person), so the
attacker has to buy something first. It is narrower, not closed.

Application code changed: about 50 lines with comments (`orderState.js` 14, `orders.js` 18,
`messageCatalogue.js` 9, `OrderTrackingPage.jsx` 9). Tests: `server/routes/reorder.test.js`,
8 cases. `paperwork.test.js` (two places) and `partOwnership.test.js` (one) reordered orders
that had not been paid for; each now asserts the refusal, pays the order, and holds what it held
before. All 21 reviewer scripts were run again afterwards (6.8).

## 7. The uploads review's findings on this branch

Recorded, not fixed: they belong to `availability-fixes`. Every script was run alone. Sizes were
reduced where the full size needs most of the machine's memory.

| # | Run | Result on this branch | Reproduces |
|---|---|---|---|
| C1 | `availability.js session 25 1` (25 lines, one request; the full run needs 3 GB) | one request builds a 119.4 MB answer in 14.0 s; memory 431 → 1,013 MB; health check worst 8.3 s, median 6.8 s. The 100-line run was not repeated | Yes |
| C2 | `availability.js mainthread 1200` (1,200 holes, not 4,900; the full size did not finish in 280 s) | 11 quotes of 100 lines from one address, none rate-limited, median 47.7 s each; health check median 62.5 s, worst 64.6 s | Yes |
| H1 | `price-nan.js` | honest 400 mm block: $3,727.15, sent to a person. The same block with one `Infinity` corner: **$352.04, open for card checkout; a checkout session was created**. With a `NaN` corner it is sent to a person | Yes |
| H2 | `availability.js queue` | one address fills the waiting line: two of three real customers refused `busy` in 0.1 s, the third waited 38.9 s | Yes |
| H2 | `availability.js pool` | @@POOL@@ | @@POOLYN@@ |
| H3 | `availability.js db 100` (100 quotes, not 1,600) | 354 kB per draft quote; 33.8 MB after 100 quotes in 31 s from one address; no limit reached | Yes (growth rate; the ceiling was not reached at this size) |
| H4 | `availability.js storage` (full size) | four addresses stored 1,960 MB in 39 s; the fifth and a real customer's 9 kB STEP were refused `storage-full`; the log says 100% | Yes |
| H5 | `retention-encryption.js retention` | on day 8 the CAD files are gone; an order placed that day goes to Stripe and the admin download answers 404 "File missing on disk"; the same for a firm-quote request | Yes |
| M1 | `abuse-limits.js on` | a verified-human token from one address works from another | Yes |
| M2 | `abuse-limits.js on` / `off` | 10 firm-quote requests an hour per address, each mails the shop; 32 attachments on disk, none swept | Yes |
| M3 | `abuse-limits.js on` | 10 "confirm your email" messages to addresses the script typed | Yes |
| M4 | `availability.js memory` | peak 1,208 MB (from 146); the watchdog stopped both hostile parses; the real customer's file parsed | Yes |
| M5 | `retention-encryption.js encryption` | with encryption on, the database still holds DXF coordinates, mesh JSON and file names in the clear; a crash mid-parse leaves one plain file | Yes |

Two numbers moved because of the merge, neither a fix: one account now gets 12 checkout tries in
15 minutes (review-fixes' limiter; the script counts 12 "sessions", which are one order and one
reused session), and 60 tries make one unpaid order.

**H1 is a price hole, not only an availability one.** The price-integrity floor from review-fixes
does not catch it: the price is finite and above the material cost of the (wrongly) measured
part. Until `availability-fixes` merges, a buyer can pay a tenth of the price for a large part.

## 8. Seams for the three branches still to come

| Branch | Where it joins | Notes |
|---|---|---|
| `tax-shipping` | `server/services/expectedCharge.js` `components(order)`: add tax and shipping there and nowhere else. `orderLifecycle.openSession` (`orderLifecycle.js:223`): `automatic_tax`, the Stripe Customer, per-line tax codes go into the one `sessions.create` call. `orderLifecycle.checkSession` (`:317`): subtract `total_details.amount_tax` when Stripe computes the tax. `orderEvents.stripeLineItems` builds the lines from `expectedCharge` | `relaunchIntegration.test.js` asserts the session amount equals `expectedCharge` to the cent: extend it, do not relax it. The phone total bar reads `quote.orderTotal`; if "Total" comes to mean before tax, its label follows |
| `availability-fixes` | The reorder handler in `server/routes/orders.js`: wrap the `saveQuote` call under the note "NOTE FOR THE availability-fixes MERGE (re-review RR-05)" the way that branch wraps `POST /api/quote`. `server/ops/status.js` `OPTIONAL_GETTERS` (`:223`): the names of the getters it exports. `MEMORY_BUDGET_MB` in `.env.example`, the runbook (step 3), the checklist and deploy notes section 8: all four say "confirm when availability-fixes merges". `messageCatalogue.js`: word `quote-too-large`, `part-reupload-required` and any other new code (the test in section 5 fails until then). `server/testSupport/latency.js` for any new responsiveness assertion | Its fix for H1 belongs before `priceQuote`'s engine call or in `resolveFeatures`; `tools/security/review-uploads/price-nan.js` is the proof. `database.writeDurably` is the only place the database file is written; if it moves saves off the main thread, keep the four steps in order (`databaseDurability.test.js`) |
| `geometry-speed` | `server/processes/featureAdapter.js` `resolveFeatures` (`:320`). `server/services/quoteIntegrity.js` `geometryHash` (`:523`) and `partSnapshot` (`:529`): the fingerprint a quote is checked against at checkout | Do not change what `geometryHash` hashes without a migration for stored quotes: a changed fingerprint makes every saved quote re-price instead of being honoured in its hold. Parser stage timings are already excluded from it. The vetting run (300 quotes, 0 fails, 63 warnings, CSV identical) is the regression check for geometry results |

## 9. Open items

| # | Item | Severity | Owner |
|---|---|---|---|
| 1 | H1: `Infinity` in a model gives a tenth of the price with checkout open | High, launch blocker | `availability-fixes` |
| 2 | C1, C2, H2, H3, H5 | Critical / High, launch blockers | `availability-fixes` |
| 3 | H4, M1, M2, M3, M5; M4 to verify on Railway | High / Medium | `availability-fixes` |
| 4 | The catalogue upgrade replaces materials, finishes and processes on the first start on the live database (6.10) | Medium (owner's data) | owner, before the deploy: note any price edited in the admin pages. Whoever owns `server/config/seed.js`: carry edited prices across by slug |
| 5 | Sample documents with the street address are in the repository (`docs/brand/samples/`) | Low | owner: keep, or regenerate with a placeholder address |
| 6 | Tax and shipping on the session | planned | `tax-shipping` (section 8) |
| 7 | `MEMORY_BUDGET_MB` and status-page getters unconfirmed | planned | second pass, when `availability-fixes` merges |
| 8 | Sixteen server states without a usable code (5.2) | Low | security engineers |
| 9 | Not verified against real Stripe: a 100% promotion code's `payment_status`; `payment_intent_data.metadata` copied to the charge; the shape of `refund.updated`; `sessions.expire` on a finished session; `expires_at` two hours out; retry timing | Medium until tried | owner with a test-mode key, runbook step for Stripe |
| 10 | Not verified by a person: the real Turnstile widget, the real card page, real mail clients, a screen reader, a real phone | Medium | before launch, by a person |
| 11 | No email to the customer when an order closes unpaid, is cancelled or is refunded; none when the owner marks an order paid by hand | owner decision (10, items 14 and 15) | owner |
| 12 | The admin phone-order route (`POST /api/orders`) does not apply one-quote-one-order | Low (admin only, two-step) | whoever next edits `orders.js` |
| 13 | Wrong codes on the in-session two-factor routes do not feed the sign-in pause (rate limit only) | Low | security engineers |
| 14 | Sign-in, setup, checkout and upload counters are in memory and reset on a restart | Low (one process) | accepted; restated by the uploads review as L5 |
| 15 | Storing a large parse result stalls the main thread for 200–330 ms | Low | `availability-fixes` / `geometry-speed` |
| 15a | RR-05: a reorder of a paid order prices on the main thread with no budget (6.11). Marked at the call site | Medium (needs a paid order) | second pass, with `availability-fixes` |
| 16 | `resolveFeatures` estimates volume as half the bounding box for a mesh with no usable volume | Low (the gate sends such parts to a person) | `geometry-speed` |
| 17 | A Stripe page already open when the owner ends price holds stays payable until its session expires (two hours at most) | Low | accepted |
| 18 | Disputes are not shown to the buyer (the catalogue has the sentence; the order page does not use it) | owner decision | owner |
| 19 | The traveler's quality checklist is fixed text per process, not tied to the material's tolerance; none for routing | owner decision (10, item 21) | owner |
| 20 | `<style>` in emails; two browser storage keys (journey report, sections 3 and 11) | Low | security engineers to confirm |
| 21 | Node 20 is out of support; the suites pass on 22 | Low | owner decision (10, item 3) |
| 22 | `tools/vet-quotes/results.*` in the repository are the earlier committed run, not regenerated here (the new run is identical apart from quote ids) | Info | none needed |

## 10. Decisions for the owner

One list from the four reports, duplicates removed. "Now" is what the merged code does if nobody
decides.

Deploy and operations:

| # | Decision | Now |
|---|---|---|
| 1 | Sending address: main domain or a subdomain | not set; the runbook recommends a subdomain with replies to the shop's mailbox |
| 2 | Keep `nordmfg.com` pointed at the site, and for how long | redirects for as long as it is listed in `REDIRECT_HOSTS`; recommended at least a year |
| 3 | Node 20 (tested here and in the Dockerfile) or 22 | 20 |
| 4 | Digest hour and whether to keep the daily email | 7 am Central; kept |
| 5 | Where the off-site copy of the backup lives | nowhere until chosen |
| 6 | When to set `HSTS_ALL_HOSTS=true` | off; not before item 2 is settled |
| 7 | An outside uptime monitor | none; UptimeRobot recommended |
| 8 | Before the first deploy: were any material or finish prices edited in the admin pages on the live site? | they would be replaced by the defaults (6.10) |
| 9 | Sample documents with the street address in the repository | kept in `docs/brand/samples/`, not published |

Payments and orders:

| # | Decision | Now |
|---|---|---|
| 10 | Promotion codes at checkout | off (`STRIPE_PROMOTION_CODES` unset) |
| 11 | How long a payment page stays open | two hours (`CHECKOUT_SESSION_MINUTES`); then the order closes as not paid and the quote can be ordered again |
| 12 | Checkout tries per account | 12 in 15 minutes (`CHECKOUT_PER_ACCOUNT_15MIN`) |
| 13 | Duplicate and late payments | flagged and emailed to you; you refund in Stripe. No automatic refund |
| 14 | Emails to the customer when an order closes unpaid, is cancelled, or is refunded | none sent |
| 15 | A confirmation email when you mark an order paid by hand | none sent |
| 16 | A cancelled order keeps its quote: the same quote cannot be checked out again; the buyer uses Reorder | yes (new at the merge; section 11, choice 1) |
| 17 | Whether a buyer sees that a payment is disputed | not shown |
| 17a | Reorder is offered only on an order that was paid for, or a PO order the shop has started | yes (new, 6.11). An order that closed unpaid sends the buyer back to its quote; one the shop cancelled unpaid says to call |

Wording and screens:

| # | Decision | Now |
|---|---|---|
| 18 | "Spam check" as the name of the Cloudflare step | used everywhere |
| 19 | Hours or reply times on "call us" messages | none stated. Only "within 24 hours" for a firm quote, from the confirmed fact |
| 20 | Time promises on the order page | none. "We'll write to you when it is settled"; "A bank can take several days to show a refund" (the lifecycle branch's "today" and "5 to 10 business days" were removed at the merge) |
| 21 | The traveler's wording and its quality checklist | as the journey pass left them |
| 22 | "We never ask for your password" at the foot of account emails | in six emails |
| 23 | "call … now and we'll lock the account" in the password-changed email | there is no lock button; today it means you reset the password |
| 24 | The admin two-step banner is amber, not red | amber |
| 25 | The browser remembers where checkout was, for a week | on |
| 26 | "Send the link again" waits a minute between sends | on |
| 27 | Anodize and powder coat are offered on plastics in the quote tool | offered (a catalogue decision) |
| 28 | "Pay and place order" as the button label; "A large or very detailed model can take up to a minute" on upload | as written |
| 29 | Replace either LinkedIn banner if already live | not done by this work |

Settled since the reports were written: flushing every save to disk (done, 6.6); the home page
numerals (done, 6.3).

## 11. Where two branches disagreed, and what was chosen

1. **A cancelled order's quote.** review-fixes freed it for a new checkout; lifecycle releases a
   quote only when its order lapses unpaid. Chosen: the order keeps the quote
   (`orderState.holdsQuote`). Stricter. Only the shop cancels an order; a buyer whose paid order
   was cancelled has Reorder, and one whose unpaid order was cancelled starts a new quote or
   calls (section 6.11).
2. **Change-log rows.** Lifecycle's action names, review-fixes' `[before, after]` pairs, review-fixes'
   tracking and carrier facts. Section 3.
3. **A total of 0 on a quote that is out.** review-fixes refuses the save; lifecycle refuses the
   accept. Both kept.
4. **Guard order on checkout.** Lifecycle validated the ship-to fields before sign-in. Chosen:
   sign-in, confirmed email, limiter, then fields.
5. **What counts as finding F-09b** in `poc-07`: a $0.00 order, not "the save was accepted".
6. **One "printed line" rule.** Journey's `oneLine` wrapping lifecycle's `printable`; the
   traveler's layout and labels are journey's.
7. **Checkout page refusals.** review-fixes' behaviour, the catalogue's words;
   `console.error` in the quote builder dropped.
8. **Order-state wording.** The catalogue's, with no time promise. Disputes stay hidden from
   buyers (lifecycle's choice).
9. **The operations digest.** State-machine labels and the attention flag, not deploy-runbook's
   guessed status names.
10. **Session reuse.** `checkoutGuard.sessionFor` calls through to `openSession`.
11. **A firm-quote link after the owner edits the quote.** Journey's catalogue told the buyer to
    check the details on the page and accept again; after lifecycle the link opens nothing until
    the quote is sent again. Chosen: lifecycle's behaviour, new wording that fits it (6.7).
12. **The sign-in pause.** review-fixes removed the account lock and its email; journey had
    worded both. The lock's wording and email were removed, not kept for a state that cannot
    happen.

None of these broke a buyer flow, so none was left undecided.

## 12. Not verified, and why

- **Real Stripe, the real Turnstile widget, real mail delivery.** The brief rules out outside
  calls; all three are answered locally (item 9 and 10 above).
- **C1 at 100 lines.** It needs about 3 GB on a shared 8 GB machine. Run at 25 lines.
- **C2 at 4,900 holes.** It did not finish inside 280 s here; run at 1,200, where the health check
  already takes a minute.
- **H3 to the ceiling.** Run to 100 quotes; the growth rate is the finding.
- **The fsync cost on Railway's volume.** Measured on this machine's disk only.
- **The first-start sweep on a real backlog of old unpaid orders.** Covered in-process by
  `orderLifecycleMigration.test.js`; not on the real server with a real Stripe account.
- **The catalogue upgrade against edited prices.** The proof database had default prices, so
  "prices are not carried over" is read from `seed.js`, and shown only as "rows replaced".
- **A full production deploy.** The Dockerfile was not built here.
