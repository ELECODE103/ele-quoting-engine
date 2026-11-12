# baseline-step1

Results of the **large** mesh cases recorded on commit `413f781` — the code as it
stood before the speed work plus one change: adjacent facet pairs of a curved
group are read from neighbour lists instead of an all-pairs scan
(`server/geometry/regions.js`, `fitGroup`).

Why it exists. On the untouched code a 500,000-triangle sphere takes tens of
minutes and an organic 500,000-triangle mesh hours, almost all of it in that
all-pairs scan, so not every large case could be recorded on the untouched code
in the time available. Commit `413f781` returns exactly what the untouched code
returns on every small and medium case of the corpus (checked with
`GEOMETRY_BENCH_ROOT=<checkout of 413f781> node tools/geometry-bench/compare.js --size small,medium`),
and finishes the large ones in seconds.

How it is used. `tools/geometry-bench/baseline/` (recorded on the untouched
code, commit `e4881d3`) is the reference wherever it has an answer. For a large
case it lists as unfinished, compare against this folder instead:

    GEOMETRY_BENCH_BASELINE=tools/geometry-bench/baseline-step1 node tools/geometry-bench/compare.js --size large

Only result hashes are kept here (`index.json`).

## 2026-11-12: `baseline/` was recorded again on the merged code

`baseline/` is no longer the output of the untouched code alone. It was recorded again, all 226
cases that finish, on the relaunch branch after the availability, geometry-speed and tax-shipping
merges (Node 20.20.0), for two reasons:

1. **Refusals on purpose.** 21 cases are now refused where the untouched code measured them or ran
   out of memory or time: a sealed hollow, no solid volume, a size that is not a real part, a damaged
   ASCII file, a drawing over 5,000 contours or over 10 m. Those answers are the baseline now.
2. **Prices.** The shipping and tax merge added settings to the rate card, so the comparer stopped
   comparing prices ("pricing rules changed since the baseline was recorded"), and every quote gained a
   `shipping` block. Before recording again, each of the 196 small and medium cases was run and its
   price section compared with the untouched code's, ignoring only that block: 3,435 priced quotes,
   all identical.

What was checked when recording: of the 221 cases that had an answer before, the geometry and DFM
hashes of all 221 are unchanged; the 15 large cases in this folder (`baseline-step1`) have the same
geometry and DFM hashes in the new `baseline/`. `soup-wide-100k` and `soup-wide-500k` stay recorded as
unfinished: they run past the 60 seconds the live server allows a file.
