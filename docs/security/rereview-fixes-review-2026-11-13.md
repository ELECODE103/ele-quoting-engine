# Independent review of the re-review fixes (2026-11-13)

Reviewer: independent (wrote none of the code under review). Code reviewed: `git diff dce1e38..28cb39d`
on `relaunch-2026-11-12`. Nothing was pushed, no product code was changed, nothing left the machine for
Stripe, Resend, Turnstile, Railway or a carrier.

## 1. State of this review (true as of the last commit)

**IN PROGRESS. No verdict yet. Do not read this file as a clearance.**

| Area | State |
|---|---|
| Reproducing the author's figures on `28cb39d` from a fresh clone, Node 20.20.0 | `npm ci` done (exit 0, 0 vulnerabilities); `npm test` running; the rest not started |
| F-07 event order | attacked: `r3-event-orderings.js`, 29 held, 0 findings, 3 notes |
| F-09 / F-12 ceilings on unpaid orders, order list and single-order route access | attacked: `r3-caps-and-lists.js`, 10 held, 2 findings (an honest buyer locked out; a second buyer behind one address) |
| F-01, F-08/F-02, F-06, F-13, F-10/F-11, F-04, F-05, F-03 | not yet attacked |
| Firm-quote, purchase-order and reorder money paths | not yet attacked |
| Changed-tests audit, price baseline, vetting comparison | not started |
| Browser check of the admin panel | not started |

Everything below this line is filled in as each area is finished.
