# Relaunch integration, second pass

2026-11-12. Branch `relaunch-2026-11-12`, from `97f57f3` (the first pass) to `54fb0a6` plus this
document. Nothing was pushed. `master`, `revisions-2026-11-11` and every other branch are untouched,
and no pull request was opened or edited. No real secret was made or used and no call left the
machine for Stripe, Resend, Turnstile or Railway.

## 1. Bottom line

**The three branches are merged and the site is ready for your review. It is not ready to launch
until you have made decisions 1, 2 and 5 in section 11.**

- **Merged**: `availability-fixes`, `geometry-speed` and `tax-shipping`, in that order, 36 files in
  conflict, each resolved from both sides (section 2). Every seam the brief named is wired and has
  a test (section 3).
- **Tests**: from a fresh clone on Node 20, 88 of 88 suites pass; the production build and the
  claims check pass; no production dependency has a known vulnerability (section 7.1).
- **Prices did not move.** 300 vetting quotes: 0 rows differ from before the merges. Geometry
  corpus: 3,435 priced quotes identical apart from the shipping block the merge added.
- **Payments**: 0 of 79 payment checks show a weakness. The payment checks hold with shipping and
  tax on and with them off (32 new tests, section 3).
- **What a customer is charged at the defaults**: the parts, plus shipping of $12.00 and $2.50 per
  kilogram, to anywhere, with no size or weight limit, and no sales tax. That is what the site
  charged before. Tax is off until you switch it on.
- **Hand-edited prices survive the catalogue upgrade** and you are told which (section 5).
- **Worse than availability-fixes by itself in one respect, and I did not hide it**: under heavy
  load the longest single delays are longer (0.6 to 0.85 s against about 0.1 s), because the
  price-integrity check added on this branch hashes each dense drawing in one piece. Typical
  delays are unchanged and other visitors keep getting prices (section 7.5, open item 4).
- **At 1 GB of memory** the heaviest meshes are told "busy, try again" for as long as the service
  stays up once it has read one large model. At 2 GB they are read (section 6.2, decision 1).
- **Open**: 15 items, 4 of them medium. None loses money, charges a wrong amount or shows one
  customer another's data (section 10).
- **Found and fixed on the way**, beyond the brief (section 9): a quote of 25 dense drawings took
  5.7 s after the merges (now 1.5 s); the admin System page had a region a keyboard could not
  reach on a phone; the proof and browser scripts that were wrong for the merged site are
  corrected, each with its reason (section 8).

## 2. The three merges, and every conflict

All three were merged with `git merge --no-ff` into `relaunch-2026-11-12`, in the order asked.
Nothing was rebased, pushed or opened as a pull request.

### 2.1 `availability-fixes` (f706811): 18 files conflicted

| File | Both sides had | Resolution |
|---|---|---|
| `server/routes/api.js` (7 places) | relaunch: the price-integrity choke point (whitelist, floor, gate, fingerprint, re-pricing at checkout) and part ownership. availability: the pricing gate and runner, the sane-geometry check, the unreadable-file check, quote limits | Both, in this order inside `priceQuote`: may this caller use the part, can its file be read, `assertSaneGeometry`, then the whitelist, engine, floor, gate and fingerprint. `saveQuote` takes the caller's context, refuses a sender over a limit before any pricing, and writes nothing in a warm-up pass. `POST /api/quote` runs through the gate and the runner |
| `server/routes/auth.js` | relaunch: one "wrong passwords" email a day, the admin-address rules. availability: resend limits per address, the "held, sent later" answer | Both. A resend to the reserved admin address still gets the usual answer and no email, and still counts as the day's try |
| `server/models/database.js` | relaunch: every save flushed to disk (`writeDurably`). availability: deferred draft writes, its own stop handler, `flush()` | availability's write path with `writeDurably` kept underneath it |
| `server/models/SqliteDB.js` | each added columns | Both field maps |
| `server/security/limits.js` | relaunch: the checkout limit. availability: the memory budget and everything derived from it | Both |
| `server/testSupport/liveServer.js` | relaunch: the admin setup code. availability: the bot-check waiver | Both |
| `server/models/partPayloads.test.js`, `server/security/dataLayer.test.js`, `server/parsers/parsePool.test.js`, `server/security/uploads.test.js` | each had changed the same cases | The merged behaviour: the quote-session answer in two parts, part ownership, the test delay hook with the responsiveness check |
| `client/src/pages/QuoteBuilder.jsx` | relaunch: no material pre-selected. availability: previews fetched by address | Both |
| `client/src/pages/AdminPanel.jsx` | relaunch: the keyboard-reachable table region. availability: "Clear old drafts" | Both |
| `client/src/components/RfqQueue.jsx` | relaunch: the needs-resend alert. availability: "Delete request" | Both |
| `client/src/components/security/VerifyEmailNotice.jsx`, `client/src/pages/VerifyEmailPage.jsx` | relaunch: the catalogue's words. availability: the "held" notice | The catalogue's shape, with the held case added to it |
| `.env.example` | both appended blocks | Rewritten afterwards as one list (section 3) |
| `tools/security/rereview-availability/linger.js`, `stall-probe.js` | relaunch had the reviewer's originals, availability its adapted ones | availability's (each has a dated comment saying what was adapted) |

### 2.2 `geometry-speed` (baf0b81): 2 files conflicted

| File | Both sides had | Resolution |
|---|---|---|
| `server/security/uploads.test.js`, `server/parsers/parsePool.test.js` | Both had changed the "slow file" case. geometry-speed swapped the slow drawing for a 2 MB STEP plate, because its parser had made the drawing fast. availability made the slowness with a test-only delay | availability's delay: the case no longer depends on which file happens to be slow. geometry-speed's new case (the 5,000-crossing-line drawing read for real inside the limit) is added beside it |

`server/parsers/fileParser.js`, which the brief expected to conflict, merged cleanly: the
restructured fast parser, with availability's one line at the 3MF merged-vertex check.

### 2.3 `tax-shipping` (c7221a0): 16 files conflicted

This branch was written on the oldest base, before the payment and price-integrity fixes. Its
changes to the order and payment code were ported by hand onto the relaunch code, not taken as
they were.

| File | Both sides had | Resolution |
|---|---|---|
| `server/services/orderEvents.js` (6 places) | relaunch: sessions and settlement moved to `orderLifecycle.js`. tax-shipping: its own `createCheckoutSession`, `markPaid` and `settleFromSession`, with tax | relaunch's structure. From tax-shipping only `orderLines` (the shipping line) is kept here, built from `expectedCharge`. The tax logic went into the lifecycle (section 3) |
| `server/routes/orders.js` (4 places) | relaunch: re-pricing, one quote one order, limits, the file check. tax-shipping: `checkout.resolve`, delivery fields, the tax-certificate route | Both. The delivery choice is resolved inside the same step as the price check |
| `server/routes/rfq.js` (3 places) | relaunch: the claim (one quote, one order), single-line fields, the price the link was sent for. tax-shipping: `resolveFirm`, the certificate routes | Both. tax-shipping's early session creation is dropped in favour of relaunch's claim-then-session order |
| `server/routes/api.js` | relaunch: the integrity gate. tax-shipping: the freight gate | Both gates |
| `server/emails/templates.js`, `server/services/pdfGenerator.js` | relaunch: discount lines, printable single-line fields. tax-shipping: delivery, pickup and tax lines | Both |
| `server/models/SqliteDB.js`, `server/models/database.js`, `server/services/fileRetention.js`, `server/routes/authorization.test.js`, `server/testSupport/harness.js` | each added its own | Both |
| `client/src/pages/CheckoutPage.jsx` (7 places) | relaunch: the journey-QA layout, the kept form, catalogue messages, the price-change notice. tax-shipping: delivery choice, exemption, per-choice totals | relaunch's page with tax-shipping's pieces placed in it |
| `client/src/pages/FirmQuotePage.jsx`, `OrderTrackingPage.jsx`, `JobTravelerPage.jsx`, `client/src/utils/api.js` | the same pattern | Both. The traveler page had been rewritten on relaunch, so the delivery line was added to the new page by hand |

One fault the merge itself would have shipped, found by reading: the two certificate-upload calls
in `client/src/utils/api.js` passed a message string where the merged `postForm` expects headers.
Fixed, and exercised in the browser run.

## 3. The seams, and the test that holds each

| Seam | What was done | Test |
|---|---|---|
| Reorder route (re-review RR-05) | Behind the pricing gate; both `saveQuote` calls run in the site's one runner; 429, 503 and `quote-too-slow` are passed on as they are, and the second lead-time try is not made after one; each part is checked with `partsDB.getRow` (no measurement file read per line); `wasPlaced` and `reorder-not-available` kept. The RR-05 note is gone | `server/routes/reorder.test.js`: 5 RR-05 cases on real behaviour (13 in all) |
| Sane geometry | `assertSaneGeometry(part.geometry, { partId, fileName, config })` in `priceQuote`, before the whitelist | `server/parsers/saneGeometry.test.js`, `server/routes/priceIntegrity.test.js` |
| File still on disk | `partFilesPresent` before an order is made at checkout (409 `part-file-missing`); the request form already had it | `server/services/fileRetention.test.js`, the catalogue test |
| One access rule | `meshAccess.mayReadPart` is `partAccess.canUse(part, { user, key })`; the quote session uses the same rule | `server/routes/partOwnership.test.js`, `quoteSessionMesh.test.js` |
| Shutdown | `database.flush()` before the last save | `server/ops/shutdown.test.js` (one case rewritten, one added on a live server) |
| Status page | `OPTIONAL_GETTERS` replaced by the real modules' figures | `server/ops/ops.test.js` |
| Admin storage routes | In the route inventory; session, two-step sign-in and CSRF as every admin route; each action in the change log | `server/routes/authorization.test.js` (20), `server/services/storagePressure.test.js` |
| Order states against retention | Every state the state machine can set is one of over, unpaid or held (a test fails on a new state). The 48-hour rule and `CHECKOUT_SESSION_MINUTES`: an unpaid order holds its files outright until the later of 48 hours after it was made and 30 minutes after its payment page lapses; a phone order or a flagged payment holds them until the owner decides. A file cannot be removed while its order can still be paid | `server/services/rowRetention.test.js` (8, two new) |
| Refusal codes | Every code the server can send has words in the catalogue or is named as not a buyer refusal: 168 codes found, 141 worded, 28 named. The quote builder shows a refusal above the total with "the price below is from before your last change", disables Check out, and retries by itself for the two codes that pass | `client/src/utils/messageCatalogue.test.js` (17) |
| Production starters and the bot check | Every script that starts a production-mode server goes through `liveServer.js` (which sets the waiver) or sets it itself. The vetting recipe in `docs/quote-vetting-process.md` would no longer start; it is fixed and was tried | `server/security/botCheckStartup.test.js` |
| Settings in one place | `.env.example` lists every limit once with the code's default. The runbook says the Turnstile keys are required before the first deploy, and that 2 GB with `MEMORY_BUDGET_MB=2048` is the recommended size | `server/security/envExample.test.js` (3): fails on a limit that is missing, listed twice or shown with another default |
| Expected charge with tax | `expectedCharge` is the order's total before tax (`tax.preTaxCents`). The session is opened with the tax Customer, session options and decorated lines; the settle check takes Stripe's tax out before comparing and refuses tax on an order checked out with tax off; a paid order stores the tax and adds it to its total | `server/routes/paymentChecksByDelivery.test.js` (32), `taxShipping.test.js` (50), `orderLifecycle.test.js` (41) |
| Session reuse | A session is handed out again only while its lines and, for a taxed order, its tax address, exemption and tax settings still hold. A request that arrives while another is in flight for the same order with something different waits and is handled on its own | `paymentChecksByDelivery.test.js`, case 7 |
| Checkout and the delivery choice | Shipping is worked out from the lines checkout has just priced again; the buyer's unpaid order is resumed whatever delivery choice it was made with; the total the page showed is compared with the total for that choice | `paymentChecksByDelivery.test.js` cases 2 and 4, `taxShipping.test.js` |
| Freight gate | `gateWithShipping` applied with the integrity gate in `priceQuote` | `taxShipping.test.js` |
| Total label | `totalLabel(quote)` on the summary and on the phone bottom bar | browser run `scripts/e2e/tax-shipping.mjs` |
| Quote views | Under the weight formula a quote view reads no part from disk; pricing and checkout reuse the parts they already loaded | `server/routes/pricingAvailability.test.js` (two of its cases failed before this) |

## 4. Where two branches disagreed: which rule won, and why

| Question | The two rules | Winner | Why |
|---|---|---|---|
| A payment whose amount does not match | tax-shipping: mark the order "paid, under review". relaunch: leave it unpaid, flag it, email the owner | relaunch | An order is released to the shop only by a payment that passes every check. The tax arithmetic was added to that check, not beside it |
| Promotion codes | tax-shipping: always allowed. relaunch: off unless `STRIPE_PROMOTION_CODES=on` | relaunch | A discount on a session opened with codes off is itself a mismatch |
| What shipping is worked out from at checkout | tax-shipping: the stored quote's lines. relaunch: nothing stored is charged without pricing it again | relaunch's lines, tax-shipping's rule | Shipping is computed now, from the lines as just priced again. The stored shipping figure is never the charge (tax-shipping's own rule), and neither are the stored weights |
| Is shipping part of the 30-day price hold? | relaunch held the whole stored total. tax-shipping charges shipping under today's settings | tax-shipping | The parts are charged at the held price; shipping follows the settings at the moment of checkout. The page shows that total and the server checks the page's figure, so a buyer is never charged a total they were not shown |
| Resuming an unpaid order | relaunch: only if its total equals the quote's. tax-shipping: bring it up to date | tax-shipping, inside relaunch's one-order rule | The delivery choice can change on the way back from the card page. It is still one order, re-priced by the same check |
| A material with no density | tax-shipping: price it, shipping "unknown weight". relaunch: the whitelist refuses the material | relaunch | Nothing is priced from a catalogue row that lacks what its process is charged from |
| The slow-file test | geometry-speed: a different slow file. availability: a delay switch for tests | availability | The test no longer depends on parser speed |
| 48 hours, or the payment window | availability: an unpaid order keeps its files 48 hours. relaunch: a payment page lives `CHECKOUT_SESSION_MINUTES` (up to 24 hours) and can be reopened | Both, whichever is later | A file is never removed while its order can still be paid |
| Database ceiling default | relaunch: 256 MB. availability: 16 MB | availability | A save rewrites the whole file on the one thread (1 to 3 ms per MB). The server now warns at start-up if the existing database is already half of the ceiling |

## 5. The catalogue upgrade keeps hand-edited prices

`server/config/seed.js` replaced the material and finish lists with the new defaults whenever the
catalogue version went up, and with them every price the owner had changed.

- **The version-3 prices are recoverable from git, exactly.** One commit carried version 3
  (`2105c0b`), and `origin/master`'s `server/config/defaults.js` is that file. They are recorded in
  `server/config/seedHistory.js` with versions 2 and 4. The database made by `origin/master`'s own
  code holds exactly those prices: 50 materials and 32 finishes compared, none differs.
- **Rule** (`server/config/seedCarry.js`): a price that differs from the old default is the owner's
  and is put back on the row with the same slug. A price that was the old default takes the new one.
  A slug that left the catalogue is not brought back. A row the owner added by hand is not carried.
- **Reported**: one start-up log line and one change-log row per price kept or not kept; the admin
  pricing page shows the same list.
- **Between versions 3 and 4** four SLA materials leave and eight arrive; no other price differs. So
  for this upgrade every edited price is kept except one on those four resins.
- **Not carried**: anything other than a price (a name, switched off, a thickness list). The owner
  checklist and the runbook say so.
- **A version with no record** (version 1): nothing is carried and the log says so once.

Proof: `server/config/seedCarry.test.js` (8 cases) and `scripts/dev/upgrade-proof.js`, which now
changes three prices in a copy of the `origin/master` database before the first start.

## 6. Measurements the brief asked for

### 6.1 The `estimateFeatures` normals question

Behaviour was not changed. A corrected version (one normal per triangle, taken at its first corner)
was built in a scratch copy and run over both corpora.

| Corpus | What changes with the corrected version |
|---|---|
| Geometry corpus, the 21 STEP, IGES and 3MF cases | The feature counts (holes, slots, bends) change in 18 of 21. For the three processes that are sold (504 priced configurations): no price, no DFM result and no gate decision differs. For sheet metal, which is not offered: 116 DFM values in 16 cases, the price in 16 cases and the gate decision in 3 |
| Vetting, 300 quotes | 0 rows differ |

So the suspicion is right about the counts, and it makes no difference to anything sold today.

### 6.2 Memory: a 500,000-triangle mesh at the 1 GB default

Three such files uploaded to a live production-mode server, one after another, in seven runs: at
the default with gaps of 5 s, none, 10 s and 2 minutes, and the heaviest file by itself; at 2 GB
with 5 s and no gap.

| File | At the default (`MEMORY_BUDGET_MB` unset, 1024) | At `MEMORY_BUDGET_MB=2048` |
|---|---|---|
| Sphere, 500k triangles | read in 2.5 s, priced | the same |
| Lattice, 500k | read in 16 s, priced, sent to a person by the gate | the same |
| Loose triangles ("soup"), 500k, as the first file on a fresh server | first try: stopped after 14 s and answered `parse-memory`, "needs more memory to read than the instant quote allows ... send it to us for a firm quote". The same file again 5 s later: read in 12 s. It is at the edge of what 1 GB can read | read in 10 s |
| The same soup file after the lattice | **503 `busy`, "give it a minute and try again", on 7 of 7 tries** (gaps of 0 s, 5 s, 10 s three times, 2 minutes twice). After one large model the process keeps 350 to 650 MB resident, still held after two minutes idle, and what is left is not enough for this file. The log says `SHORT OF MEMORY` each time and what to do | read in 10 s, both runs |

The server stayed up in every run and no answer was unexplained. Resident memory once a parse
had ended was between 230 and 600 MB at the default. It came back down after some parses and not
after others (354 MB was still held two minutes after the lattice). That is the open point
availability-fixes reported as "memory the process keeps".
Defaults were not raised. The runbook recommends 2 GB with `MEMORY_BUDGET_MB=2048`; open item 3 and
decisions 1 and 10.

### 6.3 The two wording bugs

| Input | Before | Now |
|---|---|---|
| A malformed ASCII STL (a facet with a missing or an extra vertex) | `Cannot read properties of undefined (reading '0')` | `file-damaged`: "This file is damaged or incomplete. Re-export it from your CAD program and upload again." availability's input check already did this; a test now pins it |
| A drawing 2 km across | 12.7 s, then "damaged" or "busy" | `geometry-out-of-range` in 80 ms: the size is not a real part |

Test: `server/parsers/refusalWording.test.js` (3 cases).

### 6.4 The geometry baseline

`tools/geometry-bench/baseline/` was recorded again on the merged code, because 21 cases are now
refused on purpose and because the new shipping settings had switched the price comparison off.
Before recording, the price section of each of the 196 small and medium cases was compared with the
untouched code's, ignoring only the `shipping` block the merge added: 3,435 priced quotes, all
identical. Geometry and DFM hashes of all 221 cases that had an answer are unchanged.
`tools/geometry-bench/baseline-step1/README.md` has the account.

Compared again on the last code commit (`54fb0a6`), after the two pricing-speed changes of section 9:
all 198 small and medium cases that have a baseline answer are identical to it in geometry, DFM and
price. One more has no baseline answer, because the code before the merges could not finish it.

## 7. Verification

Node v20.20.0 throughout. Server code last changed at `0ba5884`. After it come one style value in an
admin page (`2187cff`), then only test and proof scripts, screenshots and this document
(`git diff --stat 0ba5884..54fb0a6 -- server` is empty). Where each figure was run:

- **7.1**: a fresh clone of `54fb0a6`, the last commit before this document.
- **7.2, 7.4, the loaded half of 7.5, sections 6.1, 6.2 and 6.4's last paragraph, and the
  held-thread figures in section 10**: on `3162a9b` or later.
- **7.3 and the quiet half of 7.5**: on `0ba5884`. Each script that was changed afterwards was run
  again after its change, and its row is from that run.

### 7.1 Fresh clone

`git clone` of the branch into an empty folder, then in order:

| Step | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm test` | **88 of 88 suites passed**; 1,122 checks marked ok, none failed; 7 min 43 s |
| `NODE_ENV=production npm run build` | exit 0; 22 of 22 routes prerendered, 22 JSON-LD blocks valid |
| `node scripts/claims-check.js` | exit 0 |
| `npm audit` (server) | 0 vulnerabilities |
| `npm audit` (client) | 2 (1 moderate, 1 high), both in `esbuild` / `vite`, the development server only |
| `npm audit --omit=dev` (server, client) | 0 and 0 |

### 7.2 Vetting comparison

`tools/security/rereview-availability/vetting-compare.js`: the 300-quote vetting run on
`hardening-2026-11-11` (`e4881d3`) against the same run on this branch. Both: 300 quotes, 0 fails,
63 warnings. **Rows that differ: 0.** There is no row to explain.

### 7.3 Proof scripts

Every script exited 0. "As the first pass" means compared line for line with the first integration
pass's output, with ids, ports and times masked.

**The three review branches** (`tools/security/review/`, 9 scripts): nothing exploits. Output is as
the first pass except one new field name in the registration answer (`verificationQueued`) and the
date in a backup file name.

**Payments review** (`tools/security/review-payments/`, 12 scripts): **0 of 79 checks show a
weakness** (per script: 0 of 1, 4, 4, 6, 8, 15, 15, 5, 5, 5, 2 and 9).

**Uploads review** (`tools/security/review-uploads/`):

| Script | Result |
|---|---|
| `files.js` | 50 PASS, 10 INFO, no finding |
| `parser-abuse.js` (all 59 hostile files) | server alive after every one, 0 failed health checks, worst health sample 77 ms, peak memory 974 MB; 12 files read (the controls and harmless variants), 47 refused, each with a message |
| `price-nan.js` | all four poisoned models refused at upload |
| `claims.js` | a 900 MB declared upload answered 413 in 7 ms; a part row is 5.1 to 6.0 kB |
| `abuse-limits.js off` / `on` | every limit stops where it says: 500 parts per 15 minutes per address (490 with the bot check on), 30 drafts, 10 requests an hour, 10 accounts an hour, 12 checkout sessions on one order, 1 unpaid order from 60 tries |
| `availability.js session 12 1` | an answer under 0.1 MB in 6 ms, health worst 4 ms |
| `availability.js mainthread` | 359 quote requests in 30 s, none priced (refused for line count or by the rate limit), health median 2 ms, worst 19 ms |
| `availability.js queue` | 3 of 3 customers served (7, 14 and 20 s) |
| `availability.js pool` | both attack requests answered in under 1 s (`dxf-too-many-blocks`) |
| `availability.js db 0` at a 16 MB ceiling | 2,196 quotes from 74 addresses to reach the pause; then visitors without an account are paused and an open quote still re-prices (200); health worst 84 ms |
| `availability.js storage` at a 200 MB ceiling | 784 MB sent, 0 MB stored; a customer's upload and request accepted, and again after a restart |
| `availability.js budget` / `refused` | 16 MB stored per address on a 20 MB budget; refused bytes are charged (note 5) |
| `availability.js keys` | the right-most forwarded address, its IPv4-mapped form, the same address with a port and every address of one /64 count as one client (limit 3: 200, 200, 200, 429, 429) |
| `availability.js memory` / `creep` | server alive, peak 915 MB, worst health 99 ms; after 24 killed parses 526 MB idle, 11 threads, no file left |
| `retention-encryption.js retention` | 5 PASS, no finding |
| `retention-encryption.js encryption` | 5 PASS, 1 finding that is known and unchanged (note 6); script adapted (note 4) |

**Re-review of the availability fixes** (`tools/security/rereview-availability/`, every script):

| Script | Result |
|---|---|
| `pricing-eight.js` | **Passing line met**: health median 2 ms in every phase (the line is single figures) and the other visitor priced 13 of 13 in every phase. Detail in 7.5 |
| `reorder-block.js` | **Passing line met for reorders one after another** (health worst 80 ms; the line is "tens of milliseconds"). With four at once the worst sample is 167 ms (note 2). Detail in 7.5 |
| `stall-probe.js sizes` | **Does not stay flat, and is not expected to** (note 1): a save takes 1, 2, 5, 9, 18 and 21 ms at 1, 8, 16, 32, 48 and 60 MB; worst health 23, 45, 67, 167, 309 and 517 ms |
| `stall-probe.js storm` | 41 priced, 771 told to retry; health median 2 ms, worst 412 ms, 23 of 888 samples over 100 ms; the loop itself was never held longer than 153 ms; no garbage collection over 20 ms |
| `stall-probe.js held 13.5` | 89 re-prices in 30 s; health median 2 ms, worst 20 ms, none over 100 ms |
| `db-ceiling.js size` | a draft of 25 different lines adds 12,288 bytes, of 100 lines signed in 20,480 |
| `db-ceiling.js account 8` / `16` | one account stopped at 26 drafts (`drafts-full`), database 0.7 MB; every other customer and visitor served, before and after a restart |
| `db-ceiling.js grow 8` / `16` | 25 re-prices accepted, 5 refused (429); database at 9 % and 4 % of the ceiling |
| `db-ceiling.js anon 8` | 723 drafts from 25 addresses reach the pause (`quotes-paused`); confirmed customers still upload and quote |
| `eviction-collateral.js` | a visitor's quote and a customer's unpriced part survive the clean-up, which removed 142 of the flood's drafts in pieces of at most 20 ms |
| `site-caps.js rfq off` / `on` | after the flood a visitor's request is accepted (201) |
| `site-caps.js mail off` / `on`, `mail-one off` / `on` | 60 and 15 confirmation emails caused by the flood; the new customer still gets theirs (1), and a password reset is still sent |
| `storage-pin.js pin` / `control` | after the clean-up storage is at 71 %; visitor and confirmed customer accepted |
| `parse-pool.js pair` / `steal` / `solo` | 6 of 6 served; the customer parsed in all 3 rounds while the hungry file got `parse-memory`; longest customer wait 15.8 s, none refused |
| `linger.js hold` / `many` / `pipeline` / `free` | server side closed after 5.0 s; 400 of 400 answered 413 and none open after 40 s; the pipelined request not executed; 264 MB of refused uploads all charged, next upload 429 |
| `geometry-price.js volume` / `small` / `units` | hostile models refused (`nested-shells`, `geometry-not-measurable`, `geometry-too-small`, `too-thin-to-print`); units: under-priced by $0.00, checkout at $3,376.62, units locked afterwards (409) |
| `encryption.js` | with the previous key listed every old part prices exactly as before; start-up prints the error when the key is wrong or missing; script adapted (note 4) |
| `memo-check.js` | no problems; 0 of 20 concurrent pairs got a price that was not theirs; script adapted (note 3) |
| `preview-access.js off` / `on` | no leak |
| `migration.js` | additive: 4 tables and 71 columns added, nothing lost; the old quote reads the same; the same parts price as on master ($892.91 against master's unrounded 892.9166, because totals are sums of whole-cent lines; $278.98 both); a second start changes nothing; script adapted (note 4) |

**Availability fixes' own tools**: `after-the-flood.js`: 4 of 4 customers parsed after six
memory-hungry files, none asked to retry. `measure-pricing.js`: a one-line quote 175 ms, a 100-line
quote 243 ms; in a 30 s storm 51 priced, 741 told to retry, health median 2 ms, worst 896 ms.

Notes:

1. **`stall-probe.js sizes`.** A save rewrites the whole database file on the one thread, so its
   time grows with the file. availability-fixes did not change that; it contains it with the 16 MB
   ceiling (5 ms a save, worst health 67 ms). The rows above 16 MB are sizes the default no longer
   allows. Open item 6.
2. **`reorder-block.js` was adapted, not to an easier case.** As written it reorders a 100-line order
   that was never paid. On the merged site that order cannot exist (over $5,000 goes to a firm quote)
   and an unpaid order cannot be reordered. The script now makes the largest order a customer can
   (3 lines of the 4,900-hole drawing, $4,102.19; 100, 50, 25, 12 and 6 lines are refused as too
   large), pays it through the local Stripe stand-in and reorders that. Four reorders at once are
   each served (all 201, 355 ms in all, in turn); the 167 ms sample is open item 4.
3. **`memo-check.js` was adapted.** It compared a quote with the reorder of an unpaid order and
   priced its last step as a visitor on a part the buyer had since claimed; both are refused now, so
   it reported an empty comparison as a price difference. It now pays the order and prices as the
   owner. Reorder goes through the same per-request memo since round 2, so the script compares two
   routes; memo against no memo is compared by `pricingAvailability.test.js`.
4. **`retention-encryption.js`, `encryption.js` and `migration.js` were adapted.** Each priced a
   part without the part's edit key (after a restart, or after moving an old database). Parts have
   owners since the first pass, so each was refused with `part-not-found` and reported that as its
   own finding. They now carry the keys as a browser does. With that, `retention-encryption.js`
   answers as it does on availability-fixes alone, `encryption.js` shows old parts pricing exactly
   as before, and `migration.js` has totals to compare.
5. **`availability.js budget` prints "stored 36 MB"** straight after the chunked run. That reading
   includes 3.9 MB of the third upload, written up to the budget line and removed within 3 seconds
   (checked: two 8 MB files remain). The same on availability-fixes alone.
6. **"The database holds part geometry in the clear"**: file names, overall measurements and DFM
   notes are in the database, which is not encrypted. Known (uploads review M5), documented in
   `docs/security/file-encryption.md`, unchanged by this pass.

### 7.4 Browser runs

| Run | Result |
|---|---|
| `scripts/e2e/hardening-accounts.mjs` | 121 of 121 checks (4 runs since the sign-out check was corrected; 120 of 121 in the one run before, section 8) |
| `scripts/e2e/order-lifecycle.mjs` | 63 of 63 |
| `scripts/e2e/journey-qa.mjs`, 390 px and 1360 px, axe-core 4.14.0 on every screen | 204 screens (102 at each width); 0 scroll sideways; **0 serious or critical accessibility findings**; 0 problems noted; all 82 probes answer as they did in the first pass's walk. One serious finding in the first walk of this pass (Admin → System at 390 px) was fixed (section 9) |
| `tools/security/csp-browser-check.js` | 68 of 68 steps clean, 0 CSP violations, 0 page errors, 0 failed requests; the policy proof passed |
| `scripts/dev/upgrade-proof.js` | 28 of 28 checks hold. Before a timer kept its event loop busy the script hung inside Node in 7 of 20 runs; 30 of 30 runs since complete (open item 13) |
| `scripts/e2e/tax-shipping.mjs` | 56 of 56 |
| `scripts/e2e/tax-shipping-upgrade.mjs` | 12 of 12 (a database made by `hardening-2026-11-11`'s own code) |

### 7.5 Fairness, quiet and under load

"Under load" is four busy loops beside the server on this 2-core sandbox, as in the availability
write-ups.

| Measurement | Quiet | Under load |
|---|---|---|
| `pricing-eight.js`: one quote of 25 different 3,000-hole drawings, by itself | priced in 1,522 ms | refused `quote-too-slow` after 6.2 s, with the firm-quote offer |
| The same, health check with 1, 2, 4 and 8 attacking addresses: median | 2, 2, 2 and 2 ms | 9, 9, 8 and 8 ms |
| The same: worst sample | 76, 170, 85 and 151 ms | 773, 655, 585 and 845 ms |
| The same: another visitor's one-line re-price, priced | 13 of 13 in every phase | 13 of 13, 13 of 13, 12 of 12, 13 of 13 |
| The same: that visitor's median and worst | 14 to 17 ms; 80 to 227 ms | 35 to 76 ms; 148 to 259 ms |
| The same: the attackers' quotes priced per 25 s phase | 7, 8, 9 and 10 (`pricing-busy` 0, 0, 1 and 8) | none: each was `quote-too-slow` or `pricing-busy` |
| `reorder-block.js`: one reorder of the largest order a customer can make | 131, 76 and 77 ms | 275, 234 and 240 ms |
| The same: health during three in a row, median and worst | 30 and 80 ms | 125 and 226 ms |
| The same: four at once | all four 201, 355 ms in all; health worst 167 ms | three 201 and one 429 (wait your turn), 774 ms in all; health worst 393 ms |
| `stall-probe.js storm`: priced and told to retry in 30 s | 41 and 771 | 27 and 599 |
| The same: health median and worst; samples over 100 ms | 2 ms and 412 ms; 23 of 888 | 2 ms and 1,002 ms; 41 of 704 |
| The same: the longest the thread was held in one piece | 153 ms | 330 ms |
| `parse-pool.js pair`: two customers at once, three rounds | 6 of 6 served, 7.4 to 14.3 s each | 6 of 6 served, 19.4 to 35.8 s each |
| Load average during the runs | 0.0 to 1.8 | 3.4 to 5.8 |

**Passing lines.** `pricing-eight.js` (health median in single figures; the other visitor keeps
getting prices): met, quiet and under load. `reorder-block.js` (health worst in the tens of
milliseconds while reorders run; a second reorder waits or is told to retry): met quiet for reorders
one after another (80 ms). Not met with four at once (167 ms) or under load (226 ms and 393 ms).
Every reorder was served or told to wait its turn.

**Against availability-fixes by itself.** Its own write-up
(`availability-fixes-round2-2026-11-12.md`) has, for the same scripts: the 25-drawing quote by
itself 0.45 s quiet and 1.29 s under load; worst health sample 83 to 112 ms quiet and 92 to 129 ms
under load; the attackers pricing 31 to 41 quotes a phase quiet and 14 to 20 under load; the storm's
worst sample 138 ms quiet and 319 ms under load, with the thread held 53 and 118 ms at most; and a
reorder, with the change it proposed, 51 to 62 ms with health worst 12 ms.

The merged site is slower on dense drawings because every part in a quote now has its stored
measurements hashed for the price-integrity fingerprint that guards the price between quote and
checkout: about 34 ms for a 3,000-hole drawing and 60 to 80 ms for a 4,900-hole one, in one piece.
That work did not exist on availability-fixes. Medians are the same and the other visitor is priced
every time. The worst single delays are longer, most of all when the server is starved of
processor time, and there a 25-drawing quote is refused as too slow where it was priced before.
The fingerprint was not touched to improve these figures. Open item 4.

## 8. Tests that were changed, and why

No test was changed to make it pass where the code was at fault. Each change below is a test that
was wrong for the merged code, with the reason.

| Test | Change | Why the test was wrong |
|---|---|---|
| `pricingAvailability.test.js` | raw requests carry the part's edit key; the eight-address share is read inside its 6-second window, with a second bound on the whole run; RR-05 uses its own part | Parts have owners now. The figure was being read after the in-flight requests had drained (13.9 s), which is not what the limit is |
| `partOwnership.test.js`, `system.test.js`, `masterDatabase.test.js`, `siteCaps.test.js` | the quote-session answer is read in its two parts; a preview is fetched by its address; a visitor uses the edit key | The session answer changed shape on availability; a part on no quote from before ownership existed can be priced by an admin only |
| `databaseDurability.test.js` | checks the save function's body, not a 300-character window | The window no longer reached the line it was looking for |
| `ops.test.js` | database ceiling 16 MB; the "extra figures" case rewritten | The default changed; the old case tested getters that no longer exist |
| `shutdown.test.js` | "no handler" case rewritten; one case added on a live server | The database now has its own stop handler and exits 0 with the whole file written |
| `priceIntegrity.test.js`, `reorder.test.js`, `orderLifecycle.test.js`, `relaunchIntegration.test.js` | lift the new per-account limits on new quotes and stored drafts | These suites make more quotes on one account in seconds than an account may in an hour. The limits have their own suites |
| `senderQuotas.test.js` | allowance used in the test 96 to 128 kB; the abandoned order has a lapsed payment page | A merged draft row is larger; an unpaid order whose page is still open now holds its files |
| `storagePressure.test.js` | the customer prices their own parts; the levelling check allows the last holder to be partly cut | Ownership; the levelling pass stops when enough is freed |
| `authorization.test.js` | follows routers mounted without a path; inventory gains the preview, storage, certificate, shipping-preview and catalogue-upgrade routes | The walk missed nested routers |
| `messageCatalogue.test.js` | wider scan for the ways the merged code writes a code; `shipping-freight` named as a gate reason | It did not see codes written as `refusal("…")` or as the keys of a message map |
| `taxShipping.test.js` | per-account limits lifted; the default session's key list gains `expires_at` and `payment_intent_data`; a guest uploads their own part. Four cases rewritten: a stored line with no weight (now charged correctly from the re-priced lines, was "refused"); a material with no density (now not priced at all); promo code with tax (needs codes switched on; a wrong amount is flagged, not "paid, under review"); firm quotes (the guest's own part) | The suite was written before part ownership, the lifecycle and re-pricing at checkout. Each rewritten case says so in the file |
| `scripts/e2e/tax-shipping.mjs` | the pay button's name | The button is "Pay and place order" since the journey work |
| `tools/security/rereview-availability/reorder-block.js`, `tools/security/review-uploads/preload-stubs.js` | the script makes the largest order a customer can and pays for it; the Stripe stand-in reports amounts and, when asked, a paid session | The order the script was written around can no longer exist (section 7.3, note 2). Dated comment in the file |
| `tools/security/rereview-availability/memo-check.js` | pays the order before reordering it; prices its last step as the part's owner | An unpaid order cannot be reordered and a claimed part is its owner's, so the script compared nothing and called that a difference (section 7.3, note 3) |
| `tools/security/rereview-availability/encryption.js`, `migration.js`, `tools/security/review-uploads/retention-encryption.js` | carry the part edit keys over a restart, or take them from the old quote, as a browser does | Each priced its own part without the key and reported the refusal as its finding (section 7.3, note 4) |
| `scripts/e2e/hardening-accounts.mjs` | waits for the sign-out response before replaying the old session token | The page goes home at once and sends the sign-out beside it; the replay could arrive first. 120 of 121 in the one run before the change, 121 of 121 in the four since |
| `scripts/dev/upgrade-proof.js` | a timer keeps its event loop busy | The script hung inside Node in 7 of 20 runs (open item 13); 30 of 30 since |
| `tools/geometry-bench/lib.js`, `live-upload.js` | the runner ignores the worker's first "hello" message; the live tool sends the part's edit key | After the availability merge every out-of-process case failed (0 of 228) for that reason |

New suites: `paymentChecksByDelivery.test.js` (32), `seedCarry.test.js` (8), `envExample.test.js` (3),
`refusalWording.test.js` (3).

## 9. Changed, and not in the brief

| Change | Why |
|---|---|
| `pricingMemo.materialize`: a drawing is put at its stock thickness once per request, at a place where pricing can yield | Running `pricing-eight.js` on the merged tree showed a quote of 25 different dense drawings taking 5.7 s (0.45 s on availability-fixes alone) with single health samples of 0.65 to 0.7 s. The price-integrity floor check and the shipping weight each did this per line with nowhere to yield. Prices are identical (geometry corpus, vetting, the line-by-line test) |
| `geometryHash` memoised per request; the engine's catch passes the runner's interrupt on; a part is claimed without re-reading its measurement file | The same kind of fault, found right after the availability merge: 100 dense lines took 10.5 s with a 4.5 s stall |
| Admin → System: long figures wrap on a phone | The journey walk with the accessibility scan found the "Limits and budgets" card had become a sideways-scrolling region the keyboard cannot reach at 390 px (axe: serious), because the status page now shows the real modules' figures. Admin only |
| The server warns at start-up when the database is already half of its ceiling | The default ceiling went from 256 MB to 16 MB; a database that was already large would have had its first visitors refused |
| `VerifyEmailPage` says "couldn't send" when the server says the email was not sent | It said "sent" either way |
| `docs/quote-vetting-process.md` recipe | It no longer started (missing variables), and it began with `rm -rf data` in the repository; it now uses a temporary folder |
| `shared/shop-facts.json`: the `file-retention` question carries a warning | Confirming "7 days" would put a sentence on the home page that is no longer true (section 11, decision 6) |
| `pickupDisclosed`: no pickup address for an expired or refunded order | Two states the lifecycle added after tax-shipping was written |
| `carrierService` is a single-line field like the ship-to block | It is printed on the traveler |
| The unused `EASYPOST_API_KEY` line removed from `.env.example` | Nothing ever read it |
| Geometry baseline recorded again; screenshots under `docs/screenshots/tax-shipping-2026-11-11/` refreshed | Section 6.4; the committed pictures showed the old checkout page |

## 10. Open items, by severity

Nothing below loses money, charges a wrong amount or exposes another customer's data. Items 1 to 6
are about how long the one server thread can be held or how much memory is left; the rest are
housekeeping.

| # | Severity | What | Measured | What would close it |
|---|---|---|---|---|
| 1 | Medium | **Checkout prices the saved quote again in one step, outside the yielding runner.** It has to be one step with the order it guards. For the heaviest quotes that holds the thread | 0.51 to 0.59 s held for a 100-line quote of one 1,600-hole drawing; 0.77 to 0.84 s for 25 different dense drawings. Needs a signed-in account with a confirmed email; 12 checkouts per account per 15 minutes; the time is charged to the sender's pricing allowance; a quote the gate sent to a firm quote (over $5,000, or a DFM failure) is refused before this step | Price in the runner, then compare a version stamp of the quote, its parts and the rules in the same step as the insert |
| 2 | Medium | **Changing a DXF's units re-prices every draft that holds it, in the same request** | 123 to 127 ms held with one 100-line draft, 246 ms with five, 268 to 336 ms with twenty 25-line drafts. Bounded by the sender's 512 kB of drafts (about 23 drafts of 100 lines; by the same slope about 0.8 s, which is an estimate, not a measurement) | Mark the drafts stale and re-price each when it is next opened |
| 3 | Medium | **At the 1 GB default, once the server has read one large model, a mesh that needs about 500 MB to read is told "busy, try again in a minute" on every try** (section 6.2). The words give the customer no other way forward | 7 of 7 tries, with gaps of 0 s, 5 s, 10 s and 2 minutes; the log says `SHORT OF MEMORY` each time and Admin → System counts it. Ordinary 500,000-triangle models (a sphere, a lattice) are read. Never at 2 GB | Decision 1 (2 GB). Decision 10 (one more sentence in the message) |
| 4 | Medium | **The price-integrity fingerprint hashes each part's stored measurements in one piece** | About 34 ms for a 3,000-hole drawing and 60 to 80 ms for a 4,900-hole one, plus the garbage collection it causes. It is why a quote of 25 different dense drawings takes 1.5 s here against 0.45 s on availability-fixes alone, why the worst health samples under load are 0.6 to 0.85 s against 0.09 to 0.13 s, and why a reorder shows 80 ms against 12 ms (section 7.5). Medians are unchanged and nobody is refused who was served before, except the sender of such a quote under load | Hash once when a part's measurements are stored and compare the stored hash, or hash in pieces inside the runner. It is price-integrity code, so it was not changed in this pass |
| 5 | Low | **With a rate table or "shipping included", opening a quote reads each of its parts to weigh it** | 119 to 125 ms held for a quote of 25 different dense drawings; 8 to 22 ms under the weight formula (the default) | Store the measured weight and longest side on the quote when it is priced |
| 6 | Low | **A database save rewrites the whole file**, so its time grows with the database (`stall-probe.js sizes`) | 5 ms at the 16 MB ceiling, 21 ms at 60 MB (section 7.3, note 1). Contained by the ceiling, not fixed | An append-only store; not for this release |
| 7 | Low | The quote of a cancelled or expired order keeps its parts' files until storage is under pressure | Not measured (housekeeping) | Let such a quote lapse like any draft |
| 8 | Low | A cancelled order can still be marked paid by hand while its files are only softly held | By design of the manual moves; the file check at checkout does not cover a manual move | Check the files when the owner marks a cancelled order paid |
| 9 | Low | A tax-exemption certificate attached to a firm quote that was declined stays on disk while the request row exists | One file per request, 25 MB at most | Remove it with the request's attachment after 14 days |
| 10 | Low | A material the owner switched off, renamed or added by hand is not carried over a catalogue upgrade (prices are) | Section 5 | Carry `active` the same way, if wanted |
| 11 | Low | Parts uploaded before ownership existed that are on no quote can only be priced by an admin after the upgrade | By design. Parts on a quote keep working: opening the quote gives the browser their keys (`migration.js`, section 7.3) | None needed: the customer uploads the file again |
| 12 | Low | `soup-wide` meshes (random triangles spanning the whole part) run to the 60-second limit before being sent to a person | 60 s of one parse worker per upload; charged against the sender's 180 s an hour | A better search tree in the geometry code; its own task |
| 13 | Info | **A hang inside Node 20.20.0 itself, seen in a test script, not in the server.** `scripts/dev/upgrade-proof.js` stopped in 7 of 20 runs with its server started and idle. Native backtrace: the script's main thread in `node::NodePlatform::DrainTasks`, two V8 background threads in `CollectionBarrier::AwaitCollectionBackground` (each waiting for the other). The script loads sql.js (WebAssembly) three times in its own process with nothing else pending | The script now keeps a timer pending: 30 of 30 runs complete. The server loads sql.js once at start-up, so it was started 300 times in a row: 300 of 300 answered the health check (median 1.0 s, worst 1.4 s) | Nothing further here. If a deploy ever starts, logs no error and never answers its health check, redeploy and report it: it would be this |
| 14 | Info | With tax on, every checkout creates a new Stripe Customer | Not built: one Customer per account | Listed in `docs/launch/tax-and-shipping.md`, section 7 |
| 15 | Info | Client `npm audit` reports 2 findings in `esbuild` and `vite`, the development server | Not in the production image; `npm audit --omit=dev` is 0 for server and client | Vite 8 upgrade, separately |

## 11. Owner decisions

Each is a choice only you can make. The recommendation is what I would do.

1. **Railway service size.** At 1 GB the site works, but once it has read one large model the very
   heaviest meshes are told "busy, try again" for as long as the service stays up (open item 3). At
   2 GB with `MEMORY_BUDGET_MB=2048` all three test files were read in both runs.
   **Recommend 2 GB.** Runbook step 3.
2. **Turnstile keys before the first deploy.** Not optional: the site does not start without both.
   Runbook "Before you start", part B. **Do this first.**
3. **Database ceiling.** Leave `DB_MAX_MB` at 16 unless the start-up log or Admin → System shows the
   database over half of it on the first day; then set it to about four times the size shown, at
   least 64. **Recommend: check in step 9, change only if told to.**
4. **Draft allowance.** One visitor or one account may hold 512 kB of unsaved quotes: about 180
   one-part quotes, 65 of 25 parts or 23 of 100 parts. Orders and requests are not counted.
   **Recommend: keep.**
5. **Shipping and tax at launch.** As merged, a customer is charged **$12.00 plus $2.50 per kilogram of
   parts, to any destination, with no size or weight limit, and no sales tax**. That is what the site did
   before. `docs/launch/tax-and-shipping.md` recommends option B (your own rate table, oversize and
   overweight orders to a firm quote, the buyer's carrier account and pickup on; Stripe Tax on once you
   are registered in Illinois). **Recommend: launch on the defaults only if you accept that a 4 ft by 8 ft
   routed sheet is charged about $12 plus weight; otherwise put your rates in the table and switch
   shipping to "table" before launch, and leave tax off until the Illinois and Stripe steps are done.**
6. **The "deleted after 7 days" sentence.** The home page says "purged on a schedule if you do not
   order" until you confirm the `file-retention` fact; confirming it as "7 days" would print "deleted
   after 7 days unless you order", which is no longer true for a saved quote (kept 30 days) or an open
   request. **Recommend: leave it unconfirmed.**
7. **The feature-count question in the geometry code** (section 6.1). Correcting it changes nothing
   that is sold today and would change sheet-metal prices if sheet metal is ever offered.
   **Recommend: leave it; correct it as part of offering sheet metal.**
8. **Open items 1, 2 and 4** (the places the one thread can still be held: up to about 0.8 s at
   checkout, about 0.3 s on a units change, and longer single delays under heavy load). All need
   deliberately heavy quotes; 1 and 2 need a signed-in, confirmed account and are rate-limited.
   **Recommend: launch with them, fix item 4 first afterwards.**
9. **Prices you changed by hand.** They are kept over the catalogue upgrade; Admin → Pricing lists
   which. Anything else you changed on a material or finish goes back to the default.
   **Recommend: write those down before the deploy, as the checklist says.**
10. **One more sentence on the "busy" message.** Today: "We are reading a lot of files right now and
    could not take this one yet. Nothing is wrong with your file: give it a minute and try again."
    Suggested addition: "If it keeps happening, email the file to quotes@straightedgemfg.com and a
    person quotes it." The wording was reviewed in the journey work, so it was not changed here.
    **Recommend: add it.**

## 12. Could not be verified here

- **Stripe.** No call was made to Stripe, live or test. Stripe Tax (the Customer, `automatic_tax`,
  the tax reported back) is exercised against a stand-in that adds 7 %. Before switching tax on:
  the four test-mode checkouts listed in `docs/launch/tax-and-shipping.md`, section 7.
- **Cloudflare Turnstile.** The real widget has not been run against the site; the tests use a
  stand-in. Runbook step 8 is the first real check.
- **Railway.** The Docker image was not built (no daemon here). Memory figures are from this
  sandbox (2 cores), not from a Railway instance. The start-up refusal without Turnstile keys is
  tested locally, not on Railway.
- **Node 20.20.2** exactly: the sandbox has 20.20.0.
- **The live database's size** against the 16 MB ceiling: runbook step 9 checks it on the day.
- **Email**: Resend was never called.
- **Under-load figures** are from four busy loops on a 2-core sandbox. They show how the site
  behaves when it gets a fraction of a core, not what Railway will give it.
- **Memory the process keeps** (section 6.2) was measured with this sandbox's C library. Whether the
  Railway image gives memory back sooner was not measured.
- **The accessibility scan** used axe-core 4.14.0 from the first pass's scratch folder; it is not a
  dependency of the repository.
