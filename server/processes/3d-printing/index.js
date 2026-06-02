/**
 * 3D printing process definition. Self-contained: pricing + DFM live in this folder.
 */
module.exports = {
  slug: "3d-printing",
  defaultFinishSlug: "3dp-as-printed",
  previewSubProcess: "fdm",
  // Back-compat method-name wiring.
  priceMethod: "calculatePrintPrice",
  dfmFn: "runPrintingDFM",
  pricing: require("./pricing"),
  dfm: require("./dfm"),
};
