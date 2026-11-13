# Fixes for the independent re-review of the relaunch merge (2026-11-13)

Branch `relaunch-2026-11-12`. This answers `docs/security/rereview-relaunch-2026-11-12.md`, finding by
finding. Nothing here has been merged or deployed; the site stays offline until you approve.

## Running state (kept current while the work is in progress)

| Finding | State | Commit |
|---|---|---|
| F-01 units switched while an order is being made | fixed, measured | `ff2d8e1` |
| F-09 order list answers 500, admin panel blank | fixed, measured, checked in a browser | `4f0da75` |
| F-08 checkout holds the site; F-02 partial order after a hard kill; F-06 | fixed, measured | `682ee01` |
| F-12 unpaid orders pin the file store | fixed, measured at full scale | `a3dab95` |
| F-13 a units change re-prices every draft in one step | fixed, measured | `6158a22` |
| F-10, F-11 catalogue upgrade | fixed | `2e090b2`, `efe1c8b` |
| F-04 database file that cannot be read | fixed | `681c140` |
| F-05 paid, and nobody is told | fixed, measured | `8bf14bf` |
| F-07 refund before "completed" | fixed | `fdd876b` |
| F-03 shipping limits in every mode | fixed; code in `1f2d1e8` (saved as a work-in-progress commit by the coordinator when the session was cut off), tests and docs in `3a63579` | `1f2d1e8`, `3a63579` |
| Tests the audit flagged | kill-during-a-save case restored (`682ee01`); `reorder-block.js` runs the 100-line order too (`7c21810`) | |
| Final verification from a fresh clone | SEE THE LAST LINE OF THIS TABLE | |
| Verification status | in progress: section 4 is filled in as each run finishes | |

A figure that is not in this file has not been measured.

## 1. Bottom line

All thirteen findings are fixed in code, each with tests that fail on the code before the fix, and
each measured against the line the re-review set. One finding changes what the site sells (F-03: a
part over 48 in, a packed order over 50 lb, or an address outside the contiguous United States now
goes to a firm quote instead of being given a shipping price). No part price changed: the 300-quote
vetting comparison shows no difference in any price column.

Things I found and did not fix, because fixing them changes prices or is yours to decide, are in
section 6 and section 7. The most important: three settings on the material form (waste factor,
material class, stock forms) have never been saved by the database, so the site prices with its
built-in values whatever is typed there.

What cannot be shown in a sandbox is in section 8. Nothing here called Stripe, Resend, Turnstile or
Railway.

## 2. What was wrong and what changed, finding by finding

"Quiet" means nothing else running on this two-core machine. "Loaded" means four busy loops beside
the server (load average 3.5 to 4.8), the load the re-review used. Where the acceptance line says
"longest", the figure given is the worst single sample, not a median. Figures in this section are
from the runs made while each fix was written; section 4 has the runs on the final commit.

### F-01 (High): a drawing's units switched while an order is being made

**Root cause.** The units route asked "is this part on an order?", then waited for the file to be read
again in a worker, then replaced the stored measurements. A checkout that arrived in that wait made
its order from the old measurements, and the route then swapped the new ones in under it.

**What changed.** One rule, in one place (`server/services/partLock.js`): a part that is on an order
line, on a firm-quote request, or on a quote that is no longer a draft cannot have its units changed.
The route asks before the read and again in the same uninterrupted step as its write, so either the
order exists and the change is refused (409 `part-locked`, in words), or the new measurements are
stored before any later checkout prices the part. Every part carries a revision number that goes up
when its measurements are replaced; the number is part of what an order line records, and a paid
order whose part is at another revision is flagged for the owner (`part-changed`) and the shop
emailed. Order creation reads, prices, compares and writes in one step (see F-08).

**Measured.** The reviewer's `units-race.js`: holds at all five gaps. My
`tools/security/rereview-fixes/units-race-stress.js`, 200 attempts in four interleavings (units first,
checkout first, a firm-quote request, two units changes then checkout): 0 mismatched orders or
requests, quiet and loaded. A units change on a draft still works and the draft is priced again
(200 of 200).

**Tests.** `server/routes/unitsLock.test.js` (7 cases).

### F-09 (High): the order list answered 500 and the admin panel showed nothing

**Root cause.** The order list sent every order with every line and every line's part measurements.
Four unpaid orders of a detailed drawing made the answer larger than the server will send, for that
customer and for the owner. The admin panel loaded its seven sections as one request group, so one
failure blanked all of them.

**What changed.** The list is a page of summaries (50 by default, 100 at most) with a line count and
the totals in headers; an order's lines come from the single-order route, without part measurements.
The admin figures are SQL counts; parts and requests lists are bounded. The admin panel loads each
section by itself and shows "X did not load … The other tabs are not affected" with a Try again
button for the one that failed. One account may have 3 orders waiting for a card payment at once (5
per address) and start 8 unpaid checkouts a day (16 per address): `ORDERS_UNPAID_*` in
`.env.example` and the runbook; the refusal is in the message catalogue and shown at checkout.

**Measured.** The reviewer's `order-list-hold.js`: 200 for the customer and for the owner, 5 to 12 ms.
`order-list-worst.js` (the database filled to 12 MB with about 880 orders, the three unpaid orders one
account can now hold at 49 lines each): lists worst 28 ms, the work queue 65 ms. In a browser
(`scripts/e2e/admin-panel-load.mjs`, Playwright, 1360 px and 390 px): 58 of 58 checks, including
each section failing by itself.

**Tests.** `server/routes/orderList.test.js` (6 cases).

### F-08 (Medium): one checkout stopped the site; F-02 (Medium): part of an order after a hard kill; F-06 (Low)

**Root cause.** Checkout priced the whole quote again in one synchronous step and then wrote the
order, each line and the quote as separate saves; every save rewrites the whole database file. At
12 MB that held the one thread for seconds (F-08), and a process killed between two of the saves left
an order with some of its lines that could later be paid in full (F-02). The delivery choice of an
unpaid order was overwritten before Stripe was asked whether its open payment page had been paid
(F-06).

**What changed.** `database.transaction()`: an order, all its lines and its quote's new state are one
change and one save, or nothing. Checkout's pricing goes through the site's one pricing runner, in
pieces, charged to the sender; the final pass prices, compares and writes in one step, and the runner
starts again if a part or a price table changed while it was working. The answer is not sent until
the order is on disk. At start-up `server/services/orderRepair.js` finds orders from before this fix
with lines missing: an unpaid one is closed (it can never be handed a payment page; the buyer checks
out again), a paid one is flagged for the owner. An unpaid order's open payment page is closed or
settled at Stripe before anything on the order changes.

**Measured.** The reviewer's `checkout-hold.js` (100 lines; database 0.2, 6 and 12 MB), longest hold of
the health check: 43, 92 and 86 ms quiet (was 610, 2,183 and 4,229 ms); 183, 179 and 211 ms loaded
(was 3,918 ms at 12 MB). `checkout-worst.js` (four heavier quotes at 12.5 to 13.9 MB): worst 109 ms
quiet, 242 ms loaded; another visitor's one-line re-price median 10 to 38 ms quiet, 28 to 122 ms
loaded. `durability-kill.js` section C, 50 hard kills, twice: 0 partial orders (24 none and 26 whole;
20 none and 30 whole). Sections A and B: everything acknowledged was on disk.

**The one deliberate exception to "on disk before it is acknowledged"** is unchanged and was listed by
the reviewer under what held: a re-priced draft quote may wait up to 1.5 s for the file. An order, a
payment, an account or an admin edit never waits.

**Tests.** `server/routes/orderAtomic.test.js` (11), `server/services/pricingMemoStale.test.js` (6),
and the kill-during-a-save case in `server/ops/shutdown.test.js` (see section 3).

### F-12 (Medium): unpaid orders held the file store full

**Root cause.** A file on an unpaid order was kept for at least 48 hours, and for good when the order
had no payment page, and the clean-up never touched a file held that way. Accounts that pressed pay
and never paid filled the store.

**What changed.** An unpaid card order protects its files only while it can still be paid: until its
payment page closes (plus the ten minutes the expiry sweep allows), or for ten minutes when no page
was ever opened. The 48-hour floor and its setting are gone. When the store is still past the line
where visitors are turned away after everything else has been cleared, unpaid card orders are closed
from whoever holds the most first: the payment page is closed at Stripe first (an order that turns
out to be paid is settled; one Stripe cannot answer for is left alone), the buyer is emailed that
nothing was charged and how to order again, and the files go by the usual rules. Never touched: a
paid order's files, a signed-in customer's upload in its first hour, a phone order, a firm-quote
order, an order flagged for the owner. The same on the database side: under pressure the lines of
orders that closed unpaid over an hour ago are cleared (the order's own row stays, so a late payment
is still flagged, and such an order cannot be marked paid by hand).

**Measured.** The reviewer's `storage-pin-orders.js` at its 1:10 scale: after the clean-up the store
went from 97 % to 79 % and a visitor and a new customer both uploaded. My
`storage-pin-orders-full.js` at **full scale (1:1)**: a 2,048 MB store, 150 MB per account, three
unpaid orders per account; 14 accounts and 42 unpaid orders filled it to 100 % in 204 s; 43 s after
the flood it was at 75 %, a visitor and a new customer uploaded, 18 orders had been closed and 18
buyers emailed.

**Tests.** `server/services/unpaidOrdersPressure.test.js` (4), `unpaidOrderLines.test.js` (5).

### F-13 (Medium): a units change priced every saved quote in one step

**Root cause.** The units route priced every draft that held the part before answering.

**What changed.** The route stores the part and answers. The saved quotes are priced afterwards, one
at a time, through the pricing runner (in pieces) and on the sender's own pricing allowance; when
that is used up they are only marked. One sender's follow-up work queues behind itself. Units changes
are limited to 30 in ten minutes per address and per account (`UNITS_CHANGES_PER_CLIENT_10MIN`).
Nothing can be ordered at the old price in between: checkout prices again and compares (the part's
revision is in the fingerprint), and a firm-quote request made from a quote priced before a drawing
on it changed is refused in words (`quote-part-changed`).

**Measured.** The reviewer's `units-flip-hold.js` (25 drafts of 100 lines): longest hold 43 ms quiet
(was 592 to 753 ms), 130 ms loaded. My `units-flip-worst.js`, which keeps watching until the
follow-up work is over: quiet 79 ms (0.7 MB), 75 ms (12 MB), 126 and 101 ms with a 1,600-hole drawing;
loaded 146, 215 and 229 ms. Health median 2 to 47 ms throughout. Another visitor re-pricing was never
refused.

**Tests.** `server/routes/unitsRefresh.test.js` (7).

### F-10 (Medium) and F-11 (Low): the catalogue upgrade

**Root cause.** When the catalogue version went up every material and finish row was replaced and
only prices were put back; and a version marker that was missing or zero was read as "version 1",
which replaced everything.

**What changed.** Each row is merged field by field, by slug, against the whole catalogue of the
version the database was seeded from (`server/config/seedSnapshots/`: versions 2 and 3 read from git,
version 4 from the current file). A field that still holds the old default takes the new one;
anything else is yours and stays: a price, the on/off switch both ways, machinability, the thickness
list, grades, a name, a material you added, a material you deleted. A row whose slug left the
catalogue is not brought back, and what you had changed on it is reported. Every change kept and not
kept is one line in the start-up log, one row in the admin change log and one line on Admin →
Pricing (checked in a browser at both widths). The upgrade is one database change. A marker that is
not a whole number from 1 to the current version (or a rules row that is gone) with catalogue rows
present replaces nothing and adds nothing; that is said loudly in the log, recorded and shown on
Admin → Pricing.

**Measured.** The reviewer's `catalogue-upgrade.js`: 22 held, 0 findings (was 8 findings).
`scripts/dev/upgrade-proof.js` on the database written by origin/master's code: 30 of 30, and no value
that code stored is mistaken for a change made by hand.

**Tests.** `server/config/seedCarry.test.js` (21 cases).

### F-04 (Medium): a database file that cannot be read

**Root cause.** A start-up failure was logged and the server carried on; a zero-length file was opened
as a new empty database and written over; the health check answered "ok" without looking.

**What changed.** A file that exists is checked before anything is opened: not empty, a SQLite file,
integrity check "ok". If not, nothing is opened or written and the start stops with one line that
says why. The health check answers 503 unless the database is open and answers. No file at all still
makes a new one (a first start), and in production that is said loudly with what to check.

**Measured.** `server/models/databaseOpen.test.js` on the real server in production mode: an empty
file, the first third of a file, bytes that are not a database, a whole file with a damaged page, and
a 60-byte stub are each refused with exit code 1 and one FATAL line, and the file is byte for byte
what it was. The reviewer's `durability-kill.js` section E: all three damaged files refused. That a
hard kill inside a save cannot leave an empty or short file: `shutdown.test.js`, 12 kills.

### F-05 (Low): paid, and nobody is told

**Root cause.** The payment was written and marked handled, and the two emails were sent after it from
memory. A kill in between lost them, and Stripe's retry was answered "duplicate".

**What changed.** Applying a payment is one database change that includes a row for each email now
owed. They are sent after it; a row is closed only when the mail provider has taken the message. What
is still owed is sent when the event is delivered again, when the return page reports the payment, at
start-up, and every five minutes; a refused send waits and is given up, in the log, after a day.

**Measured.** `tools/security/rereview-fixes/paid-mail-kill.js`, 40 hard kills at a random moment in
the webhook, exact counts. Same event delivered again: 0 orders untold, 38 told once, 2 told twice.
Nothing delivered again (start-up only): 0 untold, 32 once, 8 twice. The reviewer's section D, 30
kills: 0 paid orders with nobody emailed (was 5 of 8 and 7 of 8).

**About "twice".** A kill after the message has gone and before that reaches the disk sends it again.
The request to the mail provider carries an Idempotency-Key (the row's id) so that the provider drops
the repeat; the test server has no provider, so the repeats above are what the key is for, and
whether Resend honours it is in section 8.

**Tests.** `server/services/owedEmails.test.js` (8).

### F-06 (Low)

Fixed with F-08: `money-attacks.js` section 2 now shows the pickup payment settled and no flag.

### F-07 (Low): refund before "completed"

**Root cause.** A full refund delivered before the payment's own event was stored on a waiting order;
the payment then made the order "paid" and left it in the work queue.

**What changed.** When the payment is applied and the order already carries a refund of the whole
amount, it goes to "refunded" in the same change. The buyer is not sent a confirmation for it.

**Tests.** `server/services/refundBeforePaid.test.js` (4): both orders of events compared field by
field, full and part refunds, replays.

### F-03 (Medium, business): what the default shipping rule sold

**Root cause.** The default rule (weight formula) had no size, weight or destination limit, and the
country was free text.

**What changed.** In every mode an order is given no shipping price online when a part is longer than
`shippingOversizeLongestIn` (48 in), the packed order is heavier than `shippingMaxParcelLb` (50 lb),
its size or weight cannot be worked out, or the address is outside the contiguous United States. These
are the rate table's two settings and its rule, with its words, and the same way on: a firm quote.
**The $12.00 and the $2.50 a kilogram are unchanged, and no part price is touched**; an order inside
the limits is charged to the cent what it was. The country is a two-letter code or it is refused in
words.

**Which orders now go to a firm quote** (the reviewer's `shipping-exposure.js`, run before and after):

| Order | Before | After |
|---|---|---|
| 1 sheet 58 x 94 in, any of the four routed plastics, any thickness (16 rows) | sold: parts $186.75 to $2,181.44 with shipping $25.63 to $321.12 | firm quote (longest side) |
| 1 strip 6 x 94 in (16 rows) | sold: shipping $13.41 to $43.98 | firm quote (longest side) |
| 1 sheet 48 x 48 in at 1/2 in or 1 in (50 to 115 lb) | sold: shipping $68.17 to $142.63 | firm quote (packed weight) |
| 1 sheet 48 x 48 in at 1/16 in (5 to 7 lb) | sold: shipping $17.76 to $20.23 | **still sold, same price and same shipping** (48 in is the limit, not over it) |
| 1 sheet 24 x 48 in up to about 40 lb | sold | still sold, same figures |
| many sheets (50 or 100 at once, 250 to 800 lb) | sold: shipping $300 to $926 | firm quote (packed weight); the most that is still sold is 5 sheets 48 x 48 in at 1/16 in (25 to 36 lb, shipping $40.80 to $53.14) |
| any priced order to Honolulu or to Germany | accepted (200) at the same shipping | refused (409) with the reason and the way to a firm quote |

**The vetting set.** 300 quotes against the commit before this work: no price column differs in any
row. 64 rows gain the gate reason `shipping-freight`. 55 of them were already going to a firm quote
for another reason (quantity, order value, a DFM failure, a turned part). 9 are new: all are orders
of 25 or 100 pieces (trays, star wheels, bracket blocks and fixture plates) whose packed weight is
over 50 lb.

**Tests.** `server/services/shipping.test.js` (26 checks), `server/routes/shippingLimits.test.js` (7).

## 3. The two tests the audit flagged

- **A hard kill while the database is being saved.** Restored in `server/ops/shutdown.test.js`: the
  process is killed with SIGKILL at twelve delays during back-to-back saves of a 12 MB database; every
  time the file is whole, passes SQLite's integrity check and holds a completed write, and the test
  fails if no kill landed inside a save.
- **`reorder-block.js`** now runs two orders and reports both: the dense drawing at as many lines as
  checkout allows (3 lines, $4,102.19) and 100 lines of a printed cube ($1,654.36), the most lines an
  order can have. Dense: 68 to 88 ms a reorder, health check worst 52 ms, four at once worst 176 ms.
  100 lines: 39 to 54 ms a reorder, health worst 42 ms, four at once worst 54 ms.

## 4. Verification on the final commit

VERIFICATION-TABLE-GOES-HERE

## 5. Judgment calls

1. **F-12, who is closed.** Only card orders that are waiting, not flagged, not from a firm quote and
   not taken by phone are ever closed to make room, heaviest holder first, and only until the store is
   five points under the line where the clean-up starts. An order whose payment page Stripe cannot
   confirm closed is left alone: an order is never paid for after its file has gone.
2. **F-12, the database side.** Rather than delete orders that closed unpaid, only their lines are
   cleared and the order row stays, so a payment that arrives late is still flagged for you.
3. **F-13, answer first.** The units answer no longer waits for the saved quotes. For a second or
   two (up to about 25 s for the heaviest case under load) a saved quote can show the old price; it
   cannot be ordered or sent as a request at that price.
4. **F-10, what counts as yours.** A material you deleted stays deleted and one you added is kept.
   A row that existed before keeps its id. When the version cannot be established the lists are left
   alone AND the marker is set to the current version, so the next real upgrade treats what is there
   as yours.
5. **F-04 applies in every mode**, not only production: a development database that cannot be read
   is not overwritten either.
6. **F-05, at least once.** I chose "a message may, rarely, go twice" over "a message may, rarely,
   not go": see F-05 above. With no mail provider configured the row is closed (the message is in the
   log, as before) so that old confirmations are not sent the day a key is added.
7. **F-07.** The buyer gets no "order confirmed" email for an order refunded before its payment was
   reported; the shop gets the refund notice.
8. **F-03.** Exactly 48 in is inside the limit. The packed weight (parts plus the packaging allowance
   you set) is what is held to 50 lb, as in the rate table.
9. **Ceilings on unpaid orders** (3 at once and 8 new a day per account; 5 and 16 per address) and
   on units changes (30 in ten minutes) are my choice of numbers. They are settings.
10. **`units-race-stress.js` has four interleavings, not five.** The fifth I had noted (units first,
    then a checkout carrying the old total) is covered by a unit test instead
    (`unitsRefresh.test.js`, "checkout in the gap").

## 6. Changes to tests and scripts that existed before, each with its reason

| File | What changed | Why |
|---|---|---|
| `server/models/partPayloads.test.js` | one assertion | It asserted that the order list carried every line's part measurements; carrying them was F-09 |
| `server/routes/relaunchIntegration.test.js` | two cases | A source-text check follows the checkout code to its new function; a counter of pricing calls counts final passes only (checkout now prices in pieces) |
| `server/services/rowRetention.test.js` | one case | It asserted the 48-hour rule that F-12 removes |
| `server/routes/priceIntegrity.test.js`, `unitsLock.test.js` | one line each | They read a saved quote in the same tick as the units answer; they now wait for the follow-up work (F-13) |
| `server/config/seedCarry.test.js` | rewritten and extended | Three cases asserted what F-10 and F-11 remove: only prices carried, a hand-added row deleted, an unknown version replaces everything |
| `server/services/shipping.test.js` | three cases | They asserted that the formula never goes to a firm quote and has no destination rule: F-03 |
| `server/ops/shutdown.test.js` | one case added | The kill-during-a-save case the audit said was missing |
| `server/testSupport/harness.js` | the unpaid-order ceilings are lifted for suites unless asked for | Most suites place many unpaid orders from one account |
| `server/testSupport/liveServer.js` | keeps a folder the caller handed in when a start is refused; skips an outbox file a kill cut short | To look at what a refused start left on disk (F-04); the reader stopped the reviewer's script once in 30 kill rounds |
| `tools/security/review-uploads/preload-stubs.js` (the local Stripe stand-in) | session ids unique per process; `checkout.sessions.expire` added | It handed out the same id after a restart (real Stripe never does; the server used to swallow the failed insert). It had no way to close a payment page, which real Stripe has, so nothing that depends on closing one could be shown |
| `scripts/dev/upgrade-proof.js` | extended for F-10; the fixture's unpaid orders are given a recent date | Since 2026-11-13 01:17 UTC the 24-hour payment window closed the fixture's two unpaid orders at the first start, and two checks failed on the calendar |
| `tools/security/rereview-availability/reorder-block.js` | runs a second, 100-line order | The audit's point |
| `tools/security/rereview-availability/vetting-compare.js` | sums up every differing row | It showed only the first three |

None of the reviewer's scripts in `tools/security/rereview-relaunch/` was edited.

**Changed outside the brief**, found on the way: the work queue was never sorted in production (the
sort line had been joined to a comment); the two older "re-seed" checks looked at the first material
only, so one material priced only through "cost per kg" at the top of the list would have wiped the
catalogue; a firm-quote request can no longer be made from a quote priced before its drawing changed
(a consequence of F-13); wording for "the order list did not load".

## 7. Still open, and what needs your decision

**Open (not fixed here):**

1. **Three material settings are not saved.** Waste factor, material class and stock forms are on the
   material form and in the catalogue file, but the database has no column for them: nothing typed
   there is stored, and pricing uses its built-in values (waste 15 % for machining, none for routing;
   class worked out from the name). Storing them would make the catalogue's own figures take effect
   and change prices, so I stopped and am reporting it.
2. **Large, light parts inside the limits** are still charged by weight alone: a 48 x 48 in sheet at
   1/16 in ships for $17.76 to $20.23, and a carrier adds a large-package charge to that. The limit is
   your setting.
3. **The checkout page still lists Canada and Mexico** in its country list. Choosing one now ends in
   "we confirm freight first" with the link to a firm quote. I did not change the page.
4. **A message can go twice** after a kill in a window of a few milliseconds (F-05), unless the mail
   provider drops the repeat.
5. **A re-priced draft may wait 1.5 s for the file** (unchanged, by design).
6. Everything in the re-review's "What you must test by hand" still stands.

**Decisions, with my recommendation:**

1. **The parcel limits under the default rule: 48 in and 50 lb.** Keep them for launch. They are the
   numbers the rate table already had. If your freight quotes show the formula covers heavier parcels,
   raise "Heaviest order we ship by parcel" under Pricing → Checkout; nine of the 300 vetting orders
   (25 or 100 pieces) are affected.
2. **Waste factor, material class, stock forms.** Leave as they are for launch; afterwards decide
   whether they should take effect, with a vetting run that shows every price that moves.
3. **Canada and Mexico in the country list.** Remove them until you ship there at a set price (a
   small change to one page), or leave them as a way into a firm quote.
4. **The ceilings on unpaid orders and on units changes.** Keep.
5. **On the first real order,** resend the "checkout.session.completed" event from the Stripe
   dashboard twice: the order stays paid and you and the buyer have one email each.

## 8. Not verified in the sandbox

- Anything at Stripe, Resend, Turnstile or Railway. In particular: that Stripe refuses payment on a
  page the site has expired (F-06, F-12 rely on it; the stand-ins assume it), and that Resend drops a
  message repeated with the same Idempotency-Key (F-05).
- A real out-of-memory kill; SIGKILL stands in for it.
- Loaded figures are four busy loops on two cores: the shape, not Railway's numbers.
- Carrier prices. F-03 routes orders by size, weight and destination; what freight costs is yours.
- The WIP commit `1f2d1e8` was pushed by the coordinator, not by me; I pushed nothing.
