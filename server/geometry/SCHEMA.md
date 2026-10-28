# Part feature schema (contract between geometry, DFM, pricing and admin)

`parseFile()` returns `geometry` (legacy fields stay for compatibility) **plus** `geometry.features`,
the object below. DFM and pricing modules consume `features`; when a field is missing they fall back
to the legacy estimate and set `confidence` for that field to `"legacy"`.

All lengths mm, areas mm², volumes mm³, angles degrees. `null` means "not determined", never a guess.

```js
features = {
  schemaVersion: 1,
  source: "step" | "stl" | "3mf" | "iges",
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

  confidence: { holes: 0..1, pockets: 0..1, walls: 0..1, shape: 0..1, overall: 0..1 },
  notes: [ "strings for the admin view: what was ambiguous" ],
}
```

Rules for implementers:
- Geometry never prices. It describes.
- STEP/IGES go through OpenCascade (occt-import-js) and use **B-rep face data** (cylindrical faces → holes/bosses; planar faces → pockets/floors; per-face triangle ranges) before falling back to mesh heuristics.
- STL/3MF use mesh methods: normal clustering into planar regions, cylinder fitting on edge loops, ray-cast thickness (minimum of opposite-face distances along normals), per-axis visibility for setups/undercuts, outline from projection along the principal axis.
- Every field has a unit test with a synthetic part whose true value is known analytically.
- `confidence` is honest: a hole found from a B-rep cylinder is 1.0; one inferred from an STL loop is ≤ 0.8.
