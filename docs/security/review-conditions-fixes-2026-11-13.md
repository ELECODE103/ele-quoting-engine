# Fixes for the conditions of the independent review (2026-11-13)

Branch `relaunch-2026-11-12`. This answers `docs/security/rereview-fixes-review-2026-11-13.md`
(findings N-01, N-03, N-05, N-08 and the phone-order part of F-12). Nothing here has been pushed,
merged or deployed. The site stays offline until you approve.

## Where this work stands (true as of the commit this file is in)

| Item | State | Commit |
|---|---|---|
| 1. Destination decided by ZIP code as well as state (N-03) | fixed, tests pass; final verification not yet run | `851fde1` |
| 2. A firm quote knows where it is going (N-05) | fixed, tests pass; final verification not yet run | this commit |
| 3. A buyer is not locked out by their own changes (N-01); phone orders safe from the clean-up (F-12) | fixed; final verification not yet run. (At `62a37ff` one suite failed that I had not run: the route inventory in `server/routes/authorization.test.js` did not list the new cancel route. Fixed in the commit this file is in.) | `62a37ff`, this commit |
| 4. A full disk is visible and says what it is (N-08) | fixed, shown on a real 3 MB disk; final verification not yet run. (At `e5efc4e` one suite failed that I had not run: `server/security/envExample.test.js` wants every setting listed in `.env.example`, and `DB_SAVE_RETRY_MS` was not. Fixed in the commit this file is in.) | `e5efc4e`, this commit |
| 5. Small corrections the review asked for | done: previous write-up corrected (`851fde1`); the per-address ceilings are run by `server/routes/orderCaps.test.js` and the harness comment is corrected (`62a37ff`) | `851fde1`, `62a37ff` |
| Final verification from a fresh clone on Node 20 | not yet run | |

A figure that is not in this file has not been measured. The full write-up (what was wrong, what
changed, what was run, what a customer now reads) is added item by item as each is finished.

## 1. Destination decided by ZIP code as well as state (N-03): notes so far

- New: `server/services/usAddress.js` (ZIP prefix to state, state spellings), with
  `server/services/usAddress.test.js` (8 cases). The list of states is `shared/us-states.json`,
  read by the server and by the checkout page's pick list.
- `server/services/checkout.js` `shipTo()` is the one place an address is checked; instant checkout,
  the firm-quote acceptance and the owner's phone order all go through it.
- Measured on the working tree of this commit, Node 20.20.0: `server/routes/shippingLimits.test.js`
  12 of 12 (5 new); the reviewer's `r3-shipping-firm-f06.js` section A: "an off-mainland ZIP code
  under a mainland state code is refused" now HOLDS (it sold 6 of 6). The same script now prints one
  FINDING it did not print before, and it is the script's own test address that is wrong: its
  "state lower case and padded" case sends state " il " with the ZIP code 43215, which is Columbus,
  Ohio. That is exactly the mismatch this fix refuses.

## 4. A full disk (N-08): notes so far

- `server/models/database.js`: a write of the database file that fails is counted, remembered and
  tried again every 15 s; `server/middleware/saveGuard.js` answers 503 `save-failed` to the request
  it happened under; `/api/health` answers 503 while the last write failed; the start-up refusal for
  "no space left" names the full disk. Runbook: `docs/launch/go-live-runbook.md`, "The volume is full".
- Measured on the working tree of this commit, Node 20.20.0: `server/models/diskFull.test.js` 8 of 8;
  `server/routes/orderAtomic.test.js` 12 of 12 (1 new: checkout with the disk full opens no payment
  page); my `tools/security/rereview-fixes/r4-full-disk.js` on a real 3 MB disk: 12 held, 0 findings
  (1 run); the reviewer's `r3-full-disk.js` on the same disk now records 503 for the second account
  (it was 201), health 503 (it was 200), and the start refused with "THE DISK IS FULL".

## 3. Replaced orders, the buyer's cancel, and phone orders (N-01, F-12): notes so far

- Checking out a changed quote closes the buyer's own unpaid card order of the earlier version in the
  same database change that writes the new order, payment page expired at Stripe first
  (`server/routes/orders.js` `replacedOrders`, `orderStep`). `POST /api/orders/:id/cancel` lets a buyer
  cancel their own unpaid card order; "Your orders" shows a Cancel button for it.
- The storage clean-up and the closing step now take `payment_method = 'card'` exactly
  (`orderLifecycle.isWaitingCardOrder`): a phone order (no method on record), a purchase-order order
  and a firm-quote order cannot be closed by it.
- Measured on the working tree of this commit, Node 20.20.0: `server/routes/orderCaps.test.js` 14 of 14
  (new: the per-address ceilings 5 and 16 with the real numbers; five changes of quantity in a row never
  refused, where the third used to be; the daily ceiling still refuses the 9th); `server/services/
  ownerOrdersPressure.test.js` 5 of 5, and 1 of 5 when the two rules are put back as they were (the
  phone order ended "expired": what the review had read and not run, now run). The reviewer's
  `r3-caps-and-lists.js`: "six changes of quantity, six checkouts: never refused" now HOLDS. It prints
  one new FINDING that is the script's own assumption no longer holding: it picks "the oldest unpaid
  order" and expects paying for its quote to give that order back, and that order is now closed.

## 2. A firm quote knows where it is going (N-05): notes so far

- The request form asks for the ship-to address (or pickup, when the shop offers it); the server
  checks it the way checkout does and stores it with the request; the owner sees it beside the price
  box and in the notification email; the address is one of the terms the emailed link is good for.
  At acceptance the order ships to that address. Another address (or the first one, on a request
  that had none) is not accepted at the quoted total: it is stored, the link closes, the owner is
  emailed "address changed, re-confirm the price", and the buyer is told what happens next.
- Measured on the working tree of this commit, Node 20.20.0: the whole suite once, 95 of 103, the 8
  failures being suites that asked for a firm quote without an address and then accepted it, the
  route inventory and the settings list; each was then corrected and passes run by itself (the whole
  suite has not been run again yet). `server/routes/firmQuoteShipTo.test.js` 14 of 14 (new).
  My `tools/security/rereview-fixes/r4-shipping-firm.js`: 34 held, 0 findings (1 run).
