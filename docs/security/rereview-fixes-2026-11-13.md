# Fixes for the independent re-review of the relaunch merge (2026-11-13)

Branch `relaunch-2026-11-12`. This answers `docs/security/rereview-relaunch-2026-11-12.md`, finding by
finding. Nothing here has been pushed by me, merged or deployed; the site stays offline until you approve.

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
| F-03 shipping limits in every mode | IN PROGRESS: code in `1f2d1e8` (a work-in-progress commit made by the coordinator when the session was cut off); tests, the exposure table and the vetting comparison still to do | |
| Tests the audit flagged | kill-during-a-save case restored (`682ee01`); `reorder-block.js` 100-line case still to do | |
| Final verification from a fresh clone | not yet run | |

The sections below are filled in as each item is finished. A figure that is not in this file has not
been measured.
