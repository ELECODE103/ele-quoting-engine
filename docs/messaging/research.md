# Straightedge launch messaging: research

Compiled 2026-11-09 for the launch of straightedgemfg.com. Companion files: `messaging-framework.md`, `claims-audit.md`, `launch-plan.md`.

## How to read this

- **[E]** = evidence: a survey figure, a published spec, or a quote retrieved from the cited page.
- **[I]** = inference: my reasoning from the evidence. Treat as a hypothesis to test, not a fact.
- Quotes were retrieved through a page-fetch tool that returns extracted text. They are accurate to what the tool returned, but anyone who wants to reproduce a quote publicly should open the source first. None of these quotes are meant to appear on the site. They are here so the copy can use the buyer's words.
- Not reachable from this environment: Practical Machinist threads and Reddit (both blocked the fetcher), the full Thomas 2019 buying-habits report, and PMMI/TMA/IMA dues pages. See "Could not verify" at the end.

---

## 1. How buyers and engineers find, vet and choose a machined-plastics supplier

### 1.1 What the surveys say

| Finding | Source | Tag |
|---|---|---|
| 73% of industrial buyers "pay close attention to the company's website" when evaluating a supplier; market presence 68%, brand reputation 61%, case studies 24%, social media 10%. | Thomas survey of 266 industrial buyers, reported Jan 2019. https://www.thomasnet.com/insights/new-thomas-report-reveals-industrial-buyer-habits/ | E |
| 71% of buyers vet fewer than five suppliers before deciding; 25% vet five to ten; 3% more than ten. | Same | E |
| Engineers do on average 60% of the buying process online before talking to anyone; 72% do at least half. | TREW Marketing / GlobalSpec, 2025 State of Marketing to Engineers, n=1,132. https://www.trewmarketing.com/hubfs/Technical%20Resources/Research/2025%20SMTE%20Research/PDF/2025%20State%20of%20Marketing%20to%20Engineers%20Research.pdf | E |
| Why engineers first contact sales: technical complexity 47%, pricing or inventory questions 40%, validating what they read online 34%. Only 6% prefer never to talk to a salesperson. | Same | E |
| Most valuable content: datasheets 79%, technical articles 61%, CAD drawings 37%, demo videos 35%, reviews/testimonials 34%. | Same | E |
| Engineers rank industry expertise as the top credibility factor. 86% look for independent sources at least sometimes. | Same | E |
| 70% rarely or never use generative AI for purchasing decisions; trust in AI answers 4.4/10, down from 6.5 in 2024. | Same; summary at https://www.trewmarketing.com/blog/2025-state-of-marketing-to-engineers-research | E |
| LinkedIn is a routine information source for 15% of engineers, but 63% in the Americas rate it very or extremely valuable among social platforms. 91% subscribe to at least one work newsletter. | Same | E |
| 58% of engineers wait until the comparison or purchase stage before contacting a supplier. Search engines (89%), supplier websites (75%) and online catalogs (74%) are the top digital resources. | IHS Engineering360, 2015 Digital Media Use in the Industrial Sector, via https://partsolutions.com/industrial-marketing-what-are-industrial-buyers-are-looking-for-on-supplier-websites | E (old, 2015) |
| End users of packaging machinery: 75% name in-stock standard parts and fast lead times for critical parts as the top thing they want from an OEM. Top worries for the year: lead times 29%, parts availability 24%, rising cost 17%. | PMMI Business Intelligence, 2025 Aftermarket Parts & Services, 132 participants (61% end users, 39% OEMs), via https://www.oemmagazine.org/pmmi-news/business-intelligence/article/22943494/endusers-rank-top-three-aftermarket-expectations-for-oems | E |
| 45% of packaging OEMs worry about meeting delivery and lead-time expectations; 27% report trouble with obsolescence. | Same study, via https://www.oemmagazine.org/pmmi-news/business-intelligence/article/22943928/actionable-steps-to-improve-aftermarket-parts-and-services | E |
| Obsolescence is accelerating; many end users and OEMs have no formal process; end users cope by backstocking and "seeking alternatives." | PMMI, Managing Obsolescence, July 2026. https://www.pmmi.org/news/obsolescence-poses-growing-risk | E |

**What this means for the site [I]:**

1. The site is the sales call. Most of the decision is made before anyone phones, and the short list is under five shops. A page that withholds price, tolerance, limits and lead time loses to one that states them.
2. The two things that make an engineer pick up the phone are a hard technical question and a price question. Straightedge answers the price question on the page, which leaves the phone for the technical one. That is a strength: the person answering is the one who will machine it.
3. "Industry expertise" is the top credibility factor. For this shop, expertise shows as specifics about how plastic behaves, not as adjectives.
4. Testimonials and case studies rank low (24–34%). The shop has none it can name anyway. Do not manufacture any. Photos with honest captions and a published equipment list do the same job.

### 1.2 The steps, by role

This sequence is assembled from the surveys above, from the competitor pages in section 3, and from the forum language in section 2. The step order is inference; the individual behaviors are evidenced where tagged.

**Purchasing agent / OEM buyer**

| Step | What they do | What they look for in the first 30 seconds | Deal-breakers |
|---|---|---|---|
| 1. Trigger | An engineer hands them a drawing, or an incumbent is late, raised prices or quit the part. | — | — |
| 2. Search | Google with a material + process + place, Thomasnet category search, or asks the engineer who they know. | Is this a real company with an address and a phone number? Does it do this material? | No address. No phone. Looks like a broker. |
| 3. Short list (under 5) [E] | Opens three or four tabs. | Location, what they machine, how to get a quote, whether they'll handle supplier paperwork (W-9, COI, NDA, supplier form). | Quote form with 15 required fields and no indication of response time. |
| 4. RFQ | Sends the same package to all of them. | Response time, and whether the quote shows quantity breaks and lead time. | Silence. "Sometimes we'd wait days for a quote" (see 2.6). |
| 5. Vet | Checks terms, cert requirements, and whether the shop can survive as a source. | ISO 9001 or a stated substitute; who answers when a lot is rejected; capacity. | Unclear who actually makes the part. Unstated quality process. A single point of failure with no plan. |
| 6. Trial order | Small PO, watches delivery date and paperwork. | On time, CoC in the box, packing list matches the PO. | Late with no call. |

Their question is not "can you make it." The Quality page already has this right: "what happens when it's wrong."

**Design / manufacturing engineer**

| Step | What they do | First 30 seconds | Deal-breakers |
|---|---|---|---|
| 1. Trigger | New design, prototype, or a part a metal shop no-quoted or botched. | — | — |
| 2. Search | Google by material and process ("delrin machining", "UHMW machined parts"); the instant-quote platforms they already have accounts with. | Tolerances stated in numbers. Machine envelope. Materials list with grades. Whether they can get a price without a sales call. | Stock photos. "Tight tolerances" with no number. No machine list. Having to create an account before seeing a price. |
| 3. Test | Uploads a STEP and looks at the price and the DFM notes. | Does the DFM feedback sound like someone who has cut this material? | Generic DFM. A price with no breakdown. |
| 4. Call or email | Only if there is a technical question (47%) [E]. | Gets a person who knows the answer. | A salesperson who has to "check with the shop." |
| 5. Order | Card for a prototype; hands off to purchasing for production. | — | — |

Engineers are the ones who know plastic moves and who have been burned by it (section 2). Copy that states the physics plainly earns their trust faster than any claim of quality.

**Maintenance / plant engineer**

| Step | What they do | First 30 seconds | Deal-breakers |
|---|---|---|---|
| 1. Trigger | A wear strip, guide, star wheel or change part is worn or broken. The OEM quotes weeks, a price that offends, or no longer exists. | — | — |
| 2. Search | Phone first. Google "near me." Asks the plastics distributor who cuts their sheet. | A phone number at the top. "Can I bring the part in?" "Do I need a drawing?" Distance. | Upload-a-CAD-file as the only door. No phone. No sign they do one-offs. |
| 3. Contact | Calls or sends a phone photo with a tape measure in it. | A straight answer on when. | "Minimum order." Being told to submit an RFQ. |
| 4. Order | Card or a blanket PO. Wants it this week. | — | — |

They rarely have CAD. The site plan already notes the landing page gives them no door (`docs/site-plan.md`, Persona C). That is the single largest audience gap in the current copy.

### 1.3 What they distrust, and how the current site does

| Distrust trigger | Evidence | Current site |
|---|---|---|
| No stated tolerances | Of the 15 competitors reviewed (14 from their own pages), only Xometry, Protolabs, Fictiv, SendCutSend and Jaco state a number. None of the regional distributor-fabricators' main pages do (section 3). | States them. Good. Needs owner confirmation of the numbers (see claims audit). |
| No machine list | Konrady lists machines by make. Cope, Midland, Curbell and Atlas Fibre do not name models. | Names machines. Good. Two machine facts conflict with the owner's earlier statements (claims audit). |
| No lead times | No regional competitor states a machined-part lead time. Platforms do. | Lead times exist in the quote tool but are not stated on the marketing pages. "Same Day" is in the seed config and is an open question. |
| Marketplace anonymity | Xometry: parts are made by unnamed shops in a "vetted network of 5,000+ suppliers." https://www.xometry.com/capabilities/cnc-machining-service/ | "The person who will run the job quotes it." Strong. Under-used in the hero. |
| Superlatives | Konrady: "Best Plastic Machine Shop & Fabrication Shop in Illinois, Indiana, Wisconsin, Michigan & Ohio." Atlas Fibre: "north america's best." | Mostly clean. A few unprovable lines ("the cheapest way there is"). |
| Unfinished or contradictory pages | Atlas Fibre's home page shows Lorem ipsum in its case-study block; Xometry's page says both 5,000 and 10,000 suppliers; Fictiv's says both 3,000 and 5,000 customers. | "Four FDM machines" on home vs. a different list on the printing page; SLS materials with no SLS machine. Same class of error; fix before launch. |
| Stock photography | Not measured in the surveys I could reach. [I] from the forum question "How do you usually make sure the shops you're working with are actually legit?" (2.6). | Real shop photos with captions. This is the site's best asset. |

---

## 2. The real pains in plastics machining, in the words people use

### 2.1 Plastic moves: tolerance, heat, moisture, stress

- "Drawings of plastic parts often specify tolerances that are tighter than the practical limitations for polymers." — Curbell Plastics white paper, *Dimensional Tolerance Challenges with Plastic Parts* (Hechtel, Aug 2023). https://www.curbellplastics.com/wp-content/uploads/2023/08/dimensional-tolerance-challenges_white_paper.pdf [E]
- Thermal expansion, in/in/°F × 10⁻⁵: 1020 steel 0.65, 6063 aluminum 1.3, nylon 6/6 5.5, HDPE 6.7. A 30" HDPE panel that fit at 72 °F grew to 30.026" at 100 °F and warped in its steel frame. — same source [E]
- Nylon 6 in water: +8.8% mass and +2% length at saturation. — same source [E]
- "the thermal expansion of plastic can be five times greater than that of metal" — MD+DI, *Machining Plastics: How Metals Techniques Could Lead You Astray*. https://www.mddionline.com/new-technologies/machining-plastics-how-metals-techniques-could-lead-you-astray [E]
- "Sometimes we'll have to machine it out of tolerance because we know it will relax and go into tolerance." — Mike Morris, president, American Plastic Fab, in Today's Machining World. https://todaysmachiningworld.com/?p=8753 [E]
- "Make one and set it aside." — Morris, same article [E]
- "You can't change physics." — Morris, same article [E]
- "it will be out of spec after a while" — Keith Hechtel, Curbell Plastics, same article [E]
- "Don't expect to measure it half an hour later and get the same numbers." — Mike Halloran, Eng-Tips thread on Delrin flatness. https://eng-tips.com/threads/machining-delrin-to-high-flatness-and-parallelism.367050 [E]
- "Now these tolerances may be unreasonable" — RooneyJC (the engineer asking), same thread [E]
- "Is asking 0.05 asking too much?" — TheMotionGuy, Eng-Tips. https://www.eng-tips.com/threads/flatness.276245 [E]
- "wound up with an unusable corkscrew because of the stress release during machining." — reply in the same thread [E]
- "when it was unclamped from the table it was slightly warped" — reply in the same thread [E]
- "It can be extremely difficult to maintain hole-to-hole tolerance with low compressive strength materials." — Port Plastics, *Machine Shop Confessions*. https://portplastics.com/blog/machine-shop-confessions [E]

**Words to mirror:** moves, relaxes, grows, warps, out of spec after a while, set it aside, unreasonable tolerance, flatness, hole-to-hole, measure it later.

### 2.2 Designed for metal

- "A very common situation is engineers who want things in plastic that were really designed for metal." — Mike Morris, Today's Machining World [E]
- "A valve screwed on with the right torque for metal might be too much for plastic, leading to cracks." — Design World, *Plastics machining specialists can get your part right the first time*. https://www.designworldonline.com/plastics-machining-specialists-can-get-your-part-right-the-first-time/ [E]

**Implication [I]:** the engineer's unspoken fear is that their own drawing is the problem. A shop that says "call out the two dimensions that matter and we'll tell you if the rest is realistic" removes the embarrassment. The RFQ page headline ("Tell us what matters. We'll price the rest.") already does this and should be promoted.

### 2.3 Finish: stringy, fuzzy, burrs, melt

- "Nylon is bad—long stringy chips. UHMW is worse." — Mike Morris, Today's Machining World [E]
- "Certain materials have horrendous chip problems." — Morris [E]
- "Materials with high elongation tend to generate more burrs when machined." — Port Plastics [E]
- "Definitely collecting a lot of stringy plastic" — luisce89, Carbide 3D community. https://community.carbide3d.com/t/why-my-uhmw-part-looks-so-bad/40926 [E]
- "send a chamfer tool round all the top side contours to clean off the remaining fuzzies" — LiamN, same thread [E]
- "the feed must be fast enough to avoid rubbing and melting the plastic." — Huub Buis, Hobby-Machinist. https://hobby-machinist.com/threads/machining-uhmw-polyethylene-question.109043/page-3 [E]
- "Applying dull cutting edges to plastic stresses the material by transmitting too much heat into the plastic." — MD+DI [E]

**Words to mirror:** stringy, fuzzies, burrs, melted edge, smeared, sharp tooling, clean edge.

### 2.4 Contamination from metal work

- "it's difficult to clean machines used to make metal parts" and metal debris "can become embedded in a soft plastic machined part" — Design World [E]
- "Many plastics are highly sensitive to petroleum-based cutting fluids" — Design World [E]

**This cuts both ways for Straightedge.** The site says "plastics first; 6061 and brass when the job calls for it," and the owner has previously said the shop's CNC machines also cut aluminum and steel and that the mill has flood coolant. A plastics specialist's main claim over a metal shop is cleanliness. If the same machines run metal, the copy must say how plastic is kept clean, or drop the implied contrast. Flagged in the claims audit.

### 2.5 Traceability and food contact

What the terms actually mean, so copy does not overclaim:

- "Within the FDA, there is no government-operated process of inspection of plastics produced for food contact use." A material that meets the composition rules in 21 CFR can be called FDA compliant; the end user is responsible for the use. — Boedeker Plastics, Agency Regulatory Compliance & Standards. https://boedeker.com/Technical-Resources/Technical-Library/Agency-Regulatory-Compliance-amp-Standards [E]
- USDA acceptance for meat and poultry equipment rests on a manufacturer's written guaranty of FDA compliance. — same [E]
- NSF: "The approval is issued for the finished product (device) in a specific use (application)." It is not a property of a plastic or of a machine shop. — same [E]
- 3-A: "Materials are approved by product, grade, form, and supplier, and not by generic material." — same [E]
- The polymer rules sit in 21 CFR Part 177. Section numbers by resin, from the regulation's own section titles (not fetched in this session; the copywriter should link eCFR and verify each): nylon 177.1500; olefin polymers including UHMW, HDPE and polypropylene 177.1520; PTFE 177.1550; polycarbonate 177.1580; PEEK 177.2415; acetal copolymer 177.2470; acetal homopolymer 177.2480. https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-177 [E for the framework, unverified for the individual numbers]
- Stock-shape makers publish per-product declarations of compliance (examples surfaced in search: Mitsubishi Chemical Advanced Materials documents for Ertacetal C and TIVAR UHMW at mcam.com). [E that these exist]

**What a buyer actually needs in hand [I]:** (1) the resin maker's or stock-shape maker's compliance statement for the exact grade and color, (2) lot traceability from that stock to their parts, (3) a certificate of conformance from the machinist. A machine shop cannot make a part "FDA approved." It can machine compliant stock, keep the lot tied to the job, and pass the paper through. Natural (uncolored) grades are the usual compliant ones; many black and colored grades are not. The site's line "Natural acetal is FDA-compliant" is too broad as written.

### 2.6 Finding a shop, getting ignored, the black box

- "every time we sent parts out for machining, it felt like throwing our CAD files into a black hole." — u/bikfoot, r/hwstartups (the poster was introducing their own platform, so read it as marketing that mirrors a real complaint). https://redlib.ssps.io/r/hwstartups/comments/1lj0s3j/we_got_tired_of_sending_cad_files_into_a_black [E]
- "Sometimes we'd wait days for a quote. Sometimes we'd get the wrong part. Sometimes there was no communication at all." — same post [E]
- "How do you usually make sure the shops you're working with are actually legit?" — u/InevitableFix6688, same thread [E]
- "We just need someone who does quality machine work, knows how to communicate well" — original poster, CNCzone RFQ board. https://www.cnczone.com/forums/usa-rfq-s/393244-lookng-small-cnc-machine-shop-post2340468.html [E]
- "I have waited several months for parts knowing the price didn't pay for expediency" — same poster [E]
- "Any recommendations for a local metal shop that takes small jobs?" — Dallas Makerspace forum. https://talk.dallasmakerspace.org/t/any-leads-on-a-machine-shop-for-a-few-hundred-small-parts/20651 [E]
- Buyer frustrations listed by a composites engineer writing about job shops: shops that "jerk them around," late delivery, "unexpected cost increases, long lead times, or high minimum volumes." Shop-side: "Remember – for a job-shop, time is money." https://explorecomposites.com/articles/business/working-with-job-shops/ [E]

**Words to mirror:** black hole, no communication, takes small jobs, communicates well, legit, wrong part, waited days for a quote.

### 2.7 Replacement parts for machines nobody supports

- "The original iron lasts forever but many of the machine parts don't." — Packaging Digest, *How to Get Obsolete Parts for Your Packaging Machine*. https://packagingdigest.com/machinery-equipment/how-to-get-obsolete-parts-for-your-packaging-machine [E]
- "When replacement parts are not available, what's a maintenance chief to do?" — same [E]
- "Too often parts from seemingly identical machines, even with sequential serial numbers are not interchangeable." — same [E]
- The article's recommended route when nothing is available: scan the original, 3D print it to check fit, then CNC-machine the final part. — same [E]. This is exactly the print-then-machine sequence the 3D printing page describes.
- Change parts named in that article: cap chucks, timing screws, starwheels, drop tubes, case packer grids. [E]
- "When we can't count on timely parts and services, it significantly impacts revenue." — contract packager of shelf-stable foods, PMMI study via OEM Magazine [E]
- A large brand owner at a PMMI session said mechanical parts are the ones they can reverse engineer and fabricate; controls are the real obsolescence risk. https://www.packworld.com/article/trends-and-issues/pmmi/live-top-top-suppliers-and-buyers-look-obsolescence-common-ground [E]

**Words to mirror:** change parts, wear strips, guides, starwheels, timing screws, the OEM quoted weeks, discontinued, no drawing, bring the old one in, line down.

### 2.8 Pains I looked for and could not evidence directly

- **"Machine shops no-quote plastic."** The current machining page leads with this ("the job they take when the aluminum runs out"). I found trade-press support that metal shops handle plastic badly (2.4, MD+DI, Design World) and that specialists market against them (Konrady: "Why you should only trust experts with plastic machining"). I did not retrieve a buyer saying a shop no-quoted plastic. The owner believes it from experience ("most machine shops don't want it"). Keep it as first-person experience, not as a statement about the industry.
- **Minimum order charges.** Named as a frustration in the Explore Composites piece ("high minimum volumes"). SendCutSend and eMachineShop both advertise no minimum, and Plastics International leads with "Low Minimum Order," which shows the platforms think it matters. No survey figure.

---

## 3. Competitive messaging teardown

Pages fetched 2026-11-09. "Gap" is my reading.

### 3.1 Regional plastics machining and fabrication

| Company | Headline (verbatim) | Proof points on the page | Does well | Gap |
|---|---|---|---|---|
| **Konrady Plastics**, Portage, IN. https://konradyplastics.com/machined-parts/ and https://konradyplastics.com/best-plastic-machine-shop-fabrication-shop-in-illinois-indiana-wisconsin-michigan-ohio-why-konrady-plastics-leads-the-midwest/ | "Machined Parts from Prototype to Production"; SEO page: "Best Plastic Machine Shop & Fabrication Shop in Illinois, Indiana, Wisconsin, Michigan & Ohio" | Family-owned since 1981; ISO 9001:2015; six Haas lathes, seven Haas mills, three Andi routers, Keyence CMM; "over one million machined plastic parts and materials annually"; quotes "within two business days"; daily delivery in territory. | Plastics-only, names machines, real scale, on-site stock. The closest true competitor for a Chicago buyer. | No tolerances. No lead-time number. No price. Superlatives ("best," "top," "premier"). Two-business-day quote. |
| **Cope Plastics**, Alton, IL, 14 locations. https://www.copeplastics.com/ | "Where Plastic Meets Purpose." | Since 1946; family- and woman-owned; "the U.S.'s largest set of fabrication capabilities"; unattributed testimonials. | Scale, stock, coverage. | Slogan headline says nothing. No tolerances, machines or lead times. "We solve your lead time challenges" with no number. |
| **Midland Plastics**, New Berlin, WI; branches in WI, IA and northern IL. https://www.midlandplastics.com/ | "Quality Plastics & Manufacturing for Your Products" | Since 1945; ISO 9001:2015; IAPD member; 3- and 5-axis routing, machining, forming. | Local to Milwaukee, certified, broad. | Generic headline. No tolerances, machines, lead times or prices. |
| **Atlas Fibre**, Northbrook, IL. https://www.atlasfibre.com/ | "north america's best … thermoset composite … supplier and fabricator" | 65+ years; "100+ CNC milling and turning machines"; routing to 60" × 120"; same-day shipping on stock. | Owns the thermoset niche (G-10, phenolic). The nearest established name to Wauconda in this list. | Thermosets, not thermoplastics. Lorem ipsum in the case-study block. No tolerances. |
| **Engineered Plastic Products**, Mount Prospect / Elk Grove Village, IL. Directory data only: https://www.globalspec.com/local/3751/C_US/IL and https://ensun.io/company/engineered-plastic-products-corporation-64a80658d63fc851237e6b15 | (own site not fetched) | Founded 1976; ISO 9001 per GlobalSpec; precision machined plastic components, manifolds; KanBan and blanket orders. | Established local precision plastics shop for aerospace, medical, instrumentation. | Could not review their own site. Listed so the owner knows the name a local buyer may already use. |
| **Jaco Products**, Middlefield, OH. https://www.jacoproducts.com/ | "Precision Plastic Products Manufacturer in Ohio" | Since 1948; ISO 9001:2015; 5-axis; "tolerances as tight as .0001″" (FAQ). | Location in the H1. Dedicated "plastic machine shop" page. | A .0001″ claim on plastic will make a plastics engineer wince. "Quick lead times, affordable pricing" with no numbers. |
| **Curbell Plastics**, national, Chicago-area branch. https://www.curbellplastics.com/services-capabilities/fabrication-machined-parts/ | "Fabrication & Machined Parts" | Since 1942; material selection tools; the best technical content in the category (the tolerance white paper cited above). | Teaches. Engineers trust them on materials. | Machining page lists no tolerances, lead times or machines. CTA is "Have a Question?" |
| **Interstate Plastics**, "Chicago" page. https://www.interstateplastics.com/chicago-plastics | "Chicago Plastics Supply \| Fast, Local Delivery" | "over 45 years serving Chicago businesses"; FDA-compliant materials. | Ranks for Chicago terms. | No Chicago facility. Ships from Des Moines. "Local" in name only. |
| **Plastics International**, Eden Prairie, MN. https://www.plasticsintl.com/ | (no H1) "Low Minimum Order," "Same Day Shipping" | Since 1985; cart and online ordering for stock. | Leads with the two things small buyers ask. | Distributor first. No machining specifics on the home page. |

Other Illinois names a buyer may see in directories (GlobalSpec list, not reviewed): Brogan & Patrick (West Chicago; Thomasnet profile is unclaimed, https://www.thomasnet.com/company/brogan-patrick-mfg-corp-30802276/profile), Adams Plastics (Rolling Meadows), Formco Plastics (Bensenville), Cicero Plastic Products (Romeoville), CDS Plastics (Aurora), Littlestar Plastics (Machesney Park), Adapt Plastics (Loves Park).

### 3.2 Instant-quote platforms

| Company | Headline (verbatim) | Proof points on the page | Does well | Gap |
|---|---|---|---|---|
| **Xometry**. https://www.xometry.com/capabilities/cnc-machining-service/ | "Custom Online CNC Machining Services" | "vetted network of 5,000+ suppliers"; standard lead time 3–7 business days; **plastics held to ±0.010" by default**, metals ±0.005"; ISO 9001, AS9100D, ITAR and more; free US shipping. | Instant price, certifications, breadth. | The buyer does not know who makes the part. Plastics get twice the tolerance band of metals by default. |
| **Protolabs**. https://www.protolabs.com/services/cnc-machining/plastics/ and https://www.protolabs.com/services/cnc-machining/cnc-milling/design-guidelines/ | "Plastic CNC Machining Service" | 20+ thermoplastics; ±0.005" typical at the automated facility; parts "as fast as 1 day"; ISO 9001, AS9100D, ITAR. | Speed and consistency for small prismatic parts. | Envelope: 3-axis plastics max 22" × 14" × **0.75"**, milling depth 2". Thicker blocks and anything sheet-size fall outside it. |
| **Fictiv**. https://www.fictiv.com/cnc-machining-service | "Precision CNC Machining Services" | "tolerances as tight as ±0.0001 inch"; plastics ±0.002" with a drawing; 95.4% on-time-in-full; network in US, China, India, Mexico. | Publishes an OTIF number. Strong DFM. | Network; location of manufacture not stated per part. Account before upload. |
| **SendCutSend**. https://sendcutsend.com/services/cnc-routing/ | "Online Sheet Cutting Services" | Routed plastics ±0.005"; 1–3 business days; no minimum; free shipping; ABS, acrylic, Delrin, G10, HDPE, polycarbonate, polypropylene, UHMW. | Price transparency, speed, no minimum. The benchmark for ordering experience. | Routing thickness **0.118" to 0.500"** only. "Cuts are 2D and perpendicular only" — no pockets, counterbores, chamfers or partial-depth cuts. Tabs left on parts. No STL. |
| **eMachineShop**. https://www.emachineshop.com/ | "Custom Manufacturing Made Easy" | 25+ years; 5M+ parts; ITAR; "U.S.-Based Manufacturing"; no minimum; free CAD. | Friendly to people without CAD. | No tolerance or lead-time number on the home page; a customer review on the page mentions five weeks. |
| **PartsBadger**, Cedarburg, WI. https://parts-badger.com/ | "Online CNC Machine Shop Delivering Parts Fast" | "Instant pricing for most parts, or get a custom quote in hours"; ISO 9001:2015, AS9100D; "From 1 to 100,000+ parts"; expedited "in as little as 7 days." | The nearest regional instant-quote competitor (southeast Wisconsin), certified. Also runs a "local CNC machine shop" landing page. | Metal-first; no plastics named on the home page. "Tight tolerances" with no number. Page does not say where parts are machined. |

### 3.3 The position nobody holds

Plot the field on two questions a buyer asks: *Can I see a price without talking to anyone?* and *Do I know exactly who is making my part and can I reach them?*

| | Price on the page | Request a quote and wait |
|---|---|---|
| **Named shop, named person, published limits** | **Empty.** | Konrady (names machines, not limits or people) |
| **Company you can call, limits not published** | PartsBadger (metal-first) | Cope, Midland, Curbell, Jaco, Atlas Fibre, Engineered Plastic Products |
| **Anonymous network** | Xometry, Fictiv, Protolabs Network | — |
| **In-house but narrow envelope** | SendCutSend (2D, to 1/2"), Protolabs (to 3/4" thick in plastics) | — |

**The open position: an instant price from a plastics shop you can drive to, quoted and machined by a person you can name, with tolerances and machine limits printed on the page.** Every regional plastics fabricator makes you ask. Every instant-quote site hides the maker or handles only thin or 2D work. Nobody in this set combines price-now with a named maker for milled, turned and pocketed plastic parts.

Three supporting gaps nobody fills:

1. **Honest plastic tolerances.** Jaco and Fictiv headline ".0001." Xometry defaults plastics to ±0.010". Nobody says "here is what each plastic will hold, and here is what it will do after it leaves us."
2. **The no-CAD door.** Only eMachineShop gestures at it. No regional shop says "bring the worn part."
3. **Stated lead time on machined parts from a regional shop.** None of the regional sites reviewed gives a number.

**What Straightedge cannot claim against this field:** years (competitors cite 1942–1985), ISO 9001 (Konrady, Midland, Jaco, PartsBadger, EPP have it), scale, stock on the floor, CMM inspection. The framework has to concede these plainly and win on directness, visibility and plastic-specific knowledge.

---

## 4. Midwestern industrial tone

There is no survey of "Midwestern tone." This section is inference from three evidenced points: engineers rank expertise first and distrust unsupported claims (TREW); the regional leaders all rely on tenure and superlatives (section 3); and the shop-floor voices quoted in section 2 are blunt, concrete and a little dry ("You can't change physics").

**Reads as credible**

- A number with a unit. "±0.005" on acetal." "59" × 96" bed."
- A limit stated without apology. "Larger than 18" × 9.5" × 12" goes out for a quote."
- The catch before the fix. The site's existing rule 6 is right for this audience.
- A named place. Wauconda, Lake County, Route 12 — not "the Chicagoland area."
- Drive time in minutes, and an invitation to come look.
- A phone number in the header and the sentence "the person who answers runs the machines."
- Photos of real parts on a real bench, with material, thickness and quantity in the caption.
- Saying what the shop is not: not ISO-certified, one person, not the place for 50,000 pieces.
- Shop vocabulary used correctly: print, first article, lot, traveler, setup, nest, deburr, break edges, cert.

**Reads as marketing**

- Any superlative. Best, leading, premier, world-class.
- "Solutions," "partner," "capabilities" as nouns standing in for what is actually done.
- "Tight tolerances" without a number.
- "Fast turnaround" without days.
- A mission statement. A tagline under the logo.
- Cleverness that asks to be admired. The current ISO line ("if it needs the behavior, you already have it") and "machines like butter" are the two places the site slips.
- Knocking competitors. "Most machine shops treat plastic as the job they take when the aluminum runs out" is a claim about other people. Midwestern buyers buy from those shops too.
- Exclamation marks, emojis, "excited to announce."

**Regional proof worth stating (each needs the owner to confirm the fact first)**

- Central time, and hours when the phone is answered.
- Pickup and drop-off in Wauconda; will-call hours.
- Drive times to named places: Milwaukee, Kenosha, Rockford, Elk Grove Village, the Fox Valley.
- One-day ground shipping across most of Illinois, Wisconsin, northern Indiana (carrier maps will confirm; do not print until checked).
- "I'll come look at the machine" if the owner will actually do site visits for replacement parts.

**Words to avoid** (extends the banned list already in `docs/copy-ui-review.md`): solutions, partner, capabilities (as filler), precision (as an adjective without a number), quality (as an adjective), tight, fast, quick, affordable, competitive, custom (when everything is custom), one-stop, turnkey, state-of-the-art, cutting-edge, industry-leading, trusted, passionate, family (the shop is not a family business), craftsmanship, excited, proud.

---

## 5. Search demand language

No keyword tool was available. Nothing below has a search volume attached. Evidence for a phrase is limited to: (a) a competitor built a page around it, which shows somebody with data thought it worth targeting; (b) the phrase appears in buyer forum posts; (c) the term is standard trade vocabulary in the sources above. Everything else is inference.

### 5.1 By intent

**A. Material + process (engineer, mid-funnel).** Highest confidence.

| Phrase | Basis |
|---|---|
| delrin machining / acetal machining / machined delrin parts | E: every platform and regional site lists Delrin by that name; Xometry, Protolabs, Fictiv and SendCutSend all use "Delrin" over "acetal" in lists. |
| UHMW machining / UHMW machined parts / custom UHMW parts | E: trade term throughout section 2. |
| HDPE CNC routing / HDPE cut to size / HDPE sheet cutting | E: SendCutSend's routing page targets sheet cutting by material. |
| PEEK machining, nylon machining, PTFE machining | E: listed on all platform pages. I: lower priority for this shop's machines. |
| plastic CNC machining / plastic machining service | E: Protolabs H1 is "Plastic CNC Machining Service"; GlobalSpec category is "Plastic Machining Services." |
| plastic machine shop | E: Jaco has a page titled "Plastic Machine Shop"; Konrady's SEO page uses "plastic machine shop." |

**B. Process/material + place (buyer and maintenance, high intent).**

| Phrase | Basis |
|---|---|
| plastic machining Chicago / Illinois / Milwaukee / Wisconsin | E: Konrady's page title strings together five states; Interstate built "Chicago Plastics Supply" and a Milwaukee page without a facility in either; GlobalSpec maintains "Plastic Machining Services Providers in Illinois" and per-city pages. |
| plastic machine shop near me / machine shop near me | E: PartsBadger runs a "local-cnc-machine-shop" page. I: "near me" queries resolve through Google Business Profile, not the website. |
| CNC routing Illinois / plastic CNC routing near me | I. |
| Lake County / Wauconda / McHenry County machine shop | I: low volume, almost no competition, high intent. |

**C. Part name (maintenance and packaging OEM, highest intent, most specific).**

| Phrase | Basis |
|---|---|
| UHMW wear strips custom / custom wear strips | E: wear strips named in trade sources; I for "custom." |
| conveyor guide rails UHMW / lane guides / chain guides | I from trade vocabulary. |
| star wheels / starwheel plastic / timing screws / change parts | E: named as change parts in Packaging Digest. Caution: timing screws need a specific process; only target parts the shop will actually make. |
| plastic bushings / acetal bushings / nylon rollers / plastic spacers | I. |
| HDPE trays / plastic machine guards / polycarbonate guards | I, and matches the shop's photographed work. |

**D. Problem (maintenance, urgent).**

| Phrase | Basis |
|---|---|
| replacement plastic parts for packaging machine | E for the problem (PMMI, Packaging Digest); I for the phrasing. |
| obsolete machine parts / OEM discontinued part / reverse engineer plastic part | E: Fictiv, igus and several small shops publish pages on exactly this (search results for "obsolete parts reverse engineering"). |
| plastic part no drawing / machine part from sample | I. |

**E. Compliance (food-equipment engineer, buyer).**

| Phrase | Basis |
|---|---|
| FDA compliant plastic machining / food grade UHMW / food grade acetal parts | E: Curbell offers selection "by FDA compliance"; Interstate's Chicago page leads with FDA-compliant materials; Port Plastics has a "Food Forum." |
| NSF 51 plastic parts / 3-A plastic | E that the terms are searched by people who know them. Straightedge must not rank for a claim it cannot make; use these terms only on an explainer page that says what a machine shop can and cannot certify. |
| metal detectable plastic parts | E: Port Plastics carries a metal-detectable category. I: worth a line only if the shop will run it. |

**F. Comparison and alternative (engineer who already uses a platform).**

| Phrase | Basis |
|---|---|
| Xometry alternative / SendCutSend plastic thickness / SendCutSend pockets | I, supported by E that SendCutSend's limits (0.118–0.500", 2D only) are real and that third parties publish "Xometry alternatives" lists. Do not build a page that names a competitor in the title; the owner is a Xometry partner. State Straightedge's own limits and let the buyer compare. |

### 5.2 Language choices the evidence supports

- Say **Delrin** first and **acetal** second. Buyers type the brand; platforms list it that way.
- Say **machined plastic parts** and **plastic machining**, not "polymer components."
- Say **print** in body copy (shop word) and **drawing** in forms and headings (search word).
- Say **replacement parts**, **wear parts**, **change parts**. Maintenance people do not search "legacy component reproduction."
- Put the **city and state in the title tag and H1** of the home page. Jaco and Interstate do; the current Straightedge H1 does not.

---

## 6. Launch channels

Expected value is my estimate for a one-person shop with no ad budget and no customer list it can name. "Sustainable" assumes 20 minutes a day.

| Channel | Evidence | Expected value | Cost | Verdict |
|---|---|---|---|---|
| **Website with the price on it** | 73% of buyers weigh the website heavily (Thomas). 60% of the process happens before contact (TREW). | High. Everything else points here. | Already built. | Fix the claims first. |
| **Google Business Profile** | "Near me" and place searches resolve in the map pack. Google's rules: no links or pricing in the description; a shop that takes customers at its address can show it. https://support.google.com/business/answer/3038177 | High for maintenance buyers within an hour; low effort. | Free. One hour to set up, five minutes a week. | Do in week one. Needs real photos, hours, and reviews from real customers only. |
| **LinkedIn, owner's personal profile** | LinkedIn is routine for only 15% of engineers, but rated valuable by 63% in the Americas (TREW). One agency's own data: employee profiles drew roughly 9 to 70 times the impressions per follower of its company page (Refine Labs, three profiles, Q3 2025 — tiny sample, self-published). https://www.refinelabs.com/article/employee-profiles-outperform-brand-pages-linkedin | Medium. Reaches people who already know the owner and their second-degree network: local plant people, other shop owners who refer plastic work. Slow. | Free. 20 minutes per post. | Yes. Personal profile is the channel. |
| **LinkedIn company page** | Same Refine Labs data; company pages get a fraction of the reach. | Low for reach. Needed so the owner's profile has an employer to link and buyers have something to check. | Free. One setup. | Create it, fill it in, post rarely. |
| **Direct email to engineers and buyers** | 91% of engineers subscribe to newsletters (TREW), which shows email is read, not that cold email is welcome. The project already has cold-email batches for the parent company. | Medium-high per hour if the list is hand-built and the email is one part-specific sentence plus a photo. Low if blasted. | Time. | Yes, 5 a day, plain text, to named people at packaging and food-equipment OEMs within 90 minutes' drive. |
| **Past contacts** | — | Highest per hour. These people already know the owner does what he says. | One email. | Day 2. Exclude anyone met through Xometry jobs. |
| **Thomasnet** | Buyers do use it for supplier discovery (Thomas, 1.2). Paid programs were estimated at $7,000–10,000 a year by WebFX, an SEO agency that competes with Thomas and cites only its own clients. https://www.webfx.com/industries/industrial/manufacturing/is-thomasnet-worth-it/ Brogan & Patrick's profile shows as unclaimed, which suggests a basic listing can exist without payment; I could not confirm current free-tier terms. | Low-medium. A complete basic profile is worth an hour. Paid placement is not worth it at launch. | Free tier if available. | Claim and complete a profile; do not buy placement. |
| **Referrals from metal shops and distributors** | Trade press says metal shops handle plastic poorly (2.4). Plastics distributors with Chicago branches (Curbell, Piedmont, Polymershapes, Port) get asked for machining they may not want at one-piece quantities. | Medium-high, slow. One referring shop can be worth more than a year of posts. | A visit and a card. Fits the owner's existing field-sales habit. | Yes. Two visits a week. |
| **TMA (Technology & Manufacturing Association), Schaumburg** | Founded 1925; "exclusively focused on assisting and promoting small and mid-size manufacturers"; member directory and "TMA Business Connect." https://www.tmaillinois.org/ Dues not published. | Medium. Members are the metal shops that would refer plastic work. 35 minutes from Wauconda. | Dues unknown. | Call and ask. Best fit of the three associations. |
| **IMA (Illinois Manufacturers' Association)** | About 4,000 members; dues negotiated per company; mainly advocacy and group buying. https://ima-net.org/membership/ | Low for lead generation. | Unknown. | Skip at launch. |
| **Lake County Partners** | Economic development group; site selection, workforce, events connecting businesses with government buyers. https://www.lakecountypartners.com/ | Low for OEM leads; useful for local introductions and possibly a "new manufacturer" mention. | Free to contact. | One email introducing the business. |
| **PMMI** | The association for packaging and processing machinery; publishes the aftermarket and obsolescence research cited here; runs PACK EXPO in Chicago. Membership categories and eligibility not verified. | Membership: low, likely not eligible or not worth it as a job shop. The research and the member directory (a list of packaging OEMs by location) are the value. | Reports may be free to download. | Use the directory to build the email list. Walk PACK EXPO Chicago when it next runs; do not exhibit. |
| **Forums (Practical Machinist, r/machinists, r/manufacturing, Eng-Tips)** | Buyers and engineers do talk there (section 2). All ban or punish self-promotion. | Low for leads. High for learning the language. | Time sink. | Read, answer plastics questions when you know the answer, never pitch. Not part of the 30-day plan. |
| **Paid search** | — | Unknown without a keyword tool. Plausibly good for part-name and "near me" terms. | Cash. | Not at launch. Revisit after 60 days of organic data. |

**What one person can sustain:** one LinkedIn post a week, five hand-written emails a day, two drop-in visits a week, and answering the phone. That is the plan in `launch-plan.md`. Anything that needs daily content or community management will be abandoned by week three.

---

## Could not verify

- **Practical Machinist and Reddit threads.** Both blocked retrieval. The brief named them as preferred sources. Machinist-side quotes come instead from Today's Machining World, Eng-Tips, Hobby-Machinist, the Carbide 3D community, CNCzone and one Reddit thread reached through a mirror.
- **Thomas 2019 report beyond the news summary.** The detail on what buyers want to see on a supplier site is in the gated report.
- **A buyer quote saying a shop "no-quoted" plastic.** Not found. See 2.8.
- **Search volumes.** None. Section 5 is language, not demand size.
- **21 CFR 177 section numbers per resin.** Listed from the regulation's section titles; not fetched. Verify against eCFR before printing.
- **PMMI membership eligibility and dues; TMA dues; IMA dues; Thomasnet's current free listing terms.** Not published where I could reach them.
- **Google Business Profile description length.** The guideline page fetched does not state it. The commonly cited limit is 750 characters; the draft in the launch plan is under that.
- **Engineered Plastic Products' own website.** Reviewed from directory listings only.
- **Xometry's plastics page and SendCutSend's how-it-works page.** The existing site plan notes these were blocked on 2026-10-28; I used Xometry's main CNC page and SendCutSend's routing page instead.
- **Drive times and one-day shipping zones** from Wauconda. Not checked against a map or carrier; listed as owner-confirmation items.
