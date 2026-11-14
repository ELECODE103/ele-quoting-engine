#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), N-03: the state pick list on the checkout page,
 * in a real Chromium at 390 px and 1360 px, with the keyboard, and with a value written into it the
 * way a form filler does.
 *
 *   NODE_PATH=/opt/npm-tools/node_modules node tools/security/review-conditions/r5-state-picklist.js
 *
 * Needs the production build (client/dist). The server is the real one (production mode); Stripe is
 * the stand-in the author's browser runs use (scripts/e2e/stub-tax-shipping.cjs).
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { chromium } = require("playwright");
const live = require(path.join(ROOT, "server/testSupport/liveServer"));
const { report } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const cube = fs.readFileSync(path.join(ROOT, "tools/vet-quotes/parts/cube_20mm.stl"));

(async () => {
  const R = report();
  const s = await live.start({ env: { NODE_OPTIONS: `-r ${path.join(ROOT, "scripts/e2e/stub-tax-shipping.cjs")}`, E2E_STUBS: "1" } });
  const browser = await chromium.launch();
  try {
    const email = "dana@buyer.test";
    const token = await s.register(email, { ip: "198.51.100.7" });
    const up = await s.upload([{ name: "cube.stl", data: cube }], { token, ip: "198.51.100.7" });
    const partId = up.body.parts[0].partId;
    const mat = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc")[0];
    const newQuote = async () => (await s.post("/api/quote", { parts: [{ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: 2, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { token, ip: "198.51.100.7" })).body;

    for (const [label, viewport] of [["390 px (phone)", { width: 390, height: 844 }], ["1360 px (desktop)", { width: 1360, height: 900 }]]) {
      console.log(`\n${label}`);
      const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
      const page = await ctx.newPage();
      await page.goto(`${s.base}/login`);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(s.passwords[email]);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
      const q = await newQuote();
      await page.goto(`${s.base}/checkout/${q.quoteId}`);
      await page.getByTestId("summary-total").waitFor({ timeout: 20000 });
      const sel = page.locator("#co-state");
      const facts = await sel.evaluate((el) => ({ tag: el.tagName, options: el.options.length, first: el.options[0].textContent, required: el.required, autocomplete: el.autocomplete, label: (document.querySelector('label[for="co-state"]') || {}).textContent, box: el.getBoundingClientRect().toJSON(), font: getComputedStyle(el).fontSize }));
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      R.check(facts.tag === "SELECT" && facts.options === 60 && facts.required && facts.label === "State", "the state is a pick list of 59 places plus 'Choose a state', required, with its label", `${facts.options} options, first "${facts.first}", autocomplete "${facts.autocomplete}"`);
      R.check(!sideways && facts.box.left >= 0 && facts.box.right <= viewport.width && (viewport.width >= 500 || facts.box.height >= 40), viewport.width < 500 ? "it fits the screen (no sideways scroll) and is at least 40 px tall to tap" : "it fits the screen (no sideways scroll)", `box ${Math.round(facts.box.width)} x ${Math.round(facts.box.height)} px, text ${facts.font}`);
      if (viewport.width < 500) R.check(parseFloat(facts.font) >= 16, "its text is 16 px or more (a phone does not zoom the page when it is tapped)", facts.font);

      // The keyboard: tab order, then what typing a state lands on.
      await page.locator("#co-city").focus();
      await page.keyboard.press("Tab");
      const afterCity = await page.evaluate(() => document.activeElement && document.activeElement.id);
      await page.keyboard.press("Tab");
      const afterState = await page.evaluate(() => document.activeElement && document.activeElement.id);
      R.check(afterCity === "co-state" && afterState === "co-zip", "Tab goes city → state → ZIP code", `${afterCity} → ${afterState}`);
      const typed = [];
      for (const [keys, want] of [["IL", "IL"], ["il", "IL"], ["OH", "OH"], ["illinois", "IL"], ["ohio", "OH"], ["texas", "TX"], ["new york", "NY"], ["california", "CA"], ["florida", "FL"], ["michigan", "MI"], ["washington", "WA"], ["hawaii", "HI"]]) {
        await sel.selectOption("");
        await sel.focus();
        await page.keyboard.type(keys, { delay: 40 });
        const got = await sel.inputValue();
        typed.push({ keys, want, got });
        await page.waitForTimeout(1100); // the browser forgets what was typed after about a second
      }
      const codes = typed.filter((t) => t.keys.length === 2);
      const names = typed.filter((t) => t.keys.length > 2);
      R.check(codes.every((t) => t.got === t.want), "typing the two-letter code with the list focused picks that state", codes.map((t) => `${t.keys}→${t.got || "nothing"}`).join(", "));
      const wrongName = names.filter((t) => t.got !== t.want);
      if (wrongName.length) R.finding(`typing the state's NAME with the list focused picks the WRONG state for ${wrongName.length} of ${names.length} names tried (each option starts with the code, "TX · Texas", and the browser matches what is typed against the start)`, names.map((t) => `${t.keys}→${t.got || "nothing"}${t.got === t.want ? "" : ` (meant ${t.want})`}`).join(", "));
      else R.holds("typing the state's name with the list focused picks that state", names.map((t) => `${t.keys}→${t.got}`).join(", "));

      // A form filler that writes the value (the DOM takes only a value that is on the list).
      const filled = [];
      for (const v of ["IL", "Illinois", "illinois", "il", "Ill.", "IL · Illinois"]) {
        await sel.selectOption("");
        const got = await sel.evaluate((el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; }, v);
        filled.push(`"${v}"→${got || "nothing chosen"}`);
      }
      R.info("a form filler that writes a value straight into the list (not the browser's own autofill, which I could not drive headless)", filled.join(", "));

      // What the buyer reads for a wrong pairing, and for Hawaii.
      await page.locator("#co-name").fill("Dana Buyer");
      await page.locator("#co-street").fill("100 Main St");
      await page.locator("#co-city").fill("Chicago");
      await sel.selectOption("TN");
      await page.locator("#co-zip").fill("75201");
      await page.getByRole("button", { name: /Pay and place order/ }).click();
      const alert = page.getByRole("alert").first();
      await alert.waitFor({ timeout: 15000 });
      const words = (await alert.textContent()).replace(/\s+/g, " ").trim();
      R.check(/ZIP code 75201 is in Texas/.test(words) && /Tennessee/.test(words), "Tennessee chosen with a Dallas ZIP code: refused in words that name both states", `"${words.slice(0, 200)}"`);
      R.check(/checkout\//.test(page.url()), "…and the buyer is still on the checkout page with what they typed", `street "${await page.locator("#co-street").inputValue()}", ZIP "${await page.locator("#co-zip").inputValue()}"`);
      await sel.selectOption("CA");
      await page.locator("#co-zip").fill("96813");
      await page.getByRole("button", { name: /Pay and place order/ }).click();
      await page.waitForFunction(() => /confirm freight|firm quote/i.test(document.body.textContent), null, { timeout: 15000 }).catch(() => {});
      const body = (await page.locator("body").textContent()).replace(/\s+/g, " ");
      const freight = (body.match(/Our parcel rates[^.]*\.[^.]*\.[^.]*\./) || [""])[0];
      R.check(/confirm freight/.test(body) && !/orders\/[0-9a-f-]{36}/.test(page.url()), "California chosen with a Honolulu ZIP code: no order; the buyer is told freight is confirmed first", `"${freight.slice(0, 220)}"`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await s.stop();
  }
  process.exit(R.done() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
