# STRAIGHTEDGE — design rationale, rounds 1 and 2

Companion to `README.md` (round-1 specs) and `review-sheet-2.html` / `review-sheet-2.png` (round 2).

## What round 1 was doing, and why it reads as safe

Round 1 was built against a hard, narrow brief: survive at 20 mm on a packing slip, embroider
in one thread, be paintable by a sign painter, avoid gears/crosshairs/chrome and avoid startup
gradients. Every decision optimized for *survival* — which is the right first filter and the
wrong last one. A mark that merely survives everywhere is, by construction, a mark that
risks nothing anywhere.

### A · Dead Square
**Idea.** A capital S drawn with straight strokes only, knocked out of a dead-square field —
straight + square, both meanings of the name in one glyph.
**Optimized for.** Small-size survival above all. A solid block with four cuts in it is the most
indestructible shape you can embroider or stamp; that is why it won round 1.
**What the owner is reacting to.** It is still a letter in a box. The concept is in the
construction of the S (no curves), but at a glance it reads as a *monogram in a square*, which
is the default move of ten thousand B2B companies. It is safe rather than distinct: a stranger
cannot tell you what it is about, and it has no gesture — nothing moves, nothing cuts, nothing
is being checked. It is a nameplate, not a signature.

### B · Ruled
**Idea.** Type-led: the name between a hairline and a heavy rule, as a sign painter lays out a
panel; every letter checked against the same straightedge.
**Optimized for.** The packing slip and the one-color world. A wordmark between rules is the
most legible thing on the sheet at 20 mm, and it costs nothing to reproduce.
**What the owner is reacting to.** Being type-led, it has no symbol — so the "mark" had to be
cut down to the initials S E between the rules. That fallback *is* the "boring SE": a
derivative, not a design. The rules are a nice typographic manner, not an idea you can put on a
hat and have it mean anything.

### C · The Bar
**Idea.** STRAIGHT and EDGE separated by the straightedge itself, standing on end.
**Optimized for.** Being literal and paintable on a truck door; a strong horizontal lockup.
**What the owner is reacting to.** Same failure as B in miniature: when you remove the words the
device is a vertical bar, which cannot stand alone, so the mark became S▌E — initials again.
Round 1 therefore delivered one monogram and two wordmarks with initials as a fallback.
None of them is a *gesture*.

### What "more Nike" means for a machine shop
Not sportswear cosplay, not a swoosh, not energy for its own sake. The swoosh is instructive for
three reasons only: (1) it is **one shape** with no letters that still says the whole brand,
(2) it is **ownable** — nobody else can use a wedge-with-lift without looking like Nike, and
(3) it carries a **verb** (motion). The equivalent here is a single shape that carries the
verb of this shop — *cut true, check square* — and that a purchasing manager would recognize
on a packing slip or a hat without the name next to it. It must still survive one-color and
20 mm; round 2 keeps every round-1 test and adds a part stamp and a shelf test. What changes is
that each mark is a **thing the shop does**, not a letter it is called by.

## Round 2 — three gesture-led directions

Each mark is one shape, explainable in one sentence, with no initials anywhere.

### D · Knife Edge
**One sentence.** The straightedge as a single stroke the name rests on — true edge dead
level on top, heel cut square, far end ground to a knife point.
**Why.** It is the closest to a literal swoosh (a bar with a taper, placed under the name) but
every edge is straight and the lift is in the taper, not a curve. Placed under the word it reads
as "the name stands on the edge."
**Lettering.** Oswald SemiBold (OFL), +5 % tracking — a condensed sign-painter's gothic that
sits well on a blade. Shop line in Archivo SemiBold.
**Honest weakness.** Alone, the blade is a sliver: 100 × 9. It needs a ground at icon size (the
color mark puts it on an ink tile), and as a one-color 6 mm part stamp it is a thin dash. It is
the most *dynamic* of the three and the least *durable*.

### E · The Kerf
**One sentence.** A square of stock parted by one dead-straight cut; nothing moved, the two halves
still make a square.
**Why.** It carries both meanings and the verb: *square* (deals square) and *the cut* (what the
shop does), and to a machinist it is also the straightedge laid across the diagonal of a plate to
check it. The 22° cut gives it lift without a curve. It is one filled shape with one line through
it, so it embroiders, stamps, and reads at 16 px with the cut still visible.
**Lettering.** Archivo Bold (OFL), set tight (−0.5 %) — a wide, quiet grotesque that reads
"instrument maker," not "job shop." Shop line in Archivo SemiBold.
**Honest weakness.** A split square is a known genre of mark; the specificity here is the thin
kerf and the shallow angle (most split squares are halved on the 45°). It depends on being used
consistently to become ownable.

### F · On the Plate
**One sentence.** The straightedge standing dead square on the surface plate — what an engineer
reads as the perpendicularity symbol (⟂).
**Why.** It is the most *shop-literate* mark: GD&T perpendicularity is a symbol every OEM
engineer has drawn, and no company brands with it. It is also the only direction with a
**custom-drawn wordmark**: every letter of STRAIGHTEDGE is built from straight strokes with
45° machined chamfers where a curve would be (S, R, A, G, D). The name is literally drawn
straight; the R has a straight leg; the chamfers are the chamfers a machinist puts on every
edge. No stock font is set plain anywhere in this direction.
**Lettering.** Custom (geometry in `scripts/brand/build2.js`); shop line in Archivo SemiBold.
**Honest weakness.** To a non-engineer the mark can read as an upside-down T. The custom
lettering has a stencil/industrial flavor that is distinctive but less "expensive" than E's
Archivo; it would suit a shop that wants to look like a shop more than an instrument maker.

## Palettes

"High quality and integrity" to a purchasing manager and an engineer means the colors of things
they already trust: instruments, nameplates, old iron, the stock on the saw. None of the
trade-dress colors of the tool brands (Milwaukee red, DeWalt yellow, CAT yellow, Makita teal,
Stihl/Husqvarna orange) and none of the SaaS teals.

| | ink / text | accent (the mark) | paper | reason |
|---|---|---|---|---|
| **1 · Ink & Brass — recommended** | `#101C33` | `#A8834E` | `#F4F1EA` | Deep ink navy with a warm brass accent on bone: the gauge, the dial, the data plate. Reads expensive and settled; no shop in the directory owns it. Brass embroiders as standard old-gold thread and prints as a flat spot (nearest Pantone, to verify against a swatch book: brass ≈ 7557 C, ink ≈ 2767 C, bone ≈ 7527 C). |
| 2 · Charcoal & Layout Blue | `#25282D` | `#1F418F` | `#FFFFFF` | Charcoal with the round-1 Dykem layout-fluid blue as the one signal. Cooler and more technical — reads "engineering" before "heritage." Safe, credible, slightly common (nearest Pantone 7687 C / Black 7 C). |
| 3 · Machine Green & Bone | `#15171A` | `#2F4A3C` | `#EDE7D6` | The gray-green of old iron (Bridgeport, South Bend) on bone, the color of natural acetal stock. Quiet and very credible to a machinist; the least "brand-like" and the lowest contrast on dark (nearest Pantone 5535 C / 7527 C). |

Rules that go with the recommendation: brass is for the mark only — never for text, never for
buttons. Below 10 mm on white, use the ink one-color version (brass on white is about 3.5:1, fine for a
mark, not for anything you must read). On dark, the mark is bone, not brass.

## Where I would put it on the building

**E · The Kerf, in Ink & Brass.** It is the one shape on both sheets that a stranger can describe
("the square with the cut through it"), that means something true about the shop, that has lift
without a curve, and that passes every test — 16 px, one thread, a 6 mm stamp on black acetal,
and the shelf beside three gray competitors — without a fallback. D has more motion and less
substance; F has more trade meaning and a narrower audience. If the owner wants F's custom
lettering, it can be paired with E's mark: the kerf square and the straight-drawn wordmark share a
language (straight strokes, machined cuts), and that pairing is the strongest single system on the
sheet.

## Files

Round-2 assets follow the round-1 naming: `d-knife-*`, `e-kerf-*`, `f-plate-*`, each in
`horizontal`, `horizontal-compact`, `stacked`, `mark`, with `-1c` one-color versions filled with
`currentColor`. Round-1 files are untouched. `Wordmark.jsx`, `favicon.svg` and `global.css` were
not changed this round. Regenerate with `cd scripts/brand && npm install && node build2.js
../../client/public/brand && node sheet2.js ../../client/public/brand e`.
