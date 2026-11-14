# Fixes for the conditions of the independent review (2026-11-13)

Branch `relaunch-2026-11-12`. This answers `docs/security/rereview-fixes-review-2026-11-13.md`
(findings N-01, N-03, N-05, N-08 and the phone-order part of F-12). Nothing here has been pushed,
merged or deployed. The site stays offline until you approve.

## Where this work stands (true as of the commit this file is in)

| Item | State | Commit |
|---|---|---|
| 1. Destination decided by ZIP code as well as state (N-03) | fixed, tests pass; final verification not yet run | this commit |
| 2. A firm quote knows where it is going (N-05) | not started | |
| 3. A buyer is not locked out by their own changes (N-01); phone orders safe from the clean-up (F-12) | not started | |
| 4. A full disk is visible and says what it is (N-08) | not started | |
| 5. Small corrections the review asked for | previous write-up corrected (this commit); the per-address ceiling test and the harness comment not yet done | this commit |
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
