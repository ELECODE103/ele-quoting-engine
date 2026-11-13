# Independent re-review of the relaunch merge

**STATE OF THIS DOCUMENT: IN PROGRESS.** Areas 1 (money), 2 (access), 3 (durability), 6 (catalogue), 7 (what a
customer sees) and 8 (the rest of the diff) are written up below. Area 5 (availability) is partly written;
area 4 (the changed-tests audit) is not finished. The verdict line will change when they are.

2026-11-12. Reviewer: independent (did not write any of the code under review). Change reviewed:
`git diff 97f57f3..dce1e38` on `relaunch-2026-11-12` (101 commits). Machine: 2 cores, 7.8 GB, Node
v20.20.0 (`/opt/node20/bin/node`) for every run. Nothing was pushed, no product code was changed, no
call left the machine for Stripe, Resend, Turnstile or Railway.

Every script named below is in `tools/security/rereview-relaunch/` and runs with one command from the
repository root, against a fresh server it starts itself:

```
env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost,127.0.0.1 /opt/node20/bin/node tools/security/rereview-relaunch/<script>.js
```

A script exits 1 when it prints a `FINDING` line.

## Verdict (provisional, three of eight areas done)

**Not yet. Yes with conditions is reachable; the conditions so far are F-01 and F-03 below.**

## Findings so far

| # | Severity | What | Proof |
|---|---|---|---|
| F-01 | **High** | A DXF's units can be switched while its order is being made: the order is paid at the millimetre price and the shop is left holding the same drawing at inch size (25.4 times larger). The order carries no flag; only one line on the printed traveler says so | `units-race.js` |
| F-02 | **Medium** | A hard kill (out-of-memory, host crash) during checkout leaves an order on disk with only some of its lines. The buyer comes back, is charged the full total, and the paid order lists fewer parts than were paid for | `durability-kill.js` section C |
| F-03 | **Medium (business)** | The default shipping rule sells a 58 x 94 inch sheet with $25.63 shipping, to any state or country. That sheet cannot go by parcel at all | `shipping-exposure.js` |
| F-04 | **Medium** | The server starts, and answers its health check "ok", on a database file it cannot read; a zero-length file is silently replaced by a new empty database. Not introduced by this merge | `durability-kill.js` section E |
| F-05 | Low | A hard kill during the "paid" webhook leaves the order paid and nobody emailed: not the buyer, not the shop. Stripe's retry is answered "already seen" | `durability-kill.js` section D |
| F-06 | Low | Changing the delivery choice in a second tab overwrites the order before Stripe is asked whether the first tab's payment went through; a correct payment is then flagged as a wrong amount | `money-attacks.js` section 2 |
| F-07 | Low | A refund event that arrives before the "completed" event leaves a fully refunded order in "paid". Not introduced by this merge | `money-attacks.js` section 4 |
| F-08 | **Medium** | One press of "pay" on a 100-line quote stops the whole site for 0.6 s on an empty database, 2.2 s at 6 MB and 4.2 s at 12 MB (the ceiling is 16 MB). The author's figure (0.51 to 0.59 s) is the empty-database case | `checkout-hold.js` |
| F-10 | **Medium** | The catalogue upgrade switches back ON every material and finish the owner had switched off, and resets machinability, waste factor, thickness lists and grades, without a line in the log for any of them | `catalogue-upgrade.js` |
| F-11 | Low | A database whose version marker is missing, null, 0 or negative is treated as version 1: at the next start every material and finish is replaced and no hand-edited price is kept | `catalogue-upgrade.js` section 4 |

## F-01 (High): the units of a drawing can be changed under an order while it is being made

**Where.** `server/routes/api.js` lines 468 to 512 (`POST /api/parts/:partId/units`) and
`server/security/index.js` lines 53 to 70 (`partEditGate`). Both ask "is this part on an order or a
request?" (api.js line 479) and then the route **waits** for the file to be read again in a worker
(line 490, `await parsePool.run(...)`) before it replaces the stored geometry (line 502). Nothing is
asked again after the wait.

**What happens.** A buyer uploads a drawing made in inches, tells the site it is in millimetres and gets
the small price. They send "units: inches" and, a few milliseconds behind it, the checkout for the
millimetre quote. Checkout runs in one piece while the units request is waiting on the worker: it prices
the part as stored (millimetres), finds the stored total correct, makes the order and locks the part.
The worker then returns and line 502 swaps in the inch geometry. The buyer pays the millimetre price.

**Measured** (`units-race.js`, three runs, three out of three; a 20 x 20 plate in 1 inch acrylic, 2 pieces):

| Holes in the drawing | A units change takes | Gap between the two requests | Paid | Same drawing in inches prices at | Stored part after payment |
|---|---|---|---|---|---|
| 600 | 144 ms | 15 ms | $412.25 | $848.90 | 508 x 508 mm |
| 200 | 76 ms | 5 ms | $214.93 | $609.04 | 508 x 508 mm |
| 50 | 38 ms | 2 ms | $140.94 | $519.08 | 508 x 508 mm |

In each run the order is `paid`, has no attention flag, and the shop got no email about it. The order
line was snapshotted as 20 x 20 mm; the part record now says 508 x 508 mm. The one thing that catches it
is the job traveler, which compares the two and prints "PART FILE CHANGED SINCE IT WAS PRICED - do not
cut from it; confirm with customer" (`client/src/utils/orderLineCore.js` line 69). So this is not a
silent loss if that line is read every time. It is rated High because it reopens the units-swap hole the
payments review closed, it needs no special access (any confirmed account), it works three times out of
three with one command, and the buyer ends up holding a paid order whose own record shows the large part.
If you would always act on the traveler line, read it as Medium.

The race exists at `97f57f3` too (the route was already asynchronous there); the merge did not introduce
it and did not close it. The author's `geometry-price.js units` check changes units and then checks out,
one after the other, which is the case that holds.

After the order exists a new units request is refused (409 `part-locked`): only the window is open.

**What a fix must achieve.** The stored geometry of a part must not change once any order or request
refers to it, whichever request started first. The check that the part is free has to be made again in
the same uninterrupted step as the write, after the file has been read; and an order must be marked for
the owner (not only on the traveler) if its part ever differs from what was priced. The same holds for a
firm-quote request sent during the wait.

## F-02 (Medium): a partial order after a hard kill, then paid in full

**Where.** `server/routes/orders.js` lines 277 to 347. The order row is inserted (line 277), then each
line is inserted one at a time (line 320), then the quote is marked `ordered` (line 347). Every one of
those inserts exports the whole database and writes it to disk with two flushes
(`server/models/SqliteDB.js` line 328 → `saveToDisk` → `writeDurably`). They are not grouped
(`database.batch`), so the disk holds every intermediate state.

**What happens.** If the process is killed hard between two of those writes (SIGKILL: Railway's
out-of-memory kill, a host fault; not a deploy, which lets the step finish), the disk holds an order with
0 to N-1 of its N lines and a quote still marked `draft`. After the restart the buyer presses pay again:
`orders.js` line 127 finds the unpaid order and resumes it. The amounts are brought up to date to the full
total, the lines are not re-made (line 257 reads whatever lines exist), and Stripe is asked for the full
amount under the name "Order - 19 parts".

**Measured** (`RR_ONLY=C durability-kill.js 8 20`: a 20-line quote, killed 4 to 124 ms after the request
is sent, 8 rounds, three separate runs): a partial order was left on disk in 6 of 8 rounds each time (0,
4, 7, 7, 8, 9, 11, 11, 12, 18, 19, 19 of 20 lines among them). In two of the three runs the buyer's second
checkout was followed through to payment: **paid $4,403.88 in full; the paid order holds 7 of 20 lines in
one run and 19 of 20 in the other.** Nothing flags it. The window was about 100 ms for 20 lines on a
database of 0.2 MB; each line costs one whole-file save, so it grows with the number of lines (up to 100)
and with the size of the database (the author's own figure: 5 ms a save at 16 MB, plus the flushes).

It needs a crash inside that window, so it will be rare. When it happens the customer has paid for parts
the order, the traveler and the packing slip do not list.

The same writes are why checkout holds the one thread: 100 lines are 100 or more full saves in one step
(see the availability section).

**What a fix must achieve.** An order and all of its lines, the quote's new status and the part claims
must reach the disk together or not at all. An order whose lines do not match its quote must never be
handed a payment page.

## F-03 (Medium, a business finding): what the default shipping rule sells

**Where.** `server/services/shipping.js` line 192 to 196 (the `formula` mode: `shippingBaseRate +
kg x shippingPerKg`, "No size or destination rule") and `atDestination`, line 320 (the formula has no
destination rule). The defaults are $12.00 and $2.50 per kg (`server/config/ruleSchema.js` lines 78, 79).

**What the instant quote will sell at the defaults** (`shipping-exposure.js`, and the size probe quoted
in the same script's header; every row was priced by the site, not sent to a firm quote, and the checkout
was taken to a Honolulu address where shown):

| Order | Parts | Shipping charged | Weight | Why it matters |
|---|---|---|---|---|
| 1 sheet 58 x 94 in, 1/16 in HDPE | $186.75 | **$25.63** | 12 lb | Length plus girth is about 212 in. UPS and FedEx Ground stop at 165 in and 108 in long. It can only go by freight |
| 1 sheet 58 x 94 in, 1/8 in acrylic | $376.01 | **$45.49** | 30 lb | The same, and acrylic that size needs a crate |
| 1 strip 6 x 94 in, 1/16 in HDPE | $117.73 | **$13.41** | 1.2 lb | Under the parcel limits but over 96 in: carriers add a large-package or additional-handling charge |
| 100 sheets 48 x 48 in, 1/16 in HDPE | $4,839.19 | $588.03 | 508 lb | A pallet. Here the per-kg rate roughly covers freight |
| 10 sheets 48 x 48 in, 1 in HDPE | $4,880.02 | $926.44 | 806 lb | A pallet. Covered |
| 10 sheets 24 x 48 in, 1 in acrylic | $4,450.04 | $573.73 | 495 lb | A pallet. Covered |

A full 48 x 96 sheet is **not** sold online: the router-bed check sends it to a firm quote. The author's
example ("a 4 ft by 8 ft routed sheet is charged about $12 plus weight") is therefore not the worst case;
the worst case is the sheet just inside the bed, 58 x 94 in, which is larger.

**The exposure, in words.** The rule charges by weight alone. Heavy orders are charged enough or more
than enough ($2.50 a kg is about $1.13 a pound). The loss is on **large, light** parts: one thin sheet
over about 4 ft on a side is charged $15 to $45 and has to travel as freight. I did not call a carrier.
My working assumption, which you should check against your own freight quotes, is $250 to $600 for a
single oversize flat sheet by LTL freight inside the contiguous states, more with a residential or
lift-gate delivery, and much more to Hawaii, Alaska or abroad. On that assumption **each such order
loses roughly $200 to $550 on a sale of $120 to $380**, and nothing limits how many are placed.

Destination: with the formula, checkout accepted the same orders to Honolulu (status 200, same shipping)
and the country field is free text of up to five characters, so an order to another country is charged
the same $12 plus weight.

**What a fix must achieve.** Before launch, no order may be given a shipping price online that the shop
cannot ship for roughly that price: a longest-side limit, a weight limit and a destination rule have to
apply in whatever mode is the default. The rate-table mode already has all three (`shippingOversizeLongestIn`
48 in, `shippingMaxParcelLb` 50 lb, contiguous states only) and sends the rest to a firm quote; it held
in every test here. This is the author's decision 5; I am saying it is a launch condition, not a
preference.

## F-04 (Medium, not from this merge): starting on a database that cannot be read

**Where.** `server/models/database.js` lines 235 to 240 and 370 to 373: a start-up failure is logged and
the server carries on ("resolve anyway so the app doesn't hang"). `server/index.js` line 113: the health
check answers `ok` without looking at the database.

**Measured** (`RR_ONLY=E durability-kill.js`): with the good database replaced by

| The file at start-up | What the server did |
|---|---|
| a zero-length file | started, health 200, **wrote a new empty database over it** (0 accounts) |
| the first third of the real file | started, health 200, rewrote the file; it is still malformed |
| bytes that are not a database | started, health 200, file untouched; every request that needs data fails |

The server's own saves cannot produce such a file: `writeDurably` writes a temporary file, flushes it
and renames it, and a half-written `quoting.db.tmp` beside a good database was ignored (held, same
section). This is about a volume that comes up damaged, empty or not mounted: Railway would see a
healthy service, the site would look alive with no accounts and no orders, and the one-time admin setup
would be open again to whoever holds `ADMIN_SETUP_CODE` if it was left in the variables.

**What a fix must achieve.** A database file that exists and cannot be read must stop the start with a
clear line in the log and leave the file exactly as it was. The health check must fail when the database
is not usable. A production start that finds no database where one is expected should say so loudly.

## F-05 (Low): paid, and nobody is told

**Where.** `server/services/orderLifecycle.js` lines 438 to 448 and 487 to 491. `applySession` marks the
order paid and records the event as handled (`notified: true`) in one step; the confirmation to the buyer
and the new-order notice to the shop are sent after it (line 491). `server/routes/stripeWebhook.js`
line 101 answers a retried event "duplicate" when its id is on record, and a replay sends nothing.

**Measured** (`RR_ONLY=D durability-kill.js 8`): control without a kill: buyer 1 email, shop 1. Killed 1
to 26 ms into the webhook, then the same event sent again as Stripe does: every order was paid after the
retry (no payment lost, none flagged), and in **5 of 8** rounds neither email was ever written. With the
real mail provider the window is the length of its API call, which is longer than here.

The order is in the admin list as paid, so it is found by looking; it is not found by waiting for the
email. A deploy does not trigger this (in-flight requests are given time to finish, tested by the
author's `shutdown.test.js`).

**What a fix must achieve.** "The buyer and the shop were told" must be remembered separately from "the
order is paid", and whatever was not sent must be sent when the event comes again or at the next start.

## F-06 (Low): the delivery choice is overwritten before Stripe is asked about the first payment

**Where.** `server/routes/orders.js` lines 250 to 259: the unpaid order's delivery choice and amounts are
rewritten first, then `checkoutGuard.sessionFor` looks at the order's open session
(`orderLifecycle.js` lines 269 to 274) and only there learns it was already paid.

**Measured** (`money-attacks.js` section 2): pickup chosen and paid in tab 1 ($273.32); before the
webhook lands, tab 2 presses pay with "ship" selected. The order becomes a ship order at $285.43, the
$273.32 payment is flagged `payment-mismatch`, the order stays unpaid. The buyer is sent to their order
page, not to a second payment page, so nobody pays twice. No money is lost; the owner has a correct
payment to sort out by hand, on an order that no longer says what the buyer chose.

The dangerous direction holds: an order is never released at the cheaper choice's price (same section;
a closed pickup session that is paid late does not release the ship order).

**What a fix must achieve.** An unpaid order's open session must be checked at Stripe before anything
about the order is changed.

## F-07 (Low, not from this merge): refund before "completed"

`money-attacks.js` section 4: a `charge.refunded` for the full amount delivered before
`checkout.session.completed` leaves the order `paid` with `refundedAmount` equal to the total and no
flag. In the usual order of events the same refund moves the order to `refunded`
(`orderLifecycle.js` line 693). Stripe does not promise delivery order. A refund is something the owner
does himself, so he knows; the order would still sit in the work queue.

## What held (areas 1 to 3)

Every line is a run of the named script on this machine.

**Money** (`money-attacks.js`: 62 checks held, 0 findings)

- 48 combinations of shipping mode (weight formula, rate table, included, free over a threshold) x tax
  off / Stripe Tax on x ship / pickup / buyer's carrier account x paperwork on / off. In every one: the
  total the page is told = the order total = the sum of the lines Stripe is asked for = the expected
  charge; subtotal + lead-time fee + shipping + paperwork add up to the total to the cent; a confirmed
  total 2 cents away is refused (409) and asks the buyer; the payment settles the order as paid with the
  stand-in's 7 % tax stored and added to the total; no flag.
- Two tabs: pickup then ship is one order; the pickup session is closed at Stripe; if it is paid anyway
  the ship order is not released and is flagged.
- A hand-built request with amounts, weights, shipping mode, tax mode and an exemption flag changes
  nothing. A delivery choice that is switched off is refused.
- A lapsed order paid late is flagged `late-payment`, not lost and not released. A replayed event changes
  nothing.
- A 100 % discount on a session opened with promotion codes off does not release the order. A payment $5
  short whose report labels $5 of it as tax is not accepted (the tax is taken out before comparing, and
  what is left must equal the expected charge).
- Stored line weights tampered with (zero, negative, missing, absurd): checkout prices again and charges
  the real total in both the formula and the table mode.

**The four rewritten tax-shipping cases** were read against the originals (`git show
c7221a0:server/routes/taxShipping.test.js`): see the changed-tests audit.

**Access** (`access-matrix.js`: 25 held, 0 findings; `route-inventory.js`: 0 of 50 owner routes without
`authenticate` then `requireAdmin`)

- A guest and another account, knowing every id: another account's part and a visitor's part cannot be
  previewed, measured, priced, have their units changed or be downloaded, with no key, with another
  part's key, or (for an account's part) with its own edit key. An account's quote cannot be read,
  reopened, re-priced, checked out, or have its drawing or tax certificate replaced or removed. An
  account's order cannot be viewed, reordered, confirmed, or have its drawing, certificate, traveler or
  documents fetched. A visitor's request shows its status only; no contact detail, no drawing.
- `GET /api/admin/storage`, the draft purge, the request deletes, the catalogue-upgrade report, the
  shipping preview, the backups: 401 for a guest, 403 for an account. An admin cookie without the CSRF
  token is refused on an unsafe request. A purge is written to the change log.
- By design, and worth knowing: a quote made without an account is opened by its id alone, and anyone
  who learns that id can order it, after which the visitor's own key no longer opens the part
  (`access-matrix.js`, last two lines). The id is 122 random bits; it is only a risk if a visitor shares
  the link.

**Durability** (`durability-kill.js` sections A, B, E)

- Killed the instant the answer arrives, the disk holds: a new quote; an order with all its lines, its
  quote marked ordered and its payment session; a settled payment; a new account with its email
  confirmed; an admin price-rule edit and the owner's account. SQLite's integrity check passed after
  every kill in the run (about 30 kills).
- A re-priced draft killed at once: the last re-price is lost (the disk held $206.86, the browser had
  been told $396.19), and only that. A re-price followed by a checkout and a kill: both are on disk.
- A half-written `quoting.db.tmp` beside a good database: the good one is loaded.
- Read, not run: `deferred()` is used in four places, all of them drafts (`api.js` 777 and 1007,
  `quotesStore.js` 212, `quoteGuards.js` 151, `storagePressure.js` 165); none wraps an order, a payment,
  an account or an admin edit, and any ordinary write takes waiting changes to disk with it
  (`database.js` `saveToDisk`).

## The suite

`npm test` on Node v20.20.0 in this worktree after `npm ci`: **88 of 88 suites passed** (run while other
scripts were using the machine).

## F-08 (Medium): one checkout stops the site for seconds once the database has grown

**Where.** `server/routes/orders.js` lines 208 to 347: the re-pricing and every write of the order are
one uninterrupted step, and each `ordersDB.insert`, `orderItemsDB.insert`, part claim and quote update is
a separate save of the whole database file (`server/models/SqliteDB.js` line 328), each with two flushes.
A 100-line order is more than 100 whole-file saves in that one step. Same cause as F-02.

**Measured** (`checkout-hold.js 100 0,6,12`: one confirmed account, one press of "pay", quiet machine;
the quote is 100 lines of a 12 mm cube in the first printing material, $1,654.36, open for checkout; the
database is padded while the server is stopped, to stand in for a shop that has been running a while):

| Database file | Checkout took | Longest wait of another visitor's health request |
|---|---|---|
| 0.2 MB (new) | 609 ms | 610 ms |
| 6.1 MB | 2,183 ms | 2,183 ms |
| 12.1 MB | 4,248 ms | 4,229 ms |

With 25 lines of a machined cube ($4,831.65): 194 ms, 511 ms and 992 ms at the same three sizes.
Nothing dense or clever is needed; the part is a cube. The author's open item 1 gives 0.51 to 0.59 s for
a 100-line quote. That is the first row: a new database. The default ceiling is 16 MB and the runbook
tells you to raise it if the database passes half of it, so 6 and 12 MB are sizes the site is expected to
reach. The time spent writing is not charged to the sender's pricing allowance (`orders.js` line 213
charges the pricing only), so the limit is the 12 checkouts per account per 15 minutes: at 12 MB one
account can stop the site for about 50 seconds in every 15 minutes, in 4-second pieces, and each further
account adds the same. During each piece no page, price or payment answer is served to anyone.

An ordinary order is not affected much: about nine saves for a 5-line order, well under half a second at
12 MB.

**What a fix must achieve.** The time one checkout holds the thread must not grow with the number of
lines times the size of the database: an order and its lines have to be one write. Whatever time
remains must be charged to the sender.

## F-10 (Medium): the catalogue upgrade undoes what the owner switched off

**Where.** `server/config/seed.js` lines 63 to 69 delete every material, finish and process row when the
catalogue version goes up; `server/config/seedCarry.js` puts back prices only
(`server/config/seedHistory.js` line 132: `pricePerKg`, `pricePerCm3`, `pricePerPart`, `pricePerSqIn`).

**Measured** (`catalogue-upgrade.js`, a version-3 database edited the way the owner edits it, then the
real seed):

| What the owner had done | After the upgrade | Said in the log |
|---|---|---|
| Changed a price (mild steel to $99.50 a kg; a finish) | kept | yes |
| Changed a price on a resin that leaves the catalogue | not brought back | yes |
| Switched a material off (stainless 304) | **back on** | no |
| Switched a finish off (deburr) | **back on** | no |
| Set machinability 0.2 and a waste factor on a material | **back at the default** | no |
| Cut a thickness list down to what is stocked; renamed a grade | **back at the default (8 thicknesses)** | no |
| Priced a material through "cost per kg" with "price per kg" empty (the admin form allows it) | **back at the default price** | a line that reads as if nothing had been set |
| Added a material by hand | deleted | yes |

The author lists this as open item 10, Low ("carry `active` the same way, if wanted") and the owner
checklist asks you to write such changes down first. I rate it Medium because of what it does on the day:
the default catalogue ships with three machining metals and five finishes switched off and everything else
on. If on the live site you have switched off anything you do not stock or do not want to sell online, the
upgrade puts it back on sale and nothing in the log or on the Pricing page names it. Machinability, waste
factor, thicknesses and grade densities are all inputs to the price, so those materials are also priced
differently from what you set.

The upgrade from the live site's version 3 to version 4 is the first thing the deploy does.

**What a fix must achieve.** Everything the owner changed on a catalogue row that still exists must
survive the upgrade or be listed, row by row, where the owner will see it before the site takes an order.
At the least: on/off, and the fields the price is computed from.

## F-11 (Low): a missing version marker means "replace everything"

`server/config/seed.js` line 62: `existingRules?.rules?.seedVersion || 1`. `catalogue-upgrade.js`
section 4, on a version-4 database with two hand-edited prices: with the marker missing, null, 0 or -1
the next start logs "seed v1 → v4", replaces every material and finish and keeps no price (mild steel
$123.45 back to $1.10). With the marker "4" as text, "abc", 4.5 or 99 nothing is touched; with 3 the
prices are carried correctly. The owner's own buttons do not move the marker (save, reset, restore: still
4, same script section 5), so this needs a damaged or hand-edited rules row. If the rules row itself is
lost the same thing happens.

**What a fix must achieve.** An unreadable marker must never be read as "the oldest version"; the
catalogue must not be replaced when the version it came from cannot be established.

## What held (areas 6, 7, 8)

**Catalogue upgrade** (`catalogue-upgrade.js`: 15 held)

- Version 3 to 4: a hand-edited material price and finish price are kept; a price on a slug that leaves
  is not brought back and is reported; the marker ends at 4; no active material is left without a price.
- A second start changes nothing.
- An edit equal to the new default ends at that figure. Version 2 to 4: the edited price is kept and all
  45 other shared materials are at the version-4 default.
- No slug is priced by a different field in version 4 than in version 3 (46 shared slugs), so a carried
  price cannot land in the wrong column. Between 3 and 4 no default price changes; four SLA resins leave
  and eight arrive, as the author says. `seedHistory.js` version 4 equals `defaults.js` (54 materials,
  0 differences, checked directly).
- Not checkable from the repository: that each shared slug names the same physical material in both
  versions. `seedHistory.js` keeps prices, not names.

**What a customer sees** (`public-surface.js`: 6 held)

- The street address and ZIP are in none of the 60 built text files (`client/dist`: pages, bundle,
  prerendered routes); none of the 22 JSON-LD blocks has a `streetAddress` or `postalCode` (city only).
- No statement that it is a one-person shop; no test customer's name. The owner's name appears only inside
  the company name "Erik Lutz Enterprise LLC", which `shared/shop-facts.json` records as confirmed.
- 145 refusal codes found in the server. Each has words in `client/src/utils/messageCatalogue.js`, or is
  an admin-page code, a gate reason or a DFM check id; two DXF codes keep the server's own sentence, which
  was read and is written for a customer.
- 17 hostile requests to a production-mode server (broken STL, STEP, 3MF and DXF files, a path in a file
  name, SQL and prototype keys in a quote, a body that is not JSON, a 3 MB body, garbage links, an
  unsigned webhook): no answer carries a path, a stack line or a JavaScript error text.
- Refusal messages name limits in two places I would not worry about ("up to 100 lines", "up to N part
  files at a time"): both are things a buyer needs to know.

**The rest of the diff** (read, not run)

- No dependency was added or changed: `package.json`, `package-lock.json`, `client/package.json` and
  `client/package-lock.json` are not in the diff. `npm ci` on Node 20 reported 0 vulnerabilities for the
  server install.
- `Dockerfile`, `railway.toml`, `docker-entrypoint.sh`, `Procfile`, `client/public` and the Vite config
  are not in the diff. Nothing new is copied into the client build.
- What starts differently in production (`server/index.js`, 51 added lines): the server exits at once
  without both Turnstile keys unless `ALLOW_LAUNCH_WITHOUT_BOT_CHECK=1`; it prints an error block when
  stored files cannot be opened with the current encryption key; it starts the storage clean-up; it prints
  the memory budget and warns when the database is over half of `DB_MAX_MB`. The database ceiling default
  went from 256 MB to 16 MB, as the author says.
- The test switch (`SE_TEST_HOOKS`) cannot open unsigned webhooks in production
  (`server/security/testHooks.js`: `enabled() && NODE_ENV !== "production"`), and the parse delay and the
  email outbox need the switch.
