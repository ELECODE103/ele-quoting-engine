# Independent re-review of the relaunch merge

**Verdict: NO as merged. YES once the five conditions below are met.** Nothing I found lets a stranger
read another customer's data or get an order marked paid for less than it was charged. What I found is:
a paid order whose part can be swapped for a larger one after pricing (F-01), an admin panel one customer
can blank without paying (F-09), a default shipping rule that sells freight-only sheets for $25 (F-03),
and a checkout that stops the whole site for seconds once the database has grown (F-08, F-02).
The author's write-up gives the best case for two of these (the checkout time, the shipping example).

**The conditions.**
1. F-01 is fixed in code (the units of a drawing cannot change under an order).
2. F-09 is fixed in code (the order lists load whatever the orders hold; one failed request does not empty the admin panel).
3. F-03: before the site takes an order, shipping is either on your own rate table (which has the size, weight and destination limits) or the default rule gets those limits.
4. F-08 and F-02 (one cause): an order and its lines are written together. If you launch without it, launch knowing a 100-line checkout stops the site for 0.6 s today and for 2 to 4 s once the database is 6 to 12 MB, and that a crash mid-checkout can leave a short order that is then charged in full.
5. F-10: straight after the first deploy, before the site is opened, go through Admin → Materials and Finishes and put back everything you had switched off or changed other than a price. The upgrade resets all of it and tells you about none of it.

2026-11-12. Reviewer: independent (wrote none of the code under review). Change reviewed:
`git diff 97f57f3..dce1e38` on `relaunch-2026-11-12` (101 commits). Machine: 2 cores, 7.8 GB, Node
v20.20.0 (`/opt/node20/bin/node`) for every run. Nothing was pushed, no product code was changed, no
call left the machine for Stripe, Resend, Turnstile or Railway. All eight areas of the brief are covered;
what could not be judged here is in the last two sections.

Every script named below is in `tools/security/rereview-relaunch/` and runs with one command from the
repository root, against a fresh server it starts itself:

```
env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost,127.0.0.1 /opt/node20/bin/node tools/security/rereview-relaunch/<script>.js
```

A script exits 1 when it shows a finding. "Verified by running" below means one of these scripts printed
it on this machine; "read" means I read the code and did not run it; the last section lists what is
neither.

## Findings

| # | Severity | What | Proof | From this merge? |
|---|---|---|---|---|
| F-01 | **High** | A DXF's units can be switched while its order is being made: the order is paid at the millimetre price and the shop is left holding the same drawing at inch size (25.4 times larger). The order carries no flag; only one line on the printed traveler says so | `units-race.js` (3 of 3) | No (the hole was there; the merge kept it) |
| F-09 | **High** | One confirmed account, without paying anything, makes the order list too large to send: the customer's "My orders" answers 500, and so does the owner's order list, which the admin panel loads together with everything else. The admin panel then shows nothing | `order-list-hold.js` | Yes (the answer ceiling met the order list) |
| F-03 | **Medium (business)** | The default shipping rule sells a 58 x 94 inch sheet with $25.63 shipping, to any state or country. That sheet cannot go by parcel at all | `shipping-exposure.js` | Yes (the default the merge chose) |
| F-08 | **Medium** | One press of "pay" on a 100-line quote stops the whole site for 0.6 s on a new database, 2.2 s at 6 MB and 4.2 s at 12 MB (the ceiling is 16 MB). The author's figure (0.51 to 0.59 s) is the new-database case | `checkout-hold.js` | Partly (the flushed saves and the re-pricing are the merge's) |
| F-02 | **Medium** | A hard kill (out of memory, host crash) during checkout leaves an order on disk with only some of its lines. The buyer comes back, is charged the full total, and the paid order lists fewer parts than were paid for | `durability-kill.js` section C | Partly (same cause as F-08) |
| F-10 | **Medium** | The catalogue upgrade switches back ON every material and finish the owner had switched off, and resets machinability, waste factor, thickness lists and grades, without a line in the log for any of them | `catalogue-upgrade.js` | Yes (disclosed by the author as Low) |
| F-12 | **Medium** | Thirteen confirmed accounts that press "pay" and never pay hold the file store full: after the clean-up no visitor and no customer can upload. The same accounts with saved quotes only are cleared | `storage-pin-orders.js` | Yes (the retention rule the merge wrote) |
| F-13 | **Medium** | Changing a drawing's units re-prices every draft that holds it in one step: 0.6 to 0.75 s of the whole site per change at the default draft allowance, repeatable | `units-flip-hold.js` | Disclosed by the author as an estimate; measured here |
| F-04 | **Medium** | The server starts, and answers its health check "ok", on a database file it cannot read; a zero-length file is silently replaced by a new empty database | `durability-kill.js` section E | No |
| F-05 | Low | A hard kill during the "paid" webhook leaves the order paid and nobody emailed: not the buyer, not the shop. Stripe's retry is answered "already seen" | `durability-kill.js` section D | No |
| F-06 | Low | Changing the delivery choice in a second tab overwrites the order before Stripe is asked whether the first tab's payment went through; a correct payment is then flagged as a wrong amount | `money-attacks.js` section 2 | Yes |
| F-11 | Low | A database whose version marker is missing, null, 0 or negative is treated as version 1: at the next start every material and finish is replaced and no hand-edited price is kept | `catalogue-upgrade.js` section 4 | Partly |
| F-07 | Low | A refund event that arrives before the "completed" event leaves a fully refunded order in "paid" | `money-attacks.js` section 4 | No |

Where the author's write-up and my runs differ:

| The write-up says | I measured |
|---|---|
| "Nothing below loses money, charges a wrong amount or exposes another customer's data" (section 10) | F-01: a paid order whose part is not the part that was priced. F-02: a buyer charged in full for an order with lines missing. F-03: orders sold at a shipping loss. No data exposure found |
| Checkout holds the thread 0.51 to 0.59 s for a 100-line quote (open item 1) | 0.6 s on a new database, 2.2 s at 6 MB, 4.2 s at 12 MB, 3.9 s at 12 MB under load |
| "a 4 ft by 8 ft routed sheet is charged about $12 plus weight" (decision 5) | A full 4 x 8 sheet is sent to a firm quote by the router-bed check. The largest sheet sold online is 58 x 94 in, charged $25.63 |
| A units change holds "about 0.8 s, an estimate" (open item 2) | 0.6 to 0.75 s per change at the full default allowance: the estimate was fair. It can be repeated |
| Prices changed by hand survive the upgrade; other changes are "not carried" (Low) | True for prices. On/off, machinability, waste factor, thicknesses and grades are reset with no report |
| Fairness under `pricing-eight.js`, quiet and loaded (7.5) | Reproduced; see the availability section |
| 88 of 88 suites | 88 of 88 here |

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

## F-09 (High): one customer can blank the owner's admin panel

**Where.** `server/routes/orders.js` lines 484 to 513 (`GET /api/orders`): for every order, every line's
part is loaded with `partsDB.getById` and its measurements and DFM result are put in the answer. For the
admin this is every order of every customer. `server/security/answerCeiling.js` (new with this merge)
refuses any JSON answer over `JSON_ANSWER_MAX_MB` (16) with 500 `answer-too-large`.
`client/src/pages/AdminPanel.jsx` lines 68 to 88: the admin panel loads materials, finishes, lead times,
quotes, statistics, **orders** and parts in one `Promise.all`; if one of the seven fails, the `catch`
logs to the browser console and none of the seven is shown.

The order list has carried the measurements since before this merge; the ceiling arrived with it. Each
is reasonable alone. Together a list that used to be slow is now refused.

**Measured** (`order-list-hold.js 6000 4`, twice): one confirmed account uploads a 100 mm disc drawn as
6,000 short segments (a 138 kB DXF), prices 49 lines of it ($4,924.76, open for checkout) and presses
"pay" four times on four quotes. Nothing is paid. Then:

| Request | Answer | Time | Thread held |
|---|---|---|---|
| `GET /api/orders` as that customer | **500 `answer-too-large`** | 626 to 756 ms | 621 to 754 ms |
| `GET /api/orders` as the owner (what the admin panel loads) | **500 `answer-too-large`** | 580 ms | not sampled |
| `GET /api/orders/admin/queue`, `/api/admin/quotes`, `/api/admin/parts` as the owner | 200 | 3 to 4 ms | |

Read, not run in a browser: with that 500 the admin panel's `loadData` sets nothing, so the Orders tab,
the materials and finishes tables, the quote list and the statistics are all empty, and the only sign is
a line in the browser console. The production queue page uses its own route and still works.

The orders do not go away by themselves: an unpaid order lapses to "expired" after its payment window,
and expired orders stay in the list. There is no button in the admin panel that deletes an order, and
the panel that would hold it is the one that is blank. The cure is a change to the database by hand.

It needs no bad intent. Each line of an ordinary part adds 5 to 8 kB to the list (measured on seven of
the repository's sample parts: 1.9 to 4.5 kB of measurements plus 2.4 to 3.3 kB of DFM result), so the
owner's list passes 16 MB at roughly two to three thousand order lines; a few customers with detailed
drawings bring that much nearer.

Every call also reads each line's measurement file again on the one thread (0.6 to 0.75 s here for 196
lines of a 93 kB file), limited only by the general 200 requests per 15 minutes per address.

**What a fix must achieve.** The owner's order list and a customer's order list must load however many
orders and lines there are and however detailed their parts: bounded in size (no per-line measurements,
or pages), with no file read per line. One failed request must not empty the rest of the admin panel.

## F-03 (Medium, a business finding): what the default shipping rule sells

**Where.** `server/services/shipping.js` line 192 to 196 (the `formula` mode: `shippingBaseRate +
kg x shippingPerKg`, "No size or destination rule") and `atDestination`, line 320 (the formula has no
destination rule). The defaults are $12.00 and $2.50 per kg (`server/config/ruleSchema.js` lines 78, 79).

**What the instant quote will sell at the defaults** (`shipping-exposure.js`; every row was priced by the
site and not sent to a firm quote; each one-piece row was then taken through checkout to a Honolulu
address and to an address in Germany, and both were accepted at the same shipping charge):

| Order | Parts | Shipping charged | Weight | Why it matters |
|---|---|---|---|---|
| 1 sheet 58 x 94 in, 1/16 in HDPE | $186.75 | **$25.63** | 12 lb | Length plus girth is about 212 in. UPS and FedEx Ground stop at 165 in and 108 in long. It can only go by freight |
| 1 sheet 58 x 94 in, 1/16 in acrylic | $248.26 | **$28.75** | 15 lb | The same, and acrylic that size needs a crate |
| 1 sheet 48 x 48 in, 1/16 in HDPE | $139.81 | **$17.76** | 5 lb | Length plus girth about 148 in: inside the parcel limit, with the carrier's large-package surcharge and its minimum billable weight |
| 1 strip 6 x 94 in, 1/16 in HDPE | $117.73 | **$13.41** | 1.2 lb | Long and light: an additional-handling or large-package charge |
| 100 sheets 48 x 48 in, 1/16 in HDPE | $4,839.19 | $588.03 | 508 lb | A pallet. Here the per-kg rate roughly covers freight |
| 10 sheets 48 x 48 in, 1 in HDPE | $4,880.02 | $926.44 | 806 lb | A pallet. Covered |
| 10 sheets 24 x 48 in, 1 in acrylic | $4,450.04 | $573.73 | 495 lb | A pallet. Covered |

A full 48 x 96 sheet is **not** sold online: the router-bed check sends it to a firm quote. The author's
example ("a 4 ft by 8 ft routed sheet is charged about $12 plus weight") is therefore not the worst case;
the worst case is the sheet just inside the bed, 58 x 94 in, which is larger.

**The exposure, in words.** The rule charges by weight alone. Heavy orders are charged enough or more
than enough ($2.50 a kg is about $1.13 a pound). The loss is on **large, light** parts: one thin sheet
over about 4 ft on a side is charged $13 to $32 and has to travel as freight or as an oversize parcel.
I did not call a carrier. My working assumption, which you should check against your own freight quotes, is $250 to $600 for a
single oversize flat sheet by LTL freight inside the contiguous states, more with a residential or
lift-gate delivery, and much more to Hawaii, Alaska or abroad. On that assumption **each such order
loses roughly $200 to $550 on a sale of $120 to $280**, and nothing limits how many are placed.

Destination: with the formula, checkout accepted every one-piece row to Honolulu and to Hamburg, Germany
(status 200, the same shipping charge). The country field is free text of up to five characters.

**What a fix must achieve.** Before launch, no order may be given a shipping price online that the shop
cannot ship for roughly that price: a longest-side limit, a weight limit and a destination rule have to
apply in whatever mode is the default. The rate-table mode already has all three (`shippingOversizeLongestIn`
48 in, `shippingMaxParcelLb` 50 lb, contiguous states only) and sends the rest to a firm quote; it held
in every test here. This is the author's decision 5; I am saying it is a launch condition, not a
preference.

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

With 25 lines of a machined cube ($4,831.65): 194 ms, 511 ms and 992 ms at the same three sizes. With the
machine loaded (four busy loops) the 100-line checkout at 12.2 MB took 3,918 ms.
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

**Measured** (`durability-kill.js 8 20`, section C: a 20-line quote, killed 4 to 124 ms after the request
is sent, 8 rounds, four separate runs): a partial order was left on disk in 6, 6, 6 and 5 of the 8 rounds
(anything from 0 to 19 of the 20 lines). In three of the runs the script followed a short order through:
the buyer presses pay again and pays. **Paid $4,403.88 in full each time; the paid order holds 7, 19 and
12 of its 20 lines.** Nothing flags it. (In the fourth run the script picked an order that happened to
have all 20 lines and only its quote left as a draft; that one was not sold short.) The window was about 100 ms for 20 lines on a
database of 0.2 MB; each line costs one whole-file save, so it grows with the number of lines (up to 100)
and with the size of the database (the author's own figure: 5 ms a save at 16 MB, plus the flushes).

It needs a crash inside that window, so it will be rare. When it happens the customer has paid for parts
the order, the traveler and the packing slip do not list.

The same writes are why checkout holds the one thread: 100 lines are 100 or more full saves in one step
(see the availability section).

**What a fix must achieve.** An order and all of its lines, the quote's new status and the part claims
must reach the disk together or not at all. An order whose lines do not match its quote must never be
handed a payment page.

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

## F-12 (Medium): unpaid orders hold the file store full

**Where.** `server/services/rowRetention.js` lines 100 to 108 (`unpaidOrderIsPayable`): a file on an
unpaid order is held outright ("never removed") until the later of 48 hours after the order was made and
30 minutes after its payment page lapses. `server/services/storagePressure.js` line 368 skips every part
held outright. Each account may store 150 MB and the store's ceiling is 2,048 MB, so fourteen accounts'
worth of unpaid orders is the whole store.

**Measured** (`storage-pin-orders.js pin` and `control`, scaled 1:10 like the author's own
`storage-pin.js`: ceiling 200 MB, 15 MB per address and per account; the two "minimum age" settings set
to one minute, which favours the defender):

| | Accounts | Store after the flood | After the pressure pass | Two minutes on |
|---|---|---|---|---|
| `pin`: each account prices its uploads and presses "pay", never pays | 13 (31 seconds) | 100 % | 100 %; visitor `storage-full`, new customer `storage-full` | the same |
| `control`: the same uploads and quotes, no checkout | 13 | 100 % | 63 %; visitor accepted, new customer accepted | the same |

(An earlier pair of runs without the second "minimum age" setting showed no difference between the two
modes: a signed-in customer's new part is spared by every pass for its first hours, so in that window
saved quotes hold the store just as well. The table is the run that separates the two.)

While it lasts every upload is answered "We can't take new files right now. Email them to
quotes@... or call ... and we'll quote them by hand." It lasts 48 hours by itself, and an account can
press "pay" again on the quote it gets back (12 checkouts per 15 minutes), so in practice until the owner
cancels those orders by hand. Each account needs a confirmed email address and its own network address
(a /64 counts as one). That is a real cost and a small one.

The rule is the author's deliberate answer to "a file must never be removed while its order can still be
paid", and that half holds (checkout checks the files are present). The other half is this.

**What a fix must achieve.** What unpaid orders can hold, summed over all senders, must stay well short
of the store, so that paying customers can always upload; or an unpaid order's files must be allowed to
go under pressure, with the order closed and its buyer told, before the store is refused to everyone.

## F-13 (Medium): a units change re-prices every draft in one step

**Where.** `server/routes/api.js` lines 901 to 925 (`refreshDraftQuotesFor`): every draft that holds the
part is priced again inside the units request, with no yielding.

**Measured** (`units-flip-hold.js`): one confirmed account holds 25 drafts of 100 lines of a 40-hole
plate, which is what the default 512 kB allowance takes (the 26th is refused `drafts-full`). Six unit
changes in a row: each request took 621 to 846 ms and held the thread 592 to 753 ms. The author's open
item 2 estimated "about 0.8 s"; the estimate was honest. What he did not say is that the change can be
repeated back and forth: here the site was stopped for about two thirds of six seconds, and the limits
that apply are the general 200 requests per 15 minutes and the sender's parse seconds, not the pricing
allowance.

**What a fix must achieve.** A units change must cost the thread no more than the one part's own
re-reading; the drafts that hold it are priced when they are next opened, or in pieces.

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
line 123 answers a retried event "duplicate" when its id is on record, and a replay sends nothing.

**Measured** (`RR_ONLY=D durability-kill.js 8`): control without a kill: buyer 1 email, shop 1. Killed 1
to 26 ms into the webhook, then the same event sent again as Stripe does: every order was paid after the
retry (no payment lost, none flagged), and in **5 of 8** rounds (7 of 8 in a second run) neither email
was ever written. With the
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

## F-11 (Low): a missing version marker means "replace everything"

`server/config/seed.js` line 62: `existingRules?.rules?.seedVersion || 1`. `catalogue-upgrade.js`
section 4, on a version-4 database with two hand-edited prices: with the marker missing, null, 0 or -1
the next start logs "seed v1 → v4", replaces every material and finish and keeps no price (mild steel
$123.45 back to $1.10). With the marker "4" as text, "abc", 4.5 or 99 nothing is touched; with 3 the
prices are carried correctly. The owner's own buttons do not move the marker (save, reset, restore: still
4, same script section 5), so this needs a damaged or hand-edited rules row. If the rules row itself is
lost the same thing happens (read, not run).

**What a fix must achieve.** An unreadable marker must never be read as "the oldest version"; the
catalogue must not be replaced when the version it came from cannot be established.

## F-07 (Low, not from this merge): refund before "completed"

`money-attacks.js` section 4: a `charge.refunded` for the full amount delivered before
`checkout.session.completed` leaves the order `paid` with `refundedAmount` equal to the total and no
flag. In the usual order of events the same refund moves the order to `refunded`
(`orderLifecycle.js` line 693). Stripe does not promise delivery order. A refund is something the owner
does himself, so he knows; the order would still sit in the work queue.

## What held

`npm test` on Node v20.20.0 in this worktree after `npm ci`: **88 of 88 suites passed**.

Every line is a run of the named script on this machine unless it says "read".

**Money** (`money-attacks.js`: 66 checks held, 0 findings)

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
- Three presses of "pay" at once: one order, one payment page. After payment the quote cannot be checked
  out again (409). The same payment reported again by webhook and by the return page changes nothing and
  emails nobody. A second press with the same amount is handed the same page.
- A drawing's units changed in one tab and "pay" pressed in another, one after the other: the buyer is
  asked (409 `quote-changed`, $177.83 against $114.68), and once the order exists the units are locked.
  (F-01 is the same two requests sent together.)

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
- The upgrade from master's database (`master-upgrade-access.js`, the repo's own fixture of a database
  written by origin/master: two parts with no owner): a stranger with no account and a stranger with a
  new account, knowing both part ids, made 48 tries each to price, preview, measure or change them, with no
  key and five guessed keys: all refused. The visitor who made the old quote opens it by its link, is
  handed the key of its part and prices it again ($892.91; master had $892.9166). A part that is on no
  quote stays usable by the admin only, as the author says: its uploader has to upload it again. Nobody
  else gains it.
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
- Read, not run: `deferred()` is used in five places: a draft's re-price and its "reopened" mark
  (`api.js` 777 and 1007), a backfill of a draft column (`quotesStore.js` 212), draft deletions
  (`quoteGuards.js` 151) and the clean-up pass (`storagePressure.js` 165). None wraps an order, a payment,
  an account or an admin edit, and any ordinary write takes waiting changes to disk with it
  (`database.js` `saveToDisk`).

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

## Availability: what I re-measured, and what held

Quiet means nothing else running on the machine. Loaded means four busy loops beside the server on these
two cores (load average 3.5 to 4.7), the same load the author used.

**The author's fairness test, run again** (`tools/security/rereview-availability/pricing-eight.js`, unchanged):

| | Quiet (author) | Quiet (mine) | Loaded (author) | Loaded (mine) |
|---|---|---|---|---|
| One quote of 25 different 3,000-hole drawings, alone | 1,522 ms | 1,278 ms | refused `quote-too-slow` after 6.2 s | refused `quote-too-slow` after 5.9 s |
| Health check, median, with 1, 2, 4, 8 attacking addresses | 2, 2, 2, 2 ms | 1, 1, 1, 1 ms | 9, 9, 8, 8 ms | 9, 8, 5, 5 ms |
| Health check, worst sample | 76 to 170 ms | 87 to 168 ms | 585 to 845 ms | 585 to 795 ms |
| Another visitor's one-line re-price: priced | 13 of 13 each phase | 13 of 13 each phase | 13, 13, 12 of 12, 13 | 12 of 12, 13, 13, 12 of 12 |
| That visitor: median; worst | 14 to 17 ms; 80 to 227 ms | 12 to 15 ms; 89 to 245 ms | 35 to 76 ms; 148 to 259 ms | 38 to 94 ms; 178 to 382 ms |

(One short script of mine overlapped the first seconds of the quiet run.) The author's figures for this
test are right, and so is his statement that it is worse than
availability-fixes alone. A real visitor is never refused and never waits more than 0.4 s for a price,
quiet or loaded, with eight addresses pricing the heaviest quotes there are.

**The open items, measured independently**

| Item | Author | Mine |
|---|---|---|
| Checkout re-pricing outside the runner | 0.5 to 0.84 s | **F-08**: 0.6 s, 2.2 s, 4.2 s by database size; 3.9 s at 12 MB loaded. The writes, not the pricing, are most of it |
| Units change re-prices every draft | 0.12 to 0.34 s measured, 0.8 s estimated | **F-13**: 0.6 to 0.75 s per change at the full allowance, repeatable |
| Reorder, one after another and four at once | 76 to 131 ms each; health worst 80 ms, 167 ms four at once | The adapted script, run again: 84 to 125 ms each; health worst 76 ms, 168 ms four at once. Reproduced. A 25-line order of a light drawing: 38 to 41 ms each, health worst 34 ms |
| At 1 GB after one large model, "busy" on every try | 7 of 7 for the heaviest mesh | `memory-poison.js`: see below |
| Quote view under a rate table reads each part | 119 to 125 ms | Not re-measured |
| The fingerprint hashed in one piece | 34 to 80 ms per dense part | Not measured by itself; it is inside the pricing-eight figures above |

**Can one upload put the site into "busy" on purpose?** (`memory-poison.js`, memory budget at its 1,024 MB
default.) One address sent 500,000 random triangles (25 MB): refused `parse-memory` after 13 s, with the
server at 963 MB when it answered. Sent again after one more large file: `busy` after 11 s, and the log
printed its "SHORT OF MEMORY" line. So yes: one sender, two uploads of 25 MB, about 25 seconds of its
180 seconds of parsing an hour, and the state the author describes is reached. **But it is the sender's
own heavy file that is refused. Ordinary customers were not touched:** before, right after, after three
large files, and 30 seconds later, four customers from four addresses each had a cube, a 76,800-triangle
block (3.8 MB), a 101,568-triangle block (5 MB) and a 248,832-triangle block (12.4 MB) read in 0.1 to
1.7 s: 12 of 12 after the attack, as the 4 of 4 before it. The server settled at 373 to 426 MB between parses. What I could not
test: this machine has 7.8 GB, so nothing here shows what Railway's own 1 GB limit does when the process
really reaches it (a hard kill, which is the trigger for F-02 and F-05).

**New attacks the existing scripts do not cover** (each is a finding above): the order list
(`order-list-hold.js`, F-09); checkout against a grown database (`checkout-hold.js`, F-08); unpaid orders
as the pin (`storage-pin-orders.js`, F-12); units flipped back and forth at the full draft allowance
(`units-flip-hold.js`, F-13); units flipped during checkout (`units-race.js`, F-01); the server killed
hard mid-checkout and mid-webhook (`durability-kill.js`, F-02, F-05).

**Does the file-retention rule let an attacker pin storage with unpaid orders?** Yes: F-12.

## The changed-tests audit

Method: each changed file was diffed against the commit it came from (`c7221a0` for tax-shipping,
`f706811` for the availability suites, `7c9de0f` for the re-review scripts). The original test files
were then run against the merged code where that could tell me something (copied in under a temporary
name, run, removed; nothing of it is committed). "Original wrong" means the old test could not pass on a
correct merged site; "finding edited away" would mean it failed for a real fault that the edit hides.

**No finding was edited away.** Three rows are marked in bold: one change removed coverage that nothing
else in the suite replaces, one follows a real change of behaviour, and one adapted script measures a much
lighter case than the one it was written for.

| Test or script | What changed | Original run on the merged code | Judgement |
|---|---|---|---|
| `taxShipping.test.js` (50 cases) | pacing limits lifted; four cases rewritten | With nothing changed: 9 of 50 pass, the rest stopped by `checkout-rate-limited` (12 checkouts per account per 15 minutes). With only the pacing limits lifted from outside: 14 pass, then the "no density" case fails half way and leaves a material without a density, and every later case fails on that | Original wrong for the merged site. See the four cases below |
| ... case "a line with no weight" | was: refused 409 `shipping-manual`; now: 200 at the full total | Fails as the author says (200) | Original wrong. Checkout prices the saved lines again and takes the weights from that. I tampered with stored weights five ways in two modes (`money-attacks.js` section 5): the real total is charged each time. The rule "an unknown weight is never zero" is still enforced on the freshly priced lines (`shipping.js` line 275) |
| ... case "a material with no density" | was: priced, shipping "unknown weight"; now: not priced at all | Fails: the material is refused by the whitelist | Original wrong; the merged rule is stricter |
| ... case "promo code and tax" | codes switched on for the first half; a wrong amount is now "unpaid and flagged", not "paid, under review"; a third case added (tax on an order checked out with tax off) | Not reached | Stricter. Confirmed independently (`money-attacks.js` section 7) |
| ... case "firm quotes" | the guest uploads their own part | Not reached | Ownership; read only |
| `pricingAvailability.test.js` | requests carry the part key; the eight-address share is read when the 6-second window closes, with a second bound over the whole run | 4 pass, 4 fail, every failure on `part-not-found` (no part key). The eight-address case fails on that before it reaches its timing check, so the original cannot say anything about the tail | Original wrong for the key. On the timing I have only the author's account (the figure was read after an 8-second tail) and my own run of `pricing-eight.js`, which agrees with his. The bound itself (a burst plus 60 % of the clock) is unchanged and a second one was added |
| `senderQuotas.test.js` | allowance used by the test 96 → 128 kB; the abandoned order now has a lapsed payment page | 7 pass, 2 fail: "2 re-prices accepted, 28 refused" and "a file on an order nobody paid for in three days is cleared" | First: original wrong (a stored draft grew from 2.3 to 2.8 kB at one line and from 5.9 to 7.8 kB at 25, so the test's own allowance was too small; the product default is 512 kB). Second: **a real change of behaviour that the edit follows**: an unpaid order with no payment page now holds its files for ever. A customer cannot normally make one (I looked: a failed session start deletes the order), so I accept it; F-02's partial orders are the exception |
| `storagePressure.test.js` | the customer prices their own parts; the levelling check allows the last holder to be partly cut | 8 pass; the first failure is "a visitor can still change the quote they have open: 400"; the four after it are knock-on (the database is left "nearly full") | Original wrong: the test had a signed-in customer price the visitor's part, which now makes it the customer's. The looser levelling check accepts "6 6 6 6 6 6 6 10": equal senders are not cut equally; the last one reached keeps more. Harmless among flood senders, noted |
| `databaseDurability.test.js` | a source-text check widened | Not run separately | Harmless. It only checks that `saveToDisk` ends in `writeDurably` |
| `shutdown.test.js` | the "no handler" case rewritten to expect a clean exit; a live-server case added | Not run separately | **Coverage removed.** The old case killed the process at six delays and checked the file was whole even when the kill landed inside a save. The new case checks a graceful stop. The suite now has no case in which the process is killed hard while it is writing. My `durability-kill.js` does that about 60 times per full run (integrity `ok` every time), so the property holds; the suite no longer proves it |
| `reorder-block.js` | makes "the largest order a customer can" (3 lines of the 4,900-hole drawing), pays it, reorders that | Original cannot run: the 100-line order is over $5,000 and an unpaid order cannot be reordered | **Lighter case.** The script was written to reorder 100 lines; it now reorders 3. A 100-line order under $5,000 exists (100 printed cubes, $1,654, see F-08), so "the largest order a customer can make" is not the heaviest reorder. The adapted script reproduces the author's figures (availability section). I did not measure the reorder of a 100-line order: it goes through the yielding runner and writes one row, so I expect it to be mild, and that is an expectation, not a measurement |
| `memo-check.js` | pays the order before reordering; prices its last step as the owner | Not run | Original wrong (ownership, paid-only reorder). One check changed meaning and the author says so: "memo against no memo" is now compared in `pricingAvailability.test.js`, not here |
| `encryption.js`, `migration.js`, `retention-encryption.js` | carry part keys over a restart, or take them from the old quote | Not run | Original wrong: each priced its own part without the key the browser would hold |
| `authorization.test.js` | follows routers mounted without a path; inventory gains five routes | Compared with my own walk of the routers (`route-inventory.js`: 98 routes, 50 owner routes, 0 without `authenticate` then `requireAdmin`) | The change makes the test see more, not less |
| `messageCatalogue.test.js` | wider scan for codes | My own scan found 145 codes, all accounted for (`public-surface.js`) | Sees more, not less |
| `priceIntegrity`, `reorder`, `orderLifecycle`, `relaunchIntegration` tests | per-account pacing limits lifted | Not run separately | Same reason as `taxShipping.test.js`; the limits are real (my own first run of `money-attacks.js` hit them after 6 checkouts) |
| `hardening-accounts.mjs` | waits for the sign-out answer before replaying the old token | Not run (browser) | Plausible; not verified |
| `upgrade-proof.js` | a timer keeps the event loop busy | Not run | Not verified. The hang it works around is in the script's own process |

## What you must test by hand

None of this can be judged in a sandbox. Each is a few minutes with real accounts.

1. **Stripe, test mode, tax off (the launch setting).** Place one order by card. Check in the Stripe
   dashboard that the amount is the total the checkout page showed. Then: start a second order, leave the
   Stripe page open, go back, change nothing and press pay again (you should land on the same page); pay it;
   press the browser's back button and pay again if Stripe lets you (the order must show paid once, and a
   second payment must show up in Admin as "needs attention").
2. **Stripe: closing a payment page.** With pickup or carrier account switched on in test mode: choose
   pickup, reach the Stripe page, go back, choose ship, reach the new Stripe page. Open the first Stripe
   page again: Stripe must say it has expired. My stand-in assumes that; only Stripe can show it.
3. **Stripe: refund and dispute.** Refund a test order in full from the dashboard and check the order
   becomes "refunded" and you get the email. Use Stripe's test card for a dispute and check the order is
   flagged.
4. **Stripe webhook.** In the dashboard, resend the same "checkout.session.completed" event twice. The
   order must stay paid, with one confirmation email.
5. **Stripe Tax** (before you ever switch it on): the four test-mode checkouts in
   `docs/launch/tax-and-shipping.md` section 7. My runs and the author's use a stand-in that adds 7 %; nothing
   here shows what Stripe really sends back, or that it accepts the Customer and address we create.
6. **Shipping.** Ask your carrier for a real price on one 58 x 94 in sheet of 1/16 in acrylic, crated, to a
   business address 500 miles away and to a home address. Compare with $28.75. That is F-03 in your own numbers.
7. **Turnstile.** With the real keys: upload a file in a private window, and check a quote is refused
   from a script without the token (the runbook's step 8).
8. **Railway.** After the first deploy: confirm the volume is mounted (Admin → System shows the database
   path and a size that is not a few hundred kB after you have used the site); set the draining time to 15
   seconds; restart the service once and confirm your test order is still there.
9. **The admin panel after F-09 is fixed.** Place four unpaid test orders of a many-line quote and open
   Admin: the Orders tab and the Materials tab must both still fill.
10. **The catalogue, on the day** (condition 5). Before the deploy, write down every material and finish
    that is switched off and any machinability, waste factor, thickness or grade you changed. After the
    deploy, compare, line by line.
11. **Email.** One real order: you and the buyer each get the email, from the address you expect.

## Not verified

- **Anything at Stripe, Resend, Turnstile or Railway.** No call left the machine. The Stripe stand-ins
  (the repo's and my own `stripe-stub-preload.js`) behave the way I read Stripe's documentation, most
  importantly: a session we expire can no longer be paid, and `amount_total`, `amount_discount` and
  `amount_tax` mean what the settle check assumes.
- **F-09 in a browser.** The two 500 answers are measured. That the admin panel then shows nothing is from
  reading `AdminPanel.jsx` lines 68 to 88, not from opening it.
- **Carrier prices in F-03.** The sizes, weights and what the site charges are measured. The freight
  figures are my assumption, stated as one.
- **A real memory limit.** The 1 GB budget is the server's own bookkeeping on a 7.8 GB machine. A real
  out-of-memory kill was imitated with SIGKILL, not provoked.
- **Firm quotes, purchase orders and reorder as money paths**: read (`server/routes/rfq.js` 655 to 795,
  `orders.js` 674 to 756), and covered by the author's suites, which pass; I wrote no attack script of my own
  for them.
- **Promotion codes switched on** with a real code: read only (`orderLifecycle.js` `checkSession`); the
  switched-off case was run.
- **Under-load figures** come from four busy loops on two cores. They show the shape, not Railway's numbers.
- **The browser runs** (`scripts/e2e/*.mjs`, the accessibility walk, the CSP check) and the geometry
  baseline, the vetting comparison and `upgrade-proof.js`: not re-run. I did not check prices against the
  vetting set.
- **`encryption.js`, `migration.js`, `retention-encryption.js`, `memo-check.js`**: their changes were read
  and judged; the adapted scripts were not re-run. `master-upgrade-access.js` covers the upgrade from
  master's database from the access side.
- **Whether each slug shared by catalogue versions 3 and 4 is the same physical material**: the history
  keeps prices, not names.
- **The quote view under a rate table** (author's open item 5) and the fingerprint cost by itself (item 4).
- **The author's scratch logs** were not read, as instructed.
