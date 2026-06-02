/**
 * Sheet metal process definition. Self-contained: pricing + DFM live in this folder.
 */
module.exports = {
  slug: "sheetmetal",
  defaultFinishSlug: "raw",
  previewSubProcess: undefined,
  // Back-compat method-name wiring (registry merges these onto the def so
  // legacy name-based dispatch and registry assertions keep working).
  priceMethod: "calculateSheetMetalPrice",
  dfmFn: "runSheetMetalDFM",
  pricing: require("./pricing"),
  dfm: require("./dfm"),
};
