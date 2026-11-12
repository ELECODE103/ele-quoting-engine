# Sales tax and shipping: what the site does today, what the rules say, and the switches

Prepared 2026-11-11 on branch `tax-shipping` (from `hardening-2026-11-11`). Every source below was read on 2026-11-11.

This is not tax advice. The tax part is a factual brief for you to take to your accountant: each legal statement names its source and says how much weight the source can carry. The decisions are yours and your accountant's.

**Where things stand.** Nothing on the site has changed. Every switch described here is built, tested and off. With the settings as they are, checkout charges exactly what it charged before this branch: the same shipping line, no tax, the same single line on Stripe's page.

---

## 1. Decision sheet (one page)

Two decisions: how shipping is charged, and whether tax is collected at checkout. Four ways to launch. All are switched in Admin → Pricing → Shipping & tax; none needs a developer.

| | A. As today | B. Recommended | C. Shipping in the price | D. Table, free over a threshold, exemptions trusted |
|---|---|---|---|---|
| **Shipping** | Weight formula: $12 + $2.50 per kg of parts, any destination | Rate table by packed weight (your numbers), oversize and overweight orders to a firm quote, buyer's carrier account ON, pickup ON | Included (no shipping line), pickup ON | Rate table, free shipping over a parts total you choose, carrier account ON |
| **Tax** | Off | Stripe Tax ON, Illinois registration only, buyers may declare an exemption, declarations NOT trusted | Stripe Tax ON | Stripe Tax ON, declarations trusted |
| **What the buyer sees** | "Shipping estimate $x" on the quote, "Shipping $x" at checkout. No mention of tax | Shipping by weight with the reason ("about 3 lb"), a choice of ship / my carrier account / pickup, "Sales tax: added at payment", an exemption box with certificate upload | "Shipping: Included". Tax added at payment | As B, with "Free" over the threshold; an exempt buyer with a certificate pays no tax at once |
| **Margin risk** | A 4 ft × 8 ft routed sheet or a 60 lb order is charged the formula ($12 + weight) while the freight bill is many times that. Alaska, Hawaii, Canada and Mexico pay the same as Elgin. Illinois tax on Illinois sales is not collected from the buyer (see question 1 for your accountant) | Low. Heavy, long, unknown-weight and out-of-area orders are never guessed: they go to a firm quote. Table rows are yours | High unless part prices go up: every order carries its freight out of margin. Oversize still goes to a firm quote | Medium: free shipping costs you the freight above the threshold; a bad certificate leaves you owing the tax |
| **Before you switch it on** | Nothing | 1. Your real UPS or FedEx rates in the table (the numbers in it now are placeholders). 2. Illinois registration (MyTax Illinois) if you do not already hold one for this company. 3. Stripe dashboard: switch Tax on, check the head office address, add the Illinois registration, check the preset product tax code. 4. One test-mode checkout to an Illinois address and one to another state | Decide a price increase first (not part of this work). Stripe and Illinois steps as B | As B, plus your accountant's comfort with taking certificates on sight |

**Recommendation: B.** Reasons, in order:

1. The formula has no size or destination rule, and the instant-quote tool will happily price a 48 in × 96 in routed part. Under the formula that order is charged about $12 plus weight. Under B it gets no parcel price at all: the buyer is told freight is confirmed on a firm quote, or ships it on their own account, or picks it up.
2. Industrial buyers commonly ship on their own UPS or FedEx account. It costs you nothing and removes shipping from the conversation.
3. Tax: whether you collect it or not, the questions in section 4 need an answer before launch. If the answer is "collect Illinois tax on Illinois sales", Stripe Tax does the arithmetic and B keeps you in control of exemptions: a declared exemption is charged tax and you refund it once you have read the certificate. That is slower for the exempt buyer by one refund, and it means a certificate you have not read never costs you money. Move to "trusted" (D) once you and your accountant are comfortable.
4. No new outside service, no carrier API, nothing that can fail at checkout except Stripe, which is already there.

If the Illinois and Stripe steps are not done by launch day, switch the shipping half of B on and leave tax off: the two halves are independent.

**Later upgrade (one, when volume justifies it):** live carrier rates from a rating API with the rate table kept as the fallback when the API is slow or down, and label purchase from the order view. (The unused EasyPost line that was in `.env.example` is gone; nothing in the code ever read it.) Second candidate: filing. Stripe Tax's pay-as-you-go plan does not file returns; your accountant files Form ST-1, or you move to Stripe's subscription plan that includes filings.

---

## 2. What happens today (read from the code, base branch)

**Shipping**

- Every instant quote carries a shipping amount worked out when the quote is priced: **$12.00 + $2.50 × the weight of the parts in kilograms** (pricing rules `shippingBaseRate`, `shippingPerKg`, Shop group; `server/services/pricingEngine.js`).
- The quote builder shows it as "Shipping estimate" with "Ship weight"; the checkout page shows "Shipping". It says estimate on the quote, but that amount is what is charged. There is no later adjustment.
- It is inside the order total. The $25 order minimum applies to parts + lead-time fee + shipping together.
- It does not depend on where the order goes. The checkout page offers United States, Canada and Mexico and charges all three the same. Nothing looks at the size of the part or the weight of the order.
- On Stripe's page shipping is not its own line. Stripe gets one line for the order (shipping inside it) and, when ordered, a second line for the inspection paperwork.
- The order stores `shippingCost` when the lines add up to the total, and `shippingMethod: "standard"` always. Emails, the order page and the order confirmation PDF show a "Shipping" line when it is above zero.

**Destination**

- Collected on the checkout page (name, street, city, state, ZIP, country), after sign-in and before the redirect to Stripe. On the instant path the server does not require the fields (the browser form does). On the firm-quote path the server requires them.
- Stripe is sent the buyer's email, not the address.

**Tax**

- None is charged. Every order is stored with `tax: 0`. The Stripe session has no tax parameters.
- No page, email or public document mentions tax. The order confirmation PDF would print a "Sales tax" row only for an amount above zero, which never happens. The internal job traveler PDF prints "Tax: $0.00".

**Firm quotes and purchase orders**

- The order total is the total you quoted. No shipping line, `shippingCost: 0`. Nothing on the quote email, page or PDF says whether shipping is in the price (the note field in admin suggests writing it there).
- A PO order is stored as "awaiting PO". Nothing is charged, and the system produces no invoice.

**Replacement parts (customer's original going back)**

- Already explicit before this branch: the firm quote email, page and PDF say "This price includes shipping your original part back to you with the finished parts"; the order confirmation email and PDF carry a line "Your original part, returned with this order: return shipping included in the quoted price"; the packing slip has a tick box; the admin order view and the shop's emails carry the reminder. Shipping the part in is at the buyer's cost.

**Reorder**: re-prices the same parts at today's rules into a new quote, shipping by the formula.

**Is weight and size known?** Yes. Each part has a measured volume (mm³), an axis-aligned bounding box and, for parts with recognised features, an oriented box. Each material has a density (machining and routing stock: lb/in³ per grade; printing materials: g/cm³). All 54 seeded materials have one. A DXF has a volume once the buyer picks a stock thickness. The pricing models fall back to a typical density when a material has none, which is fine for a price estimate and wrong for a shipping charge; the new shipping code does not do that (section 6). Box dimensions are not known: nothing computes a packed size, so dimensional weight is not modelled.

**EasyPost**: one commented line in `.env.example`. No code, no dependency, no key.

---

## 3. The brief

Confidence: **high** = the tax authority's or the vendor's own current page says it in so many words; **medium** = an official source says it but not for exactly this case, or a current secondary source says it; **low** = inference, or a source that could not be opened.

### 3.1 Illinois sales by an Illinois seller

| Statement | Source | Date of source | Confidence |
|---|---|---|---|
| A business selling at retail in Illinois must register and remit Retailers' Occupation Tax (ROT). Registration comes before the first sale. | IDOR, [Pub-113, Registering your Business](https://tax.illinois.gov/research/publications/pubs/retailers-overview-of-sales-and-use-tax/registering-your-business.html); IDOR, [Business Registration](https://tax.illinois.gov/businesses/registration.html) | Neither page shows a date (footer © 2026) | High |
| For a retailer with inventory or selling activity in Illinois, a sale is sourced where the inventory is or the selling activity happens ("the location of the inventory from which a sale is fulfilled or the location at which selling activities otherwise occur"), and the retailer remits state and local ROT "at the rates in effect at that location". This is what is usually called origin sourcing. "A retailer that fulfills any orders from its inventory in Illinois is not a remote retailer." | IDOR Informational Bulletin [FY 2026-12](https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html) (the bulletin refers to 86 Ill. Adm. Code 270.115 and PIO-125 for the sourcing rules) | December 2025 | High for the rule; the rule's application to a made-to-order shop that ships from its own floor is the plain reading, not a ruling |
| Destination-based tax is for remote retailers and marketplace facilitators (and, since 2025, retailers with an Illinois place of business selling from outside the state). IDOR's destination page says it "does not pertain to sales subject to 'origin-based' sales tax". | IDOR, [Destination-Based Sales Tax Assistance](https://tax.illinois.gov/research/taxinformation/sales/destination-based-sales-tax-assistance.html) | "current as of September 2025" | High |
| **The rate at the shop.** State rate 6.25% on general merchandise. The Northern Illinois Transit Authority tax (formerly RTA) in Lake County is **1.00%** from **August 1, 2026** (an increase of 0.25%). Local municipal taxes are added where they apply. | IDOR Informational Bulletin [FY 2026-34](https://tax.illinois.gov/research/publications/bulletins/fy-2026-34.html) | June 2026 | High for the two components |
| Combined rate inside the Village of Wauconda: **8.25%** (6.25 state + 1.00 village + 1.00 transit). | Avalara, [Wauconda rate page](https://www.avalara.com/taxrates/en/state-rates/illinois/cities/wauconda.html) (a tax-software vendor, not IDOR) | 2026 | Medium |
| Combined rate at a location in Lake County outside any municipality: **7.25%** (6.25 + 1.00), on the assumption that no county or other local tax applies there. | Arithmetic from FY 2026-34; Avalara lists no Lake County tax | | Medium-low. **The rate depends on whether the shop's address is inside village limits. Look the address up in IDOR's Tax Rate Finder (on MyTax Illinois: Tax Rate Finder → Search by Address) and use that.** |
| **Shipping charges.** Outgoing transportation and delivery charges are part of taxable gross receipts when there is an "inseparable link" between the sale and the delivery. A link exists when the charge is not separately identified to the buyer, or when it is separately identified but the seller gives no way to take the goods without paying it (no pickup, no qualifying free delivery). When the charge is separately stated and the buyer could have picked the order up or used a free option, delivery is a separate service and is not taxed. A delivery charge above the seller's actual cost is taxable to the extent of the excess. "Shipping and handling" is included in what the rule calls delivery charges. When an order mixes taxable and exempt items, the delivery charge follows the items. | [86 Ill. Adm. Code 130.415](https://www.ilga.gov/ftp/JCAR/AdminCode/086/086001300D04150R.html) (b)(1)(B)–(F) | Amended at 40 Ill. Reg. 6130, effective April 1, 2016 | High for the rule. How it applies to each setting below is inference |
| What that means for the switches (inference, for your accountant to confirm): shipping **included in the price** is simply part of the taxable price. A **separately stated** shipping line with **pickup offered** looks like the not-taxable case, provided the line does not exceed what the shipment costs you. A separately stated line with no pickup and no free option looks taxable. A table rate that runs above your real cost is taxable on the excess. | Reading of 130.415 | | Low until confirmed |
| **Custom-made goods.** A seller of special-order items is not liable for ROT, and the transaction falls under the Service Occupation Tax instead, only if all three hold: the buyer "employs the seller primarily for his engineering or other scientific skill to design and produce the property", "the property has use or value only for the specific purpose for which it is produced", and "the property has use or value only to the purchaser". The seller carries the burden of proof. Being made to order or not stocked "is not sufficient". The examples treat a single order of 50 or more identical items, and repeat orders of the same item, as ordinary retail sales. | [86 Ill. Adm. Code 130.2115](https://www.ilga.gov/ftp/JCAR/AdminCode/086/086001300S21150R.html) | Amended at 32 Ill. Reg. 17519, effective October 24, 2008 | High for the rule |
| What that means here (inference): a part machined to the buyer's own drawing is made to order, but the buyer is not hiring the shop to design it, so the first test looks unmet and the sale looks like an ordinary retail sale. A replacement part the shop measures, draws and makes from a worn original is closer to the special-order case. Which tax applies changes the return, the rate basis and possibly the registration. | Reading of 130.2115 | | Low. This is question 2 for your accountant |

### 3.2 Buyers in other states

| Statement | Source | Date | Confidence |
|---|---|---|---|
| Since *South Dakota v. Wayfair* (2018) a state may require a seller with no physical presence there to collect its tax once the seller's sales into the state pass a threshold. The most common threshold is more than $100,000 of sales in the current or previous year. Many states have dropped their separate 200-transaction test (Illinois dropped its own on January 1, 2026). | Avalara, [States eliminating economic nexus transaction thresholds](https://www.avalara.com/us/en/blog/2025/06/states-eliminating-economic-nexus-transaction-thresholds) (secondary); IDOR FY 2026-12 for Illinois's own threshold | June 2025; December 2025 | Medium for the general picture (state rules differ and change); high for Illinois's own $100,000 |
| A new seller shipping from Illinois with no office, inventory, employees or other presence in another state generally has no duty to collect that state's tax until it passes that state's threshold. Below the threshold the buyer owes use tax to their own state. | Follows from the above; no single primary source covers all states | | Medium. "Presence" has traps (a trade show, a contractor, stock at a customer). Ask |
| What to watch: sales by ship-to state over the trailing twelve months. Stripe Tax has a monitoring view that shows where you are approaching a threshold; with tax on in this site, every card order is recorded by Stripe with its ship-to state. PO orders are outside Stripe: they need to be in the count too. | Stripe, [Set up Stripe Tax](https://docs.stripe.com/tax/set-up) ("The monitoring tool in the Dashboard helps you understand where you might need to register") | current docs | High that the tool exists; it only sees what goes through Stripe |

### 3.3 Exemptions this customer base will raise

| Statement | Source | Date | Confidence |
|---|---|---|---|
| **Resale.** A sale for resale is not taxed when the seller holds a certificate of resale. The buyer may use Form CRT-61 or their own document with the required contents (the contents are listed in 86 Ill. Adm. Code 130.1405). The retailer "must keep in their books and records a certificate of resale". Certificates "should be updated at least every three years". | IDOR, [Certificate of Resale](https://tax.illinois.gov/businesses/crtinfo.html) | current page | High. The list of required contents in 130.1405 was not opened here: have your accountant give you the checklist |
| **Manufacturing machinery and equipment.** IDOR's exemption certificate covers machinery and equipment used in "manufacturing or assembling tangible personal property for wholesale or retail sale or lease". The certificate says the item category "includes machinery and repair/replacement parts". From July 1, 2019 the exemption also covers production-related tangible personal property. The buyer certifies the use under penalties of perjury, gives name, address and an Illinois account ID, FEIN or SSN, and may give a blanket certificate for all purchases from one seller. "The seller must keep this certificate." Update at least every three years. | IDOR Form [ST-587 (R-12/19)](https://tax.illinois.gov/content/dam/soi/en/web/tax/forms/sales/documents/sales/st-587.pdf); statute [35 ILCS 120/2-45](https://lig.ilga.gov/legislation/ilcs/documents/003501200K2-45.htm) | Form revised December 2019 | High that replacement parts for exempt machinery can qualify. This rests on IDOR's form, which was read. The regulation (86 Ill. Adm. Code 130.330) could not be opened (the site refused the request) and the statute is linked but was not read here, so the exact test ("used primarily") is for your accountant |
| So: can a custom replacement machine part be exempt? Yes, when the buyer is a manufacturer and the part goes into machinery used primarily to make goods for sale, and the buyer gives you a completed ST-587 (or equivalent). No, when the machine is not used that way (a building's equipment, a warehouse conveyor that only moves finished goods, a lab fixture). The buyer makes the claim; you keep the paper. | Reading of ST-587 | | Medium |
| **Exempt organisations** (government, schools, charities) hold an exemption identification number from IDOR (an "E" number) and "must give this number to a merchant in order to make certain purchases tax‑free". | IDOR, [Sales tax exemptions FAQ](https://tax.illinois.gov/research/taxinformation/sales/rot/general-information-about-sales-tax-transactions-and-exemptions.html) | current page | High that the number is the proof. The page does not say what the seller must record; the usual practice is to keep the number and a copy of the letter. Ask |
| A certificate from another state's buyer for an Illinois-sourced sale, and Illinois buyers who pick up: which certificate is good where is a question for your accountant. | | | Not researched |

### 3.4 Registration you need first

| Statement | Source | Confidence |
|---|---|---|
| Register through MyTax Illinois (about one to two business days) or by paper Form REG-1 (weeks). You receive a Certificate of Registration showing your Sales and Use Tax account ID. No fee is mentioned. Register before making sales. | IDOR, [Business Registration](https://tax.illinois.gov/businesses/registration.html); [Pub-113](https://tax.illinois.gov/research/publications/pubs/retailers-overview-of-sales-and-use-tax/registering-your-business.html) | High |
| Each legal entity registers itself. Whether Straightedge Manufacturing LLC already has its own account, or only the parent does, is something only you know. Stripe's registration entry asks for the state, not the number, but your returns are filed under the account ID. | | Ask |

### 3.5 Stripe Tax

| Statement | Source | Confidence |
|---|---|---|
| **Price.** Pay-as-you-go ("Tax Basic"): **0.5% per transaction** for no-code integrations, which includes hosted Checkout, charged "where you're registered to collect taxes". (API integrations: 50¢ per transaction.) A subscription ("Tax Complete") starts at **$90 a month** on a one-year contract and includes 2 registrations a year, 4 filings a year and 200 transactions a month; higher tiers $430, $1,000, $1,500. Basic includes calculation and collection only: no registrations, no filings. | [stripe.com/tax/pricing](https://stripe.com/tax/pricing) | High as of 2026-11-11; prices change |
| Example: a $300 order to an Illinois address, with only Illinois registered, costs $1.50 in Stripe Tax fees on top of card processing. An order to a state where you are not registered: no Stripe Tax fee, no tax. | Arithmetic from the above | Medium (the pricing page's wording is "where you're registered"; confirm on your first statement) |
| **How it is switched on for hosted Checkout:** `automatic_tax[enabled]=true` on each Checkout Session. | [Automatically collect tax with the Checkout page](https://docs.stripe.com/tax/checkout/page) | High |
| **Which address is taxed.** With an existing Stripe Customer and no shipping address collected on Stripe's page, "Checkout uses the Customer's existing shipping address to calculate taxes, if available". This site creates a Customer carrying the ship-to address typed at checkout, so the address the order ships to is the address it is taxed at and the buyer is not asked twice. | Same page, "Calculate tax for existing customers" | High for Stripe's rule. Not exercised against Stripe itself here (section 7) |
| **Registrations decide everything.** "Stripe Tax only collects tax in jurisdictions where you have an active registration." "Without a registration in the customer's location, the calculation returns zero tax." | [Checkout page guide](https://docs.stripe.com/tax/checkout/page); [Set up Stripe Tax](https://docs.stripe.com/tax/set-up) | High |
| **What you configure in the dashboard first:** the head office address ("if you sell physical goods, the address where you're shipping goods from"), the preset product tax code, whether prices include tax by default (ours are sent as tax-exclusive regardless), and your registrations (Tax → Registrations). | [Set up Stripe Tax](https://docs.stripe.com/tax/set-up) | High |
| **Tax codes.** Each product can carry a tax code; without one Stripe uses your preset. `txcd_99999999` is "General - Tangible Goods"; `txcd_00000000` is "Nontaxable". Stripe tells integrators not to pick a code on a merchant's behalf: the site therefore sends no code unless you paste one into the setting. | [Product tax codes](https://docs.stripe.com/tax/tax-codes); [Tax codes and tax behavior](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior) | High for the two codes named. The id of Stripe's "Shipping" code was not confirmed, so it is not used anywhere |
| **Origin states.** Stripe uses your head office address "as the default origin for all transactions". Per-transaction ship-from addresses "aren't available with Payment Links, Checkout, Billing, or Invoicing". | [Use ship-from addresses](https://docs.stripe.com/tax/ship-from-address) | High for what is quoted. Whether Stripe applies Illinois's origin rule to an Illinois seller's in-state sales (charging the shop's rate, not the buyer's) is **not stated on any page read here**. Check it in test mode: an Illinois ship-to in another county should show the shop's rate |
| **Tax-exempt customers.** A Customer's tax status can be set to exempt, which makes every transaction for that Customer untaxed. This site sets it only for an order whose declared exemption you have chosen to trust. A newer per-state exemptions feature is in private preview. | [Tax exemptions](https://docs.stripe.com/tax/exemptions) | High |
| **Certificates are yours.** "Stripe Tax doesn't let you upload, store, validate, or track exemption certificates. You must manage and track those certificates outside Stripe Tax." | Same page | High. This site stores the upload with the order (encrypted when the file key is set) and shows it to you; it does not judge it |
| **Tax ID collection** (`tax_id_collection`): Stripe shows a business tax ID field "depending on your customer's location". The list of supported types has none for the United States (Canada and Mexico are on it). For US buyers the switch does nothing. | [Collect customer tax IDs with Checkout](https://docs.stripe.com/tax/checkout/tax-ids) | High |
| **Where the tax amount is reported:** `total_details.amount_tax` on the Checkout Session. | [Checkout page guide](https://docs.stripe.com/tax/checkout/page) | High |
| **What Stripe Tax does not do** on the pay-as-you-go plan: register you anywhere; file or remit a return ("You must file and remit the tax you collect for every location where you're registered"); hold or check exemption certificates; decide which tax code fits a custom part; decide whether a sale is retail or special-order; tax a PO order (it never goes through Stripe); apply a ship-from address on Checkout. It also recommends against ZIP-only addresses in Illinois, which matters for one case here: a pickup order is taxed at the shop's city, state and ZIP with no street line. | [File and remit](https://docs.stripe.com/tax/filing); [Collect customer addresses](https://docs.stripe.com/tax/customer-locations) | High |
| Stripe offers, on request, a preview of "no code automatic tax calculation" for Checkout (its internal name suggests tax on by default). If your account were ever enrolled while this site's switch is off, Stripe might add tax the site did not ask for; the site would still record it and show it on the order. Do not enrol without telling whoever maintains the site. | [Checkout page guide](https://docs.stripe.com/tax/checkout/page) (preview notice) | Medium |

### 3.6 Shipping options

Carrier facts used below. UPS adds an Additional Handling charge when the longest side is over 48 in, the second-longest over 30 in, length plus girth over 105 in, or the weight over 50 lb. A Large Package Surcharge applies over 96 in long or 130 in length plus girth. UPS will not carry a parcel over 150 lb, 108 in long or 165 in length plus girth. Source: [Red Stag Fulfillment's 2026 summary of UPS's published surcharges](https://redstagfulfillment.com/ups-large-package-surcharge/) (secondary; criteria effective January 26, 2026). Confidence medium: check your own UPS and FedEx rate guides, which are the contract. A 48 in × 96 in sheet part has a length plus girth of about 96 + 2 × (48 + thickness) ≈ 193 in: over the parcel maximum, so it moves by LTL freight. Billing the receiver or a third party is a standard UPS option ("Bill Receiver: the receiver pays the transportation cost"): [UPS WorldShip help, Bill To information](https://www.ups.com/worldshiphelp/WSA/ENG/AppHelp/mergedProjects/CORE/Codes/Bill-To_Information_and_Codes.htm) (high).

The comparison is judgment, not sourced fact, except where a source is named.

| Option | What industrial buyers expect | Margin risk | Engineering | How it fails |
|---|---|---|---|---|
| (a) Included in the price, or free over a threshold | Simple. Purchasing likes one number. Free-over-a-threshold is a consumer habit; a plant buyer rarely changes an order to reach it | Highest: every order's freight comes out of margin unless prices carry it; heavy orders and far zones hurt most | Built (switch) | Quietly: you find out on the carrier invoice |
| (b) Flat rate by weight band | Familiar, predictable, shown before checkout | Low to medium: light and near orders overpay a little, far zones underpay a little. Oversize and overweight must be kept out, which the switch does | Built (switch, table, oversize rule) | A stale table. Dimensional weight on a light, bulky box is not modelled |
| (c) Live carrier rates by API | Accurate. Buyers accept it | Lowest on parcel. LTL quotes by API are less dependable | Not built. Needs a carrier or aggregator account, box-size logic, address validation, a fallback for when the API is slow or down, and label purchase to be worth it | Loudly, at checkout: a rating call that times out blocks a sale unless there is a fallback |
| (d) Ship on the customer's carrier account | Very common in industrial purchasing; many POs require it | None on freight. A wrong account number means a billing correction from the carrier | Built (switch) | A mistyped account number: found when the carrier bills back. The number is shown in full on the order so it can be checked before shipping |
| (e) Local pickup | Useful for nearby plants and for a part someone needs today | None | Built (switch) | The buyer arrives when nobody is at the door: the confirmation tells them to call first |

For occasional LTL: none of the instant options prices it. Under the table or included setting such an order is sent to a firm quote, where you price the freight in or the buyer supplies their freight account.

---

## 4. Questions to take to your accountant

1. **Collecting or not.** With tax switched off, the site collects no Illinois tax on sales to Illinois buyers. Is the company liable for that tax on its own receipts whether or not the buyer paid it? (ROT is a tax on the retailer; confirm what that means for sales already made and for launch.)
2. **Which tax applies to which jobs.** Under 86 Ill. Adm. Code 130.2115, are (a) parts made to a customer's drawing and (b) replacement parts we measure, draw and make from a worn original ordinary retail sales (ROT), or special-order sales under the Service Occupation Tax? Does a repeat order change the answer? Do 3D prints differ?
3. **The rate.** What combined rate applies at the shop's address from August 1, 2026 (IDOR Tax Rate Finder by address)? Is the shop inside or outside village limits for tax purposes?
4. **Stripe and origin sourcing.** For an Illinois buyer in another county, should the tax be the shop's rate? If Stripe's test-mode result differs, what do we do?
5. **Shipping charges.** Under 130.415, with pickup offered and shipping stated as its own line at or below cost, is the shipping line untaxed? Is it taxed when the buyer ships on their own carrier account (we charge nothing)? If shipping is included in the price, is the whole price taxable? Is a flat table that sometimes exceeds cost a problem? This sets the "Tax on the shipping line" switch.
6. **The inspection paperwork fee** (first-article report and certificate of conformance, its own line): taxable with the parts?
7. **Return of a customer's original part** inside a quoted price: any tax consequence?
8. **Exemption certificates.** Give us the checklist for a valid resale certificate (130.1405), an ST-587, and an exempt organisation's number. May we take them as an uploaded PDF or photo? How long do we keep them? Do we need a new one per order or is a blanket certificate fine? What do we do with an out-of-state buyer's certificate?
9. **Trusting a declaration.** If we charge no tax on the strength of an uploaded certificate that later proves bad, who owes the tax? Is "charge it, then refund after review" the safer default?
10. **Refunds of tax.** When we refund tax to an exempt buyer in Stripe after reading the certificate, how does that go on the return?
11. **Purchase orders.** PO orders are not charged by the site. How should tax appear on the invoice we send, and where is that invoice made?
12. **Pickup by an out-of-state buyer**, and delivery to Canada or Mexico: any tax to collect?
13. **Other states.** Do we have presence anywhere besides Illinois (a contractor, stored material, trade shows)? At what sales level into one state should we call you? Which states' thresholds should we watch first?
14. **Registration.** Does Straightedge Manufacturing LLC hold its own IDOR registration and account ID, or only the parent? What filing frequency will IDOR assign, and who files the ST-1?
15. **Filing.** Do you file from Stripe's tax reports, or should we buy Stripe's filing plan?
16. **Promotion codes** (off unless switched on). A Stripe promotion code reduces the amount charged. Is tax then on the reduced amount (that is how Stripe computes it)?

---

## 5. Owner's steps: what to do first, then how to switch each option on

This section stands on its own: it is the part to follow on the day. Nothing in it needs a developer.

### 5.1 Before switching the rate table on

1. Take your current UPS or FedEx ground rates (your account's, not the retail list) for 1, 5, 10, 20, 35 and 50 lb to a far zone, add what packing costs you, and decide the rows.
2. Decide the longest part and the heaviest order you are willing to ship by parcel without looking (48 in and 50 lb are set; carriers add handling charges above those).
3. Decide whether buyers may ship on their own carrier account and whether they may pick up. Pickup hands out the shop's street address, by email and on the order page, to a buyer who has paid for a pickup order, and to no one else.

### 5.2 Before switching sales tax on

Do these in order. Until all of them are done, leave "Sales tax at checkout" on Off.

1. **Accountant.** Take section 4 to your accountant. The answers that change a setting are question 2 (which tax applies to custom parts), question 3 (the rate at the shop) and question 5 (whether the shipping line is taxed).
2. **Illinois.** Confirm that Straightedge Manufacturing LLC itself is registered with the Illinois Department of Revenue for sales tax and has its account ID. If it is not, register through MyTax Illinois (about one to two business days) before taking a taxed order.
3. **Stripe dashboard → Settings → Tax** (in the Stripe account the site takes payments with):
   - switch Stripe Tax on;
   - check the head office address: it must be the address the parts ship from;
   - set the preset product tax code your accountant chose (Stripe's general code for physical goods is "General - Tangible Goods", `txcd_99999999`);
   - under Registrations, add Illinois. Add no other state unless your accountant says you are registered there: Stripe collects only where a registration is entered.
4. **Test mode.** With Stripe in test mode and the site's tax switch on, place three orders: one shipped to an Illinois address in another county (is the rate the one your accountant expects?), one shipped to another state (expect no tax while only Illinois is registered), one pickup. Check the tax line on the order page and on the order confirmation.
5. **Decide exemptions.** Whether buyers may declare an exemption, and whether a declaration with a certificate is charged without tax at once (trusted) or charged with tax and refunded by you after you have read the certificate (the default).
6. Then switch it on (5.3), and for the first weeks compare Stripe's tax report with what you expected.

Stripe Tax costs 0.5% of each taxed transaction on the pay-as-you-go plan and does not file returns: the ST-1 is still filed by you or your accountant.

### 5.3 The switches

Admin → **Pricing**. The Simple view shows the switches; **Everything → Shipping & tax** shows all of them with the rate table. Every change needs a one-line note and lands in the pricing History, where any earlier state can be restored. At the top of the group is a preview: type a weight, a longest side, a parts total and a state and it says, in a sentence, what a buyer would be charged with the settings on screen, saved or not.

**Shipping**

| To do this | Set |
|---|---|
| Keep today's behaviour | How shipping is charged → **Weight formula (as today)**. The two numbers are in the Shop group (Shipping base, Shipping per kg) |
| Charge by a rate table | 1. Everything → Shipping & tax → **Shipping rate table**: replace every row with your own numbers (the tag "Placeholder numbers: set your own" disappears when you do). Each row: packed weight up to N lb → charge. 2. Check **Packaging allowance** (10% of part weight plus 1 lb per order to start). 3. Check **Longest side we ship by parcel** (48 in) and **Heaviest order we ship by parcel** (50 lb). 4. How shipping is charged → **Rate table by packed weight**. Use the preview before you save |
| Include shipping in the price | How shipping is charged → **Included in the price**. Oversize and overweight orders still go to a firm quote |
| Free shipping over a parts total | **Free shipping over** → the dollar figure. 0 switches it off. Works with the formula and with the table |
| Let buyers use their own carrier account | **Let buyers ship on their own carrier account** → On |
| Offer pickup | **Let buyers pick up at the shop** → On |

Rate table and included shipping apply to the contiguous United States. An order to Alaska, Hawaii, a territory, Canada or Mexico is told freight is confirmed on a firm quote. (The formula has no such rule: it charges everywhere, as it always has.)

**Tax**

| To do this | Set |
|---|---|
| Keep today's behaviour | Sales tax at checkout → **Off (as today)** |
| Collect tax with Stripe Tax | First, outside this site: register with IDOR if needed; in Stripe → Settings → Tax: switch Tax on, confirm the head office address, choose the preset product tax code with your accountant, add your Illinois registration; run a test-mode checkout. Then: Sales tax at checkout → **Stripe Tax, automatic** |
| Pin a product tax code | **Stripe product tax code for parts** → paste the code exactly. Empty uses Stripe's preset |
| Do not tax the shipping line | **Tax on the shipping line** → Do not tax shipping (after question 5) |
| Let exempt buyers say so | **Let buyers declare a tax exemption** → On. They choose a reason and must upload a certificate |
| Charge exempt buyers no tax on sight | **Trust declared exemptions** → On. Off (the default) charges tax and tells you to refund it after you have read the certificate |
| Ask for a business tax ID on Stripe's page | **Ask for a business tax ID on Stripe's page** → On. Does nothing for US buyers |

### 5.4 On an order

Admin → Orders → open one: a "Shipping & tax" block shows the shipping method, shipping charged, packed weight, tax charged and exemption status. A pickup order carries "Customer pickup: do not ship". A carrier-account order shows the carrier and the **full account number** (the only place it is shown in full). An order with a declared exemption shows what was done about tax and a button to open the certificate. To refund tax after reading a certificate: refund that amount on the payment in the Stripe dashboard; the site does not do it for you.

**Marking a pickup order "Shipped"** sends the buyer "ready for pickup", not a shipping notice.

---

## 6. What was built

All server-side; the browser chooses, the server computes.

- **Settings** (`server/config/ruleSchema.js`): a "Shipping & tax" group in the existing rules mechanism, with two new rule types (a named choice, a short pattern-checked text) alongside numbers and tables. Typed, validated, in the history, restorable. Defaults are today's behaviour. No existing rule, default or range changed.
- **Shipping** (`server/services/shipping.js`): packed weight from each part's measured volume × its material's own density × quantity, plus the packaging allowance; the longest side from the part's measured extents. The rate table bills the next whole pound. An order gets **no price** ("we'll confirm freight") when a part is over the longest side, the order is over the parcel weight or past the last table row, the weight or size cannot be worked out (a missing density is never replaced by a typical one and never read as zero), or the address is outside the contiguous states. Such an order goes to the firm-quote path through the existing quote gate, unless the buyer can use their own carrier account or pick it up.
- **Delivery choices** (`server/services/checkout.js`): ship / carrier account / pickup, each honoured only if its switch is on. The total for a choice is parts + lead-time fee + that choice's shipping, held to the order minimum, plus the paperwork fee. Shipping is worked out at checkout, every time, from the quote's priced lines under the settings in force at that moment (`shipping.shippingFor`); the shipping figure stored on a quote is what the buyer was shown when it was priced and is never read back as the charge. When nothing has changed since the quote was priced the two agree and the order comes to the quote's own total, to the cent. If you change a shipping setting while a quote is open, the checkout page shows, and the order is charged, shipping under the new setting.
- **Stripe** (`server/services/orderEvents.js`): shipping is its own line whenever it is charged by the table or included, and always when tax is on (so Stripe can tax it, or not, separately). With every switch at its default the session is identical to before (asserted key by key in the tests).
- **Carrier account numbers**: validated (5 to 20 letters and digits), sealed with AES-256-GCM bound to the order's id, stored as ciphertext plus the last four characters. Emails, PDFs, the traveler, the order list, the production queue and the buyer's own order page show the last four only. The admin's view of one order opens the full number. Never sent to Stripe, never logged.
- **Pickup address**: stays in `server/config/shipFrom.json`. Given out only in the order confirmation email and on the buyer's order page, and only for a pickup order that has been paid. Stripe is given city, state and ZIP for tax, not the street.
- **Tax** (`server/services/tax.js`): off, or Stripe Tax. In Stripe mode the session gets `automatic_tax`, a Stripe Customer at the ship-to address, tax-exclusive lines, your tax codes, optional `tax_id_collection`. The tax Stripe reports is stored on the order and added to its total. The paid-amount check compares amounts before discounts **and before tax**, so a taxed order is not flagged. PO orders show tax as "per invoice".
- **Exemptions**: the buyer ticks a box, picks a reason and uploads a certificate (PDF, JPG or PNG) through the same guarded path as a drawing: storage ceiling and per-sender budget before the file is written, a server-chosen file name, a content check against the extension, encryption at rest when the file key is set, removal by the existing sweep once nothing refers to it. No certificate, no declaration. Trusted → charged with no tax; not trusted → charged with tax and flagged for refund. Either way the certificate is on the order for you.
- **Documents**: order confirmation email and PDF, shop notice, packing slip, job traveler, quote PDF, firm-quote page and order page state the delivery choice, shipping (amount, included, free, on your account, pickup), tax (amount, per invoice, exempt) and, for a replacement-part order, how the original goes back under each delivery choice.
- **Firm quotes and POs**: the same delivery choices on the acceptance form when a switch is on; the quoted total never changes with the choice; card payments follow the tax setting; a PO's tax is per invoice; the certificate can be uploaded through the signed link.
- **Reorder**: unchanged. The new quote is priced under the current settings; a carrier account is not carried over.
- **Database**: additive columns only (`server/models/taxShippingMigration.js`), with their field names beside them. Old rows read as "shipped by us, formula, no tax".
- **Admin**: the settings with plain labels and the preview sentence; the order view block; tags in the order list (Pickup, Collect, Tax exempt?).
- **Public copy**: no public page states a shipping price or mentions tax, before or after. The quote summary and checkout say what is true for the current settings, from the server. `node scripts/claims-check.js` exits 0.

### How it is tested

| What | Where | Result |
|---|---|---|
| Settings: defaults are today's, choices and codes validated, placeholders marked | `server/config/ruleSchema.test.js` | 15 checks |
| Weights, table, oversize, unknown weight, destination, free-over, carrier accounts, preview | `server/services/shipping.test.js` | 25 checks |
| Tax settings, exemptions, Stripe parameters, reading a paid session | `server/services/tax.test.js` | 13 checks |
| End to end through the real routes with Stripe stubbed: each shipping method, each tax mode, firm quotes, POs, reorder, tampering (method, weights, totals, the shipping figure stored on a quote, exemption flag, carrier account), logs and emails searched for the account number and the street address | `server/routes/taxShipping.test.js` | 50 tests |
| A database shaped like the previous version's upgrades in place; old quote, order and request still read, document and check out | `server/models/taxShippingMigration.test.js` | 8 checks |
| The same with a database produced by the base branch's own code, in production mode, in a browser: old order page, Reorder, old draft quote checkout | `scripts/e2e/tax-shipping-upgrade-make-db.js` then `scripts/e2e/tax-shipping-upgrade.mjs` | 12 checks |
| One browser pass (Chromium, 1360 px, production mode, the server's real Content-Security-Policy) through checkout for every shipping method and tax mode, the firm-quote page, the admin settings and order view | `scripts/e2e/tax-shipping.mjs` | 56 checks, 28 screenshots |
| Every suite in the repository, old and new | `npm test` | 45 suites. All pass on a quiet machine. One older timing test (`server/security/uploads.test.js`: a health check must answer within 250 ms while a large STEP file is read) fails when the machine is busy with other work, on this branch and on the branch it started from alike, and passes when run alone |

Screenshots: `docs/screenshots/tax-shipping-2026-11-11/`. The pickup address is masked in the one screenshot that contains it. The carrier account number in the screenshots is made up.

---

## 7. What is not built, and what could not be verified

**Not verified**

- **Nothing was run against Stripe**, live or test mode. The Stripe Tax parameters follow Stripe's documentation as read on 2026-11-11 and are exercised against a stand-in. Before switching tax on: one test-mode checkout to an Illinois address (does the rate match the shop's?), one to another state (zero tax expected with only Illinois registered), one pickup, one with an exempt Customer.
- **The rate at the shop's address.** Not looked up (the Tax Rate Finder is an interactive tool and needs the address). The two figures in 3.1 are for "inside the village" and "outside any municipality".
- **86 Ill. Adm. Code 130.330 and 130.1405** could not be opened. 35 ILCS 120/2-45 is linked but was not read. The manufacturing exemption as described here rests on IDOR's ST-587 form; the resale certificate's required contents are not listed here.
- **Carrier thresholds** come from a secondary summary, not from UPS's or FedEx's rate guide.
- **Stripe's fee "only where registered"** is the pricing page's wording; not confirmed from an invoice.

**Not built**

- Live carrier rates, address validation, label purchase, tracking import. EasyPost is not wired.
- Dimensional weight and box selection. The table uses weight and one longest-side rule.
- LTL freight pricing. Such orders go to a firm quote.
- Zones. One table for the contiguous United States.
- Automatic refund of tax after a certificate is approved; an "approved" state for a certificate. You refund in Stripe.
- Certificates on file per customer (a blanket certificate reused across orders). Each order carries its own upload.
- One Stripe Customer per account. Each taxed checkout creates a new Stripe Customer.
- Invoices for PO orders, with or without tax.
- Filing, registration, threshold alerts inside this site (Stripe's dashboard has the monitoring view).
- A delivery choice on the admin's phone-order route (`POST /api/orders`): unchanged.
- An owner-set shipping line on a firm quote. A firm quote's price is the total; say what it covers in the quote note, as now.
- A carrier account number is sealed with a key derived from `JWT_SECRET`. If that secret is ever changed, stored account numbers can no longer be opened: the order view says so and shows the last four.

---

## 8. At the relaunch merge (2026-11-12): what changed from the sections above

This branch was written on an older base. It was merged into the relaunch branch after the payment,
price-integrity and availability fixes, and those rules won wherever the two met. The settings, the
defaults and everything in sections 1 to 5 stand. What is different from section 6:

- **What a customer is charged for shipping at the defaults: the weight formula, $12.00 plus $2.50 per
  kilogram of parts, to any destination, with no size or weight limit.** No tax. One delivery choice (we
  ship). That is option A in section 1 and is what the site did before; nothing is switched on until you
  switch it on.
- **Checkout prices the quote again before it charges** (the price-integrity rule). Shipping is worked
  out from the lines as they have just been priced again, not from the stored quote's lines. The parts
  are charged at the quote's own price (today's, or the held one); shipping is charged under the settings
  as they are at that moment and is not part of the 30-day price hold.
- **The total the page showed is checked.** The checkout page sends the total it was showing for the
  delivery choice the buyer made. If that is not what the server would charge (a setting changed after
  the page loaded), nothing is charged: the buyer is shown the new total and presses pay again.
- **One quote, one order, whatever the delivery choice.** Back from the card page with another choice or
  another address, the buyer's unpaid order is brought up to date: it is never a second order. With tax
  on, a changed address closes the old card page and opens a new one tied to the new address, so an
  order is never taxed at an address it is not going to.
- **A payment that does not match is not marked paid.** It used to become "paid, under review". Now the
  order stays unpaid, is flagged for you with the reason, and you are emailed (the order-lifecycle rule).
  The check is: what Stripe collected, less the tax Stripe reports, plus any discount, equals the order's
  total before tax, in whole cents. Tax on a payment for an order that was checked out with tax off is a
  mismatch too.
- **Promotion codes are off unless you switch them on** (`STRIPE_PROMOTION_CODES=on`); section 6's
  "allow_promotion_codes" no longer applies by default.
- **A material with no density cannot be priced at all** (the pricing whitelist refuses it), so the
  "unknown weight" shipping answer is now reached only for a part whose size or volume cannot be worked
  out, not through a material record.
- **Looking at a quote reads no part from disk under the weight formula.** With a rate table or
  "included" each part of the quote is read once to weigh it.
- **Every new refusal has its words in the message catalogue** (delivery choice, carrier account, pickup
  name, no parcel price, tax address, exemption reason, certificate missing or of the wrong kind).

How it was tested at the merge, on the merged code:

| What | Where | Result |
|---|---|---|
| The branch's own end-to-end suite, with four cases rewritten for the rules above (each says why in the file) | `server/routes/taxShipping.test.js` | 50 of 50 |
| The payment checks with shipping and tax off and on: weight formula and tax off; rate table and Stripe Tax; pickup and Stripe Tax; carrier account and rate table. Expected charge, re-pricing at checkout, the fingerprint, one quote one order, settlement, refunds and disputes, and a changed address on the way back | `server/routes/paymentChecksByDelivery.test.js` | 32 of 32 |
| Shipping, tax, settings and column suites | `shipping.test.js`, `tax.test.js`, `ruleSchema.test.js`, `taxShippingMigration.test.js` | 25, 13, 15, 8 |
| The browser pass (Chromium, 1360 px, production mode, the real Content-Security-Policy) | `scripts/e2e/tax-shipping.mjs` | 56 of 56; screenshots refreshed |

Still true, and still not done: nothing here has been run against Stripe itself (section 7).
