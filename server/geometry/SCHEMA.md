# Part feature schema (contract between geometry, DFM, pricing and admin)

`parseFile()` returns `geometry` (legacy fields stay for compatibility) **plus** `geometry.features`,
the object below. DFM and pricing modules consume `features`; when a field is missing they fall back
to the legacy estimate and set `confidence` for that field to `"legacy"`.

All lengths mm, areas mm², volumes mm³, angles degrees. `null` means "not determined", never a guess.

```js
features = {
  schemaVersion: 1,
  source: "step" | "stl" | "3mf" | "iges" | "dxf",   // "dxf": extruded from a 2D drawing, see §2D input
  mesh: { triangles, watertight: bool, manifold: bool, selfIntersections: bool },

  // Extents
  aabb: { w, h, d },                                   // axis-aligned, as modelled
  obb:  { w, h, d, axes: [[x,y,z],[x,y,z],[x,y,z]] },  // oriented (PCA/min-volume); w>=h>=d
  volume, surfaceArea,

  // Shape classification
  shape: {
    kind: "flat" | "prismatic" | "revolved" | "freeform",
    primaryAxis: [x,y,z],         // extrusion axis for flat/prismatic, rotation axis for revolved
    is25D: bool,                  // every face is parallel or perpendicular to primaryAxis (±tol)
    stockThickness,               // extent along primaryAxis for flat parts, else null
    profile: {                    // projection along primaryAxis
      area, perimeter,            // outer outline only
      innerPerimeter,             // cutouts/holes outline length
      bboxW, bboxH,
      minInternalRadius,          // smallest concave corner radius found in outline (null if none)
      minSlotWidth,               // narrowest internal gap (null if none)
    },
    revolved: { axis, maxDiameter, length, minDiameter, boreDiameter, segments } | null,
  },

  // Features
  holes: [{ diameter, depth, through: bool, axis: [x,y,z], center: [x,y,z],
            blind: bool, kind: "round" | "counterbored" | "countersunk" | "tapped-candidate",
            depthToDiaRatio }],
  pockets: [{ area, depth, floorArea, openSides: 0..4, minCornerRadius, depthToWidthRatio,
              accessAxis: [x,y,z] }],
  slots: [{ width, length, depth, through: bool }],
  bosses: [{ diameter, height }],
  fillets: { count, minRadius } | null,
  chamfers: { count } | null,
  text: { present: bool, minStroke } | null,

  // Walls, thickness, access
  walls: { minThickness, p05Thickness, thinAreaFraction,   // thinAreaFraction = area below 1.0 mm / total
           tallThinMaxAspect },                            // height / thickness of the worst wall
  access: { directions: [[x,y,z]...],        // tool-access directions that together see every face
            minSetups3Axis,                  // 1..6
            undercutAreaFraction },          // faces not visible from any axis-aligned direction
  cornerRadii: { minInternalVertical, minInternalFloor },  // smallest concave radii (tool-radius drivers)

  // Printing
  overhang: { areaFraction45, maxAngleFromVertical, supportVolumeEstimate },
  bridging: { maxSpan } | null,

  // Stock & removal (per process, computed by geometry so pricing is consistent)
  stock: {
    block: { w, h, d, volume },        // obb + padding (padding from rules; geometry uses 3 mm default)
    bar:   { diameter, length, volume } | null,   // for revolved parts
    sheet: { thickness, blankW, blankH, area } | null,  // for flat parts
    removalVolumeBlock, removalRatioBlock,
  },

  confidence: { holes: 0..1, pockets: 0..1, walls: 0..1, shape: 0..1, overall: 0..1,
                source?: "dxf" },     // optional: set when the numbers come from drawn entities, not a mesh
  notes: [ "strings for the admin view: what was ambiguous" ],
}
```

Rules for implementers:
- Geometry never prices. It describes.
- STEP/IGES go through OpenCascade (occt-import-js) and use **B-rep face data** (cylindrical faces → holes/bosses; planar faces → pockets/floors; per-face triangle ranges) before falling back to mesh heuristics.
- STL/3MF use mesh methods: normal clustering into planar regions, cylinder fitting on edge loops, ray-cast thickness (minimum of opposite-face distances along normals), per-axis visibility for setups/undercuts, outline from projection along the principal axis.
- Every field has a unit test with a synthetic part whose true value is known analytically.
- `confidence` is honest: a hole found from a B-rep cylinder is 1.0; one inferred from an STL loop is ≤ 0.8.

## 2D input (DXF) — `geometry.profile2d`

A DXF has a profile but no thickness, so the geometry module produces two things (all additions are
optional fields; nothing above changed meaning, and 3D sources never carry them):

1. `geometry.profile2d` — the thickness-independent analysis of the drawing, stored with the part
   (`server/geometry/dxf`). mm, origin at the lower-left corner of the part's bounding box.
2. `geometry.features` — the object above, built by `materialize(geometry, thicknessMm)` at quote time
   by extruding the profile to the **stock thickness the customer selected**. The pricing engine and
   `runDFMAnalysis` call it for every 2D geometry, so the routing model and DFM read a DXF exactly as
   they read a STEP plate. Until a thickness is chosen `features.provisionalThickness: true` is set
   (built at 6.35 mm for the upload-time DFM preview only; the quote route refuses to price it).

```js
geometry.sourceFormat = "dxf"; geometry.is2D = true; geometry.sourceUnit = "mm" | "in" | …;
geometry.profile2d = {
  version: 1,
  units: { unit, source: "file" | "assumed" | "customer", needsConfirmation: bool, reason,
           declared, insunits, measurement,          // $INSUNITS / $MEASUREMENT as read
           sizeIfMm: { w, h }, sizeIfInch: { w, h } }, // footprint in mm under each reading
  bbox: { w, h, originX, originY },
  perimeter, innerPerimeter, area,     // outer loop / all cutouts / net material (exact: arcs are analytic)
  outerCount, nestedCount, cutoutCount, closedCount, openCount,
  holes: [{ diameter, center: [x, y], exact: bool }],            // exact = drawn as a circle/arcs
  slots: [{ width, length, shape: "stadium" | "elongated", center }],
  minInternalRadius, minInternalRadiusAt, sharpCorners: [[x, y]…],  // same convention as outline.js
  minSlotWidth, minSlotWidthAt,        // narrowest cutout / notch (not round holes)
  minWeb, minWebAt,                    // narrowest material between two cuts or a cut and the edge
  problems: [{ code: "open-contour" | "junction" | "self-intersection" | "crossing" | "duplicate" | "overlap" | "sliver",
               at: [x, y], gap? }],
  cleaned: { degenerate, duplicates, overlaps, slivers },
  ignored: { total, entityTypes: { TEXT: n, … }, layers: [{ name, reason, count }], solids, nonPlanar, paperSpace, unknownBlocks },
  layers: [ "cut layer names" ], approxCurves, tolerances: { weldMm, flattenMm },
  loops: [{ role: "outer" | "hole" | "slot" | "cutout" | "open" | "sliver", closed, depth, perimeter, area,
            pts: [[x, y]…], diameter?, center? }],   // flattened, for the 2D preview
}
```

How the 2D features map onto the schema: `shape.kind = "flat"`, `is25D = true`, `primaryAxis = [0,0,1]`,
`shape.stockThickness = aabb.d =` the selected thickness; `volume = area × t`,
`surfaceArea = 2·area + (perimeter + innerPerimeter)·t`; `shape.profile.*` straight from `profile2d`;
every drawn circle is a through `holes[]` entry (`depth = t`, `kind: "round"`); elongated cutouts are
`slots[]` (same definition as `detectSlots`); `pockets = []` (a drawing cannot express depth);
`walls.minThickness = profile2d.minWeb` (in-plane web, which is what the routing rule reads);
`mesh.watertight/manifold = null` (there is no mesh); `confidence` is 1.0 for holes and shape when every
contour is closed and nothing crosses, 0.5 otherwise, with `confidence.source = "dxf"`.

DFM check records may carry an optional `locations: [{ x, y, note }]` (mm, same origin) so the 2D
preview can mark where a check applies. Consumers that do not know the field ignore it.
