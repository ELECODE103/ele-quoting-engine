# STRAIGHTEDGE — logo system

Straightedge Manufacturing LLC · Wauconda, Illinois · an Erik Lutz Enterprise LLC company.

Open `review-sheet.html` (or `review-sheet.png`) to see all three directions large, one-color,
on dark, at 20 mm, as a favicon, on a packing-slip header and as a one-color embroidered patch.

The name carries two meanings on purpose: the machinist's straightedge (the reference everything
else is checked against) and a person who deals square. Every direction below is built so a sign
painter could lay it out with a rule and a brush, an embroiderer can run it in one thread, and it
still reads at 20 mm on a packing slip. No gradients, no swooshes, no gears, no chrome.

## The three directions

### A · Dead Square  (`a-dead-square-*.svg`) — **recommended**
A capital S drawn with nothing but straight strokes, knocked out of a dead-square field.
Straight strokes say *straight*; the dead square says *square* — it is the whole name in one
glyph, and it carries the second meaning (deals square) without saying it out loud.

### B · Ruled  (`b-ruled-*.svg`)
Type-led: the name sits between a hairline and a heavy rule, every letter checked against the
same straightedge, with the shop line justified underneath like a sign painter's layout.
Its stacked form (STRAIGHT over a large EDGE) is the strongest patch of the three; its mark
is an S E monogram between the same two rules.

### C · The Bar  (`c-bar-*.svg`)
STRAIGHT and EDGE separated by the straightedge itself — a ground bar standing proud of the
letters, the only element in color. The glyph is S ▌E. It is the most literal of the three
and the easiest to paint on a truck door, at the cost of a weaker stand-alone mark.

## Files

Each direction ships in six forms, color and one-color (`-1c`):

| file suffix | use |
|---|---|
| `-horizontal` | primary lockup with the shop line (MANUFACTURING / WAUCONDA, ILLINOIS) |
| `-horizontal-compact` | same, without the shop line — use below 40 mm (packing slips, headers) |
| `-stacked` | square-ish lockup for patches, signs, social avatars |
| `-mark` | glyph only — favicon, hat, stamp, part marking |

One-color files are filled with `currentColor`: they are black on their own, and turn white
(or any color) when inlined in HTML/CSS with `color:` set. `favicon.svg` is direction A with the
S counters opened a hair so it stays clear at 16 px.

Every file is hand-structured SVG with a tight viewBox (no padding — see clear space) and all
lettering converted to outlines, so nothing depends on an installed font.

## Type

**Barlow** (Jeremy Tribby, SIL Open Font License) — a low-contrast grotesk drawn from California
highway and public signage lettering, which is exactly the sign-painter register this brand wants.
The family's width axis gives each direction its own cut without leaving one family:

| direction | wordmark | secondary line |
|---|---|---|
| A · Dead Square | Barlow Bold (700), +2 % tracking | Barlow SemiBold (600), +26 % tracking |
| B · Ruled | Barlow Semi Condensed Bold (700), +4 % | Barlow SemiBold (600), justified to the rule |
| C · The Bar | Barlow Condensed Bold (700), +3 % | Barlow SemiBold (600), justified to the lockup |

Google Fonts: `https://fonts.googleapis.com/css2?family=Barlow:wght@600;700&family=Barlow+Semi+Condensed:wght@700&family=Barlow+Condensed:wght@700`.
If the site adopts direction A, swap `--font-display` in `global.css` from Space Grotesk to
Barlow so headings and the mark share a voice. The SVGs do not need the font — the text is outlined.

## Color

Two colors plus black and white.

| name | hex | nearest Pantone | CMYK (approx.) | role |
|---|---|---|---|---|
| Ink | `#0F172A` | Black 6 C (or 5395 C) | 90 / 75 / 45 / 70 | wordmark, body, one-color print |
| Layout Blue | `#1F418F` | 7687 C | 95 / 80 / 5 / 5 | the mark, rules, bar — the one brand color |
| Plate Gray | `#6B7280` | Cool Gray 9 C | 0 / 0 / 0 / 65 | secondary line only; never for the mark |
| White | `#FFFFFF` | — | — | reverse / paper |

**Why Layout Blue instead of the current teal (`#0E7490`).** Teal is a web-app color; it reads
"startup" and it cannot be matched on a hat or a truck without looking like a clearance tent.
Layout Blue is the color of Dykem layout fluid — the blue a machinist paints on stock before
scribing lines against a straightedge. It is an in-the-trade reference, prints as a solid
spot color, embroiders in a standard navy/royal thread, and holds contrast on white and on
Ink. It is also calmer and more credible to an OEM purchasing manager than teal. If adopted,
set `--accent: #1F418F` and `--accent-dark: #16326F` in `client/src/styles/global.css`
(`--accent-light`/`--accent-bg` to `#E8EEFA` / `#F3F6FC`) so buttons and links agree with the mark.

## Sizes

| form | minimum print | minimum screen |
|---|---|---|
| mark | 8 mm | 16 px |
| horizontal compact | 20 mm wide | 76 px wide |
| horizontal (with shop line) | 40 mm wide | 150 px wide |
| stacked | 25 mm wide | 100 px wide |

Below the minimum for a form, step down to the next form (horizontal → compact → mark).
The shop line is the first thing to go; the name must never be set below 1.4 mm cap height
in print. Embroidery: use the one-color mark or the stacked lockup, minimum 50 mm wide,
satin stitch — the square S is a single filled shape with no detail finer than 1/7 of its side.

## Clear space

Keep a margin equal to **¼ of the mark's height** on all sides of any lockup (for A, that is
one quarter of the square's side; for B and C, one quarter of the cap height). The viewBoxes
are tight to the artwork so this must be added by whatever places the file. Nothing else sits
inside that margin — not a rule, not a photo edge, not a tagline.

Do not: rotate it, outline it, add a drop shadow, put the color mark on a photograph without a
white or Ink panel behind it, recolor the S, or set the name in any other face.

## Recommendation: A · Dead Square

1. It is the only direction with a true **stand-alone mark**: a hat, a part stamp, an app icon,
   a packing-slip corner all read "Straightedge" from the square S alone — B and C both fall
   back to two letters, which is what every other shop in the directory does.
2. It carries **both meanings** in one shape with no explaining: straight strokes, dead square.
   Nobody has to be told about the owner's story for it to work, and it is not a subculture symbol.
3. It is the **most durable at small size** — in the sheet it is the one form that is still
   obviously itself at 10 mm and 16 px, because it is a solid block with four cuts in it.
4. It **embroiders and paints** better than anything with a hairline: one filled square, one thread,
   no rules to drift.
5. It looks like a company that will be here in twenty years — closer to a Starrett or a
   Brown & Sharpe plate than to a SaaS header, which is the audience's frame of reference.

B is the runner-up and would be the better choice if the owner wants a wordmark-first brand with
no symbol; its stacked patch is handsome. C is a fine truck-door layout but the S▌E mark is the
weakest of the three on its own.

The site component (`client/src/components/Wordmark.jsx`) and `client/public/favicon.svg`
have been switched to direction A. The three directions' source geometry lives in
`scripts/brand/` and can be regenerated with `npm install && node build.js ../../client/public/brand`
from that folder.
