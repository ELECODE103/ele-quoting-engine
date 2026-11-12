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
