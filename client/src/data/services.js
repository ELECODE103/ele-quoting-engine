// Copy for the three service pages (/machining, /routing, /3d-printing).
// Pure data: also read by seo/routes.js for titles, descriptions and Service JSON-LD.
//
// Integrity rule: a plain string ships as written, so it must be true whatever
// the owner answers (physics, a rule the quote tool enforces, or design advice).
// Anything only the owner can vouch for is an object { needs, text, or } and is
// resolved by facts.lines(): it shows when the fact is confirmed in
// shared/shop-facts.json, otherwise `or` shows, otherwise nothing.
import brand from '../../../shared/brand.json';
import { lines, ok, when, toleranceRows, MILLING, SLA_RESINS } from '../facts';

const LIMIT = brand.rfqQuantityThreshold;
const hasTolTable = toleranceRows().length > 0;
const turned = ok('turning');

const block = (h, items, note) => ({ h, items: lines(items), note });
const keep = (blocks) => blocks.filter((b) => b.items.length > 0);

export const SERVICES = {
  machining: {
    title: 'CNC machining',
    fullTitle: `CNC machining of Delrin, UHMW, nylon and PEEK | ${brand.name}, Illinois`,
    description: `CNC ${MILLING} of Delrin, UHMW, HDPE, nylon, PEEK and other plastics in ${brand.city}, Illinois. Upload a STEP file and see the price; card checkout to ${LIMIT} pieces. Over ${LIMIT}, a person quotes it.`,
    eyebrow: 'CNC machining, plastics first',
    h1: hasTolTable
      ? 'CNC machining for plastic. Tolerances stated by material.'
      : `Delrin, UHMW, nylon and PEEK parts, ${turned ? 'milled and turned' : 'machined'} in ${brand.city}, Illinois.`,
    lede: 'Plastic is not soft aluminum. It grows with heat, relaxes after the cut and smears under a dull tool. '
      + when(['practice-sharp-light', 'practice-rest'],
        (sharp) => `So: ${sharp}, parts left to sit before they are measured${ok('practice-programs-saved') ? ', and the program saved for your reorder' : ''}.`,
        'Upload a part and the price comes with a manufacturability check whose wall, corner and hole rules are set for plastic, not borrowed from metal.'),
    phoneNote: `Tolerance question? ${brand.phone} rings the shop.`,
    next: 'The button opens the quote tool. Drop in a STEP file and the price shows in a few seconds. Nothing is ordered until you check out.',
    hero: 'fourth-axis',
    tolerance: hasTolTable,
    blocks: keep([
      block('What belongs on a mill', [
        'Blocks, brackets, clamps, saddles, wear pads and guides in acetal, UHMW and nylon.',
        { needs: 'turning', text: 'Bushings, rollers, spacers and sleeves turned from rod: acetal, nylon, PTFE, PEEK.' },
        'Housings and manifolds in acetal, polycarbonate, PVC and polypropylene.',
        'PEEK and Ultem for heat, chemical or electrical duty. G-10 and phenolic when the part has to be stiff and insulating.',
        '6061 and brass are priced online too, for the part that mates with your plastic one.',
      ]),
      block('Machines and limits', [
        { needs: ['mill-tormach', 'mill-bridgeport'], text: (a, b) => `${a} and a ${b}, both 3-axis.` },
        { needs: 'fourth-axis', text: '4th-axis indexing for parts with work on more than one face.' },
        'The instant quote takes milled parts up to 18" × 9.5" × 12" (457 × 241 × 300 mm). Anything larger is quoted by a person.',
        { needs: 'lathe-capacity', text: (v) => `Round work: ${v}.` },
        { needs: 'threads-inserts' },
        `Up to ${LIMIT} pieces prices and checks out online. Over ${LIMIT}, a part the check fails, or a line over $5,000 goes to a person first.`,
      ]),
      block('Design notes that save you money', [
        'Inside corners carry a tool radius. The check asks for a radius of at least one third of the pocket depth, and the smallest cutter it allows is 1/16".',
        'Walls: 0.060" (1.5 mm) or more in most plastics. Under 0.040" (1.0 mm) gets flagged. Acrylic, G-10 and phenolic want 0.080" (2.0 mm).',
        'Pockets deeper than four times their width and holes deeper than four diameters cost more, and the check says so.',
        'Put the tight number only on the feature that needs it. That is where most of the price of a plastic part comes from.',
        'If the part is really a flat profile under 1" thick, routing usually costs less. Switch the process in the quote tool and the price changes on the screen.',
      ]),
    ]),
    aside: {
      h: 'What gets sent elsewhere',
      intro: 'Better you hear it here than after you have waited for a quote.',
      items: lines([
        'Square inside corners. Those are a broach or an EDM job, which this shop does not do.',
        'Heavy aluminum production. A metal shop will serve you better.',
        'A tolerance the material will not hold. Plastic expands five to ten times as much as steel for the same temperature change, so tell us where the part lives.',
        { needs: 'clean-down', text: (v) => `Metal and plastic share machines here. ${v}` },
        { needs: 'finishes-sent-out', text: (v) => `Finishes: ${v} A part with a sent-out finish ships on the standard lead time.` },
      ]),
    },
    chips: ['Delrin / acetal', 'UHMW', 'HDPE', 'Nylon 6/6 & cast', 'PEEK', 'Ultem (PEI)', 'PTFE', 'Polycarbonate', 'Acrylic', 'PVC', 'Polypropylene', 'G-10 / FR-4', 'Phenolic', '6061-T6', 'Brass 360'],
    gallery: ['acetal-clamps', 'dish-part', 'cups-lot'],
    related: [{ to: '/routing', label: 'Flat part? See CNC routing' }, { to: '/materials', label: 'Material guide' }, { to: '/replacement-parts', label: 'No drawing? Replacement parts' }],
  },

  routing: {
    title: 'CNC routing',
    fullTitle: `CNC routing of HDPE, UHMW and acetal sheet | ${brand.name}, Illinois`,
    description: `Flat plastic parts routed from HDPE, UHMW, acetal, polycarbonate and acrylic sheet in ${brand.city}, Illinois, with pockets and counterbores. Sheet from 1/16" to 1" priced online.`,
    eyebrow: 'CNC routing, sheet and plate',
    h1: 'Flat plastic parts cut from sheet, with pockets and counterbores.',
    lede: 'If your part is flat, cutting it from sheet on the router is usually the cheapest way to make it. Outline, pockets, holes and counterbores come off in one setup'
      + when('router-thickness', (v) => `, in stock from ${v} thick.`, '. Sheet from 1/16" to 1" thick is priced online.'),
    phoneNote: `Not sure it is a router part? ${brand.phone} rings the shop.`,
    next: 'The button opens the quote tool on routing. Drop in a STEP file, or a DXF of the outline and pick the thickness, and the check tells you how many of your part fit on a sheet.',
    hero: 'tray-stack-router',
    blocks: keep([
      block('What belongs on a router', [
        'Trays, nests and panels in HDPE.',
        'Guides, rails, lane dividers and wear strips in UHMW and acetal.',
        'Machine guards, windows and covers in polycarbonate and acrylic.',
        { needs: 'edge-polish' },
        'Spacers, templates and fixture plates in PVC, polypropylene, G-10 and phenolic.',
        { needs: 'router-aluminum' },
      ]),
      block('Machine and limits', [
        { needs: ['router-model', 'router-bed', 'router-spindle'], text: (m, b, s) => `${m}: ${b} bed, ${s}.` },
        'The quote tool takes flat parts up to 59" × 96" and 1" thick. Over 1" thick it is a milling job.',
        'The check nests your part on a 48" × 96" sheet and tells you how many fit.',
        { needs: 'tol-routing', text: (v) => `Profile tolerance ${v}. Large HDPE and UHMW parts move with temperature, so say what the part runs at.` , or: 'Large HDPE and UHMW parts move with temperature. Call out the dimensions that matter and say what the part runs at.' },
        'Inside corners carry the cutter radius: 1/32" in sheet up to 3/16" thick, 1/16" up to 1/2", 1/8" up to 1".',
        { needs: 'router-workholding' },
      ]),
      block('Design notes that save you money', [
        'Keep the web between cutouts at least half the sheet thickness, and never under 0.060". Thinner ones flex into the cutter and tear.',
        'A hole cannot be smaller than the cutter. Keep holes one diameter in from an edge.',
        'The check flags parts under about 1.5" across: they are tabbed into the sheet and trimmed by hand. Expect a small witness mark on one edge, and say which face matters.',
        'Engraved text needs strokes of 1/32" or wider. 1/16" cuts clean.',
        'Quantities that fill whole sheets price best.',
      ]),
    ]),
    aside: {
      h: 'What a router does that flat cutting does not',
      intro: 'A laser or a waterjet cuts straight through the sheet. A router cuts to a depth, and that is the difference between a flat blank and a finished part.',
      items: lines([
        'Pockets and steps that go partway through the sheet.',
        'Counterbores and recesses, so a fastener head sits below the surface.',
        'Thick stock. The quote tool prices sheet and plate up to 1" thick.',
        'Engraved part numbers and text.',
        'If your part is only an outline and through holes in thin sheet, you do not need any of this.',
      ]),
    },
    chips: ['HDPE', 'UHMW', 'Acetal / Delrin', 'Nylon', 'Polycarbonate', 'Acrylic (cast)', 'PVC & expanded PVC', 'Polypropylene', 'G-10 / FR-4', 'Phenolic', '6061 plate'],
    gallery: ['disc-router-bed', 'disc-stacks', 'hdpe-plate'],
    related: [{ to: '/machining', label: 'Not flat? See CNC machining' }, { to: '/materials', label: 'Material guide' }, { to: '/parts', label: 'Parts by type' }],
  },

  '3d-printing': {
    title: '3D printing',
    fullTitle: `FDM and SLA 3D printing in ${brand.city}, Illinois | ${brand.name}`,
    description: `FDM and SLA 3D printing in ${brand.city}, Illinois, for fit checks, fixtures and short runs before the production part is machined. Prices online.`,
    eyebrow: '3D printing, FDM and SLA',
    h1: 'Print the prototype. Machine the part.',
    lede: 'Printing is how you get a fit check in your hands before any plastic is cut, a fixture to hold the production part, or ten of something that does not justify a program.'
      + when('nothing-outsourced', ' Same shop, so the print and the machined part agree.'),
    phoneNote: `Print it or machine it? ${brand.phone} rings the shop.`,
    next: 'The button opens the quote tool. Drop in an STL or STEP file, pick 3D printing, and the check tells you whether it fits the build volume.',
    hero: 'fdm-print',
    blocks: keep([
      block('What printing is for', [
        'Fit and form prototypes before cutting plastic or aluminum. Print it, hold it, change it.',
        'Jigs, fixtures, soft jaws, drill guides and go/no-go gages.',
        'A fit check for a replacement part, tried on the machine before the real material is cut.',
        'Low-volume end-use parts in PETG, ABS, nylon and TPU, where printed is good enough.',
        'Fine-detail parts in SLA resin: small housings, snap fits, cosmetic models.',
        { needs: 'sla-resins', text: 'A resin picked for the job: Tough 1500 or Tough 2000 for a part that flexes or takes a knock, Rigid 10K for stiffness, ESD for electronics work, Clear when you need to see through it.' },
      ]),
      block('Machines and limits', [
        { needs: 'fdm-printers', text: (v) => `FDM: ${v}.` },
        { needs: 'sla-printer', text: (v) => `SLA: ${v}.` },
        'FDM layer heights of 0.1, 0.2 and 0.3 mm, chosen in the quote tool.',
        { needs: 'sla-resins', text: (v) => `SLA resins: ${v.resins}. Layers of ${v.layers}.` },
        'The build-volume check in the quote tool tells you whether the part fits before you pay.',
        { needs: 'print-accuracy' },
        { needs: 'print-finishing' },
      ]),
      block('When not to print', [
        'If it needs a real bearing surface or a press fit, or will see 150 °F in service, it wants to be machined from acetal or nylon.',
        'Over about 50 pieces of a simple flat part, routing from sheet is usually cheaper and the parts are stronger.',
        'A printed part is weakest between layers. If the load pulls the layers apart, machine it.',
      ]),
    ]),
    chips: ['PLA', 'PETG', 'ABS', 'Nylon (PA12)', 'Carbon fiber nylon', 'TPU',
      ...(SLA_RESINS.length ? SLA_RESINS.map((r) => `${r} resin`) : ['Standard resin', 'Tough resin'])],
    gallery: ['phenolic-prototype', 'fdm-print', 'acetal-clamps'],
    related: [{ to: '/machining', label: 'Ready for production? CNC machining' }, { to: '/routing', label: 'Flat parts: CNC routing' }],
  },
};
