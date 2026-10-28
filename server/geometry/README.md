# server/geometry — feature recognition

Turns an uploaded part (STEP, IGES, STL, 3MF) into `geometry.features`, the
object defined in [SCHEMA.md](./SCHEMA.md): holes with diameters and depths,
pockets, slots, bosses, wall thickness, tool access, outline perimeter, shape
kind and stock. Pure JavaScript, no native dependencies, typed arrays
throughout; a 770 k-triangle mesh runs in about 3 s.

```js
const { analyzeGeometry } = require("./server/geometry");
const features = analyzeGeometry({ positions, source: "stl" });                       // mesh path
const features = analyzeGeometry({ positions, source: "step", brepFaces, vertexNormals }); // B-rep path
```

`positions` is a flat `Float64Array` with 9 numbers per triangle (mm).
`brepFaces` is `[{ first, last }]` — the triangle range of each B-rep face as
`occt-import-js` reports it (`mesh.brep_faces`, offset per body);
`vertexNormals` is the kernel's per-corner normal array (exact surface normals).
`parseFile()` in `server/parsers/fileParser.js` does this wiring and puts the
result on `geometry.features`; `mesh data` never goes inside `features`.

Files:

| file | job |
|---|---|
| `index.js` | orchestration, confidence, notes, rounding, `legacyFromFeatures()` |
| `mesh.js` | welded indexed mesh, normals, areas, volume, edge adjacency, watertight/manifold |
| `bvh.js` | AABB BVH: nearest ray hit, hit counting (inside test), box query |
| `regions.js` | segmentation into planar / cylindrical / conical / other patches |
| `fit.js` | cylinder & cone fitting from normals and points, angular coverage |
| `features.js` | holes, counterbores/countersinks, bosses, pockets, slots, fillets, chamfers |
| `outline.js` | exact projection outline: perimeters, area, internal radii, slot widths |
| `shape.js` | OBB, 2.5D test, revolved test, kind, stock models |
| `raycasts.js` | wall thickness, tall-thin aspect, tool access/undercuts, overhang, self-intersection |
| `testMesh.js` | synthetic watertight mesh builder for tests |
| `geometry.test.js` | tests with analytic truth (synthetic parts, 17 reference STLs, STEP fixtures, 500k perf) |
| `validate.js` | writes [VALIDATION.md](./VALIDATION.md) from the reference library |
| `fixtures/` | STEP fixtures made with CadQuery (`generate_step_fixtures.py`) + `fixtures.json` truth |

## Pipeline

1. **Mesh** (`mesh.js`). Vertices are welded on a grid of 10⁻⁶ × bounding
   diagonal with an open-addressing hash table; a directed-edge table gives the
   neighbour across every triangle edge. Open edges → not watertight;
   duplicated directed edges → non-manifold. Volume from the divergence theorem.

2. **Segmentation** (`regions.js`).
   *Mesh path:* coplanar triangles (dihedral < 0.25°) grow into planar regions.
   Neighbouring regions with a *smooth* dihedral (0.25°–40°) are merged into a
   curved group only when their **implied radii agree** (width perpendicular to
   the shared edge ÷ angle, ratio ≤ 2.5). A tessellated cylinder is a chain of
   equal-width facets turning by equal angles, so it merges; a real planar face
   meeting a fillet at a shallow angle is far wider than the fillet facet, so it
   does not. Widths use only each region's boundary vertices (the extremes of a
   planar polygon), so cost does not grow with triangle count. Each group is
   fitted (`fit.js`); groups that fit nothing become `other` patches.
   *B-rep path:* one patch per `brep_faces` range, classified by the same fit
   using the kernel's exact vertex normals. No merging is needed.

3. **Fitting** (`fit.js`). The normals of a cylinder or cone lie in one plane
   whose normal is the axis (smallest eigenvector of the centred normal
   covariance); for short arcs the cross products of neighbouring normals give
   the axis instead. Mean `n·axis` ≈ 0 → cylinder (Kasa circle fit of the
   points projected along the axis gives centre, radius, rms); otherwise cone
   (apex from the tangent planes, half-angle from `n·axis`). Concavity is the
   sign of the radial normal component; angular coverage is 360° minus the
   largest empty gap of the vertex angles.

4. **Shape** (`shape.js`). OBB candidates: AABB, PCA, and the normals of the
   three largest planar patches, each with an in-plane rotation search
   (1° then 0.1°), then a small rotation refinement; the AABB wins near-ties so
   modelled orientation is kept. The **2.5D axis** is the candidate (AABB/OBB
   axes, big plane normals, big cylinder axes) that maximises the area whose
   normals are parallel or perpendicular to it (±1.5°); `is25D` at ≥ 98 %. The
   **revolved** test needs ≥ 90 % of lateral area (normals not along the axis)
   to be tangent-consistent with rotation about the axis (±4°). `kind`:
   revolved → `revolved`; 2.5D and thickness ≤ 25.4 mm & ≤ 0.75 × plan size,
   or ≤ 0.3 × plan size → `flat`; otherwise `prismatic`; not 2.5D and mostly
   curved → `freeform`.

5. **Outline** (`outline.js`). Triangles are projected along the primary axis.
   Candidate segments are the edges of edge-on triangles, edges between an
   up-facing and a down-facing triangle, and open edges; duplicates and
   collinear overlaps are merged. A segment is on the outline iff exactly one
   side is covered by the projection (grid point-in-triangle test at a probe
   distance of 10⁻⁸ × size — far below any tessellation sagitta). Orientation
   puts material on the left, so chained CCW loops are outer outlines and CW
   loops are cutouts. Perimeters are exact for CAD meshes (the reference parts
   agree to < 0.01 %). From the loops: `minInternalRadius` (right turns = concave
   material corners; a single turn > 30° is a sharp corner → 0, runs of gentle
   turns give chord ÷ 2 sin(θ/2)) and `minSlotWidth` (nearest crossing of a ray
   cast across the non-material side). Round holes are excluded from both — they
   are in `holes`.

6. **Features** (`features.js`).
   - **Holes** = concave cylinders with ≥ 300° coverage (coaxial seam halves
     are merged first). Each end is tested by asking whether the axis point just
     beyond it is inside the solid (parity vote of three rays): both open →
     through, one → blind, none → `internalVoid`. Coaxial stacks: a larger
     touching cylinder at an open end → `counterbored` (`counterbore {diameter,
     depth}`), a touching concave cone ≥ 0.75 mm radial growth → `countersunk`
     (`countersink {diameter, angleDeg}`), a cone narrowing to the axis →
     `drillPoint`. `tapped-candidate` when the diameter is a standard tap drill
     (±0.05 mm) that is not also a common clearance size. `depth` is the full
     axial extent including counterbore/countersink; `center` is the midpoint of
     the axis segment.
   - **Bosses** = convex full cylinders shorter than the part along their axis,
     attached at exactly one end (inside test at 0.7 r, four-way vote), excluding
     diameters coaxial with a revolved part's axis.
   - **Pockets** = planar floors whose boundary is ≥ 30 % walls rising above the
     floor plane, whose boundary is not ≥ 80 % hole cylinder (blind-hole bottoms,
     counterbore floors), and that are **open above** (≥ 80 % of rays along the
     floor normal leave the part — this is what separates a floor from a side
     wall, which also has perpendicular neighbours). `depth` = tallest wall
     above the floor, `area` = floor outline area (opening), `floorArea` =
     floor triangles (islands and through holes excluded), `openSides` = sides
     of the floor's principal rectangle whose boundary is > 50 % not wall,
     `minCornerRadius` from the floor loop corners and adjacent concave vertical
     cylinders, `width` = narrowest gap across the floor, `perimeter`.
   - **Slots** = cutouts of the outline that are not round (circularity < 0.95),
     elongated (length ≥ 1.5 × width) — `shape: "stadium"` when the area matches
     a stadium within 15 % — plus **half-round channels**: concave cylinders of
     150°–220° coverage, longer than wide, whose open side faces free space
     (`depth` = radius, `through` when the length spans the part).
   - **Fillets** = partial cylinders (15°–200°); `chamfers` = short cones (≤ 5 mm)
     not absorbed by holes + narrow tilted planes (min extent ≤ 5 mm and
     ≤ ¼ of max extent, normal not aligned with any primary/OBB axis).
   - `cornerRadii.minInternalVertical` = min of outline internal radius and pocket
     corner radii; `minInternalFloor` = concave fillets whose axis is ⊥ the
     primary axis, `0` when pockets exist without such fillets, `null` otherwise.
   - `text` is always `null` (not attempted).

7. **Ray casts** (`raycasts.js`), all from triangle centroids. Meshes above
   30 000 triangles use a deterministic area-weighted sample of 30 000 and say
   so in `notes`.
   - **Wall thickness**: cast along the inward normal to the first *back-facing*
     hit; `minThickness`, area-weighted `p05Thickness`, `thinAreaFraction`
     (< 1 mm). `tallThinMaxAspect` = for planar patches with median thickness
     ≤ 6 mm, (smaller in-plane extent) ÷ thickness, max over patches — the
     smaller extent is the free span of the wall (or of a thin floor).
   - **Access**: for each of ±X ±Y ±Z (plus ± the primary axis when it is not
     axis-aligned) a face is reachable when it faces the direction and the ray
     is clear (end cut) or is parallel to it (±1.5°) and the point just outside
     it is clear (flank cut). `undercutAreaFraction` = area reachable from none.
     `directions` = greedy cover (head-on area counts 1, flank ½; near-ties
     prefer the primary axis); `minSetups3Axis` = its size. A plate gives
     `[+Z, −Z]` = 2 (the bottom face needs a flip; pricing may treat it as stock).
   - **Overhang** (modelled +Z up): down-facing area with angle from vertical
     > 45°, excluding faces on the bed; `supportVolumeEstimate` = footprint ×
     drop to the surface below (ray cast) or the bed; `bridging.maxSpan` =
     largest smaller-extent of a horizontal down-facing region off the bed.
   - **Self-intersections**: triangle edges against non-adjacent triangles from
     the BVH; sampled above 60 000 triangles (noted), skipped above 400 000
     (`null`).

8. **Stock** (`shape.js`): `block` = OBB + 3 mm each side (`options.stockPaddingMm`);
   `bar` for revolved parts = max diameter + 2 × pad, length + 2 × pad; `sheet`
   for flat parts = thickness (no pad) × profile bbox + 2 × pad.

## Confidence

| field | rule |
|---|---|
| holes | B-rep cylinder 1.0; mesh-inferred 0.8; × 0.8 if not watertight; ≤ 0.6 if a hole has both ends closed |
| pockets | B-rep 0.9, mesh 0.7; ≤ 0.65 when a pocket is open-sided (step/channel ambiguity) |
| walls | 0.85 full sampling, 0.7 downsampled, 0.2 when no ray produced a thickness; × 0.8 if not watertight |
| shape | revolved ≥ 0.98 score → 0.95 else 0.85; 2.5D ≥ 99.5 % → 0.95 else 0.85; prismatic 0.7; freeform 0.6; ≤ 0.6 if outline loops did not close |
| overall | mean of the four |

`notes` explains every reduction in plain words (open edges, sampling, open
pockets, non-2.5D area fraction, truncated lists).

## Legacy fields

`parseFile()` keeps every legacy field and replaces three of them when the
recogniser has a value (originals are kept under `geometry.legacy`):

- `estimatedHoles` ← `features.holeCount`, `estimatedSlots` ← `features.slots.length`
- `estimatedPerimeter` ← outer outline + cutouts + pocket outlines (total cut path, exact; the old value was `(surfaceArea − 1.4·bboxArea) / thickness` clamped)
- `estimatedThickness` ← `walls.minThickness` when walls confidence ≥ 0.6 (the thinnest wall, which is what the DFM checks mean by it; the old value was the smallest bounding-box side — 40 mm for a 2.5 mm-wall housing)

`estimatedBends` is untouched (still noise; sheet metal is inactive).

## Limits (honest list)

- Everything assumes millimetres. STEP/IGES units are converted by occt-import-js; STL has no units.
- Holes must be tessellated with ≥ 3 distinct facet normals and consistent angular steps (ratio ≤ 2.5 between neighbouring facets); adaptive tessellation splits a cylinder into fragments, which are re-merged only when coaxial, same radius and touching.
- Holes that break out into a pocket wall or another hole (coverage < 300°) are not holes; they show up as fillets (partial cylinders) or nothing.
- Pockets need a planar floor. Ball-nosed or free-form floors are not pockets; a half-round channel is a slot. A covered cavity (T-slot) is neither — it is undercut area.
- `openSides` uses the floor's principal rectangle; an L-shaped step can count a side twice or not at all.
- Through-slot detection is 2D (projection along the primary axis); slots entering from the side are only seen as half-round channels when they are round-bottomed.
- `text`, `fillets` on free-form blends (variable radius) and threads are not detected; a modelled thread tessellates as `other` patches.
- Outline perimeter is exact for closed, consistently oriented meshes. Open or self-intersecting meshes fall back to the sum of outline segments with `shape` confidence ≤ 0.6.
- Overhang/bridging use the modelled Z as the print direction, like the legacy `overhangFraction`.
- Sampling: above 30 000 triangles thickness/access/overhang look at 30 000 area-weighted centroids. A thin feature smaller than ~1/30 000 of the surface area can be missed; `walls` confidence drops to 0.7 and the note says so.
- Lists are capped at 2 000 entries (`holeCount` is always the true count).
- Assemblies (multi-body STEP) are analysed as one mesh, like the rest of the parser. A bolt sitting in a hole makes that hole read as `internalVoid` (both ends inside another body) and drops holes confidence to 0.6 with a note.

## Extending

- A new feature kind: add a detector in `features.js` that consumes `patches` (each has `kind`, `tris`, `area`, and for cylinders/cones `axis`, `center`, `radius`/`rMin`/`rMax`, `concave`, `coverageDeg`, `length`) plus `bvh` for inside/visibility tests, then surface it in `index.js` with rounding and a confidence rule. Add a synthetic part in `testMesh.js` with its analytic truth and a test.
- A new surface type (sphere, torus): add a branch in `fit.js` `fitCurved()`; patches already carry `kind: "other"` for anything that does not fit.
- Tolerances live at the top of each module (`COPLANAR_COS`, `SMOOTH_MAX_DEG`, `RADIUS_RATIO_TOL`, `FULL_COVERAGE_DEG`, `MAX_SAMPLES`).
- To regenerate STEP fixtures: `pip install cadquery` then `python3 server/geometry/fixtures/generate_step_fixtures.py`.
- To refresh the validation table after a change: `node server/geometry/validate.js`.
