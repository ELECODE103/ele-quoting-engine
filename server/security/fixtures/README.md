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
