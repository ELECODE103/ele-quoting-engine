/**
 * Copy and reference data for the /materials/:slug pages.
 *
 * THIS IS THE ONLY FILE A COPYWRITER NEEDS TO EDIT for the material pages.
 * Components (pages/MaterialPage.jsx), page titles/descriptions, the FAQ
 * structured data and the sitemap are all generated from it.
 *
 * Rules this file follows - keep them when editing:
 *
 *  1. A page is only published when its `cncSlug` / `routingSlug` exists and is
 *     active in the catalog (server/config/defaults.js, via
 *     data/catalog.generated.json). Stock forms, grades and sheet thicknesses
 *     shown on the page come from the catalog, never from this file.
 *  2. Property numbers are typical values copied from a published datasheet,
 *     with the source named and linked in `datasheets[].source`. One datasheet
 *     per column. Do not mix numbers from different sheets in one column and
 *     do not round "towards" a competitor's page. `null` renders as
 *     "not listed" - prefer that to a number from memory.
 *  3. Nothing here may claim a certification or FDA/NSF/USDA compliance of
 *     Straightedge parts. Food-contact text is about the stock material in
 *     general terms only.
 *  4. Any statement about what THIS SHOP does or will hold (tolerances,
 *     finishes, paperwork) comes from a fact flag in shared/shop-facts.json
 *     via ../facts and only prints once the owner has confirmed it. Do not
 *     type a shop tolerance into this file.
 *
 * Datasheet values were retrieved on 2026-11-09 (see `retrieved`).
 */

import { when, lines, toleranceFor } from '../facts';

// Shown under every property table.
export const TYPICAL_VALUES_NOTE =
  'Typical values from the datasheet named above, for unfilled natural material at room temperature. ' +
  'They are not a specification. Grades, colors, fillers and stock makers differ, so confirm against the ' +
  'datasheet for the grade you will actually buy before designing to a number.';

// General food-contact wording, appended to every material's own note.
export const FOOD_CONTACT_GENERAL =
  'Food-contact status belongs to a specific grade, color and lot from the stock manufacturer, not to the polymer family. ' +
  'If your part touches food or drinking water, say so on the quote request and name the regulation your customer cites. ' +
  when('food-docs',
    'The stock manufacturer\'s compliance statement and the lot cert come with the job. ',
    'You will be told before you order what paperwork can be had for that stock. ') +
  'A machine shop cannot certify a finished part for food contact, and this one does not claim to.';

// Shop tolerance for a material. Prints a number only when the owner has
// confirmed that material's row (tol-* in shared/shop-facts.json).
function tol(key) {
  const t = toleranceFor(key);
  if (!t) return 'Call out the dimensions that matter on a firm-quote request, and the tolerance for them is agreed before you order.';
  return `Standard tolerance on ${t.material} here is ${t.standard}` + (t.tight ? `; the tightest quoted is ${t.tight}.` : '.');
}

const ENSINGER = 'Ensinger';
const RETRIEVED = '2026-11-09';

export const MATERIAL_PAGES = [
  // ─────────────────────────────────────────────────────────────── Acetal
  {
    slug: 'acetal-delrin',
    cncSlug: 'cnc-delrin',
    routingSlug: 'rt-delrin',
    name: 'Acetal / Delrin (POM)',
    shortName: 'acetal',
    metaTitle: 'Acetal & Delrin (POM) CNC Machining',
    metaDescription:
      'CNC machined and routed acetal and Delrin (POM) parts from Wauconda, Illinois. Typical datasheet properties, machining notes, stock forms, and instant online pricing.',
    h1: 'Acetal and Delrin (POM) machining',
    summary:
      'Acetal (polyoxymethylene, POM) is a stiff, low-friction, dimensionally stable engineering plastic. ' +
      'It is sold as copolymer (often just called acetal) and as homopolymer (Delrin is the best-known brand). ' +
      'It absorbs little water and cuts cleanly, which makes it a common first choice for machined plastic parts.',
    uses: [
      'Bushings, bearings, rollers and wear pads',
      'Gears, cams and sprockets under light to moderate load',
      'Clamps, saddles, brackets and fixture blocks',
      'Manifolds, valve bodies and housings',
      'Spacers, standoffs and electrical insulators',
    ],
    datasheets: [
      {
        column: 'Acetal copolymer (POM-C)',
        source: { maker: ENSINGER, product: 'TECAFORM AH natural', url: 'https://www.ensingerplastics.com/en-us/shapes/acetal-tecaform-ah-natural', retrieved: RETRIEVED },
        density: '1.41 g/cm³',
        tensile: '9,300 psi at yield (ASTM D638)',
        serviceTemp: '195 °F long term; 285 °F intermittent',
        waterAbsorption: '0.18% in 24 h; 0.80% at saturation (ASTM D570)',
        friction: '0.21 dynamic (ASTM D3702)',
      },
      {
        column: 'Acetal homopolymer (POM-H, Delrin resin)',
        source: { maker: ENSINGER, product: 'TECAFORM AD natural', url: 'https://www.ensingerplastics.com/en-us/shapes/acetal-tecaform-ad-natural-', retrieved: RETRIEVED },
        density: '1.41 g/cm³',
        tensile: '11,000 psi at yield (ASTM D638)',
        serviceTemp: '185 °F long term; 300 °F intermittent',
        waterAbsorption: '0.25% in 24 h; 0.90% at saturation (ASTM D570)',
        friction: '0.20 dynamic (ASTM D3702)',
      },
    ],
    wear:
      'Low friction against steel and good wear life without lubrication. Homopolymer is somewhat stiffer and stronger; ' +
      'copolymer is less prone to centerline porosity in thick rod and plate and holds up better in hot water and alkaline cleaners.',
    foodContact:
      'Natural (unpigmented) acetal grades are commonly offered by stock manufacturers with FDA food-contact compliance statements; black and filled grades often are not.',
    machining: [
      'One of the easiest plastics to machine. It forms a clean chip, takes a good finish straight off the cutter and deburrs easily.',
      'Dimensionally stable for a plastic, so it is the usual choice when a plastic part needs to hold a dimension. ' + tol('acetal-delrin'),
      'Thick plate and large-diameter rod carry internal stress from extrusion. Removing a lot of material from one side can let a part bow; roughing both sides and letting the part rest before the finish pass reduces this.',
      'Homopolymer rod and plate can have centerline porosity. If a part is cut through the middle of thick stock and the surface there matters (seal faces, pressure passages), ask for copolymer.',
      'Not suitable for strong acids or chlorine service. It cannot be reliably glued; design for fasteners or press fits.',
    ],
    toleranceAnswer:
      'Acetal is among the most dimensionally stable of the common machined plastics. ' + tol('acetal-delrin') +
      ' Tighter requests are reviewed on a firm quote with the drawing.',
  },

  // ─────────────────────────────────────────────────────────────── UHMW
  {
    slug: 'uhmw',
    cncSlug: 'cnc-uhmw',
    routingSlug: 'rt-uhmw',
    name: 'UHMW-PE',
    shortName: 'UHMW',
    metaTitle: 'UHMW-PE CNC Machining & Routing',
    metaDescription:
      'UHMW polyethylene wear strips, guides and liners, CNC machined and routed from sheet in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'UHMW polyethylene machining and routing',
    summary:
      'UHMW-PE (ultra-high-molecular-weight polyethylene) is a soft, very slippery, highly abrasion-resistant plastic. ' +
      'It takes impact without cracking and absorbs almost no water. It is used where parts slide, rub or get hit, ' +
      'and where holding a tight dimension matters less than wear life.',
    uses: [
      'Conveyor guides, wear strips and lane dividers',
      'Chute, hopper and bin liners',
      'Guide rails and corner tracks on packaging lines',
      'Bumpers, slide pads and dock components',
      'Cutting and work surfaces',
    ],
    datasheets: [
      {
        column: 'UHMW-PE (PE 1000)',
        source: { maker: ENSINGER, product: 'TECAFINE PE1000 natural', url: 'https://www.ensingerplastics.com/en-gb/shapes/polyethylene-tecafine-pe-1000-natural', retrieved: RETRIEVED },
        density: '0.93 g/cm³',
        tensile: '19 MPa at yield, about 2,750 psi (ISO 527)',
        serviceTemp: 'up to 80 °C (176 °F)',
        waterAbsorption: '0.01% (ISO 62)',
        friction: null,
      },
    ],
    wear:
      'Among the most abrasion-resistant unfilled plastics and very low friction against steel, which is why it is the standard wear-strip material. ' +
      'The datasheet above does not list a friction coefficient.',
    foodContact:
      'Natural UHMW is widely sold with FDA and EU 10/2011 food-contact statements from the stock manufacturer (the datasheet cited above makes that statement for its product). Black and reprocessed grades usually are not.',
    machining: [
      'Soft and springy. It pushes away from the cutter and tends to leave a fuzzy burr, so sharp tools and a clean-up pass matter more than on acetal.',
      'Thermal expansion is high (roughly ten times that of steel). A long strip measured in a cold shop and installed on a warm line will be a different length; dimension long parts with that in mind.',
      'Sheet is skived or pressed and is rarely flat; thick sheet can move when one face is machined away. Flatness callouts on large UHMW parts should be generous.',
      'It will not hold a fine thread well and cannot be glued. Use through-bolts, inserts or mechanical capture.',
      'Realistic tolerances are looser than for acetal. If a dimension on a UHMW part is critical, call it out on the drawing so it can be reviewed before the job is quoted.',
    ],
    toleranceAnswer:
      'UHMW is soft and moves with temperature, so realistic tolerances are looser than for acetal or nylon. ' + tol('uhmw') +
      ' On UHMW, call out any critical dimension so it is reviewed on a firm quote rather than assumed.',
  },

  // ─────────────────────────────────────────────────────────────── HDPE
  {
    slug: 'hdpe',
    cncSlug: 'cnc-hdpe',
    routingSlug: 'rt-hdpe',
    name: 'HDPE',
    shortName: 'HDPE',
    metaTitle: 'HDPE CNC Routing & Machining',
    metaDescription:
      'HDPE trays, panels, cutting surfaces and tank parts, CNC routed from sheet and machined in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'HDPE routing and machining',
    summary:
      'HDPE (high-density polyethylene) is an inexpensive, tough, chemical-resistant sheet plastic. ' +
      'It is lighter than water, absorbs essentially none of it, and is easy to cut in volume. ' +
      'It is not stiff and not a precision material; it is chosen for cost, toughness and chemical resistance.',
    uses: [
      'Trays, nests, totes and dunnage',
      'Cutting boards and food-prep surfaces',
      'Tank, splash and chemical-area parts',
      'Outdoor and marine panels (marine-board grades)',
      'Spacers, shims and low-load wear parts',
    ],
    datasheets: [
      {
        column: 'HDPE',
        source: { maker: ENSINGER, product: 'TECAFINE HDPE natural', url: 'https://www.ensingerplastics.com/en-us/shapes/polyethylene-tecafine-hdpe-natural', retrieved: RETRIEVED },
        density: '0.95 g/cm³',
        tensile: '3,700 psi at yield (ASTM D638)',
        serviceTemp: 'Listed as 248 °F long-term maximum. Heat deflection temperature is 167 °F at 66 psi (ASTM D648), so loaded parts soften far below the listed maximum.',
        waterAbsorption: null,
        friction: null,
      },
    ],
    wear:
      'Slippery and reasonably wear-resistant, but well short of UHMW. For a sliding part that sees real abrasion, UHMW is the usual upgrade. ' +
      'The datasheet above describes moisture absorption only as "low" and does not list a friction coefficient.',
    foodContact:
      'Natural HDPE sheet is commonly sold with FDA food-contact statements and is the usual cutting-board material; colored and marine-board grades vary by manufacturer.',
    machining: [
      'Cuts fast and cleanly on a router with sharp single-flute tooling. Chips are stringy and edges can carry a light burr that is trimmed after cutting.',
      'Low stiffness and high thermal expansion. It is not a material for tight tolerances or for parts that must stay flat over a long span.',
      'Sheet has residual stress from extrusion. Deep pockets or heavy one-sided cuts can let a part cup; balanced pocketing and leaving a floor thicker than a third of the sheet helps.',
      'Paint, adhesive and most inks do not stick to it. Mark by engraving and join with fasteners or plastic welding.',
    ],
    toleranceAnswer:
      'HDPE is soft and expands with temperature, so it is not a precision material. ' + tol('hdpe'),
  },

  // ─────────────────────────────────────────────────────────────── Nylon
  {
    slug: 'nylon',
    cncSlug: 'cnc-nylon',
    routingSlug: 'rt-nylon',
    name: 'Nylon 6/6 and cast nylon 6',
    shortName: 'nylon',
    metaTitle: 'Nylon 6/6 & Cast Nylon CNC Machining',
    metaDescription:
      'CNC machined nylon 6/6 and cast nylon 6 gears, rollers, bushings and wear parts from Wauconda, Illinois. Typical datasheet properties, moisture and machining notes, instant pricing.',
    h1: 'Nylon 6/6 and cast nylon machining',
    summary:
      'Nylon (polyamide) is a strong, tough bearing and wear plastic. Extruded nylon 6/6 is the common rod and plate grade; ' +
      'cast nylon 6 is used for larger blocks, plates and rounds. Both absorb moisture from the air and change size as they do, ' +
      'which is the main thing to design around.',
    uses: [
      'Gears, sprockets and sheaves',
      'Rollers, wheels and bushings',
      'Wear pads and slide blocks under load',
      'Structural spacers and insulators that take impact',
      'Large rings and blocks (cast nylon)',
    ],
    datasheets: [
      {
        column: 'Nylon 6/6, extruded',
        source: { maker: ENSINGER, product: 'TECAMID 66 natural', url: 'https://www.ensingerplastics.com/en-us/shapes/pa66-tecamid-66-natural', retrieved: RETRIEVED },
        density: '1.14 g/cm³',
        tensile: '12,000 psi at yield (ASTM D638)',
        serviceTemp: '185 °F long term; 300 °F short term',
        waterAbsorption: '0.45% in 24 h; 8.5% at saturation (ASTM D570)',
        friction: '0.26 dynamic (ASTM D3702)',
      },
      {
        column: 'Cast nylon 6',
        source: { maker: ENSINGER, product: 'TECAST T natural', url: 'https://www.ensingerplastics.com/en-us/shapes/pa6-tecast-t-natural', retrieved: RETRIEVED },
        density: '1.14 g/cm³',
        tensile: '12,000 psi at yield (ASTM D638)',
        serviceTemp: '200 °F long term; 300 °F intermittent',
        waterAbsorption: '1.2% in 24 h; 5.5% at saturation (ASTM D570)',
        friction: '0.26 dynamic (ASTM D3702)',
      },
    ],
    wear:
      'Good wear life and load capacity for an unfilled plastic. Oil-filled and molybdenum-disulfide-filled grades are sold for bearings that run dry.',
    foodContact:
      'Some natural nylon 6/6 and cast nylon grades are offered with FDA food-contact statements; filled and lubricated grades generally need to be checked individually.',
    machining: [
      'Machines well with sharp tools but is tougher and stringier than acetal; burrs take more work to remove.',
      'Moisture is the main issue. Nylon takes up water from the air over weeks and grows as it does, so a part can be in tolerance when machined and measurably larger in humid or wet service. Say what environment the part lives in.',
      'Because of that, very tight tolerances on nylon are only meaningful if the measurement condition is stated. ' + tol('nylon'),
      'Cast nylon has lower internal stress than extruded and is the better choice for large or thick parts and for parts with a lot of material removed.',
      'For a part that must hold size in wet service, acetal is usually the better material.',
    ],
    toleranceAnswer:
      'Nylon absorbs moisture and grows, so a tolerance on nylon needs a stated condition (as machined and dry, or conditioned). ' + tol('nylon') +
      ' If the part runs wet or humid, say so on the request.',
  },

  // ─────────────────────────────────────────────────────────────── PEEK
  {
    slug: 'peek',
    cncSlug: 'cnc-peek',
    routingSlug: null,
    name: 'PEEK',
    shortName: 'PEEK',
    metaTitle: 'PEEK CNC Machining',
    metaDescription:
      'CNC machined unfilled PEEK parts from Wauconda, Illinois: seals, bushings, insulators and pump parts. Typical datasheet properties, machining notes and instant online pricing.',
    h1: 'PEEK machining',
    summary:
      'PEEK (polyetheretherketone) is a high-performance thermoplastic that keeps its strength at temperatures where most plastics have softened. ' +
      'It resists most chemicals, absorbs very little water and wears well. The stock is expensive, so it is used where a cheaper plastic will not survive.',
    uses: [
      'Seals, seats and back-up rings',
      'Bushings and bearings in hot or chemical service',
      'Pump, valve and compressor components',
      'Electrical insulators and connector bodies',
      'Fixtures for hot or chemically aggressive processes',
    ],
    datasheets: [
      {
        column: 'PEEK, unfilled',
        source: { maker: ENSINGER, product: 'TECAPEEK natural', url: 'https://www.ensingerplastics.com/en-us/shapes/products/peek-tecapeek-natural', retrieved: RETRIEVED },
        density: '1.31 g/cm³',
        tensile: '16,000 psi at yield (ASTM D638)',
        serviceTemp: '480 °F long term; 572 °F short term',
        waterAbsorption: '0.03% in 24 h; 0.45% at saturation',
        friction: '0.20 to 0.25 (ASTM D3702)',
      },
    ],
    wear:
      'Good wear resistance unfilled; bearing grades with carbon fiber, graphite and PTFE are sold for higher loads and speeds.',
    foodContact:
      'Stock manufacturers offer specific PEEK grades with food-contact and medical documentation. Those are particular products with their own paperwork, not a property of PEEK in general.',
    machining: [
      'Machines to a good finish and holds dimensions well, closer to a soft metal than to most plastics.',
      'Extruded rod and plate carry internal stress. Stock is normally supplied annealed; for parts with heavy material removal or thin sections, roughing, resting and then finishing reduces movement.',
      'It is notch-sensitive compared with nylon. Inside corners should carry a radius, and thin features should not be designed with sharp roots.',
      'Material is most of the price. A drawing that lets the stock be sized closely, or a design that nests in standard rod or plate sizes, makes a real difference.',
      tol('peek'),
    ],
    toleranceAnswer:
      'PEEK is stable and holds dimensions well for a plastic. ' + tol('peek') +
      ' Tighter requirements are reviewed on a firm quote with the drawing.',
  },

  // ─────────────────────────────────────────────────────────────── Ultem
  {
    slug: 'ultem-pei',
    cncSlug: 'cnc-ultem',
    routingSlug: null,
    name: 'Ultem (PEI)',
    shortName: 'Ultem',
    metaTitle: 'Ultem (PEI) CNC Machining',
    metaDescription:
      'CNC machined Ultem (PEI) insulators, fixtures and housings from Wauconda, Illinois. Typical datasheet properties, machining notes and instant online pricing.',
    h1: 'Ultem (PEI) machining',
    summary:
      'PEI (polyetherimide; Ultem is the best-known resin brand) is a strong, stiff, amber-transparent plastic that stays rigid at elevated temperature ' +
      'and is a good electrical insulator. It sits between the commodity engineering plastics and PEEK in both performance and cost.',
    uses: [
      'Electrical insulators and connector bodies',
      'High-temperature fixtures and tooling',
      'Manifolds and housings that need to stay rigid when warm',
      'Parts that go through repeated cleaning or sterilization cycles',
    ],
    datasheets: [
      {
        column: 'PEI, unfilled',
        source: { maker: ENSINGER, product: 'TECAPEI natural', url: 'https://www.ensingerplastics.com/en-us/shapes/tecapei-natural', retrieved: RETRIEVED },
        density: '1.27 g/cm³',
        tensile: '17,500 psi at break (ASTM D638)',
        serviceTemp: '338 °F long term; 392 °F short term',
        waterAbsorption: '0.25% in 24 h; 1.25% at saturation (ASTM D570)',
        friction: null,
      },
    ],
    wear:
      'Not a bearing material. Unfilled PEI has poor wear resistance in sliding contact; the datasheet above does not list a friction coefficient.',
    foodContact:
      'Specific PEI grades are sold with food-contact documentation. Check the grade; do not assume it from the polymer name.',
    machining: [
      'Machines cleanly and holds size well.',
      'It is notch-sensitive and can stress-crack. Inside corners need a radius, and cutting fluids and cleaners have to be compatible; some solvents craze it.',
      'Extruded stock carries internal stress. Thick sections with heavy material removal benefit from roughing and resting before the finish pass.',
      tol('ultem-pei'),
    ],
    toleranceAnswer:
      'PEI is rigid and dimensionally stable. ' + tol('ultem-pei') + ' Tighter requirements are reviewed on a firm quote with the drawing.',
  },

  // ─────────────────────────────────────────────────────────────── PTFE
  {
    slug: 'ptfe',
    cncSlug: 'cnc-ptfe',
    routingSlug: null,
    name: 'PTFE',
    shortName: 'PTFE',
    metaTitle: 'PTFE CNC Machining',
    metaDescription:
      'CNC machined virgin PTFE seals, seats, slide pads and insulators from Wauconda, Illinois. Typical datasheet properties, machining notes and instant online pricing.',
    h1: 'PTFE machining',
    summary:
      'PTFE (polytetrafluoroethylene; Teflon is the best-known brand) has very low friction, a very wide temperature range and resistance to almost all chemicals. ' +
      'It is also soft, weak and creeps under load. It is chosen for chemical, thermal or sliding duty, not for strength.',
    uses: [
      'Seals, gaskets and valve seats',
      'Slide pads and low-friction liners',
      'Chemical-service fittings and spacers',
      'High-temperature and high-frequency electrical insulators',
    ],
    datasheets: [
      {
        column: 'PTFE, virgin',
        source: { maker: ENSINGER, product: 'TECAFLON PTFE natural', url: 'https://www.ensingerplastics.com/en/shapes/tecaflon-ptfe-natural', retrieved: RETRIEVED },
        density: '2.15 g/cm³',
        tensile: '22 MPa, about 3,200 psi (ASTM D4894)',
        serviceTemp: '260 °C (500 °F)',
        waterAbsorption: '0.01% (ASTM D570)',
        friction: null,
      },
    ],
    wear:
      'Very low friction, but unfilled PTFE wears quickly and cold-flows under sustained load. Glass-, carbon- and bronze-filled grades are sold for wear and creep resistance. ' +
      'The datasheet above does not list a friction coefficient.',
    foodContact:
      'Virgin PTFE is commonly sold with FDA food-contact statements from the stock manufacturer; filled grades need to be checked individually.',
    machining: [
      'Cuts easily but is very soft. It deflects under clamping and cutting pressure, so parts are held lightly and thin walls are hard to keep round.',
      'It has a volume change near room temperature (around 66 °F / 19 °C) and high thermal expansion, so a measurement depends on the temperature it is taken at.',
      'It creeps under load. A dimension that is right after machining can relax under a clamped joint or a press fit.',
      'For those reasons, realistic tolerances on PTFE are wide. If a dimension is critical, call it out so it is reviewed before the job is quoted.',
      'It cannot be glued without special surface treatment.',
    ],
    toleranceAnswer:
      'PTFE is soft, creeps and changes size with temperature, so tolerances are wider than for rigid plastics. ' + tol('ptfe') +
      ' On PTFE, call out any critical dimension so it is reviewed on a firm quote rather than assumed.',
  },

  // ─────────────────────────────────────────────────────────────── Polycarbonate
  {
    slug: 'polycarbonate',
    cncSlug: 'cnc-polycarbonate',
    routingSlug: 'rt-polycarbonate',
    name: 'Polycarbonate',
    shortName: 'polycarbonate',
    metaTitle: 'Polycarbonate CNC Machining & Routing',
    metaDescription:
      'Polycarbonate machine guards, windows, covers and housings, CNC routed and machined in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'Polycarbonate machining and routing',
    summary:
      'Polycarbonate (PC) is a clear, very impact-resistant plastic. It is the usual choice for guards and windows that must not shatter, ' +
      'and it machines into housings and covers. It scratches more easily than acrylic and is attacked by some solvents and cleaners.',
    uses: [
      'Machine guards and safety shields',
      'Sight windows and inspection covers',
      'Housings, enclosures and manifolds you need to see into',
      'Electrical covers and insulating barriers',
    ],
    datasheets: [
      {
        column: 'Polycarbonate, unfilled',
        source: { maker: ENSINGER, product: 'TECANAT natural', url: 'https://www.ensingerplastics.com/en-us/shapes/tecanat-natural', retrieved: RETRIEVED },
        density: '1.19 g/cm³',
        tensile: '9,300 psi at yield (ASTM D638)',
        serviceTemp: '250 °F long term; 275 °F intermittent',
        waterAbsorption: '0.07% in 24 h; 0.35% at saturation (ASTM D570)',
        friction: '0.38 dynamic (ASTM D3702)',
      },
    ],
    wear:
      'Not a bearing material: friction is high for a plastic and the surface scratches. Hard-coated sheet is sold for abrasion resistance on windows.',
    foodContact:
      'Some polycarbonate grades are sold with food-contact statements. Check the specific sheet or rod product.',
    machining: [
      'Machines and routes well with sharp tools. Machined faces come off the cutter frosted, not clear; optical clarity on a cut face takes polishing as a separate step.',
      ...lines([{ needs: 'edge-polish' }]),
      'It is sensitive to stress cracking. Some coolants, thread lockers, cleaners and solvents will craze it, especially around stressed holes and tight fasteners.',
      'Thick machined parts hold internal stress; stress-relieving before polishing or solvent exposure reduces cracking.',
      'Use generous inside radii and avoid sharp-rooted threads in highly loaded areas.',
      tol('polycarbonate'),
    ],
    toleranceAnswer:
      'Polycarbonate is rigid and holds size well. ' + tol('polycarbonate') + ' Tighter requirements are reviewed on a firm quote with the drawing.',
  },

  // ─────────────────────────────────────────────────────────────── Acrylic
  {
    slug: 'acrylic',
    cncSlug: 'cnc-acrylic',
    routingSlug: 'rt-acrylic',
    name: 'Cast acrylic (PMMA)',
    shortName: 'acrylic',
    metaTitle: 'Cast Acrylic CNC Machining & Routing',
    metaDescription:
      'Cast acrylic (PMMA) windows, covers, displays and light guides, CNC routed and machined in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'Cast acrylic machining and routing',
    summary:
      'Acrylic (PMMA) is a rigid, optically clear plastic with good scratch and weather resistance. ' +
      'Cast sheet is the grade used for machining because it cuts cleanly and carries less internal stress than extruded sheet. ' +
      'It is brittle compared with polycarbonate.',
    uses: [
      'Windows, sight panels and covers',
      'Displays and signage',
      'Light guides and lenses',
      'Cosmetic covers and nameplates',
    ],
    datasheets: [
      {
        column: 'Cast acrylic sheet',
        source: { maker: 'CYRO Industries', product: 'ACRYLITE GP acrylic sheet', url: 'https://www.tapplastics.com/uploads/pdf/GP%20Physical%20Properties.pdf', retrieved: RETRIEVED },
        density: '1.19 (specific gravity, ASTM D792)',
        tensile: '10,000 psi (ASTM D638)',
        serviceTemp: '180 °F maximum recommended continuous service',
        waterAbsorption: '0.2% in 24 h (ASTM D570)',
        friction: null,
      },
    ],
    wear:
      'Harder and more scratch-resistant than polycarbonate, but not a wear or bearing material. The datasheet above does not list a friction coefficient.',
    foodContact:
      'Some acrylic sheet products are sold with food-contact statements. Check the specific sheet product.',
    machining: [
      'Cast acrylic machines and routes to a clean, matte edge. A cut edge is not clear until it is polished.',
      ...lines([{ needs: 'edge-polish' }]),
      'It is brittle and notch-sensitive. Inside corners need a radius, holes should sit well in from an edge, and fasteners should not be over-tightened.',
      'Heat from cutting and some solvents and cleaners can craze the surface, sometimes days later. Annealing after heavy machining reduces that risk.',
      'Thickness tolerance of cast sheet is wide. If the thickness matters, it has to be machined, not taken from the sheet.',
      tol('acrylic'),
    ],
    toleranceAnswer:
      'Acrylic is rigid and machines to size well, but cast sheet thickness varies as supplied. ' + tol('acrylic') +
      ' If the thickness is critical, say so, because it then has to be machined.',
  },

  // ─────────────────────────────────────────────────────────────── PVC
  {
    slug: 'pvc',
    cncSlug: 'cnc-pvc',
    routingSlug: 'rt-pvc',
    name: 'PVC Type 1',
    shortName: 'PVC',
    metaTitle: 'PVC Type 1 CNC Machining & Routing',
    metaDescription:
      'Rigid PVC Type 1 manifolds, tank parts, fixtures and panels, CNC machined and routed in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'PVC machining and routing',
    summary:
      'Rigid PVC (Type 1, usually gray) is a stiff, inexpensive plastic with broad chemical resistance. ' +
      'It can be solvent-cemented and welded, which makes it common in tanks, plating lines and fluid handling. Its temperature limit is low.',
    uses: [
      'Chemical tank parts, covers and baffles',
      'Manifolds, valve bodies and fluid fittings',
      'Plating and wash-line fixtures',
      'Panels, spacers and electrical barriers',
    ],
    datasheets: [
      {
        column: 'PVC Type 1',
        source: { maker: 'Vycom', product: 'Vintec I PVC', url: 'https://www.polymershapes.com/wp-content/uploads/2020/04/Polymershapes_Vycom_Data-Sheet-Vintec-I.pdf', retrieved: RETRIEVED },
        density: '1.42 g/cm³ (ASTM D792)',
        tensile: '7,500 psi at yield',
        serviceTemp: 'Not listed. Heat deflection temperature is 176 °F at 264 psi (ASTM D648).',
        waterAbsorption: '0.06% (ASTM D570)',
        friction: null,
      },
    ],
    wear:
      'Not a wear material. The datasheet above does not list a friction coefficient.',
    foodContact:
      'Standard gray Type 1 PVC is an industrial grade. Food and potable-water use requires a specific listed product; do not assume it.',
    machining: [
      'Machines easily to a good finish and holds size reasonably well.',
      'It softens at a low temperature. Sharp tools and good chip clearance keep the cut from heating and smearing.',
      'Overheating PVC releases corrosive fumes, so it is cut conservatively and never laser-cut.',
      'It is more brittle than polyethylene or nylon, especially when cold. Avoid sharp inside corners and thin unsupported tabs.',
      'Expanded (foamed) PVC sheet is a different material: light, soft and intended for panels and signage, not for load.',
      tol('pvc'),
    ],
    toleranceAnswer:
      'Rigid PVC machines to size reasonably well. ' + tol('pvc') + ' Tighter requirements are reviewed on a firm quote with the drawing.',
  },

  // ─────────────────────────────────────────────────────────────── Polypropylene
  {
    slug: 'polypropylene',
    cncSlug: 'cnc-polypropylene',
    routingSlug: 'rt-polypropylene',
    name: 'Polypropylene',
    shortName: 'polypropylene',
    metaTitle: 'Polypropylene CNC Machining & Routing',
    metaDescription:
      'Polypropylene tank parts, chemical fixtures and lab components, CNC machined and routed in Wauconda, Illinois. Typical datasheet properties, machining notes and instant pricing.',
    h1: 'Polypropylene machining and routing',
    summary:
      'Polypropylene (PP) is a light, low-cost plastic with very good resistance to acids, bases and many solvents. ' +
      'It can be welded, absorbs almost no water and is lighter than water. It is flexible and not a precision material.',
    uses: [
      'Tank parts, covers and trays in chemical service',
      'Plating-line and lab fixtures',
      'Cutting and work surfaces',
      'Spacers and low-load parts in wet areas',
    ],
    datasheets: [
      {
        column: 'Polypropylene homopolymer',
        source: { maker: 'Röchling', product: 'Polystone P homopolymer natural (ASTM sheet)', url: 'https://www.roechling.com/fileadmin/assets/65/79/Polystone%C2%AE%20P%20homopolymer%20natural%20-%20ASTM%20%E2%80%93%20Technical%20Data%20Sheet%20(EN)%20%5B717965%5D.pdf', retrieved: RETRIEVED },
        density: '0.91 g/cm³ (ASTM D792)',
        tensile: '4,700 psi at yield (ASTM D638)',
        serviceTemp: '180 °F maximum in air',
        waterAbsorption: 'under 0.10% (ASTM D570)',
        friction: '0.25 to 0.28 dynamic',
      },
    ],
    wear:
      'Moderate. It slides acceptably but wears faster than UHMW or acetal in abrasive contact.',
    foodContact:
      'Natural polypropylene homopolymer sheet is commonly sold with FDA food-contact statements (the datasheet cited above lists FDA compliance for its product). Check the specific sheet.',
    machining: [
      'Cuts easily but is soft and gummy. It burrs, and it pushes away from the cutter on thin sections.',
      'High thermal expansion and residual stress in sheet mean flat parts can warp when material is removed unevenly. Balanced cuts and modest flatness callouts help.',
      'It becomes brittle in the cold and is notch-sensitive there; radius inside corners.',
      'It cannot be glued with ordinary adhesives. Join by welding or with fasteners.',
      'Realistic tolerances are looser than for acetal. If a dimension is critical, call it out so it is reviewed before the job is quoted.',
    ],
    toleranceAnswer:
      'Polypropylene is soft and moves with temperature, so it is not a precision material. ' + tol('polypropylene'),
  },
];

/*
 * Catalog materials that do not have a page yet (add an entry above to publish one):
 *   cnc-g10 / rt-g10 (G-10 / FR-4 glass epoxy), cnc-phenolic / rt-phenolic (canvas / linen phenolic).
 * They are thermoset laminates with NEMA-grade data, not thermoplastic stock-shape datasheets,
 * and no datasheet was pulled for them. 6061 and brass are metals and are out of scope for these pages.
 */
