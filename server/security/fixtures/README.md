# Security test fixtures

- `plate_400_holes.step.gz` — a 2 MB STEP file (gzipped): a 126 × 126 × 6 mm plate with 400 Ø3 mm
  through holes, exported from CadQuery 2.8 (OpenCascade). It takes about ten seconds to read, which
  makes it the "large STEP" for the event-loop and worker-pool tests. The suites gunzip it to a
  temporary folder at run time.
- `box_hole.igs` — a 40 × 30 × 10 mm block with one Ø8 mm hole, written by OpenCascade's IGES writer.
  Used to check that a real IGES passes the content check and reads in a worker.
- `box_zip64.3mf` — a 20 × 30 × 40 mm box written as a ZIP64 archive (Python `zipfile`,
  `force_zip64=True`), to check that the ZIP pre-flight still accepts the ZIP64 form.

Everything else the suites need (ZIP bombs, oversized meshes, renamed files, pathological DXFs) is
generated in memory at run time by `server/testSupport/zip.js` and the suites themselves.

## master-db-2026-11-11.db.gz

A database file written by the server on `origin/master` (255753c), used by
`server/models/masterDatabase.test.js` to prove that later schema changes are
additive. It was made by starting master's own `server/index.js` on an empty
data folder and sending it: one upload of `tools/vet-quotes/parts/cube_20mm.stl`,
one of `dxf_plate_holes.dxf`, two quotes (one under a client-chosen id, which
master allowed), one registration and one firm-quote request. It holds no real
data: the account is `fixture-buyer@example.test` with a random password that
was never kept, and the secrets master ran with were random and are not in it.
