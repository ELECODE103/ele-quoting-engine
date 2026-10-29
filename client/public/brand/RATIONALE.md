# STRAIGHTEDGE — design rationale, rounds 1, 2 and 3

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

---

# Round 3 — D and E refined, with a nod to machining and additive

Companion sheet: `review-sheet-3.html` / `review-sheet-3.png`. Files: `d2-knife-*`, `d3-cut-*`,
`e2-layers-*`, `e3-light-*`. Geometry in `scripts/brand/geom3.js`, lockups in `build3.js`, the
custom alphabet in `glyphs.js`; rebuild with `cd scripts/brand && npm install && node build3.js
../../client/public/brand && node sheet3.js ../../client/public/brand`.

The brief for this round: keep D (Knife Edge) and E (The Kerf), make them more refined, and
work in a nod to both processes the shop runs — machining and 3D printing. Every candidate is
still one filled shape that can be described in one sentence, and every one still has to pass the
same tests as before: 20 mm on a packing slip, a 16 px favicon, one thread, a 6 mm stamp on black
acetal, and the shelf beside three gray competitors.

The shorthand used below: the "true edge" is the dead-straight side of the straightedge, the
"heel" is its square end, the "point" is the ground end. "Layers" means the stair-step surface a
3D-printed part shows wherever a slope is built from flat layers.

## D · Knife Edge — what changed

**Geometry.** The blade is now defined by a profile rule instead of a fixed drawing, so it is the
same object in every lockup:

- Thickness at the heel = 0.56 × the cap height of the name it carries (round 2 tied it to the
  word width, so the stacked blade was a different gauge from the horizontal one).
- The top edge is dead flat over the full length. The far end is ground to a point over the last
  52 % of the length.
- The point is not a zero-width point. It carries a flat 7 % of the thickness. A true knife edge
  frays in print, thread and rubber stamps; the flat keeps the tip from disappearing or hooking.
- The heel's lower corner is broken with a 45° chamfer half the thickness — the chamfer a
  machinist puts on every sharp edge — and that chamfer is built from three steps. That is
  exactly what an FDM part looks like at a chamfer. So in one profile: a flat machined true
  edge, a ground point, and a printed heel.
- The name sits 12 % of cap height above the edge: the light you look for under a straightedge.

**Lockups.** Round 2's stacked form put the blade *above* the name, which contradicted the idea
("the name rests on the edge"). The stacked form is now STRAIGHT over EDGE on one blade as wide
as STRAIGHT, with MANUFACTURING justified to the blade. The shop line in the horizontal is
justified to the blade's length. Oswald SemiBold stays (Bold was tried: heavier but coarser),
tracking +6 %. Alone, the blade is drawn at 14 % of its length.

**The sliver problem, honestly.** Round 2 said the blade cannot stand alone, and the brief asked
for a real fix. Three were tried, two failed:

1. *A stouter blade as the mark* (30–34 % thick, four printed layers on the heel, standing beside
   the name at cap height). At 150 px it is a handsome chisel; at 32 px and on the shelf it reads
   as a boat hull or a wedge of cheese. Rejected.
2. *Two blades meeting at a dead-square corner* (a knife-edge try square — square and edge in one
   shape, the name sitting in the corner). At 16 px it is the letter L; with the printed steps on
   the upright it is a ziggurat. It is also, by accident, an initial. Rejected.
3. *Give the blade something to lie on.* A straightedge is a sliver in every view — that is what
   the object is. The only thing that fixes it is the stock it is checking. Inside direction D that
   is the plate: `d2-knife-mark-plate.svg`, an ink square with the blade a hair below centre
   (where the name's baseline would be); in one colour the blade is a hole in the plate
   (`-mark-plate-1c`), which is a strong favicon on dark. This is still a tile and is labelled as
   one. The *structural* fix is E3 below, which is the same blade laid on the stock — the two
   directions converge there.

So D remains what it was in round 2: a wordmark-led system with a very good lockup and a weak
stand-alone mark. It is more refined now; it is not fixed.

### D2 · Knife Edge (`d2-knife-*`)
One sentence: the name rests on a straightedge whose heel is printed and whose edge is ground.
Oswald SemiBold on the blade. Weakness: as above — alone it needs the plate; the 6 mm part stamp
is a dash; the embroidered mark is a sliver (use the stacked patch, never the bare blade).

### D3 · The Cut (`d3-cut-*`)
One sentence: the same blade under a name drawn with straight strokes only — every curve is a
45° machined chamfer. The lettering is the custom alphabet drawn for round 2's direction F
(S, R, A, G, D are the chamfered letters), set on D's blade. Here machining is in the *letters*,
printing is in the heel, and the ground edge is the blade, so the two processes live in the same
lockup without a texture. Weakness: the name is about 1.8× wider than Oswald's, so the blade is
longer and thinner under it; the S is the least natural letter; the whole has a stencil,
industrial flavour that is more "shop" than "instrument maker". Same plate rule for icons.

## E · The Kerf — what changed

**Geometry.** The cut is now 20° (was 22°) and 6.5 % of the side wide (was 6.5 units on 100,
unchanged, but it is now a parameter). The cut still passes through the exact centre, so the two
halves have equal area and the square stays balanced. Chamfered corners were tried (7 % of the
side on all four): the square started to read as a rounded app-icon tile, so they were dropped.
The square stays dead square — that is the word.

**Lettering.** Archivo Bold at +3 % everywhere. Round 2 had +6 % in the horizontal and −0.5 % in
the stacked, which were two different wordmarks. The horizontal mark is 1.5 × cap with a gap of
0.38 × cap; the shop line's baseline sits on the mark's bottom edge. The compact mark is 1.18 ×
cap, vertically centred on the name. The stacked mark is 2.6 × cap (round 2's 2.3 looked small
over the word).

### E2 · The Kerf, layered (`e2-layers-*`)
One sentence: a square of stock parted by one true cut — printed in layers below the cut,
machined solid above. The lower half is ten horizontal layers (5 units thick with 1.6 units of
light between them on a 100 square); the cut runs clean through both halves, so the layer ends
are flush with the kerf — the cut is true regardless of how the stock was made.

What did not work: the first version used five thick layers, and it read as a flag (solid canton,
stripes below). Thinner layers read as "printed" rather than "flag", but the lower half still
looks like ruled paper or window blinds, and at 32 px the lines strobe into gray. The texture
needs the square to be at least 64 px / 17 mm; the compact lockup and `e2-layers-mark-small.svg`
are the solid square. Honest weakness: the texture competes with the cut — the one line that
matters — and makes the halves look like two materials rather than one square.

### E3 · The Kerf, light under the edge (`e3-light-*`)
One sentence: a square of stock parted by one straightedge — the upper half is machined and its
lower face is the true edge; the lower half is printed to the slope, so its face is a stair, and
the light between them is the kerf.

This is the exact picture of a straightedge check on a printed part: lay the edge on the layered
surface and light shows through at every step. The straightedge (the upper half's lower face)
touches the lower half at the corner of each step; the kerf is 6.5 units at the corners and opens
to 13 between them. Six steps on a 100 square (riser 6, tread 16.7). It is still one filled path
with no detail finer than the kerf.

Why it works where E2 does not: the texture *is* the cut — there is nothing competing with the
one line. And it degrades gracefully: at 16 px the steps vanish on their own and the mark becomes
round 2's kerf square, so the solid fallback (`e3-light-mark-small.svg`, used in the compact
lockup, the favicon, the 6 mm stamp and any embroidery under 50 mm) is the same shape, not a
different one. There is no visual break between sizes. It also carries D's idea — the blade lying
on the work — which is why it is the real answer to D's sliver problem.

Honest weakness: at 32 px the stair reads as a serrated edge, which is fine but not the full idea;
the story ("light under the edge") lands at 40 px and up. To a non-engineer it is "a square with a
stepped cut" — still a thing a stranger can describe, which was round 2's test.

## Rules

Clear space, all candidates: a margin equal to ¼ of the mark's height (E: ¼ of the square's side;
D: ¼ of the cap height) on all sides. The viewBoxes are tight, so the placing layout adds it.

| | minimum (print / screen) | what to use below that |
|---|---|---|
| D2, D3 horizontal | 40 mm / 150 px wide | compact |
| D2, D3 compact | 20 mm / 76 px wide | plate icon |
| D2, D3 stacked | 25 mm / 100 px wide | compact |
| D2, D3 plate icon | 16 px | — |
| D2, D3 bare blade | never under 30 mm long; never embroidered alone | plate icon or stacked |
| E3 textured mark | 8.5 mm / 32 px | `-mark-small` (solid) |
| E3 horizontal (textured) | 60 mm / 230 px wide | compact (solid) |
| E3 stacked | 30 mm / 115 px wide | compact |
| E2 textured mark | 17 mm / 64 px | `-mark-small` (solid) |
| E2 horizontal (textured) | 100 mm / 380 px wide | compact (solid) |
| E2 embroidery | solid square only (1.6-unit gaps cannot be stitched) | — |
| E3 embroidery | textured at 50 mm square and up (risers 3 mm, kerf 3.25 mm) | solid |
| any E compact | 20 mm / 76 px wide | mark-small |

The printed-layer details (D's heel steps, E3's stair) are not required to be visible at every
size; they are allowed to collapse. What must never collapse is the true edge and the kerf.

Palette rules are unchanged from round 2: brass is for the mark only, never for text; on dark the
mark is bone, not brass (the sheet shows the accent on dark for comparison only); below 10 mm on
white use the one-colour ink files.

## Recommendation

**E3 · The Kerf, light under the edge, in Ink & Brass.**

1. It is the only candidate on the sheet that carries both processes *in the one line that
   already carried the meaning*. The square is "deals square", the cut is "the work", the true edge
   is the machining, the stair is the printing, and the light between them is the check a
   machinist actually makes. Nothing was added to say this; the existing cut was made honest.
2. It passes every test without a different shape: 16 px, one thread, a 6 mm stamp, the shelf.
   Its fallback is the round-2 mark, which the owner already liked.
3. It settles the D question. D's blade cannot stand alone because a straightedge is a sliver; E3
   is that blade laid on the stock. If the owner wants the knife edge, E3 is where it survives.
4. Ink & Brass still reads as the more expensive, more settled palette on the sheet. Charcoal &
   Layout Blue is credible and cooler, and the owner should choose it if he wants the company to
   read "engineering" rather than "instrument maker" — the form works equally well in both.

If the owner prefers the wordmark-led feel of D, D2 is the one to take: it is refined, the blade
rule is consistent, and the plate icon is a reasonable favicon — but he should take it knowing
that the hat, the stamp and the app icon will always be a plate with a blade on it, not a mark.
D3 is the more distinctive of the two and the less expensive-looking; it is on the sheet so the
lettering question is answered by looking rather than arguing.
